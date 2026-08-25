BEGIN;

-- Provider IDs are bound to the signed wallet. xPoker intentionally stores no
-- tax IDs, identity documents, brokerage credentials, or wallet keys.
CREATE TABLE player_investment_accounts (
  wallet_address text NOT NULL,
  provider text NOT NULL CHECK (provider IN ('alpaca')),
  provider_account_id text NOT NULL CHECK (char_length(provider_account_id) BETWEEN 8 AND 128),
  environment text NOT NULL CHECK (environment IN ('sandbox', 'production')),
  status text NOT NULL CHECK (char_length(status) BETWEEN 2 AND 32),
  opened_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (wallet_address, provider, environment),
  UNIQUE (provider, provider_account_id, environment)
);

CREATE TABLE investment_order_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_address text NOT NULL,
  provider text NOT NULL CHECK (provider IN ('alpaca')),
  provider_order_id text NOT NULL,
  client_order_id text NOT NULL UNIQUE,
  symbol text NOT NULL CHECK (symbol ~ '^[A-Z]{1,8}$'),
  notional_usd numeric(18, 2) NOT NULL CHECK (notional_usd > 0),
  status text NOT NULL,
  provider_payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_order_id)
);

CREATE INDEX investment_order_receipts_wallet_idx
ON investment_order_receipts (wallet_address, created_at DESC);

COMMIT;
