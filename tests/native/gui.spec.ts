import { test, expect } from "@playwright/test";

test("真实 o-pi Web 经中心访问、重命名和刷新恢复", async ({ page, context }) => {
  const errors: string[] = [];
  await page.goto("/");
  await page.getByLabel("中心密码").fill("test-password-1234");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("button", { name: /全部设备/ }).click();
  await expect(page.locator(".device")).toHaveCount(1);
  const [native] = await Promise.all([context.waitForEvent("page"), page.getByRole("link", { name: "打开 o-pi" }).click()]);
  native.on("pageerror", (error) => errors.push(error.message));
  const editor = native.getByRole("textbox", { name: "消息", exact: true });
  await expect(editor).toBeVisible();
  await native.locator(".session-heading button").click();
  const title = native.getByRole("textbox", { name: "会话名称", exact: true });
  await title.fill("来自 opi-hub"); await title.press("Enter");
  await expect(native.locator(".session-heading")).toContainText("来自 opi-hub");
  await native.reload();
  await expect(editor).toBeVisible();
  await expect(native.locator(".session-heading")).toContainText("来自 opi-hub");
  await native.getByRole("treeitem", { name: "hello.txt", exact: true }).click();
  await expect(native.locator(".file-preview-body")).toContainText("原生 o-pi 远程文件预览");
  await native.screenshot({ path: test.info().outputPath("native-gui.png"), fullPage: true });
  expect(errors).toEqual([]);
  await native.close();
});
