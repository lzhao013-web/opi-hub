import { test, expect, type Page } from "@playwright/test";
import { object } from "../../src/shared/protocol.ts";
import type { Interaction, ManagedSession, SessionState } from "../../src/shared/management.ts";

const paths = ["/repo/empty", "/repo/recent", "/repo/older", "/repo/running", "/repo/waiting", "/repo/unknown"];
async function workspaceFixture(page: Page, state: { active: boolean; ready: boolean; paths: string[]; dialogs?: boolean }) {
  let revision = 0;
  await page.route("**/_hub/overview", async (route) => {
    const response = await route.fetch(); const data: unknown = await response.json();
    if (!object(data) || !Array.isArray(data.devices)) throw new Error("缺少设备快照");
    const first: unknown = data.devices.find((item) => object(item) && item.name === "开发台式机");
    const second: unknown = data.devices.find((item) => object(item) && item.name === "笔记本");
    if (!object(first) || typeof first.id !== "string" || !object(second) || typeof second.id !== "string") throw new Error("缺少测试设备");
    if (object(first.report)) first.report.ready = state.ready;
    const firstId = first.id;
    const session = (id: string, cwd: string, status: SessionState, modified: string, deviceId = firstId): ManagedSession & { deviceId: string } =>
      ({ deviceId, target: { id }, cwd, state: deviceId === firstId && !state.active ? "idle" : status, modified, file: null, title: `测试会话 ${id}` });
    data.sessions = [
      session("run", "/repo/running", "running", "2026-11-12T09:00:00.000Z"),
      session("load", "/repo/running", "loading", "2026-11-13T10:00:00.000Z"),
      session("wait", "/repo/waiting", "waiting", ""),
      session("recent", "/repo/recent", "idle", "2026-11-14T11:00:00.000Z"),
      session("older", "/repo/older", "idle", "2026-11-10T09:00:00.000Z"),
      session("unknown", "/repo/unknown", "idle", "无效时间"),
      session("run", "/repo/empty", "running", "2026-11-15T00:00:00.000Z", second.id),
    ];
    const pending = (id: string, sessionId: string, deviceId: string): Interaction & { deviceId: string } =>
      ({ id, sessionId, deviceId, kind: "confirm", title: "测试交互", message: "仅供界面测试", deadline: null });
    data.interactions = [...(state.active && state.dialogs !== false ? [pending("one", "wait", first.id), pending("two", "wait", first.id)] : []), pending("other", "run", second.id)];
    const catalog = state.paths.map((path) => ({ deviceId: first.id, path }));
    data.workspaces = [...(++revision % 2 ? catalog : catalog.toReversed()), { deviceId: second.id, path: "/repo/empty" }];
    data.creations = [];
    await route.fulfill({ response, json: data });
  });
  await page.goto("/"); await page.getByLabel("中心密码").fill("test-password-1234");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("heading", { name: "概览", exact: true })).toBeVisible();
}
async function selectDevice(page: Page, name: string, phone: boolean) {
  if (phone) await page.getByRole("combobox", { name: "设备与工作区", exact: true }).selectOption({ label: `${name} · 设备概览` });
  else await page.locator("#device-nav").getByRole("button", { name, exact: true }).click();
}

