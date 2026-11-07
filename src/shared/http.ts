import type { IncomingMessage, ServerResponse } from "node:http";
import type { Headers } from "./protocol.ts";

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export async function readJson(req: IncomingMessage, limit = 64 * 1024): Promise<unknown> {
  if (req.headers["content-type"]?.split(";")[0] !== "application/json") throw new HttpError(415, "需要 application/json");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += data.length;
    if (size > limit) throw new HttpError(413, "请求过大");
    chunks.push(data);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new HttpError(400, "无效的 JSON"); }
}
export function reply(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}
const requestHeaders = new Set(["content-type", "accept", "accept-language", "range", "if-range", "x-opi-client"]);
const responseHeaders = new Set(["content-type", "content-length", "content-range", "accept-ranges", "content-disposition", "etag", "last-modified", "content-security-policy", "location"]);
export function forwardedRequest(req: IncomingMessage): Headers {
  const result: Headers = {};
  for (const [key, value] of Object.entries(req.headers)) if (requestHeaders.has(key) && typeof value === "string") result[key] = value;
  return result;
}
export function forwardedResponse(input: Record<string, string | string[] | number | undefined>): Headers {
  const result: Headers = {};
  for (const [key, value] of Object.entries(input)) if (responseHeaders.has(key) && typeof value === "string") result[key] = value;
  return result;
}
