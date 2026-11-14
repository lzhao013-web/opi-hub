import { test, expect } from "@playwright/test";
import { isPlan, isRun } from "../../src/shared/schedules.ts";
import { object } from "../../src/shared/protocol.ts";

test("真实 SDK 按范围预约创建专用会话，保留启动审批并调用本机模拟模型", async ({ page, context }) => {
  test.setTimeout(90_000);
  await page.goto("/"); await page.getByLabel("中心密码").fill("test-password-1234"); await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("heading", { name: "概览", exact: true })).toBeVisible();
  const overview: unknown = await (await page.request.get("/_hub/overview")).json();
  if (!object(overview) || !Array.isArray(overview.devices) || !object(overview.devices[0]) || typeof overview.devices[0].id !== "string") throw new Error("缺少测试设备");
  const deviceId = overview.devices[0].id;
  const root: unknown = await (await page.request.post("/_hub/directories", { headers: { Origin: new URL(page.url()).origin }, data: { deviceId, path: "" } })).json();
  if (!object(root) || typeof root.parent !== "string") throw new Error("缺少目录路径");
  const parent: unknown = await (await page.request.post("/_hub/directories", { headers: { Origin: new URL(page.url()).origin }, data: { deviceId, path: root.parent } })).json();
  if (!object(parent) || !Array.isArray(parent.children)) throw new Error("目录查询失败");
  const directory: unknown = parent.children.find((item: unknown) => object(item) && item.name === "scheduled-project");
  if (!object(directory) || typeof directory.path !== "string") throw new Error("缺少隔离目录");
  await page.getByRole("button", { name: "计划任务", exact: true }).click(); await page.getByRole("button", { name: "新建计划", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建计划任务", exact: true });
  await dialog.getByLabel("计划名称", { exact: true }).fill("真实预约验证"); await dialog.getByLabel("计划设备", { exact: true }).selectOption({ label: "原生 o-pi" });
  await dialog.getByLabel("任务模型", { exact: true }).selectOption({ label: "Fixture Alternate · hub-fixture/test-alt" });
  await dialog.getByLabel("任务目录", { exact: true }).fill(directory.path); await dialog.getByLabel("任务描述", { exact: true }).fill("整理本次隔离测试的说明，不调用工具。");
  await dialog.getByLabel("执行频率", { exact: true }).selectOption("interval"); await dialog.getByLabel("时区", { exact: true }).fill("UTC");
  const starts = Date.now() + 8000;
  await dialog.getByLabel("开始日期时间", { exact: true }).fill(new Date(starts).toISOString().slice(0, 19));
  await dialog.getByLabel("结束日期时间", { exact: true }).fill(new Date(starts + 90_000).toISOString().slice(0, 19));
  await dialog.getByLabel("间隔（分钟）", { exact: true }).fill("5");
  await dialog.getByLabel("最长运行时间（分钟）", { exact: true }).fill("1");
  const added = page.waitForResponse((response) => response.url().endsWith("/_hub/schedules") && response.request().method() === "POST");
  await dialog.getByRole("button", { name: "保存计划", exact: true }).click(); const entry: unknown = await (await added).json(); if (!isPlan(entry)) throw new Error("计划创建失败");
  expect(entry.model).toEqual({ provider: "hub-fixture", id: "test-alt" });
  const handled = new Set<string>(); let runId = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    let next = "";
    await expect.poll(async () => {
      const state: unknown = await (await page.request.get("/_hub/schedules")).json();
      if (!object(state) || !Array.isArray(state.runs)) throw new Error("运行记录缺失");
      const run: unknown = state.runs.find((item: unknown) => isRun(item) && item.planId === entry.id);
      if (isRun(run)) { runId = run.id; if (["failed", "unknown", "timed_out"].includes(run.state)) throw new Error(run.message); if (run.state === "completed") return next = "completed"; }
      const current: unknown = await (await page.request.get("/_hub/overview")).json();
      if (object(current) && Array.isArray(current.interactions)) {
        const question: unknown = current.interactions.find((item: unknown) => object(item) && item.title === "确认新建项目信任" && typeof item.id === "string" && !handled.has(item.id));
        if (object(question) && typeof question.id === "string") return next = question.id;
      }
      return "";
    }, { timeout: 30_000 }).not.toBe("");
    if (next === "completed") break;
    await page.getByRole("button", { name: /消息中心/ }).click(); const question = page.locator(`.interaction[data-dialog-id="${next}"]`);
    await expect(question).toContainText("scheduled-project"); await question.getByRole("button", { name: "确认", exact: true }).click(); handled.add(next);
  }
  expect(handled.size).toBeGreaterThan(0); expect(runId).not.toBe("");
  await page.getByRole("button", { name: "计划任务", exact: true }).click(); const row = page.locator(`.run-card[data-run-id="${runId}"]`); await expect(row).toContainText("已结束");
  await row.scrollIntoViewIfNeeded();
  await expect(row.locator(".result-body")).toHaveText("计划验证完成（本机模拟模型）");
  const [native] = await Promise.all([context.waitForEvent("page"), row.getByRole("link", { name: "查看会话" }).click()]);
  await expect(native.getByRole("combobox", { name: "模型", exact: true })).toContainText("Fixture Alternate");
  await expect(native.locator(".assistant-reply")).toContainText("计划验证完成（本机模拟模型）");
  await page.bringToFront(); const state: unknown = await (await page.request.get("/_hub/schedules")).json();
  expect(JSON.stringify(state)).not.toContain("计划验证完成（本机模拟模型）");
  if (!object(state) || !Array.isArray(state.runs)) throw new Error("运行记录缺失");
  const persisted: unknown = state.runs.find((item: unknown) => isRun(item) && item.id === runId);
  expect(isRun(persisted) ? persisted.file : null).not.toBeNull(); expect(isRun(persisted) ? persisted.replyId : null).toBeTruthy();
  if (!isRun(persisted) || !persisted.session) throw new Error("缺少专用会话");
  const modelState = await page.evaluate(({ deviceId, sessionId }) => new Promise<{ model: unknown; defaults: unknown }>((resolve, reject) => {
    const url = new URL(`/n/${deviceId}/api/events?session=${encodeURIComponent(sessionId)}&hub-preview=1`, location.href);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
    const timer = setTimeout(() => finish(new Error("读取模型状态超时")), 10_000);
    const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
    let settled = false;
    const finish = (error?: Error, state?: { model: unknown; defaults: unknown }) => {
      if (settled) return;
      settled = true; clearTimeout(timer); socket.close();
      if (error) reject(error); else if (state) resolve(state);
    };
    socket.onclose = () => finish(new Error("模型状态连接断开")); socket.onerror = () => finish(new Error("模型状态连接失败"));
    socket.onmessage = (message) => {
      try {
        const frame: unknown = JSON.parse(String(message.data));
        if (!object(frame) || !Array.isArray(frame.events)) return;
        socket.send(JSON.stringify(frame.kind === "frame" ? { kind: "ack", id: frame.id } : { ack: frame.id }));
        for (const event of frame.events) if (object(event) && event.type === "snapshot" && object(event.value) && event.value.sessionId === sessionId) {
          finish(undefined, { model: event.value.model, defaults: event.value.defaultModel }); return;
        }
      } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    };
  }), { deviceId, sessionId: persisted.session.id });
  expect(modelState.model).toMatchObject({ provider: "hub-fixture", id: "test-alt" });
  expect(modelState.defaults).toMatchObject({ provider: "hub-fixture", id: "test" });
  const notices: unknown = await (await page.request.get("/_hub/notifications")).json();
  expect(Array.isArray(notices) ? notices.filter((item: unknown) => object(item) && item.runId === runId).length : 0).toBe(1);
  expect(JSON.stringify(notices)).not.toContain("计划验证完成（本机模拟模型）");
  await page.screenshot({ path: test.info().outputPath("native-schedule.png"), fullPage: true, animations: "disabled" }); await native.close();
});
