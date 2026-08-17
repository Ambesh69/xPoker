import assert from "node:assert/strict";
import test from "node:test";

import {
  applyAction,
  applyTimeout,
  createBettingState,
  dealRemainingBoard,
  dealStreet,
  legalActions,
} from "./betting.js";

function players(stacks = [100n, 100n, 100n]) {
  return stacks.map((stack, seat) => ({ playerId: `p${seat}`, seat, stack }));
}

function state(options = {}) {
  return createBettingState({
    handId: "betting-hand-001",
    game: "NLH",
    players: players(),
    buttonSeat: 0,
    smallBlind: 5n,
    bigBlind: 10n,
    ...options,
  });
}

test("three-handed preflop and postflop action order is deterministic", () => {
  let hand = state();
  assert.equal(hand.smallBlindSeat, 1);
  assert.equal(hand.bigBlindSeat, 2);
  assert.equal(hand.actionSeat, 0);
  hand = applyAction(hand, { playerId: "p0", type: "call", expectedVersion: 0 });
  hand = applyAction(hand, { playerId: "p1", type: "call", expectedVersion: 1 });
  hand = applyAction(hand, { playerId: "p2", type: "check", expectedVersion: 2 });
  assert.equal(hand.status, "AWAITING_DEAL");
  assert.equal(hand.pendingStreet, "FLOP");
  hand = dealStreet(hand, { expectedVersion: 3, street: "FLOP", cards: [0, 1, 2] });
  assert.equal(hand.actionSeat, 1);
  assert.equal(hand.currentBet, 0n);
  assert.equal(hand.players.every((player) => player.streetContribution === 0n), true);
});

test("heads-up button posts the small blind, acts first preflop, and last postflop", () => {
  let hand = state({ players: players([100n, 100n]).slice(0, 2) });
  assert.equal(hand.smallBlindSeat, 0);
  assert.equal(hand.bigBlindSeat, 1);
  assert.equal(hand.actionSeat, 0);
  hand = applyAction(hand, { playerId: "p0", type: "call", expectedVersion: 0 });
  hand = applyAction(hand, { playerId: "p1", type: "check", expectedVersion: 1 });
  hand = dealStreet(hand, { expectedVersion: 2, street: "FLOP", cards: [0, 1, 2] });
  assert.equal(hand.actionSeat, 1);
});

test("a short all-in raise does not reopen raising for players who already acted", () => {
  let hand = state({ players: players([100n, 100n, 35n]) });
  hand = applyAction(hand, { playerId: "p0", type: "raise", to: 30n, expectedVersion: 0 });
  hand = applyAction(hand, { playerId: "p1", type: "call", expectedVersion: 1 });
  hand = applyAction(hand, { playerId: "p2", type: "all-in", expectedVersion: 2 });
  assert.equal(hand.currentBet, 35n);
  assert.equal(hand.actionSeat, 0);
  const legal = legalActions(hand, "p0");
  assert.equal(legal.toCall, 5n);
  assert.equal(legal.canRaise, false);
  assert.equal(legal.raiseRightsOpen, false);
  hand = applyAction(hand, { playerId: "p0", type: "call", expectedVersion: 3 });
  assert.equal(legalActions(hand, "p1").canRaise, false);
});

test("PLO4 maximum raise is exactly the pot after calling", () => {
  const hand = state({ game: "PLO4" });
  const legal = legalActions(hand, "p0");
  assert.equal(legal.toCall, 10n);
  assert.equal(legal.maximumTarget, 35n);
  assert.throws(
    () => applyAction(hand, { playerId: "p0", type: "raise", to: 36n, expectedVersion: 0 }),
    /maximum/i,
  );
  const raised = applyAction(hand, { playerId: "p0", type: "raise", to: 35n, expectedVersion: 0 });
  assert.equal(raised.currentBet, 35n);
});

test("a short all-in big blind does not reduce the full preflop bring-in", () => {
  const hand = state({ players: players([100n, 100n, 6n]) });
  assert.equal(hand.currentBet, 10n);
  assert.equal(hand.players.find((player) => player.playerId === "p2").contributed, 6n);
  assert.equal(legalActions(hand, "p0").toCall, 10n);
  assert.equal(legalActions(hand, "p0").minimumTarget, 20n);
});

test("antes build the pot without changing street calls and a live straddle gets last option", () => {
  const hand = state({
    ante: 2n,
    straddle: { seat: 0, amount: 20n },
  });
  assert.equal(hand.players.reduce((sum, player) => sum + player.contributed, 0n), 41n);
  assert.equal(hand.players.find((player) => player.playerId === "p0").streetContribution, 20n);
  assert.equal(hand.currentBet, 20n);
  assert.equal(hand.actionSeat, 1);
  assert.equal(legalActions(hand, "p1").toCall, 15n);
});

test("timeouts check when free and fold when facing a bet", () => {
  let hand = state();
  hand = applyTimeout(hand, { playerId: "p0", expectedVersion: 0 });
  assert.equal(hand.players.find((player) => player.playerId === "p0").folded, true);
  hand = applyAction(hand, { playerId: "p1", type: "call", expectedVersion: 1 });
  hand = applyTimeout(hand, { playerId: "p2", expectedVersion: 2 });
  assert.equal(hand.players.find((player) => player.playerId === "p2").folded, false);
  assert.equal(hand.status, "AWAITING_DEAL");
});

test("all-in players trigger a board runout and every chip remains contributed", () => {
  let hand = state({ players: players([20n, 20n]).slice(0, 2) });
  hand = applyAction(hand, { playerId: "p0", type: "all-in", expectedVersion: 0 });
  hand = applyAction(hand, { playerId: "p1", type: "call", expectedVersion: 1 });
  assert.equal(hand.status, "AWAITING_RUNOUT");
  assert.equal(hand.players.reduce((sum, player) => sum + player.contributed, 0n), 40n);
  hand = dealRemainingBoard(hand, { expectedVersion: 2, cards: [0, 1, 2, 3, 4] });
  assert.equal(hand.status, "SHOWDOWN");
  assert.equal(hand.board.length, 5);
});

test("folding awards an uncontested hand and stale or out-of-turn actions fail", () => {
  let hand = state({ players: players([100n, 100n]).slice(0, 2) });
  assert.throws(
    () => applyAction(hand, { playerId: "p1", type: "check", expectedVersion: 0 }),
    /out of turn/i,
  );
  hand = applyAction(hand, { playerId: "p0", type: "fold", expectedVersion: 0 });
  assert.equal(hand.status, "COMPLETE");
  assert.equal(hand.winnerId, "p1");
  assert.throws(
    () => applyAction(hand, { playerId: "p1", type: "check", expectedVersion: 0 }),
    /version conflict/i,
  );
});
