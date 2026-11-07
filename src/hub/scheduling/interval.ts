import { Temporal } from "@js-temporal/polyfill";
import type { ScheduleRule } from "../../shared/schedules.ts";

type IntervalRule = Extract<ScheduleRule, { minutes: number }>;
interface Window { start: number; end: number }
function localInstant(local: Temporal.PlainDateTime, timeZone: string): number | null {
  const zoned = local.toZonedDateTime(timeZone, { disambiguation: "compatible" });
  return zoned.toPlainDateTime().equals(local) ? zoned.epochMilliseconds : null;
}
function rangeWindow(rule: Extract<IntervalRule, { kind: "interval" }>): Window {
  const start = localInstant(Temporal.PlainDateTime.from(rule.start, { overflow: "reject" }), rule.timeZone);
  const end = localInstant(Temporal.PlainDateTime.from(rule.end, { overflow: "reject" }), rule.timeZone);
  if (start === null || end === null) throw new Error("时间段边界的本地时间因时区转换不存在");
  if (end <= start) throw new Error("结束时间必须晚于开始时间");
  return { start, end };
}
function dailyWindow(rule: Extract<IntervalRule, { kind: "dailyInterval" }>, date: Temporal.PlainDate): Window | null {
  if (rule.start === rule.end) throw new Error("每日时段的开始和结束不能相同");
  const endDate = rule.end < rule.start ? date.add({ days: 1 }) : date;
  const start = localInstant(date.toPlainDateTime(rule.start), rule.timeZone);
  const end = localInstant(endDate.toPlainDateTime(rule.end), rule.timeZone);
  return start === null || end === null ? null : { start, end };
}
function localDate(timeZone: string, at: number): Temporal.PlainDate {
  return Temporal.Instant.fromEpochMilliseconds(at).toZonedDateTimeISO(timeZone).toPlainDate();
}
/** 间隔按实际经过分钟计算，以窗口开始为锚点，严格选择 after 之后且未到结束的槽位。 */
function nextInWindow(window: Window, minutes: number, after: number): string | null {
  const step = minutes * 60_000;
  const slot = window.start + Math.max(0, Math.floor((after - window.start) / step) + 1) * step;
  return slot < window.end ? new Date(slot).toISOString() : null;
}
export function nextInterval(rule: IntervalRule, after: number): string | null {
  if (rule.kind === "interval") return nextInWindow(rangeWindow(rule), rule.minutes, after);
  let date = localDate(rule.timeZone, after).subtract({ days: 1 });
  for (let day = 0; day < 16; day++, date = date.add({ days: 1 })) {
    const window = dailyWindow(rule, date);
    if (window) { const next = nextInWindow(window, rule.minutes, after); if (next) return next; }
  }
  throw new Error("未来两周内没有可用的执行时段");
}
/** 即使还在正常扫描宽限期内，也不在所属窗口结束后启动。 */
export function intervalExpired(rule: ScheduleRule, scheduledAt: number, now: number): boolean {
  if (rule.kind === "interval") return now >= rangeWindow(rule).end;
  if (rule.kind !== "dailyInterval") return false;
  const date = localDate(rule.timeZone, scheduledAt);
  return ![date.subtract({ days: 1 }), date].some((day) => {
    const window = dailyWindow(rule, day);
    return window !== null && window.start <= scheduledAt && scheduledAt < window.end && now < window.end;
  });
}
