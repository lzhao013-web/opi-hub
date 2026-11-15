import { test, expect } from "@playwright/test";
import { object } from "../../src/shared/protocol.ts";

test("哈希资源首次 gzip、再次命中浏览器缓存，设备与退出登录不串用缓存", async ({ page }) => {
  await page.goto("/"); await page.getByLabel("中心密码").fill("test-password-1234");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("heading", { name: "概览", exact: true })).toBeVisible();
  const devices: unknown = await (await page.request.get("/_hub/devices")).json();
  expect(Array.isArray(devices)).toBe(true);
  if (!Array.isArray(devices)) throw new Error("设备列表无效");
  const paths: string[] = [];
  for (const name of ["开发台式机", "笔记本"]) {
    const device: unknown = devices.find((value: unknown) => object(value) && value.name === name);
    if (!object(device) || typeof device.id !== "string") throw new Error("缺少夹具设备");
    paths.push(`/n/${device.id}/assets/cache-Ab12_cd3.js`);
  }
  const [firstPath, secondPath] = paths; if (!firstPath || !secondPath) throw new Error("缺少资源路径");
  const read = (path: string) => page.evaluate(async (path) => {
    const response = await fetch(path); const text = await response.text();
    const entry = performance.getEntriesByName(new URL(path, location.href).href).at(-1);
    if (!(entry instanceof PerformanceResourceTiming)) throw new Error("缺少浏览器请求计时");
    return { status: response.status, text, encoding: response.headers.get("content-encoding"), transfer: entry.transferSize, encoded: entry.encodedBodySize, decoded: entry.decodedBodySize };
  }, path);
  const first = await read(firstPath); expect(first.status).toBe(200); expect(first.encoding).toBe("gzip");
  expect(first.text).toContain("设备 A"); expect(first.transfer).toBeGreaterThan(0); expect(first.encoded).toBeLessThan(first.decoded / 10);
  const cached = await read(firstPath); expect(cached.status).toBe(200); expect(cached.text).toBe(first.text); expect(cached.transfer).toBe(0);
  const other = await read(secondPath); expect(other.status).toBe(200); expect(other.text).toContain("设备 B"); expect(other.transfer).toBeGreaterThan(0);
  const logout = await page.request.post("/_hub/logout", { headers: { Origin: new URL(page.url()).origin }, data: {} }); expect(logout.status()).toBe(200);
  const afterLogout = await read(firstPath); expect(afterLogout.status).toBe(401); expect(afterLogout.transfer).toBeGreaterThan(0);
});
