import path from "node:path";
import { homedir } from "node:os";
import { object } from "../shared/protocol.ts";

export interface NodeConfig { hub: string; token: string; command: [string, ...string[]]; cwd: string }
export function validateNodeConfig(value: unknown): NodeConfig {
  if (!object(value)) throw new Error("无效的节点配置");
  const unsupported = Object.keys(value).filter((key) => !["hub", "token", "command", "cwd"].includes(key));
  if (unsupported.length) throw new Error(`不支持的节点配置字段：${unsupported.join(", ")}。仅支持托管后端，不接受 target。`);
  if (typeof value.hub !== "string" || typeof value.token !== "string" || !Array.isArray(value.command) || !value.command.every((part): part is string => typeof part === "string" && part.length > 0 && !part.includes("\0"))) throw new Error("节点配置需要 hub、token 和非空 command 数组");
  const [executable, ...args] = value.command;
  if (!executable) throw new Error("command 需要包含 opi-web 程序路径");
  const hub = new URL(value.hub);
  if (!["http:", "https:"].includes(hub.protocol) || hub.username || hub.password || hub.pathname !== "/" || hub.search || hub.hash) throw new Error("hub 必须是无路径、查询参数和凭据的 HTTP(S) URL");
  if (!/^[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/.test(value.token)) throw new Error("无效的设备凭据");
  if (value.cwd !== undefined && (typeof value.cwd !== "string" || !value.cwd || value.cwd.includes("\0"))) throw new Error("cwd 需要是已有目录路径");
  const command: [string, ...string[]] = [executable.includes("/") || executable.includes("\\") ? path.resolve(executable) : executable, ...args];
  return { hub: hub.origin, token: value.token, command, cwd: value.cwd === undefined ? homedir() : path.resolve(value.cwd) };
}
