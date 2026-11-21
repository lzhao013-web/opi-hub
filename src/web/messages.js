import { create, sessionUrl } from "./management.js";

const $ = (id) => document.getElementById(id);
export class MessageCenter {
  constructor(request, changed, openRun, authLost, refresh) {
    this.request = request; this.changed = changed; this.openRun = openRun; this.authLost = authLost; this.refresh = refresh; this.binding = false; this.generation = 0;
    this.notices = []; this.devices = []; this.viewers = new Map(); this.handled = new Set(); this.popups = new Set(); this.tab = "pending";
    $("messages-pending").onclick = () => { this.tab = "pending"; this.automatic = false; this.render(); };
    $("messages-notifications").onclick = () => { this.tab = "notifications"; this.automatic = false; this.render(); };
    $("notifications-read-all").onclick = () => { void this.read(null); };
    $("notification-receiver").onchange = () => { void this.bindReceiver(); };
    $("enable-notifications").onclick = async () => {
      try { await Notification.requestPermission(); this.permission(); }
      catch (error) { this.error(error.message); }
    };
  }
  start() {
    if (this.source) return;
    this.initial = true; this.channel = new BroadcastChannel("opi-hub.presence");
    this.channel.onmessage = ({ data }) => {
      if (data?.type !== "viewer" || typeof data.id !== "string") return;
      if (data.closed) this.viewers.delete(data.id);
      else { const fresh = !this.viewers.has(data.id); this.viewers.set(data.id, { ...data, at: Date.now() }); if (fresh) this.channel.postMessage({ type: "hub" }); }
    };
    const presence = () => this.channel.postMessage({ type: "hub" });
    presence(); this.timer = setInterval(presence, 5000);
    this.destination = localStorage.getItem("opi-hub.notification-destination");
    if (!this.destination) { this.destination = Array.from(crypto.getRandomValues(new Uint8Array(16)), (value) => value.toString(16).padStart(2, "0")).join("").replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5"); localStorage.setItem("opi-hub.notification-destination", this.destination); }
    this.source = new EventSource("/_hub/notifications/events");
    this.source.onmessage = ({ data }) => {
      const initial = this.initial; this.initial = false;
      this.notices = JSON.parse(data); this.error(""); this.changed();
      for (const notice of this.notices) {
        if (this.handled.has(notice.id)) continue;
        this.handled.add(notice.id);
        if (!initial && !notice.read) void this.alert(notice);
      }
      const retained = new Set(this.notices.map((notice) => notice.id));
      for (const id of this.handled) if (!retained.has(id)) this.handled.delete(id);
    };
    this.source.onerror = () => {
      this.error("通知连接中断，正在重连。后台任务不会因此停止。");
      void this.request("/_hub/me").then((value) => { if (!value.authenticated) this.authLost(); }).catch((error) => this.error(error.message));
    };
    this.permission();
  }
  clear() {
    this.generation++; this.binding = false; this.devices = []; $("notification-receiver-error").hidden = true; delete $("notification-receiver").dataset.signature;
    this.source?.close(); this.source = null; clearInterval(this.timer); this.channel?.close(); this.channel = null;
    for (const popup of this.popups) popup.close(); this.popups.clear();
    this.notices = []; this.handled.clear(); this.viewers.clear(); $("notification-list").replaceChildren(); $("notification-toasts").replaceChildren(); delete $("notification-list").dataset.signature; this.error("");
  }
  error(message) { $("notification-error").textContent = message; $("notification-error").hidden = !message; }
  open(tab) { this.automatic = tab === undefined; this.tab = tab ?? (this.pending ? "pending" : "notifications"); }
  update(data) { this.devices = data.devices; this.pending = data.interactions.length; this.render(); }
  receiverOptions() {
    const select = $("notification-receiver"); select.disabled = this.binding;
    const signature = JSON.stringify([this.destination, this.devices.map((device) => [device.id, device.name, device.notificationDestination])]);
    if (select.dataset.signature === signature || this.binding) return;
    select.dataset.signature = signature; select.replaceChildren();
    const browser = create("option", "", "此浏览器"); browser.value = ""; select.append(browser);
    for (const device of this.devices) { const option = create("option", "", device.name); option.value = device.id; select.append(option); }
    select.value = this.devices.find((device) => device.notificationDestination === this.destination)?.id ?? "";
  }
  async bindReceiver() {
    if (this.binding || !this.destination) return;
    const generation = this.generation; const deviceId = $("notification-receiver").value || null;
    this.binding = true; this.receiverOptions(); $("notification-receiver-error").hidden = true;
    try {
      await this.request("/_hub/notifications/receiver", { method: "POST", body: JSON.stringify({ deviceId, destination: this.destination }) });
      if (generation === this.generation) await this.refresh();
    } catch (error) {
      if (generation === this.generation) { $("notification-receiver-error").textContent = error.message; $("notification-receiver-error").hidden = false; }
    } finally { if (generation === this.generation) { this.binding = false; delete $("notification-receiver").dataset.signature; this.receiverOptions(); this.permission(); } }
  }
  permission() {
    const receiver = this.devices.find((device) => device.notificationDestination === this.destination);
    const active = receiver?.connected && receiver.notificationSubscribed;
    const supported = window.isSecureContext && "Notification" in window;
    const permission = supported ? Notification.permission : "unsupported";
    $("enable-notifications").hidden = active || permission !== "default";
    const browser = permission === "granted" ? "浏览器系统通知已允许，关闭全部 Hub 页面后不推送。" : permission === "denied" ? "浏览器系统通知已被拒绝，可在站点设置中修改。" : permission === "unsupported" ? "浏览器系统通知需要 HTTPS 或 localhost。" : "可允许浏览器系统通知，在 Hub 页面保持打开时接收提醒。";
    $("notification-permission").textContent = active ? `已授权“${receiver.name}”节点接收各设备的完成摘要，由它发送系统通知。启用了通知审批的 Windows 节点还可以接收并直接处理命令审批。关闭网页后仍可接收，实际显示受系统权限和勿扰模式限制。` :
      (receiver ? `“${receiver.name}”节点未订阅：请确认本机未设置 notifications: false、节点在线且系统通知工具可用。目前回退浏览器提醒。` : "选择本机节点可授权它接收各设备的完成摘要，不依赖浏览器 HTTPS 权限。") + ` ${browser} 站内完成记录始终保留。`;
  }
  render() {
    this.receiverOptions(); this.permission();
    if (this.automatic && this.pending) this.tab = "pending";
    const unread = this.notices.filter((notice) => !notice.read).length;
    $("notification-count").textContent = unread ? `未读 ${unread}` : "";
    $("messages-pending").textContent = `待处理 (${this.pending ?? 0})`;
    $("messages-notifications").textContent = `通知 (${unread})`;
    for (const [tab, id] of [["pending", "messages-pending"], ["notifications", "messages-notifications"]]) $(id).setAttribute("aria-selected", String(this.tab === tab));
    $("interactions").hidden = this.tab !== "pending"; $("notifications-panel").hidden = this.tab !== "notifications";
    $("notifications-read-all").disabled = !unread;
    const root = $("notification-list"); const signature = JSON.stringify([this.notices, this.devices.map((device) => [device.id, device.name, device.connected])]);
    if (root.dataset.signature === signature) return; root.dataset.signature = signature; root.replaceChildren();
    if (!this.notices.length) root.append(create("p", "management-empty muted", "还没有完成通知。这里只在内存保留最近 100 条通知。"));
    for (const notice of this.notices) {
      const card = create("article", `notification-card${notice.read ? "" : " unread"}`); card.dataset.noticeId = notice.id;
      card.append(create("h2", "", notice.title || "未命名会话"), create("p", "", "本轮执行已完成"), create("p", "session-location", `${this.devices.find((device) => device.id === notice.deviceId)?.name ?? "设备已移除"} · ${notice.cwd} · ${new Date(notice.completedAt).toLocaleString()}`));
      const actions = create("div", "plan-actions");
      if (notice.runId) { const open = create("button", "secondary", "查看任务结果"); open.type = "button"; open.onclick = () => { void this.read(notice.id); this.openRun(notice.runId); }; actions.append(open); }
      else {
        const open = create("a", "secondary", "查看会话 ↗"); open.href = sessionUrl(notice.deviceId, notice.file ? { path: notice.file } : { id: notice.sessionId }); open.target = "_blank"; open.rel = "noopener";
        open.onclick = () => { void this.read(notice.id); }; actions.append(open);
      }
      if (!notice.read) { const read = create("button", "text-button", "标为已读"); read.type = "button"; read.onclick = () => { void this.read(notice.id); }; actions.append(read); }
      else actions.append(create("span", "muted", "已读"));
      card.append(actions); root.append(card);
    }
  }
  async read(id) { try { await this.request("/_hub/notifications/read", { method: "POST", body: JSON.stringify({ id }) }); } catch (error) { this.error(error.message); } }
  focused(notice) {
    for (const [id, viewer] of this.viewers) {
      if (Date.now() - viewer.at > 12_000) { this.viewers.delete(id); continue; }
      if (viewer.focused && viewer.deviceId === notice.deviceId && viewer.sessionId === notice.sessionId) return true;
    }
    return false;
  }
  async alert(notice) {
    if (this.focused(notice)) return;
    try {
      const source = this.source;
      const { claimed } = await this.request("/_hub/notifications/claim", { method: "POST", body: JSON.stringify({ id: notice.id, destination: this.destination }) });
      if (!claimed || !source || source !== this.source || this.focused(notice)) return;
      const device = this.devices.find((device) => device.id === notice.deviceId)?.name ?? "设备";
      const label = `${device} · ${notice.title || "未命名会话"}`;
      const open = () => {
        void this.read(notice.id);
        if (notice.runId) this.openRun(notice.runId);
        else window.open(sessionUrl(notice.deviceId, notice.file ? { path: notice.file } : { id: notice.sessionId }), "_blank", "noopener");
      };
      const toast = create("div", "notification-toast"); const view = create("button", "text-button", `${label}：本轮执行已完成`); view.type = "button"; view.onclick = () => { toast.remove(); open(); };
      const dismiss = create("button", "icon-button", "×"); dismiss.type = "button"; dismiss.setAttribute("aria-label", "关闭完成提醒"); dismiss.onclick = () => toast.remove(); toast.append(view, dismiss);
      const root = $("notification-toasts"); root.prepend(toast); while (root.children.length > 3) root.lastChild.remove();
      if (window.isSecureContext && "Notification" in window && Notification.permission === "granted") {
        try {
          const popup = new Notification("会话已完成", { body: label, tag: notice.id }); this.popups.add(popup);
          popup.onclose = () => this.popups.delete(popup); popup.onclick = () => { popup.close(); window.focus(); open(); };
        } catch { this.error("浏览器或系统拒绝了系统通知，完成提醒仍在消息中心。 "); }
      }
    } catch (error) { this.error(error.message); }
  }
}
