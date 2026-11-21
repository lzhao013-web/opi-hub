import { test, expect } from "@playwright/test";

test("浏览器能加载已登录设备的 manifest，未登录仍返回 401", async ({ page, context, request }) => {
  await page.goto("/");
  await page.getByLabel("中心密码").fill("test-password-1234");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("button", { name: /全部设备/ }).click();
  const card = page.locator(".device").filter({ has: page.getByRole("heading", { name: "开发台式机", exact: true }) });
  const [tab] = await Promise.all([context.waitForEvent("page"), card.getByRole("link", { name: "打开 o-pi" }).click()]);
  await expect(tab.locator("#name")).toHaveText("设备 A");
  const cdp = await context.newCDPSession(tab);
  const manifest = await cdp.send("Page.getAppManifest");
  expect(manifest.url).toBe(new URL("site.webmanifest", tab.url()).href);
  expect(manifest.data).toBe(JSON.stringify({ name: "o-pi fixture" }));
  expect((await request.get(manifest.url)).status()).toBe(401);
});

test("登录、配置签发、双设备 GUI 和审批互不串线", async ({ page, context }) => {
  const errors: string[] = [];
  context.on("page", (tab) => tab.on("pageerror", (error) => errors.push(error.message)));
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.getByLabel("中心密码").fill("test-password-1234");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("heading", { name: "概览", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /全部设备/ }).click();
  await expect(page.getByRole("heading", { name: "你的设备" })).toBeVisible();
  await expect(page.locator(".device")).toHaveCount(2);
  await page.getByRole("button", { name: "添加设备", exact: true }).first().click();
  await page.getByLabel("设备名称").fill("测试设备");
  await page.getByRole("button", { name: "创建设备" }).click();
  const config = page.getByRole("textbox", { name: "节点配置" });
  await expect(config).toBeVisible(); await expect(config).toHaveValue(/"token"/);
  await page.getByRole("button", { name: "完成", exact: true }).click();
  const temporary = page.locator(".device").filter({ has: page.getByRole("heading", { name: "测试设备", exact: true }) });
  await temporary.getByRole("button", { name: "移除 测试设备" }).click();
  await page.getByRole("button", { name: "移除设备", exact: true }).click();
  await expect(page.locator(".device")).toHaveCount(2);
  const cardA = page.locator(".device").filter({ has: page.getByRole("heading", { name: "开发台式机", exact: true }) });
  const cardB = page.locator(".device").filter({ has: page.getByRole("heading", { name: "笔记本", exact: true }) });
  const [tabA] = await Promise.all([context.waitForEvent("page"), cardA.getByRole("link", { name: "打开 o-pi" }).click()]);
  const [tabB] = await Promise.all([context.waitForEvent("page"), cardB.getByRole("link", { name: "打开 o-pi" }).click()]);
  await expect(tabA.locator("#name")).toHaveText("设备 A");
  await expect(tabB.locator("#name")).toHaveText("设备 B");
  await expect(tabA.locator("#result")).toHaveText("设备 A");
  await expect(tabB.locator("#result")).toHaveText("设备 B");
  for (const [tab, name] of [[tabA, "设备 A"], [tabB, "设备 B"]] as const) {
    await expect.poll(() => tab.locator("#preview").evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
    await tab.getByLabel("消息").fill(`hello ${name}`);
    await tab.getByRole("button", { name: "发送", exact: true }).click();
    await expect(tab.locator("#result")).toHaveText(`${name}:hello ${name}`);
    await expect(tab.locator("#socket")).toHaveText(`hello ${name}`);
    await tab.getByRole("button", { name: "允许", exact: true }).click();
    await expect(tab.locator("#approval")).toHaveText(`${name}:approved`);
    await tab.reload(); await expect(tab.locator("#name")).toHaveText(name);
  }
  await tabA.close(); await tabB.close();
  await page.screenshot({ path: test.info().outputPath("devices.png"), fullPage: true, animations: "disabled" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "切换主题", exact: true }).click();
  await page.getByRole("button", { name: "切换主题", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.screenshot({ path: test.info().outputPath("devices-dark.png"), fullPage: true, animations: "disabled" });
  await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "退出", exact: true }).click();
  await expect(page.getByLabel("中心密码")).toBeVisible();
  expect(errors).toEqual([]);
});
