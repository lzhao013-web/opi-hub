import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { fixture, PASSWORD, login, add, managedConfig, waitDevices } from "./helpers.ts";
import { isOpen, json, send } from "../src/shared/protocol.ts";
import { connected } from "../src/shared/sockets.ts";
import { startHub } from "../src/hub/server.ts";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { startNode } from "../src/node/agent.ts";
import { validateNodeConfig } from "../src/node/config.ts";

let env: Awaited<ReturnType<typeof fixture>>;
before(async () => { env = await fixture(); });
after(async () => { await env.hub.close(); await env.close(); });
const authenticated = () => ({ Cookie: env.cookie });
function wsUrl(id: string) { return env.hub.url.replace("http:", "ws:") + `/n/${id}/api/events`; }
function viewer(id: string, cookie = env.cookie) { return new WebSocket(wsUrl(id), { headers: { Cookie: cookie, Origin: env.hub.url } }); }

describe("独立多设备入口", () => {
  test("管理接口和设备页面需要登录，登录拒绝跨站来源", async () => {
    assert.equal((await fetch(env.hub.url + "/_hub/devices")).status, 401);
    assert.equal((await fetch(env.hub.url + `/n/${env.a.id}/`)).status, 401);
    const response = await fetch(env.hub.url + "/_hub/login", { method: "POST", headers: { Origin: "https://evil.example", "Content-Type": "application/json" }, body: JSON.stringify({ password: PASSWORD }) });
    assert.equal(response.status, 403);
  });
  test("设备列表不泄露凭据，两个节点独立在线", async () => {
    const response = await fetch(env.hub.url + "/_hub/devices", { headers: authenticated() });
    const body = await response.text();
    assert.ok(!body.includes("tokenHash")); assert.ok(!body.includes(env.a.config.token));
    assert.equal(body.match(/"connected":true/g)?.length, 2);
  });
  test("原生 HTML 注入设备适配，保持内容和 CSP", async () => {
    const response = await fetch(`${env.hub.url}/n/${env.a.id}/`, { headers: authenticated() });
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.ok(body.includes('src="/_hub/bridge.js"'));
    assert.ok(body.includes(`data-prefix="/n/${env.a.id}/"`));
    assert.equal(response.headers.get("referrer-policy"), "same-origin");
    assert.ok(body.includes('id="prompt"'));
    assert.match(response.headers.get("content-security-policy") ?? "", /script-src 'self'/);
  });
  test("流式文件和 Range 完整转发，不转发中心凭据", async () => {
    for (let i = 0; i < 3; i++) {
      const response = await fetch(`${env.hub.url}/n/${env.a.id}/download`, { headers: authenticated() });
      const data = Buffer.from(await response.arrayBuffer());
      assert.equal(data.length, 3 * 1024 * 1024);
      assert.equal(data.every((byte) => byte === ("设".charCodeAt(0) & 255)), true);
    }
    const response = await fetch(`${env.hub.url}/n/${env.b.id}/download`, { headers: { ...authenticated(), Range: "bytes=10-19" } });
    assert.equal(response.status, 206); assert.equal((await response.arrayBuffer()).byteLength, 10);
    assert.match(response.headers.get("content-range") ?? "", /bytes 10-19\//);
    assert.equal(env.fakeA.leaked(), false); assert.equal(env.fakeB.leaked(), false);
  });
  test("WebSocket 首帧和二进制消息在两个设备间隔离", async () => {
    for (const [device, expected] of [[env.a.id, "设备 A"], [env.b.id, "设备 B"]] as const) {
      const ws = viewer(device);
      try {
        const first = new Promise<string>((resolve) => ws.once("message", (raw) => resolve(raw.toString())));
        await connected(ws); assert.ok((await first).includes(expected));
        const echo = new Promise<string>((resolve) => ws.once("message", (raw, binary) => { assert.equal(binary, true); resolve(raw.toString()); }));
        ws.send(Buffer.from("binary-payload")); assert.equal(await echo, "binary-payload");
      } finally { ws.terminate(); }
    }
  });
  test("POST 转发保留大请求体，并重新建立本机 Origin", async () => {
    const ws = viewer(env.a.id);
    try {
      const first = new Promise<string>((resolve) => ws.once("message", (raw) => resolve(raw.toString())));
      await connected(ws);
      const message: unknown = JSON.parse(await first);
      assert.ok(typeof message === "object" && message !== null && "client" in message && typeof message.client === "string");
      const payload = { message: "中文消息".repeat(100_000) };
      const response = await fetch(`${env.hub.url}/n/${env.a.id}/api/action`, { method: "POST", headers: { ...authenticated(), Origin: env.hub.url, "Content-Type": "application/json", "X-Opi-Client": message.client }, body: JSON.stringify(payload) });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { device: "设备 A", ...payload });
    } finally { ws.terminate(); }
  });
  test("未登录和跨站 WebSocket 无法连接设备", async () => {
    for (const headers of [{ Origin: env.hub.url }, { ...authenticated(), Origin: "https://evil.example" }]) {
      const ws = new WebSocket(wsUrl(env.a.id), { headers });
      try { await assert.rejects(connected(ws)); } finally { ws.terminate(); }
    }
  });
  test("节点配置只接受托管命令，拒绝旧 target 和无效参数", () => {
    assert.throws(() => validateNodeConfig({ ...env.a.config, target: "http://192.168.1.1" }), /不支持.*target/);
    assert.throws(() => validateNodeConfig({ ...env.a.config, command: [] }), /command/);
  });
  test("数据通道拒绝跨设备认领和重复使用", async () => {
    const entry = await add(env.hub.url, env.cookie, "独立通道测试");
    const base = env.hub.url.replace("http:", "ws:");
    const control = new WebSocket(base + "/_hub/connect", { headers: { Authorization: `Bearer ${entry.config.token}` } });
    try {
      await connected(control);
      const opening = new Promise<unknown>((resolve) => control.once("message", (raw) => resolve(JSON.parse(raw.toString()))));
      const response = fetch(`${env.hub.url}/n/${entry.id}/download`, { headers: authenticated() });
      const request = await opening; assert.ok(isOpen(request));
      const streamUrl = base + `/_hub/stream/${request.id}`;
      const wrong = new WebSocket(streamUrl, { headers: { Authorization: `Bearer ${env.a.config.token}` } });
      try { await assert.rejects(connected(wrong)); } finally { wrong.terminate(); }
      const channel = new WebSocket(streamUrl, { headers: { Authorization: `Bearer ${entry.config.token}` } });
      const uploadDone = new Promise((resolve) => channel.once("message", resolve));
      try {
        await connected(channel);
        await json(channel, { type: "ready" }); await uploadDone;
        await json(channel, { type: "response", status: 200, headers: { "content-type": "text/plain" } });
        await send(channel, Buffer.from("hello")); await json(channel, { type: "end" });
        assert.equal(await (await response).text(), "hello");
        const replay = new WebSocket(streamUrl, { headers: { Authorization: `Bearer ${entry.config.token}` } });
        try { await assert.rejects(connected(replay)); } finally { replay.terminate(); }
      } finally { channel.terminate(); }
    } finally {
      control.terminate();
      await fetch(`${env.hub.url}/_hub/devices/${entry.id}`, { method: "DELETE", headers: { ...authenticated(), Origin: env.hub.url } });
    }
  });
  test("退出登录会关闭该登录会话的远程连接", async () => {
    const cookie = await login(env.hub.url);
    const ws = viewer(env.a.id, cookie);
    const message = new Promise((resolve) => ws.once("message", resolve));
    await connected(ws); await message;
    const closed = new Promise((resolve) => ws.once("close", resolve));
    const response = await fetch(env.hub.url + "/_hub/logout", { method: "POST", headers: { Cookie: cookie, Origin: env.hub.url } });
    assert.equal(response.status, 200); await closed;
    assert.equal((await fetch(env.hub.url + "/_hub/devices", { headers: { Cookie: cookie } })).status, 401);
  });
  test("中心重启后节点自动重连，设备凭据仍然有效", { timeout: 10_000 }, async () => {
    const port = Number(new URL(env.hub.url).port);
    await env.hub.close();
    env.hub = await startHub({ host: "127.0.0.1", port, data: env.directory, assets: fileURLToPath(new URL("../src/web/", import.meta.url)) });
    env.cookie = await login(env.hub.url);
    const deadline = Date.now() + 5000;
    while (true) {
      const body = await (await fetch(env.hub.url + "/_hub/devices", { headers: authenticated() })).text();
      if (body.match(/"connected":true/g)?.length === 2) break;
      assert.ok(Date.now() < deadline, "两个节点应自动恢复连接");
      await delay(25);
    }
  });
  test("节点关闭后停止托管服务，再启动可恢复设备身份", async () => {
    await env.agentA.close();
    assert.equal((await fetch(`${env.fakeA.url}/health`)).status, 200);
    const reconnect = startNode(managedConfig(env.a.config, env.fakeA.url, env.directory), () => {});
    try {
      await reconnect.ready; await waitDevices(env.hub.url, env.cookie, 2);
      const response = await fetch(`${env.hub.url}/n/${env.a.id}/`, { headers: authenticated() });
      assert.equal(response.status, 200); await response.body?.cancel();
    } finally { await reconnect.close(); }
    const offline = await fetch(`${env.hub.url}/n/${env.a.id}/`, { headers: authenticated() });
    assert.equal(offline.status, 502);
  });
  test("移除设备撤销凭据并结束托管连接，不影响独立进程", async () => {
    const ws = viewer(env.b.id);
    const message = new Promise((resolve) => ws.once("message", resolve));
    await connected(ws); await message;
    const closed = new Promise((resolve) => ws.once("close", resolve));
    const response = await fetch(`${env.hub.url}/_hub/devices/${env.b.id}`, { method: "DELETE", headers: { ...authenticated(), Origin: env.hub.url } });
    assert.equal(response.status, 200); await closed;
    assert.equal((await fetch(`${env.fakeB.url}/health`)).status, 200);
    const control = new WebSocket(env.hub.url.replace("http:", "ws:") + "/_hub/connect", { headers: { Authorization: `Bearer ${env.b.config.token}` } });
    try { await assert.rejects(connected(control)); } finally { control.terminate(); }
  });
});
