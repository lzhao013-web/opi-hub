import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import type { Session } from "../src/hub/auth.ts";
import { CompletionObserver } from "../src/adapters/opi/completion.ts";
import { NotificationCenter } from "../src/hub/notifications.ts";
import type { CompletionNotice, HubNotice } from "../src/shared/notifications.ts";
import type { ManagementState } from "../src/shared/management.ts";
import { fixture } from "./helpers.ts";
import { OpiClient } from "../src/adapters/opi/client.ts";

function snapshot(running: boolean, id: string | null, reason = "stop", commandRunning = false) {
  return { type: "snapshot", value: { sessionId: "session", running, commandRunning, retrying: false, compacting: false, queue: { steering: [], followUp: [] }, entries: id ? [{ id, messages: [{ role: "assistant", content: "不能保留的正文", stopReason: reason }] }] : [], streamingMessage: null } };
}
test("完成提醒基于实际执行与新回复，初始历史、重复快照、错误、取消和纯命令不误报", () => {
  const events: string[] = []; const observer = new CompletionObserver((session, reply) => events.push(`${session}:${reply}`));
  observer.consume(snapshot(false, "old")); assert.deepEqual(events, []);
  observer.consume(snapshot(true, "old")); observer.consume(snapshot(false, "first")); observer.consume(snapshot(false, "first"));
  assert.deepEqual(events, ["session:first"]);
  for (const reason of ["error", "aborted", "toolUse"]) { observer.consume(snapshot(true, "first")); observer.consume(snapshot(false, reason, reason)); }
  observer.consume(snapshot(false, "old", "stop", true)); observer.consume(snapshot(false, "old"));
  assert.deepEqual(events, ["session:first"]);
  observer.consume(snapshot(true, "old")); observer.consume(snapshot(false, "length", "length"));
  assert.deepEqual(events, ["session:first", "session:length"]);
  assert.ok(!JSON.stringify(observer).includes("不能保留的正文"));
  const reconnect = new CompletionObserver(() => assert.fail("重连不能补发历史完成提醒")); reconnect.consume(snapshot(false, "length", "length"));
});
test("完成投影支持增量，队列和重试尚未结束时不提前提醒", () => {
  const events: string[] = []; const observer = new CompletionObserver((_session, reply) => events.push(reply));
  observer.consume(snapshot(true, null));
  observer.consume({ type: "patch", sessionId: "session", value: { running: false, retrying: true }, entries: { keep: 0, items: [{ id: "reply", messages: [{ role: "assistant", stopReason: "stop" }] }] } });
  assert.deepEqual(events, []);
  observer.consume({ type: "patch", sessionId: "session", value: { retrying: false } }); assert.deepEqual(events, ["reply"]);
});
function notice(id: string): CompletionNotice { return { id, sessionId: "session", file: null, title: "测试会话", cwd: "/project", completedAt: new Date().toISOString(), runId: null }; }
function state(notifications: CompletionNotice[]): ManagementState { return { state: "ready", models: [], workspaces: [], sessions: [], interactions: [], creations: [], tasks: [], notifications, issues: [] }; }
test("通知内存有界，重放不复活旧通知，设备身份隔离，已读与投递去重相互独立", () => {
  const center = new NotificationCenter();
  center.accept("a", state([]));
  const records = Array.from({ length: 100 }, (_, index) => notice(String(index)));
  center.accept("a", state(records)); center.accept("b", state([notice("0")])); assert.equal(center.snapshot().length, 100);
  center.accept("a", state(records)); assert.equal(center.snapshot().length, 100); assert.ok(!center.snapshot().some((item) => item.id === "a:0"));
  assert.equal(center.claim("a:99", "browser"), true); assert.equal(center.claim("a:99", "browser"), false); assert.equal(center.claim("a:99", "other-browser"), true);
  center.read("a:99"); assert.equal(center.claim("a:99", "third-browser"), false); assert.equal(center.snapshot().find((item) => item.id === "b:0")?.read, false);
  center.removeDevice("a"); assert.deepEqual(center.snapshot().map((item) => item.id), ["b:0"]);
});
test("中心首次导入节点历史通知只恢复列表，不补弹系统通知", () => {
  const center = new NotificationCenter(); center.accept("a", state([notice("old")]));
  assert.equal(center.snapshot().length, 1); assert.equal(center.claim("a:old", "browser"), false);
  center.accept("a", state([notice("old"), notice("new")])); assert.equal(center.claim("a:new", "browser"), true);
});
test("完成时的前台查看抑制延迟通知，旧查看上报不能覆盖新状态", () => {
  const center = new NotificationCenter(); const session: Session = { id: "login", expires: Date.now() + 60_000, close: new Set() };
  center.accept("a", state([]));
  center.attend(session, "page", 1, "a", "session", "browser", true); center.accept("a", state([notice("first")]));
  center.attend(session, "page", 2, "a", "session", "browser", false);
  assert.equal(center.claim("a:first", "browser"), false); assert.equal(center.claim("a:first", "other"), true);
  center.attend(session, "page", 1, "a", "session", "browser", true); center.accept("a", state([notice("first"), notice("second")]));
  assert.equal(center.claim("a:second", "browser"), true);
  for (const close of session.close) close();
});
test("真实节点无会话页面时同步完成，SSE 在后台持续推送，通知接口认证且读通知不消费审批", { timeout: 25_000 }, async () => {
  const env = await fixture(); const client = new OpiClient(new URL(env.fakeA.url), () => {});
  const controller = new AbortController();
  const headers = { Cookie: env.cookie, Origin: env.hub.url, "Content-Type": "application/json" };
  const read = async (): Promise<HubNotice[]> => (await (await fetch(env.hub.url + "/_hub/notifications", { headers })).json()) as HubNotice[];
  try {
    assert.equal((await fetch(env.hub.url + "/_hub/notifications")).status, 401);
    assert.equal((await fetch(env.hub.url + "/_hub/notifications/events")).status, 401);
    const stream = await fetch(env.hub.url + "/_hub/notifications/events", { headers, signal: controller.signal }); assert.equal(stream.status, 200);
    const reader = stream.body?.getReader(); assert.ok(reader); await reader.read();
    await client.ready; await client.action({ action: "prompt", text: "完成但没有 Web 页面", images: [], behavior: "followUp" }, "runtime-1");
    let received = "";
    while (!received.includes("runtime-1")) { const chunk = await reader.read(); assert.equal(chunk.done, false); received += new TextDecoder().decode(chunk.value); }
    const notices = await read(); assert.equal(notices.length, 1); const item = notices[0]; assert.ok(item); assert.equal(item.deviceId, env.a.id); assert.equal(item.read, false);
    assert.ok(!JSON.stringify(notices).includes("不应同步到中心"));
    const post = (path: string, body: unknown, origin = env.hub.url) => fetch(env.hub.url + path, { method: "POST", headers: { ...headers, Origin: origin }, body: JSON.stringify(body) });
    assert.equal((await post("/_hub/notifications/read", { id: item.id }, "https://evil.example")).status, 403);
    const destination = crypto.randomUUID(); const requests = await Promise.all([1, 2].map(() => post("/_hub/notifications/claim", { id: item.id, destination })));
    const claims = await Promise.all(requests.map(async (response) => { const value: unknown = await response.json(); assert.ok(typeof value === "object" && value !== null && "claimed" in value); return value.claimed; }));
    assert.deepEqual(claims.sort(), [false, true]);
    assert.equal((await post("/_hub/notifications/read", { id: item.id })).status, 200); assert.equal((await read())[0]?.read, true);
    const overview: { interactions: unknown[] } = await (await fetch(env.hub.url + "/_hub/overview", { headers })).json(); assert.equal(overview.interactions.length, 2);
    await client.action({ action: "prompt", text: "ERROR 不能误报完成", images: [], behavior: "followUp" }, "runtime-1");
    await client.synchronize(AbortSignal.timeout(5000));
    env.fakeA.disconnectClients();
    const deadline = Date.now() + 5000;
    while (env.fakeA.selections().length === 0) { assert.ok(Date.now() < deadline); await delay(20); }
    assert.equal((await read()).length, 1);
    await env.agentA.close(); assert.equal((await read()).length, 1);
    assert.equal((await post("/_hub/logout", {})).status, 200);
    while (!(await reader.read()).done) { /* 退出登录必须结束事件流。 */ }
    controller.abort(); await reader.cancel().catch(() => {});
  } finally { controller.abort(); client.close(); await env.close(); }
});
