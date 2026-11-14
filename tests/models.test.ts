import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { OpiManagement } from "../src/adapters/opi/management.ts";
import type { ManagementState } from "../src/shared/management.ts";
import { fakeOpi } from "./helpers.ts";
import { decodeModels } from "../src/adapters/opi/wire.ts";
import { isModelRef } from "../src/shared/models.ts";
import { isPlanDefinition } from "../src/shared/schedules.ts";
import { isTaskInput } from "../src/shared/tasks.ts";

const task = { id: "run", name: "模型验证", path: "/project", prompt: "整理报告", timeoutSeconds: 60 };
test("模型可省略以保持旧计划行为，指定模型必须同时提供非空提供商和标识", () => {
  assert.ok(isTaskInput(task));
  assert.ok(isPlanDefinition({ ...task, deviceId: "device", rule: { kind: "daily", time: "09:00", timeZone: "UTC" } }));
  assert.ok(isTaskInput({ ...task, model: { provider: "provider", id: "model/中文" } }));
  for (const model of [null, "model", {}, { provider: "provider" }, { provider: "", id: "model" }, { provider: "provider", id: " " }, { provider: "provider", id: "a\0b" }, { provider: "provider", id: "a".repeat(4097) }]) {
    assert.equal(isModelRef(model), false); assert.equal(isTaskInput({ ...task, model }), false);
  }
});
test("只投影模型名称与身份，快照和增量更新不保留凭据、配置或聊天正文", () => {
  const model = { provider: "provider", id: "fast", name: "快速模型" };
  const raw = { ...model, apiKey: "不能上报的密钥", baseUrl: "https://private.example", headers: { Authorization: "secret" } };
  assert.deepEqual(decodeModels({ type: "snapshot", value: { models: [raw], entries: ["不能上报的正文"] } }), [model]);
  assert.deepEqual(decodeModels({ type: "patch", value: { models: [] } }), []);
  assert.equal(decodeModels({ type: "patch", value: { running: false } }), undefined);
  assert.deepEqual(decodeModels({ type: "snapshot", value: null }), []);
  assert.equal(decodeModels({ type: "selected", session: null }), undefined);
  assert.throws(() => decodeModels({ type: "snapshot", value: { models: [{ provider: "provider", id: "fast" }] } }), /模型列表/);
});
test("模型更新复用管理订阅，初始目录和审批不丢失，同一运行不能换用另一模型", async () => {
  const fake = await fakeOpi("模型测试"); let current: ManagementState = { state: "connecting" };
  const management = new OpiManagement(new URL(fake.url), (state) => { current = state; });
  async function ready(accept: (state: Extract<ManagementState, { state: "ready" }>) => boolean) {
    const deadline = Date.now() + 5000;
    while (true) {
      const state = current;
      if (state.state === "ready" && accept(state)) return state;
      assert.ok(Date.now() < deadline, "等待模型或运行更新超时"); await delay(10);
    }
  }
  try {
    await ready((state) => state.models.length === 3 && state.sessions.length === 2 && state.interactions.length === 1);
    const model = { provider: "模型测试", id: "fast" };
    const input = { ...task, path: "/fixture/模型测试/other", model };
    management.startTask(input); await ready((state) => state.tasks.some((item) => item.id === task.id && item.state === "completed"));
    management.startTask(input); assert.equal(fake.prompts.length, 1);
    assert.throws(() => management.startTask({ ...input, model: { provider: "模型测试 备用", id: "fast" } }), /运行标识/);
    assert.throws(() => management.startTask({ ...input, model: undefined }), /运行标识/);
    fake.setModels([{ provider: "模型测试", id: "default", name: "仅保留默认" }]);
    const updated = await ready((state) => state.models.length === 1);
    assert.deepEqual(updated.models, [{ provider: "模型测试", id: "default", name: "仅保留默认" }]);
    assert.equal(updated.interactions.length, 1);
  } finally { await management.close(); await fake.close(); }
});
