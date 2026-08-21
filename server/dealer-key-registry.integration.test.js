import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import { PostgresDealerKeyRegistry } from "./dealer-key-registry.js";
import { applyMigrations } from "./migrate.js";
import { PostgresHandEventStore, createPostgresPool } from "./postgres-hand-store.js";
import { TranscriptSigner } from "./transcript.js";

const connectionString = process.env.DATABASE_URL_TEST;

test("dealer key registry preserves old verification keys and blocks in-flight rotation", {
  skip: !connectionString,
}, async () => {
  const controlPool = await createPostgresPool({ connectionString });
  const schema = "dealer_key_registry_test";
  await controlPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await controlPool.query(`CREATE SCHEMA ${schema}`);
  const isolatedUrl = new URL(connectionString);
  isolatedUrl.searchParams.set("options", `-c search_path=${schema}`);
  const pool = await createPostgresPool({ connectionString: isolatedUrl.toString() });
  await applyMigrations({ pool });
  const roomId = "30000000-0000-4000-8000-000000000006";
  await pool.query(
    `INSERT INTO rooms (id, visibility, status, rules, rules_hash)
     VALUES ($1, 'private', 'open', $2, $3)
     ON CONFLICT (id) DO NOTHING`,
    [roomId, { game: "NLH", seats: 2 }, Buffer.from("36".repeat(32), "hex")],
  );

  const oldSigner = new TranscriptSigner(generateKeyPairSync("ed25519").privateKey);
  const nextSigner = new TranscriptSigner(generateKeyPairSync("ed25519").privateKey);
  const store = new PostgresHandEventStore({ pool });
  const handId = "hand-key-registry-rotation-006";
  const opened = oldSigner.append({
    handId,
    type: "HAND_OPENED",
    payload: {
      roomId,
      rules: { game: "NLH", seats: 2, buttonSeat: 0 },
      players: ["wallet-a", "wallet-b"],
      serverCommitment: "46".repeat(32),
    },
    occurredAt: "2026-08-21T12:00:00.000Z",
  });
  await store.append({
    handId,
    expectedVersion: 0,
    idempotencyKey: "dealer-key-registry-open-006",
    requestDigest: "56".repeat(32),
    event: opened,
  });

  const registry = new PostgresDealerKeyRegistry({ pool });
  const registered = await registry.registerCurrentSigner(oldSigner);
  assert.equal(registered.keyId, oldSigner.keyId);
  await assert.rejects(
    registry.registerCurrentSigner(nextSigner),
    /old-key hand is in flight/i,
  );

  const aborted = oldSigner.append({
    handId,
    type: "HAND_ABORTED",
    payload: { reason: "OPERATOR_SHUTDOWN", refundsScheduled: true },
    previousEvent: opened,
    occurredAt: "2026-08-21T12:01:00.000Z",
  });
  await store.append({
    handId,
    expectedVersion: 1,
    idempotencyKey: "dealer-key-registry-abort-006",
    requestDigest: "66".repeat(32),
    event: aborted,
  });
  assert.equal((await registry.registerCurrentSigner(nextSigner)).keyId, nextSigner.keyId);
  assert.equal(await registry.publicKeyPem(oldSigner.keyId), oldSigner.publicKeyPem());
  await assert.rejects(
    pool.query("DELETE FROM dealer_signing_keys WHERE key_id = $1", [oldSigner.keyId]),
    /append-only/i,
  );
  await pool.end();
  await controlPool.query(`DROP SCHEMA ${schema} CASCADE`);
  await controlPool.end();
});
