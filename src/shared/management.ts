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
export type ApprovalStage = { kind: "choose" } | { kind: "instruction"; token: string };
interface CommandApproval { kind: "command"; cwd: string; command: string; targets: CommandTarget[]; options: Choice[] }
export type Interaction = InteractionBase & (
  | { kind: "nativeApproval"; message: string }
  | { kind: "choice"; options: Choice[] }
  | { kind: "tool"; options: Choice[]; stage: ApprovalStage }
  | (CommandApproval & ({ shell?: undefined; stage?: undefined } |
      { shell: "bash" | "powershell"; stage: ApprovalStage }))
  | { kind: "confirm"; message: string }
  | { kind: "input" | "secret"; initial: string; placeholder: string }
  | { kind: "editor"; initial: string }
);
export type ManagementState = { state: "connecting" } | { state: "error"; message: string } |
  { state: "ready"; models: ModelOption[]; workspaces: string[]; sessions: ManagedSession[]; interactions: Interaction[]; creations: CreationRecord[]; tasks: TaskRecord[]; notifications: CompletionNotice[]; issues: string[] };
export interface InteractionAnswer { sessionId: string; dialogId: string; value: string | null; token?: string }
export interface RespondCommand extends InteractionAnswer { type: "respond"; id: string }
export function matchesDialog(dialog: Interaction, answer: InteractionAnswer): boolean {
  return dialog.id === answer.dialogId && dialog.sessionId === answer.sessionId;
}
/** 阶段令牌只随用户看到的表单提交，不能用当前令牌补全旧回答。 */
export function responseInStage(dialog: Interaction, answer: InteractionAnswer): boolean {
  if (dialog.kind === "nativeApproval") return false;
  const stage = "stage" in dialog ? dialog.stage : undefined;
  return answer.token === (stage?.kind === "instruction" ? stage.token : undefined);
}
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
function isApprovalStage(value: unknown): value is ApprovalStage {
  return object(value) && (value.kind === "choose" || value.kind === "instruction" && string(value.token) && value.token.length > 0);
}
export function isInteraction(value: unknown): value is Interaction {
  if (!object(value) || !string(value.id) || !string(value.sessionId) || !string(value.title) || !(value.deadline === null || typeof value.deadline === "number" && Number.isFinite(value.deadline))) return false;
  switch (value.kind) {
    case "choice": return Array.isArray(value.options) && value.options.every(isChoice);
    case "tool": return isApprovalStage(value.stage) && Array.isArray(value.options) && value.options.every(isChoice);
    case "command": return string(value.cwd) && string(value.command) && Array.isArray(value.targets) && value.targets.every(isCommandTarget) &&
      Array.isArray(value.options) && value.options.every(isChoice) &&
      (value.shell === undefined && value.stage === undefined || (value.shell === "bash" || value.shell === "powershell") && isApprovalStage(value.stage));
    case "confirm": case "nativeApproval": return string(value.message);
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
export function isInteractionAnswer(value: unknown): value is InteractionAnswer {
  return object(value) && string(value.sessionId) && string(value.dialogId) && (string(value.value) || value.value === null) &&
    (value.token === undefined || string(value.token));
}
export function isRespond(value: unknown): value is RespondCommand {
  return object(value) && value.type === "respond" && string(value.id) && isInteractionAnswer(value);
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
