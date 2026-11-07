import { randomBytes } from "node:crypto";
import { WebSocket } from "ws";
import { MAX_FRAME, json, parse, webSocketUrl } from "../../shared/protocol.ts";
import { buffer } from "../../shared/sockets.ts";
import { decodeEvent, decodeFrame, type OpiEvent, type OpiFrame } from "./wire.ts";

export class OpiClient {
  private ws: WebSocket;
  private controller = new AbortController();
  private started = Promise.withResolvers<{ id: string; catalog: OpiFrame["catalog"] }>();
  private finished = Promise.withResolvers<Error>();
  private failure: Error | undefined;
  private stopped = false;
  readonly ready = this.started.promise;
  readonly closed = this.finished.promise;
  private target: URL;
  constructor(target: URL, onEvent: (event: OpiEvent) => void, sessionId?: string) {
    this.target = target;
    const path = `/api/events${sessionId ? `?session=${encodeURIComponent(sessionId)}` : ""}`;
    this.ws = new WebSocket(webSocketUrl(target.origin, path), { headers: { Origin: target.origin }, maxPayload: MAX_FRAME, perMessageDeflate: false, handshakeTimeout: 10_000 });
    const timeout = setTimeout(() => this.fail(new Error("o-pi 客户端握手超时")), 10_000);
    this.ws.on("message", (raw, binary) => {
      try {
        if (binary) throw new Error("o-pi 返回了非 JSON 事件");
        const delivery = decodeFrame(parse(buffer(raw).toString()));
        if (!delivery) return;
        for (const raw of delivery.events) {
          const event = decodeEvent(raw);
          if (!event) continue;
          if (event.type === "client") { clearTimeout(timeout); this.started.resolve({ id: event.id, catalog: delivery.catalog }); }
          onEvent(event);
        }
        void json(this.ws, delivery.ack).catch((error: unknown) => this.fail(error instanceof Error ? error : new Error("o-pi 确认帧发送失败")));
      } catch (error) { this.fail(error instanceof Error ? error : new Error("o-pi 协议不匹配")); }
    });
    this.ws.on("error", (error) => { this.failure = error; });
    this.ws.once("close", (code, reason) => {
      const failure = this.failure ?? new Error(`o-pi 连接已断开 (${code}${reason.length ? `: ${reason.toString()}` : ""})`);
      clearTimeout(timeout); this.controller.abort(failure); this.started.reject(failure); this.finished.resolve(failure);
    });
  }
  async refreshCatalog(): Promise<void> {
    const ready = await this.ready;
    await this.action(ready.catalog, null, AbortSignal.timeout(30_000));
  }
  async action(value: unknown, sessionId: string | null = null, signal?: AbortSignal): Promise<void> {
    const { id } = await this.ready;
    const response = await fetch(new URL("/api/action", this.target), {
      method: "POST", headers: { Origin: this.target.origin, "Content-Type": "application/json", "X-Opi-Client": id },
      body: JSON.stringify({ value, sessionId }), signal: signal ? AbortSignal.any([this.controller.signal, signal]) : this.controller.signal,
    });
    if (!response.ok) throw new Error(await response.text());
    await response.body?.cancel();
  }
  /** HTTP 操作完成后，用同一事件连接的 pong 确认此前排队的目录帧已到达。 */
  async synchronize(signal: AbortSignal): Promise<void> {
    const combined = AbortSignal.any([signal, this.controller.signal, AbortSignal.timeout(5000)]);
    combined.throwIfAborted();
    const nonce = randomBytes(8);
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { this.ws.off("pong", pong); combined.removeEventListener("abort", abort); };
      const abort = () => { cleanup(); reject(combined.reason); };
      const pong = (data: Buffer) => { if (data.equals(nonce)) { cleanup(); resolve(); } };
      this.ws.on("pong", pong); combined.addEventListener("abort", abort, { once: true });
      this.ws.ping(nonce, undefined, (error: Error | undefined) => { if (error) { cleanup(); reject(error); } });
    });
  }
  private fail(error: Error): void { this.failure = error; this.ws.terminate(); }
  close(): void {
    if (this.stopped) return;
    this.stopped = true; this.controller.abort(); this.ws.terminate();
  }
}
