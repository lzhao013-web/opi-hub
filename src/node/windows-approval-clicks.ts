import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { isApprovalId, type NotificationAnswer } from "../shared/notifications.ts";

const scheme = "opi-hub-approval";
const prefix = `${scheme}://`;
const maxUriLength = 100;
const pipe = (receiverId: string) => `\\\\.\\pipe\\${scheme}-${receiverId}`;

export function approvalClickUri(receiverId: string, id: string, decision: NotificationAnswer["decision"]): string {
  return `${prefix}${receiverId}/${id}/${decision}`;
}

function decodeClick(uri: string) {
  if (!uri.startsWith(prefix) || uri.length > maxUriLength) return;
  const [receiverId, id, decision, extra] = uri.slice(prefix.length).split("/");
  if (extra !== undefined || !isApprovalId(receiverId) || !isApprovalId(id) || (decision !== "allow" && decision !== "deny")) return;
  return { receiverId, answer: { type: "notificationAnswer", id, decision } satisfies NotificationAnswer };
}

export interface WindowsApprovalClicks {
  receiverId: string;
  onClick(handler: (answer: NotificationAnswer) => void): void;
  close(): void;
}
export async function openWindowsApprovalClicks(): Promise<WindowsApprovalClicks> {
  const receiverId = randomUUID();
  let handler: ((answer: NotificationAnswer) => void) | undefined;
  const server = createServer((socket) => {
    let uri = "";
    socket.setTimeout(2000, () => socket.destroy());
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => { uri += chunk; if (uri.length > maxUriLength) socket.destroy(); });
    socket.on("error", () => socket.destroy());
    socket.once("end", () => {
      const click = decodeClick(uri);
      if (click?.receiverId === receiverId) handler?.(click.answer);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipe(receiverId), () => { server.off("error", reject); resolve(); });
  });
  return { receiverId, onClick(value) { handler = value; }, close() { handler = undefined; server.close(); } };
}

// 由 Windows PowerShell 编译成 GUI 程序。点击时直接写入管道，不再启动控制台进程。
const launcherSource = `
using System;
using System.IO;
using System.IO.Pipes;
using System.Text;

public static class ApprovalClick {
  public static void Main(string[] args) {
    const string prefix = "${prefix}";
    if (args.Length != 1) return;
    string uri = args[0];
    int separator = prefix.Length + 36;
    if (uri.Length <= separator || uri.Length > ${maxUriLength} || !uri.StartsWith(prefix, StringComparison.Ordinal) || uri[separator] != '/') return;
    Guid receiver;
    if (!Guid.TryParseExact(uri.Substring(prefix.Length, 36), "D", out receiver)) return;
    try {
      using (var pipe = new NamedPipeClientStream(".", "${scheme}-" + receiver.ToString("D"), PipeDirection.Out)) {
        pipe.Connect(2000);
        byte[] bytes = Encoding.UTF8.GetBytes(uri);
        pipe.Write(bytes, 0, bytes.Length);
      }
    } catch (TimeoutException) { }
      catch (IOException) { }
      catch (UnauthorizedAccessException) { }
  }
}
`;

async function runPowerShell(script: string, env: NodeJS.ProcessEnv): Promise<void> {
  await promisify(execFile)("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    env: { ...process.env, ...env }, shell: false, windowsHide: true, timeout: 10_000,
  });
}

export async function prepareWindowsApprovalLauncher(directory: string): Promise<string> {
  const version = createHash("sha256").update(launcherSource).digest("hex").slice(0, 16);
  const launcher = path.join(directory, `approval-click-${version}.exe`);
  await mkdir(directory, { recursive: true });
  await runPowerShell(String.raw`
$ErrorActionPreference = 'Stop'
$output = $env:OPI_HUB_APPROVAL_EXE
if (-not [IO.File]::Exists($output)) {
  $temp = Join-Path ([IO.Path]::GetDirectoryName($output)) ([guid]::NewGuid().ToString() + '.exe')
  try {
    Add-Type -TypeDefinition $env:OPI_HUB_APPROVAL_SOURCE -OutputAssembly $temp -OutputType WindowsApplication
    try { [IO.File]::Move($temp, $output) }
    catch [IO.IOException] { if (-not [IO.File]::Exists($output)) { throw } }
  } finally { [IO.File]::Delete($temp) }
}
`, { OPI_HUB_APPROVAL_EXE: launcher, OPI_HUB_APPROVAL_SOURCE: launcherSource });
  return launcher;
}

export async function registerWindowsApprovalHandler(): Promise<void> {
  const local = process.env.LOCALAPPDATA;
  if (!local) throw new Error("Windows 审批入口需要 LOCALAPPDATA");
  const launcher = await prepareWindowsApprovalLauncher(path.join(local, "opi-hub"));
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Software\Classes\opi-hub-approval')
$key.SetValue('', 'URL:opi-hub 审批通知')
$key.SetValue('URL Protocol', '')
$key.CreateSubKey('shell\open\command').SetValue('', $env:OPI_HUB_APPROVAL_HANDLER)
`;
  // URL 只作为 GUI 程序的参数，不经过命令解释器。
  await runPowerShell(script, { OPI_HUB_APPROVAL_HANDLER: `"${launcher}" "%1"` });
}
