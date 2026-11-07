import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import { json } from "../shared/protocol.ts";
import type { BackendReply, RestartBackend } from "../shared/backend.ts";
import type { DirectoryListing, SessionCommand, SessionResponse } from "../shared/session-creation.ts";
import type { TaskCommand, TaskInput, TaskReply } from "../shared/tasks.ts";

type Reply = SessionResponse | BackendReply | TaskReply;
type WithoutId<T> = T extends { id: string } ? Omit<T, "id"> : never;
type Command = WithoutId<SessionCommand | RestartBackend | TaskCommand>;
export class TaskRejectedError extends Error {}
interface Pending { deviceId: string; type: Command["type"]; socket: WebSocket; receive: (value: Reply | Error) => void }
/** 设备操作只绑定当前节点连接；断线不重发变更操作。 */
export class SessionRequests {
  private pending = new Map<string, Pending>();
  private request<T extends Reply>(deviceId: string, socket: WebSocket, command: Command, accept: (value: Reply) => value is T, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted(); const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const finish = (value: Reply | Error) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer); signal.removeEventListener("abort", abort);
        if (value instanceof Error) {
          if (command.type === "directories" && socket.readyState === socket.OPEN) void json(socket, { type: "cancelDirectories", id }).catch(() => socket.terminate());
          reject(value);
        } else if (!accept(value)) reject(new Error("设备响应类型不匹配"));
        else resolve(value);
      };
      const abort = () => finish(new Error(command.type === "directories" ? "目录查询已取消" : "连接中断，操作结果未知，请检查设备状态或创建记录，不要自动重试。"));
      const timer = setTimeout(() => finish(new Error(command.type === "directories" ? "目录查询超时" : "操作确认超时，请检查设备状态或创建记录，不要自动重试。")), 20_000);
      this.pending.set(id, { deviceId, type: command.type, socket, receive: finish }); signal.addEventListener("abort", abort, { once: true });
      void json(socket, { ...command, id }).catch((error: unknown) => finish(error instanceof Error ? error : new Error("发送请求失败")));
    });
  }
  async directories(deviceId: string, socket: WebSocket, path: string, signal: AbortSignal): Promise<DirectoryListing> {
    const value = await this.request(deviceId, socket, { type: "directories", path }, (value): value is Extract<SessionResponse, { type: "directoryResult" }> => value.type === "directoryResult", signal);
    if (!value.ok) throw new Error(value.error); return value.listing;
  }
  async create(deviceId: string, socket: WebSocket, creationId: string, path: string, signal: AbortSignal): Promise<void> {
    const value = await this.request(deviceId, socket, { type: "createSession", creationId, path }, (value): value is Extract<SessionResponse, { type: "creationAccepted" }> => value.type === "creationAccepted", signal);
    if (!value.ok) throw new Error(value.error);
  }
  async restart(deviceId: string, socket: WebSocket, generation: number, signal: AbortSignal): Promise<void> {
    const value = await this.request(deviceId, socket, { type: "restartBackend", generation }, (value): value is BackendReply => value.type === "backendRestartAccepted", signal);
    if (!value.ok) throw new Error(value.error);
  }
  async startTask(deviceId: string, socket: WebSocket, task: TaskInput, signal: AbortSignal): Promise<void> {
    const value = await this.request(deviceId, socket, { type: "startTask", task }, (value): value is TaskReply => value.type === "taskAccepted", signal);
    if (!value.ok) throw new TaskRejectedError(value.error);
  }
  async taskAction(deviceId: string, socket: WebSocket, action: "cancelTask" | "acknowledgeTask", runId: string, signal: AbortSignal): Promise<void> {
    const expected = action === "cancelTask" ? "taskCancelled" : "taskAcknowledged";
    const value = await this.request(deviceId, socket, { type: action, runId }, (value): value is TaskReply => value.type === expected, signal);
    if (!value.ok) throw new Error(value.error);
  }
  receive(socket: WebSocket, value: Reply): void { const pending = this.pending.get(value.id); if (pending?.socket === socket) pending.receive(value); }
  invalidateReads(deviceId: string): void {
    for (const pending of [...this.pending.values()]) if (pending.deviceId === deviceId && pending.type === "directories") pending.receive(new Error("后端已变化，目录查询已取消"));
  }
  release(deviceId: string): void {
    for (const pending of [...this.pending.values()]) if (pending.deviceId === deviceId) pending.receive(new Error(pending.type === "directories" ? "设备连接中断，目录查询已取消" : "设备连接中断，操作不会自动重试，请检查设备状态或创建记录。"));
  }
}
