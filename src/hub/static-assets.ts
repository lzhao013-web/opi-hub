import type { IncomingMessage, ServerResponse } from "node:http";
import type { Headers } from "../shared/protocol.ts";

/** 只允许已知构建资源路径，不把查询变体、源码映射或 API 文件当作静态代码。 */
export function isHashedAssetRequest(pathname: string, req: IncomingMessage): boolean {
  return (req.method === "GET" || req.method === "HEAD") && !req.headers.range &&
    /^\/assets\/[A-Za-z0-9_.~\-]+-[A-Za-z0-9_\-]{8,}\.(?:js|css)$/.test(pathname);
}
function acceptsGzip(header: string | undefined): boolean {
  let wildcard = false;
  for (const part of header?.toLowerCase().split(",") ?? []) {
    const [coding, ...parameters] = part.trim().split(";");
    if (coding?.trim() !== "gzip" && coding?.trim() !== "*") continue;
    const quality = parameters.map((value) => value.trim()).find((value) => value.startsWith("q="));
    const value = quality === undefined ? 1 : Number(quality.slice(2));
    const accepted = Number.isFinite(value) && value > 0 && value <= 1;
    if (coding.trim() === "gzip") return accepted;
    wildcard = accepted;
  }
  return wildcard;
}
/** 返回是否需要 gzip 流。HEAD/304 只设置所选表示的元数据，不创建压缩流。 */
export function configureAssetResponse(pathname: string, req: IncomingMessage, res: ServerResponse, status: number, headers: Headers): boolean {
  if (!isHashedAssetRequest(pathname, req)) return false;
  const type = headers["content-type"]?.split(";")[0]?.trim().toLowerCase();
  const correctType = pathname.endsWith(".css") ? type === "text/css" : type === "text/javascript" || type === "application/javascript";
  const revalidated = status === 304 && (req.headers["if-none-match"] !== undefined || req.headers["if-modified-since"] !== undefined);
  if (!(status === 200 && correctType || revalidated)) return false;
  // 浏览器私有缓存，登录 Cookie 改变后必须重新鉴权，公共代理不能复用。
  res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
  res.setHeader("Vary", "Cookie, Accept-Encoding");
  if (!acceptsGzip(req.headers["accept-encoding"])) return false;
  res.setHeader("Content-Encoding", "gzip"); res.removeHeader("Content-Length");
  if (headers.etag && !headers.etag.startsWith("W/")) res.setHeader("ETag", `W/${headers.etag}`);
  return status === 200 && req.method === "GET";
}
