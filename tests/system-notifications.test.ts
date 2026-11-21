import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import childProcess, { ChildProcess, type ExecFileException, type ExecFileOptions } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import { createLinuxApprovalNotifier, createSystemNotifier, notificationCommand } from "../src/node/system-notifications.ts";
import { LocalNotifications } from "../src/node/notifications.ts";
import type { NodeCompletionNotice } from "../src/shared/notifications.ts";

const notice: NodeCompletionNotice = { id: "windows", deviceId: "00000000-0000-0000-0000-000000000001", deviceName: "测试设备", title: "中文 & <标题> ' $() 😀", completedAt: "2026-11-14T10:00:00.000Z" };
interface Invocation { program: string; args: string[]; options: ExecFileOptions; input: string }
interface Result { error: ExecFileException | null; stderr: string; stdout?: string }
const success: Result = { error: null, stderr: "" };
function script(args: string[]): string {
  const encoded = args.indexOf("-EncodedCommand");
  const value = args[encoded >= 0 ? encoded + 1 : args.indexOf("-Command") + 1];
  assert.ok(value); return encoded >= 0 ? Buffer.from(value, "base64").toString("utf16le") : value;
}
function mockCommands(t: TestContext, result: (call: Invocation) => Result): Invocation[] {
  const calls: Invocation[] = [];
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  t.mock.method(fs, "access", async () => {});
  t.mock.method(childProcess, "spawn", () => {
    const child = new ChildProcess(); queueMicrotask(() => child.emit("close", 0)); return child;
  });
  t.mock.method(childProcess, "execFile", (program: string, args: string[], options: ExecFileOptions, callback: (error: ExecFileException | null, stdout: string, stderr: string) => void) => {
    const child = new ChildProcess(); child.stdin = new PassThrough();
    const call: Invocation = { program, args, options, input: "" }; calls.push(call);
    child.stdin.on("data", (chunk: Buffer) => { call.input += chunk.toString("utf8"); });
    queueMicrotask(() => { const value = result(call); callback(value.error, value.stdout ?? "", value.stderr); });
    return child;
  });
  syncBuiltinESMExports(); return calls;
}

function windowsEnvironment(t: TestContext, result: (call: Invocation) => Result = () => success): Invocation[] {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform"); assert.ok(descriptor);
  const session = process.env.SESSIONNAME; process.env.SESSIONNAME = "Console";
  Object.defineProperty(process, "platform", { value: "win32" });
  t.after(() => {
    Object.defineProperty(process, "platform", descriptor);
    if (session === undefined) delete process.env.SESSIONNAME; else process.env.SESSIONNAME = session;
  });
  return mockCommands(t, result);
}

function setLinuxDesktop(t: TestContext) {
  const saved = { ...process.env };
  for (const key of ["DISPLAY", "DBUS_SESSION_BUS_ADDRESS", "TERMUX_VERSION", "PREFIX"]) {
    t.after(() => { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; });
  }
  process.env.DISPLAY = ":1"; process.env.DBUS_SESSION_BUS_ADDRESS = "unix:path=/run/user/1/bus";
  delete process.env.TERMUX_VERSION; delete process.env.PREFIX;
}

test("Linux 通知审批使用 notify-send 的按钮输出，关闭通知不提交决定", async (t) => {
  setLinuxDesktop(t);
  let output = "旧版 notify-send";
  const calls = mockCommands(t, () => ({ ...success, stdout: output }));
  await assert.rejects(createLinuxApprovalNotifier(), /需要支持 --action/);
  output = "  -A, --action=[NAME=]Text...";
  const send = await createLinuxApprovalNotifier();
  assert.deepEqual(calls.map(call => call.args), [["--help"], ["--help"]]);
  const approval = { id: crypto.randomUUID(), title: "--test", body: 'echo "<&>"' };
  const opened: { program: string; args: string[] }[] = [];
  t.mock.method(childProcess, "spawn", (program: string, args: string[]) => {
    opened.push({ program, args });
    const child = new ChildProcess();
    t.mock.method(child, "unref", () => {});
    queueMicrotask(() => child.emit("spawn"));
    return child;
  });
  syncBuiltinESMExports();
  const signal = new AbortController().signal;
  for (const [result, expected] of [["allow\n", "allow"], ["deny\n", "deny"], ["", undefined], ["default\n", undefined]] as const) {
    output = result;
    assert.equal(await send(approval, signal), expected);
  }
  const command = calls[2]; assert.ok(command);
  assert.ok(command.args.includes("--action=allow=仅本次允许"));
  assert.ok(command.args.includes("--action=deny=拒绝"));
  assert.deepEqual(command.args.slice(-3), ["--", "--test", 'echo "&lt;&amp;&gt;"']);
  assert.equal(command.options.shell, false);
  assert.equal(command.options.signal, signal);
  assert.deepEqual(opened, []);
  const url = "https://hub.example.test/#approval=a&session=b";
  const linked = { ...approval, detail: { deviceId: notice.deviceId, dialogId: "a", sessionId: "b", decisions: [] } };
  for (const click of ["default", "open"]) {
    output = `${click}\n`;
    assert.equal(await send(linked, signal, url), undefined);
    assert.deepEqual(opened.at(-1), { program: "xdg-open", args: [url] });
  }
  const viewOnly = calls.at(-1);
  assert.ok(viewOnly?.args.includes("--action=open=查看审批"));
  assert.ok(!viewOnly?.args.some(arg => arg.startsWith("--action=allow") || arg.startsWith("--action=deny")));
});

