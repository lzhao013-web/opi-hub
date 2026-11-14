import type { IncomingMessage, ServerResponse } from "node:http";
import type { Session, Auth } from "./auth.ts";
import { isNotificationDestination, type HubNotice } from "../shared/notifications.ts";
import type { NodeNotifications } from "./node-notifications.ts";
import type { ManagementState } from "../shared/management.ts";
import { HttpError, readJson, reply } from "../shared/http.ts";
import { object, MAX_FRAME } from "../shared/protocol.ts";

/** 最近通知与已读状态只保存在中心内存，设备断线不撤销已发生的完成事实。 */
export class NotificationCenter {
  private notices = new Map<string, HubNotice>();
  private sources = new Map<string, Set<string>>();
  private deliveries = new Map<string, Set<string>>();
  private listeners = new Set<() => void>();
  private viewers = new Map<string, { owner: string; sequence: number; deviceId: string; sessionId: string | null; destination: string; focused: boolean; until: number }>();
  private presenceCleanup = new Map<string, () => void>();
  private muted = new Map<string, Set<string>>();
  private imported = new Set<string>();
  private liveListeners = new Set<(notice: HubNotice) => void>();
  onLive(listener: (notice: HubNotice) => void): () => void { this.liveListeners.add(listener); return () => { this.liveListeners.delete(listener); }; }
  attend(session: Session, pageId: string, sequence: number, deviceId: string, sessionId: string | null, destination: string, focused: boolean): void {
    const now = Date.now();
    for (const [key, viewer] of this.viewers) if (viewer.until < now) this.viewers.delete(key);
    const key = `${session.id}:${pageId}`;
    const previous = this.viewers.get(key);
    if (previous && previous.sequence >= sequence) return;
    if (!previous && this.viewers.size >= 256) throw new HttpError(429, "会话查看连接过多");
    this.viewers.set(key, { owner: session.id, sequence, deviceId, sessionId, destination, focused, until: now + 15_000 });
    if (!this.presenceCleanup.has(session.id)) {
      const close = () => { for (const [key, viewer] of this.viewers) if (viewer.owner === session.id) this.viewers.delete(key); this.presenceCleanup.delete(session.id); };
      this.presenceCleanup.set(session.id, close); session.close.add(close);
    }
  }
  snapshot(): HubNotice[] { return [...this.notices.values()].reverse(); }
  accept(deviceId: string, state: ManagementState, initial = false): void {
    if (state.state !== "ready") return;
    const previous = this.sources.get(deviceId);
    let changed = false;
    for (const notice of state.notifications) {
      const id = `${deviceId}:${notice.id}`;
      if (previous?.has(notice.id) || this.notices.has(id)) continue;
      this.notices.set(id, { ...notice, id, deviceId, read: false });
      if (!previous || initial) this.imported.add(id);
      this.muted.set(id, new Set([...this.viewers.values()].filter((viewer) => viewer.until >= Date.now() && viewer.focused && viewer.deviceId === deviceId && viewer.sessionId === notice.sessionId).map((viewer) => viewer.destination)));
      // 先交给已授权的本机节点抢占同一接收端，再发布浏览器快照，避免双重弹窗。
      if (previous && !initial) {
        const current = this.notices.get(id);
        if (current) for (const listener of this.liveListeners) listener(current);
      }
      changed = true;
    }
    this.sources.set(deviceId, new Set(state.notifications.map((notice) => notice.id)));
    for (const id of [...this.notices.keys()].slice(0, Math.max(0, this.notices.size - 100))) { this.notices.delete(id); this.deliveries.delete(id); this.muted.delete(id); this.imported.delete(id); }
    if (changed) this.publish();
  }
  removeDevice(deviceId: string): void {
    this.sources.delete(deviceId);
    for (const [id, notice] of this.notices) if (notice.deviceId === deviceId) { this.notices.delete(id); this.deliveries.delete(id); this.muted.delete(id); this.imported.delete(id); }
    this.publish();
  }
  read(id: string | null): void {
    if (id !== null && !this.notices.has(id)) throw new HttpError(404, "通知已不存在");
    for (const [key, notice] of this.notices) if (id === null || key === id) this.notices.set(key, { ...notice, read: true });
    this.publish();
  }
  claim(id: string, destination: string): boolean {
    const notice = this.notices.get(id);
    if (!notice) throw new HttpError(404, "通知已不存在");
    if (notice.read || this.imported.has(id) || this.muted.get(id)?.has(destination)) return false;
    const delivered = this.deliveries.get(id) ?? new Set<string>();
    if (delivered.has(destination)) return false;
    if (delivered.size >= 32) throw new HttpError(429, "通知接收端过多");
    delivered.add(destination); this.deliveries.set(id, delivered); return true;
  }
  private publish(): void { for (const listener of this.listeners) listener(); }
  listen(res: ServerResponse, session: Session): void {
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
    const write = () => {
      if (res.writableLength > MAX_FRAME) { res.destroy(); return; }
      res.write(`data: ${JSON.stringify(this.snapshot())}\n\n`);
    };
    const close = () => { clearInterval(timer); this.listeners.delete(write); session.close.delete(close); res.end(); };
    const timer = setInterval(() => res.write(": heartbeat\n\n"), 15_000); timer.unref();
    this.listeners.add(write); session.close.add(close); res.once("close", close); write();
  }
}
export async function notificationRoute(url: URL, req: IncomingMessage, res: ServerResponse, origin: string, auth: Auth, center: NotificationCenter, receivers: NodeNotifications): Promise<boolean> {
  if (url.pathname !== "/_hub/notifications" && !url.pathname.startsWith("/_hub/notifications/")) return false;
  const session = auth.require(req);
  if (req.headers["sec-fetch-site"] === "cross-site") throw new HttpError(403, "不允许跨站访问");
  if (req.method === "GET" && url.pathname === "/_hub/notifications") { reply(res, 200, center.snapshot()); return true; }
  if (req.method === "GET" && url.pathname === "/_hub/notifications/events") { center.listen(res, session); return true; }
  auth.checkOrigin(req, origin);
  if (req.method !== "POST") throw new HttpError(405, "不支持此通知操作");
  const body = await readJson(req);
  if (!object(body)) throw new HttpError(400, "无效的通知操作");
  if (url.pathname === "/_hub/notifications/receiver" && isNotificationDestination(body.destination) && (body.deviceId === null || isNotificationDestination(body.deviceId))) {
    await receivers.bind(body.deviceId, body.destination); reply(res, 200, { ok: true }); return true;
  }
  if (url.pathname === "/_hub/notifications/presence" && typeof body.pageId === "string" && /^[a-f0-9]{32}$/.test(body.pageId) && typeof body.sequence === "number" && Number.isSafeInteger(body.sequence) && body.sequence >= 0 &&
    typeof body.deviceId === "string" && /^[a-f0-9-]{36}$/.test(body.deviceId) && (body.sessionId === null || typeof body.sessionId === "string" && body.sessionId.length <= 128) && typeof body.destination === "string" && /^[a-f0-9-]{36}$/.test(body.destination) && typeof body.focused === "boolean") {
    center.attend(session, body.pageId, body.sequence, body.deviceId, body.sessionId, body.destination, body.focused); reply(res, 200, { ok: true, nodeNotifications: receivers.activeDestination(body.destination) }); return true;
  }
  if (url.pathname === "/_hub/notifications/read" && (body.id === null || typeof body.id === "string")) { center.read(body.id); reply(res, 200, { ok: true }); return true; }
  if (url.pathname === "/_hub/notifications/claim" && typeof body.id === "string" && typeof body.destination === "string" && /^[a-f0-9-]{36}$/.test(body.destination)) {
    reply(res, 200, { claimed: center.claim(body.id, body.destination) }); return true;
  }
  throw new HttpError(400, "无效的通知操作");
}
