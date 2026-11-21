import { execFile, spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import type { ApprovalDecision, NodeApprovalNotice, NodeCompletionNotice } from "../shared/notifications.ts";
import { approvalClickUri } from "./windows-approval-clicks.ts";

export type DesktopNotice = NodeCompletionNotice | (NodeApprovalNotice & { receiverId: string; url?: string });
export type NotificationSender = (notice: DesktopNotice, signal: AbortSignal) => Promise<void>;
export type LinuxApprovalSender = (notice: NodeApprovalNotice, signal: AbortSignal, url?: string) => Promise<ApprovalDecision | undefined>;
const approvalLabels = { allow: "仅本次允许", deny: "拒绝" } as const;
const legacyDecisions = ["allow", "deny"] as const;
export interface NotificationCommand { program: string; args: string[]; input?: string }
const appleScript = 'on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv)\nend run';
// 探测和发送共用注册身份与权限检查，不能把能启动 PowerShell 当作通知可用。
const windowsSetup = String.raw`
if (-not [Environment]::UserInteractive -or (Get-Process -Id $PID).SessionId -eq 0) { throw '需要交互式桌面会话' }
$appId = Get-StartApps | Where-Object { $_.AppID -like '*\WindowsPowerShell\v1.0\powershell.exe' } | Select-Object -First 1 -ExpandProperty AppID
if (-not $appId) { throw '未找到已注册的 Windows PowerShell 通知应用标识' }
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId)
function Assert-NotificationSetting([bool]$allowFirstUse) {
  try { $setting = [string]$notifier.get_Setting() } catch {
    # 已注册的桌面应用在首次 Show 前可能没有通知设置。仅允许 ERROR_NOT_FOUND。
    if ($allowFirstUse -and $_.Exception.GetBaseException().HResult -eq -2147023728) { return }
    throw
  }
  if ($setting -ne 'Enabled') { throw "Windows 通知不可用：$setting" }
}
Assert-NotificationSetting $true
`;
// 脚本固定，来自中心的文字只经标准输入进入 XML 文本节点，不能成为 PowerShell 代码。
const windowsToast = `
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml('<toast><visual><binding template="ToastGeneric"><text></text><text></text></binding></visual></toast>')
$text = $xml.GetElementsByTagName('text')
$text.Item(0).AppendChild($xml.CreateTextNode([string]$data.title)) | Out-Null
$text.Item(1).AppendChild($xml.CreateTextNode([string]$data.body)) | Out-Null
if ($data.url) {
  $xml.DocumentElement.SetAttribute('launch', [string]$data.url)
  $xml.DocumentElement.SetAttribute('activationType', 'protocol')
}
if ($data.actions) {
  $text.Item(1).SetAttribute('hint-maxLines', '4')
  $actions = $xml.CreateElement('actions')
  foreach ($button in $data.actions) {
    $action = $xml.CreateElement('action')
    $action.SetAttribute('content', [string]$button.label)
    $action.SetAttribute('arguments', [string]$button.uri)
    $action.SetAttribute('activationType', 'protocol')
    $actions.AppendChild($action) | Out-Null
  }
  $xml.DocumentElement.AppendChild($actions) | Out-Null
}
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
$notifier.Show($toast)
Assert-NotificationSetting $false
`;
function windowsCommand(body: string, input?: string): NotificationCommand {
  const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try {
${windowsSetup}${body}
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`;
  return { program: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], input };
}
const linuxDesktop = (env: NodeJS.ProcessEnv) => (env.DISPLAY || env.WAYLAND_DISPLAY) && (env.DBUS_SESSION_BUS_ADDRESS || env.XDG_RUNTIME_DIR);
const isTermux = (env: NodeJS.ProcessEnv) => Boolean(env.TERMUX_VERSION || env.PREFIX?.startsWith("/data/data/com.termux/"));
const escapeBody = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export function notificationCommand(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, notice: DesktopNotice): NotificationCommand | null {
  if ("receiverId" in notice) {
    if (platform !== "win32" || env.SESSIONNAME?.toLowerCase() === "services") return null;
    const { title, body, receiverId, id, detail, url } = notice;
    const actions: { label: string; uri: string }[] = (detail?.decisions ?? legacyDecisions).map((decision) => ({
      label: approvalLabels[decision], uri: approvalClickUri(receiverId, id, decision),
    }));
    if (url) actions.push({ label: "查看审批", uri: url });
    return windowsCommand(windowsToast, JSON.stringify({ title, body, actions, url }));
  }
  const clean = (text: string) => Array.from(text.replace(/[\u0000-\u001f\u007f]/g, " ")).slice(0, 256).join("");
  const title = "o-pi 执行已完成"; const body = `${clean(notice.deviceName)} · ${clean(notice.title) || "未命名会话"}`;
  if (platform === "linux" && isTermux(env)) {
    return { program: "termux-notification", args: ["--title", title, "--content", body, "--id", "opi-hub-completion"] };
  }
  if (platform === "linux") {
    if (!linuxDesktop(env)) return null;
    return { program: "notify-send", args: ["--app-name=opi-hub", "--icon=dialog-information", "--urgency=normal", "--", title, escapeBody(body)] };
  }
  if (platform === "darwin") return { program: "/usr/bin/osascript", args: ["-e", appleScript, "--", title, body] };
  if (platform === "win32") {
    if (env.SESSIONNAME?.toLowerCase() === "services") return null;
    return windowsCommand(windowsToast, JSON.stringify({ title, body }));
  }
  return null;
}
async function executable(program: string): Promise<string | null> {
  const roots = path.isAbsolute(program) ? [""] : (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const root of roots) {
    const candidate = path.resolve(root, program);
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* 尝试下一个本机 PATH 目录。 */ }
  }
  return null;
}
function probe(program: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(program, args, { shell: false, windowsHide: true, timeout: 3000, stdio: "ignore" });
    child.once("error", () => resolve(false)); child.once("close", (code) => resolve(code === 0));
  });
}
function execute(command: NotificationCommand, signal?: AbortSignal, timeout = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(command.program, command.args, { encoding: "utf8", shell: false, windowsHide: true, timeout, maxBuffer: 8192, signal }, (error, stdout, stderr) => {
      if (error) {
        // 不记录 execFile 的完整错误消息，其中可能带有命令参数和通知摘要。
        const detail = stderr.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 512);
        reject(new Error(`通知命令失败（${error.killed ? "超时或已终止" : error.code ?? "unknown"}）${detail ? `：${detail}` : ""}`));
      } else resolve(stdout);
    });
    child.stdin?.on("error", () => {}); child.stdin?.end(command.input ?? "");
  });
}
export async function createLinuxApprovalNotifier(): Promise<LinuxApprovalSender> {
  const env = process.env;
  if (!linuxDesktop(env) || isTermux(env)) throw new Error("Linux 通知审批需要本机桌面会话和用户 D-Bus，不支持 Termux");
  const program = await executable("notify-send");
  if (!program || !(await execute({ program, args: ["--help"] })).includes("--action")) {
    throw new Error("Linux 通知审批需要支持 --action 的 notify-send");
  }
  return async ({ title, body, detail }, signal, url) => {
    const wait = 120_000;
    const decisions = detail?.decisions ?? legacyDecisions;
    const actions = decisions.map((decision) => `--action=${decision}=${approvalLabels[decision]}`);
    if (url) actions.push("--action=default=查看审批", "--action=open=查看审批");
    const args = ["--app-name=opi-hub", "--icon=dialog-question", `--expire-time=${wait}`, ...actions, "--", title, escapeBody(body)];
    const action = (await execute({ program, args }, signal, wait + 5000)).trim();
    if ((action === "allow" || action === "deny") && decisions.includes(action)) return action;
    if (url && (action === "default" || action === "open") && !signal.aborted) {
      // 只启动浏览器，不控制其生命周期。URL 由节点配置的 Hub 地址和交互标识构造。
      await new Promise<void>((resolve, reject) => {
        const opener = spawn("xdg-open", [url], { shell: false, detached: true, stdio: "ignore" });
        opener.once("error", reject);
        opener.once("spawn", () => { opener.unref(); resolve(); });
      });
    }
  };
}

export async function createSystemNotifier(): Promise<NotificationSender | null> {
  const env = { ...process.env }; const platform = process.platform;
  const sample: NodeCompletionNotice = { id: "probe", deviceId: "00000000-0000-0000-0000-000000000000", deviceName: "", title: "", completedAt: new Date().toISOString() };
  const plan = notificationCommand(platform, env, sample);
  if (!plan) return null;
  const program = await executable(plan.program); if (!program) return null;
  if (platform === "darwin") {
    const uid = process.getuid?.();
    if (uid === undefined || !await probe("/bin/launchctl", ["print", `gui/${uid}`])) return null;
  }
  if (platform === "win32") await execute({ ...windowsCommand(""), program });
  return async (notice, signal) => {
    const command = notificationCommand(platform, env, notice);
    if (!command) throw new Error("本机通知环境不可用");
    await execute({ ...command, program }, signal);
  };
}