test("Linux 完成通知有动作时只在点击后打开链接，旧版仍可发普通通知", async (t) => {
  setLinuxDesktop(t);
  const platform = Object.getOwnPropertyDescriptor(process, "platform"); assert.ok(platform);
  Object.defineProperty(process, "platform", { value: "linux" });
  t.after(() => { Object.defineProperty(process, "platform", platform); });
  let output = "";
  const calls = mockCommands(t, () => ({ ...success, stdout: output }));
  const opened: string[][] = [];
  t.mock.method(childProcess, "spawn", (program: string, args: string[]) => {
    opened.push([path.basename(program), ...args]);
    const child = new ChildProcess();
    t.mock.method(child, "unref", () => {});
    queueMicrotask(() => child.emit("spawn"));
    return child;
  });
  syncBuiltinESMExports();
  const legacy = await createSystemNotifier(); assert.ok(legacy);
  assert.equal(legacy.waitForCompletionClick, undefined);
  const url = "https://hub.example.test/#completion=done%3A1";
  const signal = new AbortController().signal;
  await legacy(notice, signal, url);
  assert.ok(!calls.at(-1)?.args.some(arg => arg.startsWith("--action")));
  output = "  -A, --action=[NAME=]Text...";
  const sender = await createSystemNotifier(); assert.ok(sender?.waitForCompletionClick);
  output = "";
  await sender.waitForCompletionClick(notice, signal, url);
  assert.deepEqual(opened, []);
  assert.ok(calls.at(-1)?.args.includes("--action=open=查看结果"));
  output = "open\n";
  await sender.waitForCompletionClick(notice, signal, url);
  assert.deepEqual(opened, [["xdg-open", url]]);
});

test("Windows 订阅前验证已注册应用和通知权限，探测不发送弹窗", async (t) => {
  const calls = windowsEnvironment(t);
  const sender = await createSystemNotifier(); assert.ok(sender);
  assert.equal(calls.length, 1);
  const probe = calls[0]; assert.ok(probe);
  const source = script(probe.args);
  assert.ok(source.includes("Get-StartApps")); assert.ok(source.includes(".AppID"));
  assert.ok(source.includes(".get_Setting()")); assert.ok(!source.includes(".Show("));
  assert.ok(!source.includes("Microsoft.Windows.PowerShell")); assert.equal(probe.input, "");
  assert.equal(probe.options.windowsHide, true); assert.equal(probe.options.shell, false);
  const signal = new AbortController().signal; await sender(notice, signal);
  const sent = calls[1]; assert.ok(sent);
  assert.ok(script(sent.args).includes("Get-StartApps")); assert.ok(script(sent.args).includes(".get_Setting()"));
  assert.ok(!script(sent.args).includes(notice.title)); assert.ok(script(sent.args).includes(".Show("));
  assert.deepEqual(JSON.parse(sent.input), { title: "o-pi 执行已完成", body: `${notice.deviceName} · ${notice.title}` });
  assert.equal(sent.options.signal, signal); assert.equal(sent.options.windowsHide, true); assert.equal(sent.options.shell, false);
  const url = "https://hub.example.test/#completion=done%3A1";
  await sender(notice, signal, url);
  assert.deepEqual(JSON.parse(calls[2]?.input ?? ""), {
    title: "o-pi 执行已完成", body: `${notice.deviceName} · ${notice.title}`, url,
    actions: [{ label: "查看结果", uri: url }],
  });
});

test("Windows 缺失注册或系统禁用通知时不宣告可用，并保留诊断原因", async (t) => {
  let diagnostic = "未找到已注册的 Windows PowerShell 通知应用标识";
  windowsEnvironment(t, () => ({ error: Object.assign(new Error("不应记录包含整个脚本的错误"), { code: 1 }), stderr: diagnostic }));
  for (const reason of [diagnostic, "Windows 通知不可用：DisabledForUser", "Windows 通知不可用：DisabledByGroupPolicy"]) {
    diagnostic = reason; const logs: string[] = [];
    const local = new LocalNotifications(true, (line) => logs.push(line));
    assert.equal(await local.ready, false); await local.receive(notice); local.close();
    assert.ok(logs.some((line) => line.includes(reason) && line.includes("未订阅中心提醒")));
    assert.ok(!logs.join("").includes("不应记录包含整个脚本的错误"));
  }
});

