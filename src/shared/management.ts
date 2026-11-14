import { isCompletionNotice, type CompletionNotice } from "./notifications.ts";
import { object } from "./protocol.ts";
import { isModelOption, type ModelOption } from "./models.ts";
import { isCreation, type CreationRecord } from "./session-creation.ts";
import { isTaskRecord, type TaskRecord } from "./tasks.ts";

export type SessionTarget = { id: string } | { path: string };
export type SessionState = "history" | "idle" | "loading" | "running" | "waiting";
export interface ManagedSession { target: SessionTarget; file: string | null; title: string; cwd: string; modified: string; state: SessionState }
export interface HistoryEntry { path: string; title: string; cwd: string; modified: string }
export interface HistoryCommand { type: "history"; id: string }
export interface CancelHistory { type: "cancelHistory"; id: string }
export type HistoryReply = { type: "historyResult"; id: string; ok: true; entries: HistoryEntry[] } | { type: "historyResult"; id: string; ok: false; error: string };
export interface Choice { label: string; value: string }
export interface CommandTarget { action: string; kind: string; target: string; reason: string }
interface InteractionBase { id: string; sessionId: string; title: string; deadline: number | null }
export type Interaction = InteractionBase & (
  | { kind: "choice"; options: Choice[] }
  | { kind: "command"; cwd: string; command: string; targets: CommandTarget[]; options: Choice[] }
  | { kind: "confirm"; message: string }
  | { kind: "input" | "secret"; initial: string; placeholder: string }
  | { kind: "editor"; initial: string }
);
export type ManagementState = { state: "connecting" } | { state: "error"; message: string } |
  { state: "ready"; models: ModelOption[]; workspaces: string[]; sessions: ManagedSession[]; interactions: Interaction[]; creations: CreationRecord[]; tasks: TaskRecord[]; notifications: CompletionNotice[]; issues: string[] };
export interface RespondCommand { type: "respond"; id: string; sessionId: string; dialogId: string; value: string | null }
export type RespondReply = { type: "responded"; id: string; ok: true } | { type: "responded"; id: string; ok: false; error: string };
export interface ManagementMessage { type: "management"; value: ManagementState }
const string = (value: unknown): value is string => typeof value === "string";
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(string);
export function isTarget(value: unknown): value is SessionTarget {
  return object(value) && (string(value.id) && value.path === undefined || string(value.path) && value.id === undefined);
}
export function isSession(value: unknown): value is ManagedSession {
  return object(value) && isTarget(value.target) && (string(value.file) || value.file === null) && string(value.title) && string(value.cwd) && string(value.modified) &&
    ["history", "idle", "loading", "running", "waiting"].includes(String(value.state));
}
function isChoice(value: unknown): value is Choice { return object(value) && string(value.label) && string(value.value); }
function isCommandTarget(value: unknown): value is CommandTarget {
  return object(value) && string(value.action) && string(value.kind) && string(value.target) && string(value.reason);
}
export function isInteraction(value: unknown): value is Interaction {
  if (!object(value) || !string(value.id) || !string(value.sessionId) || !string(value.title) || !(value.deadline === null || typeof value.deadline === "number" && Number.isFinite(value.deadline))) return false;
  switch (value.kind) {
    case "choice": return Array.isArray(value.options) && value.options.every(isChoice);
    case "command": return string(value.cwd) && string(value.command) && Array.isArray(value.targets) && value.targets.every(isCommandTarget) && Array.isArray(value.options) && value.options.every(isChoice);
    case "confirm": return string(value.message);
    case "input": case "secret": return string(value.initial) && string(value.placeholder);
    case "editor": return string(value.initial);
    default: return false;
  }
}
export function isManagement(value: unknown): value is ManagementState {
  return object(value) && (value.state === "connecting" || value.state === "error" && string(value.message) ||
    value.state === "ready" && Array.isArray(value.models) && value.models.every(isModelOption) && strings(value.workspaces) && Array.isArray(value.sessions) && value.sessions.every(isSession) &&
    Array.isArray(value.interactions) && value.interactions.every(isInteraction) && Array.isArray(value.creations) && value.creations.every(isCreation) && Array.isArray(value.tasks) && value.tasks.every(isTaskRecord) && Array.isArray(value.notifications) && value.notifications.length <= 100 && value.notifications.every(isCompletionNotice) && strings(value.issues));
}
export function isManagementMessage(value: unknown): value is ManagementMessage { return object(value) && value.type === "management" && isManagement(value.value); }
export function isRespond(value: unknown): value is RespondCommand {
  return object(value) && value.type === "respond" && string(value.id) && string(value.sessionId) && string(value.dialogId) && (string(value.value) || value.value === null);
}
export function isHistoryEntry(value: unknown): value is HistoryEntry {
  return object(value) && string(value.path) && string(value.title) && string(value.cwd) && string(value.modified);
}
export function isHistoryCommand(value: unknown): value is HistoryCommand { return object(value) && value.type === "history" && string(value.id); }
export function isCancelHistory(value: unknown): value is CancelHistory { return object(value) && value.type === "cancelHistory" && string(value.id); }
export function isHistoryReply(value: unknown): value is HistoryReply {
  return object(value) && value.type === "historyResult" && string(value.id) &&
    (value.ok === true && Array.isArray(value.entries) && value.entries.every(isHistoryEntry) || value.ok === false && string(value.error));
}
export function isRespondReply(value: unknown): value is RespondReply {
  return object(value) && value.type === "responded" && string(value.id) && (value.ok === true || value.ok === false && string(value.error));
}
