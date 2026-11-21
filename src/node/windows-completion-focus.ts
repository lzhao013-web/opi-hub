import path from "node:path";
import { prepareLauncher, registerLauncher } from "./windows-launcher.ts";

const scheme = "opi-hub-focus";
// 在生成通知的同一个 PowerShell 进程中封装这一次点击。无需读取浏览器资料，也不用保存点击记录。
export const protectCompletionLink = `
if ($data.focusUrl) {
  Add-Type -AssemblyName System.Security
  $bytes = [Text.Encoding]::UTF8.GetBytes($data.focusUrl + [char]10 + $data.url)
  $token = [Security.Cryptography.ProtectedData]::Protect($bytes, [Text.Encoding]::ASCII.GetBytes('${scheme}'), 'CurrentUser')
  $link = '${scheme}://open/' + [Convert]::ToBase64String($token).TrimEnd('=').Replace('+','-').Replace('/','_')
  $data.url = $link
  $data.actions[0].uri = $link
}
`;

const launcherSource = String.raw`
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

public static class CompletionClick {
  const string prefix = "${scheme}://open/";
  [DllImport("shlwapi.dll", CharSet = CharSet.Unicode)]
  static extern int AssocQueryStringW(uint flags, uint kind, string assoc, string verb, StringBuilder output, ref uint length);

  // 只为本机当前用户生成的通知构造参数，公开协议不接受命令、程序路径或任意 URL。
  public static bool Decode(string link, out string selector, out string fallback) {
    selector = fallback = null;
    if (link.Length > 32768 || !link.StartsWith(prefix, StringComparison.Ordinal)) return false;
    string encoded = link.Substring(prefix.Length);
    if (!Regex.IsMatch(encoded, @"\A[A-Za-z0-9_-]+\z")) return false;
    try {
      string b64 = encoded.Replace('-', '+').Replace('_', '/');
      byte[] bytes = Convert.FromBase64String(b64.PadRight((b64.Length + 3) / 4 * 4, '='));
      string[] fields = Encoding.UTF8.GetString(ProtectedData.Unprotect(bytes, Encoding.ASCII.GetBytes("${scheme}"), DataProtectionScope.CurrentUser)).Split('\n');
      Uri a, b;
      if (fields.Length != 2 || !Uri.TryCreate(fields[0], UriKind.Absolute, out a) || !Uri.TryCreate(fields[1], UriKind.Absolute, out b)) return false;
      if ((a.Scheme != "https" && a.Scheme != "http") || a.UserInfo != "" || a.GetLeftPart(UriPartial.Authority) != b.GetLeftPart(UriPartial.Authority)) return false;
      if (!Regex.IsMatch(a.PathAndQuery, @"\A/n/[a-f0-9-]{36}/\?hub-tab=[a-f0-9]{32}\z") || a.Fragment != "" || b.PathAndQuery != "/" || !b.Fragment.StartsWith("#completion=", StringComparison.Ordinal)) return false;
      selector = a.AbsoluteUri; fallback = b.AbsoluteUri; return true;
    } catch (FormatException) { return false; } catch (CryptographicException) { return false; }
  }
  static bool IsChromiumBrowser(string name) {
    return String.Equals(name, "chrome.exe", StringComparison.OrdinalIgnoreCase) ||
           String.Equals(name, "ego.exe", StringComparison.OrdinalIgnoreCase) ||
           String.Equals(name, "msedge.exe", StringComparison.OrdinalIgnoreCase);
  }
  public static void Main(string[] args) {
    string selector, fallback;
    if (args.Length != 1 || !Decode(args[0], out selector, out fallback)) return;
    try {
      // 按当前 HTTP(S) 默认关联取程序，不解析注册表中的命令行，也不更改系统默认浏览器。
      uint size = 32768; var exe = new StringBuilder((int)size);
      if (AssocQueryStringW(0x1000, 2, new Uri(fallback).Scheme, "open", exe, ref size) == 0 &&
          IsChromiumBrowser(Path.GetFileName(exe.ToString()))) {
        // 前缀以完整随机标记结束，保留后面的会话参数。未命中时由 Chrome 打开原完成链接。
        Process.Start(new ProcessStartInfo(exe.ToString(), "\"--focus=" + selector + "*\" \"" + fallback + "\"") { UseShellExecute = false });
        return;
      }
    } catch (Win32Exception) { }
    Process.Start(new ProcessStartInfo(fallback) { UseShellExecute = true });
  }
}`;
export function prepareFocusLauncher(directory: string) {
  return prepareLauncher(directory, "completion-focus", launcherSource);
}
export async function registerWindowsFocusHandler() {
  const local = process.env.LOCALAPPDATA;
  if (!local) throw new Error("Windows 通知切页需要 LOCALAPPDATA");
  await registerLauncher(scheme, "URL:opi-hub 完成通知", await prepareFocusLauncher(path.join(local, "opi-hub")));
}
