import { DatabaseSync } from "node:sqlite";
import { chmod } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { object } from "../../shared/protocol.ts";
import { isPlan, isRun, type Plan, type PlanDefinition, type ScheduleRun } from "../../shared/schedules.ts";
import { blockingTask, executingTask, type TaskRecord } from "../../shared/tasks.ts";
import { nextOccurrence } from "./time.ts";

const blockers = "'dispatching','creating','running','waiting','unknown'";
function decode<T>(row: unknown, check: (value: unknown) => value is T): T {
  if (!object(row) || typeof row.payload !== "string") throw new Error("计划数据库记录损坏");
  const value: unknown = JSON.parse(row.payload); if (!check(value)) throw new Error("计划数据库结构不匹配"); return value;
}
export class ScheduleStore {
  private db: DatabaseSync; private lease: DatabaseSync; private closed = false;
  private constructor(db: DatabaseSync, lease: DatabaseSync) { this.db = db; this.lease = lease; }
  static async open(directory: string): Promise<ScheduleStore> {
    const lockFile = path.join(directory, "schedule-lock.sqlite"); const lease = new DatabaseSync(lockFile);
    try { await chmod(lockFile, 0o600); lease.exec("PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS owner(id INTEGER); BEGIN EXCLUSIVE;"); }
    catch (error) { lease.close(); if (object(error) && (error.errcode === 5 || error.errcode === 6)) throw new Error("此数据目录已有计划任务中心运行，请勿重复启动"); throw error; }
    let db: DatabaseSync | undefined;
    try {
      const file = path.join(directory, "schedules.sqlite"); db = new DatabaseSync(file);
      await chmod(file, 0o600);
      db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
      const version = db.prepare("PRAGMA user_version").get();
      if (version?.user_version !== 0 && version?.user_version !== 1) throw new Error("不支持的计划数据库版本");
      db.exec(`CREATE TABLE IF NOT EXISTS plans(id TEXT PRIMARY KEY, next_at TEXT, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, trigger_key TEXT UNIQUE NOT NULL, plan_id TEXT NOT NULL, device_id TEXT NOT NULL, scheduled_at TEXT NOT NULL, state TEXT NOT NULL, payload TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS due_plans ON plans(next_at);
        CREATE INDEX IF NOT EXISTS run_state ON runs(state, device_id);
        PRAGMA user_version=1;`);
      return new ScheduleStore(db, lease);
    } catch (error) { db?.close(); lease.close(); throw error; }
  }
  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const value = operation(); this.db.exec("COMMIT"); return value; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  plans(includeArchived = false): Plan[] { return this.db.prepare("SELECT payload FROM plans").all().map((row) => decode(row, isPlan)).filter((plan) => includeArchived || !plan.archived); }
  plan(id: string): Plan | undefined { const row = this.db.prepare("SELECT payload FROM plans WHERE id=?").get(id); return row ? decode(row, isPlan) : undefined; }
  run(id: string): ScheduleRun | undefined { const row = this.db.prepare("SELECT payload FROM runs WHERE id=?").get(id); return row ? decode(row, isRun) : undefined; }
  runs(limit = 50): ScheduleRun[] { return this.db.prepare("SELECT payload FROM runs ORDER BY scheduled_at DESC, rowid DESC LIMIT ?").all(limit).map((row) => decode(row, isRun)); }
  unresolved(): ScheduleRun[] { return this.db.prepare(`SELECT payload FROM runs WHERE state IN (${blockers})`).all().map((row) => decode(row, isRun)); }
  private savePlan(plan: Plan): void { this.db.prepare("INSERT INTO plans(id,next_at,payload) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET next_at=excluded.next_at,payload=excluded.payload").run(plan.id, plan.enabled && !plan.archived ? plan.nextAt : null, JSON.stringify(plan)); }
  private saveRun(run: ScheduleRun): void { this.db.prepare("UPDATE runs SET state=?,payload=? WHERE id=?").run(run.state, JSON.stringify(run), run.id); }
  add(definition: PlanDefinition, now: number): Plan {
    const nextAt = nextOccurrence(definition.rule, now); if (!nextAt) throw new Error("计划没有未来可执行的时刻");
    const plan: Plan = { name: definition.name, deviceId: definition.deviceId, path: definition.path, prompt: definition.prompt, timeoutSeconds: definition.timeoutSeconds, rule: structuredClone(definition.rule), ...(definition.model ? { model: { provider: definition.model.provider, id: definition.model.id } } : {}), id: randomUUID(), enabled: true, archived: false, nextAt, createdAt: new Date(now).toISOString() };
    this.transaction(() => this.savePlan(plan)); return plan;
  }
  enabled(id: string, enabled: boolean, now: number): void {
    this.transaction(() => {
      const plan = this.plan(id); if (!plan || plan.archived) throw new Error("计划不存在");
      const nextAt = enabled ? nextOccurrence(plan.rule, now) : null; if (enabled && !nextAt) throw new Error("计划已无未来执行时刻，不能补跑；可明确选择立即执行");
      this.savePlan({ ...plan, enabled, nextAt });
    });
  }
  archive(id: string): void {
    this.transaction(() => {
      const plan = this.plan(id); if (!plan || plan.archived) throw new Error("计划不存在");
      if (this.db.prepare(`SELECT id FROM runs WHERE plan_id=? AND state IN (${blockers}) LIMIT 1`).get(id)) throw new Error("请先结束或核对尚未确认的运行");
      this.savePlan({ ...plan, enabled: false, archived: true, nextAt: null });
    });
  }
  disableDevice(deviceId: string): void { this.transaction(() => { for (const plan of this.plans()) if (plan.deviceId === deviceId) this.savePlan({ ...plan, enabled: false, nextAt: null }); }); }
  due(now: number): Plan[] { return this.db.prepare("SELECT payload FROM plans WHERE next_at<=? ORDER BY next_at,id").all(new Date(now).toISOString()).map((row) => decode(row, isPlan)); }
  /** 推进时间与写入触发记录同一事务完成，记录落盘后调用方才允许下发。 */
  claim(id: string, due: string, trigger: "timer" | "manual", now: number, unavailable: string | null, missed?: string): ScheduleRun | undefined {
    return this.transaction(() => {
      const plan = this.plan(id); if (!plan || plan.archived || trigger === "timer" && (!plan.enabled || plan.nextAt !== due)) return undefined;
      const runId = randomUUID(); const key = trigger === "timer" ? `timer:${id}:${due}` : `manual:${runId}`;
      if (this.db.prepare("SELECT id FROM runs WHERE trigger_key=?").get(key)) return undefined;
      if (trigger === "timer") {
        const nextAt = nextOccurrence(plan.rule, now); this.savePlan({ ...plan, nextAt, enabled: nextAt !== null });
      }
      const blocked = this.db.prepare(`SELECT id FROM runs WHERE (plan_id=? OR device_id=?) AND state IN (${blockers}) LIMIT 1`).get(plan.id, plan.deviceId);
      if (trigger === "manual" && (blocked || unavailable)) throw new Error(blocked ? "此计划或设备仍有运行未结束或未确认" : unavailable ?? "设备未就绪");
      const state = missed ? "missed" : blocked ? "skipped" : unavailable ? "missed" : "dispatching";
      const run: ScheduleRun = { id: runId, planId: plan.id, name: plan.name, deviceId: plan.deviceId, path: plan.path, ...(plan.model ? { model: { ...plan.model } } : {}), scheduledAt: due, trigger, state,
        session: null, file: null, replyId: null, message: missed ?? (blocked ? "上次运行未结束或结果未确认，未重复启动" : unavailable ?? ""), nodeRevision: -1, updatedAt: new Date(now).toISOString() };
      this.db.prepare("INSERT INTO runs(id,trigger_key,plan_id,device_id,scheduled_at,state,payload) VALUES(?,?,?,?,?,?,?)").run(run.id, key, plan.id, plan.deviceId, due, run.state, JSON.stringify(run));
      return run;
    });
  }
  mark(id: string, state: "unknown" | "failed" | "abandoned", message: string, now: number): void {
    this.transaction(() => { const run = this.run(id); if (!run || !blockingTask(run.state)) return; this.saveRun({ ...run, state, message, updatedAt: new Date(now).toISOString() }); });
  }
  apply(id: string, record: TaskRecord, now: number): void {
    this.transaction(() => {
      const run = this.run(id); if (!run || !blockingTask(run.state) || record.revision < run.nodeRevision || record.revision === run.nodeRevision && run.state !== "unknown") return;
      this.saveRun({ ...run, state: record.state, session: record.session, file: record.file, replyId: record.replyId, message: record.message, nodeRevision: record.revision, updatedAt: new Date(now).toISOString() });
    });
  }
  recover(now: number): void {
    for (const run of this.unresolved()) if (run.state === "dispatching" || executingTask(run.state)) this.mark(run.id, "unknown", "中心已重启，等待节点回报；不会重新下发", now);
    for (const plan of this.due(now)) if (plan.nextAt) this.claim(plan.id, plan.nextAt, "timer", now, null, "中心未运行期间错过，未补跑");
  }
  close(): void { if (this.closed) return; this.closed = true; this.db.close(); this.lease.close(); }
}
