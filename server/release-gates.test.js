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
      redisTransportSecurity: "tls",
      dealerKeyProvider: "aws-kms",
      dealerKeyReference: "arn:aws:kms:us-east-1:111122223333:key/example",
      solanaRpcUrl: "https://rpc.example",
      settlementCluster: "mainnet-beta",
      settlementProgramId: "14dia6Spfd6qu6Q36caisExYQsLA9si4PqFpqfiQ8Z9S",
      settlementProgramBinarySha256: "cd".repeat(32),
      settlementUpgradeAuthority: "SysvarRent111111111111111111111111111111111",
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
      runtime: { assetAllowlistVersion: "allowlist-v1" },
      dealerKey: {
        provider: "aws-kms",
        reference: "arn:aws:kms:us-east-1:111122223333:key/example",
      },
      settlementProgram: {
        cluster: "mainnet-beta",
        programId: "14dia6Spfd6qu6Q36caisExYQsLA9si4PqFpqfiQ8Z9S",
        binarySha256: "cd".repeat(32),
        upgradeAuthority: "SysvarRent111111111111111111111111111111111",
      },
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
  return { config, manifest, authority };
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

test("a configured HTTPS alert receiver satisfies the monitoring integration gate", () => {
  const fixture = productionFixture();
  delete fixture.config.monitoringDsn;
  fixture.config.alertWebhookUrl = "https://alerts.example/xpoker";
  const result = evaluateReleaseGates({ ...fixture, now: new Date("2026-08-17T00:00:00.000Z") });
  assert.equal(result.checks.find((check) => check.name === "monitoring_configured").passed, true);
  assert.equal(result.realValueEnabled, true);
});

test("Railway private Redis transport requires both an internal hostname and explicit attestation", () => {
  const fixture = productionFixture();
  fixture.config.redisUrl = "redis://redis.railway.internal:6379";
  fixture.config.redisTransportSecurity = "railway-private-network";
  let result = evaluateReleaseGates({ ...fixture, now: new Date("2026-08-17T00:00:00.000Z") });
  assert.equal(result.checks.find((check) => check.name === "redis_transport_encrypted").passed, true);

  fixture.config.redisUrl = "redis://redis.attacker.example:6379";
  result = evaluateReleaseGates({ ...fixture, now: new Date("2026-08-17T00:00:00.000Z") });
  assert.equal(result.checks.find((check) => check.name === "redis_transport_encrypted").passed, false);
});

test("dealer isolation requires a provider reference and no local signing key", () => {
  const fixture = productionFixture();
  delete fixture.config.dealerKeyReference;
  let result = evaluateReleaseGates({ ...fixture, now: new Date("2026-08-17T00:00:00.000Z") });
  assert.equal(result.checks.find((check) => check.name === "dealer_key_isolated").passed, false);

  fixture.config.dealerKeyReference = "arn:aws:kms:us-east-1:111122223333:key/example";
  fixture.config.safeBetaSigningKeyPem = "local-private-key";
  result = evaluateReleaseGates({ ...fixture, now: new Date("2026-08-17T00:00:00.000Z") });
  assert.equal(result.checks.find((check) => check.name === "dealer_key_isolated").passed, false);
});

test("GitHub Actions uptime monitoring satisfies the external monitoring gate", () => {
  const fixture = productionFixture();
  delete fixture.config.monitoringDsn;
  fixture.config.externalUptimeProvider = "github-actions";
  fixture.config.externalUptimeUrl = "https://github.com/Ambesh69/xPoker/actions/workflows/uptime.yml";
  const result = evaluateReleaseGates({ ...fixture, now: new Date("2026-08-17T00:00:00.000Z") });
  assert.equal(result.checks.find((check) => check.name === "monitoring_configured").passed, true);
});

test("a remote-signer manifest is bound to the key observed by the live runtime", () => {
  const fixture = productionFixture();
  fixture.config.dealerKeyProvider = "remote-signer";
  fixture.config.dealerSignerUrl = "http://signer.railway.internal:8788";
  fixture.config.dealerSignerToken = "t".repeat(32);
  delete fixture.config.dealerKeyReference;
  const { signature: _signature, ...unsigned } = fixture.manifest;
  unsigned.dealerKey = { provider: "remote-signer", keyId: "ef".repeat(16) };
  fixture.manifest = {
    ...unsigned,
    signature: sign(null, Buffer.from(canonicalJson(unsigned)), fixture.authority.privateKey).toString("base64url"),
  };

  let result = evaluateReleaseGates({
    config: fixture.config,
    manifest: fixture.manifest,
    runtimeAttestations: { dealerSignerKeyId: "ef".repeat(16) },
    now: new Date("2026-08-17T00:00:00.000Z"),
  });
  assert.equal(result.checks.find((check) => check.name === "release_matches_dealer_key").passed, true);

  result = evaluateReleaseGates({
    config: fixture.config,
    manifest: fixture.manifest,
    runtimeAttestations: { dealerSignerKeyId: "01".repeat(16) },
    now: new Date("2026-08-17T00:00:00.000Z"),
  });
  assert.equal(result.checks.find((check) => check.name === "release_matches_dealer_key").passed, false);
});

test("unset optional settlement fields match explicit empty manifest fields", () => {
  const fixture = productionFixture();
  fixture.config.settlementCluster = "devnet";
  delete fixture.config.settlementProgramId;
  delete fixture.config.settlementProgramBinarySha256;
  delete fixture.config.settlementUpgradeAuthority;
  const { signature: _signature, ...unsigned } = fixture.manifest;
  unsigned.settlementProgram = {
    cluster: "devnet",
    programId: "",
    binarySha256: "",
    upgradeAuthority: "",
  };
  fixture.manifest = {
    ...unsigned,
    signature: sign(null, Buffer.from(canonicalJson(unsigned)), fixture.authority.privateKey).toString("base64url"),
  };
  const result = evaluateReleaseGates({
    config: fixture.config,
    manifest: fixture.manifest,
    now: new Date("2026-08-17T00:00:00.000Z"),
  });
  assert.equal(result.checks.find((check) => check.name === "release_matches_settlement").passed, true);
});
