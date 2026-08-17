import assert from "node:assert/strict";
import test from "node:test";

import { RedisChallengeStore, RedisSessionStore } from "./redis-stores.js";

class FakeRedis {
  constructor() {
    this.values = new Map();
  }

  async set(key, value, options) {
    if (options?.NX && this.values.has(key)) return null;
    this.values.set(key, value);
    return "OK";
  }

  async getDel(key) {
    const value = this.values.get(key);
    this.values.delete(key);
    return value ?? null;
  }

  async get(key) {
    return this.values.get(key) ?? null;
  }

  async del(key) {
    return this.values.delete(key) ? 1 : 0;
  }
}

test("Redis challenge adapter atomically consumes one-time records", async () => {
  const store = new RedisChallengeStore(new FakeRedis());
  const record = { expiresAt: new Date(Date.now() + 60_000).toISOString(), wallet: "wallet-a" };
  await store.put("ab".repeat(32), record);
  assert.deepEqual(await store.consume("ab".repeat(32)), record);
  assert.equal(await store.consume("ab".repeat(32)), undefined);
});

test("Redis sessions store only a token hash and support revocation", async () => {
  const redis = new FakeRedis();
  const store = new RedisSessionStore(redis);
  const session = await store.issue({ wallet: "wallet-a", ttlSeconds: 60 });
  assert.equal((await store.authenticate(session.token)).wallet, "wallet-a");
  assert.equal([...redis.values.keys()].some((key) => key.includes(session.token)), false);
  assert.equal(await store.revoke(session.token), true);
  assert.equal(await store.authenticate(session.token), undefined);
});
