import { object } from "../../shared/protocol.ts";

interface Outcome { reason: string; error: string }
interface Entry { id: string; user: boolean; assistant: Outcome | null }
function outcome(value: unknown): Outcome | null {
  if (!object(value) || value.role !== "assistant" || typeof value.stopReason !== "string") return null;
  return { reason: value.stopReason, error: typeof value.errorMessage === "string" ? [...value.errorMessage].slice(0, 2000).join("") : "" };
}
function entries(value: unknown): Entry[] {
  if (!Array.isArray(value)) throw new Error("o-pi 执行条目格式不匹配");
  return value.map((entry: unknown) => {
    if (!object(entry) || typeof entry.id !== "string" || !Array.isArray(entry.messages)) throw new Error("o-pi 执行消息格式不匹配");
    let user = false; let assistant: Outcome | null = null;
    for (const message of entry.messages) { if (object(message) && message.role === "user") user = true; const result = outcome(message); if (result) assistant = result; }
    return { id: entry.id, user, assistant };
  });
}
/** 只投影忙碌标记、用户条目数量和停止原因，不保存正文、思考或工具输出。 */
export class ExecutionState {
  sessionId: string | null = null;
  private flags = new Map<string, boolean>(); private queue = 0; private list: Entry[] = []; private stream: Outcome | null = null;
  get busy(): boolean { return this.queue > 0 || [...this.flags.values()].some(Boolean); }
  get running(): boolean { return this.flags.get("running") === true; }
  get resultEntryId(): string | null { return this.list.findLast((entry) => entry.assistant !== null)?.id ?? null; }
  get users(): number { return this.list.filter((entry) => entry.user).length; }
  get result(): Outcome | null { for (let index = this.list.length - 1; index >= 0; index--) { const entry = this.list[index]; if (entry?.assistant) return entry.assistant; } return this.stream; }
  consume(raw: unknown): boolean {
    if (!object(raw) || raw.type !== "snapshot" && raw.type !== "patch") return false;
    const value = raw.value;
    if (raw.type === "patch" && object(value) && !["running", "commandRunning", "retrying", "compacting", "queue"].some((key) => key in value) && raw.entries === undefined && !(object(raw.streamingMessage) && (raw.streamingMessage.kind === "replace" || object(raw.streamingMessage.metadata)))) return false;
    const before = JSON.stringify([this.sessionId, this.busy, this.running, this.users, this.result, this.resultEntryId]);
    if (raw.type === "snapshot") {
      if (raw.value === null) { this.sessionId = null; this.flags.clear(); this.list = []; this.queue = 0; this.stream = null; return before !== JSON.stringify([this.sessionId, this.busy, this.running, this.users, this.result, this.resultEntryId]); }
      if (!object(raw.value) || typeof raw.value.sessionId !== "string") throw new Error("o-pi 执行快照缺少会话身份");
      this.sessionId = raw.value.sessionId; this.flags.clear(); this.list = entries(raw.value.entries); this.values(raw.value); this.stream = outcome(raw.value.streamingMessage);
    } else if (raw.type === "patch") {
      if (raw.sessionId !== this.sessionId || !object(raw.value)) throw new Error("o-pi 执行增量缺少初始快照");
      this.values(raw.value);
      if (raw.entries !== undefined) {
        if (!object(raw.entries) || typeof raw.entries.keep !== "number" || !Number.isInteger(raw.entries.keep) || raw.entries.keep < 0 || raw.entries.keep > this.list.length) throw new Error("o-pi 执行条目增量越界");
        this.list = [...this.list.slice(0, raw.entries.keep), ...entries(raw.entries.items)];
      }
      if (object(raw.streamingMessage)) {
        if (raw.streamingMessage.kind === "replace") this.stream = outcome(raw.streamingMessage.value);
        if (raw.streamingMessage.kind === "content" && object(raw.streamingMessage.metadata)) this.stream = outcome({ ...raw.streamingMessage.metadata, role: "assistant" });
      }
    }
    return before !== JSON.stringify([this.sessionId, this.busy, this.running, this.users, this.result, this.resultEntryId]);
  }
  private values(value: Record<string, unknown>): void {
    for (const key of ["running", "commandRunning", "retrying", "compacting"]) if (value[key] !== undefined) {
      if (typeof value[key] !== "boolean") throw new Error(`o-pi ${key} 格式不匹配`); this.flags.set(key, value[key]);
    }
    if (value.queue !== undefined) {
      if (!object(value.queue) || !Array.isArray(value.queue.steering) || !Array.isArray(value.queue.followUp)) throw new Error("o-pi 队列格式不匹配");
      this.queue = value.queue.steering.length + value.queue.followUp.length;
    }
  }
}
