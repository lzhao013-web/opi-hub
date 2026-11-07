import { Temporal } from "@js-temporal/polyfill";
import type { ScheduleRule } from "../../shared/schedules.ts";
import { nextInterval } from "./interval.ts";

/** 日历规则使用本地时刻，间隔规则使用窗口边界和实际经过分钟。 */
export function nextOccurrence(rule: ScheduleRule, after: number): string | null {
  if (rule.kind === "interval" || rule.kind === "dailyInterval") return nextInterval(rule, after);
  if (rule.kind === "once") {
    const local = Temporal.PlainDateTime.from(rule.local, { overflow: "reject" });
    const zoned = local.toZonedDateTime(rule.timeZone, { disambiguation: "compatible" });
    if (!zoned.toPlainDateTime().equals(local)) throw new Error("该本地时间因时区转换不存在");
    return zoned.epochMilliseconds > after ? new Date(zoned.epochMilliseconds).toISOString() : null;
  }
  const current = Temporal.Instant.fromEpochMilliseconds(after).toZonedDateTimeISO(rule.timeZone);
  let date = current.toPlainDate(); const time = Temporal.PlainTime.from(rule.time);
  for (let day = 0; day < 15; day++, date = date.add({ days: 1 })) {
    if (rule.kind === "weekly" && !rule.days.includes(date.dayOfWeek)) continue;
    const local = date.toPlainDateTime(time); const zoned = local.toZonedDateTime(rule.timeZone, { disambiguation: "compatible" });
    if (zoned.toPlainDateTime().equals(local) && zoned.epochMilliseconds > after) return new Date(zoned.epochMilliseconds).toISOString();
  }
  throw new Error("未来两周内没有可用的执行时刻");
}
