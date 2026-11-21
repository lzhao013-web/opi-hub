import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createConnection, createServer } from "node:net";
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

export async function forwardWindowsApprovalClick(uri: string): Promise<void> {
  const click = decodeClick(uri);
  if (!click) return;
  await new Promise<void>((resolve) => {
    const socket = createConnection(pipe(click.receiverId), () => socket.end(uri));
    socket.setTimeout(2000, () => socket.destroy());
    socket.on("error", () => socket.destroy()); // 旧通知指向的节点可能已经退出。
    socket.once("close", () => resolve());
  });
}

export async function registerWindowsApprovalHandler(entry: string): Promise<void> {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Software\Classes\opi-hub-approval')
$key.SetValue('', 'URL:opi-hub 审批通知')
$key.SetValue('URL Protocol', '')
$key.CreateSubKey('shell\open\command').SetValue('', $env:OPI_HUB_APPROVAL_HANDLER)
`;
  // 注册固定入口。系统传入的 URL 只作为脚本的最后一个参数，不经过 cmd.exe。
  const command = `"${process.execPath}" "${entry}" notification-click "%1"`;
  await promisify(execFile)("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    env: { ...process.env, OPI_HUB_APPROVAL_HANDLER: command }, shell: false, windowsHide: true, timeout: 10_000,
  });
}
