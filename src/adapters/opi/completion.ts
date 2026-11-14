import { ExecutionState } from "./execution.ts";

/** 每条连接只观察实际经历的执行，初始历史快照和重连不产生完成提醒。 */
export class CompletionObserver {
  private execution = new ExecutionState();
  private sessionId: string | null = null;
  private active = false;
  private previousReply: string | null = null;
  private completed: (sessionId: string, replyId: string) => void;
  constructor(completed: (sessionId: string, replyId: string) => void) { this.completed = completed; }
  get busy(): boolean { return this.execution.busy; }
  consume(raw: unknown): void {
    const state = this.execution;
    if (!state.consume(raw)) return;
    if (state.sessionId !== this.sessionId) {
      this.sessionId = state.sessionId; this.active = false; this.previousReply = state.resultEntryId;
    }
    if (state.running && !this.active) { this.active = true; this.previousReply = state.resultEntryId; }
    if (state.busy || !this.active) return;
    this.active = false;
    const reply = state.resultEntryId;
    if (state.sessionId && reply && reply !== this.previousReply && ["stop", "length"].includes(state.result?.reason ?? "")) this.completed(state.sessionId, reply);
  }
}
