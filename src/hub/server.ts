import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import { readFile } from "node:fs/promises";
import type { Duplex } from "node:stream";
import path from "node:path";
import { WebSocketServer } from "ws";
import { Auth } from "./auth.ts";
import { Store } from "./store.ts";
import { Nodes } from "./nodes.ts";
import { HttpError, readJson, reply } from "../shared/http.ts";
import { MAX_FRAME, object } from "../shared/protocol.ts";
import { resolveDevice } from "./native.ts";
import { proxyHttp, proxyWebSocket } from "./proxy.ts";
import { overview } from "./overview.ts";

export interface HubOptions {
  host: string; port: number; data: string; assets: string; publicUrl?: string;
  tls?: { cert: Buffer; key: Buffer };
}
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'";
export async function startHub(options: HubOptions) {
  const store = await Store.open(options.data);
  const auth = new Auth();
  const nodes = new Nodes();
  let origin = "";
  let closed = false;
  const configured = options.publicUrl ? new URL(options.publicUrl) : undefined;
  if (configured && (!["http:", "https:"].includes(configured.protocol) || configured.pathname !== "/" || configured.search || configured.hash || configured.username || configured.password)) throw new Error("public-url 必须是 HTTP(S) 入口地址，不包含路径和凭据");
  const secure = configured ? configured.protocol === "https:" : Boolean(options.tls);
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME, perMessageDeflate: false });
  const assets: Record<string, { file: string; type: string }> = {
    "/": { file: "index.html", type: "text/html; charset=utf-8" },
    "/_hub/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
    "/_hub/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
    "/_hub/bridge.js": { file: "bridge.js", type: "text/javascript; charset=utf-8" },
    "/_hub/bridge.css": { file: "bridge.css", type: "text/css; charset=utf-8" },
    "/_hub/management.js": { file: "management.js", type: "text/javascript; charset=utf-8" },
    "/_hub/history.js": { file: "history.js", type: "text/javascript; charset=utf-8" },
    "/_hub/navigation.js": { file: "navigation.js", type: "text/javascript; charset=utf-8" },
    "/_hub/views.js": { file: "views.js", type: "text/javascript; charset=utf-8" },
    "/_hub/icon.svg": { file: "icon.svg", type: "image/svg+xml" },
  };
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("Content-Security-Policy", CSP);
    try {
      const url = new URL(req.url ?? "/", origin);
      if (req.headers.host !== new URL(origin).host) throw new HttpError(421, "Host 与中心入口不匹配，请检查 public-url");
      if (url.pathname === "/_hub/health" && req.method === "GET") { reply(res, 200, { ok: true }); return; }
      if (url.pathname === "/_hub/login" && req.method === "POST") {
        auth.checkOrigin(req, origin); auth.attempt(req);
        const body = await readJson(req);
        if (!object(body) || typeof body.password !== "string" || body.password.length > 1024) throw new HttpError(400, "无效的密码");
        if (!await store.verifyPassword(body.password)) throw new HttpError(401, "密码不正确");
        auth.login(req, res, secure); reply(res, 200, { ok: true }); return;
      }
      if (url.pathname === "/_hub/logout" && req.method === "POST") {
        auth.checkOrigin(req, origin); auth.logout(req, res, secure); reply(res, 200, { ok: true }); return;
      }
      if (url.pathname === "/_hub/me" && req.method === "GET") { reply(res, 200, { authenticated: Boolean(auth.get(req)) }); return; }
      if (url.pathname === "/_hub/overview" && req.method === "GET") {
        auth.require(req); reply(res, 200, overview(store, nodes)); return;
      }
      if (url.pathname === "/_hub/history" && req.method === "POST") {
        const session = auth.require(req); auth.checkOrigin(req, origin);
        const body = await readJson(req);
        if (!object(body) || typeof body.deviceId !== "string") throw new HttpError(400, "需要设备标识");
        if (!store.get(body.deviceId)) throw new HttpError(404, "设备不存在");
        const controller = new AbortController(); const cancel = () => controller.abort();
        session.close.add(cancel); res.once("close", cancel);
        try {
          const result = await nodes.history(body.deviceId, controller.signal);
          reply(res, 200, { deviceId: body.deviceId, ...result });
        } catch (error) { throw new HttpError(409, error instanceof Error ? error.message : "历史查询失败"); }
        finally { session.close.delete(cancel); res.off("close", cancel); }
        return;
      }
      if (url.pathname === "/_hub/respond" && req.method === "POST") {
        const session = auth.require(req); auth.checkOrigin(req, origin);
        const body = await readJson(req, 1024 * 1024);
        if (!object(body) || typeof body.deviceId !== "string" || typeof body.sessionId !== "string" || typeof body.dialogId !== "string" || !(typeof body.value === "string" || body.value === null)) throw new HttpError(400, "无效的交互回答");
        if (!store.get(body.deviceId)) throw new HttpError(404, "设备不存在");
        const controller = new AbortController();
        const cancel = () => controller.abort();
        session.close.add(cancel); res.once("close", cancel);
        try { await nodes.respond(body.deviceId, body.sessionId, body.dialogId, body.value, controller.signal); }
        catch (error) { throw new HttpError(409, error instanceof Error ? error.message : "提交失败，请检查原会话状态"); }
        finally { session.close.delete(cancel); res.off("close", cancel); }
        reply(res, 200, { ok: true }); return;
      }
      if (url.pathname === "/_hub/devices") {
        auth.require(req);
        if (req.method === "GET") {
          reply(res, 200, store.list().map(({ tokenHash: _hash, ...device }) => ({ ...device, ...nodes.status(device.id) }))); return;
        }
        if (req.method === "POST") {
          auth.checkOrigin(req, origin);
          const body = await readJson(req);
          if (!object(body) || typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 80) throw new HttpError(400, "设备名称需要 1–80 个字符");
          const { device, token } = await store.add(body.name.trim());
          reply(res, 201, { id: device.id, config: { hub: origin, token, target: "http://127.0.0.1:19198" } }); return;
        }
        throw new HttpError(405, "不支持此操作");
      }
      const remove = /^\/_hub\/devices\/([a-f0-9-]{36})$/.exec(url.pathname);
      if (remove?.[1] && req.method === "DELETE") {
        auth.require(req); auth.checkOrigin(req, origin);
        await store.remove(remove[1]); nodes.disconnect(remove[1]); reply(res, 200, { ok: true }); return;
      }
      const asset = assets[url.pathname];
      if (asset && (req.method === "GET" || req.method === "HEAD")) {
        if (url.pathname === "/_hub/bridge.js") auth.require(req);
        const content = await readFile(path.join(options.assets, asset.file));
        res.writeHead(200, { "Content-Type": asset.type }); res.end(req.method === "HEAD" ? undefined : content); return;
      }
      const route = resolveDevice(req, url, origin);
      if (route) {
        const session = auth.get(req);
        if (!session && req.method === "GET" && req.headers.accept?.includes("text/html")) { res.writeHead(303, { Location: "/" }).end(); return; }
        const authenticated = session ?? auth.require(req);
        if (!store.get(route.id)) throw new HttpError(404, "设备不存在");
        if (!["GET", "HEAD"].includes(req.method ?? "")) auth.checkOrigin(req, origin);
        if (req.headers["sec-fetch-site"] === "cross-site") throw new HttpError(403, "不允许跨站访问");
        await proxyHttp(nodes, route.id, route.path, req, res, authenticated); return;
      }
      throw new HttpError(404, "页面不存在");
    } catch (error) {
      if (res.headersSent || res.destroyed) { if (!res.writableFinished) res.destroy(); return; }
      reply(res, error instanceof HttpError ? error.status : 500, { error: error instanceof Error ? error.message : "请求失败" });
    }
  };
  const server = options.tls ? https.createServer(options.tls, (req, res) => { void handle(req, res); }) : http.createServer((req, res) => { void handle(req, res); });
  server.on("upgrade", (req, socket, head) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", origin);
        if (req.headers.host !== new URL(origin).host) throw new HttpError(421, "Host mismatch");
        if (url.pathname === "/_hub/connect" || url.pathname.startsWith("/_hub/stream/")) {
          const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
          const device = token ? store.authenticate(token) : undefined;
          if (!device) throw new HttpError(401, "Invalid device credentials");
          if (url.pathname === "/_hub/connect") sockets.handleUpgrade(req, socket, head, (ws) => nodes.register(device.id, ws));
          else {
            const id = url.pathname.slice("/_hub/stream/".length);
            if (!nodes.accepts(device.id, id)) throw new HttpError(403, "Expired stream");
            sockets.handleUpgrade(req, socket, head, (ws) => nodes.accept(device.id, id, ws));
          }
          return;
        }
        const session = auth.require(req);
        auth.checkOrigin(req, origin);
        const route = resolveDevice(req, url, origin);
        if (!route || !store.get(route.id)) throw new HttpError(404, "Unknown device");
        await proxyWebSocket(nodes, sockets, route.id, route.path, req, socket, head, session);
      } catch (error) { rejectUpgrade(socket, error instanceof HttpError ? error.status : 500); }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("未能取得监听地址");
  const host = options.host.includes(":") ? `[${options.host}]` : options.host;
  const listenUrl = `${options.tls ? "https" : "http"}://${host}:${address.port}`;
  origin = configured?.origin ?? listenUrl;
  return {
    url: origin, listenUrl,
    async close() {
      if (closed) return;
      closed = true; auth.close(); nodes.close();
      for (const ws of sockets.clients) ws.terminate();
      sockets.close();
      const closing = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      server.closeAllConnections();
      await closing;
    },
  };
}
function rejectUpgrade(socket: Duplex, status: number): void {
  if (!socket.destroyed) socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\n\r\n`);
}
