import { test } from "node:test";
import assert from "node:assert/strict";
import { ExecutionState } from "../src/adapters/opi/execution.ts";

test("只投影执行元数据，增量保留停止原因，不缓存对话正文", () => {
  const state = new ExecutionState();
  state.consume({ type: "snapshot", value: { sessionId: "session", running: false, commandRunning: false, queue: { steering: [], followUp: [] }, entries: [], streamingMessage: null } });
  state.consume({ type: "patch", sessionId: "session", value: { running: true }, entries: { keep: 0, items: [{ id: "user", type: "message", messages: [{ role: "user", content: "不能缓存的用户正文" }] }] } });
  assert.equal(state.busy, true); assert.equal(state.users, 1);
  state.consume({ type: "patch", sessionId: "session", value: { running: false }, entries: { keep: 1, items: [{ id: "reply", type: "message", messages: [{ role: "assistant", content: "不能缓存的模型正文", stopReason: "error", errorMessage: "错误摘要 中文 😀" }] }] } });
  assert.equal(state.busy, false); assert.equal(state.result?.reason, "error"); assert.equal(state.result?.error, "错误摘要 中文 😀");
  assert.ok(!JSON.stringify(state).includes("不能缓存"));
  assert.equal(state.consume({ type: "patch", sessionId: "session", value: {}, streamingMessage: { kind: "content", blocks: [{ delta: "不保留的流式内容" }] } }), false);
  assert.throws(() => state.consume({ type: "patch", sessionId: "other", value: { running: true } }), /初始快照/);
});
