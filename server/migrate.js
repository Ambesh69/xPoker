import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";

import { loadConfig } from "./config.js";
import { createPostgresPool } from "./postgres-hand-store.js";

const MIGRATION_NAME = /^\d{3}_[a-z0-9_]+\.sql$/;
export const CURRENT_SCHEMA_MIGRATION = "009_investment_rails.sql";

function migrationBody(source, name) {
  const withoutBegin = source.replace(/^\s*BEGIN;\s*/i, "");
  const withoutCommit = withoutBegin.replace(/\s*COMMIT;\s*$/i, "");
  if (withoutBegin === source || withoutCommit === withoutBegin) {
    throw new Error(`Migration ${name} must have one outer BEGIN/COMMIT transaction`);
  }
  return withoutCommit;
}

export async function applyMigrations({ pool, directory = new URL("../db/", import.meta.url) } = {}) {
  if (!pool?.connect) throw new Error("A configured PostgreSQL pool is required");
  const names = (await readdir(directory)).filter((name) => MIGRATION_NAME.test(name)).sort();
  if (names.length === 0) throw new Error("No database migrations were found");
  const client = await pool.connect();
  const applied = [];
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      sha256 bytea NOT NULL CHECK (octet_length(sha256) = 32),
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    await client.query("SELECT pg_advisory_lock(hashtext('xpoker-schema-migrations'))");
    for (const name of names) {
      const source = await readFile(new URL(name, directory), "utf8");
      const digest = createHash("sha256").update(source).digest();
      const prior = await client.query("SELECT sha256 FROM schema_migrations WHERE name = $1", [name]);
      if (prior.rowCount > 0) {
        if (!Buffer.from(prior.rows[0].sha256).equals(digest)) {
          throw new Error(`Applied migration checksum changed: ${name}`);
        }
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(migrationBody(source, name));
        await client.query("INSERT INTO schema_migrations (name, sha256) VALUES ($1, $2)", [name, digest]);
        await client.query("COMMIT");
        applied.push(name);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    return Object.freeze({ applied, current: names.at(-1) });
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('xpoker-schema-migrations'))").catch(() => {});
    client.release();
  }
}

async function main() {
  const config = loadConfig();
  if (!config.databaseUrl) throw new Error("DATABASE_URL is required to apply migrations");
  const pool = await createPostgresPool({ connectionString: config.databaseUrl, max: 1 });
  try {
    const result = await applyMigrations({ pool });
    console.log(JSON.stringify({ level: "info", event: "migrations_complete", ...result }));
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
