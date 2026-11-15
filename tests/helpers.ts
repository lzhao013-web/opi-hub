import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { startHub } from "../src/hub/server.ts";
import { startNode } from "../src/node/agent.ts";
import { Store } from "../src/hub/store.ts";
import { object } from "../src/shared/protocol.ts";
import type { NodeConfig } from "../src/node/config.ts";
import type { NotificationSender } from "../src/node/system-notifications.ts";
import { setTimeout as delay } from "node:timers/promises";
import { FakeExecution } from "./fake-execution.ts";
import type { ModelOption } from "../src/shared/models.ts";

export const PASSWORD = "test-password-1234";
const html = `<!doctype html><html><head><meta charset="utf-8"><title>o-pi fixture</title></head><body><h1 id="name">连接中</h1><p id="selected-session"></p><p id="selected-cwd"></p><p id="result"></p><p id="socket"></p><img id="preview" alt="文件预览"><form><input id="prompt" aria-label="消息"><button>发送</button></form><button id="approve">允许</button><button id="create-dialog">创建审批</button><button id="create-input">创建输入</button><p id="approval"></p><script type="module" src="./app.js"></script></body></html>`;
const app = `
const socket = new WebSocket(location.origin.replace(/^http/, 'ws') + '/api/events');
let client;
socket.onmessage = async (event) => {
 const value = JSON.parse(event.data);
 for (const item of value.events || []) {
  if (item.type === 'selected') {
   const field = document.querySelector('#selected-session'); field.textContent = item.session?.id || '';
   document.querySelector('#selected-cwd').textContent = item.session?.cwd || '';
   field.dataset.seen = (field.dataset.seen || '') + (item.session?.id ? item.session.id + ',' : '');
  }
 }
 if (value.client) {
  client = value.client;
  document.querySelector('#name').textContent = value.device;
  sessionStorage.setItem('opi.session', value.device);
  const result = await (await fetch('/api/query', {method:'POST',headers:{'Content-Type':'application/json','X-Opi-Client':client},body:'{}'})).json();
  document.querySelector('#result').textContent = result.device;
  document.querySelector('#preview').src = '/api/file?client=' + client;
 }
 if (value.echo) document.querySelector('#socket').textContent = value.echo;
};
document.querySelector('form').onsubmit = async (event) => {
 event.preventDefault();
 const input = document.querySelector('#prompt').value;
 const response = await fetch(new Request('/api/action', {method:'POST',headers:{'Content-Type':'application/json','X-Opi-Client':client},body:JSON.stringify({message:input})}));
 const result = await response.json();
 document.querySelector('#result').textContent = result.device + ':' + result.message;
 socket.send(JSON.stringify({echo:input}));
};
document.querySelector('#approve').onclick = async () => {
 const result = await (await fetch('/api/action', {method:'POST',headers:{'Content-Type':'application/json','X-Opi-Client':client},body:JSON.stringify({approve:true})})).json();
 document.querySelector('#approval').textContent = result.device + ':approved';
};
document.querySelector('#create-input').onclick = async () => {
 await fetch('/api/action', {method:'POST',headers:{'Content-Type':'application/json','X-Opi-Client':client},body:JSON.stringify({createInput:true})});
};
document.querySelector('#create-dialog').onclick = async () => {
 await fetch('/api/action', {method:'POST',headers:{'Content-Type':'application/json','X-Opi-Client':client},body:JSON.stringify({createDialog:true})});
};
`;
interface FixtureHistory { path: string; cwd: string; title: string; modified: string }
interface FixtureActivity extends FixtureHistory { sessionId: string; state: "idle" | "waiting" | "running" }
interface FixtureClient { ws: WebSocket; session: string | null; sequence: number; all: boolean; acknowledgements: number; historyQuery: boolean; purpose: string | null }
export async function fakeOpi(name: string) {
  const clients = new Map<string, FixtureClient>();
  let leaked = false;
  let catalogReads = 0;
  let historyGate: Promise<void> | undefined;
  let directoryGate: Promise<void> | undefined;
  let newCalls = 0; let workspaceCalls = 0; let directoryReads = 0;
  const cwd = `/fixture/${name}`;
  const history: FixtureHistory[] = [
    { path: `${cwd}/idle.jsonl`, cwd, title: `${name} 的空闲会话`, modified: "2026-11-07T10:00:00.000Z" },
    { path: `${cwd}/waiting.jsonl`, cwd, title: `${name} 的审批会话`, modified: "2026-11-07T11:00:00.000Z" },
    { path: `${cwd}/archive.jsonl`, cwd: `${cwd}/other`, title: `${name} 的历史任务`, modified: "2026-11-06T10:00:00.000Z" },
  ];
  const idle = history[0]; const waiting = history[1];
  if (!idle || !waiting) throw new Error("Missing fixture history");
  const activity: FixtureActivity[] = [ { ...idle, sessionId: "runtime-1", state: "idle" }, { ...waiting, sessionId: "runtime-2", state: "waiting" } ];
  const directoryPaths = new Set(["/", "/fixture", cwd, `${cwd}/other`, `${cwd}/新项目`, `${cwd}/trust`, `${cwd}/denied`]);
  const trusted = new Set<string>();
  const startup = new Map<string, { finish(): void }>();
  const dialogs = new Map<string, unknown[]>();
  const hiddenActivity = new Set<string>();
  const answers: { sessionId: string; dialogId: string; value: unknown }[] = [];
  const send = (client: FixtureClient, events: unknown[], initial?: string) => {
    if (client.ws.readyState === WebSocket.OPEN) client.ws.send(JSON.stringify({ kind: "frame", id: ++client.sequence, events, ...(initial ? { client: initial, device: name } : {}) }));
  };
  const selected = (client: FixtureClient) => {
    const current = activity.find((item) => item.sessionId === client.session);
    return current ? { id: current.sessionId, cwd: current.cwd, path: current.path } : null;
  };
  const publish = () => {
    for (const client of clients.values()) send(client, [{ type: "activity", value: activity.filter((item) => !hiddenActivity.has(item.sessionId)) }, { type: "dialogs", value: dialogs.get(client.session ?? "") ?? [] }, { type: "snapshot", value: execution.snapshot(client.session) }]);
  };
  const execution = new FakeExecution((id) => activity.find((item) => item.sessionId === id), publish, (session) => {
    hiddenActivity.delete(session.sessionId);
    if (!history.some((item) => item.path === session.path)) history.push({ path: session.path, cwd: session.cwd, title: session.title, modified: session.modified });
  }, name);
  const setDialogs = (sessionId: string, value: unknown[]) => {
    dialogs.set(sessionId, value);
    const current = activity.find((item) => item.sessionId === sessionId);
    if (current) current.state = value.length ? "waiting" : "idle";
    publish();
  };
  const makeSession = (directory: string) => {
    const id = crypto.randomUUID();
    const session: FixtureActivity = { sessionId: id, path: `${directory}/${id}.jsonl`, cwd: directory, title: "", modified: new Date().toISOString(), state: "idle" };
    activity.push(session); hiddenActivity.add(id); return session;
  };
  const chooseSession = (client: FixtureClient, session: FixtureActivity) => {
    client.session = session.sessionId;
    send(client, [{ type: "selected", session: selected(client) }, { type: "dialogs", value: dialogs.get(client.session) ?? [] }, { type: "snapshot", value: execution.snapshot(client.session) }]); publish();
  };
  const createDialog = () => setDialogs("runtime-2", [{ id: crypto.randomUUID(), kind: "confirm", title: `${name} 的远程审批`, message: `确认在 ${name} 执行测试操作？`, deadline: null }]);
  createDialog();
  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.headers.cookie || req.headers.authorization) leaked = true;
      if (url.pathname === "/health") { res.end("ok"); return; }
      if (url.pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/html", "Content-Security-Policy": "default-src 'self'; script-src 'self'; img-src 'self'; connect-src 'self'", "Referrer-Policy": "no-referrer" }); res.end(html); return;
      }
      if (url.pathname === "/app.js") { res.setHeader("Content-Type", "text/javascript"); res.end(app); return; }
      if (url.pathname === "/assets/cache-Ab12_cd3.js") {
        const body = `export default ${JSON.stringify(name)};\n/*${"cache-fixture 中文 ".repeat(8192)}*/`;
        const etag = '"cache-fixture"'; res.setHeader("ETag", etag);
        if (req.headers["if-none-match"]?.replace(/^W\//, "") === etag) { res.writeHead(304).end(); return; }
        res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Content-Length": Buffer.byteLength(body) }); res.end(req.method === "HEAD" ? undefined : body); return;
      }
      if (url.pathname === "/api/file") {
        if (!clients.has(url.searchParams.get("client") ?? "")) { res.writeHead(403).end(); return; }
        res.setHeader("Content-Type", "image/svg+xml"); res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><text>${name}</text></svg>`); return;
      }
      if (url.pathname === "/download") {
        const bytes = Buffer.alloc(3 * 1024 * 1024, name.charCodeAt(0));
        if (req.headers.range === "bytes=10-19") { res.writeHead(206, { "Content-Range": `bytes 10-19/${bytes.length}`, "Content-Length": 10 }); res.end(bytes.subarray(10, 20)); }
        else { res.setHeader("Content-Length", bytes.length); res.end(bytes); }
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        const address = server.address();
        if (!address || typeof address === "string" || req.headers.origin !== `http://127.0.0.1:${address.port}`) { res.writeHead(403).end("Wrong Origin"); return; }
        const client = clients.get(String(req.headers["x-opi-client"]));
        if (!client) { res.writeHead(403).end("Wrong client"); return; }
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        const raw = Buffer.concat(chunks).toString();
        const body: unknown = raw ? JSON.parse(raw) : {};
        if (object(body) && object(body.value)) {
          const action = body.value;
          if (action.query === "directories") {
            directoryReads++;
            if (directoryGate) await directoryGate;
            const directory = typeof action.path === "string" && action.path ? path.posix.resolve(cwd, action.path) : cwd;
            if (directory.endsWith("/denied")) { res.writeHead(400).end("EACCES: permission denied"); return; }
            if (!directoryPaths.has(directory)) { res.writeHead(400).end("ENOENT: directory not found"); return; }
            const children = [...directoryPaths].filter((child) => child !== directory && path.posix.dirname(child) === directory).map((child) => ({ name: path.posix.basename(child), path: child }));
            res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ path: directory, parent: path.posix.dirname(directory), children })); return;
          }
          if (action.action === "workspace") {
            workspaceCalls++;
            if (typeof action.path !== "string" || !directoryPaths.has(action.path)) { res.writeHead(400).end("ENOENT: directory not found"); return; }
            const directory = action.path;
            const session = [...activity].reverse().find((item) => item.cwd === directory) ?? makeSession(directory);
            let waiting: Promise<void> | undefined;
            if (directory.endsWith("/trust") && !trusted.has(directory)) {
              const gate = Promise.withResolvers<void>(); startup.set(session.sessionId, { finish: () => { trusted.add(directory); gate.resolve(); } }); waiting = gate.promise;
              setDialogs(session.sessionId, [{ id: crypto.randomUUID(), kind: "confirm", title: "信任新项目", message: directory, deadline: null }]);
            }
            chooseSession(client, session); if (waiting) await waiting;
          } else if (action.action === "new") {
            const source = activity.find((item) => item.sessionId === body.sessionId);
            if (!source) { res.writeHead(400).end("Unknown source session"); return; }
            newCalls++; chooseSession(client, makeSession(source.cwd));
          } else if (action.action === "rename") {
            const session = activity.find((item) => item.sessionId === body.sessionId); if (!session) { res.writeHead(400).end("Unknown rename session"); return; }
            session.title = String(action.name); publish();
          } else if (action.action === "model") {
            const session = activity.find((item) => item.sessionId === body.sessionId);
            const model = execution.models.find((item) => item.provider === action.provider && item.id === action.id);
            if (!session || !model) { res.writeHead(400).end("指定模型不可用"); return; }
            execution.setModel(session.sessionId, model);
          } else if (action.action === "prompt") {
            const id = String(body.sessionId); await execution.prompt(id, String(action.text), (dialogs) => setDialogs(id, dialogs), client.ws);
          } else if (action.action === "abort") {
            const id = String(body.sessionId); execution.abort(id); setDialogs(id, []);
          } else if (action.action === "sessions") {
            catalogReads++; if (historyGate) await historyGate;
            client.all = action.all === true;
            send(client, [{ type: "sessions", value: client.all ? history : history.filter((item) => item.cwd === cwd) }]);
          } else if (action.action === "openSession") {
            let target = activity.find((item) => item.sessionId === action.id || item.path === action.path);
            if (!target && typeof action.path === "string") {
              const stored = history.find((item) => item.path === action.path);
              if (stored) { target = { ...stored, sessionId: "archive-1", state: "idle" }; activity.push(target); }
            }
            if (!target) { res.writeHead(400).end("Unknown session"); return; }
            client.session = target.sessionId;
            send(client, [{ type: "selected", session: selected(client) }, { type: "dialogs", value: dialogs.get(client.session) ?? [] }, { type: "snapshot", value: execution.snapshot(client.session) }]); publish();
          } else if (action.action === "dialog") {
            const sessionId = String(body.sessionId);
            const pending = dialogs.get(sessionId) ?? [];
            const dialog = pending.find((item) => object(item) && item.id === action.id);
            if (!object(dialog)) { res.writeHead(400).end("Dialog already handled"); return; }
            if (dialog.kind === "confirm" && action.value !== null && action.value !== "yes") { res.writeHead(400).end("Invalid confirmation"); return; }
            if (Array.isArray(dialog.options) && action.value !== null && !dialog.options.some((option) => object(option) && option.value === action.value)) { res.writeHead(400).end("Invalid option"); return; }
            answers.push({ sessionId, dialogId: String(action.id), value: action.value });
            setDialogs(sessionId, pending.filter((item) => item !== dialog));
            startup.get(sessionId)?.finish(); startup.delete(sessionId); execution.answer(sessionId);
          } else { res.writeHead(400).end("Unknown action"); return; }
          res.writeHead(204).end(); return;
        }
        if (object(body) && body.createDialog) createDialog();
        if (object(body) && body.approve) setDialogs("runtime-2", []);
        if (object(body) && body.createInput) setDialogs("runtime-2", [{ id: crypto.randomUUID(), kind: "input", title: `${name} 的文本输入`, deadline: null, initial: "初始草稿", placeholder: "请输入" }]);
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ device: name, ...(object(body) ? body : {}) })); return;
      }
      res.writeHead(404).end();
    })().catch((error: unknown) => res.destroy(error instanceof Error ? error : undefined));
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const address = server.address();
    if (!address || typeof address === "string" || req.headers.origin !== `http://127.0.0.1:${address.port}`) { socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const id = crypto.randomUUID();
      const requested = new URL(req.url ?? "/", "http://localhost").searchParams.get("session");
      const client: FixtureClient = { ws, sequence: 0, all: false, acknowledgements: 0, historyQuery: requested === "hub-history-query", purpose: requested, session: requested ? activity.find((item) => item.sessionId === requested)?.sessionId ?? null : "runtime-1" };
      clients.set(id, client);
      send(client, [{ type: "client", id }, { type: "selected", session: selected(client) }, { type: "workspaces", value: [...new Set(history.map((item) => item.cwd))].map((path) => ({ path, exists: true })) }, { type: "sessions", value: history.filter((item) => item.cwd === cwd) }, { type: "activity", value: activity.filter((item) => !hiddenActivity.has(item.sessionId)) }, { type: "dialogs", value: dialogs.get(client.session ?? "") ?? [] }, { type: "snapshot", value: execution.snapshot(client.session) }], id);
      ws.on("message", (raw, binary) => {
        if (!binary) {
          const value: unknown = JSON.parse(raw.toString());
          if (object(value) && value.kind === "ack") { client.acknowledgements++; return; }
          if (object(value) && typeof value.echo === "string") { ws.send(JSON.stringify({ kind: "frame", id: ++client.sequence, events: [], echo: value.echo })); return; }
        }
        ws.send(raw, { binary });
      });
      ws.once("close", () => clients.delete(id));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  return {
    url: `http://127.0.0.1:${address.port}`, leaked: () => leaked, setDialogs, answers, prompts: execution.prompts, modelChanges: execution.modelChanges,
    setModels(models: ModelOption[]) { execution.models = models; publish(); },
    model: (id: string) => execution.model(id),
    selections: () => [...clients.values()].map((client) => client.session),
    deleteSession(id: string) {
      const index = activity.findIndex((item) => item.sessionId === id); if (index >= 0) activity.splice(index, 1);
      for (const client of clients.values()) send(client, [{ type: "sessionsDeleted", ids: [id], paths: [] }]); publish();
    },
    catalogReads: () => catalogReads,
    newCalls: () => newCalls, workspaceCalls: () => workspaceCalls, directoryReads: () => directoryReads,
    directoryClients: () => [...clients.values()].filter((client) => client.purpose === "hub-directory-query").length,
    holdDirectories() { const gate = Promise.withResolvers<void>(); directoryGate = gate.promise; return () => { directoryGate = undefined; gate.resolve(); }; },
    historyClients: () => [...clients.values()].filter((client) => client.historyQuery).length,
    holdHistory() { const gate = Promise.withResolvers<void>(); historyGate = gate.promise; return () => { historyGate = undefined; gate.resolve(); }; },
    disconnectClients() { for (const client of clients.values()) client.ws.terminate(); },
    hideActivity(sessionId: string) { hiddenActivity.add(sessionId); publish(); },
    acknowledgements: () => [...clients.values()].reduce((sum, client) => sum + client.acknowledgements, 0),
    patchTitle(title: string) {
      const item = history[0]; if (!item) throw new Error("Missing history"); item.title = title;
      for (const client of clients.values()) send(client, [{ type: "sessionsPatch", value: [{ values: client.all ? history : history.filter((row) => row.cwd === cwd) }] }]);
    },
    async close() { execution.close(); for (const ws of wss.clients) ws.terminate(); wss.close(); const closing = new Promise<void>((resolve) => server.close(() => resolve())); server.closeAllConnections(); await closing; },
  };
}
// 测试默认显式关闭本机通知；通知用例通过模拟发送器单独启用，避免依赖真实桌面。
export function managedConfig(config: { hub: string; token: string }, upstream: string, cwd: string): NodeConfig {
  return { ...config, command: [process.execPath, fileURLToPath(new URL("./owned-web.ts", import.meta.url)), "--upstream", upstream], cwd, notifications: false };
}
export async function waitDevices(base: string, cookie: string, count: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (true) {
    const value: unknown = await (await fetch(base + "/_hub/overview", { headers: { Cookie: cookie } })).json();
    if (object(value) && Array.isArray(value.devices) && value.devices.filter((item) => object(item) && object(item.report) && item.report.ready === true && object(item.management) && item.management.state === "ready").length === count) return;
    if (Date.now() > deadline) throw new Error(`托管后端未就绪：${JSON.stringify(value)}`);
    await delay(20);
  }
}
export async function fixture(port = 0, notifications: { a?: NotificationSender; b?: NotificationSender } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "opi-hub-"));
  await Store.init(directory, PASSWORD);
  const hub = await startHub({ host: "127.0.0.1", port, data: directory, assets: fileURLToPath(new URL("../src/web/", import.meta.url)) });
  const fakeA = await fakeOpi("设备 A");
  const fakeB = await fakeOpi("设备 B");
  const cookie = await login(hub.url);
  const a = await add(hub.url, cookie, "开发台式机");
  const b = await add(hub.url, cookie, "笔记本");
  const notifyA = notifications.a; const notifyB = notifications.b;
  const agentA = startNode({ ...managedConfig(a.config, fakeA.url, directory), notifications: Boolean(notifyA) }, () => {}, notifyA ? async () => notifyA : undefined);
  const agentB = startNode({ ...managedConfig(b.config, fakeB.url, directory), notifications: Boolean(notifyB) }, () => {}, notifyB ? async () => notifyB : undefined);
  await Promise.all([agentA.ready, agentB.ready]); await waitDevices(hub.url, cookie, 2);
  return {
    hub, directory, cookie, a, b, fakeA, fakeB, agentA, agentB,
    async close() {
      await Promise.all([agentA.close(), agentB.close()]);
      await hub.close(); await Promise.all([fakeA.close(), fakeB.close()]);
      await rm(directory, { recursive: true, force: true });
    },
  };
}
export async function login(base: string): Promise<string> {
  const response = await fetch(`${base}/_hub/login`, { method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ password: PASSWORD }) });
  if (response.status !== 200) throw new Error(`Login failed: ${await response.text()}`);
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("No cookie");
  return cookie;
}
export async function add(base: string, cookie: string, name: string): Promise<{ id: string; config: { hub: string; token: string; command: [string, ...string[]] } }> {
  const response = await fetch(`${base}/_hub/devices`, { method: "POST", headers: { Cookie: cookie, Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
  const value: unknown = await response.json();
  if (!object(value) || typeof value.id !== "string" || !object(value.config) || typeof value.config.hub !== "string" || typeof value.config.token !== "string" || !Array.isArray(value.config.command) || !value.config.command.every((part: unknown) => typeof part === "string")) throw new Error("Invalid enrollment");
  const [executable, ...args] = value.config.command;
  if (typeof executable !== "string") throw new Error("Missing managed backend command");
  return { id: value.id, config: { hub: value.config.hub, token: value.config.token, command: [executable, ...args] } };
}