test("紧凑工作区列表按活动排序、显示交互计数，筛选跨轮询保留且新建不切换页面", async ({ page }, info) => {
  const state = { active: true, ready: true, paths, dialogs: true }; const reads: string[] = []; const errors: string[] = [];
  page.on("request", (request) => { if (/\/_hub\/(history|directories|sessions)$/.test(request.url())) reads.push(request.url()); });
  page.on("pageerror", (error) => errors.push(error.message));
  await workspaceFixture(page, state); await selectDevice(page, "开发台式机", info.project.name === "phone");
  const list = page.locator("#workspaces"); const rows = list.locator(".workspace-row");
  const all = page.getByRole("button", { name: "全部", exact: true }); const active = page.getByRole("button", { name: "有活动", exact: true });
  await expect(rows.locator("strong")).toHaveText(["waiting", "running", "recent", "older", "empty", "unknown"]);
  await expect(all).toHaveAttribute("aria-pressed", "true"); await expect(page.locator("#device-sessions")).toHaveCount(0);
  await expect(rows.filter({ hasText: "/repo/waiting" }).locator(".workspace-activity")).toHaveText("2 个待处理");
  await expect(rows.filter({ hasText: "/repo/running" }).locator(".workspace-activity")).toHaveText("2 个进行中");
  await expect(rows.filter({ hasText: "/repo/empty" }).locator(".workspace-activity")).toHaveText("暂无活动");
  await expect(rows.filter({ hasText: "/repo/unknown" }).locator(".workspace-updated")).toHaveText("尚无活动记录");
  await expect(rows.filter({ hasText: "/repo/running" }).locator("time")).toHaveAttribute("datetime", "2026-11-13T10:00:00.000Z");
  await expect(list).not.toContainText("0 个");
  await page.screenshot({ path: info.outputPath("workspace-list-light.png"), fullPage: true, animations: "disabled" });
  state.dialogs = false;
  await expect(rows.filter({ hasText: "/repo/waiting" }).locator(".workspace-activity")).toHaveText("1 个等待交互");
  state.dialogs = true;
  await expect(rows.filter({ hasText: "/repo/waiting" }).locator(".workspace-activity")).toHaveText("2 个待处理");
  await active.click(); await expect(rows.locator("strong")).toHaveText(["waiting", "running"]);
  const create = rows.filter({ hasText: "/repo/running" }).getByRole("button", { name: "新建会话", exact: true });
  await create.click();
  const dialog = page.getByRole("dialog", { name: "新建会话", exact: true });
  await expect(dialog.getByLabel("工作目录", { exact: true })).toHaveValue("/repo/running");
  await expect(dialog.getByLabel("会话设备", { exact: true }).locator("option:checked")).toHaveText("开发台式机");
  await expect(page.locator("#heading")).toHaveText("开发台式机");
  await dialog.getByRole("button", { name: "关闭新建会话", exact: true }).click();
  await create.focus(); state.active = false;
  await expect(rows).toHaveCount(0); await expect(list).toContainText("没有正在进行或待处理的工作区");
  await expect(active).toHaveAttribute("aria-pressed", "true"); await expect(active).toBeFocused();
  await all.click(); await expect(rows).toHaveCount(6); await expect(rows.first().locator("strong")).toHaveText("recent");
  state.active = true; await expect(rows.first().locator("strong")).toHaveText("waiting");
  await create.focus(); state.ready = false;
  await expect(rows.getByRole("button", { name: "新建会话", exact: true }).first()).toBeDisabled();
  await expect(rows.filter({ hasText: "/repo/running" }).getByRole("button", { name: "进入工作区 /repo/running", exact: true })).toBeFocused();
  state.ready = true; await expect(create).toBeEnabled();
  await active.click(); await selectDevice(page, "笔记本", info.project.name === "phone");
  await expect(all).toHaveAttribute("aria-pressed", "true"); await expect(rows).toHaveCount(1);
  await selectDevice(page, "开发台式机", info.project.name === "phone"); await expect(active).toHaveAttribute("aria-pressed", "true");
  await expect(rows).toHaveCount(2);
  await page.getByRole("button", { name: "切换主题", exact: true }).click(); await page.getByRole("button", { name: "切换主题", exact: true }).click();
  await page.screenshot({ path: info.outputPath("workspace-list-dark.png"), fullPage: true, animations: "disabled" });
  await all.click();
  const open = list.getByRole("button", { name: "进入工作区 /repo/running", exact: true }); await open.focus(); await open.press("Enter");
  await expect(page.locator("#heading")).toHaveText("running"); await expect(page.locator("#selected-workspace")).toHaveText("/repo/running");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(reads).toEqual([]); expect(errors).toEqual([]);
});

test("工作区列表保留同名项目的原始长路径，支持空目录和活动为空的提示", async ({ page }, info) => {
  const state = { active: true, ready: true, paths: ["C:\\项目\\demo", "/repo/other/demo", `/repo/${"长目录".repeat(80)}/demo`, "/repo/<img src=x onerror=alert(1)>"] };
  await workspaceFixture(page, state); await selectDevice(page, "开发台式机", info.project.name === "phone");
  const list = page.locator("#workspaces"); const rows = list.locator(".workspace-row");
  await expect(rows).toHaveCount(4); await expect(list.locator("img")).toHaveCount(0);
  for (const path of state.paths) {
    const open = list.getByRole("button", { name: `进入工作区 ${path}`, exact: true });
    await expect(open.locator(".workspace-path")).toHaveAttribute("title", path);
    await open.locator(".workspace-path").click(); await expect(page.locator("#selected-workspace")).toHaveText(path);
    await selectDevice(page, "开发台式机", info.project.name === "phone");
    const row = rows.filter({ has: page.getByRole("button", { name: `进入工作区 ${path}`, exact: true }) });
    await row.getByRole("button", { name: "新建会话", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "新建会话", exact: true });
    await expect(dialog.getByLabel("工作目录", { exact: true })).toHaveValue(path);
    await dialog.getByRole("button", { name: "关闭新建会话", exact: true }).click();
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "有活动", exact: true }).click();
  await expect(rows).toHaveCount(0); await expect(list).toContainText("没有正在进行或待处理的工作区");
  state.paths = []; await expect(list).toContainText("暂无可浏览的工作区");
});
