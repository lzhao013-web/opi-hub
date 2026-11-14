import { test, expect } from "@playwright/test";

test("托管后端显示 PID 和日志，重启需要确认并使页面历史缓存失效", async ({ page }, info) => {
  await page.goto("/"); await page.getByLabel("中心密码").fill("test-password-1234"); await page.getByRole("button", { name: "登录", exact: true }).click();
  if (info.project.name === "phone") await page.getByRole("combobox", { name: "设备与工作区", exact: true }).selectOption({ label: "/fixture/设备 B/other" });
  else {
    await page.locator("#device-nav").getByRole("button", { name: "笔记本", exact: true }).click();
    await page.getByRole("button", { name: "进入工作区 /fixture/设备 B/other", exact: true }).click();
  }
  await page.getByRole("button", { name: "加载历史会话", exact: true }).click(); await expect(page.locator("#history-status")).toContainText("已加载");
  await page.getByRole("button", { name: /全部设备/ }).click();
  const card = page.locator(".device").filter({ has: page.getByRole("heading", { name: "笔记本", exact: true }) });
  const pid = card.locator("dt:has-text('进程 PID') + dd"); const before = await pid.textContent();
  await expect(card).toContainText("托管后端"); await expect(card.getByText("最近后端日志", { exact: true })).toBeVisible();
  await card.getByRole("button", { name: "重启后端", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "重启托管后端？", exact: true }); await expect(dialog).toContainText("中断");
  await dialog.getByRole("button", { name: "取消", exact: true }).click(); await expect(pid).toHaveText(before ?? "");
  await card.getByRole("button", { name: "重启后端", exact: true }).click();
  await dialog.getByRole("button", { name: "确认重启", exact: true }).click();
  await expect(dialog).not.toBeVisible(); await expect(pid).not.toHaveText(before ?? "");
  await expect(card.getByRole("link", { name: "打开 o-pi" })).toBeVisible();
  await expect(page.getByRole("button", { name: "新建会话", exact: true })).toBeEnabled();
  if (info.project.name === "phone") await page.getByRole("combobox", { name: "设备与工作区", exact: true }).selectOption({ label: "/fixture/设备 B/other" });
  else {
    await page.locator("#device-nav").getByRole("button", { name: "笔记本", exact: true }).click();
    await page.getByRole("button", { name: "进入工作区 /fixture/设备 B/other", exact: true }).click();
  }
  await expect(page.getByRole("button", { name: "加载历史会话", exact: true })).toBeVisible();
  await expect(page.locator("#history-status")).toContainText("尚未读取");
});
