import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { fixture, login, waitDevices } from "./helpers.ts";
import { object } from "../src/shared/protocol.ts";
import { isReport } from "../src/shared/backend.ts";
import { startHub } from "../src/hub/server.ts";

let env: Awaited<ReturnType<typeof fixture>>;
before(async () => { env = await fixture(); });
after(async () => { await env.hub.close(); await env.close(); });
async function devices() {
  const value: unknown = await (await fetch(env.hub.url + "/_hub/devices", { headers: { Cookie: env.cookie } })).json(); assert.ok(Array.isArray(value));
  return value.map((item: unknown) => { assert.ok(object(item) && typeof item.id === "string" && typeof item.connectionId === "string" && isReport(item.report)); return { id: item.id, connectionId: item.connectionId, report: item.report }; });
}
const restart = (id: string, connectionId: string) => fetch(env.hub.url + "/_hub/backend/restart", { method: "POST", headers: { Cookie: env.cookie, Origin: env.hub.url, "Content-Type": "application/json" }, body: JSON.stringify({ deviceId: id, connectionId }) });
async function first() { const value = (await devices()).find((item) => item.id === env.a.id); assert.ok(value); return value; }

describe("节点仅托管后端", () => {
  test("节点自行分配端口并上报真实进程，中心重连不重启子进程", async () => {
    const before = await first(); assert.ok(before.report.backend.state === "running");
    assert.notEqual(before.report.backend.url, env.fakeA.url); assert.equal("target" in env.a.config, false);
    const pid = before.report.backend.pid; const generation = before.report.backend.generation;
    const port = Number(new URL(env.hub.url).port); await env.hub.close();
    env.hub = await startHub({ host: "127.0.0.1", port, data: env.directory, assets: fileURLToPath(new URL("../src/web/", import.meta.url)) }); env.cookie = await login(env.hub.url);
    await waitDevices(env.hub.url, env.cookie, 2);
    const after = await first(); assert.ok(after.report.backend.state === "running");
    assert.equal(after.report.backend.pid, pid); assert.equal(after.report.backend.generation, generation);
  });
  test("重启会及时取消在途读取，但不误取消重启确认", async () => {
    const before = await first(); const release = env.fakeA.holdHistory();
    try {
      const reading = fetch(env.hub.url + "/_hub/history", { method: "POST", headers: { Cookie: env.cookie, Origin: env.hub.url, "Content-Type": "application/json" }, body: JSON.stringify({ deviceId: env.a.id }) });
      const deadline = Date.now() + 5000;
      while (!env.fakeA.historyClients()) { assert.ok(Date.now() < deadline); await delay(20); }
      assert.equal((await restart(env.a.id, before.connectionId)).status, 202); assert.equal((await reading).status, 409);
      await waitDevices(env.hub.url, env.cookie, 2);
    } finally { release(); }
  });
  test("重启需要登录、同源与当前实例确认；旧确认不会重启新后端", async () => {
    const before = await first(); assert.ok(before.report.backend.state === "running");
    const body = JSON.stringify({ deviceId: env.a.id, connectionId: before.connectionId });
    assert.equal((await fetch(env.hub.url + "/_hub/backend/restart", { method: "POST", headers: { Origin: env.hub.url, "Content-Type": "application/json" }, body })).status, 401);
    assert.equal((await fetch(env.hub.url + "/_hub/backend/restart", { method: "POST", headers: { Cookie: env.cookie, Origin: "https://evil.example", "Content-Type": "application/json" }, body })).status, 403);
    assert.equal((await restart(env.a.id, "stale-confirmation")).status, 409);
    assert.equal((await restart(env.a.id, before.connectionId)).status, 202); await waitDevices(env.hub.url, env.cookie, 2);
    const after = await first(); assert.ok(after.report.backend.state === "running");
    assert.notEqual(after.report.backend.pid, before.report.backend.pid); assert.notEqual(after.connectionId, before.connectionId);
    assert.equal((await restart(env.a.id, before.connectionId)).status, 409);
    assert.equal(env.fakeA.newCalls(), 0);
  });
  test("后端意外退出时节点仍在线，状态与日志可见，可显式恢复但不重发任务", async () => {
    const before = await first(); assert.ok(before.report.backend.state === "running"); const pid = before.report.backend.pid;
    if (process.platform === "win32") await promisify(execFile)("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }); else process.kill(pid, "SIGKILL");
    const deadline = Date.now() + 5000;
    let failed = await first();
    while (failed.report.backend.state !== "error") { assert.ok(Date.now() < deadline); await delay(20); failed = await first(); }
    assert.equal(failed.report.ready, false); assert.equal(failed.report.backend.generation, before.report.backend.generation); assert.ok(failed.report.backend.logs.length > 0);
    assert.equal((await restart(env.a.id, failed.connectionId)).status, 202); await waitDevices(env.hub.url, env.cookie, 2);
    assert.equal(env.fakeA.newCalls(), 0);
  });
  test("停止节点结束所属 HTTP 服务，另一个独立服务仍可访问", async () => {
    const before = await first(); assert.ok(before.report.backend.state === "running"); const url = before.report.backend.url;
    await env.agentA.close();
    await assert.rejects(fetch(url + "/health", { signal: AbortSignal.timeout(1000) }));
    assert.equal((await fetch(env.fakeA.url + "/health")).status, 200);
  });
});
