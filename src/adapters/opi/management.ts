import { setTimeout as delay } from "node:timers/promises";
import type { RawData, WebSocket } from "ws";
import { parse } from "../../shared/protocol.ts";
import { buffer } from "../../shared/sockets.ts";
import type { Interaction, ManagedSession, ManagementState } from "../../shared/management.ts";
import { OpiClient } from "./client.ts";
import { readHistory } from "./history.ts";
import { applyDirectory, decodeDialog, decodeEvent, decodeFrame, type Activity, type OpiEvent, type Selected, type Workspace } from "./wire.ts";

/** 每个订阅有独立客户端身份，不借用浏览器的导航或审批连接。 */
class Subscription {
  readonly target: URL;
  readonly sessionId: string | undefined;
  private changed: (event?: OpiEvent) => void;
  private controller = new AbortController();
  private client: OpiClient | undefined;
  private task: Promise<void>;
  connected = false;
  error: string | undefined;
  selected: Selected | null = null;
  dialogs: Interaction[] = [];
  private responses = 0;
  get busy(): boolean { return this.responses > 0; }
  constructor(target: URL, changed: (event?: OpiEvent) => void, sessionId?: string) {
    this.target = target; this.changed = changed; this.sessionId = sessionId;
    this.task = this.run();
  }
  private async run(): Promise<void> {
    let failures = 0;
    while (!this.controller.signal.aborted) {
      const client = new OpiClient(this.target, (event) => {
        if (event.type === "selected") {
          if (this.sessionId && event.session?.id !== this.sessionId) throw new Error("目标会话已不存在");
          this.selected = event.session; this.dialogs = [];
        }
        if (event.type === "dialogs") {
          const selected = this.selected;
          if (!selected && event.value.length) throw new Error("o-pi 对话框缺少目标会话");
          this.dialogs = selected ? event.value.map((raw) => decodeDialog(raw, selected.id)) : [];
        }
        this.changed(event);
      }, this.sessionId);
      this.client = client;
      try {
        await client.ready;
        failures = 0; this.connected = true; this.error = undefined; this.changed();
        throw await client.closed;
      } catch (error) {
        this.connected = false; this.selected = null; this.dialogs = [];
        if (!this.controller.signal.aborted) { this.error = error instanceof Error ? error.message : String(error); this.changed(); }
      } finally { client.close(); this.client = undefined; }
      if (this.controller.signal.aborted) break;
      try { await delay(Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5)), undefined, { signal: this.controller.signal }); }
      catch { break; }
    }
  }
  async respond(sessionId: string, dialogId: string, value: string | null): Promise<void> {
    const client = this.client;
    if (!this.connected || !client || !this.dialogs.some((dialog) => dialog.id === dialogId && dialog.sessionId === sessionId)) throw new Error("交互已结束或连接已变化，请刷新状态");
    this.responses++;
    try { await client.action({ action: "dialog", id: dialogId, value }, sessionId, AbortSignal.timeout(25_000)); }
    finally { this.responses--; this.changed(); }
  }
  async close(): Promise<void> { this.controller.abort(); this.client?.close(); await this.task; }
}

