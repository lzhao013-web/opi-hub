import { test, expect, type Page } from "@playwright/test";
import { object } from "../../src/shared/protocol.ts";
import { isPlan, isRun, type ScheduleRun } from "../../src/shared/schedules.ts";
import { MARKDOWN_REPLY } from "../markdown-fixture.ts";

async function login(page: Page) {
  await page.goto("/"); await page.getByLabel("中心密码").fill("test-password-1234"); await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("heading", { name: "概览", exact: true })).toBeVisible();
}
async function device(page: Page): Promise<string> {
  const value: unknown = await (await page.request.get("/_hub/overview")).json();
  if (!object(value) || !Array.isArray(value.devices)) throw new Error("缺少设备");
  const entry: unknown = value.devices.find((item: unknown) => object(item) && item.name === "开发台式机");
  if (!object(entry) || typeof entry.id !== "string") throw new Error("缺少设备身份"); return entry.id;
}
async function action(page: Page, deviceId: string, sessionId: string, text: string): Promise<void> {
  await page.evaluate(async ({ deviceId, sessionId, text }) => {
    await new Promise<void>((resolve, reject) => {
      const prefix = `/n/${deviceId}/`;
      const socket = new WebSocket(location.origin.replace(/^http/, "ws") + prefix + "api/events?session=hub-test-command&hub-preview=1");
      socket.onerror = () => reject(new Error("测试连接失败"));
      socket.onmessage = ({ data }) => {
        const frame = JSON.parse(data); if (!Array.isArray(frame.events)) return;
        socket.send(JSON.stringify({ kind: "ack", id: frame.id }));
        for (const item of frame.events) if (item.type === "client") void fetch(prefix + "api/action", {
          method: "POST", headers: { "Content-Type": "application/json", "X-Opi-Client": item.id }, body: JSON.stringify({ sessionId, value: { action: "prompt", text, images: [], behavior: "followUp" } }),
        }).then(async (response) => { socket.close(); if (!response.ok) throw new Error(await response.text()); resolve(); }).catch(reject);
      };
    });
  }, { deviceId, sessionId, text });
}
async function focusReport(page: Page, target: string) {
  return page.evaluate(({ target }) => new Promise<boolean>((resolve) => {
    const channel = new BroadcastChannel("opi-hub.presence");
    channel.onmessage = ({ data }) => { if (data?.type === "viewer" && data.sessionId === target) { channel.close(); resolve(data.focused); } };
    channel.postMessage({ type: "hub" });
  }), { target });
}
async function planRun(page: Page, deviceId: string, name: string, prompt: string): Promise<ScheduleRun> {
  const headers = { Origin: new URL(page.url()).origin };
  const response = await page.request.post("/_hub/schedules", { headers, data: { name, deviceId, path: "/fixture/设备 A/新项目", prompt, timeoutSeconds: 30, rule: { kind: "once", local: new Date(Date.now() + 3600_000).toISOString().slice(0, 19), timeZone: "UTC" } } });
  const entry: unknown = await response.json(); if (!isPlan(entry)) throw new Error("创建计划失败");
  const started: unknown = await (await page.request.post(`/_hub/schedules/${entry.id}/run`, { headers, data: {} })).json(); if (!isRun(started)) throw new Error("启动计划失败");
  let run = started;
  await expect.poll(async () => {
    const current: unknown = await (await page.request.get(`/_hub/runs/${started.id}`)).json();
    if (!isRun(current)) throw new Error("读取运行失败"); run = current; return current.state;
  }).toBe("completed");
  await page.request.delete(`/_hub/schedules/${entry.id}`, { headers }); return run;
}

