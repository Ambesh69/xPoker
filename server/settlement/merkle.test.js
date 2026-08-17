import assert from "node:assert/strict";
import test from "node:test";
import { buildSettlementTree, settlementLeaf, verifySettlementClaim } from "./merkle.js";

const SESSION = "14dia6Spfd6qu6Q36caisExYQsLA9si4PqFpqfiQ8Z9S";
const ALICE = "11111111111111111111111111111111";
const BOB = "SysvarRent111111111111111111111111111111111";
const CAROL = "SysvarC1ock11111111111111111111111111111111";

test("settlement trees are deterministic, conserve u64 values, and verify every claim", () => {
  const first = buildSettlementTree({
    session: SESSION,
    expectedTotalAtomic: "100",
    payouts: [
      { player: CAROL, amountAtomic: "9" },
      { player: ALICE, amountAtomic: 40n },
      { player: BOB, amountAtomic: "51" },
    ],
  });
  const second = buildSettlementTree({
    session: SESSION,
    expectedTotalAtomic: 100n,
    payouts: [
      { player: BOB, amountAtomic: "51" },
      { player: CAROL, amountAtomic: "9" },
      { player: ALICE, amountAtomic: "40" },
    ],
  });

  assert.equal(first.root, second.root);
  assert.equal(first.totalAtomic, "100");
  for (const claim of first.claims) {
    assert.equal(verifySettlementClaim({ session: SESSION, root: first.root, ...claim }), true);
    assert.equal(verifySettlementClaim({
      session: SESSION,
      root: first.root,
      ...claim,
      amountAtomic: (BigInt(claim.amountAtomic) + 1n).toString(),
    }), false);
  }
});

test("single-leaf settlements use an empty proof and match the leaf root", () => {
  const tree = buildSettlementTree({
    session: SESSION,
    payouts: [{ player: ALICE, amountAtomic: "18446744073709551615" }],
  });
  assert.deepEqual(tree.claims[0].proof, []);
  assert.equal(tree.root, settlementLeaf({
    session: SESSION,
    player: ALICE,
    amountAtomic: "18446744073709551615",
  }));
  assert.equal(verifySettlementClaim({ session: SESSION, root: tree.root, ...tree.claims[0] }), true);
});

test("malformed, duplicate, unsafe, and non-conserving payouts are rejected", () => {
  assert.throws(() => buildSettlementTree({
    session: SESSION,
    payouts: [
      { player: ALICE, amountAtomic: "1" },
      { player: ALICE, amountAtomic: "2" },
    ],
  }), /one payout per player/);
  assert.throws(() => buildSettlementTree({
    session: SESSION,
    payouts: [{ player: ALICE, amountAtomic: 1 }],
  }), /bigint or canonical/);
  assert.throws(() => buildSettlementTree({
    session: SESSION,
    expectedTotalAtomic: "2",
    payouts: [{ player: ALICE, amountAtomic: "1" }],
  }), /do not equal/);
  assert.throws(() => buildSettlementTree({
    session: "not-a-key",
    payouts: [{ player: ALICE, amountAtomic: "1" }],
  }), /base58|public key/);
});
