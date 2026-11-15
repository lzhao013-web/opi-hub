import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex, Writable } from "node:stream";
import { createGzip, type Gzip } from "node:zlib";
import { WebSocket, type WebSocketServer } from "ws";
import { forwardedRequest, HttpError } from "../shared/http.ts";
import { isReply, json, object, parse, send } from "../shared/protocol.ts";
import { buffer, couple, forward } from "../shared/sockets.ts";
import type { Session } from "./auth.ts";
import type { Nodes } from "./nodes.ts";
import { adaptHtml, devicePrefix } from "./native.ts";
import { configureAssetResponse, isHashedAssetRequest } from "./static-assets.ts";

export async function proxyHttp(nodes: Nodes, id: string, pathname: string, req: IncomingMessage, res: ServerResponse, session: Session): Promise<void> {
  const abort = new AbortController();
  const cancel = () => abort.abort();
  res.once("close", cancel);
  const headers = forwardedRequest(req);
  if (isHashedAssetRequest(pathname, req)) for (const name of ["if-none-match", "if-modified-since"]) {
    const value = req.headers[name]; if (typeof value === "string") headers[name] = value;
  }
  let tunnel: WebSocket;
  try { tunnel = await nodes.open(id, { kind: "http", method: req.method ?? "GET", path: pathname, headers }, abort.signal); }
  catch (error) { res.off("close", cancel); throw new HttpError(502, error instanceof Error ? error.message : "设备连接失败"); }
  const stop = () => { tunnel.terminate(); if (!res.writableFinished) res.destroy(); };
  session.close.add(stop);
  let received = false;
  let ended = false;
  let html: Buffer[] | undefined;
  let htmlSize = 0;
  let output: Writable = res;
  let compression: Gzip | undefined;
  const operation = req.method === "POST" && /^\/api\/(?:action|query)(?:\?|$)/.test(pathname);
  let timeout = setTimeout(() => { fail(new Error("节点 HTTP 通道就绪超时")); }, 10_000);
  const fail = (error: Error) => {
    compression?.unpipe(res); compression?.destroy();
    if (!res.headersSent) {
      for (const name of ["Content-Encoding", "Content-Length", "Content-Range", "ETag", "Last-Modified"]) res.removeHeader(name);
      res.setHeader("Cache-Control", "no-store");
      res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" }).end(error.message);
    } else if (!res.writableFinished) res.destroy(error);
    tunnel.terminate();
  };
  const cleanup = () => {
    clearTimeout(timeout); session.close.delete(stop); res.off("close", cancel);
  };
  res.once("close", () => { if (!ended) tunnel.terminate(); compression?.destroy(); cleanup(); });
  const resume = () => { if (tunnel.readyState === WebSocket.OPEN) tunnel.resume(); };
  tunnel.on("message", (raw, binary) => {
    try {
      if (binary) {
        if (!received || ended) throw new Error("无效的数据顺序");
        const data = buffer(raw);
        if (html) {
          htmlSize += data.length;
          if (htmlSize > 2 * 1024 * 1024) throw new Error("HTML 入口过大");
          html.push(data);
        } else if (!output.write(data)) tunnel.pause();
        return;
      }
      const value = parse(raw.toString());
      if (object(value) && value.type === "ready" && !received) { clearTimeout(timeout); void upload(); return; }
      if (!isReply(value)) throw new Error("无效的设备响应");
      if (value.type === "error") throw new Error(value.message);
      if (value.type === "response") {
        if (received) throw new Error("响应头重复");
        received = true;
        clearTimeout(timeout);
        for (const [key, item] of Object.entries(value.headers)) res.setHeader(key, item);
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Referrer-Policy", "same-origin");
        res.setHeader("X-Content-Type-Options", "nosniff");
        const location = value.headers.location;
        if (location?.startsWith("/") && !location.startsWith("//")) res.setHeader("Location", devicePrefix(id).slice(0, -1) + location);
        res.statusCode = value.status;
        if (configureAssetResponse(pathname, req, res, value.status, value.headers)) {
          compression = createGzip({ level: 3 }); compression.on("error", fail); compression.pipe(res); output = compression;
        }
        output.on("drain", resume);
        if (value.headers["content-type"]?.includes("text/html") && req.method !== "HEAD" && pathname.split("?")[0] === "/") {
          html = []; res.removeHeader("Content-Length");
        }
      } else {
        if (!received || ended) throw new Error("无效的响应结束");
        ended = true;
        if (html) res.end(adaptHtml(Buffer.concat(html).toString("utf8"), id));
        else output.end();
        clearTimeout(timeout); tunnel.close(1000);
      }
    } catch (error) { fail(error instanceof Error ? error : new Error("设备响应失败")); }
  });
  tunnel.once("close", () => { if (!ended) fail(new Error("设备连接中断，请检查会话状态后再决定是否重试")); });
  tunnel.on("error", fail);
  let uploading = false;
  async function upload(): Promise<void> {
    if (uploading) { fail(new Error("重复的就绪消息")); return; }
    uploading = true;
    try {
      for await (const raw of req) await send(tunnel, Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw)));
      if (tunnel.readyState === WebSocket.OPEN) {
        // 原生操作可能一直等待推理或审批，不能用普通资源的首包期限截断。
        if (!operation && !received) timeout = setTimeout(() => { fail(new Error("目标响应头超时")); }, 30_000);
        await json(tunnel, { type: "end" });
      }
    } catch (error) { if (!ended) fail(error instanceof Error ? error : new Error("上传中断")); }
  }
}

export async function proxyWebSocket(nodes: Nodes, wss: WebSocketServer, id: string, pathname: string, req: IncomingMessage, socket: Duplex, head: Buffer, session: Session): Promise<void> {
  const abort = new AbortController();
  const cancel = () => abort.abort();
  socket.once("close", cancel);
  let tunnel: WebSocket | undefined;
  try {
    tunnel = await nodes.open(id, { kind: "websocket", method: "GET", path: pathname, headers: forwardedRequest(req) }, abort.signal);
    const channel = tunnel;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => done(new Error("目标 WebSocket 握手超时")), 10_000);
      const close = () => done(new Error("目标连接中断"));
      const message = (raw: import("ws").RawData, binary: boolean) => {
        try {
          const value = binary ? undefined : parse(raw.toString());
          done(object(value) && value.type === "ready" ? undefined : new Error(object(value) && typeof value.message === "string" ? value.message : "无效握手"));
        } catch { done(new Error("无效握手")); }
      };
      const done = (error?: Error) => {
        clearTimeout(timer); channel.off("message", message); channel.off("close", close);
        if (error) reject(error); else resolve();
      };
      channel.once("message", message); channel.once("close", close);
    });
    if (abort.signal.aborted) throw new Error("客户端已断开");
    wss.handleUpgrade(req, socket, head, (viewer) => {
      const stop = () => { viewer.terminate(); channel.terminate(); };
      session.close.add(stop);
      viewer.once("close", () => session.close.delete(stop));
      couple(viewer, channel);
      forward(viewer, channel); forward(channel, viewer);
      void json(channel, { type: "start" }).catch(stop);
    });
  } catch {
    tunnel?.terminate();
    if (!socket.destroyed) socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
  } finally { socket.off("close", cancel); }
}
