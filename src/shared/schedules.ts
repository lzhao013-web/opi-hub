import { object } from "./protocol.ts";
import { isModelRef, type ModelRef } from "./models.ts";
import { isTaskInput, type TaskState } from "./tasks.ts";
import { isCreatedSession, type CreatedSession } from "./session-creation.ts";

export type ScheduleRule = { kind: "once"; local: string; timeZone: string } |
  { kind: "daily"; time: string; timeZone: string } | { kind: "weekly"; time: string; timeZone: string; days: number[] } |
  { kind: "interval"; start: string; end: string; minutes: number; timeZone: string } |
  { kind: "dailyInterval"; start: string; end: string; minutes: number; timeZone: string };
export interface PlanDefinition { name: string; deviceId: string; path: string; prompt: string; timeoutSeconds: number; rule: ScheduleRule; model?: ModelRef }
export interface Plan extends PlanDefinition { id: string; enabled: boolean; archived: boolean; nextAt: string | null; createdAt: string }
export type RunState = TaskState | "dispatching" | "missed" | "skipped";
export interface ScheduleRun {
  id: string; planId: string; name: string; deviceId: string; path: string; scheduledAt: string; trigger: "timer" | "manual";
  state: RunState; session: CreatedSession | null; file: string | null; message: string; nodeRevision: number; updatedAt: string; replyId?: string | null; model?: ModelRef;
}
const str = (value: unknown): value is string => typeof value === "string";
const localDateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/;
const localTime = /^([01]\d|2[0-3]):[0-5]\d$/;
export function isRule(value: unknown): value is ScheduleRule {
  if (!object(value) || !str(value.timeZone) || value.timeZone.length > 100) return false;
  if (value.kind === "once") return str(value.local) && localDateTime.test(value.local);
  if (value.kind === "interval" || value.kind === "dailyInterval") {
    const pattern = value.kind === "interval" ? localDateTime : localTime;
    return str(value.start) && str(value.end) && pattern.test(value.start) && pattern.test(value.end) &&
      typeof value.minutes === "number" && Number.isSafeInteger(value.minutes) && value.minutes >= 1;
  }
  if (value.kind !== "daily" && value.kind !== "weekly" || !str(value.time) || !localTime.test(value.time)) return false;
  return value.kind === "daily" || Array.isArray(value.days) && value.days.length > 0 && value.days.length <= 7 && new Set(value.days).size === value.days.length && value.days.every((day) => Number.isInteger(day) && day >= 1 && day <= 7);
}
export function isPlanDefinition(value: unknown): value is PlanDefinition {
  return object(value) && str(value.deviceId) && isRule(value.rule) && isTaskInput({ ...value, id: "definition" });
}
export function isPlan(value: unknown): value is Plan {
  return isPlanDefinition(value) && "id" in value && str(value.id) && "enabled" in value && typeof value.enabled === "boolean" &&
    "archived" in value && typeof value.archived === "boolean" && "nextAt" in value && (value.nextAt === null || str(value.nextAt)) && "createdAt" in value && str(value.createdAt);
}
export function isRun(value: unknown): value is ScheduleRun {
  return object(value) && str(value.id) && str(value.planId) && str(value.name) && str(value.deviceId) && str(value.path) && str(value.scheduledAt) &&
    (value.trigger === "timer" || value.trigger === "manual") && ["dispatching", "creating", "running", "waiting", "completed", "failed", "cancelled", "timed_out", "unknown", "abandoned", "missed", "skipped"].includes(String(value.state)) &&
    (value.session === null || isCreatedSession(value.session)) && (value.file === null || str(value.file)) && str(value.message) && str(value.updatedAt) && typeof value.nodeRevision === "number" && Number.isInteger(value.nodeRevision) && (value.replyId === undefined || value.replyId === null || str(value.replyId)) && (value.model === undefined || isModelRef(value.model));
}
