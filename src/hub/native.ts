import type { IncomingMessage } from "node:http";

export const devicePrefix = (id: string) => `/n/${id}/`;
const routePattern = /^\/n\/([a-f0-9-]{36})(\/.*)$/;
export function deviceRoute(pathname: string): { id: string; path: string } | undefined {
  const match = routePattern.exec(pathname);
  const id = match?.[1];
  const path = match?.[2];
  return id && path ? { id, path } : undefined;
}
export function resolveDevice(req: IncomingMessage, url: URL, origin: string): { id: string; path: string } | undefined {
  const direct = deviceRoute(url.pathname);
  if (direct) return { id: direct.id, path: direct.path + url.search };
  // 原生 GUI 的文件 URL 是根路径。以请求来源所在设备路由，不使用浏览器共享的“当前设备”。
  if (!url.pathname.startsWith("/api/")) return undefined;
  const referer = req.headers.referer;
  if (!referer) return undefined;
  let source: URL;
  try { source = new URL(referer); } catch { return undefined; }
  const route = source.origin === origin ? deviceRoute(source.pathname) : undefined;
  return route ? { id: route.id, path: url.pathname + url.search } : undefined;
}
export function adaptHtml(html: string, id: string): string {
  const prefix = devicePrefix(id);
  const adapted = html
    .replace(/<link\s[^>]*>/gi, (tag) => {
      const isLocalManifest = /\srel\s*=\s*(['"])manifest\1/i.test(tag)
        && /\shref\s*=\s*(['"])(?:\.?\/)?site\.webmanifest\1/i.test(tag);
      if (!isLocalManifest || /\scrossorigin(?=[\s=/>])/i.test(tag)) return tag;
      return tag.replace(/^<link/i, '$& crossorigin="use-credentials"');
    })
    .replace(/\b(src|href)=(['"])\/(?!\/)/g, `$1=$2${prefix}`);
  const bridge = `<link rel="stylesheet" href="/_hub/bridge.css"><script src="/_hub/bridge.js" data-prefix="${prefix}"></script>`;
  if (!/<head(?:\s[^>]*)?>/i.test(adapted)) throw new Error("目标没有返回 o-pi HTML 页面");
  return adapted.replace(/<head(?:\s[^>]*)?>/i, (head) => head + bridge);
}
