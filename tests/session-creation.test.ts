import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import { fixture, login } from "./helpers.ts";
import { startHub } from "../src/hub/server.ts";
import { fileURLToPath } from "node:url";
import { connected } from "../src/shared/sockets.ts";
import { object } from "../src/shared/protocol.ts";
import { isCreation, isDirectoryListing, type CreationRecord } from "../src/shared/session-creation.ts";

let env: Awaited<ReturnType<typeof fixture>>;
before(async () => { env = await fixture(); });
after(async () => { await env.hub.close(); await env.close(); });
const headers = () => ({ Cookie: env.cookie, Origin: env.hub.url, "Content-Type": "application/json" });
async function until<T>(read: () => Promise<T> | T, accept: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 6000;
  while (true) { const value = await read(); if (accept(value)) return value; assert.ok(Date.now() < deadline, "等待创建状态超时"); await delay(20); }
}
async function overview() {
  const value: unknown = await (await fetch(env.hub.url + "/_hub/overview", { headers: headers() })).json();
  assert.ok(object(value) && Array.isArray(value.creations) && Array.isArray(value.sessions) && Array.isArray(value.interactions));
  const creations = value.creations.filter((item): item is CreationRecord & { deviceId: string } => isCreation(item) && "deviceId" in item && typeof item.deviceId === "string");
  assert.equal(creations.length, value.creations.length);
  return { creations, sessions: value.sessions, interactions: value.interactions };
}
const post = (path: string, body: unknown, signal?: AbortSignal) => fetch(env.hub.url + path, { method: "POST", headers: headers(), body: JSON.stringify(body), signal });
const start = (deviceId: string, path: string, creationId: string = crypto.randomUUID()) => post("/_hub/sessions", { deviceId, path, creationId });
async function record(id: string, state: CreationRecord["state"]) {
  const result = await until(overview, (value) => value.creations.some((item) => item.id === id && item.state === state));
  const value = result.creations.find((item) => item.id === id); assert.ok(value); return value;
}

