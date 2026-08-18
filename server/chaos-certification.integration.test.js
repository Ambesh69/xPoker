import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createConnection, createServer as createTcpServer } from "node:net";
import test from "node:test";

import { WebSocket } from "ws";

import { createApiServer } from "./http.js";
import { applyMigrations } from "./migrate.js";
import { createPostgresPool } from "./postgres-hand-store.js";
import { PostgresTableEventStore } from "./postgres-table-store.js";
import { attachRealtimeServer, REALTIME_PROTOCOL } from "./realtime.js";
import { RedisSessionStore } from "./redis-stores.js";
import { AuthoritativeTableCoordinator } from "./table-coordinator.js";
import { encodeBase58 } from "./wallet-auth.js";

const connectionString = process.env.DATABASE_URL_TEST;
const redisUrl = process.env.REDIS_URL_TEST;
const ORIGIN = "https://chaos.xpoker.test";

function wallet(label) {
  return encodeBase58(createHash("sha256").update(label).digest());
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitUntil(predicate, { timeoutMs = 8_000, intervalMs = 25, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

class TcpFaultProxy {
  constructor(targetUrl) {
    this.target = new URL(targetUrl);
    this.targetPort = Number(this.target.port || (this.target.protocol === "redis:" ? 6379 : 5432));
    this.latencyMs = 0;
    this.outage = false;
    this.sockets = new Set();
    this.server = undefined;
    this.port = undefined;
  }

  async start() {
    this.server = createTcpServer((client) => {
      if (this.outage) {
        client.destroy();
        return;
      }
      const upstream = createConnection({ host: this.target.hostname, port: this.targetPort });
      client.setNoDelay(true);
      upstream.setNoDelay(true);
      const pair = [client, upstream];
      for (const socket of pair) {
        this.sockets.add(socket);
        socket.on("error", () => {});
        socket.on("close", () => {
          this.sockets.delete(client);
          this.sockets.delete(upstream);
          for (const peer of pair) {
            if (!peer.destroyed) peer.destroy();
          }
        });
      }
      const forward = (source, destination) => {
        source.on("data", (chunk) => {
          const write = () => {
            if (!this.outage && !destination.destroyed) destination.write(chunk);
          };
          if (this.latencyMs > 0) setTimeout(write, this.latencyMs);
          else write();
        });
        source.on("end", () => destination.end());
      };
      forward(client, upstream);
      forward(upstream, client);
    });
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", resolve);
    });
    this.port = this.server.address().port;
    return this;
  }

  url() {
    const proxied = new URL(this.target);
    proxied.hostname = "127.0.0.1";
    proxied.port = String(this.port);
    return proxied.toString();
  }

  setLatency(milliseconds) {
    assert.ok(Number.isInteger(milliseconds) && milliseconds >= 0 && milliseconds <= 10_000);
    this.latencyMs = milliseconds;
  }

  setOutage(value) {
    this.outage = Boolean(value);
    if (this.outage) {
      for (const socket of [...this.sockets]) socket.destroy();
    }
  }

  async close() {
    this.setOutage(true);
    if (!this.server) return;
    await new Promise((resolve, reject) => this.server.close((error) => (error ? reject(error) : resolve())));
  }
}

class RealtimeProbe {
  constructor(socket) {
    this.socket = socket;
    this.messages = [];
    this.waiters = [];
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString("utf8"));
      const index = this.waiters.findIndex((entry) => entry.predicate(message));
      if (index === -1) this.messages.push(message);
      else {
        const [entry] = this.waiters.splice(index, 1);
        clearTimeout(entry.timer);
        entry.resolve(message);
      }
    });
  }

  waitFor(predicate, timeoutMs = 5_000) {
    const index = this.messages.findIndex(predicate);
    if (index !== -1) return Promise.resolve(this.messages.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const entry = { predicate, resolve, timer: undefined };
      entry.timer = setTimeout(() => {
        const waiterIndex = this.waiters.indexOf(entry);
        if (waiterIndex !== -1) this.waiters.splice(waiterIndex, 1);
        reject(new Error("Timed out waiting for replica realtime response"));
      }, timeoutMs);
      this.waiters.push(entry);
    });
  }

  send(message) {
    this.socket.send(JSON.stringify(message));
  }

  async close() {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    const closed = once(this.socket, "close");
    this.socket.close();
    await closed;
  }
}

async function connectProbe(url, token) {
  const socket = new WebSocket(url, REALTIME_PROTOCOL, { origin: ORIGIN });
  const probe = new RealtimeProbe(socket);
  await Promise.race([
    once(socket, "open"),
    once(socket, "error").then(([error]) => Promise.reject(error)),
  ]);
  await probe.waitFor((message) => message.type === "hello");
  probe.send({ type: "authenticate", requestId: "replica-auth-01", token });
  await probe.waitFor((message) => message.type === "authenticated");
  return probe;
}