test("通知发送失败保留退出码和有界诊断，不重试或记录命令全文", async (t) => {
  const calls = windowsEnvironment(t, (call) => call.input ? {
    error: Object.assign(new Error(`不应记录：${notice.title}`), { code: 7 }), stderr: `WinRT failure 0x80070490\r\n${"x".repeat(2000)}\u001b[31m`,
  } : success);
  const logs: string[] = []; const local = new LocalNotifications(true, (line) => logs.push(line));
  assert.equal(await local.ready, true); await local.receive(notice); await local.receive(notice); local.close();
  assert.equal(calls.filter((call) => call.input).length, 1);
  const message = logs.find((line) => line.includes("未自动重试")); assert.ok(message);
  assert.ok(message.includes("7")); assert.ok(message.includes("0x80070490"));
  assert.ok(message.length < 1000); assert.ok(!/[\r\n\u001b]/.test(message)); assert.ok(!message.includes(notice.title));
});

test("Windows 命令不再使用未注册的固定应用标识", () => {
  const command = notificationCommand("win32", { SESSIONNAME: "Console" }, notice); assert.ok(command);
  const source = script(command.args);
  assert.ok(!source.includes("Microsoft.Windows.PowerShell"));
  assert.ok(source.includes("Get-StartApps")); assert.ok(source.includes(".AppID"));
});

test("Windows 原生 XML 将通知正文作为文字，并为审批按钮设置协议激活", { skip: process.platform !== "win32", timeout: 15_000 }, () => {
  const id = "00000000-0000-0000-0000-000000000001";
  const receiverId = "00000000-0000-0000-0000-000000000002";
  const url = "https://hub.example.test/#approval=a&session=b";
  const plan = notificationCommand("win32", {}, { id, receiverId, title: "审批", body: 'echo "<&"', url });
  assert.ok(plan?.input);
  const source = script(plan.args);
  const xml = source.slice(source.indexOf("$data ="), source.indexOf("$toast ="));
  const probe = `[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
${xml}
[Console]::WriteLine($xml.GetXml())`;
  const result = childProcess.spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(probe, "utf16le").toString("base64")], {
    input: plan.input, encoding: "utf8", windowsHide: true, timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const escaped = url.replaceAll("&", "&amp;");
  assert.ok(result.stdout.includes(`<toast launch="${escaped}" activationType="protocol">`));
  assert.ok(result.stdout.includes(`content="查看审批" arguments="${escaped}" activationType="protocol"`));
  assert.match(result.stdout, /<text[^>]*>echo "&lt;&amp;"<\/text>/);
  assert.ok(result.stdout.includes(`content="仅本次允许" arguments="opi-hub-approval://${receiverId}/${id}/allow" activationType="protocol"`));
  assert.ok(result.stdout.includes(`content="拒绝" arguments="opi-hub-approval://${receiverId}/${id}/deny" activationType="protocol"`));
});

test("Windows 原生无弹窗探测拒绝仅有显示名称或错误标识的应用", { skip: process.platform !== "win32", timeout: 15_000 }, async (t) => {
  const calls = windowsEnvironment(t); await createSystemNotifier();
  const probe = calls[0]; assert.ok(probe);
  const source = script(probe.args); assert.ok(!source.includes(".Show("));
  const fakeApps = "function Get-StartApps { [pscustomobject]@{ Name='Windows PowerShell'; AppID='Microsoft.Windows.PowerShell' } }\n";
  const result = childProcess.spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(fakeApps + source, "utf16le").toString("base64")], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
  assert.equal(result.status, 1); assert.match(result.stderr, /未找到已注册/);
});

test("Windows 原生探测只兼容首次设置缺失，不吞掉禁用状态和其他 WinRT 错误", { skip: process.platform !== "win32", timeout: 20_000 }, async (t) => {
  const calls = windowsEnvironment(t); await createSystemNotifier();
  const probe = calls[0]; assert.ok(probe);
  const source = script(probe.args); assert.ok(!source.includes(".Show("));
  const factory = "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId)";
  assert.equal(source.split(factory).length, 2);
  const cases = [
    { getter: "return 'Enabled'", status: 0, diagnostic: "" },
    { getter: "throw [System.Runtime.InteropServices.COMException]::new('首次设置缺失', -2147023728)", status: 0, diagnostic: "" },
    { getter: "return 'DisabledForUser'", status: 1, diagnostic: "DisabledForUser" },
    { getter: "return 'DisabledForApplication'", status: 1, diagnostic: "DisabledForApplication" },
    { getter: "return 'DisabledByGroupPolicy'", status: 1, diagnostic: "DisabledByGroupPolicy" },
    { getter: "throw [System.Runtime.InteropServices.COMException]::new('访问被拒绝', -2147024891)", status: 1, diagnostic: "访问被拒绝" },
  ];
  for (const value of cases) {
    // 只替换 Windows 外部 API，不注册应用、不修改权限，也不调用 Show。
    const external = `function Get-StartApps { [pscustomobject]@{ Name='本地化名称'; AppID='{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe' } }
$mockNotifier = New-Object psobject
$mockNotifier | Add-Member -MemberType ScriptMethod -Name get_Setting -Value { ${value.getter} }
`;
    const mocked = external + source.replace(factory, "$mockNotifier");
    const result = childProcess.spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(mocked, "utf16le").toString("base64")], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
    assert.equal(result.status, value.status, result.stderr);
    if (value.diagnostic) assert.ok(result.stderr.includes(value.diagnostic), result.stderr);
  }
});
