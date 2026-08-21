import { createHash, createPublicKey } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

import {
  RELEASE_EVIDENCE_KEYS,
  RELEASE_MANIFEST_VERSION,
  signReleaseManifest,
  verifyReleaseManifestSignature,
} from "./release-manifest.js";

function required(value, label) {
  if (!value) throw new Error(`${label} is required`);
  return value;
}

function evidenceTemplate() {
  return Object.fromEntries(RELEASE_EVIDENCE_KEYS.map((key) => [key, {
    status: "pending",
    provider: "",
    reportSha256: "",
    expiresAt: "",
  }]));
}

function releaseAuthorityKeyId(privateKeyPem) {
  const der = createPublicKey(privateKeyPem).export({ type: "spki", format: "der" });
  return createHash("sha256").update(der).digest("hex");
}

function generatedManifest(env) {
  const privateKeyPem = required(env.RELEASE_AUTHORITY_PRIVATE_KEY_PEM, "RELEASE_AUTHORITY_PRIVATE_KEY_PEM");
  const buildCommit = required(env.BUILD_COMMIT, "BUILD_COMMIT");
  if (!/^[0-9a-f]{40}$/i.test(buildCommit)) throw new Error("BUILD_COMMIT must be a full 40-character Git commit");
  const dealerSignerKeyId = required(env.DEALER_SIGNER_KEY_ID, "DEALER_SIGNER_KEY_ID");
  if (!/^[0-9a-f]{32}$/i.test(dealerSignerKeyId)) throw new Error("DEALER_SIGNER_KEY_ID must be a 128-bit transcript key ID");
  const unsigned = {
    version: RELEASE_MANIFEST_VERSION,
    generatedAt: new Date().toISOString(),
    buildCommit,
    releaseAuthorityKeyId: releaseAuthorityKeyId(privateKeyPem),
    runtime: {
      assetAllowlistVersion: required(env.ASSET_ALLOWLIST_VERSION, "ASSET_ALLOWLIST_VERSION"),
      apiDeploymentId: env.API_DEPLOYMENT_ID ?? "",
      signerDeploymentId: env.SIGNER_DEPLOYMENT_ID ?? "",
      certificationEvidenceSha256: env.CERTIFICATION_EVIDENCE_SHA256 ?? "",
    },
    dealerKey: {
      provider: required(env.DEALER_KEY_PROVIDER, "DEALER_KEY_PROVIDER"),
      keyId: dealerSignerKeyId,
    },
    settlementProgram: {
      cluster: env.SETTLEMENT_CLUSTER ?? "",
      programId: env.SETTLEMENT_PROGRAM_ID ?? "",
      binarySha256: env.SETTLEMENT_PROGRAM_BINARY_SHA256 ?? "",
      upgradeAuthority: env.SETTLEMENT_UPGRADE_AUTHORITY ?? "",
    },
    evidence: evidenceTemplate(),
  };
  return signReleaseManifest(unsigned, privateKeyPem);
}

async function main([command, path = "release-manifest.json"]) {
  if (command === "generate") {
    const manifest = generatedManifest(process.env);
    const publicKeyPem = createPublicKey(process.env.RELEASE_AUTHORITY_PRIVATE_KEY_PEM)
      .export({ type: "spki", format: "pem" });
    if (!verifyReleaseManifestSignature(manifest, publicKeyPem)) {
      throw new Error("Generated release manifest failed its signature self-check");
    }
    await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    console.log(JSON.stringify({
      valid: true,
      path,
      version: manifest.version,
      buildCommit: manifest.buildCommit,
      releaseAuthorityKeyId: manifest.releaseAuthorityKeyId,
    }));
    return;
  }
  if (command === "verify") {
    const manifest = JSON.parse(await readFile(path, "utf8"));
    const valid = verifyReleaseManifestSignature(
      manifest,
      required(process.env.RELEASE_AUTHORITY_PUBLIC_KEY_PEM, "RELEASE_AUTHORITY_PUBLIC_KEY_PEM"),
    );
    console.log(JSON.stringify({ valid, version: manifest.version, buildCommit: manifest.buildCommit }));
    if (!valid) process.exitCode = 1;
    return;
  }
  throw new Error("Usage: node server/release-manifest-cli.js <generate|verify> [path]");
}

await main(process.argv.slice(2));
