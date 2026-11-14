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
export interface NotificationSubscription { type: "subscribeNotifications"; enabled: boolean }
export interface NotificationSubscriptionStatus { type: "notificationSubscription"; active: boolean }
/** 节点弹窗只需要来源和标题，不下发正文、文件路径或浏览器凭据。 */
export interface NodeCompletionNotice { id: string; deviceId: string; deviceName: string; title: string; completedAt: string }
export interface NodeCompletionMessage { type: "completionNotification"; notice: NodeCompletionNotice }
export function isNotificationSubscription(value: unknown): value is NotificationSubscription {
  return object(value) && value.type === "subscribeNotifications" && typeof value.enabled === "boolean";
}
export function isNodeCompletionNotice(value: unknown): value is NodeCompletionNotice {
  const text = (value: unknown, limit: number): value is string => typeof value === "string" && value.length <= limit && !value.includes("\0");
  return object(value) && Object.keys(value).every((key) => ["id", "deviceId", "deviceName", "title", "completedAt"].includes(key)) &&
    text(value.id, 1024) && value.id.length > 0 && isNotificationDestination(value.deviceId) && text(value.deviceName, 160) && text(value.title, 512) &&
    text(value.completedAt, 64) && Number.isFinite(Date.parse(value.completedAt));
}
export function isNodeNotificationMessage(value: unknown): value is NotificationSubscriptionStatus | NodeCompletionMessage {
  return object(value) && (value.type === "notificationSubscription" && typeof value.active === "boolean" ||
    value.type === "completionNotification" && isNodeCompletionNotice(value.notice));
}
