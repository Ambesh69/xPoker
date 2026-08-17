BEGIN;

-- Safe-beta credits are deliberately isolated from the real-value ledger.
-- They have no mint, withdrawal, settlement, or cash-out path.
CREATE TABLE safe_beta_profiles (
  wallet_address text PRIMARY KEY,
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 2 AND 24),
  is_guest boolean NOT NULL DEFAULT false,
  demo_credit_atomic numeric(20, 0) NOT NULL DEFAULT 100000
    CHECK (demo_credit_atomic BETWEEN 0 AND 18446744073709551615),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE safe_beta_room_memberships (
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  wallet_address text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'member')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, wallet_address)
);

CREATE INDEX safe_beta_memberships_wallet_idx
ON safe_beta_room_memberships (wallet_address, joined_at DESC);

-- Invite codes are returned once to the owner; only their SHA-256 digest is stored.
CREATE TABLE safe_beta_room_invites (
  room_id uuid PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
  code_hash bytea NOT NULL UNIQUE CHECK (octet_length(code_hash) = 32),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One safe-preview table shard per room and demo asset. Real-value sessions use
-- different statuses and are not constrained by this beta-only routing index.
CREATE UNIQUE INDEX table_sessions_safe_beta_shard_idx
ON table_sessions (room_id, asset_mint)
WHERE status = 'preview';

COMMIT;
