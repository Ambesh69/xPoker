import { createHash } from "node:crypto";
import { decodeBase58, encodeBase58 } from "../wallet-auth.js";
import { buildSettlementTree, SETTLEMENT_MERKLE_VERSION } from "./merkle.js";

export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

function canonicalPublicKey(value, label) {
  const bytes = decodeBase58(value);
  if (bytes.length !== 32 || encodeBase58(bytes) !== value) {
    throw new Error(`${label} must be a canonical 32-byte Solana public key`);
  }
  return value;
}

function hash32(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value) || /^0{64}$/.test(value)) {
    throw new Error(`${label} must be a nonzero lowercase 32-byte hex string`);
  }
  return value;
}

export function prepareSettlementPlan({
  session,
  asset,
  payouts,
  vaultBalanceAtomic,
  transcriptRoot,
}) {
  canonicalPublicKey(session, "session");
  if (!asset || asset.enabled !== true) throw new Error("Settlement asset is not enabled");
  canonicalPublicKey(asset.mint, "asset mint");
  canonicalPublicKey(asset.tokenProgram, "token program");
  if (asset.tokenProgram !== TOKEN_2022_PROGRAM) {
    throw new Error("xPoker settlement v1 accepts only the Token-2022 program");
  }
  if (!Number.isInteger(asset.decimals) || asset.decimals < 0 || asset.decimals > 18) {
    throw new Error("Asset decimals are invalid");
  }
  if (typeof asset.allowlistVersion !== "string" || !/^[a-z0-9][a-z0-9._-]{7,127}$/i.test(asset.allowlistVersion)) {
    throw new Error("Asset allowlist version is invalid");
  }
  hash32(transcriptRoot, "transcriptRoot");

  const tree = buildSettlementTree({
    session,
    payouts,
    expectedTotalAtomic: vaultBalanceAtomic,
  });
  const digestInput = [
    SETTLEMENT_MERKLE_VERSION,
    session,
    asset.mint,
    asset.tokenProgram,
    asset.allowlistVersion,
    transcriptRoot,
    tree.root,
    tree.totalAtomic,
  ].join("\n");

  return Object.freeze({
    version: SETTLEMENT_MERKLE_VERSION,
    idempotencyKey: createHash("sha256").update(digestInput).digest("hex"),
    session,
    mint: asset.mint,
    tokenProgram: asset.tokenProgram,
    decimals: asset.decimals,
    allowlistVersion: asset.allowlistVersion,
    transcriptRoot,
    settlementRoot: tree.root,
    totalPayoutAtomic: tree.totalAtomic,
    claims: tree.claims,
  });
}

