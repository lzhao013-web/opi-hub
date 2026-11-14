import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ScheduleStore } from "../src/hub/scheduling/store.ts";
import { Scheduler } from "../src/hub/scheduling/engine.ts";
import { TaskRejectedError } from "../src/hub/session-requests.ts";
import { blockingTask, executingTask, type TaskInput, type TaskRecord } from "../src/shared/tasks.ts";
import type { PlanDefinition } from "../src/shared/schedules.ts";

class FakeNodes {
  online = true; failure: "reject" | "uncertain" | null = null; readonly inputs: TaskInput[] = []; readonly records = new Map<string, TaskRecord>();
  taskOnline() { return this.online; }
  taskAvailability() { return !this.online ? "设备离线" : [...this.records.values()].some((record) => blockingTask(record.state)) ? "设备忙碌" : null; }
  task(_device: string, id: string) { return this.records.get(id); }
  async startTask(_device: string, input: TaskInput) {
    if (this.failure === "reject") throw new TaskRejectedError("节点明确拒绝启动");
    this.inputs.push(input); if (this.failure === "uncertain") throw new Error("确认连接中断");
    const at = new Date().toISOString(); this.records.set(input.id, { id: input.id, name: input.name, path: input.path, state: "creating", session: null, file: null, message: "", replyId: null, revision: 0, startedAt: at, updatedAt: at });
  }
  state(id: string, state: TaskRecord["state"]) { const value = this.records.get(id); assert.ok(value); this.records.set(id, { ...value, state, revision: value.revision + 1 }); }
  async cancelTask(_device: string, id: string) { if (!this.online) throw new Error("离线"); this.state(id, "cancelled"); }
  async acknowledgeTask(_device: string, id: string) { const value = this.records.get(id); if (value && executingTask(value.state)) throw new Error("仍在执行"); if (value) this.state(id, "abandoned"); }
}
const definition: PlanDefinition = { name: "代理检查", deviceId: "device", path: "/project", prompt: "检查代码并整理报告", timeoutSeconds: 60, rule: { kind: "daily", time: "09:00", timeZone: "UTC" } };
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "opi-hub-scheduler-")); const nodes = new FakeNodes(); let now = Date.parse("2026-11-07T08:00:00Z");
  const store = await ScheduleStore.open(directory); const scheduler = new Scheduler(store, nodes, () => true, () => now);
  return { directory, nodes, store, scheduler, now: () => now, at(value: string) { now = Date.parse(value); }, async close() { await scheduler.close(); await rm(directory, { recursive: true, force: true }); } };
}
async function until(read: () => string | undefined, value: string) { const deadline = Date.now() + 3000; while (read() !== value) { assert.ok(Date.now() < deadline); await delay(10); } }

