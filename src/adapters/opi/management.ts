import { setTimeout as delay } from "node:timers/promises";
import type { ModelOption } from "../../shared/models.ts";
import type { RawData, WebSocket } from "ws";
import { parse } from "../../shared/protocol.ts";
import { buffer } from "../../shared/sockets.ts";
import type { Interaction, ManagedSession, ManagementState } from "../../shared/management.ts";
import type { CompletionNotice } from "../../shared/notifications.ts";
import { CompletionObserver } from "./completion.ts";
import { OpiClient } from "./client.ts";
import { readHistory } from "./history.ts";
import { listDirectories } from "./directories.ts";
import { SessionCreation } from "./creation.ts";
import { AgentTask } from "./task.ts";
import { blockingTask, executingTask, type TaskInput } from "../../shared/tasks.ts";
import { applyDirectory, decodeDialog, decodeEvent, decodeFrame, decodeModels, type Activity, type OpiEvent, type Selected, type Workspace } from "./wire.ts";

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
  models: ModelOption[] = [];
  private responses = 0;
  private executing = false;
  private completed: (sessionId: string, replyId: string) => void;
  get busy(): boolean { return this.responses > 0 || this.executing; }
  constructor(target: URL, changed: (event?: OpiEvent) => void, completed: (sessionId: string, replyId: string) => void, sessionId?: string) {
    this.target = target; this.changed = changed; this.completed = completed; this.sessionId = sessionId;
    this.task = this.run();
  }
  private async run(): Promise<void> {
    let failures = 0;
    while (!this.controller.signal.aborted) {
      const observer = new CompletionObserver(this.completed);
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
      }, this.sessionId, (raw) => {
        observer.consume(raw); this.executing = observer.busy;
        if (!this.sessionId) {
          const models = decodeModels(raw);
          if (models) { this.models = models; if (this.connected) this.changed(); }
        }
      });
      this.client = client;
      try {
        await client.ready;
        failures = 0; this.connected = true; this.error = undefined; this.changed();
        throw await client.closed;
      } catch (error) {
        this.connected = false; this.selected = null; this.dialogs = []; this.models = []; this.executing = false;
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
  private creations = new Map<string, SessionCreation>();
  private tasks = new Map<string, AgentTask>();
  private feedback = new Set<string>();
  private notifications = new Map<string, CompletionNotice>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  constructor(target: URL, emit: (state: ManagementState) => void) {
    this.target = target; this.emit = emit;
    this.catalog = new Subscription(target, (event) => {
      if (event?.type === "workspaces") this.workspaces = event.value;
      if (event?.type === "workspacesPatch") this.workspaces = applyDirectory(this.workspaces, event.value);
      if (event?.type === "activity") this.activity = event.value;
      if (event?.type === "sessionsDeleted") for (const creation of this.creations.values()) {
        const record = creation.record;
        if (record.state === "ready" && event.ids.includes(record.session.id)) creation.record = {
          id: record.id, path: record.path, startedAt: record.startedAt, state: "error", error: "会话已删除，此创建请求不会重新执行。", session: null,
        };
      }
      if (event?.type === "feedback" && event.tone === "error") this.feedback.add(event.message);
      if (!event && !this.catalog.connected) { this.workspaces = undefined; this.activity = []; this.feedback.clear(); }
      this.schedule();
    }, (id, replyId) => this.completed(id, replyId));
    this.schedule();
  }
  /** 只读观察经 hub 转发的客户端导航，补充尚未进入全局目录的新建会话。 */
  trackViewer(socket: WebSocket): void {
    if (this.stopped) return;
    const key = Symbol();
    const observer = new CompletionObserver((id, replyId) => this.completed(id, replyId));
    const receive = (raw: RawData, binary: boolean) => {
      try {
        if (binary) throw new Error("会话发现收到了非 JSON 事件");
        const frame = decodeFrame(parse(buffer(raw).toString()));
        if (!frame) return;
        for (const raw of frame.events) {
          observer.consume(raw);
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
  private remember(notice: CompletionNotice): void {
    if (this.notifications.has(notice.id)) return;
    this.notifications.set(notice.id, notice);
    for (const id of [...this.notifications.keys()].slice(0, Math.max(0, this.notifications.size - 100))) this.notifications.delete(id);
    this.schedule();
  }
  private completed(sessionId: string, replyId: string): void {
    if (this.stopped || [...this.tasks.values()].some((task) => task.record.session?.id === sessionId && (executingTask(task.record.state) || task.record.replyId === replyId))) return;
    const session = this.activity.find((item) => item.sessionId === sessionId);
    const selected = [...this.viewers.values(), ...[this.catalog, ...this.watches.values()].flatMap((watch) => watch.selected ? [watch.selected] : [])].find((item) => item.id === sessionId);
    if (session) this.remember({ id: `${sessionId}:${replyId}`, sessionId, file: session.path, title: session.title, cwd: session.cwd, completedAt: new Date().toISOString(), runId: null });
    else if (selected) this.remember({ id: `${sessionId}:${replyId}`, sessionId, file: selected.path, title: "", cwd: selected.cwd, completedAt: new Date().toISOString(), runId: null });
  }
  private schedule(): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.publish(); }, 30);
  }
  private publish(): void {
    if (this.stopped) return;
    const desired = new Set<string>();
    if (this.catalog.connected) {
      for (const session of this.activity) if (session.state === "waiting" || session.state === "running") desired.add(session.sessionId);
      for (const session of this.viewers.values()) desired.add(session.id);
      for (const creation of this.creations.values()) {
        const record = creation.record;
        if (record.state === "ready" && !this.activity.some((item) => item.sessionId === record.session.id)) desired.add(record.session.id);
      }
      for (const [id, watch] of this.watches) if (watch.connected && watch.dialogs.length) desired.add(id);
      if (this.catalog.selected) desired.delete(this.catalog.selected.id);
    }
    for (const [id, watch] of this.watches) if (!desired.has(id) && !watch.busy) { this.watches.delete(id); void watch.close(); }
    for (const id of desired) if (!this.watches.has(id)) this.watches.set(id, new Subscription(this.target, () => this.schedule(), (sessionId, replyId) => this.completed(sessionId, replyId), id));
    if (!this.catalog.connected) {
      this.emit(this.catalog.error ? { state: "error", message: this.catalog.error } : { state: "connecting" });
      return;
    }
    for (const task of this.tasks.values()) {
      const record = task.record;
      if (record.state === "completed" && record.session) this.remember({ id: `task:${record.id}`, sessionId: record.session.id, file: record.file, title: record.name, cwd: record.path, completedAt: record.updatedAt, runId: record.id });
    }
    const subscriptions = [this.catalog, ...this.watches.values()];
    const terminal = [...this.tasks.values()].filter((task) => !blockingTask(task.record.state)).sort((a, b) => b.record.updatedAt.localeCompare(a.record.updatedAt));
    for (const task of terminal.slice(100)) this.tasks.delete(task.record.id);
    const creationDialogs = [...this.creations.values()].flatMap((creation) => creation.dialogs);
    const taskDialogs = [...this.tasks.values()].flatMap((task) => task.dialogs);
    const dialogs = [...subscriptions.filter((watch) => watch.connected).flatMap((watch) => watch.dialogs), ...creationDialogs, ...taskDialogs];
    const interactions = [...new Map(dialogs.map((dialog) => [JSON.stringify([dialog.sessionId, dialog.id]), dialog])).values()];
    const active = [...this.activity];
    // 启动交互和经浏览器发现的新会话可能尚未进入运行目录。
    for (const watch of subscriptions) {
      const selected = watch.selected;
      if (selected && watch.dialogs.length && !active.some((item) => item.sessionId === selected.id)) active.push({
        sessionId: selected.id, path: selected.path, cwd: selected.cwd, title: "", modified: "", state: "waiting",
      });
    }
    for (const creation of this.creations.values()) {
      const record = creation.record;
      const session = record.state === "ready" ? record.session : creation.selected;
      if (session && (record.state === "ready" || creation.dialogs.length) && !active.some((item) => item.sessionId === session.id)) active.push({
        sessionId: session.id, path: session.path, cwd: session.cwd, title: "", modified: record.startedAt,
        state: creation.dialogs.length ? "waiting" : "idle",
      });
    }
    for (const task of this.tasks.values()) {
      if (!executingTask(task.record.state)) continue;
      const session = task.record.session ?? (task.dialogs.length ? task.selected : null);
      if (session && !active.some((item) => item.sessionId === session.id)) active.push({ sessionId: session.id, path: task.record.file, cwd: session.cwd, title: `[schedule] ${task.record.name}`, modified: task.record.updatedAt,
        state: task.record.state === "waiting" ? "waiting" : executingTask(task.record.state) ? "running" : "idle" });
    }
    const sessions: ManagedSession[] = active.map((item) => ({ target: { id: item.sessionId }, file: item.path, cwd: item.cwd, title: item.title, modified: item.modified, state: item.state }));
    const workspaces = [...new Set([...(this.workspaces ?? []).map((item) => item.path), ...active.map((item) => item.cwd), ...[...this.viewers.values()].map((item) => item.cwd)])];
    const issues = [...this.feedback, ...[...this.watches].flatMap(([id, watch]) => watch.error ? [`${id}: ${watch.error}`] : [])];
    this.emit({ state: "ready", models: this.catalog.models, workspaces, sessions, interactions, creations: [...this.creations.values()].map((creation) => creation.record), tasks: [...this.tasks.values()].map((task) => task.record), notifications: [...this.notifications.values()], issues });
  }
  history(signal: AbortSignal) { return readHistory(this.target, signal); }
  directories(path: string, signal: AbortSignal) { return listDirectories(this.target, path, signal); }
  create(id: string, path: string): void {
    const existing = this.creations.get(id);
    if (existing) {
      if (existing.requestedPath !== path) throw new Error("创建请求标识不能用于不同目录");
      return;
    }
    if ([...this.creations.values()].some((creation) => creation.record.state === "creating")) throw new Error("此设备正在创建会话，请先完成相关交互");
    this.creations.set(id, new SessionCreation(this.target, id, path, () => this.schedule())); this.schedule();
  }
  startTask(input: TaskInput): void {
    const existing = this.tasks.get(input.id);
    if (existing) { if (existing.input.name !== input.name || existing.input.path !== input.path || existing.input.prompt !== input.prompt || existing.input.timeoutSeconds !== input.timeoutSeconds || existing.input.model?.provider !== input.model?.provider || existing.input.model?.id !== input.model?.id) throw new Error("运行标识不能用于不同任务"); return; }
    if ([...this.tasks.values()].some((task) => blockingTask(task.record.state)) || [...this.creations.values()].some((creation) => creation.record.state === "creating")) throw new Error("此设备仍有计划运行或会话创建未结束");
    this.tasks.set(input.id, new AgentTask(this.target, input, () => this.schedule())); this.schedule();
  }
  async cancelTask(id: string): Promise<void> { const task = this.tasks.get(id); if (!task) throw new Error("未找到原运行，无法确认已停止"); await task.cancel(); }
  acknowledgeTask(id: string): void { this.tasks.get(id)?.acknowledge(); }
  async respond(sessionId: string, dialogId: string, value: string | null): Promise<void> {
    const task = [...this.tasks.values()].find((task) => task.dialogs.some((dialog) => dialog.sessionId === sessionId && dialog.id === dialogId));
    if (task) { await task.respond(sessionId, dialogId, value); return; }
    const subscription = this.catalog.selected?.id === sessionId ? this.catalog : this.watches.get(sessionId);
    const creation = [...this.creations.values()].find((creation) => creation.dialogs.some((dialog) => dialog.sessionId === sessionId && dialog.id === dialogId));
    if (creation) { await creation.respond(sessionId, dialogId, value); return; }
    if (!subscription) throw new Error("目标交互已结束，请刷新状态");
    await subscription.respond(sessionId, dialogId, value);
  }
  async close(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true; clearTimeout(this.timer);
    for (const cleanup of [...this.viewerCleanup]) cleanup();
    await Promise.all([this.catalog.close(), ...[...this.watches.values()].map((watch) => watch.close()), ...[...this.creations.values()].map((creation) => creation.close()), ...[...this.tasks.values()].map((task) => task.close())]);
    this.watches.clear();
  }
}
