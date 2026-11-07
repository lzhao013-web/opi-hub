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

export const PASSWORD = "test-password-1234";
const html = `<!doctype html><html><head><meta charset="utf-8"><title>o-pi fixture</title></head><body><h1 id="name">连接中</h1><p id="selected-session"></p><p id="result"></p><p id="socket"></p><img id="preview" alt="文件预览"><form><input id="prompt" aria-label="消息"><button>发送</button></form><button id="approve">允许</button><button id="create-dialog">创建审批</button><button id="create-input">创建输入</button><p id="approval"></p><script type="module" src="./app.js"></script></body></html>`;
const app = `
const socket = new WebSocket(location.origin.replace(/^http/, 'ws') + '/api/events');
let client;
socket.onmessage = async (event) => {
 const value = JSON.parse(event.data);
 for (const item of value.events || []) {
  if (item.type === 'selected') {
   const field = document.querySelector('#selected-session'); field.textContent = item.session?.id || '';
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
interface FixtureClient { ws: WebSocket; session: string | null; sequence: number; all: boolean; acknowledgements: number; historyQuery: boolean }
export async function fakeOpi(name: string) {
  const clients = new Map<string, FixtureClient>();
  let leaked = false;
  let catalogReads = 0;
  let historyGate: Promise<void> | undefined;
  const cwd = `/fixture/${name}`;
  const history: FixtureHistory[] = [
    { path: `${cwd}/idle.jsonl`, cwd, title: `${name} 的空闲会话`, modified: "2026-11-07T10:00:00.000Z" },
    { path: `${cwd}/waiting.jsonl`, cwd, title: `${name} 的审批会话`, modified: "2026-11-07T11:00:00.000Z" },
    { path: `${cwd}/archive.jsonl`, cwd: `${cwd}/other`, title: `${name} 的历史任务`, modified: "2026-11-06T10:00:00.000Z" },
  ];
  const idle = history[0]; const waiting = history[1];
  if (!idle || !waiting) throw new Error("Missing fixture history");
  const activity: FixtureActivity[] = [ { ...idle, sessionId: "runtime-1", state: "idle" }, { ...waiting, sessionId: "runtime-2", state: "waiting" } ];
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
    for (const client of clients.values()) send(client, [{ type: "activity", value: activity.filter((item) => !hiddenActivity.has(item.sessionId)) }, { type: "dialogs", value: dialogs.get(client.session ?? "") ?? [] }]);
  };
  const setDialogs = (sessionId: string, value: unknown[]) => {
    dialogs.set(sessionId, value);
    const current = activity.find((item) => item.sessionId === sessionId);
    if (current) current.state = value.length ? "waiting" : "idle";
    publish();
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
          if (action.action === "sessions") {
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
            send(client, [{ type: "selected", session: selected(client) }, { type: "dialogs", value: dialogs.get(client.session) ?? [] }]); publish();
          } else if (action.action === "dialog") {
            const sessionId = String(body.sessionId);
            const pending = dialogs.get(sessionId) ?? [];
            const dialog = pending.find((item) => object(item) && item.id === action.id);
            if (!object(dialog)) { res.writeHead(400).end("Dialog already handled"); return; }
            if (dialog.kind === "confirm" && action.value !== null && action.value !== "yes") { res.writeHead(400).end("Invalid confirmation"); return; }
            if (Array.isArray(dialog.options) && action.value !== null && !dialog.options.some((option) => object(option) && option.value === action.value)) { res.writeHead(400).end("Invalid option"); return; }
            answers.push({ sessionId, dialogId: String(action.id), value: action.value });
            setDialogs(sessionId, pending.filter((item) => item !== dialog));
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
      const client: FixtureClient = { ws, sequence: 0, all: false, acknowledgements: 0, historyQuery: requested === "hub-history-query", session: requested ? activity.find((item) => item.sessionId === requested)?.sessionId ?? null : "runtime-1" };
      clients.set(id, client);
      send(client, [{ type: "client", id }, { type: "selected", session: selected(client) }, { type: "workspaces", value: [...new Set(history.map((item) => item.cwd))].map((path) => ({ path, exists: true })) }, { type: "sessions", value: history.filter((item) => item.cwd === cwd) }, { type: "activity", value: activity.filter((item) => !hiddenActivity.has(item.sessionId)) }, { type: "dialogs", value: dialogs.get(client.session ?? "") ?? [] }], id);
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
    url: `http://127.0.0.1:${address.port}`, leaked: () => leaked, setDialogs, answers,
    selections: () => [...clients.values()].map((client) => client.session),
    catalogReads: () => catalogReads,
    historyClients: () => [...clients.values()].filter((client) => client.historyQuery).length,
    holdHistory() { const gate = Promise.withResolvers<void>(); historyGate = gate.promise; return () => { historyGate = undefined; gate.resolve(); }; },
    disconnectClients() { for (const client of clients.values()) client.ws.terminate(); },
    hideActivity(sessionId: string) { hiddenActivity.add(sessionId); publish(); },
    acknowledgements: () => [...clients.values()].reduce((sum, client) => sum + client.acknowledgements, 0),
    patchTitle(title: string) {
      const item = history[0]; if (!item) throw new Error("Missing history"); item.title = title;
      for (const client of clients.values()) send(client, [{ type: "sessionsPatch", value: [{ values: client.all ? history : history.filter((row) => row.cwd === cwd) }] }]);
    },
    async close() { for (const ws of wss.clients) ws.terminate(); wss.close(); const closing = new Promise<void>((resolve) => server.close(() => resolve())); server.closeAllConnections(); await closing; },
  };
}
export async function fixture(port = 0) {
  const directory = await mkdtemp(path.join(tmpdir(), "opi-hub-"));
  await Store.init(directory, PASSWORD);
  const hub = await startHub({ host: "127.0.0.1", port, data: directory, assets: fileURLToPath(new URL("../src/web/", import.meta.url)) });
  const fakeA = await fakeOpi("设备 A");
  const fakeB = await fakeOpi("设备 B");
  const cookie = await login(hub.url);
  const a = await add(hub.url, cookie, "开发台式机");
  const b = await add(hub.url, cookie, "笔记本");
  const agentA = startNode({ ...a.config, target: fakeA.url }, () => {});
  const agentB = startNode({ ...b.config, target: fakeB.url }, () => {});
  await Promise.all([agentA.ready, agentB.ready]);
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
export async function add(base: string, cookie: string, name: string): Promise<{ id: string; config: { hub: string; token: string; target: string } }> {
  const response = await fetch(`${base}/_hub/devices`, { method: "POST", headers: { Cookie: cookie, Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
  const value: unknown = await response.json();
  if (!object(value) || typeof value.id !== "string" || !object(value.config) || typeof value.config.hub !== "string" || typeof value.config.token !== "string" || typeof value.config.target !== "string") throw new Error("Invalid enrollment");
  return { id: value.id, config: { hub: value.config.hub, token: value.config.token, target: value.config.target } };
}
