import { test } from "node:test";
import assert from "node:assert/strict";
import { nextOccurrence } from "../src/hub/scheduling/time.ts";

test("一次性预约按显式时区转换，过期不补跑，非法日期和时区拒绝", () => {
  const rule = { kind: "once" as const, local: "2026-11-08T09:00", timeZone: "Asia/Shanghai" };
  assert.equal(nextOccurrence(rule, Date.parse("2026-11-08T00:00:00Z")), "2026-11-08T01:00:00.000Z");
  assert.equal(nextOccurrence(rule, Date.parse("2026-11-08T02:00:00Z")), null);
  assert.throws(() => nextOccurrence({ ...rule, local: "2026-02-30T09:00" }, 0));
  assert.throws(() => nextOccurrence({ ...rule, timeZone: "bad-zone" }, 0));
});
test("一次性预约拒绝缺失时刻，重复时刻只取第一次而不补第二次", () => {
  const rule = { kind: "once" as const, local: "2026-03-08T02:30", timeZone: "America/New_York" };
  assert.throws(() => nextOccurrence(rule, Date.parse("2026-03-08T05:00:00Z")), /本地时间.*不存在/);
  const repeated = { ...rule, local: "2026-11-01T01:30" };
  assert.equal(nextOccurrence(repeated, Date.parse("2026-11-01T04:00:00Z")), "2026-11-01T05:30:00.000Z");
  assert.equal(nextOccurrence(repeated, Date.parse("2026-11-01T05:31:00Z")), null);
});
test("每天和每周跨年转换，夏令时缺失跳过、重复只触发第一次", () => {
  assert.equal(nextOccurrence({ kind: "daily", time: "09:00", timeZone: "Asia/Shanghai" }, Date.parse("2026-12-31T02:00:00Z")), "2027-01-01T01:00:00.000Z");
  assert.equal(nextOccurrence({ kind: "weekly", time: "09:00", timeZone: "UTC", days: [1] }, Date.parse("2026-11-06T12:00:00Z")), "2026-11-09T09:00:00.000Z");
  assert.equal(nextOccurrence({ kind: "daily", time: "02:30", timeZone: "America/New_York" }, Date.parse("2026-03-08T05:00:00Z")), "2026-03-09T06:30:00.000Z");
  assert.equal(nextOccurrence({ kind: "daily", time: "01:30", timeZone: "America/New_York" }, Date.parse("2026-11-01T04:00:00Z")), "2026-11-01T05:30:00.000Z");
  assert.equal(nextOccurrence({ kind: "daily", time: "01:30", timeZone: "America/New_York" }, Date.parse("2026-11-01T05:31:00Z")), "2026-11-02T06:30:00.000Z");
});
test("时区跳过整日时跳过该次日历规则，不平移到其他星期执行", () => {
  const after = Date.parse("2011-12-29T22:00:00Z");
  assert.equal(nextOccurrence({ kind: "daily", time: "09:00", timeZone: "Pacific/Apia" }, after), "2011-12-30T19:00:00.000Z");
  assert.equal(nextOccurrence({ kind: "weekly", time: "09:00", timeZone: "Pacific/Apia", days: [5] }, after), "2012-01-05T19:00:00.000Z");
});
