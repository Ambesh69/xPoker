import assert from "node:assert/strict";
import test from "node:test";

import {
  compareEvaluations,
  evaluateFive,
  evaluateHoldem,
  evaluateOmaha4,
} from "./evaluator.js";

const card = (rank, suit) => suit * 13 + "23456789TJQKA".indexOf(rank);

test("five-card evaluator orders every category and recognizes a wheel", () => {
  const hands = [
    [card("A", 0), card("J", 1), card("9", 2), card("6", 3), card("3", 0)],
    [card("A", 0), card("A", 1), card("9", 2), card("6", 3), card("3", 0)],
    [card("A", 0), card("A", 1), card("9", 2), card("9", 3), card("3", 0)],
    [card("A", 0), card("A", 1), card("A", 2), card("6", 3), card("3", 0)],
    [card("2", 0), card("3", 1), card("4", 2), card("5", 3), card("6", 0)],
    [card("A", 0), card("J", 0), card("9", 0), card("6", 0), card("3", 0)],
    [card("A", 0), card("A", 1), card("A", 2), card("9", 3), card("9", 0)],
    [card("A", 0), card("A", 1), card("A", 2), card("A", 3), card("9", 0)],
    [card("T", 2), card("J", 2), card("Q", 2), card("K", 2), card("A", 2)],
  ].map(evaluateFive);
  assert.deepEqual(hands.map((hand) => hand.category), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  for (let index = 1; index < hands.length; index += 1) {
    assert.equal(compareEvaluations(hands[index], hands[index - 1]), 1);
  }
  const wheel = evaluateFive([card("A", 0), card("2", 1), card("3", 2), card("4", 3), card("5", 0)]);
  const sixHigh = hands[4];
  assert.equal(wheel.name, "straight");
  assert.equal(compareEvaluations(sixHigh, wheel), 1);
});

test("NLH can play the board and produces an exact tie", () => {
  const board = [card("T", 2), card("J", 2), card("Q", 2), card("K", 2), card("A", 2)];
  const first = evaluateHoldem([card("2", 0), card("3", 1)], board);
  const second = evaluateHoldem([card("9", 0), card("9", 1)], board);
  assert.equal(first.name, "straight-flush");
  assert.equal(compareEvaluations(first, second), 0);
});

test("PLO4 must use exactly two hole cards and exactly three board cards", () => {
  const board = [card("J", 2), card("Q", 2), card("K", 2), card("2", 0), card("5", 1)];
  const onlyOneHeart = evaluateOmaha4(
    [card("A", 2), card("T", 0), card("3", 1), card("4", 3)],
    board,
  );
  assert.notEqual(onlyOneHeart.name, "straight-flush");

  const twoHearts = evaluateOmaha4(
    [card("A", 2), card("T", 2), card("3", 1), card("4", 3)],
    board,
  );
  assert.equal(twoHearts.name, "straight-flush");
});

test("duplicate or malformed cards are rejected", () => {
  assert.throws(() => evaluateFive([0, 0, 1, 2, 3]), /duplicate/i);
  assert.throws(() => evaluateHoldem([0, 1], [1, 2, 3, 4, 5]), /duplicates across/i);
  assert.throws(() => evaluateOmaha4([0, 1, 2, 52], [3, 4, 5, 6, 7]), /invalid/i);
});
