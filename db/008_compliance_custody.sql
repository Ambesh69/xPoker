BEGIN;

ALTER TABLE asset_allowlist
  DROP CONSTRAINT asset_allowlist_chain_id_check;

ALTER TABLE asset_allowlist
  ADD CONSTRAINT asset_allowlist_chain_id_check
  CHECK (chain_id IN ('solana:mainnet', 'solana:devnet'));

-- Real-value eligibility is deliberately separate from wallet authentication.
-- Provider references and digests are retained; raw identity documents, IP
-- addresses and biometric data must remain with the approved providers.
CREATE TABLE compliance_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_address text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('identity', 'sanctions', 'geolocation', 'source_of_funds', 'xstocks_eligibility')),
  provider text NOT NULL CHECK (char_length(provider) BETWEEN 2 AND 64),
  provider_reference text NOT NULL CHECK (char_length(provider_reference) BETWEEN 3 AND 256),
  status text NOT NULL CHECK (status IN ('pending', 'pass', 'fail', 'manual_review', 'expired', 'error')),
  country_code text CHECK (country_code IS NULL OR country_code ~ '^[A-Z]{2}$'),
  region_code text CHECK (region_code IS NULL OR region_code ~ '^[A-Z]{2}-[A-Z0-9]{1,3}$'),
  minimum_age_met boolean,
  verified_minimum_age smallint CHECK (verified_minimum_age IS NULL OR verified_minimum_age BETWEEN 18 AND 25),
  sanctions_match boolean,
  pep_match boolean,
  us_person boolean,
  qualified_investor boolean,
  wallet_eligible boolean,
  evidence_sha256 bytea NOT NULL CHECK (octet_length(evidence_sha256) = 32),
  request_digest bytea NOT NULL CHECK (octet_length(request_digest) = 32),
  idempotency_key text NOT NULL UNIQUE CHECK (char_length(idempotency_key) BETWEEN 16 AND 128),
  observed_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > observed_at),
  CHECK (observed_at <= created_at + interval '5 minutes')
);

CREATE INDEX compliance_evidence_wallet_kind_idx
ON compliance_evidence (wallet_address, kind, observed_at DESC, created_at DESC);

CREATE TABLE responsible_gaming_controls (
  wallet_address text PRIMARY KEY,
  self_excluded_until timestamptz,
  cooling_off_until timestamptz,
  daily_deposit_limit_usd_minor numeric(20, 0)
    CHECK (daily_deposit_limit_usd_minor IS NULL OR daily_deposit_limit_usd_minor > 0),
  weekly_deposit_limit_usd_minor numeric(20, 0)
    CHECK (weekly_deposit_limit_usd_minor IS NULL OR weekly_deposit_limit_usd_minor > 0),
  monthly_deposit_limit_usd_minor numeric(20, 0)
    CHECK (monthly_deposit_limit_usd_minor IS NULL OR monthly_deposit_limit_usd_minor > 0),
  session_minutes_limit integer CHECK (session_minutes_limit IS NULL OR session_minutes_limit BETWEEN 1 AND 1440),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    daily_deposit_limit_usd_minor IS NULL
    OR weekly_deposit_limit_usd_minor IS NULL
    OR daily_deposit_limit_usd_minor <= weekly_deposit_limit_usd_minor
  ),
  CHECK (
    weekly_deposit_limit_usd_minor IS NULL
    OR monthly_deposit_limit_usd_minor IS NULL
    OR weekly_deposit_limit_usd_minor <= monthly_deposit_limit_usd_minor
  )
);

CREATE TABLE responsible_gaming_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  wallet_address text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('self_exclusion_started', 'cooling_off_started', 'limits_reduced', 'limits_increase_requested', 'limits_increase_effective')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_type text NOT NULL CHECK (actor_type IN ('player', 'operator', 'provider', 'system')),
  actor_reference text NOT NULL CHECK (char_length(actor_reference) BETWEEN 1 AND 256),
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX responsible_gaming_events_wallet_idx
ON responsible_gaming_events (wallet_address, occurred_at DESC);

CREATE TABLE compliance_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_address text NOT NULL,
  product text NOT NULL CHECK (product IN ('real_value_poker', 'deposit', 'withdrawal', 'table_buy_in', 'xstocks_primary_market', 'xstocks_secondary_transfer')),
  eligible boolean NOT NULL,
  reason_codes text[] NOT NULL CHECK (cardinality(reason_codes) BETWEEN 1 AND 32),
  policy_version text NOT NULL CHECK (policy_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$'),
  policy_sha256 bytea NOT NULL CHECK (octet_length(policy_sha256) = 32),
  jurisdiction_country text CHECK (jurisdiction_country IS NULL OR jurisdiction_country ~ '^[A-Z]{2}$'),
  evidence_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  request_digest bytea NOT NULL CHECK (octet_length(request_digest) = 32),
  idempotency_key text NOT NULL UNIQUE CHECK (char_length(idempotency_key) BETWEEN 16 AND 128),
  decided_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CHECK (expires_at > decided_at)
);

