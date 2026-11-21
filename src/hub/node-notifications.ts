import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { json } from "../shared/protocol.ts";
import { MAX_APPROVAL_BODY, isNodeCompletionNotice, type HubNotice, type NodeApprovalMessage, type NodeCompletionMessage, type NotificationAnswer, type NotificationSubscriptionStatus } from "../shared/notifications.ts";
import type { ManagementState } from "../shared/management.ts";
import { HttpError } from "../shared/http.ts";
import type { NotificationCenter } from "./notifications.ts";
import type { Store } from "./store.ts";

// o-pi 命令审批在协议中以选项文字作为值，仅转发这两种原有选项。
const approvalChoice = { allow: "Allow once", deny: "Deny" } as const;
interface ApprovalTarget { deviceId: string; sessionId: string; dialogId: string; destination: string }
interface Receiver { socket: WebSocket; active?: boolean; approvals?: Map<string, ApprovalTarget> }
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
  subscribe(deviceId: string, socket: WebSocket, enabled: boolean, approvals?: true): void {
    if (!enabled) { this.receivers.delete(deviceId); this.sendStatus(socket, false); return; }
    const receiver: Receiver = { socket, approvals: approvals ? new Map() : undefined };
    this.receivers.set(deviceId, receiver); this.reconcile(deviceId, receiver);
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
  disconnect(deviceId: string): void {
    this.receivers.delete(deviceId);
    for (const receiver of this.receivers.values()) {
      if (!receiver.approvals) continue;
      for (const [id, target] of receiver.approvals) if (target.deviceId === deviceId) receiver.approvals.delete(id);
    }
  }
  offerApprovals(deviceId: string, state: ManagementState, previous?: ManagementState): void {
    if (state.state !== "ready") return;
    if (![...this.receivers.values()].some((receiver) => receiver.approvals)) return;
    const prior = new Set(previous?.state === "ready" ? previous.interactions.map((item) => JSON.stringify([item.sessionId, item.id])) : []);
    const name = (this.store.get(deviceId)?.name ?? "设备").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 96);
    for (const item of state.interactions) {
      if (item.kind !== "command" || prior.has(JSON.stringify([item.sessionId, item.id]))) continue;
      if (!Object.values(approvalChoice).every((value) => item.options.some((option) => option.value === value))) continue;
      const scope = item.targets.map((target) => `${target.action} ${target.kind} ${target.target}`).join("；");
      const lines = [item.command, `目录：${item.cwd}`];
      if (scope) lines.push(`范围：${scope}`);
      const body = lines.join("\n");
      if (body.length > MAX_APPROVAL_BODY || lines.some((line) => /[\u0000-\u001f\u007f]/.test(line))) continue;
      for (const [receiverId, receiver] of this.receivers) {
        const destination = this.store.get(receiverId)?.notificationDestination;
        if (!receiver.approvals || !destination || !this.status(receiverId) || receiver.socket.bufferedAmount > 64 * 1024) continue;
        const id = randomUUID();
        const oldest = receiver.approvals.size >= 100 ? receiver.approvals.keys().next().value : undefined;
        if (oldest !== undefined) receiver.approvals.delete(oldest);
        receiver.approvals.set(id, { deviceId, sessionId: item.sessionId, dialogId: item.id, destination });
        const notice = { id, title: `o-pi 命令审批 · ${name}`, body };
        void json(receiver.socket, { type: "approvalNotification", notice } satisfies NodeApprovalMessage).catch(() => receiver.socket.terminate());
      }
    }
  }
  takeApproval(receiverId: string, socket: WebSocket, answer: NotificationAnswer) {
    const receiver = this.receivers.get(receiverId);
    if (receiver?.socket !== socket) return;
    const approvals = receiver.approvals;
    if (!approvals) return;
    const target = approvals.get(answer.id);
    if (!target || target.destination !== this.store.get(receiverId)?.notificationDestination) return;
    approvals.delete(answer.id);
    return { deviceId: target.deviceId, sessionId: target.sessionId, dialogId: target.dialogId, value: approvalChoice[answer.decision] };
  }
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
