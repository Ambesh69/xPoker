import { createPublicKey } from "node:crypto";

import { transcriptKeyId } from "./transcript.js";

function normalizedPublicKey(publicKeyPem) {
  const key = createPublicKey(publicKeyPem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Dealer verification key must be Ed25519");
  return String(key.export({ type: "spki", format: "pem" }));
}

export class PostgresDealerKeyRegistry {
  constructor({ pool } = {}) {
    if (!pool?.query || !pool?.connect) throw new Error("Dealer key registry requires PostgreSQL");
    this.pool = pool;
  }

  async registerCurrentSigner(signer) {
    if (!signer?.publicKeyPem || !signer?.keyId) throw new Error("Dealer signer verification key is required");
    const publicKeyPem = normalizedPublicKey(signer.publicKeyPem());
    const keyId = transcriptKeyId(publicKeyPem);
    if (keyId !== signer.keyId) throw new Error("Dealer signer key id does not match its public key");

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('xpoker-dealer-key-rotation'))");
      const active = await client.query(
        `SELECT DISTINCT event.signer_key_id
           FROM hands hand
           JOIN LATERAL (
             SELECT signer_key_id
               FROM hand_events
              WHERE hand_id = hand.id
              ORDER BY sequence DESC
              LIMIT 1
           ) event ON true
          WHERE hand.status NOT IN ('complete', 'aborted')`,
      );
      const incompatible = active.rows
        .map((row) => row.signer_key_id)
        .filter((activeKeyId) => activeKeyId !== keyId);
      if (incompatible.length > 0) {
        throw new Error("Dealer signing-key rotation blocked while an old-key hand is in flight");
      }

      const existing = await client.query(
        "SELECT public_key_pem FROM dealer_signing_keys WHERE key_id = $1",
        [keyId],
      );
      if (existing.rowCount > 0 && normalizedPublicKey(existing.rows[0].public_key_pem) !== publicKeyPem) {
        throw new Error("Dealer signing-key registry conflict");
      }
      if (existing.rowCount === 0) {
        await client.query(
          "INSERT INTO dealer_signing_keys (key_id, public_key_pem) VALUES ($1, $2)",
          [keyId, publicKeyPem],
        );
      }
      await client.query("COMMIT");
      return Object.freeze({ keyId, publicKeyPem });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async publicKeyPem(keyId) {
    const result = await this.pool.query(
      "SELECT public_key_pem FROM dealer_signing_keys WHERE key_id = $1",
      [keyId],
    );
    if (result.rowCount !== 1) throw new Error("Transcript verification key is unavailable");
    const publicKeyPem = normalizedPublicKey(result.rows[0].public_key_pem);
    if (transcriptKeyId(publicKeyPem) !== keyId) throw new Error("Transcript verification key id is invalid");
    return publicKeyPem;
  }
}
