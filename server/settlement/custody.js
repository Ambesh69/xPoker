import { createHash } from "node:crypto";

import { canonicalJson } from "../../fairness/protocol.js";
import { decodeBase58, encodeBase58 } from "../wallet-auth.js";
import { TOKEN_2022_PROGRAM } from "./plan.js";

export const CUSTODY_PROTOCOL_VERSION = "xpoker-custody/v1";
export const MINT_PROFILE_VERSION = "xpoker-token2022-mint-profile/v1";

const ALLOWED_MINT_EXTENSIONS = new Set([
  "metadata_pointer",
  "scaled_ui_amount",
  "token_metadata",
]);

function fail(message, code = "custody_validation_failed") {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function publicKey(value, label) {
  try {
    const bytes = decodeBase58(value);
    if (bytes.length !== 32 || encodeBase58(bytes) !== value) throw new Error();
    return value;
  } catch {
    fail(`${label} must be a canonical Solana public key`);
  }
}

function signature(value) {
  try {
    const bytes = decodeBase58(value);
    if (bytes.length !== 64 || encodeBase58(bytes) !== value) throw new Error();
    return value;
  } catch {
    fail("Chain signature must be a canonical Solana transaction signature");
  }
}

function u64(value, label, { allowZero = false } = {}) {
  try {
    const parsed = BigInt(value);
    if (parsed < (allowZero ? 0n : 1n) || parsed > 18_446_744_073_709_551_615n) throw new Error();
    return parsed;
  } catch {
    fail(`${label} must be an unsigned 64-bit integer${allowZero ? "" : " greater than zero"}`);
  }
}

function hex32(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/i.test(value)) fail(`${label} must be a SHA-256 digest`);
  return value.toLowerCase();
}

function extensionName(value) {
  if (typeof value !== "string" || !value.trim()) fail("Token-2022 extension name is invalid");
  return value.trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[ -]+/g, "_")
    .toLowerCase();
}

function clusterChainId(cluster) {
  if (cluster === "devnet") return "solana:devnet";
  if (cluster === "mainnet-beta") return "solana:mainnet";
  fail("Custody supports only Solana devnet or mainnet-beta");
}

export function canonicalMintProfile({
  cluster,
  mint,
  tokenProgram,
  decimals,
  extensions,
  mintAuthority = null,
  freezeAuthority = null,
} = {}) {
  const normalizedExtensions = [...new Set((extensions ?? []).map(extensionName))].sort();
  if (!normalizedExtensions.includes("scaled_ui_amount")) {
    fail("xStocks mint profile must include the Token-2022 scaled UI amount extension", "unsupported_mint_profile");
  }
  const unsupported = normalizedExtensions.filter((name) => !ALLOWED_MINT_EXTENSIONS.has(name));
  if (unsupported.length > 0) {
    fail(`Token-2022 mint extensions require a separate audit: ${unsupported.join(", ")}`, "unsupported_mint_extension");
  }
  if (tokenProgram !== TOKEN_2022_PROGRAM) fail("Custody accepts only Token-2022", "invalid_token_program");
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) fail("Mint decimals are invalid");
  const profile = {
    version: MINT_PROFILE_VERSION,
    chainId: clusterChainId(cluster),
    mint: publicKey(mint, "Mint"),
    tokenProgram: publicKey(tokenProgram, "Token program"),
    decimals,
    extensions: normalizedExtensions,
    mintAuthority: mintAuthority === null ? null : publicKey(mintAuthority, "Mint authority"),
    freezeAuthority: freezeAuthority === null ? null : publicKey(freezeAuthority, "Freeze authority"),
  };
  return Object.freeze({
    ...profile,
    extensions: Object.freeze(profile.extensions),
    sha256: createHash("sha256").update(canonicalJson(profile)).digest("hex"),
  });
}

export function assertPinnedMintProfile(actual, vault) {
  const profile = canonicalMintProfile(actual);
  if (profile.chainId !== vault.chainId) fail("Mint profile is from the wrong cluster", "mint_profile_mismatch");
  if (profile.mint !== vault.assetMint) fail("Mint profile does not match the custody vault", "mint_profile_mismatch");
  if (profile.decimals !== vault.decimals) fail("Mint decimals changed after allowlisting", "mint_profile_mismatch");
  if (profile.sha256 !== hex32(vault.mintConfigurationSha256, "Pinned mint profile")) {
    fail("Token-2022 mint configuration changed after allowlisting", "mint_profile_mismatch");
  }
  return profile;
}

