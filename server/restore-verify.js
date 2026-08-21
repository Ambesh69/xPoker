import { createPostgresPool } from "./postgres-hand-store.js";
import { PostgresTableEventStore } from "./postgres-table-store.js";
import { applyMigrations } from "./migrate.js";
import { AuthoritativeTableCoordinator } from "./table-coordinator.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function verifyHandChains(pool) {
  const result = await pool.query(
    `SELECT hand_id, sequence, previous_hash, event_hash
       FROM hand_events
      ORDER BY hand_id, sequence`,
  );
  let handId;
  let sequence = 0;
  let previousHash = "0".repeat(64);
  for (const row of result.rows) {
    if (row.hand_id !== handId) {
      handId = row.hand_id;
      sequence = 0;
      previousHash = "0".repeat(64);
    }
    sequence += 1;
    assert(Number(row.sequence) === sequence, `Hand ${handId} transcript is not contiguous`);
    assert(Buffer.from(row.previous_hash).toString("hex") === previousHash, `Hand ${handId} transcript link is broken`);
    previousHash = Buffer.from(row.event_hash).toString("hex");
  }
  return new Set(result.rows.map((row) => row.hand_id)).size;
}

export async function verifyRestore({ pool } = {}) {
  assert(pool?.query, "A restored PostgreSQL pool is required");
  const migrations = await applyMigrations({ pool });
  assert(migrations.current === "006_dealer_signing_keys.sql", "Restored schema is not current");
  assert(migrations.applied.length === 0, "Restore verification must not need to mutate the schema");

  const triggers = await pool.query(
    `SELECT tgname
       FROM pg_trigger
      WHERE NOT tgisinternal
        AND tgname IN ('hand_events_no_update', 'table_events_no_mutation', 'hand_results_no_mutation', 'safe_beta_moderation_events_no_mutation', 'dealer_signing_keys_no_mutation')`,
  );
  assert(triggers.rowCount === 5, "One or more append-only protection triggers are missing");

  const brokenHands = await pool.query(
    `SELECT hand.id
       FROM hands hand
      WHERE NOT EXISTS (
        SELECT 1 FROM hand_events event
         WHERE event.hand_id = hand.id AND event.sequence = 1 AND event.event_type = 'HAND_OPENED'
      )
         OR (hand.status = 'complete' AND NOT EXISTS (
           SELECT 1 FROM hand_events event
            WHERE event.hand_id = hand.id AND event.event_type = 'HAND_COMPLETED'
         ))
      LIMIT 1`,
  );
  assert(brokenHands.rowCount === 0, "Restored hand lifecycle is incomplete");

  const tableIds = await pool.query("SELECT table_session_id FROM game_tables ORDER BY table_session_id");
  const coordinator = new AuthoritativeTableCoordinator({ store: new PostgresTableEventStore({ pool }) });
  for (const row of tableIds.rows) await coordinator.state(row.table_session_id);

  const ledgerImbalance = await pool.query(
    `SELECT ledger_transaction.id
       FROM ledger_transactions ledger_transaction
       JOIN ledger_entries entry ON entry.transaction_id = ledger_transaction.id
      WHERE ledger_transaction.status = 'posted'
      GROUP BY ledger_transaction.id, entry.asset_mint
     HAVING sum(CASE entry.direction WHEN 'debit' THEN entry.amount_atomic ELSE -entry.amount_atomic END) <> 0
      LIMIT 1`,
  );
  assert(ledgerImbalance.rowCount === 0, "Restored posted ledger is imbalanced");

  const counts = await pool.query(
    `SELECT
       (SELECT count(*) FROM safe_beta_profiles) AS profiles,
       (SELECT count(*) FROM hands) AS hands,
       (SELECT count(*) FROM game_tables) AS tables,
       (SELECT count(*) FROM safe_beta_reports) AS reports,
       (SELECT count(*) FROM safe_beta_moderation_events) AS moderation_events`,
  );
  return {
    ok: true,
    schema: migrations.current,
    profiles: Number(counts.rows[0].profiles),
    hands: Number(counts.rows[0].hands),
    verifiedHandChains: await verifyHandChains(pool),
    verifiedTableChains: tableIds.rowCount,
    reports: Number(counts.rows[0].reports),
    moderationEvents: Number(counts.rows[0].moderation_events),
    appendOnlyTriggers: triggers.rowCount,
  };
}

async function main() {
  const connectionString = process.env.VERIFY_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) throw new Error("VERIFY_DATABASE_URL is required");
  const pool = await createPostgresPool({ connectionString, max: 2 });
  try {
    console.log(JSON.stringify({ level: "info", event: "restore_verified", ...(await verifyRestore({ pool })) }));
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
