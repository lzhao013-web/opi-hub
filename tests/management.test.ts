import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { fixture, login } from "./helpers.ts";
import { WebSocket } from "ws";
import { connected } from "../src/shared/sockets.ts";
import { startHub } from "../src/hub/server.ts";
import { startNode } from "../src/node/agent.ts";
import { fileURLToPath } from "node:url";
import { isInteraction, isSession, type Interaction, type ManagedSession } from "../src/shared/management.ts";
import { object } from "../src/shared/protocol.ts";

let env: Awaited<ReturnType<typeof fixture>>;
before(async () => { env = await fixture(); });
after(async () => { await env.agentA.close(); await env.agentB.close(); await env.hub.close(); await env.close(); });
async function overview() {
  const response = await fetch(env.hub.url + "/_hub/overview", { headers: { Cookie: env.cookie } });
  assert.equal(response.status, 200);
  const value: unknown = await response.json();
  assert.ok(object(value) && Array.isArray(value.sessions) && Array.isArray(value.interactions) && Array.isArray(value.workspaces));
  const sessions = value.sessions.filter((item): item is ManagedSession & { deviceId: string } => isSession(item) && "deviceId" in item && typeof item.deviceId === "string");
  const interactions = value.interactions.filter((item): item is Interaction & { deviceId: string } => isInteraction(item) && "deviceId" in item && typeof item.deviceId === "string");
  assert.equal(sessions.length, value.sessions.length); assert.equal(interactions.length, value.interactions.length);
  return { sessions, interactions, workspaces: value.workspaces };
}
async function until<T>(read: () => Promise<T> | T, accept: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 6000;
  while (true) {
    const value = await read(); if (accept(value)) return value;
    assert.ok(Date.now() < deadline, "等待管理状态同步超时"); await delay(20);
  }
}
function respond(deviceId: string, sessionId: string, dialogId: string, value: string | null) {
  return fetch(env.hub.url + "/_hub/respond", { method: "POST", headers: { Cookie: env.cookie, Origin: env.hub.url, "Content-Type": "application/json" }, body: JSON.stringify({ deviceId, sessionId, dialogId, value }) });
}

