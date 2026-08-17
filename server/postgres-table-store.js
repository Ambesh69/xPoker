import { createHash } from "node:crypto";

import { canonicalJson } from "../fairness/protocol.js";
import {
  deserializeTableState,
  reduceTable,
  serializeTableState,
} from "./table-coordinator.js";

const ACTIVE_TURN_EVENT_TYPES = new Set([
  "HAND_STARTED",
  "ACTION_APPLIED",
  "ACTION_TIMED_OUT",
  "STREET_DEALT",
  "RUNOUT_DEALT",
  "HAND_FINISHED",
]);

function eventFromRow(row) {
  return {
    version: row.event_version,
    tableId: row.table_session_id,
    sequence: Number(row.sequence),
    type: row.event_type,
    occurredAt: new Date(row.occurred_at).toISOString(),
    previousHash: Buffer.from(row.previous_hash).toString("hex"),
    payload: row.payload,
    eventHash: Buffer.from(row.event_hash).toString("hex"),
  };
}

function tableStatus(type) {
  return {
    TABLE_CREATED: "waiting",
    HAND_STARTED: "hand_active",
    HAND_FINISHED: "waiting",
    TABLE_PAUSED: "paused",
    TABLE_RESUMED: "waiting",
    TABLE_CLOSED: "closed",
  }[type];
}

function activeTurn(event) {
  const { betting, turn } = event.payload;
  if (!betting || betting.status !== "BETTING" || !turn) return undefined;
  return {
    handId: betting.handId,
    bettingVersion: betting.version,
    playerId: turn.playerId,
    deadlineAt: turn.deadlineAt,
  };
}

function mutatesActiveTurn(event) {
  return ACTIVE_TURN_EVENT_TYPES.has(event.type);
}

export class PostgresTableEventStore {
  constructor({ pool, snapshotEvery = 100 } = {}) {
    if (!pool?.query || !pool?.connect) throw new Error("A configured PostgreSQL pool is required");
    if (!Number.isInteger(snapshotEvery) || snapshotEvery < 1 || snapshotEvery > 10_000) {
      throw new Error("Table snapshot interval is invalid");
    }
    this.pool = pool;
    this.snapshotEvery = snapshotEvery;
    this.durable = true;
  }

  async load(tableId, { afterVersion = 0 } = {}) {
    const result = await this.pool.query(
      `SELECT table_session_id, sequence, event_version, event_type, payload,
              previous_hash, event_hash, occurred_at
         FROM table_events
        WHERE table_session_id = $1 AND sequence > $2
        ORDER BY sequence ASC`,
      [tableId, afterVersion],
    );
    return result.rows.map(eventFromRow);
  }

  async head(tableId) {
    const result = await this.pool.query(
      `SELECT table_session_id, sequence, event_version, event_type, payload,
              previous_hash, event_hash, occurred_at
         FROM table_events
        WHERE table_session_id = $1
        ORDER BY sequence DESC
        LIMIT 1`,
      [tableId],
    );
    return result.rowCount === 0 ? undefined : eventFromRow(result.rows[0]);
  }

  async loadAggregate(tableId) {
    const result = await this.pool.query(
      `SELECT snapshot.sequence, snapshot.event_hash, snapshot.state,
              snapshot.state_hash, snapshot.occurred_at,
              event.event_hash AS authoritative_event_hash
         FROM table_state_snapshots AS snapshot
         JOIN table_events AS event
           ON event.table_session_id = snapshot.table_session_id
          AND event.sequence = snapshot.sequence
        WHERE snapshot.table_session_id = $1
        ORDER BY snapshot.sequence DESC
        LIMIT 1`,
      [tableId],
    );
    if (result.rowCount === 0) {
      return { state: undefined, snapshot: undefined, events: await this.load(tableId) };
    }
    const row = result.rows[0];
    const serialized = row.state;
    const expectedStateHash = createHash("sha256").update(canonicalJson(serialized)).digest("hex");
    const storedStateHash = Buffer.from(row.state_hash).toString("hex");
    if (storedStateHash !== expectedStateHash) throw new Error("Stored table snapshot hash is invalid");
    const eventHash = Buffer.from(row.event_hash).toString("hex");
    if (eventHash !== Buffer.from(row.authoritative_event_hash).toString("hex")) {
      throw new Error("Stored table snapshot event anchor is invalid");
    }
    const sequence = Number(row.sequence);
    const state = deserializeTableState(serialized);
    if (state.version !== sequence) throw new Error("Stored table snapshot version is invalid");
    return {
      state,
      snapshot: {
        sequence,
        eventHash,
        occurredAt: new Date(row.occurred_at).toISOString(),
      },
      events: await this.load(tableId, { afterVersion: sequence }),
    };
  }

