import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { FullConfig } from "@playwright/test";

/** 使用 IPC 收尾，避免 Windows 强制结束 webServer 后遗留原生子进程和临时配置。 */
export default async function setup(config: FullConfig): Promise<() => Promise<void>> {
  const fixture: unknown = config.metadata.fixture;
  if (fixture !== "browser-server.ts" && fixture !== "native-server.ts") throw new Error("无效的测试宿主");
  const child = fork(fileURLToPath(new URL(fixture, import.meta.url)), [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`测试宿主启动超时：${output}`)); }, 45_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`测试宿主退出 ${code}：${output}`)); });
    child.once("message", () => { clearTimeout(timer); resolve(); });
  });
  return async () => {
    if (child.exitCode !== null) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error(`测试宿主关闭超时：${output}`)); }, 15_000);
      child.once("exit", (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`测试宿主关闭失败 ${code}：${output}`)); });
      child.send("stop");
    });
  };
}
