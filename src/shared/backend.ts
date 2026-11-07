import { object } from "./protocol.ts";

export type BackendPhase = { state: "starting" | "stopping" | "stopped" } |
  { state: "running"; pid: number; url: string } | { state: "error"; message: string };
export type BackendStatus = BackendPhase & { generation: number; logs: string };
export interface NodeReport { type: "status"; ready: boolean; hostname: string; platform: string; backend: BackendStatus }
export function isReport(value: unknown): value is NodeReport {
  return object(value) && value.type === "status" && typeof value.ready === "boolean" && typeof value.hostname === "string" && value.hostname.length < 256 &&
    typeof value.platform === "string" && value.platform.length < 64 && isBackendStatus(value.backend);
}
export interface RestartBackend { type: "restartBackend"; id: string; generation: number }
export type BackendReply = { type: "backendRestartAccepted"; id: string; ok: true } |
  { type: "backendRestartAccepted"; id: string; ok: false; error: string };
export function isBackendStatus(value: unknown): value is BackendStatus {
  if (!object(value) || typeof value.logs !== "string" || value.logs.length > 16384 || typeof value.generation !== "number" || !Number.isSafeInteger(value.generation) || value.generation < 0) return false;
  if (value.state === "starting" || value.state === "stopping" || value.state === "stopped") return true;
  if (value.state === "error") return typeof value.message === "string";
  return value.state === "running" && typeof value.pid === "number" && Number.isSafeInteger(value.pid) && value.pid > 0 && typeof value.url === "string" && /^http:\/\/127\.0\.0\.1:\d+$/.test(value.url);
}
export function isRestartBackend(value: unknown): value is RestartBackend { return object(value) && value.type === "restartBackend" && typeof value.id === "string" && typeof value.generation === "number" && Number.isSafeInteger(value.generation) && value.generation >= 0; }
export function isBackendReply(value: unknown): value is BackendReply {
  return object(value) && value.type === "backendRestartAccepted" && typeof value.id === "string" && (value.ok === true || value.ok === false && typeof value.error === "string");
}
