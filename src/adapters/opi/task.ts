import { executingTask, type TaskInput, type TaskRecord, type TaskState } from "../../shared/tasks.ts";
import { OpiActionError } from "./client.ts";
import { SessionPort } from "./session.ts";

const summary = (error: unknown) => [...(error instanceof Error ? error.message : String(error))].slice(0, 2000).join("");
export class AgentTask {
  readonly input: TaskInput;
  private target: URL; private changed: () => void; private port: SessionPort;
  private controller = new AbortController(); private task: Promise<void>; private sent = false;
  private mode: "creating" | "running" = "creating"; private ending = false; private currentPath: string;
  private reason: "cancelled" | "timed_out" | "shutdown" | null = null;
  record: TaskRecord;
  get dialogs() { return this.port.dialogs; }
  get selected() { return this.port.selected; }
  constructor(target: URL, input: TaskInput, changed: () => void) {
    this.target = target; this.input = input; this.changed = changed; this.currentPath = input.path;
    const at = new Date().toISOString();
    this.record = { id: input.id, name: input.name, path: input.path, state: "creating", session: null, file: null, startedAt: at, updatedAt: at, revision: 0, message: "", replyId: null };
    this.port = new SessionPort(target, () => { if (!this.ending) this.update(this.port.dialogs.length ? "waiting" : this.mode); }, true);
    this.task = this.run();
  }
  private update(state: TaskState, message = this.record.message): void {
    const session = this.port.owned; const file = this.port.file;
    const replyId = state === "completed" ? this.port.execution.resultEntryId : this.record.replyId;
    const next = { ...this.record, state, session, file, message, replyId, path: session?.cwd ?? this.currentPath };
    if (JSON.stringify(next) === JSON.stringify(this.record)) return;
    this.record = { ...next, revision: this.record.revision + 1, updatedAt: new Date().toISOString() }; this.changed();
  }
  private async run(): Promise<void> {
    const timer = setTimeout(() => { this.reason = "timed_out"; this.controller.abort(new Error("计划运行超时")); }, this.input.timeoutSeconds * 1000);
    try {
      const session = await this.port.create(this.input.path, this.controller.signal, (_phase, path) => { this.currentPath = path; this.update(this.port.dialogs.length ? "waiting" : "creating"); });
      if (this.port.execution.sessionId !== session.id) throw new Error("缺少专用会话的执行状态，未发送任务");
      if (this.port.execution.busy || this.port.execution.users > 0) throw new Error("专用会话已被其他输入占用，未自动发送任务");
      await this.port.client.action({ action: "rename", name: `[schedule] ${this.input.name}` }, session.id, this.controller.signal);
      if (this.input.model) await this.port.client.action({ action: "model", provider: this.input.model.provider, id: this.input.model.id }, session.id, this.controller.signal);
      this.mode = "running"; this.update("running"); this.sent = true;
      await this.port.client.action({ action: "prompt", text: this.input.prompt, images: [], files: [], behavior: "followUp" }, session.id, this.controller.signal);
      await this.port.client.synchronize(this.controller.signal); await this.port.waitIdle(this.controller.signal);
      const result = this.port.execution.result;
      this.ending = true;
      if (result?.reason === "error") this.update("failed", summary(result.error || "模型返回错误，请检查会话"));
      else if (result?.reason === "aborted") this.update("cancelled", "原生会话已被停止");
      else this.update("completed", result?.reason === "length" ? "模型达到输出长度上限，请检查会话结果" : "SDK 执行已结束，请检查会话结果");
    } catch (error) {
      this.ending = true;
      if (this.reason === "shutdown") this.update("unknown", "节点或后端正在关闭，执行结果待核对");
      else if (this.reason) {
        const reason = this.reason;
        try {
          await this.port.abort();
          this.update(reason, this.port.owned ? "已向专用会话确认停止" : "尚未发送任务；工作区启动可能已登记，需检查原工作区");
        } catch (stop) { this.update("unknown", `停止未确认，不会自动重跑：${summary(stop)}`); }
      } else if (!this.sent) this.update("failed", summary(error));
      else if (error instanceof OpiActionError) {
        try { await this.port.waitIdle(AbortSignal.timeout(5000)); this.update("failed", summary(error)); }
        catch { this.update("unknown", `SDK 报错但无法确认停止：${summary(error)}`); }
      } else this.update("unknown", `执行连接中断，不会自动重跑：${summary(error)}`);
    } finally { clearTimeout(timer); await this.port.finish(); this.changed(); }
  }
  respond(sessionId: string, dialogId: string, value: string | null) { return this.port.respond(sessionId, dialogId, value); }
  async cancel(): Promise<void> {
    if (executingTask(this.record.state)) { this.reason = "cancelled"; this.controller.abort(new Error("用户取消计划运行")); await this.task; return; }
    if (this.record.state !== "unknown" || !this.record.session) return;
    const control = new SessionPort(this.target, () => {}, true, this.record.session.id);
    try { await control.client.ready; await control.abort(); if (control.file) this.port.file = control.file; this.update("cancelled", "用户重新连接专用会话并确认停止"); }
    finally { control.close(); }
  }
  acknowledge(): void {
    if (executingTask(this.record.state)) throw new Error("任务仍在执行，请先取消或等待结束");
    if (this.record.state === "unknown") this.update("abandoned", "用户已核对结束，未重新执行任务");
  }
  async close(): Promise<void> { this.reason = "shutdown"; this.controller.abort(); this.port.close(); await this.task; }
}
