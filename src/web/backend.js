import { create } from "./management.js";

export function backendLabel(device) {
  if (!device.connected) return { name: "离线", className: "", detail: "等待节点连接" };
  if (!device.report) return { name: "连接中", className: "waiting", detail: "等待节点状态" };
  const backend = device.report.backend;
  if (backend.state === "starting") return { name: "后端启动中", className: "waiting", detail: "节点正在后台启动 opi-web" };
  if (backend.state === "stopping") return { name: "后端停止中", className: "waiting", detail: "正在结束原托管进程" };
  if (backend.state === "error") return { name: "后端失败", className: "", detail: "查看日志后可手动重启" };
  if (backend.state === "stopped") return { name: "后端已停止", className: "", detail: "节点尚未启动后端" };
  return device.report.ready ? { name: "在线", className: "online", detail: "托管 o-pi 界面" } : { name: "后端无响应", className: "waiting", detail: "健康检查未通过" };
}
export class BackendControls {
  constructor(request, refresh) {
    this.request = request; this.refresh = refresh; this.device = null; this.busy = false; this.generation = 0; this.expanded = new Set();
    document.getElementById("cancel-restart").addEventListener("click", () => document.getElementById("restart-dialog").close());
    document.getElementById("restart-form").addEventListener("submit", (event) => { event.preventDefault(); void this.restart(); });
  }
  clear() { this.generation++; this.busy = false; this.device = null; this.expanded.clear(); }
  button(device) {
    const button = create("button", "secondary", "重启后端"); button.type = "button";
    button.disabled = !device.connected || !device.report || ["starting", "stopping"].includes(device.report?.backend.state);
    button.addEventListener("click", () => {
      this.device = device; document.getElementById("restart-device").textContent = device.name;
      document.getElementById("restart-error").hidden = true; document.getElementById("confirm-restart").disabled = false;
      document.getElementById("restart-dialog").showModal();
    });
    return button;
  }
  details(card, device) {
    const backend = device.report?.backend;
    if (backend?.state === "error") card.append(create("p", "backend-error error", backend.message));
    if (!backend?.logs) return;
    const details = create("details", "backend-logs"); details.open = this.expanded.has(device.id);
    details.append(create("summary", "", "最近后端日志"), create("pre", "", backend.logs));
    details.addEventListener("toggle", () => { if (details.open) this.expanded.add(device.id); else this.expanded.delete(device.id); }); card.append(details);
  }
  async restart() {
    if (this.busy || !this.device) return;
    this.busy = true; const generation = this.generation; document.getElementById("confirm-restart").disabled = true;
    try {
      await this.request("/_hub/backend/restart", { method: "POST", body: JSON.stringify({ deviceId: this.device.id, connectionId: this.device.connectionId }) });
      if (generation !== this.generation) return;
      document.getElementById("restart-dialog").close(); await this.refresh();
    } catch (error) {
      if (generation !== this.generation) return;
      const status = document.getElementById("restart-error"); status.textContent = error.message; status.hidden = false;
    } finally { if (generation === this.generation) { this.busy = false; document.getElementById("confirm-restart").disabled = false; } }
  }
}
