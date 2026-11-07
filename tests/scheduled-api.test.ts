import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { fixture, login, waitDevices } from "./helpers.ts";
import { startHub } from "../src/hub/server.ts";
import { isPlan, isRun, type PlanDefinition } from "../src/shared/schedules.ts";
import { object } from "../src/shared/protocol.ts";

let env: Awaited<ReturnType<typeof fixture>>;
before(async () => { env = await fixture(); });
after(async () => { await env.hub.close(); await env.close(); });
const headers = () => ({ Cookie: env.cookie, Origin: env.hub.url, "Content-Type": "application/json" });
const post = (url: string, body: unknown = {}) => fetch(env.hub.url + url, { method: "POST", headers: headers(), body: JSON.stringify(body) });
async function snapshot() {
  const value: unknown = await (await fetch(env.hub.url + "/_hub/schedules", { headers: headers() })).json();
  assert.ok(object(value) && Array.isArray(value.plans) && value.plans.every(isPlan) && Array.isArray(value.runs) && value.runs.every(isRun));
  return { plans: value.plans, runs: value.runs };
}
async function until<T>(read: () => Promise<T> | T, accept: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 10_000;
  while (true) { const value = await read(); if (accept(value)) return value; assert.ok(Date.now() < deadline, "等待计划运行状态超时"); await delay(20); }
}
async function plan(prompt: string, timeoutSeconds = 10) {
  const input: PlanDefinition = { name: `计划 ${prompt}`, deviceId: env.a.id, path: "/fixture/设备 A/other", prompt, timeoutSeconds, rule: { kind: "once", local: new Date(Date.now() + 3600_000).toISOString().slice(0, 19), timeZone: "UTC" } };
  const response = await post("/_hub/schedules", input); assert.equal(response.status, 201); const value: unknown = await response.json(); assert.ok(isPlan(value)); return value;
}
async function runNow(id: string) { const response = await post(`/_hub/schedules/${id}/run`); assert.equal(response.status, 202); const value: unknown = await response.json(); assert.ok(isRun(value)); return value; }

