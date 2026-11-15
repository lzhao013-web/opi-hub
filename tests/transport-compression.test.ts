import { test } from "node:test";
import assert from "node:assert/strict";
import http, { type IncomingMessage } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { fixture, fakeOpi, managedConfig } from "./helpers.ts";
import { startNode } from "../src/node/agent.ts";
import { isReport } from "../src/shared/backend.ts";
import { MAX_DATA_FRAME, json, object, parse } from "../src/shared/protocol.ts";
import { buffer, connected } from "../src/shared/sockets.ts";

test("浏览器 WebSocket 协商无上下文复用压缩，大文本与二进制保持一致，旧客户端仍可连接", { timeout: 20_000 }, async () => {
  const env = await fixture();
  try {
    for (const compressed of [true, false]) {
      const ws = new WebSocket(env.hub.url.replace("http:", "ws:") + `/n/${env.a.id}/api/events`, { headers: { Cookie: env.cookie, Origin: env.hub.url }, perMessageDeflate: compressed });
      let handshake: IncomingMessage | undefined; ws.once("upgrade", (response) => { handshake = response; });
      try {
        const first = new Promise<void>((resolve) => ws.once("message", () => resolve())); await connected(ws); await first;
        assert.ok(handshake); assert.equal(ws.extensions.includes("permessage-deflate"), compressed);
        if (compressed) { const extension = String(handshake.headers["sec-websocket-extensions"]); assert.match(extension, /server_no_context_takeover/); assert.match(extension, /client_no_context_takeover/); }
        for (const binary of [false, true]) {
          const text = "中文与二进制 😀 ".repeat(50_000); const sent = binary ? Buffer.from(text) : JSON.stringify({ echo: text });
          const received = new Promise<{ bytes: Buffer; binary: boolean }>((resolve) => ws.once("message", (raw, binary) => resolve({ bytes: buffer(raw), binary })));
          const before = handshake.socket.bytesRead; ws.send(sent); const response = await received;
          assert.equal(response.binary, binary);
          if (binary) assert.equal(response.bytes.toString(), text);
          else { const value = parse(response.bytes.toString()); assert.ok(object(value)); assert.equal(value.echo, text); }
          if (compressed) assert.ok(handshake.socket.bytesRead - before < Buffer.byteLength(sent) / 10, "重复负载应在真实网络帧上明显缩小");
        }
      } finally { ws.terminate(); }
    }
  } finally { await env.close(); }
});

test("压缩数据按解压后的 64 MiB 边界完整双向转发，超限仍拒绝", { timeout: 20_000 }, async () => {
  const env = await fixture();
  const ws = new WebSocket(env.hub.url.replace("http:", "ws:") + `/n/${env.a.id}/api/events`, { headers: { Cookie: env.cookie, Origin: env.hub.url } });
  try {
    const first = new Promise<void>((resolve) => ws.once("message", () => resolve())); await connected(ws); await first;
    const received = Promise.withResolvers<{ bytes: Buffer; binary: boolean }>();
    ws.once("message", (raw, binary) => received.resolve({ bytes: buffer(raw), binary }));
    ws.once("close", (code) => received.reject(new Error(`边界内数据转发断开：${code}`))); ws.on("error", received.reject);
    ws.send(Buffer.alloc(MAX_DATA_FRAME, 65));
    const result = await received.promise; assert.equal(result.binary, true); assert.equal(result.bytes.length, MAX_DATA_FRAME); assert.ok(result.bytes.every((byte) => byte === 65));
    const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
    ws.send(Buffer.alloc(MAX_DATA_FRAME + 1, 65)); assert.equal(await closed, 1009);
  } finally { ws.terminate(); await env.close(); }
});

test("真实节点仅给数据通道启用压缩，控制连接不压缩且兼容旧中心", { timeout: 25_000 }, async () => {
  for (const compressed of [true, false]) {
    const directory = await mkdtemp(path.join(tmpdir(), "opi-hub-compression-")); const upstream = await fakeOpi("压缩测试");
    const server = http.createServer();
    const wss = new WebSocketServer({ server, perMessageDeflate: compressed ? { serverNoContextTakeover: true, clientNoContextTakeover: true } : false });
    const done = Promise.withResolvers<{ bytes: Buffer; wireBytes: number }>(); void done.promise.catch(() => {});
    const token = `00000000-0000-0000-0000-000000000001.${"A".repeat(43)}`;
    wss.on("connection", (socket, req) => {
      socket.on("error", (error) => done.reject(error));
      if (req.url === "/_hub/connect") {
        assert.equal(socket.extensions, ""); let requested = false;
        socket.on("message", (raw) => {
          const value = parse(raw.toString());
          if (!requested && isReport(value) && value.ready) { requested = true; void json(socket, { type: "open", id: "fixture", kind: "http", method: "GET", path: "/download", headers: {} }).catch(done.reject); }
        });
      } else {
        const before = req.socket.bytesRead; const chunks: Buffer[] = [];
        if (socket.extensions.includes("permessage-deflate") !== compressed) { done.reject(new Error("节点数据通道未协商预期压缩")); return; }
        socket.on("message", (raw, binary) => {
          if (binary) { chunks.push(buffer(raw)); return; }
          const value = parse(raw.toString());
          if (object(value) && value.type === "ready") void json(socket, { type: "end" }).catch(done.reject);
          if (object(value) && value.type === "end") done.resolve({ bytes: Buffer.concat(chunks), wireBytes: req.socket.bytesRead - before });
        });
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); assert.ok(address && typeof address !== "string");
    const node = startNode(managedConfig({ hub: `http://127.0.0.1:${address.port}`, token }, upstream.url, directory), () => {});
    try {
      const result = await done.promise; assert.equal(result.bytes.length, 3 * 1024 * 1024); assert.ok(result.bytes.every((value) => value === ("压".charCodeAt(0) & 255)));
      if (compressed) assert.ok(result.wireBytes < result.bytes.length / 10); else assert.ok(result.wireBytes >= result.bytes.length);
    } finally {
      await node.close(); for (const socket of wss.clients) socket.terminate(); wss.close(); await new Promise<void>((resolve) => server.close(() => resolve()));
      await upstream.close(); await rm(directory, { recursive: true, force: true });
    }
  }
});
