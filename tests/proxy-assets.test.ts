import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { WebSocket } from "ws";
import { Store } from "../src/hub/store.ts";
import { startHub } from "../src/hub/server.ts";
import { isOpen, json, parse, send, type Headers, type OpenRequest } from "../src/shared/protocol.ts";
import { connected } from "../src/shared/sockets.ts";
import { add, login, PASSWORD } from "./helpers.ts";

const asset = "/assets/app-Ab12_cd3.js";
const body = Buffer.from("/* 中文静态资源 😀 */\n".repeat(30_000));
const metadata = { "content-type": "text/javascript; charset=utf-8", "content-length": String(body.length), etag: '"fixture-v1"', "last-modified": "Sun, 15 Nov 2026 00:00:00 GMT" };
function request(url: string, headers: http.OutgoingHttpHeaders, method = "GET", signal?: AbortSignal, received?: () => void) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const req = http.request(url, { headers, method, signal }, (res) => {
      const chunks: Buffer[] = []; res.on("data", (chunk: Buffer) => { chunks.push(chunk); received?.(); });
      res.on("error", reject); res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.setTimeout(10_000, () => req.destroy(new Error("测试请求超时"))); req.on("error", reject); req.end();
  });
}
async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), "opi-hub-assets-")); await Store.init(directory, PASSWORD);
  const hub = await startHub({ host: "127.0.0.1", port: 0, data: directory, assets: fileURLToPath(new URL("../src/web/", import.meta.url)) });
  const cookie = await login(hub.url); const device = await add(hub.url, cookie, "静态资源测试");
  const base = hub.url.replace("http:", "ws:"); const prefix = hub.url + `/n/${device.id}`;
  const control = new WebSocket(base + "/_hub/connect", { headers: { Authorization: `Bearer ${device.config.token}` }, perMessageDeflate: false });
  const channels = new Set<WebSocket>();
  t.after(async () => { control.terminate(); for (const channel of channels) channel.terminate(); await hub.close(); await rm(directory, { recursive: true, force: true }); });
  await connected(control);
  async function open(pathname: string, headers: http.OutgoingHttpHeaders = {}, method = "GET", signal?: AbortSignal, received?: () => void) {
    const opened = new Promise<OpenRequest>((resolve, reject) => control.once("message", (raw) => { const value = parse(raw.toString()); if (isOpen(value)) resolve(value); else reject(new Error("无效测试请求")); }));
    const response = request(prefix + pathname, { Cookie: cookie, Origin: hub.url, ...headers }, method, signal, received); void response.catch(() => {});
    const opening = await opened;
    const channel = new WebSocket(base + `/_hub/stream/${opening.id}`, { headers: { Authorization: `Bearer ${device.config.token}` }, perMessageDeflate: false }); channels.add(channel);
    const uploaded = new Promise<void>((resolve) => channel.on("message", (raw, binary) => { if (!binary && raw.toString() === '{"type":"end"}') resolve(); }));
    await connected(channel); await json(channel, { type: "ready" }); await uploaded;
    return { channel, opening, response, async reply(status = 200, headers: Headers = metadata, bytes = body) {
      await json(channel, { type: "response", status, headers });
      if (method !== "HEAD" && status !== 304) for (let offset = 0; offset < bytes.length; offset += 32 * 1024) await send(channel, bytes.subarray(offset, offset + 32 * 1024));
      await json(channel, { type: "end" }); return response;
    } };
  }
  return { open, prefix, cookie, hub };
}

test("带哈希静态资源按 gzip 协商流式压缩并使用登录隔离的私有缓存", async (t) => {
  const env = await fixture(t);
  for (const [encoding, compressed] of [["gzip", true], ["br, gzip;q=0.5", true], ["*;q=1", true], ["gzip;q=0, *;q=1", false], ["identity", false]] as const) {
    const transfer = await env.open(asset, { "Accept-Encoding": encoding }); const result = await transfer.reply();
    assert.equal(result.status, 200); assert.equal(result.headers["cache-control"], "private, max-age=31536000, immutable");
    assert.match(result.headers.vary ?? "", /Cookie/i); assert.match(result.headers.vary ?? "", /Accept-Encoding/i);
    assert.equal(result.headers["content-encoding"], compressed ? "gzip" : undefined);
    assert.deepEqual(compressed ? gunzipSync(result.body) : result.body, body);
    if (compressed) { assert.ok(result.body.length < body.length / 10); assert.equal(result.headers["content-length"], undefined); assert.equal(result.headers.etag, 'W/"fixture-v1"'); }
    else assert.equal(result.headers["content-length"], String(body.length));
    assert.equal(transfer.opening.headers.cookie, undefined); assert.equal(transfer.opening.headers.authorization, undefined);
  }
});

