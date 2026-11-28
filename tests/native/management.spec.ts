import { test, expect, type Page } from "@playwright/test";
import { fixtureInstruction, fixtureShell, fixtureShellCommand, fixtureShellPrompt, fixtureWritePrompt } from "../model.ts";
import { isInteraction, type Interaction } from "../../src/shared/management.ts";
import { object } from "../../src/shared/protocol.ts";

async function newSession(native: Page): Promise<void> {
  const editor = native.getByRole("textbox", { name: "消息", exact: true }); await expect(editor).toBeVisible();
  const previous = await editor.elementHandle(); if (!previous) throw new Error("缺少原会话编辑器");
  const changed = native.waitForResponse((response) => response.url().endsWith("/api/action") && response.request().postData()?.includes('"action":"new"') === true);
  await native.getByRole("button", { name: "新建会话", exact: true }).click(); await changed;
  await previous.waitForElementState("hidden"); await previous.dispose(); await expect(editor).toBeVisible();
}

test.afterEach(async ({ page }, info) => {
  if (info.status === "passed") return;
  const value: unknown = await (await page.request.get("/_hub/overview")).json();
  if (typeof value !== "object" || value === null || !("interactions" in value) || !Array.isArray(value.interactions)) return;
  for (const item of value.interactions) if (typeof item === "object" && item !== null && "deviceId" in item && "sessionId" in item && "id" in item) {
    const stage = "stage" in item && object(item.stage) ? item.stage : undefined;
    await page.request.post("/_hub/respond", { headers: { Origin: new URL(page.url()).origin }, data: { deviceId: item.deviceId, sessionId: item.sessionId, dialogId: item.id, value: null, token: stage?.token } });
  }
});

test("真实会话直达和后台审批订阅不切换原页面，中心回答由原生后端消费", async ({ page, context }) => {
  const errors: string[] = [];
  context.on("page", (tab) => tab.on("pageerror", (error) => errors.push(error.message)));
  await page.goto("/");
  await page.getByLabel("中心密码").fill("test-password-1234");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("button", { name: /全部设备/ }).click();
  const [native] = await Promise.all([context.waitForEvent("page"), page.getByRole("link", { name: "打开 o-pi" }).click()]);
  const editor = native.getByRole("textbox", { name: "消息", exact: true });
  await expect(editor).toBeVisible();
  await newSession(native);
  await native.locator(".session-heading button").click();
  const title = native.getByRole("textbox", { name: "会话名称", exact: true });
  await title.fill("集中审批测试"); await title.press("Enter");
  // 尚未进入全局目录的空白会话，也应通过转发连接被发现。
  await editor.fill("/hub-test-confirm"); await editor.press("ControlOrMeta+Enter");
  await expect(native.getByRole("dialog")).toBeVisible();
  await page.bringToFront(); await page.getByRole("button", { name: /消息中心/ }).click();
  const first = page.locator(".interaction").filter({ has: page.getByRole("heading", { name: "原生远程审批", exact: true }) });
  await expect(first).toBeVisible();
  await first.getByRole("button", { name: "确认", exact: true }).click();
  await expect(first).toHaveCount(0); await expect(native.getByRole("dialog")).toHaveCount(0);
  // 直接用户 Shell 输入只在隔离工作区运行 echo，使会话进入原生运行目录，不调用模型。
  await editor.fill("!echo hub-management-test");
  const shell = native.waitForResponse((response) => response.url().endsWith("/api/action") && response.request().postData()?.includes("hub-management-test") === true);
  await native.getByRole("textbox", { name: "执行命令", exact: true }).press("ControlOrMeta+Enter"); await shell;
  await page.bringToFront();
  await page.locator("#device-nav").getByRole("button", { name: "原生 o-pi", exact: true }).click();
  await page.locator(".workspace-row").filter({ has: page.getByText("workspace", { exact: true }) }).getByRole("button", { name: /^进入工作区 / }).click();
  const row = page.locator(".session-row").filter({ has: page.getByRole("heading", { name: "集中审批测试", exact: true }) });
  await expect(row).toBeVisible();
  await page.getByRole("button", { name: "加载历史会话", exact: true }).click();
  await expect(page.locator("#history-status")).toContainText("已加载");
  await expect(row).toHaveCount(1);
  const [same] = await Promise.all([context.waitForEvent("page"), row.getByRole("link", { name: "进入会话" }).click()]);
  await expect(same.locator(".session-heading")).toContainText("集中审批测试");
  await same.close();
  await editor.fill("/hub-test-confirm"); await editor.press("ControlOrMeta+Enter");
  await expect(native.getByRole("dialog")).toBeVisible();
  await page.bringToFront();
  await page.getByRole("button", { name: /消息中心/ }).click();
  const approval = page.locator(".interaction").filter({ has: page.getByRole("heading", { name: "原生远程审批", exact: true }) });
  await expect(approval).toBeVisible();
  await approval.getByRole("button", { name: "确认", exact: true }).click();
  await expect(approval).toHaveCount(0);
  await expect(native.getByRole("dialog")).toHaveCount(0);
  await expect(native.locator(".session-heading")).toContainText("集中审批测试");
  await expect(native.getByText("中心确认完成", { exact: true })).toHaveCount(2);
  await expect(native.getByText("中心确认完成", { exact: true }).last()).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("native-management.png"), fullPage: true });
  expect(errors).toEqual([]);
  await native.close();
});