export function validateFinalizedTransfer({ operation, transfer, vault, wallet, amountAtomic, minimumCreditAtomic } = {}) {
  if (!["deposit", "withdrawal"].includes(operation)) fail("Transfer operation is invalid");
  const expectedAmount = u64(amountAtomic, "Expected transfer amount");
  const minimumCredit = minimumCreditAtomic === undefined
    ? expectedAmount
    : u64(minimumCreditAtomic, "Minimum credit amount");
  if (minimumCredit > expectedAmount) fail("Minimum credit cannot exceed the expected amount");
  if (!transfer || transfer.status !== "finalized" || transfer.succeeded !== true) {
    fail("Transfer is not successfully finalized", "transfer_not_finalized");
  }
  if (transfer.chainId !== vault.chainId) fail("Transfer is from the wrong cluster", "transfer_mismatch");
  signature(transfer.signature);
  if (!Number.isInteger(transfer.instructionIndex) || transfer.instructionIndex < 0) fail("Transfer instruction index is invalid");
  u64(transfer.finalizedSlot, "Finalized slot");
  if (transfer.tokenProgram !== TOKEN_2022_PROGRAM) fail("Transfer did not use Token-2022", "invalid_token_program");
  if (publicKey(transfer.mint, "Transfer mint") !== vault.assetMint) fail("Transfer mint does not match the vault", "transfer_mismatch");
  const canonicalWallet = publicKey(wallet, "Wallet");
  const source = publicKey(transfer.sourceTokenAccount, "Source token account");
  const destination = publicKey(transfer.destinationTokenAccount, "Destination token account");
  const sourceOwner = publicKey(transfer.sourceOwner, "Source owner");
  const destinationOwner = publicKey(transfer.destinationOwner, "Destination owner");
  const sourceDelta = u64(transfer.sourceDeltaAtomic, "Source balance delta");
  const destinationDelta = u64(transfer.destinationDeltaAtomic, "Destination balance delta");

  if (operation === "deposit") {
    if (sourceOwner !== canonicalWallet || destination !== vault.vaultAddress || destinationOwner !== vault.authorityAddress) {
      fail("Deposit transfer endpoints do not match the intent", "transfer_mismatch");
    }
    if (sourceDelta !== expectedAmount || destinationDelta < minimumCredit || destinationDelta > expectedAmount) {
      fail("Deposit transfer amount does not match the intent", "transfer_amount_mismatch");
    }
  } else {
    if (source !== vault.vaultAddress || sourceOwner !== vault.authorityAddress || destinationOwner !== canonicalWallet) {
      fail("Withdrawal transfer endpoints do not match the request", "transfer_mismatch");
    }
    if (sourceDelta !== expectedAmount || destinationDelta !== expectedAmount) {
      fail("Withdrawal transfer amount does not match the request", "transfer_amount_mismatch");
    }
  }

  return Object.freeze({
    version: CUSTODY_PROTOCOL_VERSION,
    operation,
    chainId: transfer.chainId,
    signature: transfer.signature,
    instructionIndex: transfer.instructionIndex,
    finalizedSlot: String(transfer.finalizedSlot),
    mint: transfer.mint,
    tokenProgram: transfer.tokenProgram,
    sourceTokenAccount: source,
    destinationTokenAccount: destination,
    sourceOwner,
    destinationOwner,
    sourceDeltaAtomic: String(sourceDelta),
    destinationDeltaAtomic: String(destinationDelta),
    finalizedAt: new Date(transfer.finalizedAt).toISOString(),
    payloadSha256: createHash("sha256").update(canonicalJson(transfer)).digest("hex"),
  });
}

export function reconcileCustody({ vaultBalanceAtomic, playerLiabilityAtomic, escrowLiabilityAtomic = 0, pendingWithdrawalAtomic = 0 } = {}) {
  const vault = u64(vaultBalanceAtomic, "Vault balance", { allowZero: true });
  const player = u64(playerLiabilityAtomic, "Player liability", { allowZero: true });
  const escrow = u64(escrowLiabilityAtomic, "Escrow liability", { allowZero: true });
  const pending = u64(pendingWithdrawalAtomic, "Pending withdrawal", { allowZero: true });
  if (pending > player) fail("Pending withdrawals exceed player liabilities", "reconciliation_invalid");
  const difference = vault - player - escrow;
  return Object.freeze({
    vaultBalanceAtomic: String(vault),
    playerLiabilityAtomic: String(player),
    escrowLiabilityAtomic: String(escrow),
    pendingWithdrawalAtomic: String(pending),
    differenceAtomic: String(difference),
    status: difference === 0n ? "balanced" : difference > 0n ? "surplus" : "shortfall",
  });
}

export const SUPPORTED_MINT_EXTENSIONS = Object.freeze([...ALLOWED_MINT_EXTENSIONS].sort());
export { clusterChainId };
