import { object } from "../../shared/protocol.ts";
import { isInteraction, type Interaction } from "../../shared/management.ts";

export interface History { path: string; cwd: string; title: string; modified: string }
export interface Activity extends Omit<History, "path"> { sessionId: string; path: string | null; state: "idle" | "loading" | "running" | "waiting" }
export interface Selected { id: string; cwd: string; path: string | null }
export interface Workspace { path: string }
export type DirectoryPatch<T = History> = ({ from: number; count: number } | { values: T[] })[];
export type OpiEvent = { type: "client"; id: string } | { type: "selected"; session: Selected | null } |
  { type: "sessions"; value: History[] } | { type: "sessionsPatch"; value: DirectoryPatch } |
  { type: "workspaces"; value: Workspace[] } | { type: "workspacesPatch"; value: DirectoryPatch<Workspace> } |
  { type: "activity"; value: Activity[] } | { type: "dialogs"; value: unknown[] } |
  { type: "feedback"; message: string; tone: string } | { type: "sessionsDeleted"; ids: string[] };
const str = (value: unknown): value is string => typeof value === "string";
function history(value: unknown): value is History {
  return object(value) && str(value.path) && str(value.cwd) && str(value.title) && str(value.modified);
}
function selected(value: unknown): value is Selected {
  return object(value) && str(value.id) && str(value.cwd) && (str(value.path) || value.path === null);
}
function activity(value: unknown): value is Activity {
  return object(value) && str(value.sessionId) && (str(value.path) || value.path === null) && str(value.cwd) && str(value.title) && str(value.modified) &&
    ["idle", "loading", "running", "waiting"].includes(String(value.state));
}
function workspace(value: unknown): value is Workspace { return object(value) && str(value.path); }
function patch<T>(value: unknown, check: (value: unknown) => value is T): value is DirectoryPatch<T> {
  return Array.isArray(value) && value.every((part) => object(part) &&
    (Array.isArray(part.values) && part.values.every(check) || Number.isInteger(part.from) && Number.isInteger(part.count) && Number(part.from) >= 0 && Number(part.count) >= 0));
}
export interface OpiFrame {
  id: number; events: unknown[];
  ack: { kind: "ack"; id: number } | { ack: number };
  catalog: { action: "sessions"; all: true } | { action: "sessions" };
}
export function decodeFrame(value: unknown): OpiFrame | undefined {
  if (!object(value)) throw new Error("o-pi 传输帧格式不匹配");
  if (value.kind === "notification") return undefined;
  // 当前源码有 kind，已发布的本机二进制使用 {id, events}；只接受这两种已验证封装。
  if ((value.kind === "frame" || value.kind === undefined) && typeof value.id === "number" && Number.isSafeInteger(value.id) && Array.isArray(value.events)) return {
    id: value.id, events: value.events,
    ack: value.kind === "frame" ? { kind: "ack", id: value.id } : { ack: value.id },
    catalog: value.kind === "frame" ? { action: "sessions", all: true } : { action: "sessions" },
  };
  throw new Error(`o-pi 传输帧格式不匹配: kind=${String(value.kind)}, fields=${Object.keys(value).join(",")}`);
}
export function decodeEvent(value: unknown): OpiEvent | undefined {
  if (!object(value) || !str(value.type)) throw new Error("o-pi 事件格式不匹配");
  switch (value.type) {
    case "client": if (str(value.id)) return { type: "client", id: value.id }; break;
    case "selected": if (value.session === null || selected(value.session)) return { type: "selected", session: value.session }; break;
    case "sessions": if (Array.isArray(value.value) && value.value.every(history)) return { type: "sessions", value: value.value }; break;
    case "sessionsPatch": if (patch(value.value, history)) return { type: "sessionsPatch", value: value.value }; break;
    case "workspaces": if (Array.isArray(value.value) && value.value.every(workspace)) return { type: "workspaces", value: value.value }; break;
    case "workspacesPatch": if (patch(value.value, workspace)) return { type: "workspacesPatch", value: value.value }; break;
    case "sessionsDeleted": if (Array.isArray(value.ids) && value.ids.every(str)) return { type: "sessionsDeleted", ids: value.ids }; break;
    case "activity": if (Array.isArray(value.value) && value.value.every(activity)) return { type: "activity", value: value.value }; break;
    case "dialogs": if (Array.isArray(value.value)) return { type: "dialogs", value: value.value }; break;
    case "feedback": if (str(value.message) && str(value.tone)) return { type: "feedback", message: value.message, tone: value.tone }; break;
    // 聊天正文、快照和呈现配置不属于管理层，只确认传输帧，不保存这些事件。
    default: return undefined;
  }
  throw new Error(`o-pi ${value.type} 事件格式不匹配`);
}
export function applyDirectory<T>(before: T[] | undefined, parts: DirectoryPatch<T>): T[] {
  if (!before) throw new Error("o-pi 目录增量缺少初始状态");
  return parts.flatMap((part) => {
    if ("values" in part) return part.values;
    if (part.from + part.count > before.length) throw new Error("o-pi 目录增量越界");
    return before.slice(part.from, part.from + part.count);
  });
}
export function decodeDialog(raw: unknown, sessionId: string): Interaction {
  if (!object(raw)) throw new Error("o-pi 对话框格式不匹配");
  const base = { id: raw.id, title: raw.title, deadline: raw.deadline, sessionId };
  let value: unknown;
  switch (raw.kind) {
    case "select": value = { ...base, kind: "choice", options: raw.options }; break;
    case "bashApproval":
      if (!object(raw.approval)) throw new Error("o-pi 命令审批格式不匹配");
      value = { ...base, kind: "command", cwd: raw.approval.cwd, command: raw.approval.command, targets: raw.approval.items, options: raw.options };
      break;
    case "confirm": value = { ...base, kind: "confirm", message: raw.message }; break;
    case "input": case "secret": value = { ...base, kind: raw.kind, initial: raw.initial, placeholder: raw.placeholder }; break;
    case "editor": value = { ...base, kind: "editor", initial: raw.initial }; break;
    default: throw new Error("o-pi 对话框类型不匹配");
  }
  if (!isInteraction(value)) throw new Error("o-pi 对话框类型或字段不匹配");
  return value;
}
