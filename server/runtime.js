import { createPostgresPool } from "./postgres-hand-store.js";
import { PostgresTableEventStore } from "./postgres-table-store.js";
import { attachRealtimeServer } from "./realtime.js";
import { RedisTableEventBus } from "./redis-event-bus.js";
import {
  RedisChallengeStore,
  RedisRateLimiter,
  RedisSessionStore,
  createRedisConnection,
} from "./redis-stores.js";
import { AuthoritativeTableCoordinator } from "./table-coordinator.js";
import { createTimeoutWorker } from "./timeout-worker.js";

function logError(logger, event, error, context = {}) {
  logger.error(JSON.stringify({
    level: "error",
    event,
    error: error instanceof Error ? error.message : String(error),
    ...context,
  }));
}

async function within(milliseconds, operation, label) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function createAuthoritativeRuntime({
  config,
  pool: suppliedPool,
  redis: suppliedRedis,
  redisSubscriber: suppliedSubscriber,
  getHoleCards,
  logger = console,
} = {}) {
  if (!config?.databaseUrl || !config?.redisUrl) {
    throw new Error("Authoritative runtime requires both DATABASE_URL and REDIS_URL");
  }
  const pool = suppliedPool ?? await createPostgresPool({ connectionString: config.databaseUrl });
  const redis = suppliedRedis ?? await createRedisConnection(config.redisUrl);
  let redisSubscriber = suppliedSubscriber;
  let realtime;
  let attached = false;
  let closed = false;

  try {
    await pool.query("SELECT 1");
    const schema = await pool.query("SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1");
    if (schema.rows[0]?.name !== "003_realtime_tables.sql") {
      throw new Error("Database schema is not current; run npm run migrate");
    }
    if (!redis.isOpen) await redis.connect();
    redisSubscriber ??= redis.duplicate();
    const tableStore = new PostgresTableEventStore({ pool });
    const eventBus = new RedisTableEventBus({ publisher: redis, subscriber: redisSubscriber });
    const tableCoordinator = new AuthoritativeTableCoordinator({
      store: tableStore,
      onEvent: (event) => eventBus.publish(event),
      onEventError: (error, event) => logError(logger, "table_event_fanout_failed", error, {
        tableId: event.tableId,
        sequence: event.sequence,
      }),
    });
    const timeoutWorker = createTimeoutWorker({
      store: tableStore,
      coordinator: tableCoordinator,
      onError: (error, lease) => logError(logger, "table_timeout_failed", error, {
        tableId: lease?.tableId,
        bettingVersion: lease?.bettingVersion,
      }),
    });
    const auth = Object.freeze({
      challengeStore: new RedisChallengeStore(redis),
      rateLimiter: new RedisRateLimiter(redis),
      sessionStore: new RedisSessionStore(redis),
    });

    async function health() {
      await within(2_000, Promise.all([
        pool.query("SELECT 1"),
        redis.ping(),
      ]), "Authoritative dependency health check");
      return true;
    }

    async function attach(server) {
      if (attached) throw new Error("Authoritative runtime is already attached");
      if (closed) throw new Error("Authoritative runtime is closed");
      realtime = attachRealtimeServer({
        server,
        sessionStore: auth.sessionStore,
        tableCoordinator,
        allowedOrigins: config.allowedOrigins,
        subscribeToCoordinator: false,
        getHoleCards,
      });
      await eventBus.start((event) => realtime.publish(event));
      timeoutWorker.start();
      attached = true;
      return realtime;
    }

    async function close() {
      if (closed) return;
      closed = true;
      await timeoutWorker.stop();
      if (realtime) await realtime.close();
      await eventBus.close();
      if (!suppliedRedis && redis.isOpen) await redis.quit();
      if (!suppliedPool) await pool.end();
    }

    return Object.freeze({
      auth,
      tableStore,
      tableCoordinator,
      timeoutWorker,
      eventBus,
      health,
      attach,
      close,
    });
  } catch (error) {
    if (!suppliedSubscriber && redisSubscriber?.isOpen) await redisSubscriber.quit().catch(() => {});
    if (!suppliedRedis && redis.isOpen) await redis.quit().catch(() => {});
    if (!suppliedPool) await pool.end().catch(() => {});
    throw error;
  }
}