describe("计划任务真实节点协议", () => {
  test("手动触发在全新会话发送自然语言，仅发送一次，不把正文同步进运行记录", async () => {
    const entry = await plan("生成测试报告"); const run = await runNow(entry.id);
    const value = await until(snapshot, (value) => value.runs.some((item) => item.id === run.id && item.state === "completed"));
    assert.equal(env.fakeA.prompts.length, 1); assert.equal(env.fakeA.prompts[0]?.text, "生成测试报告"); assert.equal(env.fakeB.prompts.length, 0);
    const record = value.runs.find((item) => item.id === run.id); assert.ok(record?.session); assert.notEqual(record.session.id, "runtime-1"); assert.notEqual(record.session.id, "runtime-2");
    assert.ok(!JSON.stringify(value).includes("不应同步到中心的助手正文"));
    env.fakeA.deleteSession(record.session.id);
    const read = async () => { const current: unknown = await (await fetch(env.hub.url + "/_hub/overview", { headers: headers() })).json(); return current; };
    await until(read, (current) => object(current) && Array.isArray(current.sessions) && current.sessions.every((item) => !object(item) || !object(item.target) || item.target.id !== record.session?.id));
    assert.equal((await snapshot()).runs.find((item) => item.id === run.id)?.state, "completed");
  });
  test("不同设备可并行运行，同设备不重入，取消一台不影响另一台", async () => {
    const a = await plan("WAIT 并行设备 A", 30);
    const input: PlanDefinition = { name: "并行设备 B", deviceId: env.b.id, path: "/fixture/设备 B/other", prompt: "WAIT 并行设备 B", timeoutSeconds: 30,
      rule: { kind: "daily", time: "09:00", timeZone: "UTC" } };
    const response = await post("/_hub/schedules", input); assert.equal(response.status, 201);
    const b: unknown = await response.json(); assert.ok(isPlan(b));
    const [runA, runB] = await Promise.all([runNow(a.id), runNow(b.id)]);
    await until(snapshot, (value) => [runA, runB].every((run) => value.runs.some((item) => item.id === run.id && item.state === "running")));
    assert.equal((await post(`/_hub/schedules/${a.id}/run`)).status, 409);
    assert.equal(env.fakeA.prompts.filter((prompt) => prompt.text === "WAIT 并行设备 A").length, 1);
    assert.equal(env.fakeB.prompts.filter((prompt) => prompt.text === input.prompt).length, 1);
    assert.equal((await post(`/_hub/runs/${runA.id}/cancel`)).status, 200);
    const current = await until(snapshot, (value) => value.runs.some((item) => item.id === runA.id && item.state === "cancelled"));
    assert.equal(current.runs.find((run) => run.id === runB.id)?.state, "running");
    assert.equal((await post(`/_hub/runs/${runB.id}/cancel`)).status, 200);
    await until(snapshot, (value) => value.runs.some((item) => item.id === runB.id && item.state === "cancelled"));
  });
  test("一次性到期会由中心自动触发，结束后不重复触发或保持启用", async () => {
    const at = new Date(Date.now() + 3000).toISOString().slice(0, 19);
    const input: PlanDefinition = { name: "自动到期执行", deviceId: env.a.id, path: "/fixture/设备 A/other", prompt: "预约到期生成报告", timeoutSeconds: 10, rule: { kind: "once", local: at, timeZone: "UTC" } };
    const response = await post("/_hub/schedules", input); assert.equal(response.status, 201); const entry: unknown = await response.json(); assert.ok(isPlan(entry));
    const value = await until(snapshot, (value) => value.runs.some((run) => run.planId === entry.id && run.state === "completed"));
    assert.equal(value.runs.find((run) => run.planId === entry.id)?.trigger, "timer"); assert.equal(value.plans.find((plan) => plan.id === entry.id)?.enabled, false);
    assert.equal(env.fakeA.prompts.filter((prompt) => prompt.text === input.prompt).length, 1);
  });
  test("日期范围按时自动触发，窗口结束只停止新触发、不取消在途任务", async () => {
    const start = Math.floor((Date.now() + 4000) / 1000) * 1000; const end = start + 5000;
    const input: PlanDefinition = { name: "窗口自动触发", deviceId: env.a.id, path: "/fixture/设备 A/other", prompt: "WAIT 窗口结束仍运行", timeoutSeconds: 30,
      rule: { kind: "interval", start: new Date(start).toISOString().slice(0, 19), end: new Date(end).toISOString().slice(0, 19), minutes: 1, timeZone: "UTC" } };
    const response = await post("/_hub/schedules", input); assert.equal(response.status, 201);
    const entry: unknown = await response.json(); assert.ok(isPlan(entry));
    const first = await until(snapshot, (value) => value.runs.some((run) => run.planId === entry.id && run.state === "running"));
    const run = first.runs.find((run) => run.planId === entry.id); assert.ok(run);
    const after = await until(snapshot, (value) => Date.now() >= end && value.runs.some((item) => item.id === run.id && item.state === "running"));
    assert.equal(after.plans.find((plan) => plan.id === entry.id)?.enabled, false);
    assert.equal(env.fakeA.prompts.filter((prompt) => prompt.text === input.prompt).length, 1);
    assert.equal((await post(`/_hub/runs/${run.id}/cancel`)).status, 200);
    await until(snapshot, (value) => value.runs.some((item) => item.id === run.id && item.state === "cancelled"));
  });
  test("执行期间保留集中审批，取消与超时只停止对应专用会话", async () => {
    const entry = await plan("ASK 等待确认"); const run = await runNow(entry.id);
    const read = async () => { const value: unknown = await (await fetch(env.hub.url + "/_hub/overview", { headers: headers() })).json(); return value; };
    const state = await until(read, (value) => object(value) && Array.isArray(value.interactions) && value.interactions.some((item) => object(item) && item.title === "计划任务确认"));
    assert.ok(object(state) && Array.isArray(state.interactions)); const question = state.interactions.find((item) => object(item) && item.title === "计划任务确认");
    assert.ok(object(question) && typeof question.id === "string" && typeof question.sessionId === "string");
    assert.equal((await post("/_hub/respond", { deviceId: env.a.id, sessionId: question.sessionId, dialogId: question.id, value: "yes" })).status, 200);
    await until(snapshot, (value) => value.runs.some((item) => item.id === run.id && item.state === "completed"));
    const waiting = await plan("WAIT 等待取消"); const active = await runNow(waiting.id); await until(snapshot, (value) => value.runs.some((item) => item.id === active.id && item.state === "running"));
    assert.equal((await post(`/_hub/runs/${active.id}/cancel`)).status, 200); await until(snapshot, (value) => value.runs.some((item) => item.id === active.id && item.state === "cancelled"));
    const timed = await plan("WAIT 运行超时", 2); const timeout = await runNow(timed.id); await until(snapshot, (value) => value.runs.some((item) => item.id === timeout.id && item.state === "timed_out"));
  });
  test("提供商错误不会被误报为成功；连接丢失标为未知，重新连接取消不重发任务", async () => {
    const error = await plan("ERROR 返回模型错误"); const bad = await runNow(error.id);
    const failed = await until(snapshot, (value) => value.runs.some((item) => item.id === bad.id && item.state === "failed")); assert.match(failed.runs.find((item) => item.id === bad.id)?.message ?? "", /模型错误/);
    const drop = await plan("DROP 中断执行观察"); const lost = await runNow(drop.id);
    await until(snapshot, (value) => value.runs.some((item) => item.id === lost.id && item.state === "unknown")); const count = env.fakeA.prompts.length;
    assert.equal((await post(`/_hub/schedules/${drop.id}/run`)).status, 409);
    assert.equal((await post(`/_hub/runs/${lost.id}/cancel`)).status, 200); await until(snapshot, (value) => value.runs.some((item) => item.id === lost.id && item.state === "cancelled")); assert.equal(env.fakeA.prompts.length, count);
  });
  test("中心重启恢复监控而不下发第二次；任务记录和计划均落盘", async () => {
    const entry = await plan("WAIT 中心重启测试"); const run = await runNow(entry.id); await until(snapshot, (value) => value.runs.some((item) => item.id === run.id && item.state === "running"));
    const count = env.fakeA.prompts.length; const port = Number(new URL(env.hub.url).port); await env.hub.close();
    env.hub = await startHub({ host: "127.0.0.1", port, data: env.directory, assets: fileURLToPath(new URL("../src/web/", import.meta.url)) }); env.cookie = await login(env.hub.url); await waitDevices(env.hub.url, env.cookie, 2);
    await until(snapshot, (value) => value.runs.some((item) => item.id === run.id && item.state === "running")); assert.equal(env.fakeA.prompts.length, count);
    assert.equal((await post(`/_hub/runs/${run.id}/cancel`)).status, 200); await until(snapshot, (value) => value.runs.some((item) => item.id === run.id && item.state === "cancelled"));
  });
  test("计划接口验证登录和来源，拒绝直接 Shell 或斜杠任务", async () => {
    assert.equal((await fetch(env.hub.url + "/_hub/schedules")).status, 401);
    assert.equal((await fetch(env.hub.url + "/_hub/schedules", { method: "POST", headers: { ...headers(), Origin: "https://evil.example" }, body: "{}" })).status, 403);
    for (const prompt of ["!echo unsafe", "/usage"]) {
      const input: PlanDefinition = { name: "不接受直接命令", deviceId: env.a.id, path: "/project", prompt, timeoutSeconds: 60, rule: { kind: "daily", time: "09:00", timeZone: "UTC" } };
      assert.equal((await post("/_hub/schedules", input)).status, 400);
    }
  });
});