test("消息中心分区、前台目标抑制与跨标签通知去重，别的会话在前台不漏报", async ({ page, context }) => {
  test.setTimeout(45_000);
  await context.addInitScript(() => {
    const records: { title: string; body: string | undefined }[] = [];
    Object.defineProperty(window, "hubTestNotifications", { value: records });
    class TestNotification {
      static permission = "granted";
      static async requestPermission() { return "granted"; }
      onclose: (() => void) | null = null;
      constructor(title: string, options?: NotificationOptions) { records.push({ title, body: options?.body }); }
      close() { this.onclose?.(); }
    }
    Object.defineProperty(window, "Notification", { value: TestNotification, configurable: true });
  });
  await login(page); const id = await device(page);
  const claims: string[] = []; page.on("request", (request) => { if (request.url().endsWith("/_hub/notifications/claim")) claims.push(request.postData() ?? ""); });
  const second = await context.newPage(); await second.goto("/"); await expect(second.getByRole("heading", { name: "概览", exact: true })).toBeVisible();
  const native = await context.newPage(); await native.goto(`/n/${id}/?hub-session=runtime-1`); await expect(native.locator("#selected-session")).toHaveText("runtime-1");
  await native.bringToFront(); expect(await focusReport(page, "runtime-1")).toBe(true);
  await action(native, id, "runtime-1", "前台完成不重复弹窗");
  await expect(page.locator("#notification-count")).toContainText("未读");
  expect(claims).toHaveLength(0); await expect(page.locator(".notification-toast")).toHaveCount(0);
  await native.goto(`/n/${id}/?hub-session=runtime-2`); await expect(native.locator("#selected-session")).toHaveText("runtime-2");
  await native.bringToFront(); expect(await focusReport(page, "runtime-2")).toBe(true);
  await action(native, id, "runtime-1", "另一个会话在前台仍提醒");
  await expect.poll(async () => {
    const count = async (tab: Page) => tab.evaluate(() => { const value: unknown = Reflect.get(window, "hubTestNotifications"); return Array.isArray(value) ? value.length : -100; });
    return await count(page) + await count(second);
  }).toBe(1);
  await native.getByRole("button", { name: "创建审批", exact: true }).click();
  await page.bringToFront(); await expect(page.locator("#interaction-count")).not.toBeEmpty(); await page.getByRole("button", { name: /消息中心/ }).click();
  await expect(page.getByRole("tab", { name: /待处理/ })).toHaveAttribute("aria-selected", "true");
  const before = await page.locator(".interaction").count(); expect(before).toBeGreaterThan(0);
  await page.getByRole("tab", { name: /通知/ }).click(); await expect(page.locator(".notification-card")).not.toHaveCount(0);
  await page.getByRole("button", { name: "全部标为已读", exact: true }).click(); await expect(page.locator("#notification-count")).toBeEmpty();
  await page.getByRole("tab", { name: /待处理/ }).click(); await expect(page.locator(".interaction")).toHaveCount(before);
  await native.close(); await second.close();
});

