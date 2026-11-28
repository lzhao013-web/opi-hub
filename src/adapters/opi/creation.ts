import type { InteractionAnswer } from "../../shared/management.ts";
import type { CreationRecord } from "../../shared/session-creation.ts";
import { isAbsoluteDirectory } from "../../shared/session-creation.ts";
import { SessionPort } from "./session.ts";

/** 创建过程与浏览器请求分离；启动交互仍由独立会话客户端处理。 */
export class SessionCreation {
  readonly requestedPath: string;
  private controller = new AbortController(); private task: Promise<void>; private port: SessionPort;
  record: CreationRecord;
  get selected() { return this.port.selected; }
  get dialogs() { return this.port.dialogs; }
  constructor(target: URL, id: string, path: string, changed: () => void) {
    if (!isAbsoluteDirectory(path)) throw new Error("需要目标设备上的绝对目录路径");
    this.requestedPath = path; this.record = { id, path, startedAt: new Date().toISOString(), state: "creating", phase: "checking" };
    this.port = new SessionPort(target, changed); this.task = this.run(changed);
  }
  private async run(changed: () => void): Promise<void> {
    try {
      const session = await this.port.create(this.requestedPath, this.controller.signal, (phase, path) => { this.record = { ...this.record, path, state: "creating", phase }; changed(); });
      this.record = { id: this.record.id, path: session.cwd, startedAt: this.record.startedAt, state: "ready", session };
    } catch (error) {
      this.record = { id: this.record.id, path: this.record.path, startedAt: this.record.startedAt, state: "error", error: error instanceof Error ? error.message : String(error), session: this.port.selected };
    } finally { await this.port.finish(); changed(); }
  }
  respond(answer: InteractionAnswer) { return this.port.respond(answer); }
  async close(): Promise<void> { this.controller.abort(); this.port.close(); await this.task; }
}
