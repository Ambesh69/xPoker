import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import { canonicalJson } from "../fairness/protocol.js";
import { evaluateReleaseGates } from "./release-gates.js";

function evidence() {
  return {
    status: "pass",
    provider: "Independent Lab",
    reportSha256: "ab".repeat(32),
    expiresAt: "2027-08-17T00:00:00.000Z",
  };
}

function productionFixture() {
  const authority = generateKeyPairSync("ed25519");
  const buildCommit = "a".repeat(40);
  const config = {
      realValueMode: true,
      databaseUrl: "postgresql://db/xpoker?sslmode=verify-full",
      redisUrl: "rediss://redis.example",
      dealerKeyProvider: "aws-kms",
      solanaRpcUrl: "https://rpc.example",
      allowedOrigins: ["https://xpoker.example"],
      geofencingProvider: "provider",
      identityProvider: "provider",
      monitoringDsn: "https://monitor.example/project",
      assetAllowlistVersion: "allowlist-v1",
      buildCommit,
      releaseAuthorityPublicKeyPem: authority.publicKey.export({ type: "spki", format: "pem" }),
  };
  const unsigned = {
      version: "xpoker-release/v1",
      buildCommit,
      evidence: {
        applicationSecurityAudit: evidence(),
        cryptographyAudit: evidence(),
        settlementContractAudit: evidence(),
        penetrationTest: evidence(),
        rngCertification: evidence(),
        regulatoryApproval: evidence(),
        incidentResponseDrill: evidence(),
      },
  };
  const manifest = {
    ...unsigned,
    signature: sign(null, Buffer.from(canonicalJson(unsigned)), authority.privateKey).toString("base64url"),
  };
  return { config, manifest };
}

test("real-value mode opens only when every gate passes", () => {
  const fixture = productionFixture();
  const result = evaluateReleaseGates({ ...fixture, now: new Date("2026-08-17T00:00:00.000Z") });
  assert.equal(result.realValueEnabled, true);
  assert.deepEqual(result.failed, []);
});

test("one missing or expired control keeps real-value mode closed", () => {
  const fixture = productionFixture();
  fixture.manifest.evidence.cryptographyAudit.expiresAt = "2025-01-01T00:00:00.000Z";
  const result = evaluateReleaseGates({ ...fixture, now: new Date("2026-08-17T00:00:00.000Z") });
  assert.equal(result.realValueEnabled, false);
  assert.ok(result.failed.includes("cryptography_audit"));
  assert.ok(result.failed.includes("release_manifest_signature"));
});
