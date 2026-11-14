import { create, renderSessionList } from "./management.js";
import { workspaceName } from "./navigation.js";
import { backendLabel } from "./backend.js";

const active = (session) => ["running", "waiting", "loading"].includes(session.state);
const hasActivity = (workspace) => Boolean(workspace.running || workspace.waiting || workspace.pending);
function workspaceSummaries(data, id) {
  const items = new Map(data.workspaces.filter((item) => item.deviceId === id).map((item) => [item.path,
    { path: item.path, running: 0, waiting: 0, pending: 0, modified: null }]));
  const sessions = new Map();
  for (const session of data.sessions) {
    if (session.deviceId !== id || session.state === "history") continue;
    const item = items.get(session.cwd); if (!item) continue;
    if (["running", "loading"].includes(session.state)) item.running++;
    if (session.state === "waiting") item.waiting++;
    const modified = Date.parse(session.modified);
    if (Number.isFinite(modified) && (item.modified === null || modified > item.modified)) item.modified = modified;
    if ("id" in session.target) sessions.set(session.target.id, item);
  }
  for (const interaction of data.interactions) {
    if (interaction.deviceId !== id) continue;
    const item = sessions.get(interaction.sessionId); if (item) item.pending++;
  }
  return [...items.values()].sort((a, b) => Number(hasActivity(b)) - Number(hasActivity(a)) ||
    Number(Boolean(b.pending || b.waiting)) - Number(Boolean(a.pending || a.waiting)) ||
    Number(b.modified !== null) - Number(a.modified !== null) || (b.modified ?? 0) - (a.modified ?? 0) || a.path.localeCompare(b.path));
}
export class WorkspaceViews {
  constructor(history, select, creator) {
    this.history = history; this.select = select; this.creator = creator; this.search = null;
    this.workspaceFilters = new Map(); this.workspaceData = null; this.workspaceDevice = null;
    for (const filter of ["all", "active"]) document.getElementById(`workspaces-${filter}`).addEventListener("click", () => {
      if (!this.workspaceData || !this.workspaceDevice) return;
      this.workspaceFilters.set(this.workspaceDevice, filter); this.workspaces(this.workspaceData, this.workspaceDevice);
    });
  }
  clear() {
    this.search = null; this.workspaceFilters.clear(); this.workspaceData = null; this.workspaceDevice = null;
    for (const id of ["overview-devices", "active-sessions", "recent-sessions", "workspaces", "sessions", "history-results"]) {
      const node = document.getElementById(id); node.replaceChildren(); delete node.dataset.signature;
    }
  }
  render(data, view, scope, needle) {
    const devices = new Map(data.devices.map((device) => [device.id, device]));
    if (view === "overview") {
      this.deviceOverview(data);
      renderSessionList(document.getElementById("active-sessions"), data.sessions.filter(active), devices, "当前没有正在进行的会话。");
      const recent = data.sessions.filter((item) => item.state === "idle").sort((a, b) => b.modified.localeCompare(a.modified)).slice(0, 5);
      renderSessionList(document.getElementById("recent-sessions"), recent, devices, "暂无最近活动的会话。");
    }
    if (view === "device" && scope) this.workspaces(data, scope.deviceId);
    if (view === "workspace" && scope) {
      const sessions = this.history.sessions(data, scope.deviceId, scope.cwd);
      const query = needle.trim().toLocaleLowerCase();
      renderSessionList(document.getElementById("sessions"), sessions.filter((item) => !query || item.title.toLocaleLowerCase().includes(query)), devices, query ? "没有匹配的会话。" : "暂无运行会话。需要时可加载这个工作区的历史。");
      const pending = this.history.pending.has(scope.deviceId); const loaded = this.history.entries.has(scope.deviceId);
      const button = document.getElementById("load-history"); const device = devices.get(scope.deviceId);
      button.disabled = !device?.connected || !device.report?.ready || device.management.state !== "ready";
      button.textContent = pending ? "取消读取" : loaded ? "刷新历史" : "加载历史会话";
      const status = document.getElementById("history-status");
      status.classList.toggle("error", this.history.errors.has(scope.deviceId));
      status.textContent = this.history.errors.get(scope.deviceId) || (pending ? "正在读取该设备的历史目录…" : loaded ? "已加载此设备的历史，当前仅显示所选工作区。" : "历史尚未读取，不会在后台持续刷新。");
    }
    this.searchOptions(data);
    if (view === "history") this.searchResults(data, devices);
  }
  deviceOverview(data) {
    const root = document.getElementById("overview-devices");
    const signature = JSON.stringify(data.devices.map((device) => [device.id, device.name, device.connected, device.report?.ready,
      data.sessions.filter((item) => item.deviceId === device.id && item.state === "running").length,
      data.interactions.filter((item) => item.deviceId === device.id).length]));
    if (root.dataset.signature === signature) return;
    root.dataset.signature = signature; root.replaceChildren();
    if (!data.devices.length) root.append(create("p", "management-empty muted", "还没有设备，可先添加一台设备。"));
    for (const device of data.devices) {
      const card = create("button", "overview-device"); card.type = "button";
      const heading = create("span", "overview-device-heading");
      heading.append(create("span", `status-dot${device.connected ? " online" : ""}`), create("strong", "", device.name));
      const running = data.sessions.filter((item) => item.deviceId === device.id && item.state === "running").length;
      const waiting = data.interactions.filter((item) => item.deviceId === device.id).length;
      card.append(heading, create("span", "muted", device.report?.ready ? `${running} 个运行 · ${waiting} 个待处理` : backendLabel(device).name));
      card.addEventListener("click", () => this.select({ deviceId: device.id, cwd: null })); root.append(card);
    }
  }
  workspaces(data, id) {
    this.workspaceData = data; this.workspaceDevice = id;
    const root = document.getElementById("workspaces"); const filter = this.workspaceFilters.get(id) ?? "all";
    const items = workspaceSummaries(data, id); const device = data.devices.find((item) => item.id === id);
    const canCreate = this.creator.canCreate(device);
    const signature = JSON.stringify([id, filter, canCreate, items]);
    if (root.dataset.signature === signature) return;
    const focus = document.activeElement?.dataset.workspaceKey;
    root.dataset.signature = signature; root.replaceChildren();
    for (const name of ["all", "active"]) document.getElementById(`workspaces-${name}`).setAttribute("aria-pressed", String(filter === name));
    document.getElementById("workspaces-count").textContent = `${items.length} 个工作区 · ${items.filter(hasActivity).length} 个有活动`;
    const visible = filter === "active" ? items.filter(hasActivity) : items;
    if (!visible.length) root.append(create("li", "management-empty muted", !items.length ? "暂无可浏览的工作区。" : "没有正在进行或待处理的工作区，可切换到“全部”浏览。"));
    for (const [index, workspace] of visible.entries()) root.append(this.workspaceRow(workspace, id, canCreate, index));
    if (focus) {
      const button = [...root.querySelectorAll("button")].find((item) => item.dataset.workspaceKey === focus);
      const target = button?.disabled ? button.closest(".workspace-row").querySelector(".workspace-open") : button;
      (target ?? document.getElementById(`workspaces-${filter}`)).focus({ preventScroll: true });
    }
  }
  workspaceRow(workspace, id, canCreate, index) {
    const row = create("li", "workspace-row"); const scope = { deviceId: id, cwd: workspace.path };
    const button = create("button", "workspace-open"); button.type = "button";
    button.setAttribute("aria-label", `进入工作区 ${workspace.path}`); button.dataset.workspaceKey = JSON.stringify([id, workspace.path, "open"]);
    const identity = create("span", "workspace-identity"); const path = create("span", "workspace-path muted", workspace.path); path.title = workspace.path; path.id = `workspace-path-${index}`;
    const name = create("strong", "", workspaceName(workspace.path)); name.title = name.textContent;
    identity.append(name, path);
    const status = create("span", "workspace-activity"); status.id = `workspace-status-${index}`;
    if (workspace.running) status.append(create("span", "workspace-badge running", `${workspace.running} 个进行中`));
    if (workspace.pending) status.append(create("span", "workspace-badge waiting", `${workspace.pending} 个待处理`));
    else if (workspace.waiting) status.append(create("span", "workspace-badge waiting", `${workspace.waiting} 个等待交互`));
    if (!hasActivity(workspace)) status.append(create("span", "muted", "暂无活动"));
    const updated = create("span", "workspace-updated muted"); updated.id = `workspace-updated-${index}`;
    if (workspace.modified !== null) {
      const date = new Date(workspace.modified); const time = create("time", "", date.toLocaleString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }));
      time.dateTime = date.toISOString(); time.title = date.toLocaleString("zh-CN"); updated.append(create("span", "", "最近活动"), time);
    } else updated.textContent = "尚无活动记录";
    button.setAttribute("aria-describedby", `${status.id} ${updated.id}`);
    button.append(identity, status, updated); button.addEventListener("click", () => this.select(scope));
    const add = create("button", "workspace-create text-button", "+"); add.type = "button"; add.disabled = !canCreate;
    add.setAttribute("aria-label", "新建会话"); add.setAttribute("aria-describedby", path.id); add.title = canCreate ? `在 ${workspace.path} 新建会话` : "设备未就绪或会话正在创建";
    add.dataset.workspaceKey = JSON.stringify([id, workspace.path, "create"]); add.addEventListener("click", () => this.creator.open(scope));
    row.append(button, add); return row;
  }
  searchOptions(data) {
    const root = document.getElementById("history-device");
    const signature = JSON.stringify(data.devices.map((item) => [item.id, item.name]));
    if (root.dataset.signature === signature) return;
    const value = root.value; root.dataset.signature = signature; root.replaceChildren();
    const all = create("option", "", "全部在线设备"); all.value = ""; root.append(all);
    for (const device of data.devices) { const option = create("option", "", device.name); option.value = device.id; root.append(option); }
    if ([...root.options].some((option) => option.value === value)) root.value = value;
  }
  async startSearch(data, query, deviceId) {
    const ids = data.devices.filter((device) => (!deviceId || device.id === deviceId) && device.connected && device.report?.ready && device.management.state === "ready").map((device) => device.id);
    this.search = { query: query.trim().toLocaleLowerCase(), ids };
    await Promise.all(ids.map((id) => this.history.load(id)));
  }
  cancelSearch() { if (this.search) this.search.cancelled = true; for (const id of this.search?.ids ?? []) this.history.cancel(id); }
  searchResults(data, devices) {
    const root = document.getElementById("history-results");
    const status = document.getElementById("global-history-status");
    const errors = document.getElementById("history-errors"); errors.replaceChildren();
    const pending = this.search?.ids.some((id) => this.history.pending.has(id)) ?? false;
    document.getElementById("search-history").disabled = pending;
    document.getElementById("cancel-search").hidden = !pending;
    if (!this.search) { status.textContent = "输入关键词后，才会读取所选设备的历史目录。只搜索标题、设备和工作目录，不搜索正文。"; renderSessionList(root, [], devices, "历史不会在首页自动加载。"); return; }
    const { query, ids } = this.search;
    const sessions = this.history.sessions(data).filter((item) => ids.includes(item.deviceId) && this.history.entries.has(item.deviceId) &&
      [item.title, item.cwd, devices.get(item.deviceId)?.name].some((text) => text?.toLocaleLowerCase().includes(query)));
    const expired = ids.some((id) => !this.history.entries.has(id) && !this.history.pending.has(id) && !this.history.errors.has(id));
    status.textContent = pending ? "正在读取所选设备的历史目录…" : this.search.cancelled ? "查询已取消" : expired ? "部分设备结果已失效，请重新查询。" : `查询结束 · ${sessions.length} 个匹配`;
    renderSessionList(root, sessions, devices, pending ? "正在读取…" : ids.length ? "没有匹配的会话。" : "没有可查询的在线设备。");
    for (const id of ids) if (this.history.errors.has(id)) errors.append(create("p", "notice", `${devices.get(id)?.name}: ${this.history.errors.get(id)}`));
  }
}
