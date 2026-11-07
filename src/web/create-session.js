import { create, sessionUrl } from "./management.js";
import { workspaceName } from "./navigation.js";

const $ = (id) => document.getElementById(id);
// 内网 HTTP 页面不提供 randomUUID，getRandomValues 仍可用于生成创建请求标识。
function creationId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export class CreateSessionView {
  constructor(request, refresh, interactions) {
    this.request = request; this.refresh = refresh; this.interactions = interactions;
    this.data = { devices: [], creations: [] }; this.generation = 0; this.browseJob = null; this.submitting = false; this.dismissed = new Set();
    $("close-create").addEventListener("click", () => $("create-dialog").close());
    $("create-dialog").addEventListener("close", () => this.cancelBrowse());
    $("create-device").addEventListener("change", () => { this.cancelBrowse(); $("create-path").value = ""; $("directory-list").replaceChildren(); $("directory-browser").hidden = true; this.setError(""); this.enable(); });
    $("browse-directory").addEventListener("click", () => { void this.browse($("create-path").value); });
    $("directory-parent").addEventListener("click", () => { if (this.listing) void this.browse(this.listing.parent); });
    $("use-directory").addEventListener("click", () => { if (this.listing) { $("create-path").value = this.listing.path; $("directory-browser").hidden = true; } });
    $("create-form").addEventListener("submit", (event) => { event.preventDefault(); void this.submit(); });
  }
  available(device) { return device?.connected && device.report?.ready && device.management.state === "ready"; }
  setError(message) { $("create-error").textContent = message; $("create-error").hidden = !message; }
  cancelBrowse() { this.browseJob?.controller.abort(); this.browseJob = null; }
  clear() { this.generation++; this.cancelBrowse(); this.submitting = false; this.dismissed.clear(); this.data = { devices: [], creations: [] }; $("creation-records").replaceChildren(); delete $("creation-records").dataset.signature; $("creation-error").hidden = true; }
  open(scope) {
    this.generation++; this.creationId = creationId(); this.cancelBrowse(); this.setError("");
    $("create-path").value = scope?.cwd ?? ""; $("directory-browser").hidden = true; $("directory-list").replaceChildren();
    this.deviceOptions(); $("create-device").value = scope?.deviceId ?? ""; this.enable(); $("create-dialog").showModal();
    (scope ? $("create-path") : $("create-device")).focus();
  }
  deviceOptions() {
    const select = $("create-device"); const previous = select.value;
    const signature = JSON.stringify(this.data.devices.map((device) => [device.id, device.name, this.available(device)]));
    if (select.dataset.signature === signature) return;
    select.dataset.signature = signature; select.replaceChildren();
    const empty = create("option", "", "选择设备"); empty.value = ""; select.append(empty);
    for (const device of this.data.devices) {
      const option = create("option", "", device.name + (this.available(device) ? "" : "（未就绪）")); option.value = device.id; option.disabled = !this.available(device); select.append(option);
    }
    if ([...select.options].some((option) => option.value === previous)) select.value = previous;
  }
  enable() {
    const device = this.data.devices.find((item) => item.id === $("create-device").value);
    $("create-submit").disabled = this.submitting || !this.available(device);
    $("browse-directory").disabled = this.submitting || !this.available(device);
    $("create-device").disabled = this.submitting; $("create-path").disabled = this.submitting;
    $("new-session").disabled = this.submitting || !this.data.devices.some((device) => this.available(device));
  }
  update(data) {
    this.data = data; this.deviceOptions(); this.enable();
    const job = this.browseJob;
    if (job) {
      const device = data.devices.find((item) => item.id === job.deviceId);
      if (!this.available(device) || device.connectionId !== job.connectionId) { this.cancelBrowse(); this.listing = null; $("directory-browser").hidden = true; this.setError("设备连接已变化，请重新浏览目录。"); }
    }
    this.records();
  }
  async browse(path) {
    const deviceId = $("create-device").value; const device = this.data.devices.find((item) => item.id === deviceId);
    if (!this.available(device)) return;
    this.cancelBrowse(); const job = { deviceId, connectionId: device.connectionId, controller: new AbortController() }; this.browseJob = job;
    $("directory-browser").hidden = false; $("directory-status").textContent = "正在读取目标设备目录…"; $("directory-list").replaceChildren();
    this.listing = null; $("directory-parent").disabled = true; $("use-directory").disabled = true; this.setError("");
    try {
      const listing = await this.request("/_hub/directories", { method: "POST", signal: job.controller.signal, body: JSON.stringify({ deviceId, path }) });
      if (this.browseJob !== job) return;
      if (listing.connectionId !== job.connectionId) throw new Error("设备连接已变化，请重新浏览目录。");
      this.listing = listing; $("directory-status").textContent = listing.path; $("directory-parent").disabled = listing.parent === listing.path; $("use-directory").disabled = false;
      for (const child of listing.children) {
        const button = create("button", "directory-entry", child.name); button.type = "button"; button.title = child.path;
        button.addEventListener("click", () => { void this.browse(child.path); }); $("directory-list").append(button);
      }
      if (!listing.children.length) $("directory-list").append(create("p", "muted", "没有子目录"));
    } catch (error) { if (!job.controller.signal.aborted && this.browseJob === job) { $("directory-status").textContent = "读取失败"; this.setError(error.message); } }
  }
  async submit() {
    if (this.submitting) return;
    const generation = this.generation; this.submitting = true; this.cancelBrowse(); this.enable(); this.setError("");
    try {
      await this.request("/_hub/sessions", { method: "POST", body: JSON.stringify({ deviceId: $("create-device").value, path: $("create-path").value, creationId: this.creationId }) });
      if (generation !== this.generation) return;
      $("create-dialog").close(); await this.refresh();
    } catch (error) {
      if (generation !== this.generation) return;
      const message = `提交未确认，请先查看创建记录，不要直接重复创建。${error.message}`;
      if ($("create-dialog").open) this.setError(message);
      else { $("creation-error").textContent = message; $("creation-error").hidden = false; }
    } finally { if (generation === this.generation) { this.submitting = false; this.enable(); } }
  }
  records() {
    const devices = new Map(this.data.devices.map((device) => [device.id, device]));
    const records = this.data.creations.filter((record) => !this.dismissed.has(JSON.stringify([record.deviceId, record.id])))
      .sort((a, b) => Number(b.state === "creating") - Number(a.state === "creating") || b.startedAt.localeCompare(a.startedAt)).slice(0, 5);
    $("session-creations").hidden = !records.length;
    const root = $("creation-records"); const signature = JSON.stringify(records.map((record) => [record, devices.get(record.deviceId)?.name]));
    if (root.dataset.signature === signature) return;
    root.dataset.signature = signature; root.replaceChildren();
    for (const record of records) {
      const card = create("article", "creation-record"); card.dataset.creationId = record.id; card.dataset.deviceId = record.deviceId;
      const heading = create("div", "creation-heading"); heading.append(create("strong", "", `${devices.get(record.deviceId)?.name} · ${workspaceName(record.path)}`));
      if (record.state !== "creating") {
        const dismiss = create("button", "text-button", "收起"); dismiss.type = "button";
        dismiss.addEventListener("click", () => { this.dismissed.add(JSON.stringify([record.deviceId, record.id])); this.records(); }); heading.append(dismiss);
      }
      card.append(heading, create("p", "creation-path muted", record.path));
      if (record.state === "creating") {
        const phases = { checking: "正在检查目录", workspace: "正在准备工作区", new: "正在新建会话" };
        card.append(create("p", "", `${phases[record.phase]}。如需项目信任或确认，请到待处理交互回答。`));
        const pending = create("button", "secondary", "查看待处理"); pending.type = "button"; pending.addEventListener("click", this.interactions); card.append(pending);
      } else {
        card.append(create("p", record.state === "error" ? "error" : "", record.state === "error" ? record.error : "会话已就绪"));
        if (record.session) {
          const open = create("a", "primary", record.state === "ready" ? "打开会话 ↗" : "查看相关会话 ↗");
          open.href = sessionUrl(record.deviceId, { id: record.session.id }); open.target = "_blank"; open.rel = "noopener"; card.append(open);
        }
      }
      root.append(card);
    }
  }
}
