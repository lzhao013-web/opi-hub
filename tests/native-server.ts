import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startHub } from "../src/hub/server.ts";
import { Store } from "../src/hub/store.ts";
import { startNode } from "../src/node/agent.ts";
import { add, login, PASSWORD, waitDevices } from "./helpers.ts";
import { startModel } from "./model.ts";

const source = process.env.OPI_WEB_BINARY;
if (!source) throw new Error("需要 OPI_WEB_BINARY 指向已构建的 opi-web 二进制");
const directory = await mkdtemp(path.join(tmpdir(), "opi-hub-native-"));
const home = path.join(directory, "home");
const cwd = path.join(directory, "workspace");
const agentDir = path.join(home, ".pi", "agent");
await mkdir(cwd, { recursive: true });
await mkdir(path.join(directory, "remote-project"));
await mkdir(path.join(directory, "trust-project"));
await mkdir(path.join(directory, "scheduled-project"));
await writeFile(path.join(directory, "scheduled-project", "AGENTS.md"), "# 定时任务隔离测试\n");
await writeFile(path.join(directory, "remote-project", "remote.txt"), "remote project\n");
await writeFile(path.join(directory, "trust-project", "AGENTS.md"), "# 隔离测试项目\n");
await mkdir(path.join(agentDir, "configs"), { recursive: true });
const savedDirectory = path.join(agentDir, "sessions", "saved-fixture"); await mkdir(savedDirectory, { recursive: true });
const savedAt = new Date().toISOString(); const infoId = crypto.randomUUID();
const savedEntries = [
  { type: "session", version: 3, id: crypto.randomUUID(), timestamp: savedAt, cwd },
  { type: "session_info", id: infoId, parentId: null, timestamp: savedAt, name: "托管重启保留历史" },
  { type: "message", id: crypto.randomUUID(), parentId: infoId, timestamp: savedAt, message: { role: "user", content: "已保存的隔离测试历史", timestamp: Date.now() } },
];
await writeFile(path.join(savedDirectory, "saved.jsonl"), savedEntries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
await mkdir(path.join(agentDir, "extensions"), { recursive: true });
await writeFile(path.join(agentDir, "extensions", "hub-test.js"), `export default function (pi) {
  pi.on("project_trust", async (event, ctx) => {
    if (!event.cwd.endsWith("trust-project") && !event.cwd.endsWith("scheduled-project")) return { trusted: "undecided" };
    const approved = await ctx.ui.confirm("确认新建项目信任", event.cwd);
    return { trusted: approved ? "yes" : "no", remember: false };
  });
  pi.registerCommand("hub-test-confirm", { description: "独立测试审批", handler: async (_args, ctx) => {
    const approved = await ctx.ui.confirm("原生远程审批", "确认此隔离测试交互，不执行实际工具操作。");
    ctx.ui.notify(approved ? "中心确认完成" : "中心拒绝完成");
  } });
}`);
await writeFile(path.join(cwd, "hello.txt"), "原生 o-pi 远程文件预览\n");
const model = await startModel();
await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "never", defaultProvider: "hub-fixture", defaultModel: "test", compaction: { enabled: false }, retry: { enabled: false } }));
await writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { "hub-fixture": { api: "openai-completions", baseUrl: model.url, apiKey: "fixture", models: [{ id: "test", name: "Fixture", input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
await writeFile(path.join(agentDir, "configs", "auto-title.jsonc"), '{"enabled":false}');
await writeFile(path.join(agentDir, "configs", "discord-presence.jsonc"), '{"enabled":false}');
const binary = path.join(directory, process.platform === "win32" ? "opi-web.exe" : "opi-web");
await copyFile(source, binary);
const childEnv = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|DISPLAY|XAUTHORITY|LD_LIBRARY_PATH|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS)$/i.test(entry[0])));
Object.assign(childEnv, { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", OPI_NO_NOTIFICATIONS: "1", NODE_ENV: "test", XDG_CONFIG_HOME: path.join(home, "config") });
// 此脚本是独立测试进程。托管子进程只继承隔离环境，不读取用户真实配置。
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, childEnv);
await Store.init(path.join(directory, "hub"), PASSWORD);
const hub = await startHub({ host: "127.0.0.1", port: 19292, data: path.join(directory, "hub"), assets: fileURLToPath(new URL("../src/web/", import.meta.url)) });
const device = await add(hub.url, await login(hub.url), "原生 o-pi");
const agent = startNode({ ...device.config, command: [binary], cwd }, () => {});
await agent.ready; await waitDevices(hub.url, await login(hub.url), 1);
console.log(`Native fixture: ${hub.url}`);
process.send?.("ready");
let closing = false;
const close = async () => {
  if (closing) return; closing = true;
  await agent.close(); await hub.close(); await model.close();
  await rm(directory, { recursive: true, force: true });
  process.exit(0);
};
process.on("message", (message) => { if (message === "stop") void close(); });
process.once("SIGTERM", () => { void close(); });
process.once("SIGINT", () => { void close(); });