test("到期先落盘再下发，重复扫描不重复派发，上次未结束时跳过下一次", async () => {
  const env = await fixture();
  try {
    const plan = env.scheduler.add(definition); env.at("2026-11-07T09:00:00Z"); env.scheduler.tick(); env.scheduler.tick();
    assert.equal(env.nodes.inputs.length, 1); assert.equal(env.store.runs().length, 1);
    const first = env.store.runs()[0]; assert.ok(first); assert.equal(first.id, env.nodes.inputs[0]?.id);
    env.at("2026-11-08T09:00:00Z"); env.scheduler.tick(); assert.equal(env.store.runs()[0]?.state, "skipped"); assert.equal(env.nodes.inputs.length, 1);
    env.nodes.state(first.id, "completed"); env.scheduler.tick(); assert.equal(env.store.run(first.id)?.state, "completed");
    env.scheduler.enable(plan.id, false); const manual = env.scheduler.runNow(plan.id); assert.equal(manual.trigger, "manual"); assert.equal(env.nodes.inputs.length, 2);
    assert.throws(() => env.scheduler.runNow(plan.id), /未结束|未确认/);
  } finally { await env.close(); }
});
test("所选模型随计划和运行落盘，定时与手动下发一致，旧计划仍可读取", async () => {
  const env = await fixture();
  try {
    const model = { provider: "fixture", id: "fast" };
    const old = env.scheduler.add(definition); const plan = env.scheduler.add({ ...definition, model });
    env.scheduler.enable(old.id, false); env.at("2026-11-07T09:00:00Z"); env.scheduler.tick();
    const timer = env.store.runs()[0]; assert.ok(timer);
    assert.deepEqual(timer.model, model); assert.deepEqual(env.nodes.inputs[0]?.model, model);
    env.nodes.state(timer.id, "completed"); env.scheduler.tick(); const manual = env.scheduler.runNow(plan.id);
    assert.deepEqual(manual.model, model); assert.deepEqual(env.nodes.inputs[1]?.model, model);
    await env.scheduler.close(); const restored = await ScheduleStore.open(env.directory);
    try {
      assert.deepEqual(restored.plan(plan.id)?.model, model); assert.deepEqual(restored.run(timer.id)?.model, model);
      assert.deepEqual(restored.run(manual.id)?.model, model); assert.equal(restored.plan(old.id)?.model, undefined);
    } finally { restored.close(); }
  } finally { await env.close(); }
});
test("离线与中心长时间未扫描只记错过，不自动补跑", async () => {
  const env = await fixture();
  try {
    env.scheduler.add(definition); env.nodes.online = false; env.at("2026-11-07T09:00:00Z"); env.scheduler.tick(); assert.equal(env.store.runs()[0]?.state, "missed");
    env.nodes.online = true; env.scheduler.tick(); assert.equal(env.nodes.inputs.length, 0);
    env.at("2026-11-08T09:01:00Z"); env.scheduler.tick(); assert.equal(env.store.runs()[0]?.state, "missed"); assert.equal(env.nodes.inputs.length, 0);
  } finally { await env.close(); }
});
test("中心重启仅恢复监控，不重新下发原运行，节点缺失时需人工核对后解除阻塞", async () => {
  const env = await fixture(); let replacement: Scheduler | undefined;
  try {
    const plan = env.scheduler.add(definition); const run = env.scheduler.runNow(plan.id); env.scheduler.tick(); await env.scheduler.close();
    const store = await ScheduleStore.open(env.directory); replacement = new Scheduler(store, env.nodes, () => true, env.now);
    assert.equal(store.run(run.id)?.state, "unknown"); replacement.tick(); assert.equal(store.run(run.id)?.state, "creating"); assert.equal(env.nodes.inputs.length, 1);
    env.nodes.records.clear(); replacement.tick(); assert.equal(store.run(run.id)?.state, "unknown");
    assert.throws(() => replacement?.runNow(plan.id), /未确认/); env.nodes.online = false;
    await assert.rejects(replacement.acknowledge(run.id, AbortSignal.timeout(1000)), /节点就绪/);
    env.nodes.online = true; await replacement.acknowledge(run.id, AbortSignal.timeout(1000)); assert.equal(store.run(run.id)?.state, "abandoned");
    replacement.runNow(plan.id); assert.equal(env.nodes.inputs.length, 2);
  } finally { if (replacement) await replacement.close(); else await env.scheduler.close(); await rm(env.directory, { recursive: true, force: true }); }
});
test("明确拒绝与下发结果未知不同；未知运行不自动重试，取消不等于暂停计划", async () => {
  const env = await fixture();
  try {
    const plan = env.scheduler.add(definition); env.nodes.failure = "reject"; const refused = env.scheduler.runNow(plan.id);
    await until(() => env.store.run(refused.id)?.state, "failed"); assert.equal(env.nodes.inputs.length, 0);
    env.nodes.failure = "uncertain"; const unknown = env.scheduler.runNow(plan.id); await until(() => env.store.run(unknown.id)?.state, "unknown");
    env.scheduler.tick(); assert.equal(env.nodes.inputs.length, 1); assert.throws(() => env.scheduler.runNow(plan.id), /未确认/);
    await env.scheduler.acknowledge(unknown.id, AbortSignal.timeout(1000)); env.nodes.failure = null;
    const running = env.scheduler.runNow(plan.id); env.scheduler.tick(); await env.scheduler.cancel(running.id, AbortSignal.timeout(1000));
    assert.equal(env.store.run(running.id)?.state, "cancelled"); assert.equal(env.store.plan(plan.id)?.enabled, true);
  } finally { await env.close(); }
});
test("即使延迟不足 30 秒，窗口已结束也只记错过，不启动最后一个槽位", async () => {
  const env = await fixture();
  try {
    const plan = env.scheduler.add({ ...definition, rule: { kind: "interval", start: "2026-11-07T08:00:10", end: "2026-11-07T08:00:20", minutes: 1, timeZone: "UTC" } });
    env.at("2026-11-07T08:00:20Z"); env.scheduler.tick();
    assert.equal(env.nodes.inputs.length, 0); assert.equal(env.store.runs()[0]?.state, "missed");
    assert.match(env.store.runs()[0]?.message ?? "", /时间段已结束/); assert.equal(env.store.plan(plan.id)?.enabled, false);
  } finally { await env.close(); }
});
test("两类间隔计划都跳过未结束的运行，窗口关闭不强制结束已运行任务", async () => {
  const rules: PlanDefinition["rule"][] = [
    { kind: "interval", start: "2026-11-07T09:00", end: "2026-11-07T09:02", minutes: 1, timeZone: "UTC" },
    { kind: "dailyInterval", start: "09:00", end: "09:02", minutes: 1, timeZone: "UTC" },
  ];
  for (const rule of rules) {
    const env = await fixture();
    try {
      const plan = env.scheduler.add({ ...definition, rule }); env.at("2026-11-07T09:00:00Z"); env.scheduler.tick();
      const first = env.store.runs()[0]; assert.ok(first); env.nodes.state(first.id, "running");
      env.at("2026-11-07T09:01:00Z"); env.scheduler.tick();
      assert.equal(env.store.runs()[0]?.state, "skipped"); assert.equal(env.nodes.inputs.length, 1);
      env.at("2026-11-07T09:02:00Z"); env.scheduler.tick();
      assert.equal(env.store.run(first.id)?.state, "running"); assert.equal(env.nodes.inputs.length, 1);
      assert.equal(env.store.plan(plan.id)?.nextAt, rule.kind === "interval" ? null : "2026-11-08T09:00:00.000Z");
    } finally { await env.close(); }
  }
});
test("跨午夜间隔离线不补跑，恢复后仍沿原窗口锚点触发", async () => {
  const env = await fixture();
  try {
    const plan = env.scheduler.add({ ...definition, rule: { kind: "dailyInterval", start: "23:00", end: "01:00", minutes: 40, timeZone: "UTC" } });
    env.nodes.online = false; env.at("2026-11-07T23:00:00Z"); env.scheduler.tick();
    assert.equal(env.store.runs()[0]?.state, "missed"); assert.equal(env.store.plan(plan.id)?.nextAt, "2026-11-07T23:40:00.000Z");
    env.nodes.online = true; env.at("2026-11-07T23:05:00Z"); env.scheduler.tick(); assert.equal(env.nodes.inputs.length, 0);
    env.at("2026-11-07T23:40:00Z"); env.scheduler.tick(); assert.equal(env.nodes.inputs.length, 1);
    assert.equal(env.store.plan(plan.id)?.nextAt, "2026-11-08T00:20:00.000Z");
  } finally { await env.close(); }
});
