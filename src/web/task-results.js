import { create } from "./management.js";
import { renderMarkdown } from "./markdown.js";

/** 正文仅经原生转发通道进入当前页面，不进入管理快照或中心数据库。 */
export function readFinalReply(run, signal) {
  return new Promise((resolve, reject) => {
    const combined = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
    if (combined.aborted) { reject(combined.reason); return; }
    const prefix = `/n/${run.deviceId}/`;
    const url = new URL(prefix + "api/events?session=hub-result-pending&hub-preview=1", location.href);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true; combined.removeEventListener("abort", abort); socket.close();
      if (error) reject(error); else resolve(result);
    };
    const abort = () => finish(combined.reason);
    combined.addEventListener("abort", abort, { once: true });
    socket.onclose = () => finish(new Error("结果读取连接已断开，请手动重新读取"));
    socket.onerror = () => finish(new Error("无法连接设备读取结果"));
    socket.onmessage = (message) => {
      try {
        const frame = JSON.parse(message.data);
        if (frame.kind === "notification") return;
        if ((frame.kind !== undefined && frame.kind !== "frame") || !Number.isSafeInteger(frame.id) || !Array.isArray(frame.events)) throw new Error("结果读取协议不匹配");
        socket.send(JSON.stringify(frame.kind === "frame" ? { kind: "ack", id: frame.id } : { ack: frame.id }));
        for (const event of frame.events) {
          if (event.type === "client") {
            void fetch(prefix + "api/action", {
              method: "POST", signal: combined, headers: { "Content-Type": "application/json", "X-Opi-Client": event.id },
              body: JSON.stringify({ sessionId: null, value: run.file ? { action: "openSession", path: run.file } : { action: "openSession", id: run.session.id } }),
            }).then(async (response) => { if (!response.ok) throw new Error(await response.text()); }).catch((error) => finish(error));
          }
          if (event.type === "selected" && event.session && event.session.id !== run.session.id) throw new Error("会话身份已变化，未读取其他会话的回复");
          if (event.type !== "snapshot" || event.value === null) continue;
          if (event.value.sessionId !== run.session.id || !Array.isArray(event.value.entries)) throw new Error("结果快照与计划会话不匹配");
          const entry = event.value.entries.find((item) => item.id === run.replyId);
          if (!entry || !Array.isArray(entry.messages)) throw new Error("原回复已不在会话中，未使用后续回复替代");
          const assistant = entry.messages.findLast((item) => item.role === "assistant");
          if (!assistant) throw new Error("原回复不是模型消息");
          const text = typeof assistant.content === "string" ? assistant.content : Array.isArray(assistant.content)
            ? assistant.content.filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n") : "";
          const truncated = text.length > 131072;
          finish(null, { text: truncated ? text.slice(0, 131072).replace(/[\uD800-\uDBFF]$/, "") : text, truncated });
          return;
        }
      } catch (error) { finish(error); }
    };
  });
}

