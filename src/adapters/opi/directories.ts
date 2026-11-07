import { isDirectoryListing, type DirectoryListing } from "../../shared/session-creation.ts";
import { OpiClient } from "./client.ts";

export async function queryDirectories(client: OpiClient, path: string, signal: AbortSignal): Promise<DirectoryListing> {
  const value = await client.query({ query: "directories", path }, signal);
  if (!isDirectoryListing(value)) throw new Error("o-pi 目录查询格式不匹配");
  return { path: value.path, parent: value.parent, children: value.children.map(({ name, path }) => ({ name, path })) };
}
export async function listDirectories(target: URL, path: string, signal: AbortSignal): Promise<DirectoryListing> {
  signal.throwIfAborted();
  const client = new OpiClient(target, () => {}, "hub-directory-query");
  const close = () => client.close(); signal.addEventListener("abort", close, { once: true });
  try { return await queryDirectories(client, path, signal); }
  finally { signal.removeEventListener("abort", close); client.close(); }
}
