import assert from "node:assert/strict";
import test from "node:test";

import { encodeBase58 } from "../wallet-auth.js";
import { TOKEN_2022_PROGRAM } from "./plan.js";
import {
  assertPinnedMintProfile,
  canonicalMintProfile,
  reconcileCustody,
  validateFinalizedTransfer,
} from "./custody.js";

const key = (byte) => encodeBase58(Buffer.alloc(32, byte));
const signature = encodeBase58(Buffer.alloc(64, 11));
const wallet = key(1);
const mint = key(2);
const vaultAddress = key(3);
const authorityAddress = key(4);
const sourceTokenAccount = key(5);
const destinationTokenAccount = key(6);

function profile(overrides = {}) {
  return canonicalMintProfile({
    cluster: "devnet",
    mint,
    tokenProgram: TOKEN_2022_PROGRAM,
    decimals: 8,
    extensions: ["scaledUiAmount", "metadataPointer", "tokenMetadata"],
    mintAuthority: key(7),
    freezeAuthority: key(8),
    ...overrides,
  });
}

function vault() {
  const configured = profile();
  return {
    chainId: "solana:devnet",
    assetMint: mint,
    vaultAddress,
    authorityAddress,
    decimals: 8,
    mintConfigurationSha256: configured.sha256,
  };
}

test("Token-2022 mint profiles are canonical, pinned and reject unaudited extensions", () => {
  const configured = profile();
  assert.equal(assertPinnedMintProfile({
    cluster: "devnet",
    mint,
    tokenProgram: TOKEN_2022_PROGRAM,
    decimals: 8,
    extensions: ["token_metadata", "scaled_ui_amount", "metadata_pointer"],
    mintAuthority: key(7),
    freezeAuthority: key(8),
  }, vault()).sha256, configured.sha256);
  assert.throws(() => profile({ extensions: ["scaledUiAmount", "transferFeeConfig"] }), /separate audit/);
  assert.throws(() => profile({ extensions: ["metadataPointer"] }), /scaled UI/);
});

test("deposits credit only the actual finalized vault delta", () => {
  const result = validateFinalizedTransfer({
    operation: "deposit",
    wallet,
    vault: vault(),
    amountAtomic: "1000",
    minimumCreditAtomic: "990",
    transfer: {
      status: "finalized",
      succeeded: true,
      chainId: "solana:devnet",
      signature,
      instructionIndex: 2,
      finalizedSlot: "123",
      tokenProgram: TOKEN_2022_PROGRAM,
      mint,
      sourceTokenAccount,
      destinationTokenAccount: vaultAddress,
      sourceOwner: wallet,
      destinationOwner: authorityAddress,
      sourceDeltaAtomic: "1000",
      destinationDeltaAtomic: "995",
      finalizedAt: "2026-08-25T00:00:00.000Z",
    },
  });
  assert.equal(result.destinationDeltaAtomic, "995");
  assert.match(result.payloadSha256, /^[0-9a-f]{64}$/);
});

test("withdrawals require exact finalized source and destination deltas", () => {
  const base = {
    status: "finalized",
    succeeded: true,
    chainId: "solana:devnet",
    signature,
    instructionIndex: 0,
    finalizedSlot: "124",
    tokenProgram: TOKEN_2022_PROGRAM,
    mint,
    sourceTokenAccount: vaultAddress,
    destinationTokenAccount,
    sourceOwner: authorityAddress,
    destinationOwner: wallet,
    sourceDeltaAtomic: "500",
    destinationDeltaAtomic: "500",
    finalizedAt: "2026-08-25T00:01:00.000Z",
  };
  assert.equal(validateFinalizedTransfer({
    operation: "withdrawal",
    transfer: base,
    vault: vault(),
    wallet,
    amountAtomic: "500",
  }).destinationDeltaAtomic, "500");
  assert.throws(() => validateFinalizedTransfer({
    operation: "withdrawal",
    transfer: { ...base, destinationDeltaAtomic: "499" },
    vault: vault(),
    wallet,
    amountAtomic: "500",
  }), /amount/);
});

test("reconciliation distinguishes balance, surplus and shortfall without mixing pending withdrawals", () => {
  assert.equal(reconcileCustody({
    vaultBalanceAtomic: "1000",
    playerLiabilityAtomic: "700",
    escrowLiabilityAtomic: "300",
    pendingWithdrawalAtomic: "100",
  }).status, "balanced");
  assert.equal(reconcileCustody({ vaultBalanceAtomic: "1001", playerLiabilityAtomic: "1000" }).status, "surplus");
  assert.equal(reconcileCustody({ vaultBalanceAtomic: "999", playerLiabilityAtomic: "1000" }).status, "shortfall");
});
