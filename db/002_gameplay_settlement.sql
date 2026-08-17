BEGIN;

CREATE TABLE table_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES rooms(id),
  asset_mint text NOT NULL REFERENCES asset_allowlist(mint_address),
  asset_allowlist_version text NOT NULL,
  token_program text NOT NULL CHECK (token_program = 'spl-token-2022'),
  escrow_program_address text,
  escrow_session_address text UNIQUE,
  escrow_vault_address text UNIQUE,
  status text NOT NULL CHECK (status IN ('preview', 'open', 'locked', 'settling', 'refunding', 'closed')),
  total_deposited_atomic numeric(20, 0) NOT NULL DEFAULT 0
    CHECK (total_deposited_atomic BETWEEN 0 AND 18446744073709551615),
  total_released_atomic numeric(20, 0) NOT NULL DEFAULT 0
    CHECK (total_released_atomic BETWEEN 0 AND total_deposited_atomic),
  refund_after_slot numeric(20, 0) CHECK (refund_after_slot BETWEEN 0 AND 18446744073709551615),
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  CHECK ((status = 'closed') = (closed_at IS NOT NULL)),
  CHECK (
    status = 'preview'
    OR (
      escrow_program_address IS NOT NULL
      AND escrow_session_address IS NOT NULL
      AND escrow_vault_address IS NOT NULL
    )
  )
);

CREATE INDEX table_sessions_room_status_idx ON table_sessions (room_id, status);

CREATE TABLE table_seats (
  table_session_id uuid NOT NULL REFERENCES table_sessions(id),
  seat smallint NOT NULL CHECK (seat BETWEEN 0 AND 8),
  wallet_address text NOT NULL,
  buy_in_atomic numeric(20, 0) NOT NULL
    CHECK (buy_in_atomic BETWEEN 1 AND 18446744073709551615),
  stack_atomic numeric(20, 0) NOT NULL
    CHECK (stack_atomic BETWEEN 0 AND 18446744073709551615),
  status text NOT NULL CHECK (status IN ('seated', 'playing', 'sitting_out', 'leaving', 'left')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  left_at timestamptz,
  PRIMARY KEY (table_session_id, seat),
  UNIQUE (table_session_id, wallet_address),
  CHECK ((status = 'left') = (left_at IS NOT NULL))
);

CREATE TABLE hand_state_snapshots (
  hand_id text NOT NULL REFERENCES hands(id),
  version bigint NOT NULL CHECK (version >= 0),
  state jsonb NOT NULL,
  state_hash bytea NOT NULL CHECK (octet_length(state_hash) = 32),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (hand_id, version)
);

CREATE TABLE hand_results (
  hand_id text PRIMARY KEY REFERENCES hands(id),
  table_session_id uuid NOT NULL REFERENCES table_sessions(id),
  game_type text NOT NULL CHECK (game_type IN ('NLH', 'PLO4')),
  rules_hash bytea NOT NULL CHECK (octet_length(rules_hash) = 32),
  transcript_root bytea NOT NULL CHECK (octet_length(transcript_root) = 32),
  result_hash bytea NOT NULL CHECK (octet_length(result_hash) = 32),
  result jsonb NOT NULL,
  pot_atomic numeric(20, 0) NOT NULL CHECK (pot_atomic BETWEEN 0 AND 18446744073709551615),
  rake_atomic numeric(20, 0) NOT NULL CHECK (rake_atomic BETWEEN 0 AND pot_atomic),
  completed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE settlement_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_session_id uuid NOT NULL REFERENCES table_sessions(id),
  version text NOT NULL,
  settlement_root bytea NOT NULL CHECK (octet_length(settlement_root) = 32),
  transcript_root bytea NOT NULL CHECK (octet_length(transcript_root) = 32),
  total_payout_atomic numeric(20, 0) NOT NULL
    CHECK (total_payout_atomic BETWEEN 1 AND 18446744073709551615),
  claim_after_slot numeric(20, 0)
    CHECK (claim_after_slot BETWEEN 0 AND 18446744073709551615),
  status text NOT NULL CHECK (status IN ('prepared', 'submitted', 'committed', 'claimable', 'refunding', 'closed', 'failed')),
  idempotency_key text NOT NULL UNIQUE,
  chain_signature text UNIQUE,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'failed') = (error_code IS NOT NULL))
);

CREATE UNIQUE INDEX settlement_batches_active_idx
ON settlement_batches (table_session_id)
WHERE status IN ('prepared', 'submitted', 'committed', 'claimable', 'refunding');

CREATE TABLE settlement_claims (
  settlement_batch_id uuid NOT NULL REFERENCES settlement_batches(id),
  wallet_address text NOT NULL,
  amount_atomic numeric(20, 0) NOT NULL
    CHECK (amount_atomic BETWEEN 1 AND 18446744073709551615),
  leaf_hash bytea NOT NULL CHECK (octet_length(leaf_hash) = 32),
  proof jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('unclaimed', 'submitted', 'finalized', 'failed')),
  chain_signature text UNIQUE,
  claimed_at timestamptz,
  PRIMARY KEY (settlement_batch_id, wallet_address),
  CHECK ((status = 'finalized') = (claimed_at IS NOT NULL))
);

CREATE FUNCTION prevent_game_record_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER hand_state_snapshots_no_mutation
BEFORE UPDATE OR DELETE ON hand_state_snapshots
FOR EACH ROW EXECUTE FUNCTION prevent_game_record_mutation();

CREATE TRIGGER hand_results_no_mutation
BEFORE UPDATE OR DELETE ON hand_results
FOR EACH ROW EXECUTE FUNCTION prevent_game_record_mutation();

COMMIT;
