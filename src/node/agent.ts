import { hostname, platform } from "node:os";
import { WebSocket } from "ws";
import { isOpen, json, MAX_FRAME, parse, webSocketUrl } from "../shared/protocol.ts";
import { buffer, connected } from "../shared/sockets.ts";
import { serveHttp, serveWebSocket } from "./transport.ts";
import { isSessionCommand, isCancelDirectories, type SessionResponse } from "../shared/session-creation.ts";
import { isRespond, isHistoryCommand, isCancelHistory, type HistoryReply, type RespondReply } from "../shared/management.ts";
import { isRestartBackend, type BackendReply, type NodeReport } from "../shared/backend.ts";
import { validateNodeConfig } from "./config.ts";
import { NodeRuntime } from "./runtime.ts";
import { isTaskCommand, type TaskReply } from "../shared/tasks.ts";

export interface NodeAgent { ready: Promise<void>; closed: Promise<void>; close(): Promise<void> }
export function startNode(input: unknown, log: (message: string) => void = console.log): NodeAgent {
  const config = validateNodeConfig(input);
  const abort = new AbortController();
  const sockets = new Set<WebSocket>(); const reads = new Set<AbortController>();
  const ready = Promise.withResolvers<void>();
  let first = true; let currentControl: WebSocket | undefined;
  const runtime = new NodeRuntime(config, (value) => {
    const control = currentControl;
    if (!control || control.readyState !== WebSocket.OPEN) return;
    if (control.bufferedAmount > MAX_FRAME) { control.terminate(); return; }
    void json(control, { type: "management", value }).catch(() => control.terminate());
  }, () => {
    for (const controller of reads) controller.abort();
    const control = currentControl; void report(control).catch(() => control?.terminate());
  });
  async function report(control: WebSocket | undefined): Promise<void> {
    if (!control || control.readyState !== WebSocket.OPEN) return;
    const backend = runtime.backend; let healthy = false;
    if (backend.state === "running") {
      try {
        const response = await fetch(new URL("/health", backend.url), { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]), redirect: "error" });
        healthy = response.ok; await response.body?.cancel();
      } catch { /* 健康检查失败不重启后端，也不重放任务。 */ }
    }
    const current = runtime.backend;
    if (current.generation !== backend.generation || current.state !== backend.state || control !== currentControl || control.readyState !== WebSocket.OPEN) return;
    await json(control, { type: "status", ready: healthy, hostname: hostname(), platform: platform(), backend: current } satisfies NodeReport);
  }
  const track = (ws: WebSocket) => { sockets.add(ws); ws.on("error", () => {}); ws.once("close", () => sockets.delete(ws)); return ws; };
  const options = { headers: { Authorization: `Bearer ${config.token}` }, maxPayload: MAX_FRAME, perMessageDeflate: false, handshakeTimeout: 10_000 };
  const run = async () => {
    let failures = 0;
    while (!abort.signal.aborted) {
      const control = track(new WebSocket(webSocketUrl(config.hub, "/_hub/connect"), options));
      let statusTimer: ReturnType<typeof setInterval> | undefined; let stopped = false;
      const historyTasks = new Map<string, AbortController>(); const directoryTasks = new Map<string, AbortController>();
      const beginRead = (tasks: Map<string, AbortController>, id: string) => { const controller = new AbortController(); tasks.set(id, controller); reads.add(controller); return controller; };
      const finishRead = (tasks: Map<string, AbortController>, id: string, controller: AbortController) => { tasks.delete(id); reads.delete(controller); };
      try {
        const closed = new Promise<number>((resolve) => control.once("close", (code) => resolve(code)));
        await connected(control); failures = 0; let heartbeat = Date.now();
        control.on("ping", () => { heartbeat = Date.now(); }); log("已连接中心");
        control.on("message", (raw, binary) => {
          try {
            if (binary || buffer(raw).byteLength > MAX_FRAME) throw new Error("无效控制帧");
            const request = parse(raw.toString());
            if (isTaskCommand(request)) {
              void (async () => {
                let result: TaskReply;
                const type = request.type === "startTask" ? "taskAccepted" : request.type === "cancelTask" ? "taskCancelled" : "taskAcknowledged";
                try {
                  if (request.type === "startTask") runtime.management.startTask(request.task);
                  else if (request.type === "cancelTask") await runtime.management.cancelTask(request.runId);
                  else runtime.management.acknowledgeTask(request.runId);
                  result = { type, id: request.id, ok: true };
                } catch (error) { result = { type, id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) }; }
                if (control.readyState === WebSocket.OPEN) await json(control, result);
              })().catch(() => control.terminate()); return;
            }
            if (isRestartBackend(request)) {
              let result: BackendReply;
              try { if (runtime.backend.generation !== request.generation) throw new Error("后端已变化，请重新确认重启"); runtime.restart(); result = { type: "backendRestartAccepted", id: request.id, ok: true }; }
              catch (error) { result = { type: "backendRestartAccepted", id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) }; }
              void json(control, result).catch(() => control.terminate()); return;
            }
            if (isCancelDirectories(request)) { directoryTasks.get(request.id)?.abort(); return; }
            if (isSessionCommand(request)) {
              void (async () => {
                let result: SessionResponse;
                if (request.type === "directories") {
                  const controller = beginRead(directoryTasks, request.id);
                  try { result = { type: "directoryResult", id: request.id, ok: true, listing: await runtime.management.directories(request.path, AbortSignal.any([controller.signal, abort.signal, AbortSignal.timeout(15_000)])) }; }
                  catch (error) { result = { type: "directoryResult", id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) }; }
                  finally { finishRead(directoryTasks, request.id, controller); }
                  if (controller.signal.aborted) return;
                } else {
                  try { runtime.management.create(request.creationId, request.path); result = { type: "creationAccepted", id: request.id, ok: true }; }
                  catch (error) { result = { type: "creationAccepted", id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) }; }
                }
                if (control.readyState === WebSocket.OPEN) await json(control, result);
              })().catch(() => control.terminate()); return;
            }
            if (isCancelHistory(request)) { historyTasks.get(request.id)?.abort(); return; }
            if (isHistoryCommand(request)) {
              const controller = beginRead(historyTasks, request.id);
              void (async () => {
                let result: HistoryReply;
                try { result = { type: "historyResult", id: request.id, ok: true, entries: await runtime.management.history(AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)])) }; }
                catch (error) { result = { type: "historyResult", id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) }; }
                finally { finishRead(historyTasks, request.id, controller); }
                if (!controller.signal.aborted && control.readyState === WebSocket.OPEN) await json(control, result);
              })().catch(() => control.terminate()); return;
            }
            if (isRespond(request)) {
              void (async () => {
                let result: RespondReply;
                try { await runtime.management.respond(request.sessionId, request.dialogId, request.value); result = { type: "responded", id: request.id, ok: true }; }
                catch (error) { result = { type: "responded", id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) }; }
                await json(control, result);
              })().catch(() => control.terminate()); return;
            }
            if (!isOpen(request)) throw new Error("无效转发请求");
            if (sockets.size >= 128) throw new Error("连接数超过限制");
            const tunnel = track(new WebSocket(webSocketUrl(config.hub, `/_hub/stream/${request.id}`), options));
            void (async () => {
              await connected(tunnel); const target = runtime.target;
              if (request.kind === "http") { await serveHttp(tunnel, target, request); await json(tunnel, { type: "ready" }); }
              else await serveWebSocket(tunnel, target, request, request.path.split("?")[0] === "/api/events" ? (socket) => runtime.observe(socket) : undefined);
            })().catch((error: unknown) => { log(error instanceof Error ? error.message : "转发失败"); tunnel.terminate(); });
          } catch { control.close(1008, "Invalid control frame"); }
        });
        currentControl = control; await json(control, { type: "management", value: runtime.snapshot }); await report(control);
        if (first) { first = false; ready.resolve(); }
        statusTimer = setInterval(() => {
          if (Date.now() - heartbeat > 45_000) control.terminate(); else void report(control).catch(() => control.terminate());
        }, 15_000);
        stopped = await closed === 4001;
      } catch (error) { if (!abort.signal.aborted) log(`中心连接失败：${error instanceof Error ? error.message : String(error)}`); }
      finally {
        clearInterval(statusTimer);
        for (const controller of historyTasks.values()) { controller.abort(); reads.delete(controller); }
        for (const controller of directoryTasks.values()) { controller.abort(); reads.delete(controller); }
        if (currentControl === control) currentControl = undefined;
        for (const socket of sockets) socket.terminate();
      }
      if (abort.signal.aborted || stopped) { if (stopped) log("设备凭据已撤销或被另一节点使用，正在关闭托管后端"); break; }
      const milliseconds = Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5)); log(`连接已断开，${milliseconds / 1000} 秒后重连`);
      await new Promise<void>((resolve) => {
        const stop = () => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => { abort.signal.removeEventListener("abort", stop); resolve(); }, milliseconds);
        abort.signal.addEventListener("abort", stop, { once: true });
      });
    }
  };
  runtime.restart();
  const task = run().finally(async () => { abort.abort(); for (const controller of reads) controller.abort(); await runtime.close(); });
  return { ready: ready.promise, closed: task, async close() { abort.abort(); for (const socket of sockets) socket.terminate(); await task; } };
}
