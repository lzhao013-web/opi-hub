import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setImmediate } from "node:timers/promises";
import { WebSocket } from "ws";
import { Store } from "../src/hub/store.ts";
import { startHub } from "../src/hub/server.ts";
import { isOpen, json, parse, type OpenRequest } from "../src/shared/protocol.ts";
import { connected } from "../src/shared/sockets.ts";
import { add, login, PASSWORD } from "./helpers.ts";

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), "opi-hub-proxy-timeout-")); await Store.init(directory, PASSWORD);
  const hub = await startHub({ host: "127.0.0.1", port: 0, data: directory, assets: fileURLToPath(new URL("../src/web/", import.meta.url)) });
  const cookie = await login(hub.url); const device = await add(hub.url, cookie, "延迟响应节点"); const base = hub.url.replace("http:", "ws:");
  const control = new WebSocket(base + "/_hub/connect", { headers: { Authorization: `Bearer ${device.config.token}` } }); await connected(control);
  const channels = new Set<WebSocket>(); let requests = 0;
  t.after(async () => { t.mock.timers.reset(); control.terminate(); for (const channel of channels) channel.terminate(); await hub.close(); await rm(directory, { recursive: true, force: true }); });
  async function open(method: string, pathname: string, signal?: AbortSignal) {
    const opening = new Promise<OpenRequest>((resolve, reject) => control.once("message", (raw) => {
      const value = parse(raw.toString()); if (isOpen(value)) { requests++; resolve(value); } else reject(new Error("无效测试请求"));
    }));
    const response = fetch(hub.url + `/n/${device.id}` + pathname, { method, headers: { Cookie: cookie, Origin: hub.url }, ...(method === "POST" ? { body: "{}" } : {}), signal });
    const request = await opening;
    const channel = new WebSocket(base + `/_hub/stream/${request.id}`, { headers: { Authorization: `Bearer ${device.config.token}` } }); channels.add(channel);
    const ended = new Promise<void>((resolve) => channel.on("message", (raw, binary) => { if (!binary && raw.toString() === '{"type":"end"}') resolve(); }));
    await connected(channel);
    return { channel, response, async ready() { await json(channel, { type: "ready" }); await ended; await setImmediate(); } };
  }
  return { open, requests: () => requests };
}
test("长操作和查询在就绪后可等待超过 30 秒，不误报超时或重复下发", async (t) => {
  const env = await fixture(t); t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const route of ["/api/action", "/api/query?catalog=1"]) {
    const operation = await env.open("POST", route); await operation.ready();
    t.mock.timers.tick(31_000); await setImmediate();
    await json(operation.channel, { type: "response", status: 204, headers: {} }); await json(operation.channel, { type: "end" });
    assert.equal((await operation.response).status, 204);
  }
  assert.equal(env.requests(), 2);
});
test("普通资源和 GET 查询仍有响应头超时，长操作也不能无限等待就绪", async (t) => {
  const env = await fixture(t); t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const route of ["/app.js", "/api/query"]) {
    const operation = await env.open("GET", route); await operation.ready(); t.mock.timers.tick(30_001);
    const response = await operation.response; assert.equal(response.status, 502); assert.match(await response.text(), /响应头超时/);
  }
  const operation = await env.open("POST", "/api/action"); t.mock.timers.tick(10_001);
  const response = await operation.response; assert.equal(response.status, 502); assert.match(await response.text(), /就绪超时/);
});
test("浏览器取消长操作等待会回收通道，不发送任务重试或停止指令", async (t) => {
  const env = await fixture(t); const controller = new AbortController();
  const operation = await env.open("POST", "/api/action", controller.signal); await operation.ready();
  const closed = new Promise<void>((resolve) => operation.channel.once("close", () => resolve()));
  controller.abort(); await assert.rejects(operation.response); await closed; assert.equal(env.requests(), 1);
});
