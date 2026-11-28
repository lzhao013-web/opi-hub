import { test } from "node:test";
import assert from "node:assert/strict";
import { applyDirectory, decodeDialog, decodeEvent, decodeFrame } from "../src/adapters/opi/wire.ts";

test("o-pi 目录增量复用旧区间并插入新记录，缺少基线或越界时报告协议错误", () => {
  const before = ["a", "b", "c"].map((path) => ({ path, cwd: "/project", title: path, modified: "2026-11-07" }));
  const first = before[0]; assert.ok(first);
  assert.deepEqual(applyDirectory(before, [{ from: 1, count: 2 }, { values: [first] }]).map((item) => item.path), ["b", "c", "a"]);
  assert.throws(() => applyDirectory(undefined, []), /初始/);
  assert.throws(() => applyDirectory(before, [{ from: 2, count: 2 }]), /越界/);
  assert.throws(() => decodeEvent({ type: "sessionsPatch", value: [{ from: -1, count: 1 }] }), /不匹配/);
});
test("识别源码和现有二进制的帧封装，未知封装明确报错", () => {
  const frame = { id: 1, events: [{ type: "client", id: "client" }] };
  assert.deepEqual(decodeFrame(frame), { ...frame, ack: { ack: 1 }, catalog: { action: "sessions" } });
  assert.deepEqual(decodeFrame({ ...frame, kind: "frame" }), { ...frame, ack: { kind: "ack", id: 1 }, catalog: { action: "sessions", all: true } });
  assert.throws(() => decodeFrame({ ...frame, kind: "unknown" }), /不匹配/);
});
test("兼容旧版分阶段 Bash，sudo 私有阶段不公开令牌或账号", () => {
  const options = [{ label: "允许一次", value: "Allow once" }, { label: "拒绝并说明", value: "Deny with instruction" }];
  const base = { id: "same", deadline: null, title: "审批", options };
  const bash = { ...base, kind: "bashApproval", approval: { cwd: "/demo", command: "echo test", items: [], environment: [] } };
  const choose = { kind: "choose" };
  assert.deepEqual(decodeDialog({ ...base, kind: "toolApproval", stage: choose }, "s"), { ...base, kind: "tool", sessionId: "s", stage: choose });
  assert.deepEqual(decodeDialog({ ...bash, stage: choose }, "s"), decodeDialog(bash, "s"));
  for (const kind of ["instruction", "waiting", "prompting", "submitted"]) {
    const dialog = decodeDialog({ ...bash, stage: { kind, token: "private-token", account: "private-account" } }, "s");
    assert.equal(dialog.kind, "nativeApproval"); assert.doesNotMatch(JSON.stringify(dialog), /private-|options/);
  }
  const sudo = { ...bash, approval: { ...bash.approval, command: "/usr/bin/sudo example" } };
  assert.equal(decodeDialog({ ...sudo, stage: choose }, "s").kind, "nativeApproval");
  assert.equal(decodeDialog(sudo, "s").kind, "command");
  assert.equal(decodeDialog({ ...sudo, kind: "shellApproval", stage: choose, approval: { ...sudo.approval, shell: "bash" } }, "s").kind, "nativeApproval");
  assert.throws(() => decodeDialog({ ...bash, stage: { kind: "unknown" } }, "s"), /阶段/);
});
test("只读取管理事件，未知交互不被猜测为审批", () => {
  assert.equal(decodeEvent({ type: "snapshot", value: { body: "不保存聊天正文" } }), undefined);
  assert.throws(() => decodeDialog({ id: "x", title: "未知", kind: "future", deadline: null }, "session"), /不匹配/);
  assert.deepEqual(decodeDialog({ id: "x", title: "确认", kind: "confirm", message: "原文", deadline: null }, "session"), { id: "x", title: "确认", kind: "confirm", message: "原文", deadline: null, sessionId: "session" });
});