test("真实工具审批可发送拒绝说明，命令审批可跳过说明", async ({ page, context }) => {
  await page.goto("/"); await page.getByLabel("中心密码").fill("test-password-1234");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("button", { name: /全部设备/ }).click();
  const [native] = await Promise.all([context.waitForEvent("page"), page.getByRole("link", { name: "打开 o-pi" }).click()]);
  const editor = native.getByRole("textbox", { name: "消息", exact: true });
  await newSession(native);
  await editor.fill(fixtureWritePrompt); await editor.press("ControlOrMeta+Enter");
  await expect(native.getByRole("button", { name: "拒绝并说明" })).toBeVisible();
  await page.bringToFront(); await page.getByRole("button", { name: /消息中心/ }).click();
  await page.getByRole("tab", { name: /待处理/ }).click();
  const tool = page.locator(".interaction").filter({ hasText: "拟写入的隔离测试内容" });
  await expect(tool).toContainText("hub-approval.txt");
  await tool.getByRole("button", { name: "拒绝并说明" }).click();
  const instruction = tool.getByLabel("给代理的说明"); await expect(instruction).toBeVisible();
  const overview: unknown = await (await page.request.get("/_hub/overview")).json();
  if (!object(overview) || !Array.isArray(overview.interactions)) throw new Error("缺少交互目录");
  const item = overview.interactions.find((value: unknown): value is Interaction & { deviceId: string } =>
    isInteraction(value) && value.kind === "tool" && "deviceId" in value && typeof value.deviceId === "string");
  if (!item) throw new Error("缺少工具审批");
  const stale = await page.request.post("/_hub/respond", { headers: { Origin: new URL(page.url()).origin },
    data: { deviceId: item.deviceId, sessionId: item.sessionId, dialogId: item.id, value: "Allow once" } });
  expect(stale.status()).toBe(409);
  await instruction.fill(fixtureInstruction); await tool.getByRole("button", { name: "发送说明" }).click();
  await expect(tool).toHaveCount(0);
  await expect(native.locator(".assistant-reply")).toContainText("模型收到拒绝说明");
  await editor.fill(fixtureShellPrompt); await editor.press("ControlOrMeta+Enter");
  const shell = page.locator(".interaction").filter({ hasText: fixtureShellCommand });
  await expect(shell).toContainText(fixtureShell === "powershell" ? "PowerShell" : "Bash");
  await shell.getByRole("button", { name: "拒绝并说明" }).click();
  await shell.getByRole("button", { name: "跳过说明" }).click();
  await expect(shell).toHaveCount(0);
  await expect(native.locator(".assistant-reply").last()).toContainText("计划验证完成");
  await native.close();
});

test("原页面关闭后仍能回答未落盘会话的交互", async ({ page, context }) => {
  await page.goto("/");
  await page.getByLabel("中心密码").fill("test-password-1234");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("button", { name: /全部设备/ }).click();
  const [native] = await Promise.all([context.waitForEvent("page"), page.getByRole("link", { name: "打开 o-pi" }).click()]);
  await newSession(native);
  const editor = native.getByRole("textbox", { name: "消息", exact: true });
  await editor.fill("/hub-test-confirm"); await editor.press("ControlOrMeta+Enter");
  await expect(native.getByRole("dialog")).toBeVisible();
  await page.bringToFront(); await page.getByRole("button", { name: /消息中心/ }).click();
  const approval = page.locator(".interaction").filter({ has: page.getByRole("heading", { name: "原生远程审批", exact: true }) });
  await expect(approval).toBeVisible();
  const url = await approval.getByRole("link", { name: "查看会话" }).getAttribute("href");
  if (!url) throw new Error("缺少目标会话链接");
  await native.close(); await page.bringToFront();
  await page.waitForResponse((response) => response.url().endsWith("/_hub/overview"));
  await expect(approval).toBeVisible();
  await approval.getByRole("button", { name: "确认", exact: true }).click();
  await expect(approval).toHaveCount(0);
  const restored = await context.newPage(); await restored.goto(url);
  await expect(restored.getByText("中心确认完成", { exact: true })).toBeVisible();
  await restored.close();
});
