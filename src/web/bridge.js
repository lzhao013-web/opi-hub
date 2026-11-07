(() => {
  "use strict";
  const prefix = document.currentScript.dataset.prefix;
  const params = new URLSearchParams(location.search);
  const targetId = params.get("hub-session");
  const targetPath = params.get("hub-path");
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
      if (url.pathname === "/api/events") {
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
      if (!targetId && !targetPath) return;
      this.addEventListener("message", (event) => {
        let delivery;
        try { delivery = JSON.parse(event.data); } catch { return; }
        if ((delivery.kind !== undefined && delivery.kind !== "frame") || !Array.isArray(delivery.events)) return;
        for (const item of delivery.events) {
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
