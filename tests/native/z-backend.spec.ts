import { test, expect } from "@playwright/test";

test("真实托管后端重启保留已保存历史，不自动恢复运行实例", async ({ page }) => {
  await page.goto("/"); await page.getByLabel("中心密码").fill("test-password-1234"); await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("button", { name: "查找历史", exact: true }).click();
  await page.getByRole("searchbox", { name: "历史关键词", exact: true }).fill("托管重启保留历史");
  await page.getByRole("button", { name: "搜索历史", exact: true }).click(); await expect(page.locator("#history-results")).toContainText("托管重启保留历史");
  await page.getByRole("button", { name: /全部设备/ }).click();
  const card = page.locator(".device"); const pid = card.locator("dt:has-text('进程 PID') + dd"); const before = await pid.textContent();
  await card.getByRole("button", { name: "重启后端", exact: true }).click();
  await page.getByRole("dialog", { name: "重启托管后端？", exact: true }).getByRole("button", { name: "确认重启", exact: true }).click();
  await expect(pid).not.toHaveText(before ?? ""); await expect(card.getByRole("link", { name: "打开 o-pi" })).toBeVisible();
  await expect(page.getByRole("button", { name: "新建会话", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "概览", exact: true }).click();
  await expect(page.locator("#active-sessions .session-row")).toHaveCount(0); await expect(page.locator("#recent-sessions .session-row")).toHaveCount(0);
  await page.getByRole("button", { name: "查找历史", exact: true }).click();
  await page.getByRole("button", { name: "搜索历史", exact: true }).click(); await expect(page.locator("#history-results")).toContainText("托管重启保留历史");
  await page.screenshot({ path: test.info().outputPath("managed-backend.png"), fullPage: true });
});
