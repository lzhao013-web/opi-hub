import { TaskResults } from "./task-results.js";
import { create, sessionUrl } from "./management.js";
import { workspaceName } from "./navigation.js";

const $ = (id) => document.getElementById(id);
const labels = { dispatching: "正在下发", creating: "准备会话", running: "运行中", waiting: "等待交互", completed: "已结束", failed: "失败", cancelled: "已取消", timed_out: "已超时", unknown: "待核对", abandoned: "已核对结束", missed: "已错过", skipped: "未重复启动" };
const unresolved = (state) => ["dispatching", "creating", "running", "waiting", "unknown"].includes(state);
const modelLabel = (model) => model ? `${model.provider}/${model.id}` : "沿用设备默认";
const timeLabel = (date) => date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const fullTime = (value) => new Date(value).toLocaleString("zh-CN", { hourCycle: "h23" });
function dayGroup(value) {
  const date = new Date(value); const today = new Date(); const yesterday = new Date(); yesterday.setDate(today.getDate() - 1);
  return { key: date.toDateString(), label: date.toDateString() === today.toDateString() ? "今天" : date.toDateString() === yesterday.toDateString() ? "昨天"
    : date.toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" }) };
}
function placeChildren(root, children) {
  const retained = new Set(children);
  for (const child of [...root.children]) if (!retained.has(child)) child.remove();
  children.forEach((child, index) => { if (root.children[index] !== child) root.insertBefore(child, root.children[index] ?? null); });
}
function ruleLabel(rule) {
  if (rule.kind === "once") return `${rule.local.replace("T", " ")} · ${rule.timeZone}`;
  if (rule.kind === "interval") return `${rule.start.replace("T", " ")} 至 ${rule.end.replace("T", " ")} · 每 ${rule.minutes} 分钟 · ${rule.timeZone}`;
  if (rule.kind === "dailyInterval") return `每天 ${rule.start}–${rule.end < rule.start ? "次日 " : ""}${rule.end} · 每 ${rule.minutes} 分钟 · ${rule.timeZone}`;
  const days = ["", "一", "二", "三", "四", "五", "六", "日"];
  return `${rule.kind === "daily" ? "每天" : `每周${rule.days.map((day) => days[day]).join("、")}`} ${rule.time} · ${rule.timeZone}`;
}
export class ScheduleView {
  constructor(request) {
    this.results = new TaskResults();
    this.request = request; this.devices = []; this.data = { plans: [], runs: [], error: null }; this.visible = false; this.loading = false; this.generation = 0;
    this.planBusy = new Set(); this.runBusy = new Set(); this.confirming = null; this.saving = false;
    this.runCards = new Map(); this.runGroups = new Map(); this.runDetails = new Set();
    $("schedule-close").addEventListener("click", () => $("schedule-dialog").close());
    $("schedule-kind").addEventListener("change", () => this.ruleFields());
    $("schedule-device").addEventListener("change", () => this.modelOptions(true));
    $("schedule-form").addEventListener("submit", (event) => { event.preventDefault(); void this.save(); });
    $("schedule-confirm").addEventListener("close", () => { this.confirming = null; });
    $("schedule-confirm-cancel").addEventListener("click", () => $("schedule-confirm").close());
    $("schedule-confirm-form").addEventListener("submit", (event) => { event.preventDefault(); void this.confirm(); });
  }
  clear() {
    this.results.clear(); this.runCards.clear(); this.runGroups.clear(); this.runDetails.clear(); this.highlightedRun = null;
    this.generation++; clearTimeout(this.timer); this.controller?.abort(); this.visible = false; this.loading = false; this.saving = false;
    this.data = { plans: [], runs: [], error: null }; this.devices = []; this.planBusy.clear(); this.runBusy.clear(); this.confirming = null; this.pinnedRun = null; this.focusedRun = null; $("schedule-form").reset(); this.modelOptions(true);
    $("schedule-plans").replaceChildren(); $("schedule-runs").replaceChildren(); delete $("schedule-plans").dataset.signature; delete $("schedule-runs").dataset.signature;
  }
  update(data, visible) {
    this.devices = data.devices; this.deviceOptions(); this.modelOptions(); this.results.update(data.devices, visible);
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
      if (this.pinnedRun && !data.runs.some((run) => run.id === this.pinnedRun.id)) data.runs.unshift(this.pinnedRun);
      this.data = data; $("schedule-page-error").hidden = !data.error; $("schedule-page-error").textContent = data.error ?? ""; this.render();
    } catch (error) { if (!controller.signal.aborted && generation === this.generation) { $("schedule-page-error").textContent = error.message; $("schedule-page-error").hidden = false; } }
    finally { if (generation === this.generation) { this.loading = false; if (this.visible && !document.hidden) this.timer = setTimeout(() => { this.timer = undefined; void this.reload(); }, 2000); } }
  }
  async focusRun(id) {
    const generation = this.generation;
    try {
      const run = await this.request(`/_hub/runs/${encodeURIComponent(id)}`);
      if (generation !== this.generation) return;
      this.pinnedRun = run; this.focusedRun = id; this.highlightedRun = id;
      if (!this.data.runs.some((item) => item.id === id)) this.data.runs.unshift(run);
      this.render();
    } catch (error) { if (generation === this.generation) { $("schedule-page-error").textContent = error.message; $("schedule-page-error").hidden = false; } }
    const card = [...document.querySelectorAll(".run-card")].find((item) => item.dataset.runId === id);
    if (card) { card.classList.add("highlighted-run"); card.scrollIntoView({ block: "center" }); this.focusedRun = null; }
  }
  deviceOptions() {
    const root = $("schedule-device"); const signature = JSON.stringify(this.devices.map((device) => [device.id, device.name, device.connected]));
    if (root.dataset.signature === signature) return;
    const previous = root.value; root.dataset.signature = signature; root.replaceChildren();
    const empty = create("option", "", "选择设备"); empty.value = ""; root.append(empty);
    for (const device of this.devices) { const option = create("option", "", device.name + (device.connected ? "" : "（当前离线）")); option.value = device.id; root.append(option); }
    if ([...root.options].some((option) => option.value === previous)) root.value = previous;
  }
  modelOptions(reset = false) {
    const root = $("schedule-model"); const device = this.devices.find((item) => item.id === $("schedule-device").value);
    const ready = device?.connected && device.report?.ready && device.management?.state === "ready";
    const models = ready ? device.management.models : [];
    const signature = JSON.stringify([device?.id, device?.connectionId, ready, models]);
    if (!reset && root.dataset.signature === signature) return;
    const previous = reset ? "" : root.value; root.dataset.signature = signature; root.replaceChildren();
    const option = create("option", "", "沿用设备默认"); option.value = ""; root.append(option);
    for (const model of models) {
      const option = create("option", "", `${model.name} · ${modelLabel(model)}`);
      option.value = JSON.stringify({ provider: model.provider, id: model.id }); root.append(option);
    }
    if (previous && ![...root.options].some((option) => option.value === previous)) {
      const option = create("option", "", `${modelLabel(JSON.parse(previous))}（当前不可用）`); option.value = previous; root.append(option);
    }
    root.value = previous; root.disabled = !ready;
    $("schedule-model-hint").textContent = !device ? "选择设备后显示可用模型，仅影响本计划的新会话。" : !ready
      ? "设备离线或后端未就绪，暂时无法读取模型列表。" : !models.length
        ? "设备尚未提供可用模型，请先检查原生模型配置和启动交互。" : "仅影响本计划的新会话。指定模型不可用时运行失败，不自动换模型。";
  }
  open(scope) {
    this.deviceOptions(); $("schedule-device").value = scope?.deviceId ?? ""; this.modelOptions(true); $("schedule-path").value = scope?.cwd ?? "";
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
      const model = $("schedule-model").value ? JSON.parse($("schedule-model").value) : undefined;
      await this.request("/_hub/schedules", { method: "POST", body: JSON.stringify({ ...(model ? { model } : {}), name: $("schedule-name").value, deviceId: $("schedule-device").value, path: $("schedule-path").value, prompt: $("schedule-prompt").value, timeoutSeconds: Number($("schedule-timeout").value) * 60, rule }) });
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
        card.append(create("p", "muted plan-model", `模型：${modelLabel(plan.model)}`));
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
    const signature = JSON.stringify([this.data.runs, [...this.runBusy], new Date().toDateString(), this.devices.map((device) => [device.id, device.name, device.connected, device.connectionId, device.report?.ready, device.management])]);
    if (runs.dataset.signature === signature) return; runs.dataset.signature = signature; this.results.retain(this.data.runs);
    const retained = new Set(this.data.runs.map((run) => run.id));
    for (const [id, card] of this.runCards) if (!retained.has(id)) { card.node.remove(); this.runCards.delete(id); this.runDetails.delete(id); }
    const groups = new Map();
    const sorted = [...this.data.runs].sort((a, b) => Number(unresolved(b.state)) - Number(unresolved(a.state)) || Date.parse(b.scheduledAt) - Date.parse(a.scheduledAt));
    for (const run of sorted) {
      const device = devices.get(run.deviceId); const key = JSON.stringify([run, this.runBusy.has(run.id), device?.name, device?.connected, device?.connectionId, device?.report?.ready, device?.management]);
      let card = this.runCards.get(run.id);
      if (!card || card.signature !== key) {
        this.results.unmount(run.id); card = { node: this.renderRun(run, device), signature: key }; this.runCards.set(run.id, card);
      }
      const day = unresolved(run.state) ? { key: "active", label: "进行中与待核对" } : dayGroup(run.scheduledAt);
      let group = groups.get(day.key);
      if (!group) {
        group = this.runGroups.get(day.key);
        if (!group) {
          const node = create("section", `run-group${day.key === "active" ? " active-runs" : ""}`);
          const heading = create("div", "run-group-heading"); const title = create("h3"); const count = create("span", "muted"); heading.append(title, count);
          const list = create("div", "run-group-list"); node.append(heading, list); group = { node, title, count, list };
        }
        group.title.textContent = day.label; group.rows = []; groups.set(day.key, group);
      }
      group.rows.push(card.node);
    }
    for (const group of groups.values()) { group.count.textContent = `${group.rows.length} 次运行`; placeChildren(group.list, group.rows); }
    this.runGroups = groups;
    placeChildren(runs, groups.size ? [...groups.values()].map((group) => group.node) : [create("p", "management-empty muted", "暂无运行记录。")]);
    if (this.focusedRun) { const card = this.runCards.get(this.focusedRun); if (card) { card.node.classList.add("highlighted-run"); card.node.scrollIntoView({ block: "center" }); this.focusedRun = null; } }
  }
  renderRun(run, device) {
    const active = unresolved(run.state); const card = create("article", `run-card ${run.state} ${active ? "is-active" : "is-history"}${this.highlightedRun === run.id ? " highlighted-run" : ""}`); card.dataset.runId = run.id;
    const heading = create("div", "run-heading"); const title = create("div", "run-title");
    const mark = create("span", `run-mark ${run.state}`, run.state === "completed" ? "✓" : active ? "•" : "–"); mark.setAttribute("aria-hidden", "true");
    title.append(mark, create("h2", "", run.name));
    const timing = create("div", "run-timing"); const time = create("time", "run-time muted", timeLabel(new Date(run.scheduledAt))); time.dateTime = run.scheduledAt; time.title = `触发时间：${fullTime(run.scheduledAt)}`;
    timing.append(create("span", `session-state ${run.state}`, labels[run.state]), time); heading.append(title, timing); card.append(heading);
    const metadata = create("p", "run-meta muted");
    const name = run.model ? device?.management?.models?.find((model) => model.provider === run.model.provider && model.id === run.model.id)?.name ?? run.model.id : "设备默认模型";
    for (const [text, tooltip] of [[device?.name ?? "设备已移除", "执行设备"], [workspaceName(run.path), run.path], [name, `模型：${modelLabel(run.model)}`]]) {
      const item = create("span", "", text); item.title = tooltip; metadata.append(item);
    }
    card.append(metadata);
    const normalEnd = run.state === "completed" && run.message === "SDK 执行已结束，请检查会话结果";
    if (run.message && !normalEnd) card.append(create("p", `run-message${run.state === "completed" ? " result-warning" : ""}`, run.message));
    const actions = create("div", "run-actions"); const resultActions = create("span", "result-actions"); actions.append(resultActions);
    if (run.state === "completed" && run.session) { const result = create("section", "run-result"); this.results.mount(result, run, resultActions); card.append(result); }
    if (run.session && device?.connected && device.management?.state === "ready") {
      const open = create("a", "text-button run-open", "查看会话 ↗"); open.target = "_blank"; open.rel = "noopener";
      open.href = sessionUrl(run.deviceId, run.file ? { path: run.file } : { id: run.session.id }); actions.append(open);
    }
    if (active) {
      const cancel = create("button", "text-button", "取消运行"); cancel.type = "button"; cancel.disabled = this.runBusy.has(run.id) || !device?.report?.ready;
      cancel.addEventListener("click", () => this.ask("取消会尝试停止这个专用会话，不暂停计划。无法确认停止时仍需核对，不会自动重跑。", () => this.action(run.id, `/_hub/runs/${run.id}/cancel`, { method: "POST", body: "{}" }, this.runBusy))); actions.append(cancel);
    }
    if (run.state === "unknown") {
      const acknowledge = create("button", "text-button", "确认已结束"); acknowledge.type = "button"; acknowledge.disabled = this.runBusy.has(run.id);
      acknowledge.addEventListener("click", () => this.ask("请先在设备上核对原任务确实已结束。此操作不会发送停止指令，只解除后续计划的阻塞；误确认可能导致并发执行。", () => this.action(run.id, `/_hub/runs/${run.id}/acknowledge`, { method: "POST", body: "{}" }, this.runBusy))); actions.append(acknowledge);
    }
    const details = create("dl", "run-details"); details.id = `run-details-${run.id}`; details.hidden = !this.runDetails.has(run.id);
    for (const [label, text] of [["任务目录", run.path], ["模型", modelLabel(run.model)], ["触发方式", run.trigger === "timer" ? "定时触发" : "手动执行"], ["触发时间", fullTime(run.scheduledAt)]]) {
      details.append(create("dt", "", label), create("dd", label === "模型" ? "run-model" : "", text));
    }
    if (normalEnd) details.append(create("dt", "", "执行说明"), create("dd", "", run.message));
    const toggle = create("button", "text-button run-details-toggle", "详情"); toggle.type = "button"; toggle.setAttribute("aria-controls", details.id); toggle.setAttribute("aria-expanded", String(!details.hidden));
    toggle.onclick = () => { details.hidden = !details.hidden; if (details.hidden) this.runDetails.delete(run.id); else this.runDetails.add(run.id); toggle.setAttribute("aria-expanded", String(!details.hidden)); };
    actions.append(toggle); card.append(actions, details); return card;
  }
}