describe("远程新建会话", () => {
  test("目录来自目标设备，可向上浏览，不创建运行实例，并释放只读客户端", async () => {
    await until(overview, (value) => value.sessions.length === 4);
    const count = env.fakeA.newCalls();
    const response = await post("/_hub/directories", { deviceId: env.a.id, path: "" });
    assert.equal(response.status, 200);
    const listing: unknown = await response.json(); assert.ok(isDirectoryListing(listing));
    assert.equal(listing.path, "/fixture/设备 A"); assert.equal(listing.parent, "/fixture");
    assert.ok(listing.children.some((item) => item.name === "新项目"));
    assert.equal(env.fakeA.newCalls(), count); assert.equal(env.fakeB.directoryReads(), 0);
    await until(() => env.fakeA.directoryClients(), (count) => count === 0);
    const denied = await post("/_hub/directories", { deviceId: env.a.id, path: "/fixture/设备 A/denied" });
    assert.equal(denied.status, 409); assert.match(await denied.text(), /EACCES/);
  });
  test("在已打开工作区仍创建全新会话，同一请求重放不会重复创建", async () => {
    const ws = new WebSocket(env.hub.url.replace("http:", "ws:") + `/n/${env.a.id}/api/events`, { headers: headers() });
    const selections: string[] = [];
    ws.on("message", (raw) => {
      const frame: unknown = JSON.parse(raw.toString());
      if (object(frame) && Array.isArray(frame.events)) for (const event of frame.events) if (object(event) && event.type === "selected" && object(event.session) && typeof event.session.id === "string") selections.push(event.session.id);
    });
    try {
      await connected(ws); await until(() => selections.length, (count) => count > 0);
      const creationId = crypto.randomUUID();
      assert.equal((await start(env.a.id, "/fixture/设备 A", creationId)).status, 202);
      const created = await record(creationId, "ready"); assert.ok(created.state === "ready");
      assert.notEqual(created.session.id, "runtime-1"); assert.notEqual(created.session.id, "runtime-2");
      assert.equal(created.session.cwd, "/fixture/设备 A");
      assert.ok(selections.every((id) => id === "runtime-1"));
      assert.equal((await start(env.a.id, "/fixture/设备 A", creationId)).status, 202);
      assert.equal(env.fakeA.newCalls(), 1);
      assert.equal((await start(env.a.id, "/fixture/设备 A/other", creationId)).status, 409);
      assert.equal(env.fakeA.answers.length, 0);
    } finally { ws.terminate(); }
  });
  test("未收录目录能创建并立即登记空白会话，不依赖全量历史", async () => {
    const creationId = crypto.randomUUID();
    assert.equal((await start(env.a.id, "/fixture/设备 A/新项目", creationId)).status, 202);
    const created = await record(creationId, "ready"); assert.ok(created.state === "ready");
    const state = await overview();
    assert.ok(state.sessions.some((item) => object(item) && object(item.target) && item.target.id === created.session.id && item.cwd === "/fixture/设备 A/新项目"));
    assert.equal(env.fakeA.catalogReads(), 0);
  });
  test("同一托管进程的管理订阅重连保留创建身份，不重新创建", async () => {
    const before = await overview(); const entry = before.creations.find((item) => item.deviceId === env.a.id && item.state === "ready"); assert.ok(entry?.state === "ready");
    const count = env.fakeA.newCalls(); env.fakeA.disconnectClients();
    await until(overview, (value) => value.creations.every((item) => item.deviceId !== env.a.id));
    const restored = await record(entry.id, "ready"); assert.ok(restored.state === "ready"); assert.equal(restored.session.id, entry.session.id); assert.equal(env.fakeA.newCalls(), count);
  });
  test("原生会话删除后不保留空白会话残影，旧创建标识也不重新执行", async () => {
    const state = await overview(); const entry = state.creations.find((item) => item.deviceId === env.a.id && item.state === "ready"); assert.ok(entry?.state === "ready");
    const before = env.fakeA.newCalls(); env.fakeA.deleteSession(entry.session.id);
    const removed = await record(entry.id, "error"); assert.ok(removed.state === "error"); assert.equal(removed.session, null);
    await until(overview, (value) => value.sessions.every((item) => !object(item) || !object(item.target) || item.target.id !== entry.session.id));
    assert.equal((await start(env.a.id, entry.path, entry.id)).status, 202); assert.equal(env.fakeA.newCalls(), before);
  });
  test("不存在和无权限目录在变更前失败，相对路径直接拒绝", async () => {
    const before = env.fakeA.workspaceCalls();
    assert.equal((await start(env.a.id, "relative/project")).status, 400);
    for (const [path, error] of [["/missing-project", /ENOENT/], ["/fixture/设备 A/denied", /EACCES/]] as const) {
      const id = crypto.randomUUID(); assert.equal((await start(env.a.id, path, id)).status, 202);
      const failed = await record(id, "error"); assert.ok(failed.state === "error"); assert.match(failed.error, error); assert.equal(failed.session, null);
    }
    assert.equal(env.fakeA.workspaceCalls(), before);
  });
  test("启动信任交互集中回答，等待时不阻塞其他设备，也不自动放行", async () => {
    const id = crypto.randomUUID(); assert.equal((await start(env.a.id, "/fixture/设备 A/trust", id)).status, 202);
    await record(id, "creating");
    const state = await until(overview, (value) => value.interactions.some((item) => object(item) && item.title === "信任新项目"));
    const dialog = state.interactions.find((item) => object(item) && item.title === "信任新项目");
    assert.ok(object(dialog) && typeof dialog.sessionId === "string" && typeof dialog.id === "string");
    const before = env.fakeA.newCalls(); const port = Number(new URL(env.hub.url).port);
    await env.hub.close(); env.hub = await startHub({ host: "127.0.0.1", port, data: env.directory, assets: fileURLToPath(new URL("../src/web/", import.meta.url)) });
    env.cookie = await login(env.hub.url);
    await until(overview, (value) => value.interactions.some((item) => object(item) && item.id === dialog.id));
    assert.equal((await start(env.a.id, "/fixture/设备 A/trust", id)).status, 202); assert.equal(env.fakeA.newCalls(), before);
    assert.equal((await start(env.a.id, "/fixture/设备 A/other")).status, 409);
    const other = crypto.randomUUID(); assert.equal((await start(env.b.id, "/fixture/设备 B/other", other)).status, 202); await record(other, "ready");
    const payload = { deviceId: env.a.id, sessionId: dialog.sessionId, dialogId: dialog.id, value: "yes" };
    assert.equal((await post("/_hub/respond", { ...payload, value: "invalid" })).status, 409);
    assert.equal((await post("/_hub/respond", payload)).status, 200);
    const created = await record(id, "ready"); assert.ok(created.state === "ready"); assert.notEqual(created.session.id, dialog.sessionId);
  });
  test("取消浏览关闭只读订阅，未登录和跨站请求不能创建或列目录", async () => {
    const release = env.fakeB.holdDirectories(); const controller = new AbortController();
    const result = post("/_hub/directories", { deviceId: env.b.id, path: "" }, controller.signal).then(() => false, () => true);
    try { await until(() => env.fakeB.directoryClients(), (count) => count === 1); controller.abort(); assert.equal(await result, true); await until(() => env.fakeB.directoryClients(), (count) => count === 0); }
    finally { controller.abort(); release(); }
    for (const endpoint of ["/_hub/directories", "/_hub/sessions"]) {
      assert.equal((await fetch(env.hub.url + endpoint, { method: "POST", headers: { Origin: env.hub.url, "Content-Type": "application/json" }, body: "{}" })).status, 401);
      assert.equal((await fetch(env.hub.url + endpoint, { method: "POST", headers: { ...headers(), Origin: "https://evil.example" }, body: "{}" })).status, 403);
    }
    assert.equal(env.fakeA.leaked(), false); assert.equal(env.fakeB.leaked(), false);
  });
});
