import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../src/hub/store.ts";

test("并发注册不丢失设备，重启后凭据有效，持久化不保存明文密码或令牌", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "opi-hub-store-"));
  try {
    const password = "a-long-test-password";
    await Store.init(directory, password);
    await assert.rejects(Store.init(directory, password), /EEXIST/);
    const store = await Store.open(directory);
    assert.equal(await store.verifyPassword(password), true);
    assert.equal(await store.verifyPassword("wrong-password"), false);
    const created = await Promise.all(Array.from({ length: 6 }, (_, index) => store.add(`设备 ${index}`)));
    const reopened = await Store.open(directory);
    assert.equal(reopened.list().length, 6);
    const saved = await readFile(path.join(directory, "hub.json"), "utf8");
    assert.ok(!saved.includes(password));
    for (const item of created) {
      assert.ok(!saved.includes(item.token.split(".")[1] ?? item.token));
      assert.equal(reopened.authenticate(item.token)?.id, item.device.id);
      assert.equal(reopened.authenticate(item.token + "invalid"), undefined);
    }
    const first = created[0]; assert.ok(first);
    await reopened.remove(first.device.id);
    assert.equal((await Store.open(directory)).authenticate(first.token), undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("通知授权按浏览器唯一绑定，重启后保留，撤销和不存在设备不误改其他绑定", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "opi-hub-receivers-"));
  try {
    await Store.init(directory, "a-long-test-password"); const store = await Store.open(directory);
    const a = await store.add("甲"); const b = await store.add("乙"); const destination = crypto.randomUUID(); const other = crypto.randomUUID();
    assert.equal(await store.bindNotifications(a.device.id, destination), true);
    assert.equal((await Store.open(directory)).get(a.device.id)?.notificationDestination, destination);
    assert.equal(await store.bindNotifications(b.device.id, destination), true);
    assert.equal(store.get(a.device.id)?.notificationDestination, undefined); assert.equal(store.get(b.device.id)?.notificationDestination, destination);
    assert.equal(await store.bindNotifications(a.device.id, other), true);
    assert.equal(await store.bindNotifications(crypto.randomUUID(), destination), false);
    assert.equal(store.get(b.device.id)?.notificationDestination, destination);
    await assert.rejects(store.bindNotifications(a.device.id, "invalid"), /无效/);
    assert.equal(await store.bindNotifications(null, destination), true);
    assert.equal(store.get(b.device.id)?.notificationDestination, undefined); assert.equal(store.get(a.device.id)?.notificationDestination, other);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
