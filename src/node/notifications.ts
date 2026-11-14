import type { NodeCompletionNotice } from "../shared/notifications.ts";
import { createSystemNotifier, type NotificationSender } from "./system-notifications.ts";

/** 只消费中心推送的新完成事实，重连复用有界去重集合，不重试系统弹窗。 */
export class LocalNotifications {
  readonly ready: Promise<boolean>;
  private sender: NotificationSender | null = null;
  private seen = new Set<string>();
  private controller = new AbortController();
  private tail = Promise.resolve();
  private pending = 0;
  private log: (message: string) => void;
  constructor(enabled: boolean, log: (message: string) => void, factory: () => Promise<NotificationSender | null> = createSystemNotifier) {
    this.log = log;
    this.ready = enabled ? factory().then((sender) => {
      this.sender = sender;
      if (!sender) this.log("本机通知不可用：需要桌面会话及系统通知工具，未订阅中心提醒");
      return sender !== null;
    }).catch(() => { this.log("本机通知初始化失败，未订阅中心提醒"); return false; }) : Promise.resolve(false);
  }
  async receive(notice: NodeCompletionNotice): Promise<void> {
    if (!await this.ready || this.controller.signal.aborted || this.seen.has(notice.id)) return;
    this.seen.add(notice.id);
    if (this.seen.size > 100) { const oldest = this.seen.values().next().value; if (oldest !== undefined) this.seen.delete(oldest); }
    if (this.pending >= 32) { this.log("本机通知队列已满，本条不弹出，完成记录仍保留在中心"); return; }
    this.pending++;
    const sender = this.sender;
    this.tail = this.tail.then(async () => {
      if (!this.controller.signal.aborted && sender) await sender(notice, this.controller.signal);
    }).catch(() => {
      if (!this.controller.signal.aborted) this.log("本机通知发送失败，未自动重试，可在消息中心查看完成记录");
    }).finally(() => { this.pending--; });
    await this.tail;
  }
  close(): void { this.controller.abort(); }
}
