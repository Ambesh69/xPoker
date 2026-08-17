import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { PostgresHandEventStore, createPostgresPool } from "./postgres-hand-store.js";
import { TranscriptSigner, verifyTranscript } from "./transcript.js";

const connectionString = process.env.DATABASE_URL_TEST;

test("Postgres hand store atomically persists an idempotent signed transcript", {
  skip: !connectionString,
}, async () => {
  const pool = await createPostgresPool({ connectionString });
  const migrations = await Promise.all([
    readFile(new URL("../db/001_core.sql", import.meta.url), "utf8"),
    readFile(new URL("../db/002_gameplay_settlement.sql", import.meta.url), "utf8"),
  ]);
  for (const migration of migrations) await pool.query(migration);
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
  await pool.end();
});
