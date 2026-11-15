import { WebSocket } from "ws";

export const MAX_FRAME = 16 * 1024 * 1024;
// 原生会话快照可能超过控制消息限额，数据通道单独限制解压后的完整消息。
export const MAX_DATA_FRAME = 64 * 1024 * 1024;
export type Headers = Record<string, string>;
export type OpenRequest = { type: "open"; id: string; kind: "http" | "websocket"; method: string; path: string; headers: Headers };
export type HttpReply = { type: "response"; status: number; headers: Headers } | { type: "end" } | { type: "error"; message: string };

export function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function parse(text: string): unknown { return JSON.parse(text); }
export function headers(value: unknown): value is Headers {
  return object(value) && Object.entries(value).every(([key, item]) => /^[a-z0-9-]+$/.test(key) && typeof item === "string" && !/[\r\n]/.test(item));
}
export function isOpen(value: unknown): value is OpenRequest {
  return object(value) && value.type === "open" && typeof value.id === "string" &&
    (value.kind === "http" || value.kind === "websocket") && typeof value.method === "string" &&
    typeof value.path === "string" && value.path.startsWith("/") && !/[\r\n]/.test(value.path) && headers(value.headers);
}
export function isReply(value: unknown): value is HttpReply {
  return object(value) && (value.type === "end" ||
    (value.type === "error" && typeof value.message === "string") ||
    (value.type === "response" && Number.isInteger(value.status) && typeof value.status === "number" && value.status >= 200 && value.status <= 599 && headers(value.headers)));
}
export function send(ws: WebSocket, value: string | Buffer, binary = Buffer.isBuffer(value)): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState !== WebSocket.OPEN) { reject(new Error("连接已断开")); return; }
    ws.send(value, { binary }, (error) => error ? reject(error) : resolve());
  });
}
export function json(ws: WebSocket, value: unknown): Promise<void> { return send(ws, JSON.stringify(value), false); }
export function webSocketUrl(base: string, pathname: string): string {
  const url = new URL(pathname, base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}
