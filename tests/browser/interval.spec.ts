import { test, expect } from "@playwright/test";
import { isPlan } from "../../src/shared/schedules.ts";

test("两种窗口间隔可配置、暂停与刷新恢复，切换频率不残留隐藏字段校验", async ({ page }, info) => {
  test.setTimeout(60_000);
  await page.goto("/"); await page.getByLabel("中心密码").fill("test-password-1234"); await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("button", { name: "计划任务", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建计划任务", exact: true }); const names: string[] = [];
  for (const kind of ["interval", "dailyInterval", "once"] as const) {
    const name = `${kind} ${info.project.name}`; names.push(name);
    await page.getByRole("button", { name: "新建计划", exact: true }).click();
    await dialog.getByLabel("计划名称", { exact: true }).fill(name); await dialog.getByLabel("计划设备", { exact: true }).selectOption({ label: "开发台式机" });
    await dialog.getByLabel("任务目录", { exact: true }).fill("/fixture/设备 A/other"); await dialog.getByLabel("任务描述", { exact: true }).fill("检查项目状态并汇报");
    await dialog.getByLabel("时区", { exact: true }).fill("UTC");
    const start = new Date(Date.now() + 3600_000).toISOString().slice(0, 19); const end = new Date(Date.now() + 7200_000).toISOString().slice(0, 19);
    if (kind === "interval") {
      await dialog.getByLabel("执行频率", { exact: true }).selectOption(kind);
      await dialog.getByLabel("开始日期时间", { exact: true }).fill(start); await dialog.getByLabel("结束日期时间", { exact: true }).fill(start);
      await dialog.getByLabel("间隔（分钟）", { exact: true }).fill("15");
      await dialog.getByRole("button", { name: "保存计划", exact: true }).click(); await expect(dialog.getByRole("alert")).toContainText("结束时间");
      await dialog.getByLabel("结束日期时间", { exact: true }).fill(end);
    } else {
      await dialog.getByLabel("执行频率", { exact: true }).selectOption("dailyInterval");
      await dialog.getByLabel("每日开始时间", { exact: true }).fill("23:00"); await dialog.getByLabel("每日结束时间", { exact: true }).fill("01:00");
      await dialog.getByLabel("间隔（分钟）", { exact: true }).fill(kind === "once" ? "0" : "40");
      if (kind === "once") {
        await dialog.getByLabel("执行频率", { exact: true }).selectOption(kind); await dialog.getByLabel("预约时间", { exact: true }).fill(start);
        await expect(dialog.getByLabel("间隔（分钟）", { exact: true })).toBeDisabled();
      }
    }
    if (kind === "dailyInterval") await page.screenshot({ path: info.outputPath("interval-dialog.png"), fullPage: true, animations: "disabled" });
    const added = page.waitForResponse((response) => response.url().endsWith("/_hub/schedules") && response.request().method() === "POST");
    await dialog.getByRole("button", { name: "保存计划", exact: true }).click();
    const saved: unknown = await (await added).json(); expect(isPlan(saved) ? saved.rule.kind : "invalid").toBe(kind);
    const card = page.locator(".plan-card").filter({ has: page.getByRole("heading", { name, exact: true }) });
    await card.getByRole("button", { name: "暂停计划", exact: true }).click(); await expect(card).toContainText("已暂停");
    await page.reload(); await page.getByRole("button", { name: "计划任务", exact: true }).click(); await expect(card).toContainText("已暂停");
    if (kind === "interval") await expect(card).toContainText(`${start.replace("T", " ")} 至 ${end.replace("T", " ")} · 每 15 分钟 · UTC`);
    if (kind === "dailyInterval") await expect(card).toContainText("每天 23:00–次日 01:00 · 每 40 分钟 · UTC");
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("interval-plans.png"), fullPage: true, animations: "disabled" });
  for (const name of names) {
    const card = page.locator(".plan-card").filter({ has: page.getByRole("heading", { name, exact: true }) });
    await card.getByRole("button", { name: "删除计划", exact: true }).click();
    await page.getByRole("dialog", { name: "确认计划操作", exact: true }).getByRole("button", { name: "确认操作", exact: true }).click(); await expect(card).toHaveCount(0);
  }
});
