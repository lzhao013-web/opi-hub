import { execFile } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { object } from "../shared/protocol.ts";

export interface OwnedProcess { process: ChildProcess; exited: boolean; exit: Promise<void> }
async function waitExit(child: OwnedProcess, milliseconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([child.exit.then(() => true), new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
async function signal(child: OwnedProcess, force: boolean): Promise<boolean> {
  const pid = child.process.pid;
  if (child.exited || pid === undefined) return true;
  if (process.platform === "win32") {
    return new Promise<boolean>((resolve) => execFile("taskkill.exe", ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])], { windowsHide: true }, (error) => resolve(!error || child.exited)));
  }
  try { process.kill(-pid, force ? "SIGKILL" : "SIGTERM"); return true; }
  catch (error) { if (object(error) && error.code === "ESRCH") return true; throw error; }
}
/** 只向本次 spawn 的 PID/独立进程组发送信号，从不按进程名或端口清理。 */
export async function stopOwnedProcess(child: OwnedProcess): Promise<void> {
  if (child.exited) return;
  if (child.process.pid === undefined) { await child.exit; return; }
  const graceful = await signal(child, false);
  if (graceful && await waitExit(child, 5000)) return;
  if (!await signal(child, true) || !await waitExit(child, 5000)) throw new Error(`无法终止托管后端 PID ${child.process.pid}`);
}