CREATE INDEX compliance_decisions_wallet_product_idx
ON compliance_decisions (wallet_address, product, decided_at DESC);

-- A vault is a canonical raw-token custody boundary. UI multipliers never
-- change raw balances, ledger entries, escrow deposits or payouts.
CREATE TABLE custody_vaults (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_id text NOT NULL CHECK (chain_id IN ('solana:devnet', 'solana:mainnet')),
  asset_mint text NOT NULL,
  token_program text NOT NULL CHECK (token_program = 'spl-token-2022'),
  decimals smallint NOT NULL CHECK (decimals BETWEEN 0 AND 18),
  allowlist_version text NOT NULL CHECK (allowlist_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$'),
  mint_configuration_sha256 bytea NOT NULL CHECK (octet_length(mint_configuration_sha256) = 32),
  supported_extensions text[] NOT NULL DEFAULT '{}'::text[],
  vault_address text NOT NULL UNIQUE,
  authority_address text NOT NULL,
  authority_mode text NOT NULL CHECK (authority_mode IN ('escrow_program', 'hsm_multisig')),
  status text NOT NULL CHECK (status IN ('provisioning', 'active', 'deposits_paused', 'withdrawals_paused', 'frozen', 'retired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chain_id, asset_mint)
);

CREATE TABLE value_deposit_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_address text NOT NULL,
  custody_vault_id uuid NOT NULL REFERENCES custody_vaults(id),
  compliance_decision_id uuid NOT NULL REFERENCES compliance_decisions(id),
  source_token_account text NOT NULL,
  expected_amount_atomic numeric(20, 0) NOT NULL CHECK (expected_amount_atomic BETWEEN 1 AND 18446744073709551615),
  minimum_credit_atomic numeric(20, 0) NOT NULL CHECK (minimum_credit_atomic BETWEEN 1 AND expected_amount_atomic),
  valuation_usd_minor numeric(20, 0) NOT NULL CHECK (valuation_usd_minor BETWEEN 1 AND 18446744073709551615),
  price_snapshot_sha256 bytea NOT NULL CHECK (octet_length(price_snapshot_sha256) = 32),
  actual_credit_atomic numeric(20, 0) CHECK (actual_credit_atomic BETWEEN 1 AND 18446744073709551615),
  status text NOT NULL CHECK (status IN ('created', 'submitted', 'finalized', 'credited', 'rejected', 'expired')),
  idempotency_key text NOT NULL UNIQUE CHECK (char_length(idempotency_key) BETWEEN 16 AND 128),
  chain_signature text UNIQUE,
  expires_at timestamptz NOT NULL,
  finalized_at timestamptz,
  credited_at timestamptz,
  rejection_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at),
  CHECK ((status = 'credited') = (actual_credit_atomic IS NOT NULL AND credited_at IS NOT NULL)),
  CHECK ((status IN ('rejected', 'expired')) = (rejection_code IS NOT NULL))
);

CREATE INDEX value_deposit_intents_wallet_idx
ON value_deposit_intents (wallet_address, created_at DESC);

CREATE TABLE value_withdrawal_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_address text NOT NULL,
  custody_vault_id uuid NOT NULL REFERENCES custody_vaults(id),
  compliance_decision_id uuid NOT NULL REFERENCES compliance_decisions(id),
  destination_token_account text NOT NULL,
  amount_atomic numeric(20, 0) NOT NULL CHECK (amount_atomic BETWEEN 1 AND 18446744073709551615),
  actual_debit_atomic numeric(20, 0) CHECK (actual_debit_atomic BETWEEN 1 AND 18446744073709551615),
  status text NOT NULL CHECK (status IN ('held', 'approved', 'submitting', 'submitted', 'finalized', 'rejected', 'cancelled', 'failed')),
  approval_quorum smallint NOT NULL CHECK (approval_quorum BETWEEN 2 AND 9),
  idempotency_key text NOT NULL UNIQUE CHECK (char_length(idempotency_key) BETWEEN 16 AND 128),
  chain_signature text UNIQUE,
  earliest_submit_at timestamptz NOT NULL,
  submitted_at timestamptz,
  finalized_at timestamptz,
  terminal_code text,
  last_error_code text,
  submission_attempts integer NOT NULL DEFAULT 0 CHECK (submission_attempts BETWEEN 0 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'submitted' OR (submitted_at IS NOT NULL AND finalized_at IS NULL)),
  CHECK (status <> 'finalized' OR (submitted_at IS NOT NULL AND finalized_at IS NOT NULL AND actual_debit_atomic IS NOT NULL)),
  CHECK ((status IN ('rejected', 'cancelled', 'failed')) = (terminal_code IS NOT NULL))
);

