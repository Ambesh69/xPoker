import assert from "node:assert/strict";
import test from "node:test";

import { evaluateFive } from "./evaluator.js";
import { applyRake, buildPots, settlePots } from "./pots.js";

const card = (rank, suit) => suit * 13 + "23456789TJQKA".indexOf(rank);
const rank = (ranks) => evaluateFive(ranks.map(([value, suit]) => card(value, suit)));
const high = rank([["A", 0], ["J", 1], ["9", 2], ["6", 3], ["3", 0]]);
const pair = rank([["A", 0], ["A", 1], ["9", 2], ["6", 3], ["3", 0]]);
const trips = rank([["K", 0], ["K", 1], ["K", 2], ["6", 3], ["3", 0]]);

test("side pots include folded dead money and return unmatched chips", () => {
  const result = buildPots([
    { playerId: "a", contributed: 100n, folded: false },
    { playerId: "b", contributed: 50n, folded: false },
    { playerId: "c", contributed: 20n, folded: true },
  ]);
  assert.deepEqual(result.pots.map((pot) => pot.amount), [60n, 60n]);
  assert.deepEqual(result.pots[0].eligiblePlayerIds, ["a", "b"]);
  assert.deepEqual(result.pots[1].eligiblePlayerIds, ["a", "b"]);
  assert.equal(result.refunds.get("a"), 50n);
});

test("rake obeys no-flop-no-drop, percentage, cap, and conservation", () => {
  const { pots } = buildPots([
    { playerId: "a", contributed: 100n, folded: false },
    { playerId: "b", contributed: 100n, folded: false },
  ]);
  assert.equal(applyRake({ pots, rakeBps: 500, capAtomic: 6n, flopDealt: false }).totalRake, 0n);
  const raked = applyRake({ pots, rakeBps: 500, capAtomic: 6n, flopDealt: true });
  assert.equal(raked.totalRake, 6n);
  assert.equal(raked.pots[0].netAmount, 194n);
});

test("main and side pots award independently", () => {
  const { pots, refunds } = buildPots([
    { playerId: "a", contributed: 100n, folded: false },
    { playerId: "b", contributed: 50n, folded: false },
    { playerId: "c", contributed: 20n, folded: false },
  ]);
  const settlement = settlePots({
    pots,
    rankingsByBoard: [{ a: high, b: pair, c: trips }],
    oddChipOrder: ["b", "c", "a"],
  });
  assert.equal(settlement.awards.get("c"), 60n);
  assert.equal(settlement.awards.get("b"), 60n);
  assert.equal(refunds.get("a"), 50n);
});

test("ties, odd chips, and run-it-twice conserve every atomic unit", () => {
  const tiedPot = [{ index: 0, amount: 15n, eligiblePlayerIds: ["a", "b", "c"] }];
  const tied = settlePots({
    pots: tiedPot,
    rankingsByBoard: [{ a: pair, b: pair, c: high }],
    oddChipOrder: ["b", "c", "a"],
  });
  assert.equal(tied.awards.get("a"), 7n);
  assert.equal(tied.awards.get("b"), 8n);

  const twice = settlePots({
    pots: [{ index: 0, amount: 101n, eligiblePlayerIds: ["a", "b"] }],
    rankingsByBoard: [{ a: trips, b: pair }, { a: high, b: pair }],
    oddChipOrder: ["a", "b"],
  });
  assert.equal(twice.details[0].amount, 51n);
  assert.equal(twice.details[1].amount, 50n);
  assert.equal(twice.awards.get("a"), 51n);
  assert.equal(twice.awards.get("b"), 50n);
});
