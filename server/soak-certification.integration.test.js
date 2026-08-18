import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";

import { applyMigrations } from "./migrate.js";
import { createPostgresPool } from "./postgres-hand-store.js";
import { PostgresTableEventStore } from "./postgres-table-store.js";
import {
  AuthoritativeTableCoordinator,
  verifyTableEventChain,
} from "./table-coordinator.js";
import { encodeBase58 } from "./wallet-auth.js";

const connectionString = process.env.DATABASE_URL_TEST;
const enabled = process.env.RUN_SOAK_CERTIFICATION === "1";
const requestedDurationMs = Number(process.env.SOAK_DURATION_MS ?? 10_000);
const durationMs = Number.isInteger(requestedDurationMs)
  ? Math.min(300_000, Math.max(5_000, requestedDurationMs))
  : 10_000;
const requestedTables = Number(process.env.SOAK_TABLE_COUNT ?? 16);
const tableCount = Number.isInteger(requestedTables)
  ? Math.min(64, Math.max(4, requestedTables))
  : 16;
const requestedP95LimitMs = Number(process.env.SOAK_P95_LIMIT_MS ?? 2_000);
const p95LimitMs = Number.isFinite(requestedP95LimitMs) && requestedP95LimitMs >= 100
  ? requestedP95LimitMs
  : 2_000;

function wallet(label) {
  return encodeBase58(createHash("sha256").update(label).digest());
}

function rules(game) {
  return {
    game,
    seats: 2,
    smallBlindAtomic: "10",
    bigBlindAtomic: "20",
    anteAtomic: "0",
    minimumBuyInAtomic: "2000",
    maximumBuyInAtomic: "10000",
    rakeBps: 500,
    rakeCapAtomic: "300",
    actionClockMs: 20_000,
    timeBankMs: 60_000,
    roeHandsPerGame: 1,
  };
}