CREATE INDEX value_withdrawal_requests_wallet_idx
ON value_withdrawal_requests (wallet_address, created_at DESC);

CREATE TABLE value_withdrawal_approvals (
  withdrawal_request_id uuid NOT NULL REFERENCES value_withdrawal_requests(id),
  operator_wallet text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('approve', 'reject')),
  request_digest bytea NOT NULL CHECK (octet_length(request_digest) = 32),
  decided_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (withdrawal_request_id, operator_wallet)
);

CREATE TABLE value_chain_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_type text NOT NULL CHECK (operation_type IN ('deposit', 'withdrawal', 'settlement_claim', 'refund')),
  operation_id uuid NOT NULL,
  chain_id text NOT NULL CHECK (chain_id IN ('solana:devnet', 'solana:mainnet')),
  chain_signature text NOT NULL,
  instruction_index integer NOT NULL CHECK (instruction_index >= 0),
  finalized_slot numeric(20, 0) NOT NULL CHECK (finalized_slot BETWEEN 1 AND 18446744073709551615),
  asset_mint text NOT NULL,
  token_program text NOT NULL CHECK (token_program = 'spl-token-2022'),
  source_token_account text NOT NULL,
  destination_token_account text NOT NULL,
  source_owner text NOT NULL,
  destination_owner text NOT NULL,
  source_delta_atomic numeric(20, 0) NOT NULL CHECK (source_delta_atomic BETWEEN 1 AND 18446744073709551615),
  destination_delta_atomic numeric(20, 0) NOT NULL CHECK (destination_delta_atomic BETWEEN 1 AND 18446744073709551615),
  payload_sha256 bytea NOT NULL CHECK (octet_length(payload_sha256) = 32),
  finalized_at timestamptz NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chain_id, chain_signature, instruction_index),
  UNIQUE (operation_type, operation_id)
);

CREATE TABLE custody_reconciliations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  custody_vault_id uuid NOT NULL REFERENCES custody_vaults(id),
  finalized_slot numeric(20, 0) NOT NULL CHECK (finalized_slot BETWEEN 1 AND 18446744073709551615),
  vault_balance_atomic numeric(20, 0) NOT NULL CHECK (vault_balance_atomic BETWEEN 0 AND 18446744073709551615),
  player_liability_atomic numeric(20, 0) NOT NULL CHECK (player_liability_atomic BETWEEN 0 AND 18446744073709551615),
  escrow_liability_atomic numeric(20, 0) NOT NULL CHECK (escrow_liability_atomic BETWEEN 0 AND 18446744073709551615),
  pending_withdrawal_atomic numeric(20, 0) NOT NULL CHECK (pending_withdrawal_atomic BETWEEN 0 AND 18446744073709551615),
  difference_atomic numeric(78, 0) NOT NULL,
  status text NOT NULL CHECK (status IN ('balanced', 'surplus', 'shortfall', 'error')),
  evidence_sha256 bytea NOT NULL CHECK (octet_length(evidence_sha256) = 32),
  reconciled_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (custody_vault_id, finalized_slot)
);

CREATE FUNCTION prevent_real_value_evidence_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER compliance_evidence_no_mutation
BEFORE UPDATE OR DELETE ON compliance_evidence
FOR EACH ROW EXECUTE FUNCTION prevent_real_value_evidence_mutation();

CREATE TRIGGER compliance_decisions_no_mutation
BEFORE UPDATE OR DELETE ON compliance_decisions
FOR EACH ROW EXECUTE FUNCTION prevent_real_value_evidence_mutation();

CREATE TRIGGER responsible_gaming_events_no_mutation
BEFORE UPDATE OR DELETE ON responsible_gaming_events
FOR EACH ROW EXECUTE FUNCTION prevent_real_value_evidence_mutation();

CREATE TRIGGER value_withdrawal_approvals_no_mutation
BEFORE UPDATE OR DELETE ON value_withdrawal_approvals
FOR EACH ROW EXECUTE FUNCTION prevent_real_value_evidence_mutation();

CREATE TRIGGER value_chain_observations_no_mutation
BEFORE UPDATE OR DELETE ON value_chain_observations
FOR EACH ROW EXECUTE FUNCTION prevent_real_value_evidence_mutation();

CREATE TRIGGER custody_reconciliations_no_mutation
BEFORE UPDATE OR DELETE ON custody_reconciliations
FOR EACH ROW EXECUTE FUNCTION prevent_real_value_evidence_mutation();

COMMIT;
