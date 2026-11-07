import { create } from "./management.js";

export const workspaceName = (path) => path.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) || path;
export class Navigation {
  constructor(select) {
    this.select = select; this.expanded = new Set(); this.options = new Map();
    this.root = document.getElementById("device-nav"); this.picker = document.getElementById("workspace-picker");
    this.picker.addEventListener("change", () => { const scope = this.options.get(this.picker.value); if (scope) { this.expanded.add(scope.deviceId); this.select(scope); } });
  }
  render(data, scope) {
    const signature = JSON.stringify([scope, [...this.expanded], data.devices.map((device) => [device.id, device.name, device.connected]), data.workspaces]);
    if (this.root.dataset.signature === signature) return;
    const focus = document.activeElement?.dataset.navKey;
    this.root.dataset.signature = signature; this.root.replaceChildren(); this.picker.replaceChildren(); this.options.clear();
    const placeholder = create("option", "", "选择设备或工作区"); placeholder.value = ""; this.picker.append(placeholder);
    for (const device of data.devices) {
      const expanded = this.expanded.has(device.id);
      const group = create("div", "device-branch");
      const button = create("button", `nav-item device-nav-button${scope?.deviceId === device.id && scope.cwd === null ? " selected" : ""}`);
      button.type = "button"; button.dataset.navKey = device.id;
      button.setAttribute("aria-expanded", String(expanded)); button.setAttribute("aria-label", device.name);
      button.append(create("span", "branch-arrow", expanded ? "▾" : "▸"), create("span", `status-dot${device.connected ? " online" : ""}`), create("span", "nav-name", device.name));
      button.addEventListener("click", () => { if (expanded) this.expanded.delete(device.id); else this.expanded.add(device.id); this.select({ deviceId: device.id, cwd: null }); });
      group.append(button);
      const workspaces = data.workspaces.filter((item) => item.deviceId === device.id).sort((a, b) => a.path.localeCompare(b.path));
      const options = create("optgroup"); options.label = device.name;
      const addOption = (selection, label) => {
        const key = JSON.stringify(selection); const option = create("option", "", label); option.value = key;
        this.options.set(key, selection); if (scope?.deviceId === selection.deviceId && scope.cwd === selection.cwd) option.selected = true;
        options.append(option);
      };
      addOption({ deviceId: device.id, cwd: null }, `${device.name} · 设备概览`);
      const children = create("div", "workspace-nav"); children.hidden = !expanded;
      for (const workspace of workspaces) {
        const current = scope?.deviceId === device.id && scope.cwd === workspace.path;
        const child = create("button", `nav-item workspace-nav-button${current ? " selected" : ""}`, workspaceName(workspace.path));
        child.type = "button"; child.title = workspace.path; child.dataset.navKey = JSON.stringify([device.id, workspace.path]);
        child.setAttribute("aria-label", `${device.name} / ${workspace.path}`);
        child.addEventListener("click", () => this.select({ deviceId: device.id, cwd: workspace.path }));
        children.append(child); addOption({ deviceId: device.id, cwd: workspace.path }, workspace.path);
      }
      if (!workspaces.length) children.append(create("p", "nav-empty", device.connected ? "暂无工作区" : "设备离线"));
      group.append(children); this.root.append(group); this.picker.append(options);
    }
    if (!scope) this.picker.value = "";
    if (focus) [...this.root.querySelectorAll("button")].find((button) => button.dataset.navKey === focus)?.focus({ preventScroll: true });
  }
}
