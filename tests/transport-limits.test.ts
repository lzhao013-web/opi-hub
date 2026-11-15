import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { WebSocket } from "ws";
import { fixture, fakeOpi, add } from "./helpers.ts";
import { OpiClient } from "../src/adapters/opi/client.ts";
import { MAX_FRAME, object, parse } from "../src/shared/protocol.ts";
import { buffer, connected } from "../src/shared/sockets.ts";

function longSnapshot(count: number) {
  const content = "历史内容😀".repeat(2048);
  return { sessionId: "runtime-1", entries: Array.from({ length: count }, (_, index) => ({
    id: `entry-${index}`, parentId: index ? `entry-${index - 1}` : null, type: "message",
    messages: [{ role: "user", content }],
  })) };
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

for (const compressed of [true, false]) {
  test(`超过旧消息及队列限额的初始会话快照完整转发，压缩=${compressed}`, { timeout: 30_000 }, async () => {
    const env = await fixture();
    const snapshot = longSnapshot(1100);
    assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) > MAX_FRAME * 2);
    env.fakeA.setInitialSnapshot(snapshot);
    const ws = new WebSocket(env.hub.url.replace("http:", "ws:") + `/n/${env.a.id}/api/events`, {
      headers: { Cookie: env.cookie, Origin: env.hub.url }, perMessageDeflate: compressed,
    });
    const received = Promise.withResolvers<unknown>();
    ws.on("error", received.reject);
    ws.once("close", (code) => received.reject(new Error(`快照到达前连接断开：${code}`)));
    ws.once("message", (raw, binary) => {
      try {
        assert.equal(binary, false);
        const frame = parse(buffer(raw).toString());
        assert.ok(object(frame) && Array.isArray(frame.events));
        const event: unknown = frame.events.find((item: unknown) => object(item) && item.type === "snapshot");
        assert.ok(object(event)); received.resolve(event.value);
      } catch (error) { received.reject(error); }
    });
    try {
      assert.equal(digest(await received.promise), digest(snapshot));
      assert.equal(ws.extensions.includes("permessage-deflate"), compressed);
      const echoed = new Promise<string>((resolve, reject) => {
        ws.once("error", reject); ws.once("close", () => reject(new Error("大快照后连接断开")));
        ws.once("message", (raw) => resolve(buffer(raw).toString()));
      });
      ws.send(JSON.stringify({ echo: "快照后仍可交互" }));
      const result = parse(await echoed); assert.ok(object(result)); assert.equal(result.echo, "快照后仍可交互");
      assert.equal(env.fakeA.prompts.length, 0);
      assert.equal(env.fakeA.leaked(), false);
    } finally { ws.terminate(); await env.close(); }
  });
}

test("本机适配器可接收超过 16 MiB 的快照并继续确认事件", { timeout: 15_000 }, async () => {
  const backend = await fakeOpi("大快照适配器");
  const snapshot = longSnapshot(600); backend.setInitialSnapshot(snapshot);
  let observed: unknown;
  const client = new OpiClient(new URL(backend.url), () => {}, "runtime-1", (event) => {
    if (object(event) && event.type === "snapshot") observed = event.value;
  });
  try {
    await client.ready; await client.synchronize(AbortSignal.timeout(5000));
    assert.equal(digest(observed), digest(snapshot));
    assert.ok(backend.acknowledgements() > 0);
    assert.equal(client.signal.aborted, false);
    assert.equal(backend.prompts.length, 0);
  } finally { client.close(); await backend.close(); }
});

test("节点控制通道仍拒绝超过 16 MiB 的消息且不协商压缩", { timeout: 20_000 }, async () => {
  const env = await fixture();
  const device = await add(env.hub.url, env.cookie, "控制限额");
  const ws = new WebSocket(env.hub.url.replace("http:", "ws:") + "/_hub/connect", {
    headers: { Authorization: `Bearer ${device.config.token}` },
  });
  ws.on("error", () => {});
  try {
    await connected(ws); assert.equal(ws.extensions, "");
    const closed = new Promise<number>((resolve) => ws.once("close", resolve));
    // 控制连接的接收层错误会直接终止套接字，不走应用层的 1008 校验关闭。
    ws.send(" ".repeat(MAX_FRAME + 1)); assert.equal(await closed, 1006);
  } finally { ws.terminate(); await env.close(); }
});
