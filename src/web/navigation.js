import { create } from "./management.js";
import { buildWorkspaceTree, workspaceAncestors } from "./workspace-tree.js";

export const workspaceName = (path) => path.replace(/[\\/]+$/, "").split(path.startsWith("/") && !path.startsWith("//") ? "/" : /[\\/]/).at(-1) || path;
function branchKey(deviceId, key) { return JSON.stringify([deviceId, key]); }
function folderIcon() {
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 24 24"); icon.setAttribute("aria-hidden", "true"); icon.classList.add("folder-icon");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M3 7V5a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z M3 8h18");
  icon.append(path); return icon;
}
export class Navigation {
  constructor(select) {
    this.select = select; this.collapsed = new Set(); this.options = new Map(); this.data = null; this.scope = null;
    this.root = document.getElementById("device-nav"); this.picker = document.getElementById("workspace-picker");
    this.panel = document.getElementById("workspace-panel"); this.tree = document.getElementById("workspace-tree");
    this.search = document.getElementById("workspace-tree-search");
    this.picker.addEventListener("change", () => { const scope = this.options.get(this.picker.value); if (scope) this.select(scope); });
    this.search.addEventListener("input", () => { this.tree.scrollTop = 0; if (this.data) this.render(this.data, this.scope); });
  }
  clear() {
    this.data = null; this.scope = null; this.collapsed.clear(); this.options.clear(); this.search.value = "";
    this.root.replaceChildren(); this.tree.replaceChildren(); this.picker.replaceChildren(); delete this.root.dataset.signature;
  }
  render(data, scope) {
    const deviceChanged = this.scope?.deviceId !== scope?.deviceId;
    const selectionChanged = deviceChanged || this.scope?.cwd !== scope?.cwd;
    if (deviceChanged) this.search.value = "";
    this.data = data; this.scope = scope;
    const chosen = data.devices.find((device) => device.id === scope?.deviceId);
    const paths = data.workspaces.filter((item) => item.deviceId === chosen?.id).map((item) => item.path);
    const tree = buildWorkspaceTree(paths);
    if (selectionChanged && scope?.cwd) for (const key of workspaceAncestors(tree, scope.cwd)) this.collapsed.delete(branchKey(chosen?.id, key));
    const query = this.search.value.trim().toLocaleLowerCase();
    const signature = JSON.stringify([scope, [...this.collapsed], query, data.devices.map((device) => [device.id, device.name, device.connected]), data.workspaces]);
    if (this.root.dataset.signature === signature) return;
    const focus = document.activeElement?.dataset.navKey; const scroll = this.tree.scrollTop;
    this.root.dataset.signature = signature; this.tree.replaceChildren(); this.panel.hidden = !chosen;
    document.getElementById("workspace-tree-device").textContent = chosen?.name ?? "";
    document.getElementById("workspace-tree-count").textContent = String(new Set(paths).size);
    this.renderDevices(data, scope);
    if (chosen) {
      const filtered = query ? buildWorkspaceTree(paths.filter((path) => path.toLocaleLowerCase().includes(query))) : tree;
      this.renderTree(filtered, chosen, scope.cwd, query);
      if (!filtered.length) this.tree.append(create("p", "nav-empty", query ? "没有匹配的工作区。" : chosen.connected ? "暂无工作区" : "设备离线，暂无工作区"));
    }
    this.tree.scrollTop = deviceChanged ? 0 : scroll;
    if (focus) [...this.root.querySelectorAll("button"), ...this.tree.querySelectorAll("button")].find((button) => button.dataset.navKey === focus)?.focus({ preventScroll: true });
    if (selectionChanged && scope?.cwd) this.revealSelection();
  }
  renderDevices(data, scope) {
    this.root.replaceChildren(); this.picker.replaceChildren(); this.options.clear();
    const placeholder = create("option", "", "选择设备或工作区"); placeholder.value = ""; this.picker.append(placeholder);
    for (const device of data.devices) {
      const current = scope?.deviceId === device.id;
      const button = create("button", `nav-item device-nav-button${current ? " selected" : ""}`);
      button.type = "button"; button.dataset.navKey = device.id;
      button.setAttribute("aria-expanded", String(current)); button.setAttribute("aria-controls", "workspace-panel"); button.setAttribute("aria-label", device.name);
      button.append(create("span", "branch-arrow", current ? "▾" : "▸"), create("span", `status-dot${device.connected ? " online" : ""}`), create("span", "nav-name", device.name));
      button.addEventListener("click", () => this.select({ deviceId: device.id, cwd: null })); this.root.append(button);
      const workspaces = data.workspaces.filter((item) => item.deviceId === device.id).sort((a, b) => a.path.localeCompare(b.path));
      const options = create("optgroup"); options.label = device.name;
      const addOption = (selection, label) => {
        const key = JSON.stringify(selection); const option = create("option", "", label); option.value = key;
        this.options.set(key, selection); if (scope?.deviceId === selection.deviceId && scope.cwd === selection.cwd) option.selected = true;
        options.append(option);
      };
      addOption({ deviceId: device.id, cwd: null }, `${device.name} · 设备概览`);
      for (const path of new Set(workspaces.map((item) => item.path))) addOption({ deviceId: device.id, cwd: path }, path);
      this.picker.append(options);
    }
    if (!scope) this.picker.value = "";
  }
  renderTree(nodes, device, cwd, query) {
    const list = create("ul", "workspace-tree-list"); let index = 0;
    const append = (nodes, parent) => {
      for (const node of nodes) {
        const item = create("li", "workspace-node"); const row = create("div", `tree-row${node.workspace !== null && cwd === node.workspace ? " selected" : ""}`);
        const key = branchKey(device.id, node.key); const expanded = Boolean(query) || !this.collapsed.has(key);
        const children = create("ul", "workspace-tree-list workspace-children"); children.id = `workspace-branch-${index++}`; children.hidden = !expanded;
        if (node.children.length) {
          const toggle = create("button", node.workspace === null ? "tree-directory" : "tree-toggle"); toggle.type = "button";
          toggle.dataset.navKey = JSON.stringify([key, "toggle"]); toggle.title = node.path;
          toggle.setAttribute("aria-label", `${expanded ? "折叠" : "展开"} ${node.label}`);
          toggle.setAttribute("aria-expanded", String(expanded)); toggle.setAttribute("aria-controls", children.id);
          const arrow = create("span", "tree-chevron", expanded ? "▾" : "▸"); arrow.setAttribute("aria-hidden", "true"); toggle.append(arrow);
          if (node.workspace === null) toggle.append(folderIcon(), create("span", "tree-name", node.label));
          toggle.addEventListener("click", () => { if (expanded) this.collapsed.add(key); else this.collapsed.delete(key); this.render(this.data, this.scope); });
          // 搜索期间展开所有匹配路径，避免把命中项藏在已折叠的分组里。
          toggle.disabled = Boolean(query); row.append(toggle);
        } else row.append(create("span", "tree-spacer"));
        if (node.workspace !== null) {
          const button = create("button", "workspace-select"); button.type = "button"; button.title = node.workspace;
          button.dataset.navKey = JSON.stringify([device.id, node.workspace, "select"]);
          button.setAttribute("aria-label", `${device.name} / ${node.workspace}`);
          if (cwd === node.workspace) button.setAttribute("aria-current", "page");
          button.append(folderIcon(), create("span", "tree-name", node.label));
          button.addEventListener("click", () => this.select({ deviceId: device.id, cwd: node.workspace })); row.append(button);
        }
        item.append(row);
        if (node.children.length) { append(node.children, children); item.append(children); }
        parent.append(item);
      }
    };
    append(nodes, list); this.tree.append(list);
  }
  revealSelection() {
    const selected = this.tree.querySelector('[aria-current="page"]');
    if (!selected || !this.tree.clientHeight) return;
    const bounds = this.tree.getBoundingClientRect(); const item = selected.getBoundingClientRect();
    if (item.top < bounds.top) this.tree.scrollTop -= bounds.top - item.top;
    else if (item.bottom > bounds.bottom) this.tree.scrollTop += item.bottom - bounds.bottom;
  }
}
