import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFile } from "node:fs/promises";

import { canonicalJson } from "../fairness/protocol.js";

export const RELEASE_MANIFEST_VERSION = "xpoker-release/v1";
export const RELEASE_EVIDENCE_KEYS = Object.freeze([
  "applicationSecurityAudit",
  "cryptographyAudit",
  "settlementContractAudit",
  "penetrationTest",
  "rngCertification",
  "regulatoryApproval",
  "incidentResponseDrill",
]);

const MAX_MANIFEST_BYTES = 64 * 1024;

function ed25519Key(value, create, label) {
  const key = value?.asymmetricKeyType ? value : create(value);
  if (key.asymmetricKeyType !== "ed25519") throw new Error(`${label} must be an Ed25519 key`);
  return key;
}

export function unsignedReleaseManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("Release manifest must be a JSON object");
  }
  const { signature: _signature, ...unsigned } = manifest;
  return unsigned;
}

export function signReleaseManifest(manifest, privateKeyPem) {
  const unsigned = unsignedReleaseManifest(manifest);
  const privateKey = ed25519Key(privateKeyPem, createPrivateKey, "Release authority private key");
  return {
    ...unsigned,
    signature: sign(null, Buffer.from(canonicalJson(unsigned), "utf8"), privateKey).toString("base64url"),
  };
}

export function verifyReleaseManifestSignature(manifest, publicKeyPem) {
  try {
    if (typeof manifest?.signature !== "string" || !manifest.signature) return false;
    const publicKey = ed25519Key(publicKeyPem, createPublicKey, "Release authority public key");
    return verify(
      null,
      Buffer.from(canonicalJson(unsignedReleaseManifest(manifest)), "utf8"),
      publicKey,
      Buffer.from(manifest.signature, "base64url"),
    );
  } catch {
    return false;
  }
}

export function parseReleaseManifestJson(value, { maximumBytes = MAX_MANIFEST_BYTES } = {}) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  if (Buffer.byteLength(value, "utf8") > maximumBytes) throw new Error("Release manifest exceeds the size limit");
  const manifest = JSON.parse(value);
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("Release manifest must be a JSON object");
  }
  return manifest;
}

export async function loadReleaseManifest({ path, json } = {}) {
  if (path && json) throw new Error("Configure only one of RELEASE_MANIFEST_PATH or RELEASE_MANIFEST_JSON");
  if (json) return parseReleaseManifestJson(json);
  if (!path) return undefined;
  return parseReleaseManifestJson(await readFile(path, "utf8"));
}
