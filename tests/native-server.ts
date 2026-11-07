import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startHub } from "../src/hub/server.ts";
import { Store } from "../src/hub/store.ts";
import { startNode } from "../src/node/agent.ts";
import { add, login, PASSWORD } from "./helpers.ts";

const source = process.env.OPI_WEB_BINARY;
if (!source) throw new Error("需要 OPI_WEB_BINARY 指向已构建的 opi-web 二进制");
const directory = await mkdtemp(path.join(tmpdir(), "opi-hub-native-"));
const home = path.join(directory, "home");
const cwd = path.join(directory, "workspace");
const agentDir = path.join(home, ".pi", "agent");
await mkdir(cwd, { recursive: true });
await mkdir(path.join(agentDir, "configs"), { recursive: true });
await mkdir(path.join(agentDir, "extensions"), { recursive: true });
await writeFile(path.join(agentDir, "extensions", "hub-test.js"), `export default function (pi) {
  pi.registerCommand("hub-test-confirm", { description: "独立测试审批", handler: async (_args, ctx) => {
    const approved = await ctx.ui.confirm("原生远程审批", "确认此隔离测试交互，不执行实际工具操作。");
    ctx.ui.notify(approved ? "中心确认完成" : "中心拒绝完成");
  } });
}`);
await writeFile(path.join(cwd, "hello.txt"), "原生 o-pi 远程文件预览\n");
await writeFile(path.join(agentDir, "settings.json"), '{"defaultProjectTrust":"never"}');
await writeFile(path.join(agentDir, "configs", "discord-presence.jsonc"), '{"enabled":false}');
const binary = path.join(directory, process.platform === "win32" ? "opi-web.exe" : "opi-web");
await copyFile(source, binary);
const childEnv = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|DISPLAY|XAUTHORITY|LD_LIBRARY_PATH|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS)$/i.test(entry[0])));
Object.assign(childEnv, { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", OPI_NO_NOTIFICATIONS: "1", NODE_ENV: "test", XDG_CONFIG_HOME: path.join(home, "config") });
const child = spawn(binary, ["--cwd", cwd, "--host", "127.0.0.1", "--port", "0"], { cwd, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
let output = "";
child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
const target = await new Promise<string>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`原生 Web 启动超时：${output}`)), 30_000);
  child.once("error", (error) => { clearTimeout(timer); reject(error); });
  child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`原生 Web 提前退出 ${code}：${output}`)); });
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
    const url = output.match(/opi-web: (http:\/\/[^\s]+)/)?.[1];
    if (url) { clearTimeout(timer); resolve(new URL(url).origin); }
  });
});
await Store.init(path.join(directory, "hub"), PASSWORD);
const hub = await startHub({ host: "127.0.0.1", port: 19292, data: path.join(directory, "hub"), assets: fileURLToPath(new URL("../src/web/", import.meta.url)) });
const device = await add(hub.url, await login(hub.url), "原生 o-pi");
const agent = startNode({ ...device.config, target }, () => {});
await agent.ready;
console.log(`Native fixture: ${hub.url}`);
process.send?.("ready");
let closing = false;
const close = async () => {
  if (closing) return; closing = true;
  await agent.close(); await hub.close();
  if (child.exitCode === null) await new Promise<void>((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    child.once("exit", () => { clearTimeout(timer); resolve(); }); child.kill("SIGTERM");
  });
  await rm(directory, { recursive: true, force: true });
  process.exit(0);
};
process.on("message", (message) => { if (message === "stop") void close(); });
process.once("SIGTERM", () => { void close(); });
process.once("SIGINT", () => { void close(); });
