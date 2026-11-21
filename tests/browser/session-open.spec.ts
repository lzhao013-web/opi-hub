import { expect, test, type Page, type WebSocketRoute } from "@playwright/test";
import { object } from "../../src/shared/protocol.ts";

const target = { id: "runtime-1", cwd: "/fixture/设备 A", path: "/fixture/设备 A/idle.jsonl" };

async function openTarget(page: Page) {
  await page.goto("/");
  await page.getByLabel("中心密码").fill("test-password-1234");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("heading", { name: "概览", exact: true })).toBeVisible();
  const overview: unknown = await (await page.request.get("/_hub/overview")).json();
  if (!object(overview) || !Array.isArray(overview.devices)) throw new Error("缺少设备列表");
  const device: unknown = overview.devices.find((item: unknown) => object(item) && item.name === "开发台式机");
  if (!object(device) || typeof device.id !== "string") throw new Error("缺少目标设备");

  const routed = Promise.withResolvers<WebSocketRoute>();
  await page.routeWebSocket((url) => url.pathname.endsWith("/api/events") && url.searchParams.get("session") === target.id, routed.resolve);
  await page.goto(`/n/${device.id}/?hub-session=${target.id}`);
  const socket = await routed.promise;
  let sequence = 0;
  return async (session: typeof target | null) => {
    const id = ++sequence;
    const echo = `已收到会话事件 ${id}`;
    socket.send(JSON.stringify({ kind: "frame", id, events: [{ type: "selected", session }], echo }));
    await expect(page.locator("#socket")).toHaveText(echo);
  };
}

test("运行会话已打开，后续空选中事件不弹出打开失败提示", async ({ page }) => {
  const select = await openTarget(page);
  await select(target);
  await expect(page.locator("#selected-session")).toHaveText(target.id);
  await select(null);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await select(target);
  await expect(page.locator("#selected-session")).toHaveText(target.id);
});

test("首次打开失败只提示一次，关闭后不再弹出", async ({ page }) => {
  const select = await openTarget(page);
  await select(null);
  const alert = page.getByRole("alert");
  await expect(alert.getByRole("link", { name: "返回会话管理" })).toHaveAttribute("href", "/");
  await select(null);
  await expect(alert).toHaveCount(1);
  await alert.getByRole("button", { name: "关闭", exact: true }).click();
  await select(null);
  await expect(alert).toHaveCount(0);
});

test("首次打开失败后选中目标会话，旧提示自动消失", async ({ page }) => {
  const select = await openTarget(page);
  await select(null);
  const alert = page.getByRole("alert");
  await expect(alert).toBeVisible();
  await select(target);
  await expect(page.locator("#selected-session")).toHaveText(target.id);
  await expect(alert).toHaveCount(0);
});
