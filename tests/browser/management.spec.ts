import { test, expect } from "@playwright/test";
import { object } from "../../src/shared/protocol.ts";

test("同一审批进入拒绝说明阶段后只显示原生会话入口", async ({ page }) => {
  let instruction = false;
  await page.route("**/_hub/overview", async route => {
    const response = await route.fetch();
    const data: unknown = await response.json();
    if (!object(data) || !Array.isArray(data.devices)) throw new Error("缺少设备列表");
    const device: unknown = data.devices[0];
    if (!object(device) || typeof device.id !== "string") throw new Error("缺少设备身份");
    const base = { id: "test-stage", sessionId: "runtime-1", deviceId: device.id, title: "工具审批", deadline: null };
    const stage = instruction ? { kind: "nativeApproval", message: "请在原生会话中填写拒绝说明。" } : { kind: "choice", options: [
      { label: "允许一次", value: "Allow once" }, { label: "拒绝并说明", value: "Deny with instruction" },
    ] };
    await route.fulfill({ response, json: { ...data, interactions: [{ ...base, ...stage }] } });
  });
  await page.route("**/_hub/respond", async route => {
    const body: unknown = route.request().postDataJSON();
    expect(object(body) && body.value).toBe("Deny with instruction"); instruction = true;
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto("/"); await page.getByLabel("中心密码").fill("test-password-1234");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("button", { name: /消息中心/ }).click();
  const card = page.locator('[data-dialog-id="test-stage"]');
  await expect(card.getByRole("button", { name: "允许一次" })).toBeVisible();
  await card.getByRole("button", { name: "拒绝并说明" }).click();
  await expect(card).toContainText("请在原生会话中填写拒绝说明");
  await expect(card.getByRole("button")).toHaveCount(0);
  await expect(card.getByRole("link", { name: "查看会话" })).toHaveAttribute("href", /hub-session=runtime-1/);
});
test("概览不加载历史，设备工作区按需浏览，集中交互仍双向同步", async ({ page, context }, info) => {
  test.setTimeout(45_000);
  const errors: string[] = [];
  const histories: string[] = [];
  context.on("page", (tab) => tab.on("pageerror", (error) => errors.push(error.message)));
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => { if (request.url().endsWith("/_hub/history")) histories.push(request.postData() ?? ""); });
  await page.goto("/");
  await page.getByLabel("中心密码").fill("test-password-1234");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("heading", { name: "概览", exact: true })).toBeVisible();
  await expect(page.locator("#overview-devices .overview-device")).toHaveCount(2);
  expect(await page.locator("#recent-sessions .session-row").count()).toBeLessThanOrEqual(5);
  await expect(page.locator("#overview-view .session-state.history")).toHaveCount(0);
  expect(histories).toHaveLength(0);
  if (info.project.name === "phone") {
    await page.getByRole("combobox", { name: "设备与工作区", exact: true }).selectOption({ label: "/fixture/设备 A/other" });
  } else {
    await page.locator("#device-nav").getByRole("button", { name: "开发台式机", exact: true }).click();
    await page.getByRole("button", { name: "进入工作区 /fixture/设备 A/other", exact: true }).click();
  }
  await expect(page.getByRole("heading", { name: "other", exact: true })).toBeVisible();
  // 已被其他页面打开的旧会话属于运行实例，但未加载的历史不会混入当前视图。
  await expect(page.locator("#sessions .session-state.history")).toHaveCount(0);
  expect(histories).toHaveLength(0);
  await page.getByRole("button", { name: "加载历史会话", exact: true }).click();
  const archive = page.locator("#sessions .session-row").filter({ has: page.getByRole("heading", { name: "设备 A 的历史任务", exact: true }) });
  await expect(archive).toBeVisible();
  await expect(page.locator("#sessions .session-row")).toHaveCount(1);
  expect(histories).toHaveLength(1);
  const [opened] = await Promise.all([context.waitForEvent("page"), archive.getByRole("link", { name: "进入会话" }).click()]);
  await expect(opened.locator("#selected-session")).toHaveText("archive-1");
  await expect(opened.locator("#selected-session")).toHaveAttribute("data-seen", "archive-1,");
  await expect(opened.locator("#name")).toHaveText("设备 A");
  await opened.close(); await page.bringToFront();
  await page.waitForResponse((response) => response.url().endsWith("/_hub/overview"));
  await expect(page.locator("#sessions .session-row")).toHaveCount(1);
  await page.screenshot({ path: info.outputPath("workspace.png"), fullPage: true });
  await page.getByRole("button", { name: "查找历史", exact: true }).click();
  expect(histories).toHaveLength(1);
  await page.getByRole("combobox", { name: "查询范围", exact: true }).selectOption({ label: "笔记本" });
  await page.getByRole("searchbox", { name: "历史关键词", exact: true }).fill("历史任务");
  await page.getByRole("button", { name: "搜索历史", exact: true }).click();
  await expect(page.locator("#history-results .session-row")).toHaveCount(1);
  await expect(page.locator("#history-results")).toContainText("设备 B 的历史任务");
  expect(histories).toHaveLength(2);
  await page.getByRole("button", { name: "概览", exact: true }).click();
  await page.waitForResponse((response) => response.url().endsWith("/_hub/overview"));
  expect(histories).toHaveLength(2);
  await page.screenshot({ path: info.outputPath("overview.png"), fullPage: true });
  await page.getByRole("button", { name: /全部设备/ }).click();
  const previousDialogs = await page.locator(".interaction").evaluateAll((cards) => cards.map((card) => card.getAttribute("data-dialog-id")));
  const windows = [];
  for (const name of ["开发台式机", "笔记本"]) {
    const card = page.locator(".device").filter({ has: page.getByRole("heading", { name, exact: true }) });
    const [native] = await Promise.all([context.waitForEvent("page"), card.getByRole("link", { name: "打开 o-pi" }).click()]);
    await expect(native.locator("#selected-session")).toHaveText("runtime-1");
    await native.getByRole("button", { name: "创建审批", exact: true }).click(); windows.push(native);
  }
  const nativeA = windows[0]; const nativeB = windows[1];
  if (!nativeA || !nativeB) throw new Error("缺少测试窗口");
  await page.bringToFront(); await page.getByRole("button", { name: /消息中心/ }).click();
  await expect.poll(() => page.locator(".interaction").evaluateAll((cards, old) => cards.every((card) => !old.includes(card.getAttribute("data-dialog-id"))), previousDialogs)).toBe(true);
  await expect(page.locator(".interaction")).toHaveCount(2);
  const approvalA = page.locator(".interaction").filter({ has: page.getByRole("heading", { name: "设备 A 的远程审批", exact: true }) });
  await approvalA.getByRole("button", { name: "确认", exact: true }).click();
  await expect(approvalA).toHaveCount(0); await expect(page.locator(".interaction")).toHaveCount(1);
  await expect(nativeA.locator("#selected-session")).toHaveText("runtime-1");
  await nativeB.getByRole("button", { name: "允许", exact: true }).click();
  await page.bringToFront(); await expect(page.locator(".interaction")).toHaveCount(0);
  await nativeA.getByRole("button", { name: "创建输入", exact: true }).click();
  await page.bringToFront();
  const field = page.getByRole("textbox", { name: "回答", exact: true }); await expect(field).toHaveValue("初始草稿");
  const refresh = page.waitForResponse((response) => response.url().endsWith("/_hub/overview"));
  await field.fill("保留用户草稿 中文 😀"); await refresh; await expect(field).toHaveValue("保留用户草稿 中文 😀");
  await page.getByRole("button", { name: "提交回答", exact: true }).click(); await expect(page.locator(".interaction")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await nativeA.close(); await nativeB.close(); expect(errors).toEqual([]);
});
