import { object } from "./protocol.ts";

export interface DirectoryListing { path: string; parent: string; children: { name: string; path: string }[] }
export interface CreatedSession { id: string; cwd: string; path: string | null }
interface CreationBase { id: string; path: string; startedAt: string }
export type CreationRecord = CreationBase & (
  | { state: "creating"; phase: "checking" | "workspace" | "new" }
  | { state: "ready"; session: CreatedSession }
  | { state: "error"; error: string; session: CreatedSession | null }
);
export type SessionCommand = { type: "directories"; id: string; path: string } |
  { type: "createSession"; id: string; creationId: string; path: string };
export type DirectoryResponse = { type: "directoryResult"; id: string } & ({ ok: true; listing: DirectoryListing } | { ok: false; error: string });
export type CreationResponse = { type: "creationAccepted"; id: string } & ({ ok: true } | { ok: false; error: string });
export type SessionResponse = DirectoryResponse | CreationResponse;
const str = (value: unknown): value is string => typeof value === "string";
export function isDirectoryListing(value: unknown): value is DirectoryListing {
  return object(value) && str(value.path) && str(value.parent) && Array.isArray(value.children) &&
    value.children.every((item) => object(item) && str(item.name) && str(item.path));
}
export function isCreatedSession(value: unknown): value is CreatedSession {
  return object(value) && str(value.id) && str(value.cwd) && (str(value.path) || value.path === null);
}
export function isCreation(value: unknown): value is CreationRecord {
  return object(value) && str(value.id) && str(value.path) && str(value.startedAt) &&
    (value.state === "creating" && ["checking", "workspace", "new"].includes(String(value.phase)) ||
    value.state === "ready" && isCreatedSession(value.session) || value.state === "error" && str(value.error) && (value.session === null || isCreatedSession(value.session)));
}
export function isSessionCommand(value: unknown): value is SessionCommand {
  return object(value) && str(value.id) && str(value.path) && value.path.length <= 4096 && !value.path.includes("\0") &&
    (value.type === "directories" || value.type === "createSession" && str(value.creationId));
}
export function isCancelDirectories(value: unknown): value is { type: "cancelDirectories"; id: string } { return object(value) && value.type === "cancelDirectories" && str(value.id); }
export function isSessionResponse(value: unknown): value is SessionResponse {
  return object(value) && str(value.id) && (value.type === "directoryResult" || value.type === "creationAccepted") &&
    (value.ok === false && str(value.error) || value.ok === true && (value.type === "creationAccepted" || isDirectoryListing(value.listing)));
}
export function isAbsoluteDirectory(path: string): boolean {
  return path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\");
}
