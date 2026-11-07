export const create = (tag, className = "", text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
export function sessionUrl(deviceId, target) {
  const query = new URLSearchParams("id" in target ? { "hub-session": target.id } : { "hub-path": target.path });
  return `/n/${deviceId}/?${query}`;
}
const labels = { history: "历史", idle: "空闲", loading: "加载中", running: "运行中", waiting: "等待交互" };
const order = { waiting: 0, running: 1, loading: 2, idle: 3, history: 4 };
function link(deviceId, target, label) {
  const node = create("a", "secondary", label);
  node.href = sessionUrl(deviceId, target); node.target = "_blank"; node.rel = "noopener";
  return node;
}
export function renderSessionList(root, sessions, devices, empty) {
  const sorted = [...sessions].sort((a, b) => order[a.state] - order[b.state] || b.modified.localeCompare(a.modified));
  const signature = JSON.stringify([empty, sorted.map((session) => [session, devices.get(session.deviceId)?.name])]);
  if (root.dataset.signature === signature) return;
  root.dataset.signature = signature; root.replaceChildren();
  if (!sorted.length) root.append(create("p", "management-empty muted", empty));
  for (const session of sorted) {
    const row = create("article", "session-row");
    const content = create("div", "session-row-content");
    const heading = create("div", "session-row-heading");
    heading.append(create("h2", "", session.title || "未命名会话"), create("span", `session-state ${session.state}`, labels[session.state]));
    content.append(heading, create("p", "session-location", `${devices.get(session.deviceId)?.name} · ${session.cwd}`));
    row.append(content, link(session.deviceId, session.target, "进入会话 ↗")); root.append(row);
  }
}
export class ManagementView {
  constructor(request, refresh) {
    this.request = request; this.refresh = refresh;
    this.interactions = document.getElementById("interactions");
    this.status = document.getElementById("management-status");
    this.cards = new Map();
    this.fieldId = 0;
  }
  clear() { this.cards.clear(); this.interactions.replaceChildren(); this.status.replaceChildren(); }
  render(data, deviceId, view) {
    const devices = new Map(data.devices.map((device) => [device.id, device]));
    const active = new Set(data.interactions.map((item) => JSON.stringify([item.deviceId, item.sessionId, item.id])));
    for (const [key, card] of this.cards) if (!active.has(key)) { card.remove(); this.cards.delete(key); }
    const visible = data.interactions;
    for (const [index, item] of visible.entries()) {
      const key = JSON.stringify([item.deviceId, item.sessionId, item.id]);
      let card = this.cards.get(key);
      if (!card) { card = this.interaction(item); this.cards.set(key, card); }
      const session = data.sessions.find((session) => session.deviceId === item.deviceId && session.target.id === item.sessionId);
      card.querySelector(".interaction-context").textContent = `${devices.get(item.deviceId)?.name} · ${session?.title || item.sessionId}`;
      if (this.interactions.children[index] !== card) this.interactions.insertBefore(card, this.interactions.children[index] ?? null);
    }
    const visibleKeys = new Set(visible.map((item) => JSON.stringify([item.deviceId, item.sessionId, item.id])));
    for (const [key, card] of this.cards) if (!visibleKeys.has(key)) card.remove();
    const empty = this.interactions.querySelector(".management-empty");
    if (!visible.length && !empty) this.interactions.append(create("p", "management-empty muted", "当前没有待处理交互。"));
    else if (visible.length) empty?.remove();
    this.status.replaceChildren();
    if (view !== "devices") for (const device of data.devices.filter((item) => !deviceId || item.id === deviceId)) {
      let message = "";
      if (!device.connected) message = deviceId ? "设备离线，不展示旧会话或交互" : "";
      else if (device.management.state === "error") message = device.management.message;
      else if (device.management.state === "connecting") message = deviceId ? "正在订阅会话目录" : "";
      else if (device.management.issues.length) message = device.management.issues.join("\n");
      if (message) this.status.append(create("p", "notice", `${device.name}: ${message}`));
    }
  }
  interaction(item) {
    const card = create("article", "interaction");
    card.dataset.dialogId = item.id; card.dataset.deviceId = item.deviceId;
    const header = create("div", "interaction-heading");
    const heading = create("div"); heading.append(create("h2", "", item.title), create("p", "interaction-context muted"));
    header.append(heading, link(item.deviceId, { id: item.sessionId }, "查看会话 ↗")); card.append(header);
    if (item.kind === "confirm") card.append(create("p", "interaction-message", item.message));
    if (item.kind === "command") {
      card.append(create("p", "muted", item.cwd), create("pre", "command-preview", item.command));
      const targets = create("dl", "command-targets");
      for (const target of item.targets) targets.append(create("dt", "", `${target.action} · ${target.kind} · ${target.target}`), create("dd", "", target.reason));
      card.append(targets);
    }
    let input;
    const form = create("form", "interaction-form");
    if (["input", "secret", "editor"].includes(item.kind)) {
      const id = `interaction-field-${++this.fieldId}`;
      const label = create("label", "", item.kind === "editor" ? "编辑内容" : "回答"); label.htmlFor = id;
      input = create(item.kind === "editor" ? "textarea" : "input");
      input.id = id; input.value = item.initial;
      if (item.kind === "editor") input.rows = 6;
      else { input.type = item.kind === "secret" ? "password" : "text"; input.placeholder = item.placeholder; input.autocomplete = "off"; }
      form.append(label, input);
    }
    const feedback = create("p", "interaction-feedback"); feedback.setAttribute("role", "status"); feedback.hidden = true;
    const actions = create("div", "interaction-actions");
    let busy = false;
    const submit = async (value) => {
      if (busy) return;
      busy = true; feedback.hidden = false; feedback.textContent = "正在提交…"; feedback.classList.remove("error");
      for (const control of form.querySelectorAll("button,input,textarea")) control.disabled = true;
      try {
        await this.request("/_hub/respond", { method: "POST", body: JSON.stringify({ deviceId: item.deviceId, sessionId: item.sessionId, dialogId: item.id, value }) });
        feedback.textContent = "已提交，等待设备更新";
        await this.refresh();
      } catch (error) {
        busy = false; feedback.textContent = error.message; feedback.classList.add("error");
        for (const control of form.querySelectorAll("button,input,textarea")) control.disabled = false;
      }
    };
    const button = (label, value, primary) => {
      const node = create("button", primary ? "primary" : "secondary", label); node.type = "button";
      node.addEventListener("click", () => { void submit(value); }); actions.append(node);
    };
    if (item.kind === "choice" || item.kind === "command") for (const option of item.options) button(option.label, option.value, false);
    else if (item.kind === "confirm") { button("确认", "yes", true); button("拒绝", null, false); }
    else {
      const send = create("button", "primary", "提交回答"); send.type = "submit"; actions.append(send);
      form.addEventListener("submit", (event) => { event.preventDefault(); void submit(input.value); });
    }
    if (item.kind !== "confirm") button("取消交互", null, false);
    if (item.deadline !== null) card.append(create("p", "footnote", `截止时间：${new Date(item.deadline).toLocaleString()}`));
    form.append(actions, feedback); card.append(form);
    return card;
  }
}
