BEGIN;

CREATE TABLE dealer_signing_keys (
  key_id text PRIMARY KEY CHECK (key_id ~ '^[0-9a-f]{32}$'),
  algorithm text NOT NULL DEFAULT 'Ed25519' CHECK (algorithm = 'Ed25519'),
  public_key_pem text NOT NULL CHECK (
    public_key_pem LIKE '-----BEGIN PUBLIC KEY-----%'
    AND public_key_pem LIKE '%-----END PUBLIC KEY-----%'
  ),
  registered_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION prevent_dealer_signing_key_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'dealer signing keys are append-only';
END;
$$;

CREATE TRIGGER dealer_signing_keys_no_mutation
BEFORE UPDATE OR DELETE ON dealer_signing_keys
FOR EACH ROW EXECUTE FUNCTION prevent_dealer_signing_key_mutation();

COMMIT;
