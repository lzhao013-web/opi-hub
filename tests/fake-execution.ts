import type { WebSocket } from "ws";

interface Session { sessionId: string; path: string; cwd: string; title: string; modified: string; state: "idle" | "waiting" | "running" }
export class FakeExecution {
  readonly prompts: { sessionId: string; text: string }[] = [];
  private getSession: (id: string) => Session | undefined; private publish: () => void; private submitted: (session: Session) => void;
  private running = new Set<string>(); private aborted = new Set<string>(); private rows = new Map<string, unknown[]>();
  private gates = new Map<string, { resolve(): void }>();
  constructor(getSession: (id: string) => Session | undefined, publish: () => void, submitted: (session: Session) => void) { this.getSession = getSession; this.publish = publish; this.submitted = submitted; }
  snapshot(id: string | null) {
    const session = id ? this.getSession(id) : undefined; if (!session) return null;
    return { sessionId: session.sessionId, cwd: session.cwd, entries: this.rows.get(session.sessionId) ?? [], running: this.running.has(session.sessionId), commandRunning: this.running.has(session.sessionId), retrying: false, compacting: false, queue: { steering: [], followUp: [] }, streamingMessage: null };
  }
  async prompt(id: string, text: string, ask: (value: unknown[]) => void, socket: WebSocket): Promise<void> {
    const session = this.getSession(id); if (!session) throw new Error("Unknown prompt session");
    this.prompts.push({ sessionId: id, text }); this.submitted(session);
    const rows = this.rows.get(id) ?? []; rows.push({ id: crypto.randomUUID(), type: "message", messages: [{ role: "user", content: text }] }); this.rows.set(id, rows);
    this.running.add(id); session.state = "running"; this.publish();
    if (/WAIT|ASK|DROP/.test(text)) {
      const gate = Promise.withResolvers<void>(); this.gates.set(id, { resolve: () => gate.resolve() });
      if (text.includes("ASK")) ask([{ id: crypto.randomUUID(), kind: "confirm", title: "计划任务确认", message: session.cwd, deadline: null }]);
      if (text.includes("DROP")) socket.terminate();
      await gate.promise; this.gates.delete(id);
    }
    const reason = this.aborted.has(id) ? "aborted" : text.includes("ERROR") ? "error" : "stop";
    rows.push({ id: crypto.randomUUID(), type: "message", messages: [{ role: "assistant", content: "不应同步到中心的助手正文", stopReason: reason, ...(reason === "error" ? { errorMessage: "模拟模型错误 中文 😀" } : {}) }] });
    this.running.delete(id); session.state = "idle"; session.modified = new Date().toISOString(); this.publish();
  }
  answer(id: string): void { this.gates.get(id)?.resolve(); }
  abort(id: string): void { this.aborted.add(id); this.running.delete(id); const session = this.getSession(id); if (session) session.state = "idle"; this.gates.get(id)?.resolve(); this.publish(); }
  close(): void { for (const gate of this.gates.values()) gate.resolve(); }
}
