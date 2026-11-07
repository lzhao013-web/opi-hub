import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { OpiClient } from "../src/adapters/opi/client.ts";
import { fakeOpi } from "./helpers.ts";

async function until(read: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!read()) { assert.ok(Date.now() < deadline, "等待本机 HTTP 请求超时"); await setImmediate(); }
}
test("适配器长操作和查询没有独立的响应头期限，完成后返回原始 Unicode 结果", async (t) => {
  const backend = await fakeOpi("长等待 中文 😀"); const client = new OpiClient(new URL(backend.url), () => {});
  const releaseAction = backend.holdHistory(); const releaseQuery = backend.holdDirectories();
  try {
    await client.ready; t.mock.timers.enable({ apis: ["setTimeout"] });
    let done = false;
    const pending = Promise.all([client.action({ action: "sessions", all: true }), client.query({ query: "directories", path: "" })]).finally(() => { done = true; });
    await until(() => backend.catalogReads() === 1 && backend.directoryReads() === 1);
    t.mock.timers.tick(301_000); await setImmediate(); assert.equal(done, false);
    releaseAction(); releaseQuery(); const [, result] = await pending;
    assert.ok(typeof result === "object" && result !== null && "path" in result); assert.equal(result.path, "/fixture/长等待 中文 😀");
    assert.equal(backend.catalogReads(), 1); assert.equal(backend.directoryReads(), 1);
  } finally { t.mock.timers.reset(); releaseAction(); releaseQuery(); client.close(); await backend.close(); }
});
test("调用方取消与客户端关闭会终止本机等待，不重试请求", async () => {
  const backend = await fakeOpi("取消本机等待"); const client = new OpiClient(new URL(backend.url), () => {});
  const release = backend.holdDirectories();
  try {
    await client.ready; const controller = new AbortController();
    const cancelled = assert.rejects(client.query({ query: "directories", path: "" }, controller.signal));
    await until(() => backend.directoryReads() === 1); controller.abort(); await cancelled;
    const closed = assert.rejects(client.query({ query: "directories", path: "" }));
    await until(() => backend.directoryReads() === 2); client.close(); await closed;
    assert.equal(backend.directoryReads(), 2);
  } finally { release(); client.close(); await backend.close(); }
});
