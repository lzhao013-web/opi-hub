import type { PlanDefinition, ScheduleRun } from "../../shared/schedules.ts";
import { executingTask } from "../../shared/tasks.ts";
import type { Nodes } from "../nodes.ts";
import { TaskRejectedError } from "../session-requests.ts";
import { ScheduleStore } from "./store.ts";
import { intervalExpired } from "./interval.ts";

type TaskNodes = Pick<Nodes, "taskAvailability" | "taskOnline" | "task" | "startTask" | "cancelTask" | "acknowledgeTask">;
export class Scheduler {
  private store: ScheduleStore; private nodes: TaskNodes; private now: () => number; private hasDevice: (id: string) => boolean;
  private timer: ReturnType<typeof setInterval> | undefined; private stopped = false; private work = new Set<Promise<void>>();
  error: string | null = null;
  constructor(store: ScheduleStore, nodes: TaskNodes, hasDevice: (id: string) => boolean, now = Date.now) { this.store = store; this.nodes = nodes; this.hasDevice = hasDevice; this.now = now; this.store.recover(now()); }
  start(): void { this.timer = setInterval(() => this.tick(), 1000); }
  snapshot() {
    const runs = [...new Map([...this.store.unresolved(), ...this.store.runs()].map((run) => [run.id, run])).values()]
      .sort((a, b) => Number(b.state === "unknown" || executingTask(b.state) || b.state === "dispatching") - Number(a.state === "unknown" || executingTask(a.state) || a.state === "dispatching") || b.scheduledAt.localeCompare(a.scheduledAt));
    return { plans: this.store.plans(), runs, error: this.error };
  }
  resultRun(id: string): ScheduleRun | undefined { return this.store.run(id); }
  summary() { const runs = this.store.unresolved(); return { active: runs.filter((run) => run.state !== "unknown").length, unknown: runs.filter((run) => run.state === "unknown").length, error: this.error }; }
  add(input: PlanDefinition) { if (!this.hasDevice(input.deviceId)) throw new Error("设备不存在"); return this.store.add(input, this.now()); }
  enable(id: string, value: boolean): void { const plan = this.store.plan(id); if (value && (!plan || !this.hasDevice(plan.deviceId))) throw new Error("设备不存在"); this.store.enabled(id, value, this.now()); }
  remove(id: string): void { this.store.archive(id); }
  removeDevice(id: string): void { this.store.disableDevice(id); }
  tick(): void {
    if (this.stopped) return;
    try {
      this.reconcile();
      const now = this.now();
      for (const plan of this.store.due(now)) if (plan.nextAt) {
        const late = intervalExpired(plan.rule, Date.parse(plan.nextAt), now) ? "所属时间段已结束，未补跑" :
          now - Date.parse(plan.nextAt) > 30_000 ? "中心未及时扫描到期时间，未补跑" : undefined;
        const run = this.store.claim(plan.id, plan.nextAt, "timer", now, this.hasDevice(plan.deviceId) ? this.nodes.taskAvailability(plan.deviceId) : "设备已移除", late);
        if (run?.state === "dispatching") this.launch(run);
      }
      this.error = null;
    } catch (error) { this.error = error instanceof Error ? error.message : String(error); }
  }
  private reconcile(): void {
    for (const run of this.store.unresolved()) {
      const actual = this.nodes.task(run.deviceId, run.id);
      if (actual) this.store.apply(run.id, actual, this.now());
      else if (run.state !== "unknown" && (run.nodeRevision >= 0 || this.nodes.taskAvailability(run.deviceId) !== null || this.now() - Date.parse(run.updatedAt) > 10_000)) this.store.mark(run.id, "unknown", "节点状态缺失或连接中断，等待回报，不会重新下发", this.now());
    }
  }
  private launch(run: ScheduleRun): void {
    const operation = this.dispatch(run).catch((error: unknown) => { this.error = error instanceof Error ? error.message : String(error); }).finally(() => this.work.delete(operation)); this.work.add(operation);
  }
  private async dispatch(run: ScheduleRun): Promise<void> {
    try {
      const plan = this.store.plan(run.planId); if (!plan) throw new Error("运行对应的计划缺失");
      await this.nodes.startTask(run.deviceId, { id: run.id, name: plan.name, path: plan.path, prompt: plan.prompt, timeoutSeconds: plan.timeoutSeconds, ...(plan.model ? { model: plan.model } : {}) }, AbortSignal.timeout(25_000));
    } catch (error) {
      if (!this.stopped) this.store.mark(run.id, error instanceof TaskRejectedError ? "failed" : "unknown", error instanceof Error ? error.message : String(error), this.now());
    }
  }
  runNow(id: string): ScheduleRun {
    if (this.stopped) throw new Error("计划任务中心正在关闭");
    this.reconcile(); const plan = this.store.plan(id); if (!plan || !this.hasDevice(plan.deviceId)) throw new Error("计划或设备不存在");
    const run = this.store.claim(id, new Date(this.now()).toISOString(), "manual", this.now(), this.nodes.taskAvailability(plan.deviceId));
    if (!run) throw new Error("计划不可执行"); this.launch(run); return run;
  }
  async cancel(id: string, signal: AbortSignal): Promise<void> {
    this.reconcile(); const run = this.store.run(id); if (!run || !(executingTask(run.state) || run.state === "dispatching" || run.state === "unknown")) throw new Error("此运行已结束");
    await this.nodes.cancelTask(run.deviceId, id, signal); if (!this.stopped) this.reconcile();
  }
  async acknowledge(id: string, signal: AbortSignal): Promise<void> {
    this.reconcile(); const run = this.store.run(id); if (!run || run.state !== "unknown") throw new Error("仅未确认的运行需要人工核对");
    if (this.hasDevice(run.deviceId)) {
      if (!this.nodes.taskOnline(run.deviceId)) throw new Error("请等待节点就绪后核对；离线时无法确认原运行状态");
      await this.nodes.acknowledgeTask(run.deviceId, id, signal);
    }
    if (!this.stopped) this.store.mark(id, "abandoned", "用户确认原任务已结束，未发送任务重试或远程停止指令", this.now());
  }
  stop(): void { this.stopped = true; clearInterval(this.timer); }
  async close(): Promise<void> { this.stop(); await Promise.allSettled([...this.work]); this.store.close(); }
}
