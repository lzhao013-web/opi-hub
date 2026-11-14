import { test, expect, type Page } from "@playwright/test";
import { object } from "../../src/shared/protocol.ts";

const paths = [
  "/home/liang/.pi", "/home/liang/models/Ling 3.0 tiny GGUF", "/home/liang/models/Qwen3.8-Flash-Next-GGUF",
  "/home/liang/repo/agent-coding-bench", "/home/liang/repo/o-pi", "/home/liang/repo/opi-hub",
  "/home/liang/repo/opi-hub/examples/demo", "/home/liang/repo/tools/demo", "/tmp/pi-smoke",
];
async function workspaceFixture(page: Page, workspaces = paths) {
  let revision = 0;
  await page.route("**/_hub/overview", async (route) => {
    const response = await route.fetch(); const data: unknown = await response.json();
    if (!object(data) || !Array.isArray(data.devices)) throw new Error("缺少设备快照");
    const device: unknown = data.devices.find((item) => object(item) && item.name === "开发台式机");
    if (!object(device) || typeof device.id !== "string") throw new Error("缺少测试设备");
    const catalog = workspaces.map((path) => ({ deviceId: device.id, path }));
    data.workspaces = ++revision % 2 ? catalog : catalog.toReversed();
    await route.fulfill({ response, json: data });
  });
  await page.goto("/"); await page.getByLabel("中心密码").fill("test-password-1234");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("heading", { name: "概览", exact: true })).toBeVisible();
}