function tableRules() {
  return {
    game: "NLH",
    seats: 2,
    smallBlindAtomic: "10",
    bigBlindAtomic: "20",
    anteAtomic: "0",
    minimumBuyInAtomic: "2000",
    maximumBuyInAtomic: "10000",
    rakeBps: 500,
    rakeCapAtomic: "300",
    actionClockMs: 5_000,
    timeBankMs: 0,
    roeHandsPerGame: 1,
  };
}

test("TCP fault injection covers Redis interruption, database latency, pool pressure, and API replica replacement", {
  skip: !connectionString || !redisUrl,
  timeout: 90_000,
}, async (context) => {
  const { createClient } = await import("redis");
  const runId = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const postgresProxy = await new TcpFaultProxy(connectionString).start();
  const redisProxy = await new TcpFaultProxy(redisUrl).start();
  const controlPool = await createPostgresPool({ connectionString, max: 8 });
  await applyMigrations({ pool: controlPool });

  const redis = createClient({
    url: redisProxy.url(),
    disableOfflineQueue: true,
    socket: {
      connectTimeout: 2_000,
      reconnectStrategy: (retries) => Math.min(25 * 2 ** retries, 500),
    },
  });
  redis.on("error", () => {});
  const replicas = [];
  const probes = [];
  context.after(async () => {
    for (const probe of probes) await probe.close().catch(() => {});
    for (const replica of replicas.reverse()) await replica.close().catch(() => {});
    if (redis.isOpen) await redis.quit().catch(() => redis.disconnect());
    await controlPool.end();
    await postgresProxy.close();
    await redisProxy.close();
  });
  await redis.connect();
  const sessions = new RedisSessionStore(redis, { prefix: `test:chaos:session:${runId}:` });
  const player = wallet(`chaos-player:${runId}`);
  const session = await sessions.issue({ wallet: player, ttlSeconds: 600 });

  const roomId = randomUUID();
  const tableId = randomUUID();
  const assetMint = wallet(`chaos-asset:${runId}`);
  const allowlistVersion = `chaos-${createHash("sha256").update(runId).digest("hex").slice(0, 12)}`;
  const roomRules = { name: "Chaos certification", description: "Fault-injection table", tableRules: tableRules() };
  await controlPool.query(
    `INSERT INTO asset_allowlist (
       mint_address, chain_id, token_program, symbol, decimals,
       multiplier_source, price_source, version, enabled, metadata
     ) VALUES ($1, 'solana:mainnet', 'spl-token-2022', 'CHAOSx', 2,
               'certification', 'certification', $2, false, $3)`,
    [assetMint, allowlistVersion, { zeroValue: true, runId }],
  );
  await controlPool.query(
    `INSERT INTO rooms (id, visibility, status, rules, rules_hash)
     VALUES ($1, 'private', 'open', $2, $3)`,
    [roomId, roomRules, createHash("sha256").update(JSON.stringify(roomRules)).digest()],
  );
  await controlPool.query(
    `INSERT INTO table_sessions (
       id, room_id, asset_mint, asset_allowlist_version, token_program, status
     ) VALUES ($1, $2, $3, $4, 'spl-token-2022', 'preview')`,
    [tableId, roomId, assetMint, allowlistVersion],
  );

  const fanoutErrors = [];
  const store = new PostgresTableEventStore({ pool: controlPool, snapshotEvery: 2 });
  const coordinator = new AuthoritativeTableCoordinator({
    store,
    onEvent: (event) => redis.publish(`test:chaos:event:${tableId}`, JSON.stringify(event)),
    onEventError: (error, event) => fanoutErrors.push({ error, event }),
  });

  redisProxy.setOutage(true);
  await waitUntil(() => !redis.isReady, { label: "Redis client outage" });
  await assert.rejects(sessions.authenticate(session.token));
  const committed = await coordinator.createTable({
    tableId,
    roomId,
    assetMint,
    allowlistVersion,
    rules: tableRules(),
    idempotencyKey: `chaos-create-${runId}`,
  });
  assert.equal(committed.duplicate, false);
  assert.equal(fanoutErrors.length, 1);
  assert.equal(fanoutErrors[0].event.type, "TABLE_CREATED");
  assert.equal((await new AuthoritativeTableCoordinator({ store }).state(tableId)).version, 1);

  redisProxy.setOutage(false);
  await waitUntil(() => redis.isReady, { label: "Redis client recovery" });
  assert.equal((await sessions.authenticate(session.token)).wallet, player);
  await coordinator.seatPlayer({
    tableId,
    playerId: player,
    seat: 0,
    buyInAtomic: "2000",
    expectedVersion: 1,
    idempotencyKey: `chaos-seat-${runId}`,
  });
  assert.equal(await redis.ping(), "PONG");

  const latencyPool = await createPostgresPool({ connectionString: postgresProxy.url(), max: 2 });
  await Promise.all([latencyPool.query("SELECT 1"), latencyPool.query("SELECT 1")]);
  postgresProxy.setLatency(125);
  const timings = [];
  const startedAt = performance.now();
  const delayedQueries = Array.from({ length: 10 }, async () => {
    const queryStartedAt = performance.now();
    const result = await latencyPool.query("SELECT 1 AS healthy");
    timings.push(performance.now() - queryStartedAt);
    assert.equal(result.rows[0].healthy, 1);
  });
  await delay(25);
  assert.ok(latencyPool.waitingCount >= 6, `Expected pool pressure, observed ${latencyPool.waitingCount} waiting queries`);
  await Promise.all(delayedQueries);
  const elapsedMs = performance.now() - startedAt;
  timings.sort((left, right) => left - right);
  const p95Ms = timings[Math.ceil(timings.length * 0.95) - 1];
  assert.ok(elapsedMs >= 500, `Injected database latency was not observable (${elapsedMs}ms)`);
  assert.ok(p95Ms >= 200, `Database p95 did not reflect the injected latency (${p95Ms}ms)`);
  assert.ok(p95Ms < 5_000, `Database p95 exceeded the application query timeout (${p95Ms}ms)`);
  postgresProxy.setLatency(0);
  const recoveryStartedAt = performance.now();
  assert.equal((await latencyPool.query("SELECT 1 AS healthy")).rows[0].healthy, 1);
  assert.ok(performance.now() - recoveryStartedAt < 2_000);
  await latencyPool.end();

  async function startReplica(label) {
    const replicaCoordinator = new AuthoritativeTableCoordinator({
      store: new PostgresTableEventStore({ pool: controlPool, snapshotEvery: 2 }),
    });
    const server = await createApiServer({
      config: {
        realValueMode: false,
        safeBetaMode: true,
        allowedOrigins: [ORIGIN],
        publicOrigin: ORIGIN,
        bodyLimitBytes: 16_384,
      },
      auth: { sessionStore: sessions },
      healthCheck: async () => true,
    });
    const realtime = attachRealtimeServer({
      server,
      sessionStore: sessions,
      tableCoordinator: replicaCoordinator,
      allowedOrigins: [ORIGIN],
      heartbeatMs: 60_000,
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const replica = {
      label,
      coordinator: replicaCoordinator,
      url: `ws://127.0.0.1:${server.address().port}/v1/realtime`,
      async close() {
        await realtime.close();
        await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      },
    };
    replicas.push(replica);
    return replica;
  }

  const replicaA = await startReplica("replica-a");
  const probeA = await connectProbe(replicaA.url, session.token);
  probes.push(probeA);
  probeA.send({ type: "subscribe", requestId: "replica-sub-a1", tableId, afterVersion: 0 });
  const firstSnapshot = await probeA.waitFor(
    (message) => message.type === "table_snapshot" && message.requestId === "replica-sub-a1",
  );
  assert.equal(firstSnapshot.state.version, 2);
  assert.equal(firstSnapshot.state.seats[0].playerId, player);
  await replicaA.close();
  replicas.splice(replicas.indexOf(replicaA), 1);
  await waitUntil(() => probeA.socket.readyState === WebSocket.CLOSED, { label: "replica A socket closure" });
  probes.splice(probes.indexOf(probeA), 1);

  const replicaB = await startReplica("replica-b");
  const probeB = await connectProbe(replicaB.url, session.token);
  probes.push(probeB);
  probeB.send({ type: "subscribe", requestId: "replica-sub-b1", tableId, afterVersion: 1 });
  const recovered = await probeB.waitFor(
    (message) => message.type === "table_snapshot" && message.requestId === "replica-sub-b1",
  );
  assert.equal(recovered.state.version, 2);
  assert.deepEqual(recovered.events.map((event) => event.sequence), [2]);
  probeB.send({
    type: "command",
    command: "sit_out",
    requestId: "replica-command-01",
    tableId,
    expectedVersion: 2,
    idempotencyKey: `replica-sit-out-${runId}`,
  });
  const command = await probeB.waitFor(
    (message) => message.type === "command_result" && message.requestId === "replica-command-01",
  );
  assert.equal(command.version, 3);
  assert.equal(command.state.seats[0].status, "SITTING_OUT");
  const finalState = await replicaB.coordinator.state(tableId);
  assert.equal(finalState.version, 3);
  assert.equal(finalState.seats[0].status, "SITTING_OUT");

  context.diagnostic(JSON.stringify({
    certification: "network-chaos",
    redisRecovered: true,
    durableDuringRedisOutage: true,
    databaseLatencyMs: 125,
    databaseP95Ms: Math.round(p95Ms),
    databasePoolMax: 2,
    databasePeakWaiting: 8,
    replicaRestartRecoveredVersion: finalState.version,
  }));
});
