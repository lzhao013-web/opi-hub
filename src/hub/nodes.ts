import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { json, MAX_FRAME, parse, type OpenRequest } from "../shared/protocol.ts";
import { isReport, isBackendReply, type NodeReport } from "../shared/backend.ts";
import { isManagementMessage, isRespondReply, isHistoryReply, type HistoryEntry, type HistoryCommand, type CancelHistory, type ManagementState, type RespondCommand } from "../shared/management.ts";
import { buffer } from "../shared/sockets.ts";
import { isSessionResponse } from "../shared/session-creation.ts";
import { SessionRequests } from "./session-requests.ts";
import { isTaskReply, blockingTask, type TaskInput, type TaskRecord } from "../shared/tasks.ts";

interface Connection { id: string; socket: WebSocket; report?: NodeReport; management?: ManagementState; seen: number }
interface HistoryPending { node: Connection; deviceId: string; finish: (result: HistoryEntry[] | Error) => void }
interface ResponsePending { node: Connection; deviceId: string; finish: (error?: Error) => void }
interface Pending { node: Connection; deviceId: string; resolve: (ws: WebSocket) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
export class Nodes {
  private connections = new Map<string, Connection>();
  private pending = new Map<string, Pending>();
  private streams = new Map<string, Set<WebSocket>>();
  private responses = new Map<string, ResponsePending>();
  private histories = new Map<string, HistoryPending>();
  private answering = new Set<string>();
  private sessionRequests = new SessionRequests();
  private timer = setInterval(() => this.heartbeat(), 15_000);
  private onManagement: (deviceId: string, state: ManagementState) => void;
  constructor(onManagement: (deviceId: string, state: ManagementState) => void) { this.onManagement = onManagement; this.timer.unref(); }
  status(id: string): { connected: false } | { connected: true; connectionId: string; report?: NodeReport } {
    const node = this.connections.get(id);
    return node ? { connected: true, connectionId: this.identity(node), report: node.report } : { connected: false };
  }
  private identity(node: Connection): string { return `${node.id}:${node.report?.backend.generation ?? 0}`; }
  management(id: string): ManagementState | undefined { return this.connections.get(id)?.management; }
  async respond(deviceId: string, sessionId: string, dialogId: string, value: string | null, signal: AbortSignal): Promise<void> {
    const node = this.connections.get(deviceId);
    if (!node || signal.aborted) throw new Error("设备离线或请求已取消");
    if (node.management?.state !== "ready" || !node.management.interactions.some((item) => item.sessionId === sessionId && item.id === dialogId)) throw new Error("交互已结束或状态未就绪，请刷新");
    const key = JSON.stringify([deviceId, sessionId, dialogId]);
    if (this.answering.has(key)) throw new Error("此交互正在提交，请等待结果");
    const id = randomUUID();
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        if (!this.responses.delete(id)) return;
        clearTimeout(timer); signal.removeEventListener("abort", abort); this.answering.delete(key);
        if (error) reject(error); else resolve();
      };
      const abort = () => finish(new Error("连接中断，请检查交互是否已处理后再决定是否重试"));
      const timer = setTimeout(() => finish(new Error("交互提交超时，请检查原会话状态，不要自动重试")), 30_000);
      this.answering.add(key); this.responses.set(id, { node, deviceId, finish });
      signal.addEventListener("abort", abort, { once: true });
      void json(node.socket, { type: "respond", id, sessionId, dialogId, value } satisfies RespondCommand).catch((error: unknown) => finish(error instanceof Error ? error : new Error("提交失败")));
    });
  }
  async history(deviceId: string, signal: AbortSignal): Promise<{ connectionId: string; entries: HistoryEntry[] }> {
    const node = this.connections.get(deviceId);
    if (!node || node.management?.state !== "ready") throw new Error("设备会话管理尚未连接");
    signal.throwIfAborted();
    if ([...this.histories.values()].some((pending) => pending.deviceId === deviceId)) throw new Error("此设备的历史正在读取，请稍后重试");
    const id = randomUUID(); const connectionId = this.identity(node);
    return new Promise<{ connectionId: string; entries: HistoryEntry[] }>((resolve, reject) => {
      const cancel = () => { if (node.socket.readyState === WebSocket.OPEN) void json(node.socket, { type: "cancelHistory", id } satisfies CancelHistory).catch(() => node.socket.terminate()); };
      const finish = (result: HistoryEntry[] | Error) => {
        if (!this.histories.delete(id)) return;
        clearTimeout(timer); signal.removeEventListener("abort", abort);
        if (result instanceof Error) { cancel(); reject(result); }
        else if (connectionId !== this.identity(node)) reject(new Error("后端已变化，历史查询结果已失效"));
        else resolve({ connectionId, entries: result });
      };
      const abort = () => finish(new Error("历史查询已取消"));
      const timer = setTimeout(() => finish(new Error("历史查询超时")), 35_000);
      this.histories.set(id, { node, deviceId, finish }); signal.addEventListener("abort", abort, { once: true });
      void json(node.socket, { type: "history", id } satisfies HistoryCommand).catch((error: unknown) => finish(error instanceof Error ? error : new Error("历史查询失败")));
    });
  }
  private sessionConnection(deviceId: string): Connection {
    const node = this.connections.get(deviceId);
    if (!node || node.management?.state !== "ready" || !node.report?.ready || node.report.backend.state !== "running") throw new Error("托管后端的会话管理尚未就绪");
    return node;
  }
  async directories(deviceId: string, path: string, signal: AbortSignal) {
    const node = this.sessionConnection(deviceId);
    const connectionId = this.identity(node);
    const listing = await this.sessionRequests.directories(deviceId, node.socket, path, signal);
    if (connectionId !== this.identity(node)) throw new Error("后端已变化，目录查询结果已失效");
    return { ...listing, connectionId };
  }
  create(deviceId: string, creationId: string, path: string, signal: AbortSignal) { return this.sessionRequests.create(deviceId, this.sessionConnection(deviceId).socket, creationId, path, signal); }
  restartBackend(deviceId: string, connectionId: string, signal: AbortSignal): Promise<void> {
    const node = this.connections.get(deviceId);
    if (!node?.report) return Promise.reject(new Error("设备已离线或尚未报告状态"));
    if (connectionId !== this.identity(node)) return Promise.reject(new Error("设备或后端已变化，请刷新后重新确认"));
    return this.sessionRequests.restart(deviceId, node.socket, node.report.backend.generation, signal);
  }
  task(id: string, runId: string): TaskRecord | undefined { const state = this.management(id); return state?.state === "ready" ? state.tasks.find((task) => task.id === runId) : undefined; }
  taskOnline(id: string): boolean { const node = this.connections.get(id); return !!node?.report?.ready && node.report.backend.state === "running" && node.management?.state === "ready"; }
  taskAvailability(id: string): string | null {
    const state = this.management(id);
    if (!this.taskOnline(id) || state?.state !== "ready") return "设备离线或托管后端未就绪";
    if (state.tasks.some((task) => blockingTask(task.state)) || state.creations.some((creation) => creation.state === "creating")) return "设备仍有计划运行或会话创建未结束";
    return null;
  }
  startTask(deviceId: string, task: TaskInput, signal: AbortSignal) { return this.sessionRequests.startTask(deviceId, this.sessionConnection(deviceId).socket, task, signal); }
  cancelTask(deviceId: string, runId: string, signal: AbortSignal) { return this.sessionRequests.taskAction(deviceId, this.sessionConnection(deviceId).socket, "cancelTask", runId, signal); }
  acknowledgeTask(deviceId: string, runId: string, signal: AbortSignal) { return this.sessionRequests.taskAction(deviceId, this.sessionConnection(deviceId).socket, "acknowledgeTask", runId, signal); }
  register(id: string, socket: WebSocket): void {
    this.disconnect(id);
    const node: Connection = { id: randomUUID(), socket, seen: Date.now() };
    this.connections.set(id, node);
    socket.on("pong", () => { node.seen = Date.now(); });
    socket.on("message", (raw, binary) => {
      try {
        if (binary || buffer(raw).byteLength > MAX_FRAME) throw new Error("Invalid report");
        const value = parse(raw.toString());
        if (isReport(value)) {
          if (value.backend.state !== "running" || node.report && node.report.backend.generation !== value.backend.generation) {
            this.sessionRequests.invalidateReads(id);
            for (const pending of [...this.histories.values()]) if (pending.deviceId === id) pending.finish(new Error("托管后端已变化，历史查询已取消"));
          }
          node.report = value;
        }
        else if (isManagementMessage(value)) { node.management = value.value; this.onManagement(id, value.value); }
        else if (isSessionResponse(value) || isBackendReply(value) || isTaskReply(value)) this.sessionRequests.receive(node.socket, value);
        else if (isHistoryReply(value)) {
          const pending = this.histories.get(value.id);
          if (pending?.node === node) pending.finish(value.ok ? value.entries : new Error(value.error));
        }
        else if (isRespondReply(value)) {
          const pending = this.responses.get(value.id);
          if (pending?.node === node) pending.finish(value.ok ? undefined : new Error(value.error));
        } else throw new Error("Invalid report");
      } catch { socket.close(1008, "Invalid report"); }
    });
    socket.on("error", () => socket.terminate());
    socket.on("close", () => {
      if (this.connections.get(id) !== node) return;
      this.connections.delete(id);
      this.release(id);
    });
  }
  open(deviceId: string, request: Omit<OpenRequest, "id" | "type">, signal: AbortSignal): Promise<WebSocket> {
    const node = this.connections.get(deviceId);
    if (!node) return Promise.reject(new Error("设备已离线"));
    if (signal.aborted) return Promise.reject(new Error("请求已取消"));
    if (this.pending.size >= 256) return Promise.reject(new Error("等待连接过多"));
    const id = randomUUID();
    return new Promise<WebSocket>((resolve, reject) => {
      const fail = (error: Error) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        signal.removeEventListener("abort", abort);
        reject(error);
      };
      const abort = () => fail(new Error("请求已取消"));
      const timer = setTimeout(() => fail(new Error("设备响应超时")), 10_000);
      this.pending.set(id, {
        deviceId, node, timer, reject: fail,
        resolve: (ws) => { signal.removeEventListener("abort", abort); resolve(ws); },
      });
      signal.addEventListener("abort", abort, { once: true });
      void json(node.socket, { type: "open", id, ...request } satisfies OpenRequest).catch(fail);
    });
  }
  accepts(deviceId: string, id: string): boolean {
    const pending = this.pending.get(id);
    return pending?.deviceId === deviceId && pending.node === this.connections.get(deviceId);
  }
  accept(deviceId: string, id: string, socket: WebSocket): void {
    const pending = this.pending.get(id);
    if (!pending || !this.accepts(deviceId, id)) { socket.close(1008, "Expired stream"); return; }
    this.pending.delete(id);
    clearTimeout(pending.timer);
    let streams = this.streams.get(deviceId);
    if (!streams) { streams = new Set(); this.streams.set(deviceId, streams); }
    streams.add(socket);
    socket.on("error", () => socket.terminate());
    socket.once("close", () => { streams.delete(socket); if (!streams.size) this.streams.delete(deviceId); });
    pending.resolve(socket);
  }
  disconnect(id: string): void {
    const previous = this.connections.get(id);
    this.connections.delete(id);
    previous?.socket.close(4001, "Device disconnected or replaced");
    this.release(id);
  }
  private release(id: string): void {
    this.sessionRequests.release(id);
    for (const pending of [...this.histories.values()]) if (pending.deviceId === id) pending.finish(new Error("设备连接中断，历史查询已取消"));
    for (const pending of [...this.responses.values()]) if (pending.deviceId === id) pending.finish(new Error("设备连接中断，请检查交互是否已处理"));
    for (const pending of [...this.pending.values()]) if (pending.deviceId === id) pending.reject(new Error("设备已离线"));
    for (const ws of this.streams.get(id) ?? []) ws.terminate();
    this.streams.delete(id);
  }
  private heartbeat(): void {
    for (const node of this.connections.values()) {
      if (Date.now() - node.seen > 40_000) node.socket.terminate();
      else node.socket.ping();
    }
  }
  close(): void {
    clearInterval(this.timer);
    for (const [id, node] of this.connections) {
      this.connections.delete(id);
      node.socket.close(1001, "Hub shutting down");
      this.release(id);
    }
  }
}
