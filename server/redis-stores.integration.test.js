import assert from "node:assert/strict";
import test from "node:test";

import { RedisTableEventBus } from "./redis-event-bus.js";
import {
  RedisChallengeStore,
  RedisRateLimiter,
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
  const limiter = new RedisRateLimiter(redis, { prefix: `test:rate:${suffix}` });
  assert.equal((await limiter.consume("wallet-a", { limit: 1, windowMs: 60_000 })).allowed, true);
  assert.equal((await limiter.consume("wallet-a", { limit: 1, windowMs: 60_000 })).allowed, false);
  const subscriber = redis.duplicate();
  const bus = new RedisTableEventBus({
    publisher: redis,
    subscriber,
    prefix: `test:table-events:${suffix}`,
  });
  let receive;
  const received = new Promise((resolve) => { receive = resolve; });
  await bus.start(receive);
  const event = {
    tableId: "018f47a6-7b9d-7cc3-8a23-60bfc31e3f45",
    sequence: 1,
    eventHash: "ab".repeat(32),
  };
  await bus.publish(event);
  let timer;
  try {
    assert.deepEqual(await Promise.race([
      received,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Redis fanout timed out")), 2_000); }),
    ]), event);
  } finally {
    clearTimeout(timer);
  }
  await bus.close();
  await redis.quit();
});
