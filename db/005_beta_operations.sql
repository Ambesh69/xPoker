BEGIN;

ALTER TABLE safe_beta_profiles
  ADD COLUMN bio text NOT NULL DEFAULT '' CHECK (char_length(bio) <= 160),
  ADD COLUMN avatar_style text NOT NULL DEFAULT 'felt' CHECK (avatar_style IN ('felt', 'river', 'ticker', 'night')),
  ADD COLUMN status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'banned')),
  ADD COLUMN beta_access_granted_at timestamptz,
  ADD COLUMN last_seen_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX safe_beta_profiles_status_idx
ON safe_beta_profiles (status, last_seen_at DESC);

CREATE TABLE safe_beta_operators (
  wallet_address text PRIMARY KEY,
  role text NOT NULL CHECK (role IN ('moderator', 'admin')),
  active boolean NOT NULL DEFAULT true,
  granted_by_wallet text NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CHECK ((active AND revoked_at IS NULL) OR (NOT active AND revoked_at IS NOT NULL))
);

CREATE TABLE safe_beta_access_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash bytea NOT NULL UNIQUE CHECK (octet_length(code_hash) = 32),
  label text NOT NULL CHECK (char_length(label) BETWEEN 2 AND 48),
  max_uses integer NOT NULL CHECK (max_uses BETWEEN 1 AND 1000),
  use_count integer NOT NULL DEFAULT 0 CHECK (use_count BETWEEN 0 AND max_uses),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_by_wallet text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);

CREATE INDEX safe_beta_access_invites_active_idx
ON safe_beta_access_invites (expires_at, created_at DESC)
WHERE revoked_at IS NULL;

CREATE TABLE safe_beta_access_redemptions (
  invite_id uuid NOT NULL REFERENCES safe_beta_access_invites(id),
  wallet_address text NOT NULL UNIQUE,
  redeemed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (invite_id, wallet_address)
);

CREATE TABLE safe_beta_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_wallet text NOT NULL,
  reported_wallet text,
  hand_id text REFERENCES hands(id),
  category text NOT NULL CHECK (category IN ('collusion', 'harassment', 'stalling', 'bug', 'fairness', 'other')),
  details text NOT NULL CHECK (char_length(details) BETWEEN 10 AND 1000),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewing', 'resolved', 'dismissed')),
  assigned_to_wallet text,
  resolution_note text CHECK (resolution_note IS NULL OR char_length(resolution_note) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CHECK ((status IN ('resolved', 'dismissed')) = (resolved_at IS NOT NULL))
);

CREATE INDEX safe_beta_reports_queue_idx
ON safe_beta_reports (status, created_at ASC);

CREATE INDEX safe_beta_reports_reporter_idx
ON safe_beta_reports (reporter_wallet, created_at DESC);

CREATE TABLE operations_incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fingerprint bytea NOT NULL UNIQUE CHECK (octet_length(fingerprint) = 32),
  category text NOT NULL CHECK (char_length(category) BETWEEN 2 AND 64),
  severity text NOT NULL CHECK (severity IN ('warning', 'error', 'critical')),
  message text NOT NULL CHECK (char_length(message) BETWEEN 1 AND 1000),
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  occurrences bigint NOT NULL DEFAULT 1 CHECK (occurrences > 0),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

CREATE INDEX operations_incidents_queue_idx
ON operations_incidents (status, severity, last_seen_at DESC);

CREATE TABLE safe_beta_moderation_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  operator_wallet text NOT NULL,
  action text NOT NULL CHECK (char_length(action) BETWEEN 3 AND 64),
  subject_type text NOT NULL CHECK (subject_type IN ('player', 'report', 'invite', 'incident')),
  subject_id text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX safe_beta_moderation_events_recent_idx
ON safe_beta_moderation_events (created_at DESC);

CREATE FUNCTION prevent_operations_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'operations audit events are append-only';
END;
$$;

CREATE TRIGGER safe_beta_moderation_events_no_mutation
BEFORE UPDATE OR DELETE ON safe_beta_moderation_events
FOR EACH ROW EXECUTE FUNCTION prevent_operations_event_mutation();

COMMIT;
