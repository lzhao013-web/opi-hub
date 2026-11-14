import { ManagementView } from "./management.js";
import { HistoryStore } from "./history.js";
import { Navigation, workspaceName } from "./navigation.js";
import { WorkspaceViews } from "./views.js";
import { CreateSessionView } from "./create-session.js";
import { BackendControls, backendLabel } from "./backend.js";
import { MessageCenter } from "./messages.js";
import { ScheduleView } from "./schedules.js";

const $ = (id) => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`缺少界面元素：${id}`);
  return element;
};
let devices = [];
let overview = { devices: [], workspaces: [], sessions: [], interactions: [], creations: [] };
let view = "overview";
let scope = null;
let removing = null;
let authenticated = false;
let timer;
let pendingRead = 0;
const management = new ManagementView(request, refresh);
const history = new HistoryStore(request, () => { if (authenticated) render(); });
const navigation = new Navigation(selectScope);
const views = new WorkspaceViews(history, selectScope);
const backendControls = new BackendControls(request, refresh);
const schedules = new ScheduleView(request);
const messages = new MessageCenter(request, () => { if (authenticated) render(); }, (runId) => { scope = null; view = "schedules"; render(); void schedules.focusRun(runId); }, showLogin, refresh);
const creator = new CreateSessionView(request, refresh, () => { scope = null; view = "interactions"; messages.open("pending"); render(); });
const text = (id, value) => { $(id).textContent = value; };
function message(id, value) { text(id, value); $(id).hidden = !value; }
async function request(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { "Content-Type": "application/json", ...options.headers } });
  const value = await response.json();
  if (!response.ok) {
    if (response.status === 401 && url !== "/_hub/login") showLogin();
    throw new Error(value.error || `HTTP ${response.status}`);
  }
  return value;
}
function showLogin() {
  authenticated = false; pendingRead++; clearTimeout(timer); management.clear(); history.clear(); views.clear(); creator.clear(); backendControls.clear(); schedules.clear(); messages.clear();
  overview = { devices: [], workspaces: [], sessions: [], interactions: [], creations: [] }; devices = []; scope = null; view = "overview";
  $("workspace").hidden = true; $("login").hidden = false;
  for (const dialog of document.querySelectorAll("dialog[open]")) dialog.close();
  $("password").focus();
}
async function showWorkspace() {
  authenticated = true; $("login").hidden = true; $("workspace").hidden = false;
  $("password").value = "";
  messages.start(); await refresh();
}
async function refresh() {
  clearTimeout(timer);
  if (!authenticated || document.hidden) return;
  const sequence = ++pendingRead;
  try {
    const value = await request("/_hub/overview");
    if (sequence !== pendingRead || !authenticated) return;
    overview = value; devices = value.devices; history.reconcile(devices); message("workspace-error", ""); text("center-status", "中心已连接"); $("center-dot").classList.add("online"); render();
  } catch (error) { if (sequence === pendingRead && authenticated) { message("workspace-error", error.message); text("center-status", "中心连接异常"); $("center-dot").classList.remove("online"); } }
  finally { if (authenticated && !document.hidden) timer = setTimeout(refresh, 2000); }
}
function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}
function selectScope(value) {
  scope = value; view = value.cwd === null ? "device" : "workspace";
  $("session-search").value = ""; render();
}
function render() {
  if (!authenticated) return;
  if (scope && !devices.some((device) => device.id === scope.deviceId)) { scope = null; view = "overview"; }
  const online = devices.filter((device) => device.connected).length;
  const running = overview.sessions.filter((session) => ["running", "loading"].includes(session.state)).length;
  text("device-count", String(devices.length)); text("interaction-count", overview.interactions.length ? `待处理 ${overview.interactions.length}` : "");
  text("summary-text", `${online} 台在线 · ${running} 个运行 · ${overview.interactions.length} 个待处理交互`);
  const chosen = devices.find((device) => device.id === scope?.deviceId);
  const titles = { overview: "概览", device: chosen?.name, workspace: scope?.cwd ? workspaceName(scope.cwd) : "工作区", history: "查找历史", schedules: "计划任务", interactions: "消息中心", devices: "你的设备" };
  const descriptions = { overview: "关注正在进行的工作，不展开全部历史。", device: "选择工作区后浏览会话，历史按需读取。", workspace: "当前工作区的会话与按需历史。", history: "明确查询时才读取历史，不在首页铺开。", schedules: "预约设备上的代理任务，执行记录与会话分开管理。", interactions: "待处理交互与完成通知分区展示，已读通知不等于已审批。", devices: "管理设备连接，或打开完整的原生 o-pi 界面。" };
  text("heading", titles[view]); text("breadcrumb", chosen && view === "workspace" ? `${chosen.name} / ${titles[view]}` : titles[view]); text("page-description", descriptions[view]);
  $("selected-workspace").hidden = view !== "workspace"; text("selected-workspace", scope?.cwd ?? "");
  for (const [name, id] of [["overview", "overview-nav"], ["schedules", "schedules-nav"], ["history", "history-nav"], ["interactions", "all-interactions"], ["devices", "all-devices"]]) $(id).classList.toggle("selected", !scope && view === name);
  for (const [name, id] of [["overview", "overview-view"], ["device", "device-view"], ["workspace", "workspace-view"], ["history", "history-view"], ["schedules", "schedules-view"], ["interactions", "message-center"], ["devices", "devices"]]) $(id).hidden = view !== name;
  navigation.render(overview, scope); views.render(overview, view, scope, $("session-search").value);
  management.render(overview, scope?.deviceId ?? null, view); creator.update(overview); schedules.update(overview, view === "schedules"); messages.update(overview);
  $("new-session").hidden = view === "schedules"; $("add-schedule").hidden = view !== "schedules"; $("add-schedule").disabled = !devices.length;
  const attention = overview.scheduleSummary?.unknown ?? 0; const scheduleError = overview.scheduleSummary?.error;
  text("schedule-attention", attention ? String(attention) : ""); $("schedule-alert").hidden = !attention && !scheduleError;
  text("schedule-alert", scheduleError ? `计划任务需要检查：${scheduleError}` : `${attention} 个计划运行结果待核对，点击查看。`);
  const list = $("devices");
  const fingerprint = JSON.stringify(devices);
  if (list.dataset.fingerprint !== fingerprint) {
    list.dataset.fingerprint = fingerprint; list.replaceChildren();
    for (const device of devices) list.append(card(device));
  }
  $("empty").hidden = view !== "devices" || devices.length !== 0;
}
function card(device) {
  const status = backendLabel(device);
  const card = element("article", "device"); card.dataset.deviceId = device.id;
  const heading = element("div", "device-heading");
  const icon = element("div", "monitor-icon"); icon.setAttribute("aria-hidden", "true");
  const title = element("div");
  const badge = element("span", "device-state"); badge.append(element("span", `status-dot ${status.className}`), document.createTextNode(status.name));
  title.append(element("h2", "", device.name), badge);
  const remove = element("button", "icon-button", "×");
  remove.type = "button"; remove.title = "移除设备"; remove.setAttribute("aria-label", `移除 ${device.name}`);
  remove.addEventListener("click", () => { removing = device; text("remove-description", `将移除“${device.name}”。`); message("remove-error", ""); $("remove-dialog").showModal(); });
  heading.append(icon, title, remove);
  const details = element("dl", "device-details");
  const info = [
    ["系统", device.report ? `${device.report.platform} · ${device.report.hostname}` : "尚未连接"],
    ["托管后端", device.report?.backend.state === "running" ? device.report.backend.url : status.name],
    ["进程 PID", device.report?.backend.state === "running" ? String(device.report.backend.pid) : "—"],
    ["添加时间", new Date(device.createdAt).toLocaleDateString()],
  ];
  for (const [label, value] of info) details.append(element("dt", "", label), element("dd", "", value));
  const actions = element("div", "device-actions");
  const open = element("a", `primary${device.connected && device.report?.ready ? "" : " disabled"}`, "打开 o-pi ↗");
  open.href = `/n/${device.id}/`; open.target = "_blank"; open.rel = "noopener";
  if (!device.connected || !device.report?.ready) { open.setAttribute("aria-disabled", "true"); open.removeAttribute("href"); }
  actions.append(element("span", "", status.detail), open, backendControls.button(device));
  card.append(heading, details, actions); backendControls.details(card, device);
  return card;
}
$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault(); $("login-submit").disabled = true; message("login-error", "");
  try { await request("/_hub/login", { method: "POST", body: JSON.stringify({ password: $("password").value }) }); await showWorkspace(); }
  catch (error) { message("login-error", error.message); }
  finally { $("login-submit").disabled = false; }
});
$("logout").addEventListener("click", async () => {
  try { await request("/_hub/logout", { method: "POST", body: "{}" }); showLogin(); }
  catch (error) { message("workspace-error", error.message); }
});
for (const [name, id] of [["overview", "overview-nav"], ["schedules", "schedules-nav"], ["history", "history-nav"], ["interactions", "all-interactions"], ["devices", "all-devices"]]) $(id).addEventListener("click", () => { scope = null; view = name; if (name === "interactions") messages.open(); render(); });
$("new-session").addEventListener("click", () => creator.open(scope));
$("add-schedule").addEventListener("click", () => schedules.open(scope));
$("schedule-workspace").addEventListener("click", () => schedules.open(scope));
$("schedule-alert").addEventListener("click", () => $("schedules-nav").click());
$("session-search").addEventListener("input", render);
$("load-history").addEventListener("click", () => {
  if (!scope) return;
  if (history.pending.has(scope.deviceId)) history.cancel(scope.deviceId); else void history.load(scope.deviceId);
});
$("history-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const query = $("history-query").value.trim();
  if (!query) { text("global-history-status", "请输入历史关键词。"); return; }
  await views.startSearch(overview, query, $("history-device").value); render();
});
$("cancel-search").addEventListener("click", () => { views.cancelSearch(); render(); });
function enroll() {
  text("copy-config", "复制配置");
  $("enroll-name-step").hidden = false; $("enroll-config-step").hidden = true;
  $("device-name").value = ""; message("enroll-error", "");
  $("enroll-dialog").showModal(); $("device-name").focus();
}
for (const id of ["add-device", "add-sidebar", "add-empty"]) $(id).addEventListener("click", enroll);
for (const id of ["close-enroll", "finish-enroll"]) $(id).addEventListener("click", () => $("enroll-dialog").close());
$("enroll-dialog").addEventListener("close", () => { $("node-config").value = ""; });
$("enroll-form").addEventListener("submit", async (event) => {
  event.preventDefault(); $("enroll-submit").disabled = true; message("enroll-error", "");
  try {
    const result = await request("/_hub/devices", { method: "POST", body: JSON.stringify({ name: $("device-name").value }) });
    $("node-config").value = JSON.stringify(result.config, null, 2);
    $("enroll-name-step").hidden = true; $("enroll-config-step").hidden = false;
    $("download-config").focus(); await refresh();
  } catch (error) { message("enroll-error", error.message); }
  finally { $("enroll-submit").disabled = false; }
});
$("download-config").addEventListener("click", () => {
  const url = URL.createObjectURL(new Blob([$("node-config").value + "\n"], { type: "application/json" }));
  const link = element("a"); link.href = url; link.download = "node.json"; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$("copy-config").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText($("node-config").value); text("copy-config", "已复制"); }
  catch { $("node-config").focus(); $("node-config").select(); text("copy-config", "请手动复制所选配置"); }
});
$("cancel-remove").addEventListener("click", () => $("remove-dialog").close());
$("remove-form").addEventListener("submit", async (event) => {
  event.preventDefault(); if (!removing) return;
  $("confirm-remove").disabled = true;
  try { await request(`/_hub/devices/${removing.id}`, { method: "DELETE" }); $("remove-dialog").close(); removing = null; await refresh(); }
  catch (error) { message("remove-error", error.message); }
  finally { $("confirm-remove").disabled = false; }
});
const themes = ["system", "light", "dark"];
const labels = { system: "跟随系统", light: "浅色", dark: "深色" };
let theme = localStorage.getItem("opi-hub.theme") || "system";
function applyTheme() { document.documentElement.dataset.theme = theme; text("theme", labels[theme] || labels.system); }
applyTheme();
$("theme").addEventListener("click", () => { theme = themes[(themes.indexOf(theme) + 1) % themes.length]; localStorage.setItem("opi-hub.theme", theme); applyTheme(); });
document.addEventListener("visibilitychange", () => { if (!document.hidden && authenticated) void refresh(); else clearTimeout(timer); });
try { const me = await request("/_hub/me"); if (me.authenticated) await showWorkspace(); else showLogin(); }
catch (error) { showLogin(); message("login-error", error.message); }
