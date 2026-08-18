import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";

import { applyMigrations } from "./migrate.js";
import { createPostgresPool } from "./postgres-hand-store.js";
import { PostgresTableEventStore } from "./postgres-table-store.js";
import { RedisTableEventBus } from "./redis-event-bus.js";
import { createRedisConnection } from "./redis-stores.js";
import {
  AuthoritativeTableCoordinator,
  verifyTableEventChain,
} from "./table-coordinator.js";
import { encodeBase58 } from "./wallet-auth.js";

const connectionString = process.env.DATABASE_URL_TEST;
const redisUrl = process.env.REDIS_URL_TEST;
const TABLE_COUNT = 16;
const PLAYERS_PER_TABLE = 4;
const COMMAND_DEADLINE_MS = 20_000;

function wallet(label) {
  return encodeBase58(createHash("sha256").update(label).digest());
}

function rules(game = "NLH") {
  return {
    game,
    seats: 6,
    smallBlindAtomic: "10",
    bigBlindAtomic: "20",
    anteAtomic: "0",
    minimumBuyInAtomic: "2000",
    maximumBuyInAtomic: "10000",
    rakeBps: 500,
    rakeCapAtomic: "300",
    actionClockMs: 20_000,
    timeBankMs: 60_000,
    roeHandsPerGame: 6,
  };
}

async function provisionTable(pool, { assetMint, allowlistVersion, game, label }) {
  const roomId = randomUUID();
  const tableId = randomUUID();
  const tableRules = rules(game);
  const roomRules = { name: label, description: "Resilience certification", tableRules };
  const rulesHash = createHash("sha256").update(JSON.stringify(roomRules)).digest();
  await pool.query(
    `INSERT INTO rooms (id, visibility, status, rules, rules_hash)
     VALUES ($1, 'private', 'open', $2, $3)`,
    [roomId, roomRules, rulesHash],
  );
  await pool.query(
    `INSERT INTO table_sessions (
       id, room_id, asset_mint, asset_allowlist_version, token_program, status
     ) VALUES ($1, $2, $3, $4, 'spl-token-2022', 'preview')`,
    [tableId, roomId, assetMint, allowlistVersion],
  );
  return { tableId, roomId, rules: tableRules };
}

