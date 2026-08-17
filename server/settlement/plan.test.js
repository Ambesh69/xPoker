import assert from "node:assert/strict";
import test from "node:test";
import { prepareSettlementPlan, TOKEN_2022_PROGRAM } from "./plan.js";

const SESSION = "14dia6Spfd6qu6Q36caisExYQsLA9si4PqFpqfiQ8Z9S";
const MINT = "SysvarRecentB1ockHashes11111111111111111111";
const TRANSCRIPT_ROOT = "4f".repeat(32);
const asset = Object.freeze({
  mint: MINT,
  tokenProgram: TOKEN_2022_PROGRAM,
  decimals: 8,
  allowlistVersion: "xstocks-v1",
  enabled: true,
});

test("a settlement plan binds one allowlisted mint, transcript, exact vault amount, and claims", () => {
  const input = {
    session: SESSION,
    asset,
    vaultBalanceAtomic: "100",
    transcriptRoot: TRANSCRIPT_ROOT,
    payouts: [
      { player: "11111111111111111111111111111111", amountAtomic: "40" },
      { player: "SysvarRent111111111111111111111111111111111", amountAtomic: "60" },
    ],
  };
  const first = prepareSettlementPlan(input);
  const second = prepareSettlementPlan(input);

  assert.equal(first.totalPayoutAtomic, "100");
  assert.equal(first.mint, MINT);
  assert.equal(first.tokenProgram, TOKEN_2022_PROGRAM);
  assert.equal(first.idempotencyKey, second.idempotencyKey);
  assert.equal(first.claims.length, 2);
});

test("disabled, non-Token-2022, floating, malformed, and imbalanced plans fail closed", () => {
  const base = {
    session: SESSION,
    asset,
    vaultBalanceAtomic: "1",
    transcriptRoot: TRANSCRIPT_ROOT,
    payouts: [{ player: "11111111111111111111111111111111", amountAtomic: "1" }],
  };
  assert.throws(() => prepareSettlementPlan({ ...base, asset: { ...asset, enabled: false } }), /not enabled/);
  assert.throws(() => prepareSettlementPlan({
    ...base,
    asset: { ...asset, tokenProgram: "11111111111111111111111111111111" },
  }), /only the Token-2022/);
  assert.throws(() => prepareSettlementPlan({
    ...base,
    payouts: [{ player: "11111111111111111111111111111111", amountAtomic: 1 }],
  }), /bigint or canonical/);
  assert.throws(() => prepareSettlementPlan({ ...base, transcriptRoot: "00".repeat(32) }), /nonzero/);
  assert.throws(() => prepareSettlementPlan({ ...base, vaultBalanceAtomic: "2" }), /do not equal/);
});
