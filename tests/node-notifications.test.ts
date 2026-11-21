import { test } from "node:test";
import assert from "node:assert/strict";
import { validateNodeConfig } from "../src/node/config.ts";
import { LocalNotifications } from "../src/node/notifications.ts";
import { notificationCommand, type NotificationSender } from "../src/node/system-notifications.ts";
import { isNodeCompletionNotice, isNodeNotificationMessage, type NodeCompletionNotice } from "../src/shared/notifications.ts";
import { setTimeout as delay } from "node:timers/promises";

const notice = (id = "one"): NodeCompletionNotice => ({ id, deviceId: "00000000-0000-0000-0000-000000000001", deviceName: "测试设备", title: "测试完成", completedAt: "2026-11-14T10:00:00.000Z" });
const config = { hub: "http://127.0.0.1:19200", token: `00000000-0000-0000-0000-000000000001.${"A".repeat(43)}`, command: ["opi-web"] };
test("节点通知默认开启，显式 false 才关闭，只接受本机布尔开关", () => {
  assert.equal(validateNodeConfig(config).notifications, true);
  assert.equal(validateNodeConfig({ ...config, notifications: undefined }).notifications, true);
  assert.equal(validateNodeConfig({ ...config, notifications: true }).notifications, true);
  assert.equal(validateNodeConfig({ ...config, notifications: false }).notifications, false);
  assert.throws(() => validateNodeConfig({ ...config, notifications: null }), /notifications/);
  assert.throws(() => validateNodeConfig({ ...config, notifications: "true" }), /notifications/);
  assert.throws(() => validateNodeConfig({ ...config, notifications: { command: ["unsafe"] } }), /notifications/);
});
test("节点通知协议只接收有界摘要，不允许正文和自定义命令混入", () => {
  assert.ok(isNodeCompletionNotice(notice()));
  assert.ok(isNodeNotificationMessage({ type: "completionNotification", notice: notice() }));
  assert.ok(!isNodeCompletionNotice({ ...notice(), body: "聊天正文" }));
  assert.ok(!isNodeCompletionNotice({ ...notice(), command: "unsafe" }));
  assert.ok(!isNodeCompletionNotice({ ...notice(), title: "x".repeat(513) }));
  assert.ok(!isNodeCompletionNotice({ ...notice(), completedAt: "invalid" }));
  assert.ok(!isNodeNotificationMessage({ type: "notificationSubscription", active: "yes" }));
});
test("系统通知数据不进入脚本，Linux 转义标记，后台无桌面时不启用", () => {
  const value = { ...notice(), title: `'; $(touch /tmp/unsafe); <b>&\"中文😀` };
  const linux = notificationCommand("linux", { DISPLAY: ":1", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1/bus" }, value);
  assert.equal(linux?.program, "notify-send"); assert.ok(linux?.args.includes("--"));
  assert.ok(linux?.args.at(-1)?.includes("&lt;b&gt;&amp;"));
  const mac = notificationCommand("darwin", {}, value); assert.ok(mac);
  assert.ok(!mac.args[1]?.includes(value.title)); assert.ok(mac.args.includes(value.deviceName + " · " + value.title));
  const windows = notificationCommand("win32", { SESSIONNAME: "Console" }, value); assert.ok(windows);
  assert.ok(!windows.args.join(" ").includes(value.title));
  assert.deepEqual(JSON.parse(windows.input ?? ""), { title: "o-pi 执行已完成", body: value.deviceName + " · " + value.title });
  assert.equal(notificationCommand("linux", {}, value), null);
  assert.equal(notificationCommand("win32", { SESSIONNAME: "Services" }, value), null);
  assert.equal(notificationCommand("freebsd", {}, value), null);
  const android = notificationCommand("linux", { TERMUX_VERSION: "test" }, value);
  assert.equal(android?.program, "termux-notification"); assert.ok(android?.args.includes(value.deviceName + " · " + value.title));
});
test("本机通知关闭时不初始化工具，重复事件和失败不重复发送", async () => {
  let called = 0; const logs: string[] = [];
  const disabled = new LocalNotifications(false, (line) => logs.push(line), async () => { called++; return async () => {}; });
  await disabled.receive(notice()); assert.equal(called, 0); disabled.close();
  const unavailable = new LocalNotifications(true, (line) => logs.push(line), async () => null);
  assert.equal(await unavailable.ready, false); await unavailable.receive(notice()); unavailable.close();
  const local = new LocalNotifications(true, (line) => logs.push(line), async () => async () => { called++; throw new Error("失败"); });
  await local.receive(notice()); await local.receive(notice()); assert.equal(called, 1);
  assert.ok(logs.some((line) => line.includes("未自动重试")));
  local.close(); await local.receive(notice("late")); assert.equal(called, 1);
});
test("Linux 等待审批按钮时不阻塞其他审批或完成通知，断线取消等待", { timeout: 5000 }, async () => {
  const printed: string[] = [];
  const local = new LocalNotifications(true, () => {}, async () => async (value) => { printed.push(value.id); });
  const connection = new AbortController();
  const started = Promise.withResolvers<AbortSignal>();
  try {
    const first = local.receiveLinuxApproval({ id: "first", title: "审批", body: "echo first" }, async (_notice, signal) => {
      started.resolve(signal);
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      return undefined;
    }, connection.signal);
    const wait = await started.promise;
    await local.receive(notice("completed"));
    const second = await local.receiveLinuxApproval({ id: "second", title: "审批", body: "echo second" }, async () => "deny", connection.signal);
    assert.equal(second, "deny");
    assert.deepEqual(printed, ["completed"]);
    assert.equal(wait.aborted, false);
    connection.abort();
    assert.equal(await first, undefined);
    assert.equal(wait.aborted, true);
  } finally { connection.abort(); local.close(); }
});

test("完成通知等待点击不阻塞后续提醒，等待额度用完时仍会弹普通通知", { timeout: 5000 }, async () => {
  const waiting: string[] = []; const plain: string[] = [];
  const start = Promise.withResolvers<void>();
  const send: NotificationSender = async (item) => { plain.push(item.id); };
  send.waitForCompletionClick = async (item, signal, url) => {
    assert.match(url, /#completion=/);
    waiting.push(item.id);
    if (waiting.length === 8) start.resolve();
    await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
  };
  const local = new LocalNotifications(true, () => {}, async () => send);
  try {
    const jobs = Array.from({ length: 8 }, (_, index) => local.receive(notice(String(index)), `https://hub.example/#completion=${index}`));
    await start.promise;
    await local.receive(notice("overflow"), "https://hub.example/#completion=overflow");
    assert.deepEqual(plain, ["overflow"]);
    assert.equal(waiting.length, 8);
    local.close();
    await Promise.all(jobs);
  } finally { local.close(); }
});

test("本机通知队列有界且串行，关闭会取消尚未发送的弹窗", async () => {
  const started = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>(); const sent: string[] = []; const logs: string[] = [];
  const local = new LocalNotifications(true, (line) => logs.push(line), async () => async (value, signal) => {
    assert.equal(signal.aborted, false); sent.push(value.id); started.resolve(); await release.promise;
  });
  const jobs = Array.from({ length: 40 }, (_, index) => local.receive(notice(String(index))));
  await started.promise; await delay(0); assert.equal(sent.length, 1);
  assert.equal(logs.filter((line) => line.includes("队列已满")).length, 8);
  local.close(); release.resolve(); await Promise.all(jobs); assert.equal(sent.length, 1);
});