test("concurrent tables recover after retries, write races, and Redis fanout loss", {
  skip: !connectionString || !redisUrl,
  timeout: 45_000,
}, async (context) => {
  const runId = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const pool = await createPostgresPool({ connectionString, max: 20 });
  const redis = await createRedisConnection(redisUrl);
  await redis.connect();
  context.after(async () => {
    await redis.quit();
    await pool.end();
  });
  await applyMigrations({ pool });

  const assetMint = wallet(`resilience-asset:${runId}`);
  const allowlistVersion = `cert-${createHash("sha256").update(runId).digest("hex").slice(0, 12)}`;
  await pool.query(
    `INSERT INTO asset_allowlist (
       mint_address, chain_id, token_program, symbol, decimals,
       multiplier_source, price_source, version, enabled, metadata
     ) VALUES ($1, 'solana:mainnet', 'spl-token-2022', 'CERTx', 2,
               'certification', 'certification', $2, false, $3)`,
    [assetMint, allowlistVersion, { zeroValue: true, runId }],
  );

  const games = ["NLH", "PLO4", "ROE"];
  const tables = await Promise.all(Array.from({ length: TABLE_COUNT }, (_, index) => provisionTable(pool, {
    assetMint,
    allowlistVersion,
    game: games[index % games.length],
    label: `Certification table ${index}`,
  })));
  const store = new PostgresTableEventStore({ pool, snapshotEvery: 5 });
  const coordinator = new AuthoritativeTableCoordinator({ store });

  const startedAt = performance.now();
  await Promise.all(tables.map(async (table, tableIndex) => {
    await coordinator.createTable({
      ...table,
      assetMint,
      allowlistVersion,
      idempotencyKey: `cert-create-${runId}-${tableIndex}`,
    });
    for (let seat = 0; seat < PLAYERS_PER_TABLE; seat += 1) {
      await coordinator.seatPlayer({
        tableId: table.tableId,
        playerId: wallet(`cert-player:${runId}:${tableIndex}:${seat}`),
        seat,
        buyInAtomic: "2000",
        expectedVersion: seat + 1,
        idempotencyKey: `cert-seat-${runId}-${tableIndex}-${seat}`,
      });
    }
  }));
  const elapsedMs = performance.now() - startedAt;
  const commands = TABLE_COUNT * (PLAYERS_PER_TABLE + 1);
  assert.ok(
    elapsedMs <= COMMAND_DEADLINE_MS,
    `${commands} authoritative commands exceeded the ${COMMAND_DEADLINE_MS}ms certification deadline`,
  );
  context.diagnostic(JSON.stringify({
    certification: "concurrent-table-baseline",
    tables: TABLE_COUNT,
    players: TABLE_COUNT * PLAYERS_PER_TABLE,
    commands,
    elapsedMs: Math.round(elapsedMs),
    commandsPerSecond: Math.round((commands / elapsedMs) * 100_000) / 100,
  }));

  const recoveredCoordinator = new AuthoritativeTableCoordinator({
    store: new PostgresTableEventStore({ pool, snapshotEvery: 5 }),
  });
  const recoveredStates = await Promise.all(tables.map((table) => recoveredCoordinator.state(table.tableId)));
  for (let index = 0; index < recoveredStates.length; index += 1) {
    const state = recoveredStates[index];
    assert.equal(state.version, PLAYERS_PER_TABLE + 1);
    assert.equal(state.seats.length, PLAYERS_PER_TABLE);
    assert.equal(state.rules.game, games[index % games.length]);
    const events = await store.load(tables[index].tableId);
    const verification = verifyTableEventChain(events, tables[index].tableId);
    assert.equal(verification.ok, true, verification.errors.join(", "));
  }

  const retries = await Promise.all(tables.map((table, tableIndex) => coordinator.seatPlayer({
    tableId: table.tableId,
    playerId: wallet(`cert-player:${runId}:${tableIndex}:0`),
    seat: 0,
    buyInAtomic: "2000",
    expectedVersion: 1,
    idempotencyKey: `cert-seat-${runId}-${tableIndex}-0`,
  })));
  assert.equal(retries.every((result) => result.duplicate === true), true);
  assert.deepEqual(
    await Promise.all(tables.map(async (table) => (await coordinator.state(table.tableId)).version)),
    Array(TABLE_COUNT).fill(PLAYERS_PER_TABLE + 1),
  );

  const raceTable = await provisionTable(pool, {
    assetMint,
    allowlistVersion,
    game: "NLH",
    label: "Same-seat race",
  });
  await coordinator.createTable({
    ...raceTable,
    assetMint,
    allowlistVersion,
    idempotencyKey: `cert-race-create-${runId}`,
  });
  const race = await Promise.allSettled([0, 1].map((contender) => coordinator.seatPlayer({
    tableId: raceTable.tableId,
    playerId: wallet(`cert-race-player:${runId}:${contender}`),
    seat: 0,
    buyInAtomic: "2000",
    expectedVersion: 1,
    idempotencyKey: `cert-race-seat-${runId}-${contender}`,
  })));
  assert.equal(race.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(race.filter((result) => result.status === "rejected").length, 1);
  assert.match(race.find((result) => result.status === "rejected").reason.message, /version conflict|occupied/i);
  const raceState = await coordinator.state(raceTable.tableId);
  assert.equal(raceState.version, 2);
  assert.equal(raceState.seats.length, 1);

  const publisher = redis.duplicate();
  const subscriber = redis.duplicate();
  await publisher.connect();
  const bus = new RedisTableEventBus({
    publisher,
    subscriber,
    prefix: `test:certification:fanout:${runId}:`,
  });
  await publisher.quit();
  const fanoutErrors = [];
  const failClosedCoordinator = new AuthoritativeTableCoordinator({
    store,
    onEvent: (event) => bus.publish(event),
    onEventError: (error, event) => fanoutErrors.push({ error, event }),
  });
  const outageTable = await provisionTable(pool, {
    assetMint,
    allowlistVersion,
    game: "PLO4",
    label: "Redis fanout outage",
  });
  const committed = await failClosedCoordinator.createTable({
    ...outageTable,
    assetMint,
    allowlistVersion,
    idempotencyKey: `cert-outage-create-${runId}`,
  });
  assert.equal(committed.duplicate, false);
  assert.equal(fanoutErrors.length, 1);
  assert.match(fanoutErrors[0].error.message, /closed|open/i);
  const outageState = await recoveredCoordinator.state(outageTable.tableId);
  assert.equal(outageState.status, "WAITING");
  assert.equal(outageState.version, 1);
  assert.equal((await store.load(outageTable.tableId)).length, 1);
});
