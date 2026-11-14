import { execFile, spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import type { NodeCompletionNotice } from "../shared/notifications.ts";

export type NotificationSender = (notice: NodeCompletionNotice, signal: AbortSignal) => Promise<void>;
export interface NotificationCommand { program: string; args: string[]; input?: string }
const appleScript = 'on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv)\nend run';
// 脚本固定，来自中心的文字只经标准输入进入 XML 文本节点，不能成为 PowerShell 代码。
const windowsScript = `
$ErrorActionPreference = 'Stop'
if (-not [Environment]::UserInteractive) { throw '需要交互式桌面会话' }
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml('<toast><visual><binding template="ToastGeneric"><text></text><text></text></binding></visual></toast>')
$text = $xml.GetElementsByTagName('text')
$text.Item(0).AppendChild($xml.CreateTextNode([string]$data.title)) | Out-Null
$text.Item(1).AppendChild($xml.CreateTextNode([string]$data.body)) | Out-Null
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Microsoft.Windows.PowerShell').Show($toast)
`;
export function notificationCommand(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, notice: NodeCompletionNotice): NotificationCommand | null {
  const clean = (text: string) => Array.from(text.replace(/[\u0000-\u001f\u007f]/g, " ")).slice(0, 256).join("");
  const title = "o-pi 执行已完成"; const body = `${clean(notice.deviceName)} · ${clean(notice.title) || "未命名会话"}`;
  if (platform === "linux" && (env.TERMUX_VERSION || env.PREFIX?.startsWith("/data/data/com.termux/"))) {
    return { program: "termux-notification", args: ["--title", title, "--content", body, "--id", "opi-hub-completion"] };
  }
  if (platform === "linux") {
    if ((!env.DISPLAY && !env.WAYLAND_DISPLAY) || (!env.DBUS_SESSION_BUS_ADDRESS && !env.XDG_RUNTIME_DIR)) return null;
    const escaped = body.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    return { program: "notify-send", args: ["--app-name=opi-hub", "--icon=dialog-information", "--urgency=normal", "--", title, escaped] };
  }
  if (platform === "darwin") return { program: "/usr/bin/osascript", args: ["-e", appleScript, "--", title, body] };
  if (platform === "win32") {
    if (env.SESSIONNAME?.toLowerCase() === "services") return null;
    return { program: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", windowsScript], input: JSON.stringify({ title, body }) };
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
  if (platform === "win32" && !await probe(program, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "if ([Environment]::UserInteractive -and (Get-Process -Id $PID).SessionId -ne 0) { exit 0 } else { exit 1 }"])) return null;
  return (notice, signal) => new Promise<void>((resolve, reject) => {
    const command = notificationCommand(platform, env, notice);
    if (!command) { reject(new Error("本机通知环境不可用")); return; }
    const child = execFile(program, command.args, { shell: false, windowsHide: true, timeout: 10_000, maxBuffer: 8192, signal }, (error) => {
      if (error) reject(new Error(`本机通知发送失败（${error.code ?? "unknown"}）`));
      else resolve();
    });
    child.stdin?.on("error", () => {}); child.stdin?.end(command.input ?? "");
  });
}