describe("跨设备管理", () => {
  test("默认只同步运行实例和工作区元数据，不主动读取或保存历史", async () => {
    const state = await until(overview, (state) => state.sessions.length === 4 && state.interactions.length === 2 && state.workspaces.length === 4);
    assert.equal(state.sessions.filter((item) => item.state === "history").length, 0);
    assert.equal(state.sessions.filter((item) => "id" in item.target && item.target.id === "runtime-2").length, 2);
    assert.equal(new Set(state.sessions.map((item) => JSON.stringify([item.deviceId, item.target]))).size, 4);
    assert.equal(env.fakeA.catalogReads(), 0); assert.equal(env.fakeB.catalogReads(), 0);
    assert.equal(env.fakeA.historyClients(), 0);
  });
  test("本机 Web 订阅断线时清除旧交互，重连后恢复目录和待处理项", async () => {
    env.fakeA.disconnectClients();
    await until(overview, (state) => state.sessions.every((item) => item.deviceId !== env.a.id));
    const restored = await until(overview, (state) => state.sessions.length === 4 && state.interactions.length === 2);
    assert.ok(restored.interactions.some((item) => item.deviceId === env.a.id));
  });
  test("无关历史增量仍确认传输，但不会进入概览；显式查询只读取目标设备", async () => {
    const before = env.fakeA.acknowledgements();
    for (let index = 0; index < 8; index++) env.fakeA.patchTitle(`增量标题 ${index}`);
    await until(() => env.fakeA.acknowledgements(), (count) => count >= before + 8);
    assert.ok((await overview()).sessions.every((item) => item.title !== "增量标题 7"));
    const response = await fetch(env.hub.url + "/_hub/history", { method: "POST", headers: { Cookie: env.cookie, Origin: env.hub.url, "Content-Type": "application/json" }, body: JSON.stringify({ deviceId: env.a.id }) });
    assert.equal(response.status, 200);
    const body: unknown = await response.json();
    assert.ok(object(body) && Array.isArray(body.entries));
    assert.equal(body.entries.length, 3);
    assert.ok(body.entries.some((item) => object(item) && item.title === "增量标题 7"));
    assert.equal(env.fakeA.catalogReads(), 1); assert.equal(env.fakeB.catalogReads(), 0);
    await until(() => env.fakeA.historyClients(), (count) => count === 0);
    assert.equal((await overview()).sessions.length, 4);
  });
  test("取消历史查询会释放临时订阅，不切换正常管理客户端", async () => {
    const release = env.fakeB.holdHistory();
    const controller = new AbortController();
    const before = env.fakeB.selections().filter((id) => id === "runtime-1").length;
    const request = fetch(env.hub.url + "/_hub/history", { method: "POST", signal: controller.signal, headers: { Cookie: env.cookie, Origin: env.hub.url, "Content-Type": "application/json" }, body: JSON.stringify({ deviceId: env.b.id }) });
    const rejected = request.then(() => false, () => true);
    try {
      await until(() => env.fakeB.historyClients(), (count) => count === 1);
      assert.equal(env.fakeB.selections().filter((id) => id === "runtime-1").length, before);
      controller.abort(); assert.equal(await rejected, true);
      await until(() => env.fakeB.historyClients(), (count) => count === 0);
    } finally { controller.abort(); release(); }
  });
  test("历史查询需要登录和同源来源，未授权请求不会访问节点", async () => {
    const before = env.fakeA.catalogReads();
    const options = { method: "POST", headers: { Origin: env.hub.url, "Content-Type": "application/json" }, body: JSON.stringify({ deviceId: env.a.id }) };
    assert.equal((await fetch(env.hub.url + "/_hub/history", options)).status, 401);
    assert.equal((await fetch(env.hub.url + "/_hub/history", { ...options, headers: { ...options.headers, Cookie: env.cookie, Origin: "https://evil.example" } })).status, 403);
    assert.equal(env.fakeA.catalogReads(), before);
  });
  test("节点断线时在途历史作废，重连使用新连接标识", async () => {
    const connectionId = async () => {
      const value: unknown = await (await fetch(env.hub.url + "/_hub/devices", { headers: { Cookie: env.cookie } })).json();
      assert.ok(Array.isArray(value));
      const device: unknown = value.find((item: unknown) => object(item) && item.id === env.a.id);
      assert.ok(object(device) && typeof device.connectionId === "string");
      return device.connectionId;
    };
    const before = await connectionId();
    const release = env.fakeA.holdHistory();
    try {
      const request = fetch(env.hub.url + "/_hub/history", { method: "POST", headers: { Cookie: env.cookie, Origin: env.hub.url, "Content-Type": "application/json" }, body: JSON.stringify({ deviceId: env.a.id }) });
      await until(() => env.fakeA.historyClients(), (count) => count === 1);
      await env.agentA.close();
      assert.equal((await request).status, 409);
      await until(() => env.fakeA.historyClients(), (count) => count === 0);
    } finally { release(); }
    env.agentA = startNode({ ...env.a.config, target: env.fakeA.url }, () => {}); await env.agentA.ready;
    await until(overview, (state) => state.interactions.length === 2);
    assert.notEqual(before, await connectionId());
  });
  test("集中回答保留后端校验，重复请求不能重复消费，不影响另一设备", async () => {
    const state = await overview();
    const dialog = state.interactions.find((item) => item.deviceId === env.a.id); assert.ok(dialog);
    assert.equal((await respond(env.a.id, dialog.sessionId, dialog.id, "invalid")).status, 409);
    const responses = await Promise.all([respond(env.a.id, dialog.sessionId, dialog.id, "yes"), respond(env.a.id, dialog.sessionId, dialog.id, "yes")]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
    await until(overview, (state) => state.interactions.every((item) => item.deviceId !== env.a.id));
    assert.equal(env.fakeA.answers.length, 1); assert.equal(env.fakeA.answers[0]?.value, "yes");
    assert.equal(env.fakeB.answers.length, 0);
    assert.equal((await overview()).interactions.filter((item) => item.deviceId === env.b.id).length, 1);
  });
  test("原界面处理后中心撤销交互，旧回答不会进入其他会话", async () => {
    const dialog = (await overview()).interactions.find((item) => item.deviceId === env.b.id); assert.ok(dialog);
    env.fakeB.setDialogs(dialog.sessionId, []);
    await until(overview, (state) => !state.interactions.some((item) => item.id === dialog.id && item.deviceId === env.b.id));
    assert.equal((await respond(env.b.id, dialog.sessionId, dialog.id, "yes")).status, 409);
    assert.equal(env.fakeB.answers.length, 0);
  });
  test("命令审批保留完整范围，选择、输入和取消值不改写", async () => {
    env.fakeA.setDialogs("runtime-2", [
      { id: "command", kind: "bashApproval", title: "执行 Bash 命令", deadline: null, approval: { cwd: "/中文目录", command: "echo '中文 😀'", items: [{ action: "write", kind: "file", target: "/中文目录/a.txt", reason: "需要确认" }] }, options: [{ label: "仅本次允许", value: "allow_once" }] },
      { id: "choice", kind: "select", title: "选择范围", deadline: null, options: [{ label: "本次", value: "原始选项值" }] },
      { id: "input", kind: "input", title: "输入内容", deadline: null, initial: "初始值", placeholder: "内容" },
      { id: "secret", kind: "secret", title: "输入密钥", deadline: null, initial: "", placeholder: "密钥" },
      { id: "editor", kind: "editor", title: "编辑内容", deadline: null, initial: "第一行\n第二行" },
    ]);
    const state = await until(overview, (state) => state.interactions.length === 5);
    const command = state.interactions.find((item) => item.id === "command"); assert.ok(command?.kind === "command");
    assert.equal(command.command, "echo '中文 😀'"); assert.equal(command.targets[0]?.target, "/中文目录/a.txt");
    for (const [id, value] of [["command", "allow_once"], ["choice", "原始选项值"], ["input", "保留\n中文 😀"], ["secret", "secret-test"], ["editor", null]] as const) assert.equal((await respond(env.a.id, "runtime-2", id, value)).status, 200);
    await until(overview, (state) => state.interactions.length === 0);
    assert.deepEqual(env.fakeA.answers.slice(1).map((item) => item.value), ["allow_once", "原始选项值", "保留\n中文 😀", "secret-test", null]);
  });
  test("浏览器提示补全未索引交互，原页面关闭和中心重启后仍能回答", async () => {
    await until(() => env.fakeA.selections(), (sessions) => !sessions.includes("runtime-2"));
    env.fakeA.hideActivity("runtime-2");
    env.fakeA.setDialogs("runtime-2", [{ id: "hidden-confirm", kind: "confirm", title: "未索引交互", message: "只由浏览器发现", deadline: null }]);
    assert.equal((await overview()).interactions.length, 0);
    const ws = new WebSocket(env.hub.url.replace("http:", "ws:") + `/n/${env.a.id}/api/events?session=runtime-2`, { headers: { Cookie: env.cookie, Origin: env.hub.url } });
    await connected(ws);
    await until(overview, (state) => state.interactions.some((item) => item.id === "hidden-confirm"));
    ws.terminate();
    const port = Number(new URL(env.hub.url).port); await env.hub.close();
    env.hub = await startHub({ host: "127.0.0.1", port, data: env.directory, assets: fileURLToPath(new URL("../src/web/", import.meta.url)) });
    env.cookie = await login(env.hub.url);
    await until(overview, (state) => state.interactions.some((item) => item.id === "hidden-confirm"));
    assert.equal((await respond(env.a.id, "runtime-2", "hidden-confirm", "yes")).status, 200);
    await until(overview, (state) => state.interactions.length === 0);
  });
  test("管理接口需要登录和同源提交，节点离线立即移除旧摘要", async () => {
    assert.equal((await fetch(env.hub.url + "/_hub/overview")).status, 401);
    assert.equal((await fetch(env.hub.url + "/_hub/respond", { method: "POST", headers: { Cookie: env.cookie, Origin: "https://evil.example", "Content-Type": "application/json" }, body: "{}" })).status, 403);
    await env.agentA.close();
    await until(overview, (state) => state.sessions.every((item) => item.deviceId !== env.a.id));
    assert.equal((await fetch(env.fakeA.url + "/health")).status, 200);
  });
});
