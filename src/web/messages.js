import { create, sessionUrl } from "./management.js";

const $ = (id) => document.getElementById(id);
export class MessageCenter {
  constructor(request, changed, openRun, authLost) {
    this.request = request; this.changed = changed; this.openRun = openRun; this.authLost = authLost;
    this.notices = []; this.devices = []; this.viewers = new Map(); this.handled = new Set(); this.popups = new Set(); this.tab = "pending";
    $("messages-pending").onclick = () => { this.tab = "pending"; this.automatic = false; this.render(); };
    $("messages-notifications").onclick = () => { this.tab = "notifications"; this.automatic = false; this.render(); };
    $("notifications-read-all").onclick = () => { void this.read(null); };
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
    this.source?.close(); this.source = null; clearInterval(this.timer); this.channel?.close(); this.channel = null;
    for (const popup of this.popups) popup.close(); this.popups.clear();
    this.notices = []; this.handled.clear(); this.viewers.clear(); $("notification-list").replaceChildren(); $("notification-toasts").replaceChildren(); delete $("notification-list").dataset.signature; this.error("");
  }
  error(message) { $("notification-error").textContent = message; $("notification-error").hidden = !message; }
  open(tab) { this.automatic = tab === undefined; this.tab = tab ?? (this.pending ? "pending" : "notifications"); }
  update(data) { this.devices = data.devices; this.pending = data.interactions.length; this.render(); }
  permission() {
    const supported = window.isSecureContext && "Notification" in window;
    const permission = supported ? Notification.permission : "unsupported";
    $("enable-notifications").hidden = permission !== "default";
    $("notification-permission").textContent = permission === "granted" ? "系统通知已允许。Hub 页面可在后台，全部关闭后不推送。" : permission === "denied" ? "系统通知已被拒绝，可在浏览器站点设置中修改。站内提醒仍可用。" : permission === "unsupported" ? "系统通知需要支持通知的浏览器及 HTTPS 或 localhost。站内提醒仍可用。" : "允许系统通知后，即使 Hub 在后台也能收到提醒。";
  }
  render() {
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
