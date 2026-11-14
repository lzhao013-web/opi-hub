import { test, expect } from "@playwright/test";
import { object } from "../../src/shared/protocol.ts";
import type { ScheduleRun } from "../../src/shared/schedules.ts";

test("计划任务可按时区预约、暂停手动运行、集中审批并保留记录", async ({ page }, info) => {
  test.setTimeout(45_000);
  const name = `界面计划 ${info.project.name}`;
  await page.goto("/"); await page.getByLabel("中心密码").fill("test-password-1234"); await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("button", { name: "计划任务", exact: true }).click(); await page.getByRole("button", { name: "新建计划", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建计划任务", exact: true });
  await dialog.getByLabel("计划名称", { exact: true }).fill(name); await dialog.getByLabel("计划设备", { exact: true }).selectOption({ label: "开发台式机" });
  const model = dialog.getByLabel("任务模型", { exact: true });
  await expect(model).toHaveValue("");
  await expect(model.locator("option")).toContainText(["沿用设备默认", "设备 A 默认模型", "设备 A 快速模型", "设备 A 备用模型"]);
  await model.selectOption({ label: "设备 A 快速模型 · 设备 A/fast" });
  await dialog.getByLabel("计划设备", { exact: true }).selectOption({ label: "笔记本" });
  await expect(model).toHaveValue(""); await expect(model).not.toContainText("设备 A");
  await model.selectOption({ label: "设备 B 快速模型 · 设备 B/fast" });
  await dialog.getByLabel("计划设备", { exact: true }).selectOption({ label: "开发台式机" }); await expect(model).toHaveValue("");
  await model.selectOption({ label: "设备 A 备用模型 · 设备 A 备用/fast" });
  await dialog.getByLabel("任务目录", { exact: true }).fill("/fixture/设备 A/新项目"); await dialog.getByLabel("任务描述", { exact: true }).fill("ASK 检查测试并生成报告");
  await dialog.getByLabel("执行频率", { exact: true }).selectOption("weekly"); await dialog.getByLabel("时区", { exact: true }).fill("UTC");
  await dialog.getByLabel("执行时间", { exact: true }).fill("09:30"); await dialog.getByLabel("一", { exact: true }).uncheck(); await dialog.getByLabel("五", { exact: true }).check();
  await dialog.getByRole("button", { name: "保存计划", exact: true }).click();
  const plan = page.locator(".plan-card").filter({ has: page.getByRole("heading", { name, exact: true }) });
  await expect(plan).toContainText("模型：设备 A 备用/fast");
  await expect(plan).toContainText("每周五 09:30 · UTC"); await plan.getByRole("button", { name: "暂停计划", exact: true }).click(); await expect(plan).toContainText("已暂停");
  await plan.getByRole("button", { name: "立即执行", exact: true }).click(); await page.getByRole("dialog", { name: "确认计划操作", exact: true }).getByRole("button", { name: "确认操作", exact: true }).click();
  const run = page.locator(".run-card").filter({ has: page.getByRole("heading", { name, exact: true }) });
  await expect(run).toContainText("等待交互"); await expect(run.locator(".run-meta")).toContainText("设备 A 备用模型");
  await page.getByRole("button", { name: /消息中心/ }).click();
  const question = page.locator(".interaction").filter({ has: page.getByRole("heading", { name: "计划任务确认", exact: true }) }); await expect(question).toBeVisible();
  await question.getByRole("button", { name: "确认", exact: true }).click(); await expect(question).toHaveCount(0);
  await page.getByRole("button", { name: "计划任务", exact: true }).click(); await expect(run).toContainText("已结束");
  await run.scrollIntoViewIfNeeded();
  await expect(run.locator(".result-body")).toHaveText("不应同步到中心的助手正文");
  await expect(plan).toContainText("已暂停"); await expect(run.getByRole("link", { name: "查看会话" })).toBeVisible();
  await page.screenshot({ path: info.outputPath("schedules.png"), fullPage: true, animations: "disabled" });
  await plan.getByRole("button", { name: "删除计划", exact: true }).click(); await page.getByRole("dialog", { name: "确认计划操作", exact: true }).getByRole("button", { name: "确认操作", exact: true }).click();
  await expect(plan).toHaveCount(0); await expect(run).toContainText(name);
  await page.getByRole("button", { name: "新建计划", exact: true }).click();
  await expect(model).toHaveValue("");
  await dialog.getByLabel("计划名称", { exact: true }).fill("不接受 Shell"); await dialog.getByLabel("计划设备", { exact: true }).selectOption({ label: "开发台式机" });
  await dialog.getByLabel("任务目录", { exact: true }).fill("/fixture/设备 A/新项目"); await dialog.getByLabel("任务描述", { exact: true }).fill("!echo unsafe");
  await dialog.getByLabel("预约时间", { exact: true }).fill(new Date(Date.now() + 3600_000).toISOString().slice(0, 19)); await dialog.getByLabel("时区", { exact: true }).fill("UTC");
  await dialog.getByRole("button", { name: "保存计划", exact: true }).click(); await expect(dialog.getByRole("alert")).toContainText("自然语言");
  await dialog.getByRole("button", { name: "关闭计划任务", exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("运行记录优先显示待核对项，历史按日期紧凑分组，完整信息只在详情展开", async ({ page }, info) => {
  await page.goto("/"); await page.getByLabel("中心密码").fill("test-password-1234"); await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("heading", { name: "概览", exact: true })).toBeVisible();
  const overview: unknown = await (await page.request.get("/_hub/overview")).json();
  if (!object(overview) || !Array.isArray(overview.devices)) throw new Error("缺少设备列表");
  const device: unknown = overview.devices.find((item) => object(item) && item.name === "开发台式机");
  if (!object(device) || typeof device.id !== "string") throw new Error("缺少设备");
  const today = new Date(); const yesterday = new Date(); yesterday.setDate(today.getDate() - 1); const earlier = new Date(); earlier.setDate(today.getDate() - 3);
  const base: ScheduleRun = { id: crypto.randomUUID(), planId: crypto.randomUUID(), name: "今日已结束", deviceId: device.id, path: "C:\\工作区\\完整路径\\示例项目", scheduledAt: today.toISOString(), trigger: "timer", state: "completed", session: null, file: null, replyId: null, message: "SDK 执行已结束，请检查会话结果", nodeRevision: 1, updatedAt: today.toISOString(), model: { provider: "设备 A", id: "fast" } };
  const records: ScheduleRun[] = [
    { ...base, id: crypto.randomUUID(), name: "更早记录", scheduledAt: earlier.toISOString() },
    { ...base, id: crypto.randomUUID(), name: "昨日失败", scheduledAt: yesterday.toISOString(), state: "failed", message: "指定模型不可用，未自动换模型" },
    base,
    { ...base, id: crypto.randomUUID(), name: "待核对任务", scheduledAt: earlier.toISOString(), state: "unknown", message: "执行连接中断，不会自动重跑" },
  ];
  await page.route("**/_hub/schedules", (route) => route.fulfill({ json: { plans: [], runs: records, error: null } }));
  await page.getByRole("button", { name: "计划任务", exact: true }).click();
  await expect(page.locator(".run-group-heading h3")).toHaveText(["进行中与待核对", "今天", "昨天", earlier.toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" })]);
  await expect(page.locator(".run-card").first()).toContainText("待核对任务");
  const card = page.locator(`.run-card[data-run-id="${base.id}"]`); await expect(card).toHaveClass(/is-history/);
  await expect(card.locator(".run-meta")).toHaveText("开发台式机示例项目设备 A 快速模型");
  await expect(card.locator(".run-time")).toHaveText(/^\d{2}:\d{2}$/); await expect(card.locator(".run-details")).toBeHidden(); await expect(card.locator(".run-message")).toHaveCount(0);
  await expect(page.locator(".run-card.failed .run-message")).toHaveText("指定模型不可用，未自动换模型");
  await expect(page.locator(".run-card.unknown .run-message")).toHaveText("执行连接中断，不会自动重跑");
  await card.getByRole("button", { name: "详情", exact: true }).click(); await expect(card.locator(".run-details")).toContainText(base.path);
  await expect(card.locator(".run-model")).toHaveText("设备 A/fast"); await expect(card.locator(".run-details")).toContainText("定时触发");
  await card.getByRole("button", { name: "详情", exact: true }).click(); await expect(card.locator(".run-details")).toBeHidden();
  await page.screenshot({ path: info.outputPath("run-history.png"), fullPage: true, animations: "disabled" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("同设备模型列表刷新保留选择，不可用与断线不会静默改成默认", async ({ page }) => {
  await page.goto("/"); await page.getByLabel("中心密码").fill("test-password-1234"); await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("button", { name: "计划任务", exact: true }).click(); await page.getByRole("button", { name: "新建计划", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建计划任务", exact: true });
  await dialog.getByLabel("计划设备", { exact: true }).selectOption({ label: "开发台式机" });
  const model = dialog.getByLabel("任务模型", { exact: true }); const selected = JSON.stringify({ provider: "设备 A", id: "fast" });
  await model.selectOption(selected);
  let available = true; let online = true;
  await page.route("**/_hub/overview", async (route) => {
    const response = await route.fetch(); const data: unknown = await response.json();
    if (!object(data) || !Array.isArray(data.devices)) throw new Error("缺少设备快照");
    for (const device of data.devices) if (object(device) && device.name === "开发台式机" && object(device.management) && Array.isArray(device.management.models)) {
      if (!available) device.management.models = device.management.models.filter((item) => !object(item) || item.id !== "fast");
      if (!online) { device.connected = false; device.management = { state: "connecting" }; }
    }
    await route.fulfill({ response, json: data });
  });
  await page.waitForResponse((response) => response.url().endsWith("/_hub/overview")); await expect(model).toHaveValue(selected);
  available = false;
  await expect(model.locator("option:checked")).toHaveText("设备 A/fast（当前不可用）"); await expect(model).toHaveValue(selected);
  online = false; await expect(model).toBeDisabled(); await expect(model).toHaveValue(selected);
  await expect(dialog.locator("#schedule-model-hint")).toContainText("设备离线");
  online = true; available = true; await expect(model).toBeEnabled();
  await expect(model.locator("option:checked")).toHaveText("设备 A 快速模型 · 设备 A/fast"); await expect(model).toHaveValue(selected);
  await dialog.getByRole("button", { name: "关闭计划任务", exact: true }).click();
});
