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
