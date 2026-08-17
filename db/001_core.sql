BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE wallet_challenges (
  id_hash bytea PRIMARY KEY CHECK (octet_length(id_hash) = 32),
  wallet_address text NOT NULL,
  domain text NOT NULL,
  origin text NOT NULL,
  message_hash bytea NOT NULL CHECK (octet_length(message_hash) = 32),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX wallet_challenges_expiry_idx ON wallet_challenges (expires_at) WHERE consumed_at IS NULL;

CREATE TABLE sessions (
  id_hash bytea PRIMARY KEY CHECK (octet_length(id_hash) = 32),
  wallet_address text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sessions_wallet_idx ON sessions (wallet_address, expires_at DESC);

CREATE TABLE asset_allowlist (
  mint_address text PRIMARY KEY,
  chain_id text NOT NULL CHECK (chain_id = 'solana:mainnet'),
  token_program text NOT NULL CHECK (token_program IN ('spl-token', 'spl-token-2022')),
  symbol text NOT NULL,
  decimals smallint NOT NULL CHECK (decimals BETWEEN 0 AND 18),
  multiplier_source text NOT NULL,
  price_source text NOT NULL,
  version text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE rooms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_wallet text,
  visibility text NOT NULL CHECK (visibility IN ('public', 'private')),
  status text NOT NULL CHECK (status IN ('open', 'paused', 'closed')),
  rules jsonb NOT NULL,
  rules_hash bytea NOT NULL CHECK (octet_length(rules_hash) = 32),
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz
);

CREATE TABLE hands (
  id text PRIMARY KEY,
  room_id uuid NOT NULL REFERENCES rooms(id),
  status text NOT NULL CHECK (status IN ('committing', 'beacon_reserved', 'dealing', 'complete', 'aborted')),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  deck_root bytea CHECK (deck_root IS NULL OR octet_length(deck_root) = 32),
  beacon_chain_hash bytea CHECK (beacon_chain_hash IS NULL OR octet_length(beacon_chain_hash) = 32),
  beacon_round bigint CHECK (beacon_round IS NULL OR beacon_round > 0),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE hand_events (
  hand_id text NOT NULL REFERENCES hands(id),
  sequence bigint NOT NULL CHECK (sequence > 0),
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  previous_hash bytea NOT NULL CHECK (octet_length(previous_hash) = 32),
  event_hash bytea NOT NULL CHECK (octet_length(event_hash) = 32),
  signature bytea NOT NULL,
  signer_key_id text NOT NULL,
  idempotency_key text NOT NULL,
  request_digest bytea NOT NULL CHECK (octet_length(request_digest) = 32),
  occurred_at timestamptz NOT NULL,
  inserted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (hand_id, sequence),
  UNIQUE (hand_id, event_hash),
  UNIQUE (hand_id, idempotency_key)
);

CREATE FUNCTION prevent_hand_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'hand_events is append-only';
END;
$$;

CREATE TRIGGER hand_events_no_update
BEFORE UPDATE OR DELETE ON hand_events
FOR EACH ROW EXECUTE FUNCTION prevent_hand_event_mutation();

CREATE TABLE ledger_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_wallet text,
  purpose text NOT NULL CHECK (purpose IN ('player', 'escrow', 'rake', 'withdrawal', 'deposit', 'suspense')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (owner_wallet, purpose)
);

CREATE TABLE ledger_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('deposit', 'buy_in', 'cash_out', 'pot_award', 'rake', 'refund', 'withdrawal', 'reversal')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'posted')),
  idempotency_key text NOT NULL UNIQUE,
  reverses_transaction_id uuid REFERENCES ledger_transactions(id),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  posted_at timestamptz,
  CHECK ((status = 'pending' AND posted_at IS NULL) OR (status = 'posted' AND posted_at IS NOT NULL)),
  CHECK ((kind = 'reversal') = (reverses_transaction_id IS NOT NULL))
);

CREATE TABLE ledger_entries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transaction_id uuid NOT NULL REFERENCES ledger_transactions(id),
  account_id uuid NOT NULL REFERENCES ledger_accounts(id),
  asset_mint text NOT NULL REFERENCES asset_allowlist(mint_address),
  direction text NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount_atomic numeric(78, 0) NOT NULL CHECK (amount_atomic > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ledger_entries_account_idx ON ledger_entries (account_id, asset_mint, id);
CREATE INDEX ledger_entries_transaction_idx ON ledger_entries (transaction_id);

CREATE FUNCTION protect_posted_ledger_entries() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_transaction uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_transaction := OLD.transaction_id;
  ELSE
    target_transaction := NEW.transaction_id;
  END IF;
  IF EXISTS (SELECT 1 FROM ledger_transactions WHERE id = target_transaction AND status = 'posted') THEN
    RAISE EXCEPTION 'entries for a posted transaction are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER ledger_entries_protect_posted
BEFORE INSERT OR UPDATE OR DELETE ON ledger_entries
FOR EACH ROW EXECUTE FUNCTION protect_posted_ledger_entries();

CREATE FUNCTION validate_ledger_posting() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' THEN
      RAISE EXCEPTION 'ledger transactions must be created pending and posted after entries are added';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status = 'posted' AND OLD.status = 'pending' THEN
    IF NOT EXISTS (SELECT 1 FROM ledger_entries WHERE transaction_id = NEW.id) THEN
      RAISE EXCEPTION 'cannot post an empty ledger transaction';
    END IF;
    IF EXISTS (
      SELECT asset_mint
      FROM ledger_entries
      WHERE transaction_id = NEW.id
      GROUP BY asset_mint
      HAVING SUM(CASE direction WHEN 'debit' THEN amount_atomic ELSE -amount_atomic END) <> 0
         OR COUNT(*) < 2
    ) THEN
      RAISE EXCEPTION 'ledger transaction is not balanced per asset';
    END IF;
  END IF;
  IF OLD.status = 'posted' THEN
    RAISE EXCEPTION 'posted ledger transactions are immutable; create a reversal';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER ledger_transactions_validate_posting
BEFORE INSERT OR UPDATE ON ledger_transactions
FOR EACH ROW EXECUTE FUNCTION validate_ledger_posting();

CREATE TABLE settlement_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_address text NOT NULL,
  room_id uuid NOT NULL REFERENCES rooms(id),
  asset_mint text NOT NULL REFERENCES asset_allowlist(mint_address),
  amount_atomic numeric(78, 0) NOT NULL CHECK (amount_atomic > 0),
  kind text NOT NULL CHECK (kind IN ('buy_in', 'cash_out', 'refund')),
  status text NOT NULL CHECK (status IN ('created', 'submitted', 'confirmed', 'failed', 'expired')),
  idempotency_key text NOT NULL UNIQUE,
  chain_signature text UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE outbox_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  topic text NOT NULL,
  aggregate_id text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);

CREATE INDEX outbox_unpublished_idx ON outbox_events (id) WHERE published_at IS NULL;

COMMIT;