export class OpiManagement {
  private target: URL;
  private emit: (state: ManagementState) => void;
  private catalog: Subscription;
  private watches = new Map<string, Subscription>();
  private viewers = new Map<symbol, Selected>();
  private viewerCleanup = new Set<() => void>();
  private workspaces: Workspace[] | undefined;
  private activity: Activity[] = [];
  private feedback = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  constructor(target: URL, emit: (state: ManagementState) => void) {
    this.target = target; this.emit = emit;
    this.catalog = new Subscription(target, (event) => {
      if (event?.type === "workspaces") this.workspaces = event.value;
      if (event?.type === "workspacesPatch") this.workspaces = applyDirectory(this.workspaces, event.value);
      if (event?.type === "activity") this.activity = event.value;
      if (event?.type === "feedback" && event.tone === "error") this.feedback.add(event.message);
      if (!event && !this.catalog.connected) { this.workspaces = undefined; this.activity = []; this.feedback.clear(); }
      this.schedule();
    });
    this.schedule();
  }
  /** 只读观察经 hub 转发的客户端导航，补充尚未进入全局目录的新建会话。 */
  trackViewer(socket: WebSocket): void {
    if (this.stopped) return;
    const key = Symbol();
    const receive = (raw: RawData, binary: boolean) => {
      try {
        if (binary) throw new Error("会话发现收到了非 JSON 事件");
        const frame = decodeFrame(parse(buffer(raw).toString()));
        if (!frame) return;
        for (const raw of frame.events) {
          const event = decodeEvent(raw);
          if (event?.type !== "selected") continue;
          if (event.session) this.viewers.set(key, event.session); else this.viewers.delete(key);
          this.schedule();
        }
      } catch (error) {
        this.feedback.add(`浏览器会话发现失败: ${error instanceof Error ? error.message : String(error)}`); this.schedule();
      }
    };
    const cleanup = () => {
      socket.off("message", receive); socket.off("close", cleanup);
      this.viewers.delete(key); this.viewerCleanup.delete(cleanup); this.schedule();
    };
    socket.on("message", receive); socket.once("close", cleanup); this.viewerCleanup.add(cleanup);
  }
  private schedule(): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.publish(); }, 30);
  }
  private publish(): void {
    if (this.stopped) return;
    const desired = new Set<string>();
    if (this.catalog.connected) {
      for (const session of this.activity) if (session.state === "waiting") desired.add(session.sessionId);
      for (const session of this.viewers.values()) desired.add(session.id);
      for (const [id, watch] of this.watches) if (watch.connected && watch.dialogs.length) desired.add(id);
      if (this.catalog.selected) desired.delete(this.catalog.selected.id);
    }
    for (const [id, watch] of this.watches) if (!desired.has(id) && !watch.busy) { this.watches.delete(id); void watch.close(); }
    for (const id of desired) if (!this.watches.has(id)) this.watches.set(id, new Subscription(this.target, () => this.schedule(), id));
    if (!this.catalog.connected) {
      this.emit(this.catalog.error ? { state: "error", message: this.catalog.error } : { state: "connecting" });
      return;
    }
    const subscriptions = [this.catalog, ...this.watches.values()];
    const interactions = subscriptions.filter((watch) => watch.connected).flatMap((watch) => watch.dialogs);
    const active = [...this.activity];
    // 启动交互和经浏览器发现的新会话可能尚未进入运行目录。
    for (const watch of subscriptions) {
      const selected = watch.selected;
      if (selected && watch.dialogs.length && !active.some((item) => item.sessionId === selected.id)) active.push({
        sessionId: selected.id, path: selected.path, cwd: selected.cwd, title: "", modified: "", state: "waiting",
      });
    }
    const sessions: ManagedSession[] = active.map((item) => ({ target: { id: item.sessionId }, file: item.path, cwd: item.cwd, title: item.title, modified: item.modified, state: item.state }));
    const workspaces = [...new Set([...(this.workspaces ?? []).map((item) => item.path), ...active.map((item) => item.cwd), ...[...this.viewers.values()].map((item) => item.cwd)])];
    const issues = [...this.feedback, ...[...this.watches].flatMap(([id, watch]) => watch.error ? [`${id}: ${watch.error}`] : [])];
    this.emit({ state: "ready", workspaces, sessions, interactions, issues });
  }
  history(signal: AbortSignal) { return readHistory(this.target, signal); }
  async respond(sessionId: string, dialogId: string, value: string | null): Promise<void> {
    const subscription = this.catalog.selected?.id === sessionId ? this.catalog : this.watches.get(sessionId);
    if (!subscription) throw new Error("目标交互已结束，请刷新状态");
    await subscription.respond(sessionId, dialogId, value);
  }
  async close(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true; clearTimeout(this.timer);
    for (const cleanup of [...this.viewerCleanup]) cleanup();
    await Promise.all([this.catalog.close(), ...[...this.watches.values()].map((watch) => watch.close())]);
    this.watches.clear();
  }
}
