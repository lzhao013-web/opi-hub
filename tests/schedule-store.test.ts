import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ScheduleStore } from "../src/hub/scheduling/store.ts";
import type { PlanDefinition } from "../src/shared/schedules.ts";

const definition: PlanDefinition = { name: "检查项目", deviceId: "device", path: "/project", prompt: "检查测试结果并整理报告", timeoutSeconds: 600, rule: { kind: "daily", time: "09:00", timeZone: "UTC" } };
test("计划和触发记录原子落盘、重复触发去重，第二个中心不能打开同一调度目录", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "opi-hub-schedule-")); let store = await ScheduleStore.open(directory);
  try {
    await assert.rejects(ScheduleStore.open(directory), /已有计划任务中心/);
    const now = Date.parse("2026-11-07T08:00:00Z"); const plan = store.add(definition, now); assert.ok(plan.nextAt);
    const run = store.claim(plan.id, plan.nextAt, "timer", Date.parse(plan.nextAt), null); assert.equal(run?.state, "dispatching");
    assert.equal(store.claim(plan.id, plan.nextAt, "timer", Date.parse(plan.nextAt), null), undefined);
    store.close(); store = await ScheduleStore.open(directory);
    assert.equal(store.runs().length, 1); assert.notEqual(store.plan(plan.id)?.nextAt, plan.nextAt);
    store.recover(Date.parse("2026-11-07T10:00:00Z")); assert.equal(store.runs()[0]?.state, "unknown");
    const next = store.plan(plan.id)?.nextAt; assert.ok(next);
    assert.equal(store.claim(plan.id, next, "timer", Date.parse(next), null)?.state, "skipped");
    assert.throws(() => store.archive(plan.id), /未确认/);
    assert.ok(run); store.mark(run.id, "abandoned", "已核对", Date.parse(next)); store.archive(plan.id);
    assert.equal(store.plans().length, 0); assert.equal(store.runs().length, 2);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});
test("启动恢复记录错过，不补跑；暂停和设备移除停止未来触发", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "opi-hub-schedule-")); const store = await ScheduleStore.open(directory);
  try {
    const at = Date.parse("2026-11-07T08:00:00Z"); const plan = store.add(definition, at);
    store.recover(Date.parse("2026-11-10T11:00:00Z")); assert.equal(store.runs().length, 1); assert.equal(store.runs()[0]?.state, "missed");
    assert.equal(store.plan(plan.id)?.nextAt, "2026-11-11T09:00:00.000Z");
    store.enabled(plan.id, false, at); assert.equal(store.due(Date.parse("2030-01-01T00:00:00Z")).length, 0);
    store.enabled(plan.id, true, Date.parse("2026-11-10T11:00:00Z")); store.disableDevice("device"); assert.equal(store.plan(plan.id)?.enabled, false);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});
test("两类间隔持久化后按原锚点恢复，过期范围关闭且不能重新启用补跑", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "opi-hub-interval-store-")); let store = await ScheduleStore.open(directory);
  try {
    const at = Date.parse("2026-11-07T08:00:00Z");
    const range = store.add({ ...definition, rule: { kind: "interval", start: "2026-11-07T09:00", end: "2026-11-07T10:00", minutes: 15, timeZone: "UTC" } }, at);
    const daily = store.add({ ...definition, rule: { kind: "dailyInterval", start: "23:00", end: "01:00", minutes: 40, timeZone: "UTC" } }, at);
    store.close(); store = await ScheduleStore.open(directory);
    assert.deepEqual(store.plan(range.id)?.rule, range.rule); assert.deepEqual(store.plan(daily.id)?.rule, daily.rule);
    store.recover(Date.parse("2026-11-07T09:16:00Z")); assert.equal(store.plan(range.id)?.nextAt, "2026-11-07T09:30:00.000Z");
    assert.equal(store.runs()[0]?.state, "missed");
    store.enabled(range.id, false, Date.parse("2026-11-07T09:17:00Z"));
    store.enabled(range.id, true, Date.parse("2026-11-07T09:31:00Z")); assert.equal(store.plan(range.id)?.nextAt, "2026-11-07T09:45:00.000Z");
    store.recover(Date.parse("2026-11-07T10:00:00Z")); assert.equal(store.plan(range.id)?.enabled, false);
    assert.throws(() => store.enabled(range.id, true, Date.parse("2026-11-07T10:00:00Z")), /未来执行时刻/);
    store.recover(Date.parse("2026-11-08T00:05:00Z")); assert.equal(store.plan(daily.id)?.nextAt, "2026-11-08T00:20:00.000Z");
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});
