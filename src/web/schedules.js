import { create, sessionUrl } from "./management.js";

const $ = (id) => document.getElementById(id);
const labels = { dispatching: "正在下发", creating: "准备会话", running: "运行中", waiting: "等待交互", completed: "已结束", failed: "失败", cancelled: "已取消", timed_out: "已超时", unknown: "待核对", abandoned: "已核对结束", missed: "已错过", skipped: "未重复启动" };
const unresolved = (state) => ["dispatching", "creating", "running", "waiting", "unknown"].includes(state);
function ruleLabel(rule) {
  if (rule.kind === "once") return `${rule.local.replace("T", " ")} · ${rule.timeZone}`;
  if (rule.kind === "interval") return `${rule.start.replace("T", " ")} 至 ${rule.end.replace("T", " ")} · 每 ${rule.minutes} 分钟 · ${rule.timeZone}`;
  if (rule.kind === "dailyInterval") return `每天 ${rule.start}–${rule.end < rule.start ? "次日 " : ""}${rule.end} · 每 ${rule.minutes} 分钟 · ${rule.timeZone}`;
  const days = ["", "一", "二", "三", "四", "五", "六", "日"];
  return `${rule.kind === "daily" ? "每天" : `每周${rule.days.map((day) => days[day]).join("、")}`} ${rule.time} · ${rule.timeZone}`;
}
export class ScheduleView {
  constructor(request) {
    this.request = request; this.devices = []; this.data = { plans: [], runs: [], error: null }; this.visible = false; this.loading = false; this.generation = 0;
    this.planBusy = new Set(); this.runBusy = new Set(); this.confirming = null; this.saving = false;
    $("schedule-close").addEventListener("click", () => $("schedule-dialog").close());
    $("schedule-kind").addEventListener("change", () => this.ruleFields());
    $("schedule-form").addEventListener("submit", (event) => { event.preventDefault(); void this.save(); });
    $("schedule-confirm").addEventListener("close", () => { this.confirming = null; });
    $("schedule-confirm-cancel").addEventListener("click", () => $("schedule-confirm").close());
    $("schedule-confirm-form").addEventListener("submit", (event) => { event.preventDefault(); void this.confirm(); });
  }
  clear() {
    this.generation++; clearTimeout(this.timer); this.controller?.abort(); this.visible = false; this.loading = false; this.saving = false;
    this.data = { plans: [], runs: [], error: null }; this.devices = []; this.planBusy.clear(); this.runBusy.clear(); this.confirming = null; $("schedule-form").reset();
    $("schedule-plans").replaceChildren(); $("schedule-runs").replaceChildren(); delete $("schedule-plans").dataset.signature; delete $("schedule-runs").dataset.signature;
  }
  update(data, visible) {
    this.devices = data.devices; this.deviceOptions();
    if (visible && !this.visible) { this.visible = true; void this.reload(); }
    else if (!visible && this.visible) { this.visible = false; clearTimeout(this.timer); this.timer = undefined; }
    if (visible && !document.hidden && !this.loading && !this.timer) void this.reload();
    if (visible) this.render();
  }
  async reload() {
    clearTimeout(this.timer); this.timer = undefined; if (this.loading) return;
    this.loading = true; const generation = this.generation; const controller = new AbortController(); this.controller = controller;
    try {
      const data = await this.request("/_hub/schedules", { signal: controller.signal });
      if (generation !== this.generation) return;
      this.data = data; $("schedule-page-error").hidden = !data.error; $("schedule-page-error").textContent = data.error ?? ""; this.render();
    } catch (error) { if (!controller.signal.aborted && generation === this.generation) { $("schedule-page-error").textContent = error.message; $("schedule-page-error").hidden = false; } }
    finally { if (generation === this.generation) { this.loading = false; if (this.visible && !document.hidden) this.timer = setTimeout(() => { this.timer = undefined; void this.reload(); }, 2000); } }
  }
  deviceOptions() {
    const root = $("schedule-device"); const signature = JSON.stringify(this.devices.map((device) => [device.id, device.name, device.connected]));
    if (root.dataset.signature === signature) return;
    const previous = root.value; root.dataset.signature = signature; root.replaceChildren();
    const empty = create("option", "", "选择设备"); empty.value = ""; root.append(empty);
    for (const device of this.devices) { const option = create("option", "", device.name + (device.connected ? "" : "（当前离线）")); option.value = device.id; root.append(option); }
    if ([...root.options].some((option) => option.value === previous)) root.value = previous;
  }
  open(scope) {
    this.deviceOptions(); $("schedule-device").value = scope?.deviceId ?? ""; $("schedule-path").value = scope?.cwd ?? "";
    $("schedule-name").value = ""; $("schedule-prompt").value = ""; $("schedule-timeout").value = "30"; $("schedule-kind").value = "once";
    $("schedule-zone").value = Intl.DateTimeFormat().resolvedOptions().timeZone;
    $("schedule-local").value = ""; $("schedule-time").value = "09:00";
    $("schedule-range-start").value = ""; $("schedule-range-end").value = "";
    $("schedule-window-start").value = "09:00"; $("schedule-window-end").value = "18:00"; $("schedule-minutes").value = "15";
    for (const input of $("schedule-days").querySelectorAll("input")) input.checked = input.value === "1";
    $("schedule-form-error").hidden = true; this.ruleFields(); $("schedule-submit").disabled = false; $("schedule-dialog").showModal(); $("schedule-name").focus();
  }
  ruleFields() {
    const kind = $("schedule-kind").value; const interval = kind === "interval" || kind === "dailyInterval";
    $("schedule-once").hidden = kind !== "once"; $("schedule-repeat").hidden = kind !== "daily" && kind !== "weekly"; $("schedule-days").hidden = kind !== "weekly";
    $("schedule-interval").hidden = !interval; $("schedule-range").hidden = kind !== "interval"; $("schedule-window").hidden = kind !== "dailyInterval";
    for (const [id, enabled] of [["schedule-local", kind === "once"], ["schedule-time", kind === "daily" || kind === "weekly"],
      ["schedule-range-start", kind === "interval"], ["schedule-range-end", kind === "interval"],
      ["schedule-window-start", kind === "dailyInterval"], ["schedule-window-end", kind === "dailyInterval"], ["schedule-minutes", interval]]) {
      $(id).required = enabled; $(id).disabled = !enabled;
    }
  }
  async save() {
    if (this.saving) return; this.saving = true; const generation = this.generation; $("schedule-submit").disabled = true; $("schedule-form-error").hidden = true;
    const kind = $("schedule-kind").value; const timeZone = $("schedule-zone").value;
    const rule = { kind, timeZone };
    if (kind === "once") rule.local = $("schedule-local").value;
    else if (kind === "interval" || kind === "dailyInterval") {
      const prefix = kind === "interval" ? "schedule-range" : "schedule-window";
      rule.start = $(`${prefix}-start`).value; rule.end = $(`${prefix}-end`).value; rule.minutes = Number($("schedule-minutes").value);
    } else {
      rule.time = $("schedule-time").value;
      if (kind === "weekly") rule.days = [...$("schedule-days").querySelectorAll("input:checked")].map((input) => Number(input.value));
    }
    try {
      await this.request("/_hub/schedules", { method: "POST", body: JSON.stringify({ name: $("schedule-name").value, deviceId: $("schedule-device").value, path: $("schedule-path").value, prompt: $("schedule-prompt").value, timeoutSeconds: Number($("schedule-timeout").value) * 60, rule }) });
      if (generation !== this.generation) return;
      $("schedule-dialog").close(); document.getElementById("schedules-nav").click(); await this.reload();
    } catch (error) { if (generation === this.generation) { $("schedule-form-error").textContent = error.message; $("schedule-form-error").hidden = false; } }
    finally { if (generation === this.generation) { this.saving = false; $("schedule-submit").disabled = false; } }
  }
  async action(key, path, options, busy) {
    if (busy.has(key)) return; busy.add(key); this.render(); const generation = this.generation;
    try { await this.request(path, options); if (generation === this.generation) await this.reload(); }
    catch (error) { if (generation === this.generation) { $("schedule-page-error").textContent = error.message; $("schedule-page-error").hidden = false; } }
    finally { if (generation === this.generation) { busy.delete(key); this.render(); } }
  }
  ask(text, operation) { this.confirming = operation; $("schedule-confirm-text").textContent = text; $("schedule-confirm").showModal(); }
  async confirm() { const operation = this.confirming; $("schedule-confirm").close(); if (operation) await operation(); }
  render() {
    const devices = new Map(this.devices.map((device) => [device.id, device])); const plans = $("schedule-plans"); const runs = $("schedule-runs");
    const planSignature = JSON.stringify([this.data.plans, [...this.planBusy], this.data.runs.filter((run) => unresolved(run.state)), this.devices.map((device) => [device.id, device.name, device.report?.ready])]);
    if (plans.dataset.signature !== planSignature) {
      plans.dataset.signature = planSignature; plans.replaceChildren();
      if (!this.data.plans.length) plans.append(create("p", "management-empty muted", "还没有计划任务。新建后在指定时间启动独立会话。"));
      for (const plan of this.data.plans) {
        const card = create("article", "plan-card"); card.dataset.planId = plan.id;
        const heading = create("div", "session-row-heading"); heading.append(create("h2", "", plan.name), create("span", "session-state", plan.enabled ? "已启用" : "已暂停"));
        card.append(heading, create("p", "session-location", `${devices.get(plan.deviceId)?.name ?? "设备已移除"} · ${plan.path}`), create("p", "", ruleLabel(plan.rule)), create("p", "muted", plan.nextAt && plan.enabled ? `下次：${new Date(plan.nextAt).toLocaleString()} · 最长 ${plan.timeoutSeconds} 秒` : `无自动触发 · 最长 ${plan.timeoutSeconds} 秒`));
        const details = create("details"); details.append(create("summary", "", "任务描述"), create("pre", "", plan.prompt)); card.append(details);
        const actions = create("div", "plan-actions");
        const button = (text, callback, disabled = false) => { const node = create("button", "secondary", text); node.type = "button"; node.disabled = disabled || this.planBusy.has(plan.id); node.addEventListener("click", callback); actions.append(node); };
        button(plan.enabled ? "暂停计划" : "启用计划", () => { void this.action(plan.id, `/_hub/schedules/${plan.id}/enable`, { method: "POST", body: JSON.stringify({ enabled: !plan.enabled }) }, this.planBusy); });
        const blocked = this.data.runs.some((run) => unresolved(run.state) && (run.planId === plan.id || run.deviceId === plan.deviceId));
        button("立即执行", () => this.ask(`立即在 ${devices.get(plan.deviceId)?.name ?? plan.deviceId} 的 ${plan.path} 新建会话执行“${plan.name}”？仍遵循审批规则。`, () => this.action(plan.id, `/_hub/schedules/${plan.id}/run`, { method: "POST", body: "{}" }, this.planBusy)), blocked || !devices.get(plan.deviceId)?.report?.ready);
        button("删除计划", () => this.ask(`删除“${plan.name}”？已保存的运行记录保留，正在执行的任务不会因此停止。`, () => this.action(plan.id, `/_hub/schedules/${plan.id}`, { method: "DELETE" }, this.planBusy)), this.data.runs.some((run) => run.planId === plan.id && unresolved(run.state)));
        card.append(actions); plans.append(card);
      }
    }
    const signature = JSON.stringify([this.data.runs, [...this.runBusy], this.devices.map((device) => [device.id, device.management?.state])]);
    if (runs.dataset.signature === signature) return; runs.dataset.signature = signature; runs.replaceChildren();
    if (!this.data.runs.length) runs.append(create("p", "management-empty muted", "暂无运行记录。"));
    for (const run of this.data.runs) {
      const card = create("article", "run-card"); card.dataset.runId = run.id;
      const heading = create("div", "session-row-heading"); heading.append(create("h2", "", run.name), create("span", `session-state ${run.state}`, labels[run.state]));
      card.append(heading, create("p", "session-location", `${devices.get(run.deviceId)?.name ?? "设备已移除"} · ${run.path}`), create("p", "muted", `${new Date(run.scheduledAt).toLocaleString()} · ${run.trigger === "timer" ? "定时触发" : "手动执行"}`));
      if (run.message) card.append(create("p", "run-message", run.message));
      const actions = create("div", "plan-actions");
      if (run.session && devices.get(run.deviceId)?.management.state === "ready") {
        const open = create("a", "secondary", "查看会话 ↗"); open.target = "_blank"; open.rel = "noopener";
        open.href = sessionUrl(run.deviceId, run.file ? { path: run.file } : { id: run.session.id }); actions.append(open);
      }
      if (unresolved(run.state)) {
        const cancel = create("button", "secondary", "取消运行"); cancel.type = "button"; cancel.disabled = this.runBusy.has(run.id) || !devices.get(run.deviceId)?.report?.ready;
        cancel.addEventListener("click", () => this.ask("取消会尝试停止这个专用会话，不暂停计划。无法确认停止时仍需核对，不会自动重跑。", () => this.action(run.id, `/_hub/runs/${run.id}/cancel`, { method: "POST", body: "{}" }, this.runBusy))); actions.append(cancel);
      }
      if (run.state === "unknown") {
        const acknowledge = create("button", "secondary", "确认已结束"); acknowledge.type = "button"; acknowledge.disabled = this.runBusy.has(run.id);
        acknowledge.addEventListener("click", () => this.ask("请先在设备上核对原任务确实已结束。此操作不会发送停止指令，只解除后续计划的阻塞；误确认可能导致并发执行。", () => this.action(run.id, `/_hub/runs/${run.id}/acknowledge`, { method: "POST", body: "{}" }, this.runBusy))); actions.append(acknowledge);
      }
      card.append(actions); runs.append(card);
    }
  }
}
