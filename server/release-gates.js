import { createPublicKey, verify } from "node:crypto";

import { canonicalJson } from "../fairness/protocol.js";
import { decodeBase58, encodeBase58 } from "./wallet-auth.js";

const HEX_32 = /^[0-9a-f]{64}$/i;

function isFuture(value, now) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > now.getTime();
}

function evidencePassed(item, now) {
  return item?.status === "pass"
    && typeof item.provider === "string"
    && item.provider.length >= 2
    && HEX_32.test(item.reportSha256 ?? "")
    && isFuture(item.expiresAt, now);
}

function manifestSignaturePassed(manifest, publicKeyPem) {
  try {
    const { signature, ...unsigned } = manifest;
    const publicKey = createPublicKey(publicKeyPem);
    if (publicKey.asymmetricKeyType !== "ed25519") return false;
    return verify(
      null,
      Buffer.from(canonicalJson(unsigned), "utf8"),
      publicKey,
      Buffer.from(signature, "base64url"),
    );
  } catch {
    return false;
  }
}

function isSolanaPublicKey(value) {
  try {
    const bytes = decodeBase58(value);
    return bytes.length === 32 && encodeBase58(bytes) === value;
  } catch {
    return false;
  }
}

export function evaluateReleaseGates({ config, manifest, now = new Date() }) {
  const checks = [
    ["postgres_tls", config.databaseUrl?.startsWith("postgres") && /sslmode=(require|verify-full)/.test(config.databaseUrl)],
    ["redis_tls", config.redisUrl?.startsWith("rediss://")],
    ["dealer_key_isolated", config.dealerKeyProvider === "aws-kms" || config.dealerKeyProvider === "vault"],
    ["solana_rpc_tls", config.solanaRpcUrl?.startsWith("https://")],
    ["settlement_mainnet", config.settlementCluster === "mainnet-beta"],
    ["settlement_program_configured", isSolanaPublicKey(config.settlementProgramId)],
    ["settlement_binary_pinned", HEX_32.test(config.settlementProgramBinarySha256 ?? "")],
    ["settlement_upgrade_authority", config.settlementUpgradeAuthority === "immutable" || isSolanaPublicKey(config.settlementUpgradeAuthority)],
    ["strict_origins", config.allowedOrigins.length > 0 && config.allowedOrigins.every((origin) => origin.startsWith("https://"))],
    ["geofencing_configured", Boolean(config.geofencingProvider)],
    ["identity_controls_configured", Boolean(config.identityProvider)],
    ["monitoring_configured", Boolean(config.monitoringDsn)],
    ["asset_allowlist_versioned", /^[a-z0-9][a-z0-9._-]{7,127}$/i.test(config.assetAllowlistVersion ?? "")],
    ["release_manifest_version", manifest?.version === "xpoker-release/v1"],
    ["release_matches_build", manifest?.buildCommit === config.buildCommit && /^[0-9a-f]{40}$/i.test(config.buildCommit ?? "")],
    ["release_matches_settlement", manifest?.settlementProgram?.cluster === config.settlementCluster
      && manifest?.settlementProgram?.programId === config.settlementProgramId
      && manifest?.settlementProgram?.binarySha256 === config.settlementProgramBinarySha256
      && manifest?.settlementProgram?.upgradeAuthority === config.settlementUpgradeAuthority],
    ["release_manifest_signature", manifestSignaturePassed(manifest, config.releaseAuthorityPublicKeyPem)],
    ["application_security_audit", evidencePassed(manifest?.evidence?.applicationSecurityAudit, now)],
    ["cryptography_audit", evidencePassed(manifest?.evidence?.cryptographyAudit, now)],
    ["settlement_contract_audit", evidencePassed(manifest?.evidence?.settlementContractAudit, now)],
    ["penetration_test", evidencePassed(manifest?.evidence?.penetrationTest, now)],
    ["rng_certification", evidencePassed(manifest?.evidence?.rngCertification, now)],
    ["regulatory_approval", evidencePassed(manifest?.evidence?.regulatoryApproval, now)],
    ["incident_response_drill", evidencePassed(manifest?.evidence?.incidentResponseDrill, now)],
  ].map(([name, passed]) => ({ name, passed: passed === true }));

  const failed = checks.filter((check) => !check.passed).map((check) => check.name);
  return Object.freeze({
    realValueRequested: config.realValueMode,
    realValueEnabled: config.realValueMode && failed.length === 0,
    checks,
    failed,
  });
}

export function assertRealValueReady(result) {
  if (!result.realValueEnabled) {
    throw new Error(`Real-value mode is blocked by release gates: ${result.failed.join(", ") || "not requested"}`);
  }
}