test("结果以 Markdown 安全排版，展开与详情跨轮询保留，复制仍为原始正文", async ({ page, context }, info) => {
  test.setTimeout(45_000);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const errors: string[] = []; const externalRequests: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message)); page.on("dialog", async (dialog) => { errors.push(dialog.message()); await dialog.dismiss(); });
  page.on("request", (request) => { if (new URL(request.url()).hostname === "tracking.example") externalRequests.push(request.url()); });
  await login(page); const id = await device(page); const run = await planRun(page, id, `Markdown 结果 ${info.project.name}`, "MARKDOWN 生成巡检报告");
  await page.getByRole("button", { name: "计划任务", exact: true }).click();
  const card = page.locator(`.run-card[data-run-id="${run.id}"]`); await card.scrollIntoViewIfNeeded();
  const body = card.locator(".result-body"); await expect(body.locator("h1")).toHaveText("巡检报告");
  await expect(card.getByRole("button", { name: "展开结果", exact: true })).toHaveAttribute("aria-expanded", "false");
  expect(await body.evaluate((element) => element.clientHeight)).toBeLessThan(110);
  await expect(body.getByRole("link", { name: "外部文档", exact: true })).toHaveAttribute("tabindex", "-1");
  await card.getByRole("button", { name: "展开结果", exact: true }).click();
  await expect(body).not.toHaveClass(/collapsed/); await expect(body.locator("strong").first()).toHaveText("12 个模块");
  await expect(body.locator("ul ul li")).toHaveText("不改变原审批规则"); await expect(body.locator("blockquote")).toContainText("不代表内容已经验证成功");
  await expect(body.locator("table tbody tr")).toHaveCount(2); await expect(body.locator("pre code")).toContainText('const result = "<img src=x onerror=alert(1)>";');
  const link = body.getByRole("link", { name: "外部文档", exact: true });
  await expect(link).not.toHaveAttribute("tabindex", "-1");
  await expect(link).toHaveAttribute("href", "https://example.com/report"); await expect(link).toHaveAttribute("target", "_blank"); await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  await expect(body.getByRole("link", { name: "发送邮件", exact: true })).toHaveAttribute("href", "mailto:review@example.com");
  await expect(body.locator("a")).toHaveCount(2); await expect(body.locator("img, script, iframe, style, [onerror], [onclick], [style]")).toHaveCount(0);
  await expect(body).toContainText("[图片：跟踪图片]"); expect(externalRequests).toEqual([]); expect(errors).toEqual([]);
  await card.getByRole("button", { name: "复制回复", exact: true }).click(); await expect(card.getByRole("button", { name: "已复制", exact: true })).toBeVisible();
  // Windows 系统剪贴板会把 LF 转为 CRLF，正文与 Markdown 标记仍需逐字一致。
  expect((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n")).toBe(MARKDOWN_REPLY.replace(/\r\n/g, "\n"));
  await card.getByRole("button", { name: "详情", exact: true }).click(); await expect(card.locator(".run-details")).toBeVisible();
  await page.waitForResponse((response) => response.url().endsWith("/_hub/schedules"));
  await expect(card.getByRole("button", { name: "收起结果", exact: true })).toHaveAttribute("aria-expanded", "true");
  await expect(card.getByRole("button", { name: "详情", exact: true })).toBeFocused();
  await planRun(page, id, `后续记录 ${info.project.name}`, "不影响原记录展开状态");
  await expect(page.locator(".run-card").filter({ has: page.getByRole("heading", { name: `后续记录 ${info.project.name}`, exact: true }) })).toBeVisible();
  await expect(body).not.toHaveClass(/collapsed/); await expect(card.locator(".run-details")).toBeVisible();
  await expect(card.getByRole("button", { name: "详情", exact: true })).toBeFocused();
  await card.getByRole("button", { name: "详情", exact: true }).click();
  await page.screenshot({ path: info.outputPath("markdown-result-expanded.png"), fullPage: true, animations: "disabled" });
  await card.getByRole("button", { name: "收起结果", exact: true }).click(); await expect(body).toHaveClass(/collapsed/);
  await page.screenshot({ path: info.outputPath("markdown-results.png"), fullPage: true, animations: "disabled" });
  await page.getByRole("button", { name: "切换主题", exact: true }).click(); await page.getByRole("button", { name: "切换主题", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.screenshot({ path: info.outputPath("markdown-results-dark.png"), fullPage: true, animations: "disabled" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const data = await page.evaluate(() => JSON.stringify([localStorage, sessionStorage])); expect(data).not.toContain("巡检报告");
});

test("任务结果就地读取原始回复、安全显示并排除思考，后续对话不覆盖本次结果", async ({ page, context }, info) => {
  test.setTimeout(45_000);
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  await login(page); const id = await device(page);
  const run = await planRun(page, id, `在线结果 ${info.project.name}`, "BLOCKS 生成报告"); expect(run.replyId).toBeTruthy(); expect(JSON.stringify(run)).not.toContain("最终报告");
  const readRequests: string[] = []; page.on("websocket", (socket) => { if (socket.url().includes("hub-preview=1")) readRequests.push(socket.url()); });
  const native = await context.newPage(); await native.goto(`/n/${id}/?hub-session=runtime-1`); await expect(native.locator("#selected-session")).toHaveText("runtime-1");
  await page.bringToFront(); await page.getByRole("button", { name: /消息中心/ }).click(); await page.getByRole("tab", { name: /通知/ }).click();
  const notice = page.locator(".notification-card").filter({ has: page.getByRole("heading", { name: run.name, exact: true }) });
  await notice.getByRole("button", { name: "查看任务结果", exact: true }).click();
  const card = page.locator(`.run-card[data-run-id="${run.id}"]`); await expect(card).toHaveClass(/highlighted-run/);
  await expect(card.locator(".result-body")).toHaveText("最终报告 <img src=x onerror=alert(1)> 中文 😀");
  await expect(card.locator(".run-result img")).toHaveCount(0); await expect(card.locator(".run-result")).not.toContainText("不能展示的思考"); await expect(card.locator(".run-result")).not.toContainText("隐藏工具");
  await expect(native.locator("#selected-session")).toHaveText("runtime-1"); expect(context.pages()).toHaveLength(2);
  const firstReads = readRequests.length;
  await page.waitForResponse((response) => response.url().endsWith("/_hub/schedules")); expect(readRequests).toHaveLength(firstReads);
  if (!run.session) throw new Error("缺少计划会话"); await action(page, id, run.session.id, "SECOND 后续人工对话");
  await page.reload(); await page.getByRole("button", { name: "计划任务", exact: true }).click(); await card.scrollIntoViewIfNeeded();
  await expect(card.locator(".result-body")).toHaveText("最终报告 <img src=x onerror=alert(1)> 中文 😀");
  const current: unknown = await (await page.request.get("/_hub/schedules")).json(); expect(JSON.stringify(current)).not.toContain("最终报告");
  const notices: unknown = await (await page.request.get("/_hub/notifications")).json(); expect(JSON.stringify(notices)).not.toContain("最终报告");
  const stored = await page.evaluate(() => [JSON.stringify(localStorage), JSON.stringify(sessionStorage)]); expect(stored.join()).not.toContain("最终报告");
  await page.screenshot({ path: info.outputPath("task-results.png"), fullPage: true, animations: "disabled" });
  await page.route("**/_hub/overview", async (route) => {
    const response = await route.fetch(); const value: unknown = await response.json();
    if (!object(value) || !Array.isArray(value.devices)) throw new Error("缺少概览");
    for (const entry of value.devices) if (object(entry) && entry.id === id) entry.connected = false;
    await route.fulfill({ response, json: value });
  });
  await expect(card.locator(".run-result")).toContainText("设备离线"); await expect(card.locator(".result-body")).toHaveCount(0);
  await page.unroute("**/_hub/overview"); await expect(card.locator(".result-body")).toHaveText("最终报告 <img src=x onerror=alert(1)> 中文 😀");
  await page.getByRole("button", { name: "退出", exact: true }).click(); await expect(page.getByRole("button", { name: "登录", exact: true })).toBeVisible(); await expect(page.locator(".result-body")).toHaveCount(0);
  await native.close(); expect(errors).toEqual([]);
});
