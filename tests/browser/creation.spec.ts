import { test, expect } from "@playwright/test";

test("全局浏览远程目录创建会话，原页面不切换，工作区入口自动预填", async ({ page, context }, info) => {
  await page.addInitScript(() => { Object.defineProperty(window.crypto, "randomUUID", { value: undefined }); });
  const errors: string[] = []; context.on("page", (tab) => tab.on("pageerror", (error) => errors.push(error.message)));
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/"); await page.getByLabel("中心密码").fill("test-password-1234"); await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("button", { name: /全部设备/ }).click();
  const device = page.locator(".device").filter({ has: page.getByRole("heading", { name: "开发台式机", exact: true }) });
  const [before] = await Promise.all([context.waitForEvent("page"), device.getByRole("link", { name: "打开 o-pi" }).click()]);
  await expect(before.locator("#selected-session")).toHaveText("runtime-1"); await page.bringToFront();
  await page.getByRole("button", { name: "新建会话", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建会话", exact: true });
  await dialog.getByRole("combobox", { name: "会话设备", exact: true }).selectOption({ label: "开发台式机" });
  await dialog.getByRole("button", { name: "浏览目录", exact: true }).click();
  await expect(dialog.locator("#directory-status")).toHaveText("/fixture/设备 A");
  await dialog.getByRole("button", { name: "新项目", exact: true }).click();
  await expect(dialog.locator("#directory-status")).toHaveText("/fixture/设备 A/新项目");
  await dialog.getByRole("button", { name: "使用此目录", exact: true }).click();
  await expect(dialog.getByRole("textbox", { name: "工作目录", exact: true })).toHaveValue("/fixture/设备 A/新项目");
  await page.screenshot({ path: info.outputPath("create-session.png"), fullPage: true });
  const response = page.waitForResponse((response) => response.url().endsWith("/_hub/sessions"));
  await dialog.getByRole("button", { name: "创建会话", exact: true }).click();
  const value: unknown = await (await response).json();
  if (typeof value !== "object" || value === null || !("creationId" in value) || typeof value.creationId !== "string") throw new Error("无效创建确认");
  const record = page.locator(`.creation-record[data-creation-id="${value.creationId}"]`);
  await expect(record).toContainText("会话已就绪"); await expect(dialog).not.toBeVisible();
  const [created] = await Promise.all([context.waitForEvent("page"), record.getByRole("link", { name: "打开会话" }).click()]);
  await expect(created.locator("#selected-cwd")).toHaveText("/fixture/设备 A/新项目");
  await expect(created.locator("#selected-session")).not.toHaveText(/^(runtime-1|runtime-2|)$/);
  await expect(before.locator("#selected-session")).toHaveText("runtime-1");
  await created.close(); await page.bringToFront();
  if (info.project.name === "phone") await page.getByRole("combobox", { name: "设备与工作区", exact: true }).selectOption({ label: "/fixture/设备 A/新项目" });
  else {
    await page.locator("#device-nav").getByRole("button", { name: "开发台式机", exact: true }).click();
    await page.locator(".workspace-card").filter({ hasText: "/fixture/设备 A/新项目" }).click();
  }
  await page.getByRole("button", { name: "新建会话", exact: true }).click();
  await expect(dialog.getByRole("textbox", { name: "工作目录", exact: true })).toHaveValue("/fixture/设备 A/新项目");
  await expect(dialog.getByRole("combobox", { name: "会话设备", exact: true })).toHaveValue(await record.getAttribute("data-device-id") ?? "");
  await dialog.getByRole("combobox", { name: "会话设备", exact: true }).selectOption({ label: "笔记本" });
  await expect(dialog.getByRole("textbox", { name: "工作目录", exact: true })).toHaveValue("");
  await dialog.getByRole("textbox", { name: "工作目录", exact: true }).fill("/fixture/设备 B/denied");
  await dialog.getByRole("button", { name: "浏览目录", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("EACCES");
  await dialog.getByRole("button", { name: "关闭新建会话", exact: true }).click(); await before.close();
  expect(errors).toEqual([]);
});
