import http from "node:http";
import https from "node:https";
import { WebSocket } from "ws";
import { forwardedResponse } from "../shared/http.ts";
import { json, MAX_FRAME, object, parse, send, type OpenRequest } from "../shared/protocol.ts";
import { buffer, connected, couple, forward } from "../shared/sockets.ts";

export async function serveHttp(tunnel: WebSocket, target: URL, request: OpenRequest): Promise<void> {
  const transport = target.protocol === "https:" ? https : http;
  const local = transport.request({
    protocol: target.protocol, hostname: target.hostname.replace(/^\[|\]$/g, ""), port: target.port || undefined,
    path: request.path, method: request.method, headers: { ...request.headers, origin: target.origin, host: target.host },
  });
  const fail = (error: Error) => {
    local.destroy();
    if (tunnel.readyState === WebSocket.OPEN) void json(tunnel, { type: "error", message: error.message }).then(() => tunnel.close(1011), () => tunnel.terminate());
  };
  local.on("error", fail);
  tunnel.once("close", () => local.destroy());
  tunnel.on("message", (raw, binary) => {
    if (binary) {
      if (!local.write(buffer(raw))) tunnel.pause();
    } else {
      try {
        const value = parse(raw.toString());
        if (!object(value) || value.type !== "end") throw new Error("无效的请求结束");
        local.end();
      } catch (error) { fail(error instanceof Error ? error : new Error("请求失败")); }
    }
  });
  local.on("drain", () => { if (tunnel.readyState === WebSocket.OPEN) tunnel.resume(); });
  local.once("response", (response) => {
    void (async () => {
      try {
        await json(tunnel, { type: "response", status: response.statusCode ?? 502, headers: forwardedResponse(response.headers) });
        for await (const raw of response) await send(tunnel, Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw)));
        await json(tunnel, { type: "end" });
      } catch (error) { fail(error instanceof Error ? error : new Error("响应中断")); }
    })();
  });
}

export async function serveWebSocket(tunnel: WebSocket, target: URL, request: OpenRequest, observe?: (socket: WebSocket) => void): Promise<void> {
  const url = new URL(request.path, target);
  url.protocol = target.protocol === "https:" ? "wss:" : "ws:";
  // URL 的 host 始终来自本机配置，不能由中心下发的路径改变。
  url.host = target.host;
  const local = new WebSocket(url, { headers: { ...request.headers, Origin: target.origin }, maxPayload: MAX_FRAME, perMessageDeflate: false });
  observe?.(local);
  const early: { data: Buffer; binary: boolean }[] = [];
  let size = 0;
  const collect = (raw: import("ws").RawData, binary: boolean) => {
    const data = buffer(raw); size += data.length;
    if (size > MAX_FRAME * 2) { local.terminate(); tunnel.terminate(); return; }
    early.push({ data, binary }); local.pause();
  };
  local.on("message", collect);
  couple(local, tunnel);
  const start = (raw: import("ws").RawData, binary: boolean) => {
    try {
      const value = binary ? undefined : parse(raw.toString());
      if (!object(value) || value.type !== "start") throw new Error("无效的开始帧");
      local.off("message", collect);
      forward(tunnel, local); forward(local, tunnel);
      void (async () => {
        for (const item of early) await send(tunnel, item.data, item.binary);
        early.length = 0;
        local.resume();
      })().catch(() => { local.terminate(); tunnel.terminate(); });
    } catch { local.terminate(); tunnel.terminate(); }
  };
  tunnel.once("message", start);
  try { await connected(local); local.pause(); await json(tunnel, { type: "ready" }); }
  catch (error) {
    tunnel.off("message", start);
    if (tunnel.readyState === WebSocket.OPEN) await json(tunnel, { type: "error", message: error instanceof Error ? error.message : "本机 WebSocket 连接失败" });
    local.terminate(); tunnel.close(1011);
  }
}
