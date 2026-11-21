import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { prepareFocusLauncher } from "../src/node/windows-completion-focus.ts";
import { notificationCommand } from "../src/node/system-notifications.ts";

// 运行真正的通知 XML 构造与 Windows 点击入口解码，但不注册协议、不显示通知、不启动浏览器。
test("Windows 完成通知正文和按钮使用同一用户的受保护定位，拒绝伪造及跨站目标", { skip: process.platform !== "win32", timeout: 20_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "opi-focus-test-"));
  try {
    const launcher = await prepareFocusLauncher(directory);
    const deviceId = crypto.randomUUID();
    const url = "http://hub.example:19200/#completion=abc%3A123";
    const selector = `http://hub.example:19200/n/${deviceId}/?hub-tab=${"ab".repeat(16)}`;
    const plan = notificationCommand("win32", {}, { id: "abc:123", deviceId, deviceName: "测试设备", title: "会话", completedAt: new Date().toISOString() }, url, selector);
    assert.ok(plan?.input); const encoded = plan.args.at(-1); assert.ok(encoded);
    const full = Buffer.from(encoded, "base64").toString("utf16le");
    const probe = `$ErrorActionPreference = 'Stop'
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType=WindowsRuntime] | Out-Null
${full.slice(full.indexOf("$data ="), full.indexOf("$toast ="))}
[void][Reflection.Assembly]::LoadFrom($env:OPI_FOCUS_TEST_EXE)
$link = $xml.DocumentElement.GetAttribute('launch')
$buttonLink = $xml.GetElementsByTagName('action').Item(0).GetAttribute('arguments')
$a=''; $b=''
if ($buttonLink -ne $link -or !$link.StartsWith('opi-hub-focus://open/')) {throw 'wrong toast link'}
$cut = [int]($link.Length / 2); $changed = if ($link[$cut] -eq 'A') {'B'} else {'A'}
if ([CompletionClick]::Decode($link.Remove($cut,1).Insert($cut,$changed), [ref]$a, [ref]$b)) {throw 'accepted forged link'}
if (![CompletionClick]::Decode($link, [ref]$a, [ref]$b)) { 'rejected'; exit }
[Console]::WriteLine($a); [Console]::WriteLine($b)`;
    const run = (input: string) => {
      const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(probe, "utf16le").toString("base64")], { env: { ...process.env, OPI_FOCUS_TEST_EXE: launcher }, input, encoding: "utf8", windowsHide: true, timeout: 8000 });
      assert.equal(r.status, 0, r.stderr); return r.stdout.trim().split(/\r?\n/);
    };
    assert.deepEqual(run(plan.input), [selector, url]);
    assert.deepEqual(run(plan.input.replace(selector, selector.replace("hub.example", "other.example"))), ["rejected"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
