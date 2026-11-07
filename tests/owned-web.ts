import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { parseArgs } from "node:util";
import { appendFile } from "node:fs/promises";
import { WebSocket, WebSocketServer } from "ws";

const { values } = parseArgs({ options: {
  host: { type: "string" }, port: { type: "string" }, cwd: { type: "string" }, upstream: { type: "string" }, mode: { type: "string" },
  marker: { type: "string" }, descendant: { type: "boolean" }, "crash-after": { type: "string" },
} });
if (values.marker) await appendFile(values.marker, `${process.pid}\n`);
console.log(`fixture-pid: ${process.pid}`);
if (values.mode === "fail") { console.error("模拟启动失败 中文 😀"); process.exit(17); }
if (values.mode === "hang") { setInterval(() => {}, 1000); await new Promise(() => {}); }
const upstream = values.upstream ? new URL(values.upstream) : undefined;
const server = http.createServer((req, res) => {
  if (!upstream) { if (values.mode === "unhealthy") res.statusCode = 503; res.end(req.url === "/health" ? "ok" : "owned backend"); return; }
  const target = http.request({ hostname: upstream.hostname, port: upstream.port, path: req.url, method: req.method, headers: { ...req.headers, host: upstream.host, origin: upstream.origin } }, (response) => {
    res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res);
  });
  target.on("error", () => res.destroy()); req.on("error", () => target.destroy()); res.once("close", () => { if (!res.writableFinished) target.destroy(); }); req.pipe(target);
});
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  if (!upstream) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (viewer) => {
    const url = new URL(req.url ?? "/", upstream); url.protocol = "ws:";
    const target = new WebSocket(url, { headers: { Origin: upstream.origin }, perMessageDeflate: false });
    const early: { data: Buffer; binary: boolean }[] = [];
    target.on("open", () => { for (const item of early) target.send(item.data, { binary: item.binary }); early.length = 0; });
    viewer.on("message", (raw, binary) => {
      const data = Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw);
      if (target.readyState === WebSocket.OPEN) target.send(data, { binary }); else early.push({ data, binary });
    });
    target.on("message", (raw, binary) => { if (viewer.readyState === WebSocket.OPEN) viewer.send(raw, { binary }); });
    viewer.on("error", () => { viewer.terminate(); target.terminate(); }); target.on("error", () => { viewer.terminate(); target.terminate(); });
    viewer.once("close", () => target.terminate()); target.once("close", () => viewer.close());
  });
});
const descendant = values.descendant ? spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { windowsHide: true, stdio: "ignore" }) : undefined;
if (descendant) console.log(`fixture-descendant: ${descendant.pid}`);
await new Promise<void>((resolve) => server.listen(Number(values.port ?? "0"), values.host ?? "127.0.0.1", resolve));
const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing address");
console.log(`opi-web: http://${values.mode === "wrong" ? "192.0.2.1" : "127.0.0.1"}:${address.port}/`);
if (values["crash-after"]) setTimeout(() => process.exit(23), Number(values["crash-after"]));
const close = async () => {
  for (const ws of wss.clients) ws.terminate(); wss.close(); server.close(); server.closeAllConnections();
  if (descendant && descendant.exitCode === null && descendant.signalCode === null) await once(descendant, "exit");
  process.exit(0);
};
process.once("SIGTERM", () => { void close(); }); process.once("SIGINT", () => { void close(); });
