function eventFromRow(row) {
  return {
    version: "xpoker-hand-transcript/v1",
    handId: row.hand_id,
    sequence: Number(row.sequence),
    type: row.event_type,
    occurredAt: new Date(row.occurred_at).toISOString(),
    previousHash: Buffer.from(row.previous_hash).toString("hex"),
    signerKeyId: row.signer_key_id,
    payload: row.payload,
    eventHash: Buffer.from(row.event_hash).toString("hex"),
    signature: Buffer.from(row.signature).toString("base64url"),
  };
}

function statusFor(type) {
  return {
    HAND_OPENED: "committing",
    BEACON_RESERVED: "beacon_reserved",
    DECK_COMMITTED: "dealing",
    HAND_COMPLETED: "complete",
    HAND_ABORTED: "aborted",
  }[type];
}

export class PostgresHandEventStore {
  constructor({ pool } = {}) {
    if (!pool?.query || !pool?.connect) throw new Error("A configured PostgreSQL pool is required");
    this.pool = pool;
    this.durable = true;
  }

  async load(handId) {
    const result = await this.pool.query(
      `SELECT hand_id, sequence, event_type, payload, previous_hash, event_hash,
              signature, signer_key_id, occurred_at
         FROM hand_events
        WHERE hand_id = $1
        ORDER BY sequence ASC`,
      [handId],
    );
    return result.rows.map(eventFromRow);
  }

  async findIdempotency(handId, idempotencyKey) {
    const result = await this.pool.query(
      `SELECT hand_id, sequence, event_type, payload, previous_hash, event_hash,
              signature, signer_key_id, occurred_at, request_digest
         FROM hand_events
        WHERE hand_id = $1 AND idempotency_key = $2`,
      [handId, idempotencyKey],
    );
    if (result.rowCount === 0) return undefined;
    return {
      requestDigest: Buffer.from(result.rows[0].request_digest).toString("hex"),
      event: eventFromRow(result.rows[0]),
    };
  }

  async append({ handId, expectedVersion, idempotencyKey, requestDigest, event }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const duplicate = await client.query(
        `SELECT hand_id, sequence, event_type, payload, previous_hash, event_hash,
                signature, signer_key_id, occurred_at, request_digest
           FROM hand_events
          WHERE hand_id = $1 AND idempotency_key = $2`,
        [handId, idempotencyKey],
      );
      if (duplicate.rowCount > 0) {
        const row = duplicate.rows[0];
        if (Buffer.from(row.request_digest).toString("hex") !== requestDigest) {
          throw new Error("Idempotency key was reused with different input");
        }
        await client.query("COMMIT");
        return { event: eventFromRow(row), duplicate: true };
      }

      if (event.type === "HAND_OPENED") {
        if (expectedVersion !== 0 || event.sequence !== 1) throw new Error("Opening hand version is invalid");
        await client.query(
          `INSERT INTO hands (id, room_id, status, version)
           VALUES ($1, $2, 'committing', 0)`,
          [handId, event.payload.roomId],
        );
      } else {
        const hand = await client.query("SELECT version FROM hands WHERE id = $1 FOR UPDATE", [handId]);
        if (hand.rowCount !== 1) throw new Error("Hand does not exist");
        if (Number(hand.rows[0].version) !== expectedVersion) throw new Error("Hand version conflict");
      }
      if (event.sequence !== expectedVersion + 1) throw new Error("Transcript sequence differs from expected version");

      await client.query(
        `INSERT INTO hand_events (
           hand_id, sequence, event_type, payload, previous_hash, event_hash,
           signature, signer_key_id, idempotency_key, request_digest, occurred_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          handId,
          event.sequence,
          event.type,
          event.payload,
          Buffer.from(event.previousHash, "hex"),
          Buffer.from(event.eventHash, "hex"),
          Buffer.from(event.signature, "base64url"),
          event.signerKeyId,
          idempotencyKey,
          Buffer.from(requestDigest, "hex"),
          event.occurredAt,
        ],
      );

      const nextStatus = statusFor(event.type);
      const deckRoot = event.type === "DECK_COMMITTED" ? Buffer.from(event.payload.deckRoot, "hex") : null;
      const beaconChainHash = event.type === "DECK_COMMITTED"
        ? Buffer.from(event.payload.beacon.chainHash, "hex")
        : null;
      const beaconRound = event.type === "DECK_COMMITTED" ? event.payload.beacon.round : null;
      const completed = event.type === "HAND_COMPLETED" || event.type === "HAND_ABORTED";
      await client.query(
        `UPDATE hands
            SET version = $2,
                status = COALESCE($3, status),
                deck_root = COALESCE($4, deck_root),
                beacon_chain_hash = COALESCE($5, beacon_chain_hash),
                beacon_round = COALESCE($6, beacon_round),
                completed_at = CASE WHEN $7 THEN $8::timestamptz ELSE completed_at END
          WHERE id = $1`,
        [handId, event.sequence, nextStatus, deckRoot, beaconChainHash, beaconRound, completed, event.occurredAt],
      );
      await client.query("COMMIT");
      return { event, duplicate: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async close() {
    await this.pool.end();
  }
}

export async function createPostgresPool({ connectionString, max = 20 } = {}) {
  const { Pool } = await import("pg");
  return new Pool({
    connectionString,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    query_timeout: 5_000,
    statement_timeout: 5_000,
  });
}
