import { test } from "node:test";
import assert from "node:assert/strict";
import { isRule } from "../src/shared/schedules.ts";
import { nextOccurrence } from "../src/hub/scheduling/time.ts";
import { intervalExpired } from "../src/hub/scheduling/interval.ts";

const range = { kind: "interval" as const, start: "2026-11-08T09:00", end: "2026-11-08T10:00", minutes: 15, timeZone: "Asia/Shanghai" };
const daily = { kind: "dailyInterval" as const, start: "09:00", end: "10:00", minutes: 15, timeZone: "Asia/Shanghai" };

test("两类间隔规则校验正整数分钟及各自的日期或时间格式", () => {
  for (const rule of [range, daily]) {
    assert.equal(isRule(rule), true);
    for (const minutes of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "15"]) assert.equal(isRule({ ...rule, minutes }), false);
  }
  assert.equal(isRule({ ...range, start: "09:00" }), false);
  assert.equal(isRule({ ...daily, end: "24:00" }), false);
});
test("日期范围锚定开始时刻，包含开始不包含结束，晚创建不从当前时刻重新计时", () => {
  assert.equal(nextOccurrence(range, Date.parse("2026-11-08T00:00:00Z")), "2026-11-08T01:00:00.000Z");
  assert.equal(nextOccurrence(range, Date.parse("2026-11-08T01:00:00Z")), "2026-11-08T01:15:00.000Z");
  assert.equal(nextOccurrence(range, Date.parse("2026-11-08T01:16:00Z")), "2026-11-08T01:30:00.000Z");
  assert.equal(nextOccurrence(range, Date.parse("2026-11-08T01:45:00Z")), null);
  assert.equal(nextOccurrence(range, Date.parse("2026-11-08T02:00:00Z")), null);
  assert.equal(nextOccurrence({ ...range, minutes: 90 }, Date.parse("2026-11-08T00:00:00Z")), "2026-11-08T01:00:00.000Z");
  assert.equal(nextOccurrence({ ...range, minutes: 90 }, Date.parse("2026-11-08T01:00:00Z")), null);
  assert.throws(() => nextOccurrence({ ...range, end: range.start }, 0), /结束时间/);
  assert.throws(() => nextOccurrence({ ...range, end: "2026-11-07T10:00" }, 0), /结束时间/);
  assert.throws(() => nextOccurrence({ ...range, start: "2026-02-30T09:00" }, 0));
});
test("日期范围可跨日，每日时段在结束后等待次日且每天重新锚定", () => {
  assert.equal(nextOccurrence({ ...range, end: "2026-11-09T10:00", minutes: 120 }, Date.parse("2026-11-08T23:00:00Z")), "2026-11-09T01:00:00.000Z");
  assert.equal(nextOccurrence(daily, Date.parse("2026-11-08T00:59:00Z")), "2026-11-08T01:00:00.000Z");
  assert.equal(nextOccurrence(daily, Date.parse("2026-11-08T01:16:00Z")), "2026-11-08T01:30:00.000Z");
  assert.equal(nextOccurrence(daily, Date.parse("2026-11-08T01:45:00Z")), "2026-11-09T01:00:00.000Z");
  assert.equal(nextOccurrence({ ...daily, minutes: 90 }, Date.parse("2026-11-08T01:00:00Z")), "2026-11-09T01:00:00.000Z");
  assert.throws(() => nextOccurrence({ ...daily, end: daily.start }, 0), /不能相同/);
});
test("每日跨午夜时段包含前一天开启的窗口，并在下个窗口重新计算间隔", () => {
  const rule = { ...daily, start: "23:00", end: "01:00", minutes: 40 };
  assert.equal(nextOccurrence(rule, Date.parse("2026-11-08T16:05:00Z")), "2026-11-08T16:20:00.000Z");
  assert.equal(nextOccurrence(rule, Date.parse("2026-11-08T16:20:00Z")), "2026-11-09T15:00:00.000Z");
  assert.equal(nextOccurrence(rule, Date.parse("2026-11-08T14:00:00Z")), "2026-11-08T15:00:00.000Z");
});
test("窗口截止约束与每日跨午夜归属一致，结束后不再使用扫描宽限期", () => {
  const at = (value: string) => Date.parse(value);
  assert.equal(intervalExpired(range, at("2026-11-08T01:45:00Z"), at("2026-11-08T01:59:59Z")), false);
  assert.equal(intervalExpired(range, at("2026-11-08T01:45:00Z"), at("2026-11-08T02:00:00Z")), true);
  const rule = { ...daily, start: "23:00", end: "01:00", minutes: 40 };
  assert.equal(intervalExpired(rule, at("2026-11-08T16:20:00Z"), at("2026-11-08T16:59:59Z")), false);
  assert.equal(intervalExpired(rule, at("2026-11-08T16:20:00Z"), at("2026-11-08T17:00:00Z")), true);
  assert.equal(intervalExpired(rule, at("2026-11-08T15:00:00Z"), at("2026-11-08T16:00:00Z")), false);
});
test("间隔按实际经过分钟计算，跨夏令时不缩短间隔，边界不存在的日窗口跳过", () => {
  const spring = { ...daily, start: "01:00", end: "04:00", minutes: 60, timeZone: "America/New_York" };
  assert.equal(nextOccurrence(spring, Date.parse("2026-03-08T06:00:00Z")), "2026-03-08T07:00:00.000Z");
  const fall = { ...spring, start: "00:00", end: "03:00", minutes: 30 };
  assert.equal(nextOccurrence(fall, Date.parse("2026-11-01T05:30:00Z")), "2026-11-01T06:00:00.000Z");
  assert.equal(nextOccurrence({ ...spring, start: "02:30" }, Date.parse("2026-03-08T05:00:00Z")), "2026-03-09T06:30:00.000Z");
  assert.throws(() => nextOccurrence({ ...range, start: "2026-03-08T02:30", end: "2026-03-08T04:00", timeZone: spring.timeZone }, 0), /本地时间.*不存在/);
});
