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
