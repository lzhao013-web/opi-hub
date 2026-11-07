import { hostname, platform } from "node:os";
import { WebSocket } from "ws";
import { isOpen, json, MAX_FRAME, object, parse, webSocketUrl } from "../shared/protocol.ts";
import { buffer, connected } from "../shared/sockets.ts";
import { serveHttp, serveWebSocket } from "./transport.ts";
import { OpiManagement } from "../adapters/opi/management.ts";
import { isRespond, isHistoryCommand, isCancelHistory, type HistoryReply, type RespondReply, type ManagementState } from "../shared/management.ts";

export interface NodeConfig { hub: string; token: string; target: string }
export function validateNodeConfig(value: unknown): NodeConfig {
  if (!object(value) || typeof value.hub !== "string" || typeof value.token !== "string" || typeof value.target !== "string") throw new Error("节点配置需要 hub、token、target");
  const hub = new URL(value.hub);
  const target = new URL(value.target);
  for (const url of [hub, target]) if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("地址必须是没有路径、查询参数和凭据的 HTTP(S) URL");
  if (!["127.0.0.1", "localhost", "[::1]"].includes(target.hostname)) throw new Error("target 只允许本机回环地址");
  if (!/^[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/.test(value.token)) throw new Error("无效的设备凭据");
  return { hub: hub.origin, token: value.token, target: target.origin };
}
export interface NodeAgent { ready: Promise<void>; close(): Promise<void> }
export function startNode(input: NodeConfig, log: (message: string) => void = console.log): NodeAgent {
  const config = validateNodeConfig(input);
  const target = new URL(config.target);
  const abort = new AbortController();
  const sockets = new Set<WebSocket>();
  let first = true;
  let resolveReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
  const track = (ws: WebSocket) => { sockets.add(ws); ws.on("error", () => {}); ws.once("close", () => sockets.delete(ws)); return ws; };
  const options = { headers: { Authorization: `Bearer ${config.token}` }, maxPayload: MAX_FRAME, perMessageDeflate: false, handshakeTimeout: 10_000 };
  let currentControl: WebSocket | undefined;
  let latestManagement: ManagementState = { state: "connecting" };
  const management = new OpiManagement(target, (value) => {
    latestManagement = value;
    const control = currentControl;
    if (!control || control.readyState !== WebSocket.OPEN) return;
    if (control.bufferedAmount > MAX_FRAME) { control.terminate(); return; }
    void json(control, { type: "management", value }).catch(() => control.terminate());
  });
  const run = async () => {
    let failures = 0;
    while (!abort.signal.aborted) {
      const control = track(new WebSocket(webSocketUrl(config.hub, "/_hub/connect"), options));
      let statusTimer: ReturnType<typeof setInterval> | undefined;
      let stopped = false;
      const historyTasks = new Map<string, AbortController>();
      try {
        const closed = new Promise<number>((resolve) => control.once("close", (code) => resolve(code)));
        await connected(control);
        failures = 0;
        let heartbeat = Date.now();
        control.on("ping", () => { heartbeat = Date.now(); });
        log("已连接中心");
        const report = async () => {
          let healthy = false;
          try {
            const response = await fetch(new URL("/health", target), { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]), redirect: "error" });
            healthy = response.ok;
            await response.body?.cancel();
          } catch { /* 本机服务关闭或设备网络中断时，上报不可用，不影响中心连接。 */ }
          if (control.readyState === WebSocket.OPEN) await json(control, { type: "status", ready: healthy, hostname: hostname(), platform: platform(), target: config.target });
        };
        control.on("message", (raw, binary) => {
          try {
            if (binary || buffer(raw).byteLength > MAX_FRAME) throw new Error("无效控制帧");
            const request = parse(raw.toString());
            if (isCancelHistory(request)) { historyTasks.get(request.id)?.abort(); return; }
            if (isHistoryCommand(request)) {
              const controller = new AbortController(); historyTasks.set(request.id, controller);
              void (async () => {
                let result: HistoryReply;
                try { result = { type: "historyResult", id: request.id, ok: true, entries: await management.history(AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)])) }; }
                catch (error) { result = { type: "historyResult", id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) }; }
                finally { historyTasks.delete(request.id); }
                if (!controller.signal.aborted && control.readyState === WebSocket.OPEN) await json(control, result);
              })().catch(() => control.terminate());
              return;
            }
            if (isRespond(request)) {
              void (async () => {
                let result: RespondReply;
                try {
                  await management.respond(request.sessionId, request.dialogId, request.value);
                  result = { type: "responded", id: request.id, ok: true };
                } catch (error) { result = { type: "responded", id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) }; }
                await json(control, result);
              })().catch(() => control.terminate());
              return;
            }
            if (!isOpen(request)) throw new Error("无效转发请求");
            if (sockets.size >= 128) throw new Error("连接数超过限制");
            const tunnel = track(new WebSocket(webSocketUrl(config.hub, `/_hub/stream/${request.id}`), options));
            void (async () => {
              await connected(tunnel);
              if (request.kind === "http") { await serveHttp(tunnel, target, request); await json(tunnel, { type: "ready" }); }
              else await serveWebSocket(tunnel, target, request, request.path.split("?")[0] === "/api/events" ? (socket) => management.trackViewer(socket) : undefined);
            })().catch((error: unknown) => { log(error instanceof Error ? error.message : "转发失败"); tunnel.terminate(); });
          } catch { control.close(1008, "Invalid control frame"); }
        });
        currentControl = control;
        await json(control, { type: "management", value: latestManagement });
        await report();
        if (first) { first = false; resolveReady(); }
        statusTimer = setInterval(() => {
          if (Date.now() - heartbeat > 45_000) control.terminate();
          else void report().catch(() => control.terminate());
        }, 15_000);
        const code = await closed;
        stopped = code === 4001;
      } catch (error) {
        if (!abort.signal.aborted) log(`中心连接失败：${error instanceof Error ? error.message : String(error)}`);
      } finally {
        clearInterval(statusTimer);
        for (const controller of historyTasks.values()) controller.abort(); historyTasks.clear();
        if (currentControl === control) currentControl = undefined;
        for (const socket of sockets) socket.terminate();
      }
      if (abort.signal.aborted || stopped) {
        if (stopped) log("设备凭据已撤销或被另一节点使用，请检查配置后重新启动");
        break;
      }
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5));
      log(`连接已断开，${delay / 1000} 秒后重连`);
      await new Promise<void>((resolve) => {
        const stop = () => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => { abort.signal.removeEventListener("abort", stop); resolve(); }, delay);
        abort.signal.addEventListener("abort", stop, { once: true });
      });
    }
  };
  const task = run().finally(() => management.close());
  return { ready, async close() { abort.abort(); for (const socket of sockets) socket.terminate(); await task; } };
}
