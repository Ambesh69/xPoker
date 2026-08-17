BEGIN;

CREATE TABLE game_tables (
  table_session_id uuid PRIMARY KEY REFERENCES table_sessions(id),
  status text NOT NULL CHECK (status IN ('waiting', 'hand_active', 'paused', 'closed')),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  current_hand_id text REFERENCES hands(id),
  action_deadline_at timestamptz,
  event_head bytea NOT NULL CHECK (octet_length(event_head) = 32),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE table_events (
  table_session_id uuid NOT NULL REFERENCES game_tables(table_session_id),
  sequence bigint NOT NULL CHECK (sequence > 0),
  event_version text NOT NULL CHECK (event_version = 'xpoker-table-events/v1'),
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  previous_hash bytea NOT NULL CHECK (octet_length(previous_hash) = 32),
  event_hash bytea NOT NULL CHECK (octet_length(event_hash) = 32),
  idempotency_key text NOT NULL,
  request_digest bytea NOT NULL CHECK (octet_length(request_digest) = 32),
  occurred_at timestamptz NOT NULL,
  inserted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (table_session_id, sequence),
  UNIQUE (table_session_id, event_hash),
  UNIQUE (table_session_id, idempotency_key)
);

CREATE INDEX table_events_reconnect_idx ON table_events (table_session_id, sequence);

CREATE TRIGGER table_events_no_mutation
BEFORE UPDATE OR DELETE ON table_events
FOR EACH ROW EXECUTE FUNCTION prevent_game_record_mutation();

-- Periodic snapshots are append-only acceleration points. The authoritative
-- event row remains the audit anchor for the snapshot sequence and head hash.
CREATE TABLE table_state_snapshots (
  table_session_id uuid NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  event_hash bytea NOT NULL CHECK (octet_length(event_hash) = 32),
  state jsonb NOT NULL,
  state_hash bytea NOT NULL CHECK (octet_length(state_hash) = 32),
  occurred_at timestamptz NOT NULL,
  inserted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (table_session_id, sequence),
  FOREIGN KEY (table_session_id, sequence)
    REFERENCES table_events (table_session_id, sequence)
);

CREATE INDEX table_state_snapshots_latest_idx
ON table_state_snapshots (table_session_id, sequence DESC);

CREATE TRIGGER table_state_snapshots_no_mutation
BEFORE UPDATE OR DELETE ON table_state_snapshots
FOR EACH ROW EXECUTE FUNCTION prevent_game_record_mutation();

-- Operational timeout leases are mutable by design. The version and hand id
-- prevent a delayed worker from timing out a newer action or a later hand.
CREATE TABLE table_timeout_leases (
  table_session_id uuid PRIMARY KEY REFERENCES game_tables(table_session_id),
  hand_id text NOT NULL,
  betting_version bigint NOT NULL CHECK (betting_version >= 0),
  player_id text NOT NULL,
  deadline_at timestamptz NOT NULL,
  lease_owner text,
  lease_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((lease_owner IS NULL) = (lease_until IS NULL))
);

CREATE INDEX table_timeout_leases_due_idx
ON table_timeout_leases (deadline_at, lease_until);

COMMIT;
