import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import { applyMigrations } from "./migrate.js";
import { BetaOperationsService } from "./beta-operations.js";
import { PostgresHandEventStore, createPostgresPool } from "./postgres-hand-store.js";
import { PostgresTableEventStore } from "./postgres-table-store.js";
import { createRedisConnection } from "./redis-stores.js";
import { AuthoritativeTableCoordinator, nextHandSetup } from "./table-coordinator.js";
import { TranscriptSigner, verifyTranscript } from "./transcript.js";

const connectionString = process.env.DATABASE_URL_TEST;
const redisUrl = process.env.REDIS_URL_TEST;

test("Postgres hand store atomically persists an idempotent signed transcript", {
  skip: !connectionString || !redisUrl,
}, async () => {
  const pool = await createPostgresPool({ connectionString });
  const migrationResult = await applyMigrations({ pool });
  const migrations = [
    "001_core.sql",
    "002_gameplay_settlement.sql",
    "003_realtime_tables.sql",
    "004_safe_beta.sql",
    "005_beta_operations.sql",
    "006_dealer_signing_keys.sql",
    "007_hand_history_indexes.sql",
    "008_compliance_custody.sql",
  ];
  assert.equal(migrationResult.current, migrations.at(-1));
  assert.equal(migrationResult.applied.every((name) => migrations.includes(name)), true);
  assert.deepEqual((await applyMigrations({ pool })).applied, []);
  const roomId = "018f47a6-7b9d-7cc3-8a23-60bfc31e3f45";
  await pool.query(
    `INSERT INTO rooms (id, visibility, status, rules, rules_hash)
     VALUES ($1, 'private', 'open', $2, $3)`,
    [roomId, { game: "NLH", seats: 2 }, Buffer.from("ab".repeat(32), "hex")],
  );
  const keypair = generateKeyPairSync("ed25519");
  const signer = new TranscriptSigner(keypair.privateKey);
  const event = signer.append({
    handId: "hand-postgres-001",
    type: "HAND_OPENED",
    payload: {
      roomId,
      rules: { game: "NLH", seats: 2, buttonSeat: 0 },
      players: ["wallet-a", "wallet-b"],
      serverCommitment: "cd".repeat(32),
    },
    occurredAt: "2026-08-17T12:00:00.000Z",
  });
  const store = new PostgresHandEventStore({ pool });
  const input = {
    handId: event.handId,
    expectedVersion: 0,
    idempotencyKey: "postgres-open-0001",
    requestDigest: "ef".repeat(32),
    event,
  };
  const first = await store.append(input);
  const retry = await store.append(input);
  assert.equal(first.duplicate, false);
  assert.equal(retry.duplicate, true);
  const transcript = await store.load(event.handId);
  assert.equal(transcript.length, 1);
  assert.equal(verifyTranscript(transcript, keypair.publicKey).ok, true);
  await assert.rejects(
    store.append({ ...input, requestDigest: "00".repeat(32) }),
    /different input/i,
  );

  await pool.query(
    `INSERT INTO asset_allowlist
      (mint_address, chain_id, token_program, symbol, decimals, multiplier_source, price_source, version, enabled)
     VALUES ($1, 'solana:mainnet', 'spl-token-2022', 'TESTx', 8, 'test', 'test', 'test-v001', true)`,
    ["SysvarRecentB1ockHashes11111111111111111111"],
  );
  const tableSession = await pool.query(
    `INSERT INTO table_sessions
      (room_id, asset_mint, asset_allowlist_version, token_program, status)
     VALUES ($1, $2, 'test-v001', 'spl-token-2022', 'preview')
     RETURNING id`,
    [roomId, "SysvarRecentB1ockHashes11111111111111111111"],
  );
  await pool.query(
    `INSERT INTO hand_state_snapshots (hand_id, version, state, state_hash)
     VALUES ($1, 1, $2, $3)`,
    [input.handId, { phase: "PREFLOP", actionSeat: 0 }, Buffer.from("12".repeat(32), "hex")],
  );
  await pool.query(
    `INSERT INTO hand_results
      (hand_id, table_session_id, game_type, rules_hash, transcript_root, result_hash, result, pot_atomic, rake_atomic)
     VALUES ($1, $2, 'NLH', $3, $4, $5, $6, 100, 2)`,
    [
      input.handId,
      tableSession.rows[0].id,
      Buffer.from("ab".repeat(32), "hex"),
      Buffer.from("cd".repeat(32), "hex"),
      Buffer.from("ef".repeat(32), "hex"),
      { payouts: { "wallet-a": "98" } },
    ],
  );
  await assert.rejects(
    pool.query("UPDATE hand_state_snapshots SET state = '{}' WHERE hand_id = $1", [input.handId]),
    /append-only/i,
  );

  const tableId = tableSession.rows[0].id;
  const tableStore = new PostgresTableEventStore({ pool, snapshotEvery: 2 });
  const tableCoordinator = new AuthoritativeTableCoordinator({
    store: tableStore,
    clock: () => new Date("2026-08-17T12:00:00.000Z"),
  });
  const tableRules = {
    game: "NLH",
    seats: 2,
    smallBlindAtomic: "10",
    bigBlindAtomic: "20",
    minimumBuyInAtomic: "100",
    maximumBuyInAtomic: "2000",
    actionClockMs: 5_000,
    timeBankMs: 10_000,
  };
  await tableCoordinator.createTable({
    tableId,
    roomId,
    assetMint: "SysvarRecentB1ockHashes11111111111111111111",
    allowlistVersion: "test-v001",
    rules: tableRules,
    idempotencyKey: "postgres-table-create-0001",
  });
  await tableCoordinator.seatPlayer({
    tableId,
    playerId: "11111111111111111111111111111111",
    seat: 0,
    buyInAtomic: "1000",
    expectedVersion: 1,
    idempotencyKey: "postgres-table-seat-a-001",
  });
  await tableCoordinator.seatPlayer({
    tableId,
    playerId: "SysvarC1ock11111111111111111111111111111111",
    seat: 1,
    buyInAtomic: "1000",
    expectedVersion: 2,
    idempotencyKey: "postgres-table-seat-b-001",
  });
  const setup = nextHandSetup(await tableCoordinator.state(tableId));
  await pool.query(
    `INSERT INTO hands (id, room_id, status, version, deck_root)
     VALUES ($1, $2, 'dealing', 1, $3)`,
    [setup.handId, roomId, Buffer.from("34".repeat(32), "hex")],
  );
  await tableCoordinator.startHand({
    tableId,
    handId: setup.handId,
    deckRoot: "34".repeat(32),
    fairnessTranscriptHead: "56".repeat(32),
    expectedVersion: 3,
    idempotencyKey: "postgres-table-start-001",
  });
  const recoveredTable = await tableCoordinator.state(tableId);
  assert.equal(recoveredTable.status, "HAND_ACTIVE");
  assert.equal(recoveredTable.currentHand.turn.playerId, "11111111111111111111111111111111");
  const snapshots = await pool.query(
    "SELECT sequence FROM table_state_snapshots WHERE table_session_id = $1 ORDER BY sequence",
    [tableId],
  );
  assert.deepEqual(snapshots.rows.map((row) => Number(row.sequence)), [2, 4]);
  await tableCoordinator.leave({
    tableId,
    playerId: "SysvarC1ock11111111111111111111111111111111",
    expectedVersion: 4,
    idempotencyKey: "postgres-table-leave-clock-001",
  });
  const stateWithLeavingPlayer = await tableCoordinator.state(tableId);
  await pool.query("DELETE FROM table_timeout_leases WHERE table_session_id = $1", [tableId]);
  await pool.query("UPDATE game_tables SET action_deadline_at = NULL WHERE table_session_id = $1", [tableId]);
  assert.equal(await tableStore.reconcileDeadline({
    tableId,
    expectedVersion: stateWithLeavingPlayer.version,
    turn: {
      handId: stateWithLeavingPlayer.currentHand.betting.handId,
      bettingVersion: stateWithLeavingPlayer.currentHand.betting.version,
      playerId: stateWithLeavingPlayer.currentHand.turn.playerId,
      deadlineAt: stateWithLeavingPlayer.currentHand.turn.deadlineAt,
    },
  }), true);
  const claimed = await tableStore.claimExpiredDeadlines({
    ownerId: "timeout-worker-001",
    now: new Date("2026-08-17T12:00:16.000Z"),
  });
  assert.equal(claimed.length, 1);
  assert.equal((await tableStore.claimExpiredDeadlines({
    ownerId: "timeout-worker-002",
    now: new Date("2026-08-17T12:00:16.000Z"),
  })).length, 0);
  await assert.rejects(
    pool.query("UPDATE table_events SET payload = '{}' WHERE table_session_id = $1", [tableId]),
    /append-only/i,
  );
  await assert.rejects(
    pool.query("DELETE FROM table_state_snapshots WHERE table_session_id = $1", [tableId]),
    /append-only/i,
  );

  const adminWallet = "11111111111111111111111111111111";
  const playerWallet = "SysvarC1ock11111111111111111111111111111111";
  await pool.query(
    `INSERT INTO safe_beta_profiles (wallet_address, display_name, is_guest)
     VALUES ($1, 'Admin Player', false), ($2, 'Invited Player', false)
     ON CONFLICT (wallet_address) DO NOTHING`,
    [adminWallet, playerWallet],
  );
  const redis = await createRedisConnection(redisUrl);
  await redis.connect();
  const operations = new BetaOperationsService({
    pool,
    redis,
    adminWallets: [adminWallet],
    instanceId: "integration-instance",
    buildCommit: "integration-build",
  });
  await operations.bootstrap();
  assert.equal(await operations.operator(adminWallet), "admin");
  const invitation = await operations.createInvite({
    wallet: adminWallet,
    label: "Integration cohort",
    maxUses: 2,
    expiresHours: 24,
  });
  assert.match(invitation.code, /^BETA-[A-Z2-9]{5}-[A-Z2-9]{5}$/);
  assert.equal((await operations.redeemInvite({ wallet: playerWallet, code: invitation.code })).granted, true);
  await operations.recordRequest({ method: "GET", path: "/health/ready", statusCode: 200, durationMs: 12.5 });
  await operations.recordIncident({ category: "integration_warning", severity: "warning", message: "Restore drill signal" });
  await operations.start();
  const overview = await operations.overview(adminWallet);
  assert.equal(overview.instances.some((instance) => instance.instanceId === "integration-instance"), true);
  assert.equal(overview.summary.openIncidents, 1);
  const report = await pool.query(
    `INSERT INTO safe_beta_reports (reporter_wallet, reported_wallet, category, details)
     VALUES ($1, $2, 'stalling', 'Repeatedly consumed the full action clock.')
     RETURNING id`,
    [adminWallet, playerWallet],
  );
  assert.equal(
    (await operations.listReports({ wallet: adminWallet })).some((entry) => entry.id === report.rows[0].id),
    true,
  );
  assert.equal((await operations.moderateReport({
    wallet: adminWallet,
    reportId: report.rows[0].id,
    status: "resolved",
    note: "Reviewed the action log and contacted the player.",
  })).status, "resolved");
  assert.equal((await operations.moderatePlayer({
    wallet: adminWallet,
    playerWallet,
    status: "suspended",
    note: "Temporary closed-beta hold.",
  })).status, "suspended");
  await assert.rejects(
    pool.query("UPDATE safe_beta_moderation_events SET payload = '{}'"),
    /append-only/i,
  );
  await operations.close();
  await redis.quit();
  await pool.end();
});
