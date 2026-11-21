import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { add, fixture, managedConfig } from "./helpers.ts";
import { startNode } from "../src/node/agent.ts";
import { approvalClickUri, openWindowsApprovalClicks, prepareWindowsApprovalLauncher } from "../src/node/windows-approval-clicks.ts";
import { notificationCommand, type DesktopNotice } from "../src/node/system-notifications.ts";
import { object } from "../src/shared/protocol.ts";

async function waitFor(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (!await check()) {
    assert.ok(Date.now() < deadline, "等待审批状态超时");
    await delay(20);
  }
}

test("Windows 通知按钮回传仅本次允许和拒绝，旧按钮不处理新审批", { skip: process.platform !== "win32", timeout: 25_000 }, async () => {
  const env = await fixture();
  let clicks: Awaited<ReturnType<typeof openWindowsApprovalClicks>> | undefined;
  let agent: ReturnType<typeof startNode> | undefined;
  try {
    clicks = await openWindowsApprovalClicks();
    const receiver = await add(env.hub.url, env.cookie, "Windows 接收端");
    const notices: Extract<DesktopNotice, { receiverId: string }>[] = [];
    agent = startNode({ ...managedConfig(receiver.config, env.fakeB.url, env.directory), notifications: true }, () => {}, async () => async (notice) => {
      if ("receiverId" in notice && notice.detail?.deviceId === env.a.id && notice.detail.sessionId === "runtime-1") notices.push(notice);
    }, { kind: "windows", clicks });
    await agent.ready;
    const binding = await fetch(`${env.hub.url}/_hub/notifications/receiver`, {
      method: "POST", headers: { Cookie: env.cookie, Origin: env.hub.url, "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId: receiver.id, destination: crypto.randomUUID() }),
    });
    assert.equal(binding.status, 200);
    const overview = async () => {
      const value: unknown = await (await fetch(`${env.hub.url}/_hub/overview`, { headers: { Cookie: env.cookie } })).json();
      assert.ok(object(value) && Array.isArray(value.devices) && Array.isArray(value.interactions));
      const devices: unknown[] = value.devices;
      const interactions: unknown[] = value.interactions;
      return { devices, interactions };
    };
    await waitFor(async () => (await overview()).devices.some((item: unknown) => object(item) && item.id === receiver.id && item.notificationSubscribed));
    const command = (id: string) => ({
      id, kind: "bashApproval", title: "命令审批", deadline: null,
      approval: { command: `echo '${id} & <测试>'`, cwd: "C:\\项目", items: [{ action: "read", kind: "file", target: "a.txt", reason: "测试" }] },
      options: ["Allow once", "Always allow similar", "Deny", "Deny with instruction"].map((value) => ({ label: value, value })),
    });
    const launcher = await prepareWindowsApprovalLauncher(path.join(env.directory, "desktop-notifications"));
    const binary = await readFile(launcher);
    const pe = binary.readUInt32LE(0x3c);
    assert.equal(binary.toString("ascii", pe, pe + 4), "PE\0\0");
    assert.equal(binary.readUInt16LE(pe + 24 + 68), 2, "回调必须是 Windows GUI 子系统，不能由系统分配控制台");
    const click = (uri: string) => promisify(execFile)(launcher, [uri], { timeout: 5000 });
    const buttons = (index: number) => {
      const notice = notices[index];
      assert.ok(notice);
      const plan = notificationCommand("win32", { SESSIONNAME: "Console" }, notice);
      assert.ok(plan?.input);
      const data: unknown = JSON.parse(plan.input);
      assert.ok(object(data) && typeof data.body === "string" && Array.isArray(data.actions));
      assert.match(data.body, /C:\\项目/);
      assert.match(data.body, /read file a\.txt/);
      assert.match(data.body, /& <测试>/);
      return data.actions.map((action: unknown) => {
        assert.ok(object(action) && typeof action.label === "string" && typeof action.uri === "string");
        return { label: action.label, uri: action.uri };
      });
    };

    env.fakeA.setDialogs("runtime-1", [command("allow")]);
    await waitFor(() => notices.length === 1);
    const first = buttons(0);
    assert.deepEqual(first.map(({ label }) => label), ["仅本次允许", "拒绝", "查看审批"]);
    assert.equal(first[2]?.uri, `${env.hub.url}/#approval=allow&device=${env.a.id}&session=runtime-1`);
    assert.ok(first[0]);
    await click(first[0].uri);
    await waitFor(() => env.fakeA.answers.length === 1);
    assert.deepEqual(env.fakeA.answers[0], { sessionId: "runtime-1", dialogId: "allow", value: "Allow once" });

    env.fakeA.setDialogs("runtime-1", [command("expired"), command("cancel")]);
    await waitFor(() => notices.length === 3);
    const expired = notices.find((notice) => notice.body.includes("echo 'expired"));
    const active = notices.find((notice) => notice.body.includes("echo 'cancel"));
    assert.ok(expired && active);
    env.fakeA.setDialogs("runtime-1", [command("cancel")]);
    await waitFor(async () => !(await overview()).interactions.some((item: unknown) => object(item) && item.deviceId === env.a.id && item.id === "expired"));
    await click(approvalClickUri(expired.receiverId, expired.id, "allow"));
    await click(first[0].uri);
    const reject = buttons(notices.indexOf(active)).find(({ label }) => label === "拒绝");
    assert.ok(reject);
    await click(reject.uri);
    await waitFor(() => env.fakeA.answers.length >= 2);
    assert.deepEqual(env.fakeA.answers.slice(1), [{ sessionId: "runtime-1", dialogId: "cancel", value: "Deny" }]);
    assert.equal(env.fakeB.answers.length, 0);
  } finally {
    clicks?.close();
    await agent?.close();
    await env.close();
  }
});
