import type { WebSocket } from "ws";
import type { ModelOption, ModelRef } from "../src/shared/models.ts";
import { MARKDOWN_REPLY } from "./markdown-fixture.ts";

interface Session { sessionId: string; path: string; cwd: string; title: string; modified: string; state: "idle" | "waiting" | "running" }
export class FakeExecution {
  readonly prompts: { sessionId: string; text: string; model: ModelRef }[] = [];
  readonly modelChanges: { sessionId: string; model: ModelRef }[] = [];
  models: ModelOption[]; readonly defaultModel: ModelRef;
  private selectedModels = new Map<string, ModelRef>();
  private getSession: (id: string) => Session | undefined; private publish: () => void; private submitted: (session: Session) => void;
  private running = new Set<string>(); private aborted = new Set<string>(); private rows = new Map<string, unknown[]>();
  private gates = new Map<string, { resolve(): void }>();
  constructor(getSession: (id: string) => Session | undefined, publish: () => void, submitted: (session: Session) => void, provider: string) {
    this.getSession = getSession; this.publish = publish; this.submitted = submitted;
    this.defaultModel = { provider, id: "default" };
    this.models = [{ ...this.defaultModel, name: `${provider} 默认模型` }, { provider, id: "fast", name: `${provider} 快速模型` }, { provider: `${provider} 备用`, id: "fast", name: `${provider} 备用模型` }];
  }
  model(id: string): ModelRef { return this.selectedModels.get(id) ?? this.defaultModel; }
  setModel(id: string, model: ModelRef): void {
    const selected = { provider: model.provider, id: model.id };
    this.selectedModels.set(id, selected); this.modelChanges.push({ sessionId: id, model: selected }); this.publish();
  }
  snapshot(id: string | null) {
    const session = id ? this.getSession(id) : undefined; if (!session) return null;
    return { sessionId: session.sessionId, cwd: session.cwd, models: this.models, model: this.model(session.sessionId), entries: this.rows.get(session.sessionId) ?? [], running: this.running.has(session.sessionId), commandRunning: this.running.has(session.sessionId), retrying: false, compacting: false, queue: { steering: [], followUp: [] }, streamingMessage: null };
  }
  async prompt(id: string, text: string, ask: (value: unknown[]) => void, socket: WebSocket): Promise<void> {
    const session = this.getSession(id); if (!session) throw new Error("Unknown prompt session");
    this.prompts.push({ sessionId: id, text, model: { ...this.model(id) } }); this.submitted(session);
    const rows = this.rows.get(id) ?? []; rows.push({ id: crypto.randomUUID(), type: "message", messages: [{ role: "user", content: text }] }); this.rows.set(id, rows);
    this.running.add(id); session.state = "running"; this.publish();
    if (/WAIT|ASK|DROP/.test(text)) {
      const gate = Promise.withResolvers<void>(); this.gates.set(id, { resolve: () => gate.resolve() });
      if (text.includes("ASK")) ask([{ id: crypto.randomUUID(), kind: "confirm", title: "计划任务确认", message: session.cwd, deadline: null }]);
      if (text.includes("DROP")) socket.terminate();
      await gate.promise; this.gates.delete(id);
    }
    const reason = this.aborted.has(id) ? "aborted" : text.includes("ERROR") ? "error" : "stop";
    const content = text.includes("MARKDOWN") ? MARKDOWN_REPLY : text.includes("BLOCKS") ? [{ type: "thinking", thinking: "不能展示的思考" }, { type: "text", text: "最终报告 <img src=x onerror=alert(1)> 中文 😀" }, { type: "toolCall", id: "tool", name: "隐藏工具", arguments: {} }] : text.includes("SECOND") ? "后续人工回复不能替换原结果" : "不应同步到中心的助手正文";
    rows.push({ id: crypto.randomUUID(), type: "message", messages: [{ role: "assistant", content, stopReason: reason, ...(reason === "error" ? { errorMessage: "模拟模型错误 中文 😀" } : {}) }] });
    this.running.delete(id); session.state = "idle"; session.modified = new Date().toISOString(); this.publish();
  }
  answer(id: string): void { this.gates.get(id)?.resolve(); }
  abort(id: string): void { this.aborted.add(id); this.running.delete(id); const session = this.getSession(id); if (session) session.state = "idle"; this.gates.get(id)?.resolve(); this.publish(); }
  close(): void { for (const gate of this.gates.values()) gate.resolve(); }
}
