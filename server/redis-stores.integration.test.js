import assert from "node:assert/strict";
import test from "node:test";

import {
  RedisChallengeStore,
  RedisSessionStore,
  createRedisConnection,
} from "./redis-stores.js";

const url = process.env.REDIS_URL_TEST;

test("Redis production adapters preserve one-time challenge and session semantics", {
  skip: !url,
}, async () => {
  const redis = await createRedisConnection(url);
  await redis.connect();
  const suffix = `${process.pid}:${Date.now()}:`;
  const challenges = new RedisChallengeStore(redis, { prefix: `test:challenge:${suffix}` });
  const sessions = new RedisSessionStore(redis, { prefix: `test:session:${suffix}` });
  const idHash = "ab".repeat(32);
  await challenges.put(idHash, {
    wallet: "wallet-a",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  assert.equal((await challenges.consume(idHash)).wallet, "wallet-a");
  assert.equal(await challenges.consume(idHash), undefined);
  const session = await sessions.issue({ wallet: "wallet-a", ttlSeconds: 60 });
  assert.equal((await sessions.authenticate(session.token)).wallet, "wallet-a");
  assert.equal(await sessions.revoke(session.token), true);
  await redis.quit();
});
