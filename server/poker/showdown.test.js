import assert from "node:assert/strict";
import test from "node:test";

import { settleShowdown, settleUncontested } from "./showdown.js";

const card = (rank, suit) => suit * 13 + "23456789TJQKA".indexOf(rank);

test("NLH showdown settles side pots, refunds, rake, and payouts exactly", () => {
  const result = settleShowdown({
    game: "NLH",
    players: [
      { playerId: "a", seat: 0, contributed: 100n, folded: false, holeCards: [card("A", 0), card("A", 1)] },
      { playerId: "b", seat: 1, contributed: 50n, folded: false, holeCards: [card("K", 0), card("K", 1)] },
      { playerId: "c", seat: 2, contributed: 20n, folded: false, holeCards: [card("Q", 0), card("Q", 1)] },
    ],
    boards: [[card("2", 0), card("3", 1), card("7", 2), card("9", 3), card("J", 0)]],
    buttonSeat: 0,
    rakeBps: 500,
    rakeCapAtomic: 5n,
  });
  assert.equal(result.totalRake, 5n);
  assert.equal(result.refunds.get("a"), 50n);
  assert.equal(result.payouts.get("a"), 165n);
  assert.equal([...result.payouts.values()].reduce((sum, amount) => sum + amount, 0n) + result.totalRake, 170n);
});

test("PLO4 showdown uses Omaha evaluation and can split two boards", () => {
  const result = settleShowdown({
    game: "PLO4",
    players: [
      {
        playerId: "a",
        seat: 0,
        contributed: 50n,
        folded: false,
        holeCards: [card("A", 2), card("T", 2), card("3", 0), card("4", 1)],
      },
      {
        playerId: "b",
        seat: 1,
        contributed: 50n,
        folded: false,
        holeCards: [card("9", 0), card("9", 1), card("8", 0), card("8", 1)],
      },
    ],
    boards: [
      [card("J", 2), card("Q", 2), card("K", 2), card("2", 0), card("5", 1)],
      [card("9", 2), card("8", 2), card("2", 1), card("K", 3), card("6", 0)],
    ],
    buttonSeat: 1,
  });
  assert.equal(result.payouts.get("a"), 50n);
  assert.equal(result.payouts.get("b"), 50n);
});

test("uncontested preflop pots apply no-flop-no-drop", () => {
  const result = settleUncontested({
    players: [
      { playerId: "a", seat: 0, contributed: 10n, folded: false },
      { playerId: "b", seat: 1, contributed: 5n, folded: true },
    ],
    buttonSeat: 0,
    flopDealt: false,
    rakeBps: 1_000,
    rakeCapAtomic: 100n,
  });
  assert.equal(result.totalRake, 0n);
  assert.equal(result.payouts.get("a"), 15n);
});
