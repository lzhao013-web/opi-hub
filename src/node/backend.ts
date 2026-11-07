import { spawn } from "node:child_process";
import type { BackendPhase, BackendStatus } from "../shared/backend.ts";
import { stopOwnedProcess, type OwnedProcess } from "./process-tree.ts";

export interface BackendConfig { command: [string, ...string[]]; cwd: string }
interface Child extends OwnedProcess { stopping: boolean }
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
export class ManagedBackend {
  private config: BackendConfig;
  private changed: () => void;
  private child: Child | undefined;
  private operation: Promise<void> | undefined;
  private shutdown = new AbortController();
  private tail = "";
  private value: BackendPhase = { state: "stopped" };
  private generation = 0;
  constructor(config: BackendConfig, changed: () => void) { this.config = config; this.changed = changed; }
  get status(): BackendStatus { return { ...this.value, generation: this.generation, logs: this.tail }; }
  restart(): void {
    if (this.shutdown.signal.aborted) throw new Error("节点正在关闭");
    if (this.operation) throw new Error("后端正在启动或重启，请等待状态更新");
    this.generation++;
    this.set(this.child && !this.child.exited ? { state: "stopping" } : { state: "starting" });
    this.operation = this.replace().catch((error: unknown) => {
      if (!this.shutdown.signal.aborted) this.set({ state: "error", message: message(error) });
    }).finally(() => { this.operation = undefined; });
  }
  private set(value: BackendPhase): void { this.value = value; this.changed(); }
  private async stopChild(): Promise<void> {
    const child = this.child;
    if (!child) return;
    child.stopping = true;
    await stopOwnedProcess(child);
    if (this.child === child) this.child = undefined;
  }
  private async replace(): Promise<void> {
    await this.stopChild();
    if (this.shutdown.signal.aborted) return;
    this.tail = ""; this.set({ state: "starting" });
    const [executable, ...prefix] = this.config.command;
    const processChild = spawn(executable, [...prefix, "--host", "127.0.0.1", "--port", "0", "--cwd", this.config.cwd], {
      cwd: this.config.cwd, shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = Promise.withResolvers<void>(); const announced = Promise.withResolvers<string>();
    const child: Child = { process: processChild, stopping: false, exited: false, exit: exited.promise }; this.child = child;
    const timer = setTimeout(() => announced.reject(new Error("opi-web 启动超时，30 秒内未报告有效监听地址")), 30_000);
    const abort = () => announced.reject(new Error("后端启动已取消"));
    this.shutdown.signal.addEventListener("abort", abort, { once: true });
    const append = (text: string) => { this.tail = [...this.tail + text].slice(-4096).join(""); };
    let line = "";
    processChild.stdout.setEncoding("utf8"); processChild.stderr.setEncoding("utf8");
    processChild.stdout.on("data", (text: string) => {
      append(text); line += text;
      const lines = line.split(/\r?\n/); line = lines.pop() ?? "";
      if (line.length > 65536) line = "";
      for (const value of lines) if (value.startsWith("opi-web: ")) {
        try {
          const url = new URL(value.slice("opi-web: ".length).trim());
          if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || Number(url.port) < 1 || url.pathname !== "/" || url.search || url.hash || url.username || url.password) throw new Error("opi-web 必须监听节点分配的回环 HTTP 地址");
          announced.resolve(url.origin);
        } catch (error) { announced.reject(error); }
      }
    });
    processChild.stderr.on("data", append);
    processChild.once("error", (error) => { child.exited = true; exited.resolve(); announced.reject(error); });
    processChild.once("exit", (code, signal) => {
      child.exited = true; exited.resolve();
      const error = new Error(`托管 opi-web 已退出 (${signal ?? code ?? "unknown"})`); announced.reject(error);
      if (!child.stopping && !this.shutdown.signal.aborted && this.child === child && this.value.state === "running") this.set({ state: "error", message: error.message });
    });
    try {
      const url = await announced.promise;
      clearTimeout(timer); this.shutdown.signal.removeEventListener("abort", abort);
      const response = await fetch(new URL("/health", url), { signal: AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(5000)]), redirect: "error" });
      await response.body?.cancel();
      if (!response.ok || child.exited || processChild.pid === undefined) throw new Error("opi-web 未能通过启动健康检查");
      this.set({ state: "running", pid: processChild.pid, url });
    } catch (error) {
      try { await this.stopChild(); }
      catch (cleanup) { throw new Error(`${message(error)}\n清理失败: ${message(cleanup)}`); }
      throw error;
    } finally { clearTimeout(timer); this.shutdown.signal.removeEventListener("abort", abort); }
  }
  async close(): Promise<void> {
    this.shutdown.abort();
    await this.operation; await this.stopChild();
    this.set({ state: "stopped" });
  }
}
