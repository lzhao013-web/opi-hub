import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { fixture, login, waitDevices, add, managedConfig } from "./helpers.ts";
import { WebSocket } from "ws";
import { connected } from "../src/shared/sockets.ts";
import type { ManagementState } from "../src/shared/management.ts";
import { OpiClient } from "../src/adapters/opi/client.ts";
import { startNode } from "../src/node/agent.ts";
import { startHub } from "../src/hub/server.ts";
import { isCompletionNotice, isNodeCompletionNotice, type HubNotice, type NodeCompletionNotice } from "../src/shared/notifications.ts";
import { object, json } from "../src/shared/protocol.ts";

async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (!await check()) { assert.ok(Date.now() < deadline, "等待通知状态超时"); await delay(10); }
}
function isHubNotice(value: unknown): value is HubNotice {
  return isCompletionNotice(value) && object(value) && typeof value.deviceId === "string" && typeof value.read === "boolean";
}
async function notices(url: string, cookie: string): Promise<HubNotice[]> {
  const value: unknown = await (await fetch(url + "/_hub/notifications", { headers: { Cookie: cookie } })).json();
  assert.ok(Array.isArray(value)); const result: unknown[] = value; assert.ok(result.every(isHubNotice)); return result;
}
async function subscribed(url: string, cookie: string, id: string) {
  const value: unknown = await (await fetch(url + "/_hub/overview", { headers: { Cookie: cookie } })).json();
  assert.ok(object(value) && Array.isArray(value.devices));
  return value.devices.some((device: unknown) => object(device) && device.id === id && device.notificationSubscribed === true);
}

test("省略 notifications 时默认检测并订阅，仍须中心显式授权后才接收提醒", { timeout: 15_000 }, async () => {
  const env = await fixture(); const client = new OpiClient(new URL(env.fakeA.url), () => {});
  let receiver: ReturnType<typeof startNode> | undefined; let initialized = 0;
  const delivered: { id: string; url: string | undefined; focusUrl: string | undefined }[] = [];
  try {
    const entry = await add(env.hub.url, env.cookie, "默认通知接收端");
    const config = managedConfig(entry.config, env.fakeB.url, env.directory); delete config.notifications;
    receiver = startNode({ ...config, windowsFocus: true }, () => {}, async () => {
      initialized++;
      return async (notice, _signal, url, focusUrl) => { delivered.push({ id: notice.id, url, focusUrl }); };
    });
    await receiver.ready; assert.equal(initialized, 1); assert.equal(await subscribed(env.hub.url, env.cookie, entry.id), false);
    const response = await fetch(env.hub.url + "/_hub/notifications/receiver", { method: "POST", headers: { Cookie: env.cookie, Origin: env.hub.url, "Content-Type": "application/json" }, body: JSON.stringify({ deviceId: entry.id, destination: crypto.randomUUID() }) });
    assert.equal(response.status, 200); await until(() => subscribed(env.hub.url, env.cookie, entry.id));
    await client.ready; await client.action({ action: "prompt", text: "默认开启后通过模拟通知发送器接收", images: [], behavior: "followUp" }, "runtime-1");
    await until(() => delivered.length === 1);
    const item = delivered[0]; assert.ok(item?.url);
    assert.ok(item.focusUrl);
    const focus = new URL(item.focusUrl); assert.equal(focus.origin, env.hub.url); assert.equal(focus.pathname, `/n/${env.a.id}/`);
    assert.match(focus.search, /^\?hub-tab=[a-f0-9]{32}$/);
    const link = new URL(item.url);
    assert.equal(link.origin, env.hub.url);
    assert.equal(link.pathname + link.search, "/");
    assert.deepEqual([...new URLSearchParams(link.hash.slice(1))], [["completion", item.id]]);
  } finally { client.close(); await receiver?.close(); await env.close(); }
});