  async findIdempotency(tableId, idempotencyKey) {
    const result = await this.pool.query(
      `SELECT table_session_id, sequence, event_version, event_type, payload,
              previous_hash, event_hash, occurred_at, request_digest
         FROM table_events
        WHERE table_session_id = $1 AND idempotency_key = $2`,
      [tableId, idempotencyKey],
    );
    if (result.rowCount === 0) return undefined;
    return {
      requestDigest: Buffer.from(result.rows[0].request_digest).toString("hex"),
      event: eventFromRow(result.rows[0]),
    };
  }

  async append({ tableId, expectedVersion, idempotencyKey, requestDigest, event }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const duplicate = await client.query(
        `SELECT table_session_id, sequence, event_version, event_type, payload,
                previous_hash, event_hash, occurred_at, request_digest
           FROM table_events
          WHERE table_session_id = $1 AND idempotency_key = $2`,
        [tableId, idempotencyKey],
      );
      if (duplicate.rowCount > 0) {
        const row = duplicate.rows[0];
        if (Buffer.from(row.request_digest).toString("hex") !== requestDigest) {
          throw new Error("Idempotency key was reused with different input");
        }
        await client.query("COMMIT");
        return { event: eventFromRow(row), duplicate: true };
      }

      if (event.type === "TABLE_CREATED") {
        if (expectedVersion !== 0 || event.sequence !== 1) throw new Error("Opening table version is invalid");
        await client.query(
          `INSERT INTO game_tables (table_session_id, status, version, event_head, updated_at)
           VALUES ($1, 'waiting', 0, decode(repeat('00', 32), 'hex'), $2)`,
          [tableId, event.occurredAt],
        );
      } else {
        const table = await client.query(
          "SELECT version FROM game_tables WHERE table_session_id = $1 FOR UPDATE",
          [tableId],
        );
        if (table.rowCount !== 1) throw new Error("Table does not exist");
        if (Number(table.rows[0].version) !== expectedVersion) throw new Error("Table version conflict");
      }
      if (event.sequence !== expectedVersion + 1) throw new Error("Table event sequence differs from expected version");

      await client.query(
        `INSERT INTO table_events (
           table_session_id, sequence, event_version, event_type, payload,
           previous_hash, event_hash, idempotency_key, request_digest, occurred_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          tableId,
          event.sequence,
          event.version,
          event.type,
          event.payload,
          Buffer.from(event.previousHash, "hex"),
          Buffer.from(event.eventHash, "hex"),
          idempotencyKey,
          Buffer.from(requestDigest, "hex"),
          event.occurredAt,
        ],
      );

      const nextStatus = tableStatus(event.type);
      const currentHandId = event.type === "HAND_STARTED"
        ? event.payload.handId
        : event.type === "HAND_FINISHED" ? null : undefined;
      const turnMutation = mutatesActiveTurn(event);
      const turn = activeTurn(event);
      await client.query(
        `UPDATE game_tables
            SET version = $2,
                status = COALESCE($3, status),
                current_hand_id = CASE WHEN $4 THEN $5 ELSE current_hand_id END,
                action_deadline_at = CASE WHEN $6 THEN $7 ELSE action_deadline_at END,
                event_head = $8,
                updated_at = $9
          WHERE table_session_id = $1`,
        [
          tableId,
          event.sequence,
          nextStatus,
          currentHandId !== undefined,
          currentHandId,
          turnMutation,
          turn?.deadlineAt ?? null,
          Buffer.from(event.eventHash, "hex"),
          event.occurredAt,
        ],
      );

      if (turnMutation) {
        if (turn) {
          await client.query(
            `INSERT INTO table_timeout_leases (
               table_session_id, hand_id, betting_version, player_id, deadline_at,
               lease_owner, lease_until, updated_at
             ) VALUES ($1, $2, $3, $4, $5, NULL, NULL, $6)
             ON CONFLICT (table_session_id) DO UPDATE
               SET hand_id = EXCLUDED.hand_id,
                   betting_version = EXCLUDED.betting_version,
                   player_id = EXCLUDED.player_id,
                   deadline_at = EXCLUDED.deadline_at,
                   lease_owner = NULL,
                   lease_until = NULL,
                   updated_at = EXCLUDED.updated_at`,
            [tableId, turn.handId, turn.bettingVersion, turn.playerId, turn.deadlineAt, event.occurredAt],
          );
        } else {
          await client.query("DELETE FROM table_timeout_leases WHERE table_session_id = $1", [tableId]);
        }
      }

      if (event.sequence % this.snapshotEvery === 0) {
        const snapshotEvents = await client.query(
          `SELECT table_session_id, sequence, event_version, event_type, payload,
                  previous_hash, event_hash, occurred_at
             FROM table_events
            WHERE table_session_id = $1
            ORDER BY sequence ASC`,
          [tableId],
        );
        const state = serializeTableState(reduceTable(snapshotEvents.rows.map(eventFromRow)));
        const stateHash = createHash("sha256").update(canonicalJson(state)).digest();
        await client.query(
          `INSERT INTO table_state_snapshots (
             table_session_id, sequence, event_hash, state, state_hash, occurred_at
           ) VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            tableId,
            event.sequence,
            Buffer.from(event.eventHash, "hex"),
            state,
            stateHash,
            event.occurredAt,
          ],
        );
      }

      await client.query("COMMIT");
      return { event, duplicate: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async claimExpiredDeadlines({ ownerId, now = new Date(), leaseMs = 10_000, limit = 50 }) {
    if (typeof ownerId !== "string" || ownerId.length < 8) throw new Error("Timeout owner id is required");
    if (!Number.isInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 60_000) throw new Error("Timeout lease is invalid");
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("Timeout claim limit is invalid");
    const leaseUntil = new Date(now.getTime() + leaseMs);
    const result = await this.pool.query(
      `WITH candidates AS (
         SELECT table_session_id
           FROM table_timeout_leases
          WHERE deadline_at <= $1
            AND (lease_until IS NULL OR lease_until <= $1)
          ORDER BY deadline_at ASC
          LIMIT $2
          FOR UPDATE SKIP LOCKED
       )
       UPDATE table_timeout_leases AS target
          SET lease_owner = $3,
              lease_until = $4,
              updated_at = $1
         FROM candidates
        WHERE target.table_session_id = candidates.table_session_id
       RETURNING target.table_session_id, target.hand_id, target.betting_version,
                 target.player_id, target.deadline_at, target.lease_owner, target.lease_until`,
      [now, limit, ownerId, leaseUntil],
    );
    return result.rows.map((row) => ({
      tableId: row.table_session_id,
      handId: row.hand_id,
      bettingVersion: Number(row.betting_version),
      playerId: row.player_id,
      deadlineAt: new Date(row.deadline_at).toISOString(),
      leaseOwner: row.lease_owner,
      leaseUntil: new Date(row.lease_until).toISOString(),
    }));
  }

  async listPreviewTableIds() {
    const result = await this.pool.query(
      `SELECT game.table_session_id
         FROM game_tables AS game
         JOIN table_sessions AS session ON session.id = game.table_session_id
        WHERE session.status = 'preview'
          AND game.status IN ('waiting', 'hand_active')
        ORDER BY game.updated_at ASC`,
    );
    return result.rows.map((row) => row.table_session_id);
  }

  async reconcileDeadline({ tableId, expectedVersion, turn }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const table = await client.query(
        "SELECT version FROM game_tables WHERE table_session_id = $1 FOR UPDATE",
        [tableId],
      );
      if (table.rowCount !== 1 || Number(table.rows[0].version) !== expectedVersion) {
        await client.query("ROLLBACK");
        return false;
      }
      await client.query(
        "UPDATE game_tables SET action_deadline_at = $2 WHERE table_session_id = $1",
        [tableId, turn?.deadlineAt ?? null],
      );
      if (turn) {
        await client.query(
          `INSERT INTO table_timeout_leases (
             table_session_id, hand_id, betting_version, player_id, deadline_at,
             lease_owner, lease_until, updated_at
           ) VALUES ($1, $2, $3, $4, $5, NULL, NULL, now())
           ON CONFLICT (table_session_id) DO UPDATE
             SET hand_id = EXCLUDED.hand_id,
                 betting_version = EXCLUDED.betting_version,
                 player_id = EXCLUDED.player_id,
                 deadline_at = EXCLUDED.deadline_at,
                 lease_owner = NULL,
                 lease_until = NULL,
                 updated_at = EXCLUDED.updated_at`,
          [tableId, turn.handId, turn.bettingVersion, turn.playerId, turn.deadlineAt],
        );
      } else {
        await client.query("DELETE FROM table_timeout_leases WHERE table_session_id = $1", [tableId]);
      }
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
