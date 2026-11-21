import type { NodeApprovalNotice } from "../shared/notifications.ts";
import { createSystemNotifier, type DesktopNotice, type LinuxApprovalSender, type NotificationSender } from "./system-notifications.ts";

function detail(error: unknown): string {
  return error instanceof Error ? error.message : "未知错误";
}
/** 重连复用有界去重集合，不重试系统弹窗。 */
export class LocalNotifications {
  readonly ready: Promise<boolean>;
  private sender: NotificationSender | null = null;
  private seen = new Set<string>();
  private controller = new AbortController();
  private tail = Promise.resolve();
  private pending = 0;
  private waitingForAction = 0;
  private log: (message: string) => void;
  constructor(enabled: boolean, log: (message: string) => void, factory: () => Promise<NotificationSender | null> = createSystemNotifier) {
    this.log = log;
    this.ready = enabled ? factory().then((sender) => {
      this.sender = sender;
      if (!sender) this.log("本机通知不可用：需要桌面会话及系统通知工具，未订阅中心提醒");
      return sender !== null;
    }).catch((error: unknown) => { this.log(`本机通知初始化失败：${detail(error)}，未订阅中心提醒`); return false; }) : Promise.resolve(false);
  }
  private remember(id: string): boolean {
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    if (this.seen.size > 100) { const oldest = this.seen.values().next().value; if (oldest !== undefined) this.seen.delete(oldest); }
    return true;
  }
  async receive(notice: DesktopNotice): Promise<void> {
    if (!await this.ready || this.controller.signal.aborted || !this.remember(notice.id)) return;
    if (this.pending >= 32) { this.log("本机通知队列已满，本条不弹出，可在消息中心查看"); return; }
    this.pending++;
    const sender = this.sender;
    this.tail = this.tail.then(async () => {
      if (!this.controller.signal.aborted && sender) await sender(notice, this.controller.signal);
    }).catch((error: unknown) => {
      if (!this.controller.signal.aborted) this.log(`本机通知发送失败：${detail(error)}，未自动重试，可在消息中心查看`);
    }).finally(() => { this.pending--; });
    await this.tail;
  }
  async receiveLinuxApproval(notice: NodeApprovalNotice, send: LinuxApprovalSender, connection: AbortSignal, url?: string) {
    if (!await this.ready || connection.aborted || this.controller.signal.aborted || !this.remember(notice.id)) return;
    if (this.waitingForAction >= 8) { this.log("本机正在等待的审批通知过多，可在消息中心处理"); return; }
    // 等待桌面按钮使用独立的并发额度，不占用普通通知队列。
    const signal = AbortSignal.any([this.controller.signal, connection]);
    this.waitingForAction++;
    try { return await send(notice, signal, url); }
    catch (error) {
      if (!signal.aborted) this.log(`本机审批通知失败：${detail(error)}，可在消息中心处理`);
    } finally { this.waitingForAction--; }
  }
  close(): void { this.controller.abort(); }
}
