import { object } from "./protocol.ts";

/** 只有会话定位和完成事实，不包含模型回复或首条用户消息。 */
export interface CompletionNotice {
  id: string; sessionId: string; file: string | null; title: string; cwd: string; completedAt: string; runId: string | null;
}
export function isCompletionNotice(value: unknown): value is CompletionNotice {
  return object(value) && typeof value.id === "string" && typeof value.sessionId === "string" &&
    (value.file === null || typeof value.file === "string") && typeof value.title === "string" && typeof value.cwd === "string" &&
    typeof value.completedAt === "string" && (value.runId === null || typeof value.runId === "string");
}
export interface HubNotice extends CompletionNotice { deviceId: string; read: boolean }

export const isNotificationDestination = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9-]{36}$/.test(value);
export interface NotificationSubscription { type: "subscribeNotifications"; enabled: boolean; approvals?: true }
export interface NotificationSubscriptionStatus { type: "notificationSubscription"; active: boolean }
/** 节点弹窗只需要来源和标题，不下发正文、文件路径或浏览器凭据。 */
export interface NodeCompletionNotice { id: string; deviceId: string; deviceName: string; title: string; completedAt: string }
export interface NodeCompletionMessage { type: "completionNotification"; notice: NodeCompletionNotice }
export const MAX_APPROVAL_BODY = 320;
export interface NodeApprovalNotice { id: string; title: string; body: string }
export interface NodeApprovalMessage { type: "approvalNotification"; notice: NodeApprovalNotice }
export interface NotificationAnswer { type: "notificationAnswer"; id: string; decision: "allow" | "deny" }
export const isApprovalId = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
export function isNotificationAnswer(value: unknown): value is NotificationAnswer {
  return object(value) && value.type === "notificationAnswer" && isApprovalId(value.id) && (value.decision === "allow" || value.decision === "deny");
}
export function isNotificationSubscription(value: unknown): value is NotificationSubscription {
  return object(value) && value.type === "subscribeNotifications" && typeof value.enabled === "boolean" && (value.approvals === undefined || value.approvals === true);
}
export function isNodeCompletionNotice(value: unknown): value is NodeCompletionNotice {
  const text = (value: unknown, limit: number): value is string => typeof value === "string" && value.length <= limit && !value.includes("\0");
  return object(value) && Object.keys(value).every((key) => ["id", "deviceId", "deviceName", "title", "completedAt"].includes(key)) &&
    text(value.id, 1024) && value.id.length > 0 && isNotificationDestination(value.deviceId) && text(value.deviceName, 160) && text(value.title, 512) &&
    text(value.completedAt, 64) && Number.isFinite(Date.parse(value.completedAt));
}
export function isNodeNotificationMessage(value: unknown): value is NotificationSubscriptionStatus | NodeCompletionMessage | NodeApprovalMessage {
  if (!object(value)) return false;
  if (value.type === "notificationSubscription") return typeof value.active === "boolean";
  if (value.type === "completionNotification") return isNodeCompletionNotice(value.notice);
  const notice = value.notice;
  return value.type === "approvalNotification" && object(notice) && isApprovalId(notice.id) &&
    typeof notice.title === "string" && notice.title.length <= 128 && typeof notice.body === "string" && notice.body.length <= MAX_APPROVAL_BODY;
}
