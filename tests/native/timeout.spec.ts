import { test, expect } from "@playwright/test";
import { setTimeout as delay } from "node:timers/promises";

test("真实审批等待超过 30 秒仍可确认，不被网关误报超时", async ({ page, context }) => {
  test.setTimeout(90_000);
  await page.goto("/"); await page.getByLabel("中心密码").fill("test-password-1234"); await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("button", { name: /全部设备/ }).click();
  const [native] = await Promise.all([context.waitForEvent("page"), page.getByRole("link", { name: "打开 o-pi" }).click()]);
  const statuses: number[] = [];
  native.on("response", (response) => { if (response.url().endsWith("/api/action") && response.request().postData()?.includes("/hub-test-confirm")) statuses.push(response.status()); });
  const dialog = native.getByRole("dialog");
  try {
    const editor = native.getByRole("textbox", { name: "消息", exact: true }); await expect(editor).toBeVisible();
    await editor.fill("/hub-test-confirm"); await editor.press("ControlOrMeta+Enter"); await expect(dialog).toBeVisible();
    // 真实经过旧的 30 秒期限，等待本身是故障条件，不用于猜测界面渲染时机。
    await delay(31_000); expect(statuses).toEqual([]); await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "确认", exact: true }).click();
    await expect.poll(() => statuses).toEqual([204]); await expect(dialog).toHaveCount(0);
    await expect(native.getByText("中心确认完成", { exact: true })).toBeVisible();
  } finally {
    if (await dialog.isVisible()) await dialog.getByRole("button", { name: "确认", exact: true }).click();
    await native.close();
  }
});