export class TaskResults {
  constructor() {
    this.cache = new Map(); this.roots = new Map(); this.devices = new Map(); this.queue = new Map(); this.expanded = new Set(); this.active = 0; this.visible = false;
    this.observer = new IntersectionObserver((entries) => {
      for (const entry of entries) if (entry.isIntersecting) { this.observer.unobserve(entry.target); const record = this.roots.get(entry.target.dataset.runId); if (record) this.enqueue(record.run); }
    });
    this.resize = new ResizeObserver((entries) => { for (const entry of entries) this.checkOverflow(entry.target); });
  }
  clear() { this.visible = false; this.observer.disconnect(); this.resize.disconnect(); for (const entry of this.cache.values()) entry.controller?.abort(); this.cache.clear(); this.roots.clear(); this.queue.clear(); this.expanded.clear(); }
  update(devices, visible) {
    this.visible = visible;
    this.devices = new Map(devices.map((device) => [device.id, device]));
    for (const [id, entry] of this.cache) {
      const device = this.devices.get(entry.deviceId);
      if (!visible && entry.state === "loading" || !device?.connected || device.management?.state !== "ready" || device.connectionId !== entry.connectionId) { entry.controller?.abort(); this.cache.delete(id); }
    }
    if (!visible) { this.queue.clear(); this.observer.disconnect(); }
    for (const { run } of this.roots.values()) this.draw(run);
  }
  unmount(id) {
    const record = this.roots.get(id); if (!record) return;
    this.observer.unobserve(record.root); if (record.body) this.resize.unobserve(record.body); this.roots.delete(id);
  }
  retain(runs) {
    const retained = new Set(runs.map((run) => run.id));
    for (const id of this.roots.keys()) if (!retained.has(id)) this.unmount(id);
    for (const [id, entry] of this.cache) if (!retained.has(id)) { entry.controller?.abort(); this.cache.delete(id); }
    for (const id of this.expanded) if (!retained.has(id)) this.expanded.delete(id);
    for (const id of this.queue.keys()) if (!retained.has(id)) this.queue.delete(id);
  }
  mount(root, run, actions) { root.dataset.runId = run.id; root.setAttribute("aria-label", "任务结果"); this.roots.set(run.id, { root, run, actions }); this.draw(run); }
  checkOverflow(body) {
    const record = this.roots.get(body.dataset.runId); if (!record || record.body !== body) return;
    const expanded = this.expanded.has(record.run.id);
    const clipped = !expanded && body.scrollHeight > body.clientHeight + 1;
    record.toggle.hidden = !expanded && !clipped;
    // 折叠预览中的不可见链接不能截获键盘焦点，展开后恢复原有访问方式。
    for (const link of body.querySelectorAll("a")) { if (clipped) link.tabIndex = -1; else link.removeAttribute("tabindex"); }
    for (const block of body.querySelectorAll("pre, .markdown-table")) block.tabIndex = clipped ? -1 : 0;
    record.toggle.textContent = expanded ? "收起结果" : "展开结果"; record.toggle.setAttribute("aria-expanded", String(expanded));
  }
  draw(run) {
    const record = this.roots.get(run.id); if (!record) return;
    const { root, actions } = record; const device = this.devices.get(run.deviceId); const entry = this.cache.get(run.id);
    const signature = JSON.stringify([this.visible, entry?.state, entry?.text, entry?.error, entry?.truncated, device?.connectionId, device?.management?.state, device?.connected]);
    if (root.dataset.signature === signature) return;
    this.observer.unobserve(root); if (record.body) this.resize.unobserve(record.body);
    root.dataset.signature = signature; root.replaceChildren(); actions.replaceChildren(); record.body = null;
    if (!run.replyId) { root.append(create("p", "result-state muted", run.replyId === null ? "本次运行没有可定位的最终回复。" : "旧运行记录未保存回复定位信息，请查看原会话。")); return; }
    if (!device?.connected || device.management?.state !== "ready") { root.append(create("p", "result-state muted", "设备离线或会话管理未就绪，无法读取最终回复。")); return; }
    if (entry?.state === "ready") {
      const body = create("div", "result-body"); body.id = `run-result-${run.id}`; body.dataset.runId = run.id;
      body.innerHTML = renderMarkdown(entry.text || "模型没有返回文本内容。");
      body.classList.toggle("collapsed", !this.expanded.has(run.id)); root.append(body); record.body = body;
      const expand = create("button", "text-button result-expand", "展开结果"); expand.type = "button"; expand.setAttribute("aria-controls", body.id);
      expand.onclick = () => {
        if (this.expanded.has(run.id)) this.expanded.delete(run.id); else this.expanded.add(run.id);
        body.classList.toggle("collapsed", !this.expanded.has(run.id)); this.checkOverflow(body);
      };
      record.toggle = expand; actions.append(expand); this.resize.observe(body); this.checkOverflow(body);
      if (entry.truncated) root.append(create("p", "result-state result-warning", "回复超过 128 Ki 字符，当前仅展示前段，完整内容请查看会话。"));
      const copy = create("button", "text-button", "复制回复"); copy.type = "button"; copy.disabled = !entry.text;
      copy.onclick = async () => { try { await navigator.clipboard.writeText(entry.text); copy.textContent = "已复制"; } catch { copy.textContent = "无法复制，请选择正文手动复制"; } }; actions.append(copy);
      return;
    }
    root.append(create("p", entry?.state === "error" ? "result-state error" : "result-state muted", entry?.error || (entry?.state === "loading" ? "正在读取结果…" : "结果将在此处在线加载。")));
    if (entry?.state === "error") {
      const retry = create("button", "text-button", "重新读取回复"); retry.type = "button"; retry.onclick = () => { this.cache.delete(run.id); this.enqueue(run); }; actions.append(retry);
    } else if (!entry && this.visible) this.observer.observe(root);
  }
  enqueue(run) {
    if (!this.visible || !run.replyId || this.cache.has(run.id)) return;
    const device = this.devices.get(run.deviceId); if (!device?.connected || device.management?.state !== "ready") return;
    this.queue.set(run.id, run); this.pump();
  }
  pump() {
    while (this.visible && this.active < 3 && this.queue.size) {
      const run = this.queue.values().next().value; this.queue.delete(run.id);
      if (this.cache.has(run.id)) continue;
      const device = this.devices.get(run.deviceId); if (!device?.connected || device.management?.state !== "ready") continue;
      const controller = new AbortController(); const entry = { deviceId: run.deviceId, connectionId: device.connectionId, state: "loading", controller };
      this.cache.set(run.id, entry); this.active++; this.draw(run);
      void readFinalReply(run, controller.signal).then((result) => {
        if (this.cache.get(run.id) === entry) Object.assign(entry, result, { state: "ready" });
      }, (error) => {
        if (this.cache.get(run.id) === entry && !controller.signal.aborted) Object.assign(entry, { state: "error", error: error.message });
      }).finally(() => { this.active--; if (this.cache.get(run.id) === entry) { delete entry.controller; this.draw(run); } this.pump(); });
    }
  }
}
