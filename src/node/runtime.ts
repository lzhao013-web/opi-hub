import type { ManagementState } from "../shared/management.ts";
import { OpiManagement } from "../adapters/opi/management.ts";
import { ManagedBackend, type BackendConfig } from "./backend.ts";

/** 托管进程和 SDK 订阅同属节点；中心连接变化不会重启它们。 */
export class NodeRuntime {
  private backendProcess: ManagedBackend;
  private active: OpiManagement | undefined;
  private transition = Promise.resolve();
  private version = 0;
  private closed = false;
  private state: ManagementState = { state: "connecting" };
  private onManagement: (value: ManagementState) => void;
  private onBackend: () => void;
  constructor(config: BackendConfig, onManagement: (value: ManagementState) => void, onBackend: () => void) {
    this.onManagement = onManagement; this.onBackend = onBackend;
    this.backendProcess = new ManagedBackend(config, () => this.reconcile());
  }
  get backend() { return this.backendProcess.status; }
  get snapshot(): ManagementState { return this.state; }
  get target(): URL {
    const backend = this.backend;
    if (backend.state !== "running") throw new Error(backend.state === "error" ? backend.message : "托管后端尚未运行");
    return new URL(backend.url);
  }
  get management(): OpiManagement {
    if (!this.active) throw new Error("托管后端的会话管理尚未就绪");
    return this.active;
  }
  observe(socket: import("ws").WebSocket): void { this.active?.trackViewer(socket); }
  restart(): void { this.backendProcess.restart(); }
  private publish(value: ManagementState): void { this.state = value; if (!this.closed) this.onManagement(value); }
  private reconcile(): void {
    const status = this.backend;
    const previous = this.active; this.active = undefined;
    const version = ++this.version;
    this.publish(status.state === "error" ? { state: "error", message: status.message } : { state: "connecting" });
    this.transition = this.transition.then(async () => {
      await previous?.close();
      if (this.closed || version !== this.version || status.state !== "running") return;
      const management = new OpiManagement(new URL(status.url), (value) => {
        if (!this.closed && version === this.version) this.publish(value);
      });
      this.active = management;
    }).catch((error: unknown) => this.publish({ state: "error", message: error instanceof Error ? error.message : String(error) }));
    if (!this.closed) this.onBackend();
  }
  async close(): Promise<void> {
    this.closed = true; await this.backendProcess.close(); await this.transition;
  }
}