test("sustained concurrent table soak preserves durability and bounded command latency", {
  skip: !connectionString || !enabled,
  timeout: durationMs + 90_000,
}, async (context) => {
  const runId = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const pool = await createPostgresPool({ connectionString, max: Math.min(40, tableCount + 8) });
  context.after(() => pool.end());
  await applyMigrations({ pool });

  const assetMint = wallet(`soak-asset:${runId}`);
  const allowlistVersion = `soak-${createHash("sha256").update(runId).digest("hex").slice(0, 12)}`;
  await pool.query(
    `INSERT INTO asset_allowlist (
       mint_address, chain_id, token_program, symbol, decimals,
       multiplier_source, price_source, version, enabled, metadata
     ) VALUES ($1, 'solana:mainnet', 'spl-token-2022', 'SOAKx', 2,
               'certification', 'certification', $2, false, $3)`,
    [assetMint, allowlistVersion, { zeroValue: true, runId }],
  );

  const games = ["NLH", "PLO4", "ROE"];
  const tables = await Promise.all(Array.from({ length: tableCount }, async (_, index) => {
    const roomId = randomUUID();
    const tableId = randomUUID();
    const game = games[index % games.length];
    const tableRules = rules(game);
    const roomRules = { name: `Soak table ${index}`, description: "Sustained certification", tableRules };
    await pool.query(
      `INSERT INTO rooms (id, visibility, status, rules, rules_hash)
       VALUES ($1, 'private', 'open', $2, $3)`,
      [roomId, roomRules, createHash("sha256").update(JSON.stringify(roomRules)).digest()],
    );
    await pool.query(
      `INSERT INTO table_sessions (
         id, room_id, asset_mint, asset_allowlist_version, token_program, status
       ) VALUES ($1, $2, $3, $4, 'spl-token-2022', 'preview')`,
      [tableId, roomId, assetMint, allowlistVersion],
    );
    return {
      tableId,
      roomId,
      game,
      rules: tableRules,
      players: [wallet(`soak:${runId}:${index}:0`), wallet(`soak:${runId}:${index}:1`)],
    };
  }));

  const store = new PostgresTableEventStore({ pool, snapshotEvery: 500 });
  const coordinator = new AuthoritativeTableCoordinator({ store });
  await Promise.all(tables.map(async (table, index) => {
    await coordinator.createTable({
      ...table,
      assetMint,
      allowlistVersion,
      idempotencyKey: `soak-create-${runId}-${index}`,
    });
    for (let seat = 0; seat < table.players.length; seat += 1) {
      await coordinator.seatPlayer({
        tableId: table.tableId,
        playerId: table.players[seat],
        seat,
        buyInAtomic: "2000",
        expectedVersion: seat + 1,
        idempotencyKey: `soak-seat-${runId}-${index}-${seat}`,
      });
    }
  }));

  const latencies = [];
  const errors = [];
  const operationsByTable = Array(tableCount).fill(0);
  const startedAt = performance.now();
  const stopAt = startedAt + durationMs;
  await Promise.all(tables.map(async (table, tableIndex) => {
    let sittingOut = false;
    while (performance.now() < stopAt) {
      const state = await coordinator.state(table.tableId);
      const operationStartedAt = performance.now();
      const operationNumber = operationsByTable[tableIndex] + 1;
      try {
        if (sittingOut) {
          await coordinator.returnPlayer({
            tableId: table.tableId,
            playerId: table.players[0],
            expectedVersion: state.version,
            idempotencyKey: `soak-return-${runId}-${tableIndex}-${operationNumber}`,
          });
        } else {
          await coordinator.sitOut({
            tableId: table.tableId,
            playerId: table.players[0],
            expectedVersion: state.version,
            idempotencyKey: `soak-sit-${runId}-${tableIndex}-${operationNumber}`,
          });
        }
        sittingOut = !sittingOut;
        operationsByTable[tableIndex] = operationNumber;
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
        break;
      } finally {
        latencies.push(performance.now() - operationStartedAt);
      }
    }
  }));
  const elapsedMs = performance.now() - startedAt;

  assert.deepEqual(errors, []);
  assert.ok(operationsByTable.every((count) => count >= 10), `Insufficient sustained operations: ${operationsByTable.join(",")}`);
  latencies.sort((left, right) => left - right);
  const p50Ms = latencies[Math.ceil(latencies.length * 0.5) - 1];
  const p95Ms = latencies[Math.ceil(latencies.length * 0.95) - 1];
  const p99Ms = latencies[Math.ceil(latencies.length * 0.99) - 1];
  assert.ok(p95Ms <= p95LimitMs, `Soak p95 ${p95Ms}ms exceeded ${p95LimitMs}ms`);

  const recoveredCoordinator = new AuthoritativeTableCoordinator({
    store: new PostgresTableEventStore({ pool, snapshotEvery: 500 }),
  });
  for (let index = 0; index < tables.length; index += 1) {
    const table = tables[index];
    const state = await recoveredCoordinator.state(table.tableId);
    assert.equal(state.version, 3 + operationsByTable[index]);
    assert.equal(state.rules.game, table.game);
    assert.equal(state.seats.length, 2);
    assert.equal(state.seats.reduce((sum, player) => sum + player.stack, 0n), 4_000n);
    const events = await store.load(table.tableId);
    const verification = verifyTableEventChain(events, table.tableId);
    assert.equal(verification.ok, true, verification.errors.join(", "));
  }

  const operations = operationsByTable.reduce((sum, count) => sum + count, 0);
  context.diagnostic(JSON.stringify({
    certification: "sustained-table-soak",
    durationMs: Math.round(elapsedMs),
    tables: tableCount,
    operations,
    operationsPerSecond: Math.round((operations / elapsedMs) * 100_000) / 100,
    errors: errors.length,
    p50Ms: Math.round(p50Ms * 100) / 100,
    p95Ms: Math.round(p95Ms * 100) / 100,
    p99Ms: Math.round(p99Ms * 100) / 100,
  }));
});
