import { test, expect } from "@playwright/test";

test("真实远程目录创建新会话，不切换已有页面，并集中处理新项目启动交互", async ({ page, context }) => {
  test.setTimeout(90_000);
  const errors: string[] = []; context.on("page", (tab) => tab.on("pageerror", (error) => errors.push(error.message)));
  await page.goto("/"); await page.getByLabel("中心密码").fill("test-password-1234"); await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("button", { name: /全部设备/ }).click();
  const [before] = await Promise.all([context.waitForEvent("page"), page.getByRole("link", { name: "打开 o-pi" }).click()]);
  await expect(before.getByRole("treeitem", { name: "hello.txt", exact: true })).toBeVisible(); await page.bringToFront();
  await page.getByRole("button", { name: "新建会话", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建会话", exact: true });
  await dialog.getByRole("combobox", { name: "会话设备", exact: true }).selectOption({ label: "原生 o-pi" });
  await dialog.getByRole("button", { name: "浏览目录", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "上一级", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "上一级", exact: true }).click();
  await dialog.getByRole("button", { name: "remote-project", exact: true }).click();
  await dialog.getByRole("button", { name: "使用此目录", exact: true }).click();
  const path = await dialog.getByRole("textbox", { name: "工作目录", exact: true }).inputValue();
  const response = page.waitForResponse((response) => response.url().endsWith("/_hub/sessions"));
  await dialog.getByRole("button", { name: "创建会话", exact: true }).click();
  const result: unknown = await (await response).json();
  if (typeof result !== "object" || result === null || !("creationId" in result) || typeof result.creationId !== "string") throw new Error("无效创建确认");
  const record = page.locator(`.creation-record[data-creation-id="${result.creationId}"]`);
  await expect(record).toContainText("会话已就绪");
  const [created] = await Promise.all([context.waitForEvent("page"), record.getByRole("link", { name: "打开会话" }).click()]);
  await expect(created.getByRole("treeitem", { name: "remote.txt", exact: true })).toBeVisible();
  await expect(before.getByRole("treeitem", { name: "hello.txt", exact: true })).toBeVisible();
  await created.close(); await page.bringToFront();
  await page.getByRole("button", { name: "新建会话", exact: true }).click();
  await dialog.getByRole("combobox", { name: "会话设备", exact: true }).selectOption({ label: "原生 o-pi" });
  await dialog.getByRole("textbox", { name: "工作目录", exact: true }).fill(path.replace(/remote-project$/, "trust-project"));
  const accepted = page.waitForResponse((response) => response.url().endsWith("/_hub/sessions"));
  await dialog.getByRole("button", { name: "创建会话", exact: true }).click();
  const ack: unknown = await (await accepted).json();
  if (typeof ack !== "object" || ack === null || !("creationId" in ack) || typeof ack.creationId !== "string") throw new Error("无效创建确认");
  const pending = page.locator(`.creation-record[data-creation-id="${ack.creationId}"]`);
  await expect(pending.getByRole("button", { name: "查看待处理" })).toBeVisible();
  await pending.getByRole("button", { name: "查看待处理" }).click();
  const handled = new Set<string>();
  for (let attempt = 0; attempt < 3; attempt++) {
    let event = "";
    await expect.poll(async () => {
      const value: unknown = await (await page.request.get("/_hub/overview")).json();
      if (typeof value !== "object" || value === null || !("creations" in value) || !Array.isArray(value.creations) || !("interactions" in value) || !Array.isArray(value.interactions)) throw new Error("无效概览");
      const current: unknown = value.creations.find((item: unknown) => typeof item === "object" && item !== null && "id" in item && item.id === ack.creationId);
      if (typeof current === "object" && current !== null && "state" in current && current.state === "ready") return event = "ready";
      const next: unknown = value.interactions.find((item: unknown) => typeof item === "object" && item !== null && "title" in item && item.title === "确认新建项目信任" && "id" in item && typeof item.id === "string" && !handled.has(item.id));
      if (typeof next === "object" && next !== null && "id" in next && typeof next.id === "string") return event = next.id;
      return "";
    }).not.toBe("");
    if (event === "ready") break;
    const question = page.locator(`.interaction[data-dialog-id="${event}"]`);
    await expect(question).toContainText("trust-project");
    await question.getByRole("button", { name: "确认", exact: true }).click(); handled.add(event);
  }
  expect(handled.size).toBeGreaterThan(0); await expect(pending).toContainText("会话已就绪");
  await page.screenshot({ path: test.info().outputPath("native-creation.png"), fullPage: true });
  await before.close(); expect(errors).toEqual([]);
});
