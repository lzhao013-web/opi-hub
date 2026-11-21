#!/usr/bin/env node
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Store, secret } from "./hub/store.ts";
import { startHub } from "./hub/server.ts";
import { startNode } from "./node/agent.ts";
import { validateNodeConfig } from "./node/config.ts";
import { createLinuxApprovalNotifier } from "./node/system-notifications.ts";
import { openWindowsApprovalClicks, registerWindowsApprovalHandler } from "./node/windows-approval-clicks.ts";
import { registerWindowsFocusHandler } from "./node/windows-completion-focus.ts";

const usage = `opi-hub — o-pi 多设备 Web 入口

bun run init [--data ./data]              初始化中心，密码从 OPI_HUB_PASSWORD 读取，否则生成
bun run hub [--host 127.0.0.1] [--port 19200] [--data ./data]
            [--public-url https://hub.example.com] [--cert cert.pem --key key.pem]
bun run node --config ./node.json         连接中心，配置由管理界面生成
            [--windows-focus]              用支持 --focus 的默认浏览器激活已有会话页
            [--windows-approvals | --linux-approvals]  允许在本机系统通知中直接审批

节点根据 command 配置自动后台启动 opi-web，不支持外部后端或 target 配置。`;
async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    args: process.argv.slice(2), allowPositionals: true, strict: true,
    options: { data: { type: "string", default: "./data" }, host: { type: "string", default: "127.0.0.1" },
      port: { type: "string", default: "19200" }, "public-url": { type: "string" }, cert: { type: "string" }, key: { type: "string" },
      config: { type: "string" }, "windows-focus": { type: "boolean" }, "windows-approvals": { type: "boolean" }, "linux-approvals": { type: "boolean" }, help: { type: "boolean", short: "h" } },
  });
  if (values.help || !positionals.length) { console.log(usage); return; }
  if (positionals.length !== 1) throw new Error("只允许一个子命令");
  const command = positionals[0];
  if (command === "init") {
    const password = process.env.OPI_HUB_PASSWORD ?? secret();
    await Store.init(path.resolve(values.data), password);
    console.log(`中心数据已初始化：${path.resolve(values.data)}\n${process.env.OPI_HUB_PASSWORD ? "已使用 OPI_HUB_PASSWORD 设置密码" : `初始密码（请保存在密码管理器中）：${password}`}\n运行 bun run hub 启动中心`);
    return;
  }
  if (command === "hub") {
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("port 需要是 0–65535 的整数");
    if (Boolean(values.cert) !== Boolean(values.key)) throw new Error("cert 和 key 必须同时提供");
    const tls = values.cert && values.key ? { cert: await readFile(values.cert), key: await readFile(values.key) } : undefined;
    const hub = await startHub({ host: values.host, port, data: path.resolve(values.data), assets: fileURLToPath(new URL("./web/", import.meta.url)), publicUrl: values["public-url"], tls });
    console.log(`opi-hub: ${hub.url}`);
    if (hub.url !== hub.listenUrl) console.log(`监听地址：${hub.listenUrl}`);
    if (new URL(hub.url).protocol === "http:") console.warn("当前使用 HTTP。仅用于可信内网或本机，公网请配置 HTTPS。登录密码与会话内容不会由 HTTP 加密。");
    await untilSignal(); await hub.close();
    return;
  }
  if (command === "node") {
    if (!values.config) throw new Error("需要 --config ./node.json");
    const config = validateNodeConfig(JSON.parse(await readFile(values.config, "utf8")));
    if (values["windows-focus"]) config.windowsFocus = true;
    if (values["windows-approvals"] && (process.platform !== "win32" || !config.notifications)) {
      throw new Error("--windows-approvals 需要 Windows 和启用的节点通知");
    }
    if (values["linux-approvals"] && (process.platform !== "linux" || !config.notifications)) {
      throw new Error("--linux-approvals 需要 Linux 和启用的节点通知");
    }
    if (config.windowsFocus) {
      if (process.platform !== "win32" || !config.notifications) throw new Error("windowsFocus 或 --windows-focus 需要 Windows 和启用的节点通知");
      await registerWindowsFocusHandler();
    }
    const linuxSender = values["linux-approvals"] ? await createLinuxApprovalNotifier() : undefined;
    const clicks = values["windows-approvals"] ? await openWindowsApprovalClicks() : undefined;
    try {
      if (clicks) await registerWindowsApprovalHandler();
      const approvals = clicks ? { kind: "windows", clicks } as const : linuxSender ? { kind: "linux", send: linuxSender } as const : undefined;
      const node = startNode(config, console.log, undefined, approvals);
      await Promise.race([untilSignal(), node.closed]); await node.close();
    } finally { clicks?.close(); }
    return;
  }
  throw new Error(`未知子命令：${command}`);
}
function untilSignal(): Promise<void> {
  return new Promise((resolve) => {
    const done = () => { process.off("SIGINT", done); process.off("SIGTERM", done); resolve(); };
    process.once("SIGINT", done); process.once("SIGTERM", done);
  });
}
await main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