test("执行节点通过原控制连接接收已授权的跨设备新通知，与浏览器共享去重和前台抑制", { timeout: 20_000 }, async () => {
  const received: NodeCompletionNotice[] = [];
  const env = await fixture(0, { b: async (notice) => { assert.ok(isNodeCompletionNotice(notice)); received.push(notice); } });
  const client = new OpiClient(new URL(env.fakeA.url), () => {});
  const destination = crypto.randomUUID();
  const post = (path: string, body: unknown, cookie = env.cookie, origin = env.hub.url) => fetch(env.hub.url + path, {
    method: "POST", headers: { ...(cookie ? { Cookie: cookie } : {}), Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const complete = async (text: string) => { await client.action({ action: "prompt", text, images: [], behavior: "followUp" }, "runtime-1"); };
  try {
    await client.ready;
    assert.equal(await subscribed(env.hub.url, env.cookie, env.b.id), false);
    await complete("尚未授权，不应转发给节点");
    await until(async () => (await notices(env.hub.url, env.cookie)).length === 1); assert.equal(received.length, 0);
    const binding = { deviceId: env.b.id, destination };
    assert.equal((await post("/_hub/notifications/receiver", binding, "")).status, 401);
    assert.equal((await post("/_hub/notifications/receiver", binding, env.cookie, "https://evil.example")).status, 403);
    assert.equal((await post("/_hub/notifications/receiver", { ...binding, destination: "invalid" })).status, 400);
    assert.equal((await post("/_hub/notifications/receiver", { ...binding, deviceId: crypto.randomUUID() })).status, 404);
    assert.equal((await fetch(env.hub.url + "/_hub/notifications", { headers: { Authorization: `Bearer ${env.b.config.token}` } })).status, 401);
    assert.equal((await post("/_hub/notifications/receiver", binding)).status, 200);
    await until(() => subscribed(env.hub.url, env.cookie, env.b.id)); assert.equal(received.length, 0);
    await complete("已授权的跨设备提醒"); await until(() => received.length === 1);
    const delivered = received[0]; assert.ok(delivered);
    assert.equal(delivered.deviceId, env.a.id); assert.equal(delivered.deviceName, "开发台式机");
    assert.deepEqual(Object.keys(delivered).sort(), ["completedAt", "deviceId", "deviceName", "id", "title"]);
    assert.ok(!JSON.stringify(delivered).includes("不应同步到中心"));
    const claim: unknown = await (await post("/_hub/notifications/claim", { id: delivered.id, destination })).json();
    assert.deepEqual(claim, { claimed: false });
    assert.equal((await notices(env.hub.url, env.cookie)).find((item) => item.id === delivered.id)?.read, false);
    const pageId = "a".repeat(32);
    assert.equal((await post("/_hub/notifications/presence", { pageId, sequence: 1, deviceId: env.a.id, sessionId: "runtime-1", destination, focused: true })).status, 200);
    await complete("当前接收端正在前台查看，不重复提醒");
    await until(async () => (await notices(env.hub.url, env.cookie)).length === 3); assert.equal(received.length, 1);
    await post("/_hub/notifications/presence", { pageId, sequence: 2, deviceId: env.a.id, sessionId: "runtime-1", destination, focused: false });
    assert.equal((await post("/_hub/notifications/receiver", { deviceId: null, destination })).status, 200);
    await until(async () => !await subscribed(env.hub.url, env.cookie, env.b.id));
    await complete("撤销授权，不再转发"); await until(async () => (await notices(env.hub.url, env.cookie)).length === 4);
    assert.equal(received.length, 1);
    await post("/_hub/notifications/receiver", binding); await until(() => subscribed(env.hub.url, env.cookie, env.b.id));
    assert.equal(received.length, 1); // 重新绑定不会补弹已发生的完成记录。
    await complete("重新授权后的新事件"); await until(() => received.length === 2);
    await post("/_hub/notifications/receiver", { deviceId: env.a.id, destination });
    await until(async () => !await subscribed(env.hub.url, env.cookie, env.b.id));
    await complete("只有中心授权、本机配置显式关闭，也不转发");
    await until(async () => (await notices(env.hub.url, env.cookie)).length === 6); assert.equal(received.length, 2);
  } finally { client.close(); await env.close(); }
});

test("Linux 通知按钮的决定经中心提交到原设备，无决定不消费审批", { timeout: 15_000 }, async () => {
  const env = await fixture();
  let receiver: ReturnType<typeof startNode> | undefined;
  try {
    const entry = await add(env.hub.url, env.cookie, "Linux 接收端");
    const received: { body: string; decisions: string[]; url?: string }[] = [];
    receiver = startNode({ ...managedConfig(entry.config, env.fakeB.url, env.directory), notifications: true }, () => {}, async () => async () => {}, {
      kind: "linux",
      send: async (notice, _signal, url) => {
        received.push({ body: notice.body, decisions: notice.detail?.decisions ?? [], url });
        if (url?.includes("approval=allow") || url?.includes("approval=confirm")) return "allow";
        if (url?.includes("approval=deny")) return "deny";
      },
    });
    await receiver.ready;
    const bind = await fetch(env.hub.url + "/_hub/notifications/receiver", { method: "POST", headers: { Cookie: env.cookie, Origin: env.hub.url, "Content-Type": "application/json" }, body: JSON.stringify({ deviceId: entry.id, destination: crypto.randomUUID() }) });
    assert.equal(bind.status, 200);
    await until(() => subscribed(env.hub.url, env.cookie, entry.id));
    env.fakeA.setDialogs("runtime-1", [
      ...["dismiss", "allow", "deny"].map((id) => ({
        id, kind: "bashApproval", title: "命令审批", deadline: null,
        approval: { command: id === "allow" ? `echo first\necho ${"x".repeat(500)}` : `echo approval-${id}`, cwd: "/demo", items: [] },
        options: ["Allow once", "Deny"].map((value) => ({ label: value, value })),
      })),
      { id: "confirm", kind: "confirm", title: "确认项目", message: "是否继续？", deadline: null },
      { id: "secret", kind: "secret", title: "输入密钥", initial: "secret", placeholder: "", deadline: null },
    ]);
    const fromSource = () => received.filter(x => x.url?.includes(`device=${env.a.id}`) && x.url.includes("session=runtime-1"));
    await until(() => fromSource().length >= 4 && env.fakeA.answers.length >= 2);
    assert.equal(fromSource().length, 4);
    const long = received.find(x => x.url?.includes("approval=allow"));
    assert.ok(long?.url);
    assert.equal(new URL(long.url).origin, env.hub.url);
    assert.match(long.url, new RegExp(`device=${env.a.id}`));
    assert.match(long.body, /内容已截断/);
    assert.ok(long.body.length <= 320);
    assert.deepEqual(long.decisions, ["allow", "deny"]);
    assert.deepEqual(received.find(x => x.url?.includes("approval=confirm"))?.decisions, []);
    assert.deepEqual(env.fakeA.answers.map(({ dialogId, value }) => [dialogId, value]).sort(), [["allow", "Allow once"], ["deny", "Deny"]]);
    const overview: unknown = await (await fetch(env.hub.url + "/_hub/overview", { headers: { Cookie: env.cookie } })).json();
    assert.ok(object(overview) && Array.isArray(overview.interactions));
    for (const id of ["dismiss", "confirm", "secret"]) assert.ok(overview.interactions.some((item: unknown) => object(item) && item.deviceId === env.a.id && item.id === id));
    assert.equal(env.fakeB.answers.length, 0);
  } finally { await receiver?.close(); await env.close(); }
});

test("来源节点重连的首份目录只恢复记录，不把离线期间的完成批量补弹", { timeout: 15_000 }, async () => {
  const received: NodeCompletionNotice[] = [];
  const env = await fixture(0, { b: async (notice) => { assert.ok(isNodeCompletionNotice(notice)); received.push(notice); } });
  const sockets: WebSocket[] = [];
  try {
    const source = await add(env.hub.url, env.cookie, "重连来源"); const destination = crypto.randomUUID();
    await fetch(env.hub.url + "/_hub/notifications/receiver", { method: "POST", headers: { Cookie: env.cookie, Origin: env.hub.url, "Content-Type": "application/json" }, body: JSON.stringify({ deviceId: env.b.id, destination }) });
    await until(() => subscribed(env.hub.url, env.cookie, env.b.id));
    const connect = async () => {
      const socket = new WebSocket(env.hub.url.replace(/^http/, "ws") + "/_hub/connect", { headers: { Authorization: `Bearer ${source.config.token}` } });
      sockets.push(socket); await connected(socket); return socket;
    };
    const state = (ids: string[]): ManagementState => ({ state: "ready", workspaces: [], sessions: [], models: [], interactions: [], tasks: [], creations: [], issues: [],
      notifications: ids.map((id) => ({ id, sessionId: "session", file: null, title: "测试", cwd: "/project", completedAt: new Date().toISOString(), runId: null })) });
    const first = await connect(); await json(first, { type: "management", value: state([]) });
    await json(first, { type: "management", value: state(["live"]) }); await until(() => received.length === 1);
    const closed = new Promise<void>((resolve) => first.once("close", () => resolve())); first.close(); await closed;
    const next = await connect(); await json(next, { type: "management", value: state(["live", "missed"]) });
    await until(async () => (await notices(env.hub.url, env.cookie)).length === 2);
    await json(next, { type: "management", value: state(["live", "missed", "fresh"]) });
    await until(() => received.some((item) => item.id === `${source.id}:fresh`));
    assert.deepEqual(received.map((item) => item.id), [`${source.id}:live`, `${source.id}:fresh`]);
  } finally { for (const socket of sockets) socket.terminate(); await env.close(); }
});

test("绑定持久化，中心重启和节点控制重连不补弹旧通知，也不重启托管进程", { timeout: 20_000 }, async () => {
  const received: NodeCompletionNotice[] = [];
  const env = await fixture(0, { b: async (notice) => { assert.ok(isNodeCompletionNotice(notice)); received.push(notice); } });
  const client = new OpiClient(new URL(env.fakeA.url), () => {});
  let replacement: Awaited<ReturnType<typeof startHub>> | undefined;
  try {
    const destination = crypto.randomUUID();
    const bound = await fetch(env.hub.url + "/_hub/notifications/receiver", { method: "POST", headers: { Cookie: env.cookie, Origin: env.hub.url, "Content-Type": "application/json" }, body: JSON.stringify({ deviceId: env.b.id, destination }) });
    assert.equal(bound.status, 200); await until(() => subscribed(env.hub.url, env.cookie, env.b.id));
    const saved = await readFile(env.directory + "/hub.json", "utf8"); assert.ok(saved.includes(destination)); assert.ok(!saved.includes(env.b.config.token));
    const before: unknown = await (await fetch(env.hub.url + "/_hub/overview", { headers: { Cookie: env.cookie } })).json();
    assert.ok(object(before) && Array.isArray(before.devices));
    const pids = before.devices.map((device: unknown) => object(device) && object(device.report) && object(device.report.backend) ? device.report.backend.pid : null);
    await client.ready; await client.action({ action: "prompt", text: "重启前完成", images: [], behavior: "followUp" }, "runtime-1");
    await until(() => received.length === 1);
    await env.hub.close();
    replacement = await startHub({ host: "127.0.0.1", port: Number(new URL(env.hub.url).port), data: env.directory, assets: fileURLToPath(new URL("../src/web/", import.meta.url)) });
    const cookie = await login(replacement.url); await waitDevices(replacement.url, cookie, 2);
    await until(() => subscribed(env.hub.url, cookie, env.b.id)); assert.equal(received.length, 1);
    const after: unknown = await (await fetch(env.hub.url + "/_hub/overview", { headers: { Cookie: cookie } })).json();
    assert.ok(object(after) && Array.isArray(after.devices));
    assert.deepEqual(after.devices.map((device: unknown) => object(device) && object(device.report) && object(device.report.backend) ? device.report.backend.pid : null), pids);
    await client.action({ action: "prompt", text: "重连后新的完成事件", images: [], behavior: "followUp" }, "runtime-1");
    await until(() => received.length === 2);
  } finally { client.close(); await replacement?.close(); await env.close(); }
});