test("设备旁展示路径树，目录折叠与工作区选择分离，刷新保留状态", async ({ page }, info) => {
  const reads: string[] = []; const errors: string[] = [];
  page.on("request", (request) => { if (/\/_hub\/(history|directories)$/.test(request.url())) reads.push(request.url()); });
  page.on("pageerror", (error) => errors.push(error.message));
  await workspaceFixture(page);
  const panel = page.locator("#workspace-panel"); const tree = page.locator("#workspace-tree");
  await expect(panel).toBeHidden();
  if (info.project.name === "phone") {
    await page.getByRole("combobox", { name: "设备与工作区", exact: true }).selectOption({ label: "/home/liang/repo/opi-hub/examples/demo" });
    await expect(page.getByRole("heading", { name: "demo", exact: true })).toBeVisible();
    await expect(panel).toBeHidden();
    await expect(page.locator("#selected-workspace")).toHaveText("/home/liang/repo/opi-hub/examples/demo");
  } else {
    await page.locator("#device-nav").getByRole("button", { name: "开发台式机", exact: true }).click();
    await expect(panel).toBeVisible(); await expect(page.locator("#workspace-tree-count")).toHaveText("9");
    await expect(tree.getByRole("button", { name: "折叠 /home/liang", exact: true })).toBeVisible();
    const parent = tree.getByRole("button", { name: "开发台式机 / /home/liang/repo/opi-hub", exact: true });
    const child = tree.getByRole("button", { name: "开发台式机 / /home/liang/repo/opi-hub/examples/demo", exact: true });
    await parent.click(); await expect(page.getByRole("heading", { name: "opi-hub", exact: true })).toBeVisible();
    await expect(parent).toHaveAttribute("aria-current", "page"); await expect(child).toBeVisible();
    await page.getByRole("button", { name: "预约任务", exact: true }).click();
    const schedule = page.getByRole("dialog", { name: "新建计划任务", exact: true });
    await expect(schedule.getByLabel("任务目录", { exact: true })).toHaveValue("/home/liang/repo/opi-hub");
    await schedule.getByRole("button", { name: "关闭计划任务", exact: true }).click();
    await page.screenshot({ path: info.outputPath("workspace-tree-light.png"), fullPage: true, animations: "disabled" });
    const fold = tree.getByRole("button", { name: "折叠 opi-hub", exact: true });
    await fold.focus(); await fold.press("Enter"); await expect(child).toBeHidden();
    await page.waitForResponse((response) => response.url().endsWith("/_hub/overview"));
    await expect(child).toBeHidden(); await expect(tree.getByRole("button", { name: "展开 opi-hub", exact: true })).toBeFocused();
    await expect(page.getByRole("heading", { name: "opi-hub", exact: true })).toBeVisible();
    await page.getByRole("searchbox", { name: "筛选工作区", exact: true }).fill("examples/demo");
    await expect(child).toBeVisible(); await expect(parent).toHaveCount(0);
    await child.click(); await expect(page.getByRole("heading", { name: "demo", exact: true })).toBeVisible();
    await page.getByRole("searchbox", { name: "筛选工作区", exact: true }).fill("");
    await expect(child).toBeVisible(); await expect(child).toHaveAttribute("aria-current", "page");
    await expect(page.locator("#breadcrumb")).toContainText("/home/liang/repo/opi-hub/examples/demo");
    await page.getByRole("searchbox", { name: "筛选工作区", exact: true }).fill("没有这个工作区");
    await expect(tree).toContainText("没有匹配的工作区");
    await page.getByRole("searchbox", { name: "筛选工作区", exact: true }).fill("");
    await page.getByRole("button", { name: "切换主题", exact: true }).click();
    await page.getByRole("button", { name: "切换主题", exact: true }).click();
    await page.screenshot({ path: info.outputPath("workspace-tree-dark.png"), fullPage: true, animations: "disabled" });
    await page.locator("#device-nav").getByRole("button", { name: "笔记本", exact: true }).click();
    await expect(tree).toContainText("暂无工作区"); await expect(tree.getByRole("button")).toHaveCount(0);
    await page.locator("#device-nav").getByRole("button", { name: "开发台式机", exact: true }).click();
    await expect(parent).toBeVisible();
    await page.setViewportSize({ width: 900, height: 840 }); await expect(panel).toBeHidden();
    await page.getByRole("combobox", { name: "设备与工作区", exact: true }).selectOption({ label: "/home/liang/repo/opi-hub" });
    await expect(page.getByRole("heading", { name: "opi-hub", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.setViewportSize({ width: 1280, height: 840 }); await expect(panel).toBeVisible();
    await expect(parent).toHaveAttribute("aria-current", "page");
    await page.getByRole("button", { name: "概览", exact: true }).click(); await expect(panel).toBeHidden();
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(reads).toEqual([]); expect(errors).toEqual([]);
});

test("路径树区分磁盘、共享根和同名目录，选择保留原始路径", async ({ page }, info) => {
  test.skip(info.project.name === "phone", "手机通过完整路径选择器浏览");
  const workspaces = ["/", "C:\\", "C:\\工作区\\项目", "D:\\工作区\\项目", "\\\\nas\\team\\项目", "/repo/目录\\原名", "/repo/<img src=x onerror=alert(1)>", `/repo/${"很长项目".repeat(64)}`];
  await workspaceFixture(page, workspaces);
  await page.locator("#device-nav").getByRole("button", { name: "开发台式机", exact: true }).click();
  const tree = page.locator("#workspace-tree");
  await expect(tree.locator(".workspace-select")).toHaveCount(workspaces.length);
  for (const path of workspaces) {
    const item = tree.getByRole("button", { name: `开发台式机 / ${path}`, exact: true });
    await expect(item).toBeVisible(); await expect(item).toHaveAttribute("title", path);
    await item.click(); await expect(item).toHaveAttribute("aria-current", "page");
    await expect(page.locator("#selected-workspace")).toHaveText(path);
    await page.getByRole("button", { name: "新建会话", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "新建会话", exact: true });
    await expect(dialog.getByLabel("工作目录", { exact: true })).toHaveValue(path);
    await dialog.getByRole("button", { name: "关闭新建会话", exact: true }).click();
  }
  await expect(tree.locator("img")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
