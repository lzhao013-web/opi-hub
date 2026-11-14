(() => {
  "use strict";
  const prefix = document.currentScript.dataset.prefix;
  const params = new URLSearchParams(location.search);
  const targetId = params.get("hub-session");
  const targetPath = params.get("hub-path");
  const channel = new BroadcastChannel("opi-hub.presence");
  const viewerId = Array.from(crypto.getRandomValues(new Uint8Array(16)), (value) => value.toString(16).padStart(2, "0")).join("");
  let destination = localStorage.getItem("opi-hub.notification-destination");
  if (!destination) { destination = viewerId.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5"); localStorage.setItem("opi-hub.notification-destination", destination); }
  let selectedId = null; let lastHub = 0; let nodeNotificationsUntil = 0; let closed = false; let sequence = 0;
  const presence = (leaving = false) => {
    if (closed) return;
    const value = { type: "viewer", id: viewerId, deviceId: prefix.split("/")[2], sessionId: selectedId, focused: !leaving && document.visibilityState === "visible" && document.hasFocus() };
    channel.postMessage(value);
    // 查看状态是可过期的提示。断网或页面退出时上报失败不影响原生会话。
    const sent = ++sequence;
    void fetch("/_hub/notifications/presence", { method: "POST", keepalive: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pageId: viewerId, sequence: sent, deviceId: value.deviceId, sessionId: selectedId, destination, focused: value.focused }) })
      .then(async (response) => { if (!response.ok) return; const status = await response.json(); if (sent === sequence) nodeNotificationsUntil = status.nodeNotifications === true ? Date.now() + 12_000 : 0; }).catch(() => {});
  };
  channel.onmessage = ({ data }) => { if (data?.type === "hub") { lastHub = Date.now(); presence(); } };
  for (const event of ["focus", "blur"]) window.addEventListener(event, () => presence());
  document.addEventListener("visibilitychange", () => presence());
  const heartbeat = setInterval(() => presence(), 5000);
  window.addEventListener("pagehide", (event) => { presence(true); channel.postMessage({ type: "viewer", id: viewerId, closed: true }); if (!event.persisted) { closed = true; clearInterval(heartbeat); channel.close(); } });
  window.addEventListener("pageshow", () => presence());
  const openError = (message) => {
    const banner = document.createElement("aside");
    banner.className = "hub-native-error"; banner.setAttribute("role", "alert");
    const back = document.createElement("a"); back.href = "/"; back.textContent = "返回会话管理";
    banner.append(document.createTextNode(message + " "), back);
    document.body.prepend(banner);
  };
  const route = (input) => {
    const url = new URL(input, location.href);
    if ((url.origin === location.origin || ((url.protocol === "ws:" || url.protocol === "wss:") && url.host === location.host)) && url.pathname.startsWith("/api/")) {
      if (url.pathname === "/api/events" && url.searchParams.get("hub-preview") !== "1") {
        if (targetId) url.searchParams.set("session", targetId);
        // 历史会话要按路径打开，握手时不选择默认会话，避免短暂展示或误操作其他会话。
        else if (targetPath) url.searchParams.set("session", "hub-open-pending");
      }
      url.pathname = prefix.slice(0, -1) + url.pathname;
    }
    return url.href;
  };
  const NativeSocket = window.WebSocket;
  window.WebSocket = class extends NativeSocket {
    constructor(url, protocols) {
      super(route(url), protocols);
      const routed = new URL(route(url));
      if (routed.pathname !== prefix + "api/events" || routed.searchParams.get("hub-preview") === "1") return;
      this.addEventListener("close", () => { selectedId = null; presence(); });
      this.addEventListener("message", (event) => {
        let delivery;
        try { delivery = JSON.parse(event.data); } catch { return; }
        // Hub 页面或已授权的本机节点负责提醒时，不再重复投递原生完成弹窗。
        if (delivery.kind === "notification" && delivery.value?.kind === "completed" && (Date.now() - lastHub < 12_000 || Date.now() < nodeNotificationsUntil)) { event.stopImmediatePropagation(); return; }
        if ((delivery.kind !== undefined && delivery.kind !== "frame") || !Array.isArray(delivery.events)) return;
        for (const item of delivery.events) {
          if (item.type === "selected") { selectedId = item.session?.id ?? null; presence(); }
          if (targetId && item.type === "selected" && item.session === null) openError("目标会话已不存在，请刷新中心列表。");
          if (!targetPath || item.type !== "client") continue;
          void fetch(prefix + "api/action", {
            method: "POST", headers: { "Content-Type": "application/json", "X-Opi-Client": item.id },
            body: JSON.stringify({ sessionId: null, value: { action: "openSession", path: targetPath } }),
          }).then(async (response) => { if (!response.ok) throw new Error(await response.text()); })
            .catch((error) => openError(`打开目标会话失败：${error.message}`));
        }
      });
    }
  };
  const storage = Storage.prototype;
  const get = storage.getItem;
  const set = storage.setItem;
  const remove = storage.removeItem;
  const key = (name) => name === "opi.session" ? `opi-hub:${prefix}:${name}` : name;
  storage.getItem = function (name) { return get.call(this, key(name)); };
  storage.setItem = function (name, value) { return set.call(this, key(name), value); };
  storage.removeItem = function (name) { return remove.call(this, key(name)); };
})();
