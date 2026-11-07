import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, type WebSocketServer } from "ws";
import { forwardedRequest, HttpError } from "../shared/http.ts";
import { isReply, json, object, parse, send } from "../shared/protocol.ts";
import { buffer, couple, forward } from "../shared/sockets.ts";
import type { Session } from "./auth.ts";
import type { Nodes } from "./nodes.ts";
import { adaptHtml, devicePrefix } from "./native.ts";

export async function proxyHttp(nodes: Nodes, id: string, pathname: string, req: IncomingMessage, res: ServerResponse, session: Session): Promise<void> {
  const abort = new AbortController();
  const cancel = () => abort.abort();
  res.once("close", cancel);
  let tunnel: WebSocket;
  try { tunnel = await nodes.open(id, { kind: "http", method: req.method ?? "GET", path: pathname, headers: forwardedRequest(req) }, abort.signal); }
  catch (error) { res.off("close", cancel); throw new HttpError(502, error instanceof Error ? error.message : "设备连接失败"); }
  const stop = () => { tunnel.terminate(); if (!res.writableFinished) res.destroy(); };
  session.close.add(stop);
  let received = false;
  let ended = false;
  let html: Buffer[] | undefined;
  let htmlSize = 0;
  const timeout = setTimeout(() => { fail(new Error("目标响应头超时")); }, 30_000);
  const fail = (error: Error) => {
    if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" }).end(error.message);
    else if (!res.writableFinished) res.destroy(error);
    tunnel.terminate();
  };
  const cleanup = () => {
    clearTimeout(timeout); session.close.delete(stop); res.off("close", cancel);
  };
  res.once("close", () => { if (!ended) tunnel.terminate(); cleanup(); });
  res.on("drain", () => { if (tunnel.readyState === WebSocket.OPEN) tunnel.resume(); });
  tunnel.on("message", (raw, binary) => {
    try {
      if (binary) {
        if (!received || ended) throw new Error("无效的数据顺序");
        const data = buffer(raw);
        if (html) {
          htmlSize += data.length;
          if (htmlSize > 2 * 1024 * 1024) throw new Error("HTML 入口过大");
          html.push(data);
        } else if (!res.write(data)) tunnel.pause();
        return;
      }
      const value = parse(raw.toString());
      if (object(value) && value.type === "ready" && !received) { void upload(); return; }
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
        if (value.headers["content-type"]?.includes("text/html") && req.method !== "HEAD" && pathname.split("?")[0] === "/") {
          html = []; res.removeHeader("Content-Length");
        }
      } else {
        if (!received || ended) throw new Error("无效的响应结束");
        ended = true;
        if (html) res.end(adaptHtml(Buffer.concat(html).toString("utf8"), id));
        else res.end();
        tunnel.close(1000);
        cleanup();
      }
    } catch (error) { fail(error instanceof Error ? error : new Error("设备响应失败")); }
  });
  tunnel.once("close", () => { if (!ended) fail(new Error("设备连接中断，请检查会话状态后再决定是否重试")); cleanup(); });
  tunnel.on("error", fail);
  let uploading = false;
  async function upload(): Promise<void> {
    if (uploading) { fail(new Error("重复的就绪消息")); return; }
    uploading = true;
    try {
      for await (const raw of req) await send(tunnel, Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw)));
      if (tunnel.readyState === WebSocket.OPEN) await json(tunnel, { type: "end" });
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
