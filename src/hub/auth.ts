import type { IncomingMessage, ServerResponse } from "node:http";
import { secret } from "./store.ts";
import { HttpError } from "../shared/http.ts";

const COOKIE = "opi_hub_session";
const TTL = 12 * 60 * 60 * 1000;
export interface Session { id: string; expires: number; close: Set<() => void> }
export class Auth {
  private sessions = new Map<string, Session>();
  private attempts = new Map<string, { count: number; until: number }>();
  private timer = setInterval(() => this.collect(), 60_000);
  constructor() { this.timer.unref(); }
  get(req: IncomingMessage): Session | undefined {
    const token = req.headers.cookie?.split(";").map((item) => item.trim()).find((item) => item.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    const session = token ? this.sessions.get(token) : undefined;
    if (session && session.expires > Date.now()) return session;
    if (session) this.drop(session);
    return undefined;
  }
  require(req: IncomingMessage): Session {
    const session = this.get(req);
    if (!session) throw new HttpError(401, "请先登录");
    return session;
  }
  checkOrigin(req: IncomingMessage, origin: string): void {
    if (req.headers.origin !== origin) throw new HttpError(403, "来源不匹配");
  }
  attempt(req: IncomingMessage): void {
    const now = Date.now();
    this.collect();
    const key = req.socket.remoteAddress ?? "unknown";
    const previous = this.attempts.get(key);
    const value = previous && previous.until > now ? previous : { count: 0, until: now + 15 * 60_000 };
    if (value.count >= 10) throw new HttpError(429, "尝试次数过多，请在 15 分钟后重试");
    if (this.attempts.size >= 10_000 && !this.attempts.has(key)) throw new HttpError(429, "登录请求过多");
    value.count++;
    this.attempts.set(key, value);
  }
  login(req: IncomingMessage, res: ServerResponse, secure: boolean): void {
    const previous = this.get(req);
    if (previous) this.drop(previous);
    const session: Session = { id: secret(), expires: Date.now() + TTL, close: new Set() };
    this.sessions.set(session.id, session);
    res.setHeader("Set-Cookie", `${COOKIE}=${session.id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${TTL / 1000}${secure ? "; Secure" : ""}`);
    if (req.socket.remoteAddress) this.attempts.delete(req.socket.remoteAddress);
  }
  logout(req: IncomingMessage, res: ServerResponse, secure: boolean): void {
    const session = this.get(req);
    if (session) this.drop(session);
    res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`);
  }
  private drop(session: Session): void {
    this.sessions.delete(session.id);
    for (const close of session.close) close();
    session.close.clear();
  }
  private collect(): void {
    const now = Date.now();
    for (const session of this.sessions.values()) if (session.expires <= now) this.drop(session);
    for (const [key, value] of this.attempts) if (value.until <= now) this.attempts.delete(key);
  }
  close(): void { clearInterval(this.timer); for (const session of this.sessions.values()) this.drop(session); }
}
