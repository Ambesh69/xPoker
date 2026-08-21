import { createPostgresPool } from "./postgres-hand-store.js";
import { PostgresTableEventStore } from "./postgres-table-store.js";
import { BetaOperationsService } from "./beta-operations.js";
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
import { SafeBetaService } from "./safe-beta-service.js";
import { createSafeBetaDealer } from "./safe-beta-dealer.js";
import { RuntimeMonitoring } from "./monitoring.js";

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

export async function recoverSafeBetaTables({ tableStore, tableCoordinator, dealer }) {
  if (!dealer || !tableStore?.listPreviewTableIds || !tableStore?.reconcileDeadline) return { recovered: 0 };
  const tableIds = await tableStore.listPreviewTableIds();
  let recovered = 0;
  for (const tableId of tableIds) {
    const state = await tableCoordinator.state(tableId);
    const betting = state.currentHand?.betting;
    const activeTurn = state.status === "HAND_ACTIVE" && betting?.status === "BETTING" && state.currentHand?.turn
      ? {
          handId: betting.handId,
          bettingVersion: betting.version,
          playerId: state.currentHand.turn.playerId,
          deadlineAt: state.currentHand.turn.deadlineAt,
        }
      : undefined;
    if (await tableStore.reconcileDeadline({ tableId, expectedVersion: state.version, turn: activeTurn })) {
      recovered += 1;
    }
    dealer.schedule(tableId);
  }
  return { recovered };
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
  let operations;
  let monitoring;
  let attached = false;
  let closed = false;

  try {
    await pool.query("SELECT 1");
    const schema = await pool.query("SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1");
    if (schema.rows[0]?.name !== "006_dealer_signing_keys.sql") {
      throw new Error("Database schema is not current; run npm run migrate");
    }
    if (!redis.isOpen) await redis.connect();
    redisSubscriber ??= redis.duplicate();
    operations = new BetaOperationsService({
      pool,
      redis,
      adminWallets: config.adminWallets,
      instanceId: config.instanceId,
      buildCommit: config.buildCommit,
      logger,
    });
    await operations.bootstrap();
    monitoring = new RuntimeMonitoring({ pool, redis, operations, config, logger });
    const operationalLogger = {
      log: logger.log?.bind(logger) ?? (() => {}),
      warn: logger.warn?.bind(logger) ?? (() => {}),
      error(value) {
        logger.error(value);
        let record = { event: "runtime_error", error: String(value) };
        try { record = JSON.parse(value); } catch {}
        monitoring.capture({
          category: record.event ?? "runtime_error",
          severity: record.level === "critical" ? "critical" : "error",
          message: record.error ?? record.message ?? String(value),
          context: record,
        }).catch(() => {});
      },
    };
    operations.logger = operationalLogger;
    const tableStore = new PostgresTableEventStore({ pool });
    const eventBus = new RedisTableEventBus({ publisher: redis, subscriber: redisSubscriber });
    const tableCoordinator = new AuthoritativeTableCoordinator({
      store: tableStore,
      onEvent: (event) => eventBus.publish(event),
      onEventError: (error, event) => logError(operationalLogger, "table_event_fanout_failed", error, {
        tableId: event.tableId,
        sequence: event.sequence,
      }),
    });
    const timeoutWorker = createTimeoutWorker({
      store: tableStore,
      coordinator: tableCoordinator,
      onError: (error, lease) => logError(operationalLogger, "table_timeout_failed", error, {
        tableId: lease?.tableId,
        bettingVersion: lease?.bettingVersion,
      }),
      onResult: monitoring.recordTimeout,
    });
    const auth = Object.freeze({
      challengeStore: new RedisChallengeStore(redis),
      rateLimiter: new RedisRateLimiter(redis),
      sessionStore: new RedisSessionStore(redis),
    });
    const safeBetaDealer = config.safeBetaMode ? await createSafeBetaDealer({
      pool,
      redis,
      tableCoordinator,
      signingKeyPem: config.safeBetaSigningKeyPem,
      signerUrl: config.dealerSignerUrl,
      signerToken: config.dealerSignerToken,
      nodeEnv: config.nodeEnv,
      logger: operationalLogger,
    }) : undefined;
    const unsubscribeSafeBetaDealer = safeBetaDealer
      ? tableCoordinator.subscribe(safeBetaDealer.onTableEvent)
      : undefined;
    const safeBeta = config.safeBetaMode ? new SafeBetaService({
      pool,
      sessionStore: auth.sessionStore,
      tableCoordinator,
      dealer: safeBetaDealer,
      operations,
      inviteRequired: config.betaInviteRequired,
    }) : undefined;
    if (safeBeta) await safeBeta.bootstrap();
    await recoverSafeBetaTables({ tableStore, tableCoordinator, dealer: safeBetaDealer });

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
        getHoleCards: getHoleCards ?? safeBetaDealer?.getHoleCards,
        onTelemetry: monitoring.recordRealtime,
      });
      await eventBus.start((event) => realtime.publish(event));
      await operations.start();
      await monitoring.start();
      timeoutWorker.start();
      attached = true;
      return realtime;
    }

    async function close() {
      if (closed) return;
      closed = true;
      unsubscribeSafeBetaDealer?.();
      await safeBetaDealer?.close();
      await timeoutWorker.stop();
      if (realtime) await realtime.close();
      await eventBus.close();
      await monitoring?.close();
      await operations?.close();
      if (!suppliedRedis && redis.isOpen) await redis.quit();
      if (!suppliedPool) await pool.end();
    }

    return Object.freeze({
      auth,
      operations,
      monitoring,
      safeBeta,
      safeBetaDealer,
      tableStore,
      tableCoordinator,
      timeoutWorker,
      eventBus,
      health,
      attach,
      close,
    });
  } catch (error) {
    await monitoring?.close().catch(() => {});
    await operations?.close().catch(() => {});
    if (!suppliedSubscriber && redisSubscriber?.isOpen) await redisSubscriber.quit().catch(() => {});
    if (!suppliedRedis && redis.isOpen) await redis.quit().catch(() => {});
    if (!suppliedPool) await pool.end().catch(() => {});
    throw error;
  }
}
