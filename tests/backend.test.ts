import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { ManagedBackend } from "../src/node/backend.ts";
import { object } from "../src/shared/protocol.ts";
import type { BackendStatus } from "../src/shared/backend.ts";

const executable = fileURLToPath(new URL("./owned-web.ts", import.meta.url));
async function until(read: () => BackendStatus, accept: (value: BackendStatus) => boolean): Promise<BackendStatus> {
  const deadline = Date.now() + 10_000;
  while (true) { const value = read(); if (accept(value)) return value; assert.ok(Date.now() < deadline, "托管进程状态未更新"); await delay(15); }
}
function exists(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { if (object(error) && error.code === "ESRCH") return false; throw error; }
}
function backend(cwd: string, args: string[] = []) { return new ManagedBackend({ command: [process.execPath, executable, ...args], cwd }, () => {}); }

test("后台启动回环服务，拒绝并发启动；关闭只结束自己及后代，不影响另一实例", { timeout: 20_000 }, async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "opi-hub-owned-")); const first = backend(cwd, ["--descendant"]); const other = backend(cwd);
  try {
    first.restart(); assert.throws(() => first.restart(), /正在启动/); other.restart();
    const a = await until(() => first.status, (value) => value.state === "running");
    const b = await until(() => other.status, (value) => value.state === "running");
    assert.ok(a.state === "running" && b.state === "running"); assert.notEqual(a.pid, b.pid); assert.notEqual(a.url, b.url);
    assert.match(a.url, /^http:\/\/127\.0\.0\.1:\d+$/); assert.equal((await fetch(a.url + "/health")).status, 200);
    const child = Number(a.logs.match(/fixture-descendant: (\d+)/)?.[1]); assert.ok(child > 0 && exists(child));
    await first.close(); assert.equal(first.status.state, "stopped"); assert.equal(exists(a.pid), false); assert.equal(exists(child), false);
    assert.equal((await fetch(b.url + "/health")).status, 200);
  } finally { await first.close(); await other.close(); await rm(cwd, { recursive: true, force: true }); }
});
test("启动失败保留 Unicode 日志，拒绝非回环地址与失败健康检查，并清理已启动进程", { timeout: 20_000 }, async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "opi-hub-owned-"));
  try {
    for (const mode of ["fail", "wrong", "unhealthy"]) {
      const child = backend(cwd, ["--mode", mode]);
      try {
        child.restart(); const value = await until(() => child.status, (value) => value.state === "error"); assert.ok(value.state === "error");
        const pid = Number(value.logs.match(/fixture-pid: (\d+)/)?.[1]); assert.ok(pid > 0); assert.equal(exists(pid), false);
        if (mode === "fail") assert.match(value.logs, /中文 😀/);
        if (mode === "wrong") assert.match(value.message, /回环/);
        if (mode === "unhealthy") assert.match(value.message, /健康检查/);
      } finally { await child.close(); }
    }
    const missing = new ManagedBackend({ command: [path.join(cwd, "missing-opi-web.exe")], cwd }, () => {});
    try { missing.restart(); const value = await until(() => missing.status, (value) => value.state === "error"); assert.ok(value.state === "error"); assert.match(value.message, /ENOENT/); }
    finally { await missing.close(); }
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
test("异常退出不自动重启，显式重启使用新进程与新代数", { timeout: 15_000 }, async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "opi-hub-owned-")); const marker = path.join(cwd, "launches.txt");
  const child = backend(cwd, ["--crash-after", "500", "--marker", marker]);
  try {
    child.restart(); const first = await until(() => child.status, (value) => value.state === "running"); assert.ok(first.state === "running");
    const failed = await until(() => child.status, (value) => value.state === "error"); assert.equal(failed.generation, first.generation);
    assert.equal((await readFile(marker, "utf8")).trim().split("\n").length, 1);
    child.restart(); const restarted = await until(() => child.status, (value) => value.state === "running"); assert.ok(restarted.state === "running");
    assert.notEqual(restarted.pid, first.pid); assert.equal(restarted.generation, first.generation + 1);
    assert.equal((await readFile(marker, "utf8")).trim().split("\n").length, 2);
  } finally { await child.close(); await rm(cwd, { recursive: true, force: true }); }
});
test("启动未完成时节点关闭也会释放自己启动的子进程", { timeout: 15_000 }, async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "opi-hub-owned-")); const child = backend(cwd, ["--mode", "hang"]);
  try {
    child.restart(); const started = await until(() => child.status, (value) => value.logs.includes("fixture-pid:"));
    const pid = Number(started.logs.match(/fixture-pid: (\d+)/)?.[1]); assert.ok(exists(pid));
    await child.close(); assert.equal(child.status.state, "stopped"); assert.equal(exists(pid), false);
  } finally { await child.close(); await rm(cwd, { recursive: true, force: true }); }
});
