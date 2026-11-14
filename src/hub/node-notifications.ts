import { WebSocket } from "ws";
import { json } from "../shared/protocol.ts";
import { isNodeCompletionNotice, type HubNotice, type NodeCompletionMessage, type NotificationSubscriptionStatus } from "../shared/notifications.ts";
import { HttpError } from "../shared/http.ts";
import type { NotificationCenter } from "./notifications.ts";
import type { Store } from "./store.ts";

interface Receiver { socket: WebSocket; active?: boolean }
/** 本机开关只决定是否订阅；跨设备摘要的接收权限必须由已登录浏览器授予。 */
export class NodeNotifications {
  private receivers = new Map<string, Receiver>();
  private stop: () => void;
  private store: Store;
  private center: NotificationCenter;
  constructor(store: Store, center: NotificationCenter) {
    this.store = store; this.center = center;
    this.stop = center.onLive((notice) => this.deliver(notice));
  }
  subscribe(deviceId: string, socket: WebSocket, enabled: boolean): void {
    if (!enabled) { this.disconnect(deviceId); this.sendStatus(socket, false); return; }
    const receiver: Receiver = { socket }; this.receivers.set(deviceId, receiver); this.reconcile(deviceId, receiver);
  }
  status(deviceId: string): boolean {
    const receiver = this.receivers.get(deviceId);
    return Boolean(receiver && receiver.socket.readyState === WebSocket.OPEN && this.store.get(deviceId)?.notificationDestination);
  }
  activeDestination(destination: string): boolean {
    return this.store.list().some((device) => device.notificationDestination === destination && this.status(device.id));
  }
  async bind(deviceId: string | null, destination: string): Promise<void> {
    if (!await this.store.bindNotifications(deviceId, destination)) throw new HttpError(404, "通知接收设备不存在");
    for (const [id, receiver] of this.receivers) this.reconcile(id, receiver);
  }
  disconnect(deviceId: string): void { this.receivers.delete(deviceId); }
  close(): void { this.stop(); this.receivers.clear(); }
  private sendStatus(socket: WebSocket, active: boolean): void {
    void json(socket, { type: "notificationSubscription", active } satisfies NotificationSubscriptionStatus).catch(() => socket.terminate());
  }
  private reconcile(id: string, receiver: Receiver): void {
    const active = this.status(id);
    if (receiver.active === active) return;
    receiver.active = active; this.sendStatus(receiver.socket, active);
  }
  private deliver(notice: HubNotice): void {
    const clean = (text: string, limit: number) => Array.from(text.replace(/[\u0000-\u001f\u007f]/g, " ")).slice(0, limit).join("");
    const payload = { id: notice.id, deviceId: notice.deviceId, deviceName: clean(this.store.get(notice.deviceId)?.name ?? "设备", 80), title: clean(notice.title, 256), completedAt: notice.completedAt };
    if (!isNodeCompletionNotice(payload)) return;
    for (const [id, receiver] of this.receivers) {
      const destination = this.store.get(id)?.notificationDestination;
      if (!destination || !this.status(id) || receiver.socket.bufferedAmount > 64 * 1024) continue;
      try { if (!this.center.claim(notice.id, destination)) continue; }
      catch { continue; } // 单条通知的接收端上限不应中断执行节点的管理订阅。
      void json(receiver.socket, { type: "completionNotification", notice: payload } satisfies NodeCompletionMessage).catch(() => receiver.socket.terminate());
    }
  }
}
