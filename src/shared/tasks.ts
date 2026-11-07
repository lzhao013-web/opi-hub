import { object } from "./protocol.ts";
import { isAbsoluteDirectory, isCreatedSession, type CreatedSession } from "./session-creation.ts";

export interface TaskInput { id: string; name: string; path: string; prompt: string; timeoutSeconds: number }
export type TaskState = "creating" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "timed_out" | "unknown" | "abandoned";
export interface TaskRecord {
  id: string; name: string; path: string; state: TaskState; session: CreatedSession | null; file: string | null;
  startedAt: string; updatedAt: string; revision: number; message: string;
}
export type TaskCommand = { type: "startTask"; id: string; task: TaskInput } |
  { type: "cancelTask" | "acknowledgeTask"; id: string; runId: string };
export type TaskReply = { type: "taskAccepted" | "taskCancelled" | "taskAcknowledged"; id: string } & ({ ok: true } | { ok: false; error: string });
const str = (value: unknown): value is string => typeof value === "string";
export const blockingTask = (state: string): boolean => ["dispatching", "creating", "running", "waiting", "unknown"].includes(state);
export const executingTask = (state: string): boolean => ["creating", "running", "waiting"].includes(state);
export function isTaskInput(value: unknown): value is TaskInput {
  return object(value) && str(value.id) && value.id.length <= 128 && str(value.name) && value.name.trim().length > 0 && value.name.length <= 80 &&
    str(value.path) && value.path.length <= 4096 && !value.path.includes("\0") && isAbsoluteDirectory(value.path) &&
    str(value.prompt) && value.prompt.trim().length > 0 && value.prompt.length <= 16384 && !/^[!/]/.test(value.prompt.trimStart()) &&
    typeof value.timeoutSeconds === "number" && Number.isInteger(value.timeoutSeconds) && value.timeoutSeconds >= 1 && value.timeoutSeconds <= 10800;
}
export function isTaskRecord(value: unknown): value is TaskRecord {
  return object(value) && str(value.id) && str(value.name) && str(value.path) &&
    ["creating", "running", "waiting", "completed", "failed", "cancelled", "timed_out", "unknown", "abandoned"].includes(String(value.state)) &&
    (value.session === null || isCreatedSession(value.session)) && (str(value.file) || value.file === null) && str(value.startedAt) && str(value.updatedAt) &&
    typeof value.revision === "number" && Number.isSafeInteger(value.revision) && value.revision >= 0 && str(value.message);
}
export function isTaskCommand(value: unknown): value is TaskCommand {
  return object(value) && str(value.id) && (value.type === "startTask" && isTaskInput(value.task) ||
    (value.type === "cancelTask" || value.type === "acknowledgeTask") && str(value.runId));
}
export function isTaskReply(value: unknown): value is TaskReply {
  return object(value) && ["taskAccepted", "taskCancelled", "taskAcknowledged"].includes(String(value.type)) && str(value.id) &&
    (value.ok === true || value.ok === false && str(value.error));
}
