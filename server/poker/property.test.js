import assert from "node:assert/strict";
import test from "node:test";

import {
  applyAction,
  createBettingState,
  dealRemainingBoard,
  dealStreet,
  legalActions,
} from "./betting.js";

function random(seed) {
  let value = seed >>> 0;
  return () => {
    value += 0x6D2B79F5;
    let next = value;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function choose(source, values) {
  return values[Math.floor(source() * values.length)];
}

function invariant(state, initialTotal) {
  assert.equal(
    state.players.reduce((sum, player) => sum + player.stack + player.contributed, 0n),
    initialTotal,
  );
  assert.equal(state.players.every((player) => (
    player.stack >= 0n
    && player.contributed >= 0n
    && player.streetContribution >= 0n
    && player.streetContribution <= player.contributed
  )), true);
  assert.equal(new Set(state.board).size, state.board.length);
}

function play(seed, game) {
  const source = random(seed);
  const playerCount = 2 + Math.floor(source() * 8);
  const players = Array.from({ length: playerCount }, (_, seat) => ({
    playerId: `p${seat}`,
    seat,
    stack: BigInt(20 + Math.floor(source() * 481)),
  }));
  const initialTotal = players.reduce((sum, player) => sum + player.stack, 0n);
  let state = createBettingState({
    handId: `property-${game}-${seed}`,
    game,
    players,
    buttonSeat: Math.floor(source() * playerCount),
    smallBlind: 5n,
    bigBlind: 10n,
    ante: BigInt(Math.floor(source() * 3)),
  });
  invariant(state, initialTotal);
  let nextCard = 0;
  let transitions = 0;
  while (!["COMPLETE", "SHOWDOWN"].includes(state.status) && transitions < 500) {
    const priorVersion = state.version;
    if (state.status === "BETTING") {
      const actor = state.players.find((player) => player.seat === state.actionSeat);
      const legal = legalActions(state, actor.playerId);
      const actions = [];
      if (legal.canCheck) actions.push({ type: "check" });
      if (legal.canFold) actions.push({ type: "fold" });
      if (legal.canCall) actions.push({ type: "call" });
      if (legal.canBet || legal.canRaise) {
        const type = legal.canBet ? "bet" : "raise";
        if (legal.minimumTarget <= legal.maximumTarget) actions.push({ type, to: legal.minimumTarget });
        actions.push({ type, to: legal.maximumTarget });
        if (legal.allInTarget <= legal.maximumTarget) actions.push({ type: "all-in" });
      } else if (legal.allInTarget <= state.currentBet) {
        actions.push({ type: "all-in" });
      }
      const action = choose(source, actions);
      state = applyAction(state, {
        playerId: actor.playerId,
        expectedVersion: state.version,
        ...action,
      });
    } else if (state.status === "AWAITING_DEAL") {
      const cardCount = state.pendingStreet === "FLOP" ? 3 : 1;
      const cards = Array.from({ length: cardCount }, () => nextCard++);
      state = dealStreet(state, {
        expectedVersion: state.version,
        street: state.pendingStreet,
        cards,
      });
    } else if (state.status === "AWAITING_RUNOUT") {
      const cards = Array.from({ length: 5 - state.board.length }, () => nextCard++);
      state = dealRemainingBoard(state, { expectedVersion: state.version, cards });
    } else {
      assert.fail(`Unexpected randomized state: ${state.status}`);
    }
    assert.equal(state.version, priorVersion + 1);
    invariant(state, initialTotal);
    transitions += 1;
  }
  assert.ok(transitions < 500, `Randomized ${game} hand did not terminate`);
  return {
    status: state.status,
    version: state.version,
    board: state.board,
    stacks: state.players.map((player) => player.stack.toString()),
    contributions: state.players.map((player) => player.contributed.toString()),
  };
}

test("500 deterministic randomized NLH/PLO4 hands conserve chips and terminate", () => {
  for (const game of ["NLH", "PLO4"]) {
    for (let seed = 1; seed <= 250; seed += 1) {
      const first = play(seed, game);
      assert.deepEqual(play(seed, game), first);
    }
  }
});