test("仅静态资源转发条件头，304 与 HEAD 保留正确缓存及压缩元数据", async (t) => {
  const env = await fixture(t);
  const conditional = await env.open(asset, { "Accept-Encoding": "gzip", "If-None-Match": 'W/"fixture-v1"', "If-Modified-Since": metadata["last-modified"] });
  assert.equal(conditional.opening.headers["if-none-match"], 'W/"fixture-v1"'); assert.equal(conditional.opening.headers["if-modified-since"], metadata["last-modified"]);
  const cached = await conditional.reply(304, { etag: metadata.etag }); assert.equal(cached.status, 304); assert.equal(cached.body.length, 0);
  assert.match(cached.headers["cache-control"] ?? "", /immutable/); assert.equal(cached.headers.etag, 'W/"fixture-v1"');
  const head = await env.open(asset, { "Accept-Encoding": "gzip" }, "HEAD"); const result = await head.reply();
  assert.equal(result.body.length, 0); assert.equal(result.headers["content-encoding"], "gzip"); assert.equal(result.headers["content-length"], undefined);
  const css = await env.open("/assets/theme-Ab12_cd3.css", { "Accept-Encoding": "gzip" });
  assert.equal((await css.reply(200, { ...metadata, "content-type": "text/css" })).headers["content-encoding"], "gzip");
});

test("HTML、API、非哈希资源、查询变体、错误和 Range 均不缓存或 gzip", async (t) => {
  const env = await fixture(t);
  for (const pathname of ["/", "/api/file/app-Ab12_cd3.js", "/app.js", "/assets/app.js", asset + "?variant=1", "/assets/app-Ab12_cd3.js.map"]) {
    const transfer = await env.open(pathname, { "Accept-Encoding": "gzip", "If-None-Match": metadata.etag });
    assert.equal(transfer.opening.headers["if-none-match"], undefined);
    const html = pathname === "/"; const bytes = html ? Buffer.from("<html><head></head><body>测试</body></html>") : body;
    const result = await transfer.reply(200, { "content-type": html ? "text/html" : "text/javascript" }, bytes);
    assert.equal(result.headers["cache-control"], "no-store"); assert.equal(result.headers["content-encoding"], undefined);
    if (html) assert.ok(result.body.includes('src="/_hub/bridge.js"')); else assert.deepEqual(result.body, body);
  }
  for (const [status, type] of [[404, "text/javascript"], [200, "text/html"], [200, "application/json"]] as const) {
    const result = await (await env.open(asset, { "Accept-Encoding": "gzip" })).reply(status, { "content-type": type });
    assert.equal(result.headers["cache-control"], "no-store"); assert.equal(result.headers["content-encoding"], undefined);
  }
  const range = await env.open(asset, { "Accept-Encoding": "gzip", Range: "bytes=10-19" });
  const result = await range.reply(206, { ...metadata, "content-length": "10", "content-range": `bytes 10-19/${body.length}` }, body.subarray(10, 20));
  assert.equal(result.headers["cache-control"], "no-store"); assert.equal(result.headers["content-encoding"], undefined); assert.equal(result.body.length, 10);
  assert.equal(result.headers["content-range"], `bytes 10-19/${body.length}`);
  const ignoredRange = await (await env.open(asset, { Range: "bytes=10-19", "Accept-Encoding": "gzip" })).reply();
  assert.equal(ignoredRange.headers["cache-control"], "no-store"); assert.equal(ignoredRange.headers["content-encoding"], undefined);
  const post = await (await env.open(asset, { "Accept-Encoding": "gzip" }, "POST")).reply();
  assert.equal(post.headers["cache-control"], "no-store"); assert.equal(post.headers["content-encoding"], undefined);
});

test("缓存资源仍须鉴权，发送响应头后尚未出正文的转发错误不能被缓存", async (t) => {
  const env = await fixture(t);
  const unauthenticated = await request(env.prefix + asset, { "Accept-Encoding": "gzip", "If-None-Match": metadata.etag });
  assert.equal(unauthenticated.status, 401); assert.equal(unauthenticated.headers["cache-control"], "no-store");
  const crossSite = await request(env.prefix + asset, { Cookie: env.cookie, "Sec-Fetch-Site": "cross-site" }); assert.equal(crossSite.status, 403);
  const transfer = await env.open(asset, { "Accept-Encoding": "gzip" });
  await json(transfer.channel, { type: "response", status: 200, headers: metadata }); await json(transfer.channel, { type: "error", message: "模拟读取失败" });
  const result = await transfer.response; assert.equal(result.status, 502); assert.equal(result.headers["cache-control"], "no-store");
  assert.equal(result.headers["content-encoding"], undefined); assert.equal(result.headers.etag, undefined); assert.match(result.body.toString(), /模拟读取失败/);
});

test("浏览器在 gzip 流中途取消会释放数据通道，后续请求仍可用", async (t) => {
  const env = await fixture(t); const controller = new AbortController();
  const transfer = await env.open(asset, { "Accept-Encoding": "gzip" }, "GET", controller.signal, () => controller.abort());
  const closed = new Promise<void>((resolve) => transfer.channel.once("close", () => resolve()));
  await json(transfer.channel, { type: "response", status: 200, headers: metadata }); await send(transfer.channel, body.subarray(0, 32 * 1024));
  await assert.rejects(transfer.response); await closed;
  const next = await (await env.open(asset, { "Accept-Encoding": "gzip" })).reply(); assert.deepEqual(gunzipSync(next.body), body);
});
