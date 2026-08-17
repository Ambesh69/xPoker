const STREETS = Object.freeze(["PREFLOP", "FLOP", "TURN", "RIVER"]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function clone(state) {
  return structuredClone(state);
}

function playerById(state, playerId) {
  return state.players.find((player) => player.playerId === playerId);
}

function clockwisePlayers(state, afterSeat) {
  const sorted = [...state.players].sort((left, right) => left.seat - right.seat);
  const split = sorted.findIndex((player) => player.seat > afterSeat);
  return split === -1 ? sorted : [...sorted.slice(split), ...sorted.slice(0, split)];
}

function nextSeat(state, afterSeat, predicate) {
  return clockwisePlayers(state, afterSeat).find(predicate)?.seat;
}

function postForcedBet(player, amount) {
  const paid = player.stack < amount ? player.stack : amount;
  player.stack -= paid;
  player.streetContribution += paid;
  player.contributed += paid;
  player.allIn = player.stack === 0n;
  return paid;
}

function postAnte(player, amount) {
  const paid = player.stack < amount ? player.stack : amount;
  player.stack -= paid;
  player.contributed += paid;
  player.allIn = player.stack === 0n;
  return paid;
}

function potSize(state) {
  return state.players.reduce((sum, player) => sum + player.contributed, 0n);
}

function actionable(player) {
  return !player.folded && !player.allIn;
}

function active(player) {
  return !player.folded;
}

function addActed(state, playerId) {
  if (!state.actedSinceFullRaise.includes(playerId)) state.actedSinceFullRaise.push(playerId);
}

function maximumTarget(state, player) {
  const availableTarget = player.streetContribution + player.stack;
  if (state.game === "NLH") return availableTarget;
  const toCall = state.currentBet > player.streetContribution
    ? state.currentBet - player.streetContribution
    : 0n;
  const callPaid = toCall < player.stack ? toCall : player.stack;
  const potAfterCall = potSize(state) + callPaid;
  const potLimitTarget = player.streetContribution + callPaid + potAfterCall;
  return potLimitTarget < availableTarget ? potLimitTarget : availableTarget;
}

function nextPendingActor(state, afterSeat) {
  return nextSeat(state, afterSeat, (player) => (
    actionable(player)
    && (player.streetContribution < state.currentBet || !state.actedSinceFullRaise.includes(player.playerId))
  ));
}

function finishOrAdvance(state, actorSeat) {
  const remaining = state.players.filter(active);
  if (remaining.length === 1) {
    state.status = "COMPLETE";
    state.winnerId = remaining[0].playerId;
    state.actionSeat = null;
    return;
  }

  const canAct = remaining.filter(actionable);
  if (canAct.length === 0) {
    state.status = "AWAITING_RUNOUT";
    state.actionSeat = null;
    return;
  }
  if (canAct.length === 1 && canAct[0].streetContribution === state.currentBet) {
    state.status = state.phase === "RIVER" ? "SHOWDOWN" : "AWAITING_RUNOUT";
    state.actionSeat = null;
    return;
  }

  const roundComplete = canAct.every((player) => (
    player.streetContribution === state.currentBet
    && state.actedSinceFullRaise.includes(player.playerId)
  ));
  if (roundComplete) {
    state.actionSeat = null;
    if (state.phase === "RIVER") {
      state.status = "SHOWDOWN";
    } else {
      state.status = "AWAITING_DEAL";
      state.pendingStreet = STREETS[STREETS.indexOf(state.phase) + 1];
    }
    return;
  }

  const next = nextPendingActor(state, actorSeat);
  assert(next !== undefined, "Betting round has no valid next actor");
  state.actionSeat = next;
}

export function createBettingState({
  handId,
  game,
  players,
  buttonSeat,
  smallBlind,
  bigBlind,
  ante = 0n,
  straddle,
}) {
  assert(game === "NLH" || game === "PLO4", "Game must be NLH or PLO4");
  assert(Array.isArray(players) && players.length >= 2 && players.length <= 9, "A hand requires 2 to 9 players");
  assert(new Set(players.map((player) => player.playerId)).size === players.length, "Player ids must be unique");
  assert(new Set(players.map((player) => player.seat)).size === players.length, "Seats must be unique");
  assert(players.some((player) => player.seat === buttonSeat), "Button seat is not active");
  assert(typeof smallBlind === "bigint" && smallBlind > 0n, "Small blind must be positive bigint atomic units");
  assert(typeof bigBlind === "bigint" && bigBlind >= smallBlind, "Big blind must be at least the small blind");
  assert(typeof ante === "bigint" && ante >= 0n, "Ante must be non-negative bigint atomic units");
  for (const player of players) {
    assert(typeof player.stack === "bigint" && player.stack > 0n, "Every player needs a positive bigint stack");
    assert(Number.isInteger(player.seat) && player.seat >= 0 && player.seat <= 8, "Seat must be from 0 to 8");
  }

  const state = {
    version: 0,
    handId,
    game,
    phase: "PREFLOP",
    status: "BETTING",
    pendingStreet: null,
    buttonSeat,
    smallBlind,
    bigBlind,
    ante,
    currentBet: 0n,
    lastFullRaiseSize: bigBlind,
    actedSinceFullRaise: [],
    actionSeat: null,
    board: [],
    winnerId: null,
    players: players.map((player) => ({
      playerId: player.playerId,
      seat: player.seat,
      stack: player.stack,
      streetContribution: 0n,
      contributed: 0n,
      folded: false,
      allIn: false,
    })),
  };

  if (ante > 0n) {
    for (const player of state.players) postAnte(player, ante);
  }

  const smallBlindSeat = players.length === 2
    ? buttonSeat
    : nextSeat(state, buttonSeat, () => true);
  const bigBlindSeat = nextSeat(state, smallBlindSeat, () => true);
  state.smallBlindSeat = smallBlindSeat;
  state.bigBlindSeat = bigBlindSeat;
  postForcedBet(state.players.find((player) => player.seat === smallBlindSeat), smallBlind);
  postForcedBet(state.players.find((player) => player.seat === bigBlindSeat), bigBlind);
  let lastForcedSeat = bigBlindSeat;
  // The full big blind remains the preflop bring-in even when the big blind is all-in short.
  state.currentBet = bigBlind;
  if (straddle) {
    assert(players.length >= 3, "A live straddle requires at least three players");
    assert(Number.isInteger(straddle.seat), "Straddle seat is required");
    assert(typeof straddle.amount === "bigint" && straddle.amount >= bigBlind * 2n, "Straddle must be at least twice the big blind");
    const expectedSeat = nextSeat(state, bigBlindSeat, active);
    assert(straddle.seat === expectedSeat, "Only the first live seat after the big blind may straddle");
    const straddler = state.players.find((player) => player.seat === straddle.seat);
    assert(straddler.stack >= straddle.amount, "Straddler cannot cover the full live straddle");
    postForcedBet(straddler, straddle.amount);
    state.straddle = { seat: straddle.seat, amount: straddle.amount };
    state.currentBet = straddle.amount;
    state.lastFullRaiseSize = straddle.amount - bigBlind;
    lastForcedSeat = straddle.seat;
  }
  const smallBlindPlayer = state.players.find((player) => player.seat === smallBlindSeat);
  state.actionSeat = players.length === 2 && actionable(smallBlindPlayer)
    ? smallBlindSeat
    : nextSeat(state, lastForcedSeat, actionable) ?? null;
  if (state.actionSeat === null) finishOrAdvance(state, bigBlindSeat);
  return state;
}

export function legalActions(state, playerId) {
  assert(state.status === "BETTING", "Hand is not accepting betting actions");
  const player = playerById(state, playerId);
  assert(player, "Player is not in this hand");
  assert(player.seat === state.actionSeat, "Action is out of turn");
  const toCall = state.currentBet > player.streetContribution
    ? state.currentBet - player.streetContribution
    : 0n;
  const callAmount = toCall < player.stack ? toCall : player.stack;
  const availableTarget = player.streetContribution + player.stack;
  const maxTarget = maximumTarget(state, player);
  const raiseRightsOpen = !state.actedSinceFullRaise.includes(playerId);
  const opening = state.currentBet === 0n;
  const minimumTarget = opening ? state.bigBlind : state.currentBet + state.lastFullRaiseSize;
  const canIncrease = availableTarget > state.currentBet && maxTarget > state.currentBet && raiseRightsOpen;

  return Object.freeze({
    playerId,
    toCall,
    callAmount,
    canFold: toCall > 0n,
    canCheck: toCall === 0n,
    canCall: toCall > 0n,
    canBet: opening && canIncrease,
    canRaise: !opening && canIncrease,
    raiseRightsOpen,
    minimumTarget,
    maximumTarget: maxTarget,
    allInTarget: availableTarget,
  });
}

function payTo(player, target) {
  const amount = target - player.streetContribution;
  assert(amount >= 0n && amount <= player.stack, "Action exceeds player stack");
  player.stack -= amount;
  player.streetContribution += amount;
  player.contributed += amount;
  player.allIn = player.stack === 0n;
}

function applyIncrease(state, player, target, legal) {
  assert(typeof target === "bigint", "Bet or raise target must be bigint atomic units");
  assert(target > state.currentBet, "Bet or raise must increase the current bet");
  assert(target <= legal.maximumTarget, "Bet or raise exceeds the legal maximum");
  assert(legal.raiseRightsOpen, "Betting has not been reopened for this player");
  const allIn = target === legal.allInTarget;
  assert(target >= legal.minimumTarget || allIn, "Bet or raise is below the minimum and is not all-in");
  const previousBet = state.currentBet;
  const raiseSize = target - previousBet;
  payTo(player, target);
  state.currentBet = target;
  const fullRaise = previousBet === 0n
    ? target >= state.bigBlind
    : raiseSize >= state.lastFullRaiseSize;
  if (fullRaise) {
    state.lastFullRaiseSize = previousBet === 0n ? target : raiseSize;
    state.actedSinceFullRaise = [player.playerId];
  } else {
    addActed(state, player.playerId);
  }
}

export function applyAction(stateInput, action) {
  assert(action?.expectedVersion === stateInput.version, "Betting state version conflict");
  const state = clone(stateInput);
  const player = playerById(state, action.playerId);
  const legal = legalActions(state, action.playerId);
  const actorSeat = player.seat;

  switch (action.type) {
    case "fold":
      assert(legal.canFold, "Fold is not legal when checking is available");
      player.folded = true;
      addActed(state, player.playerId);
      break;
    case "check":
      assert(legal.canCheck, "Check is not legal facing a bet");
      addActed(state, player.playerId);
      break;
    case "call":
      assert(legal.canCall, "Call is not legal without a bet");
      payTo(player, player.streetContribution + legal.callAmount);
      addActed(state, player.playerId);
      break;
    case "bet":
      assert(legal.canBet, "Bet is not legal in the current state");
      applyIncrease(state, player, action.to, legal);
      break;
    case "raise":
      assert(legal.canRaise, "Raise is not legal in the current state");
      applyIncrease(state, player, action.to, legal);
      break;
    case "all-in":
      if (legal.allInTarget <= state.currentBet) {
        payTo(player, legal.allInTarget);
        addActed(state, player.playerId);
      } else {
        applyIncrease(state, player, legal.allInTarget, legal);
      }
      break;
    default:
      throw new Error("Unsupported betting action");
  }

  state.version += 1;
  finishOrAdvance(state, actorSeat);
  return state;
}

export function applyTimeout(stateInput, { playerId, expectedVersion }) {
  const legal = legalActions(stateInput, playerId);
  return applyAction(stateInput, {
    playerId,
    expectedVersion,
    type: legal.canCheck ? "check" : "fold",
  });
}

export function dealStreet(stateInput, { expectedVersion, street, cards }) {
  assert(expectedVersion === stateInput.version, "Betting state version conflict");
  assert(stateInput.status === "AWAITING_DEAL", "Hand is not awaiting a street");
  assert(street === stateInput.pendingStreet, "Unexpected street");
  const expectedCards = street === "FLOP" ? 3 : 1;
  assert(Array.isArray(cards) && cards.length === expectedCards, `${street} requires ${expectedCards} cards`);
  assert(cards.every((card) => Number.isInteger(card) && card >= 0 && card < 52), "Board contains an invalid card");
  assert(new Set([...stateInput.board, ...cards]).size === stateInput.board.length + cards.length, "Board contains duplicate cards");

  const state = clone(stateInput);
  state.version += 1;
  state.phase = street;
  state.status = "BETTING";
  state.pendingStreet = null;
  state.board.push(...cards);
  state.currentBet = 0n;
  state.lastFullRaiseSize = state.bigBlind;
  state.actedSinceFullRaise = [];
  for (const player of state.players) player.streetContribution = 0n;
  state.actionSeat = nextSeat(state, state.buttonSeat, actionable) ?? null;
  if (state.actionSeat === null) {
    state.status = street === "RIVER" ? "SHOWDOWN" : "AWAITING_RUNOUT";
  }
  return state;
}

export function dealRemainingBoard(stateInput, { expectedVersion, cards }) {
  assert(expectedVersion === stateInput.version, "Betting state version conflict");
  assert(stateInput.status === "AWAITING_RUNOUT", "Hand is not awaiting an all-in runout");
  assert(Array.isArray(cards) && cards.length === 5 - stateInput.board.length, "Runout must complete a five-card board");
  assert(cards.every((card) => Number.isInteger(card) && card >= 0 && card < 52), "Runout contains an invalid card");
  assert(new Set([...stateInput.board, ...cards]).size === 5, "Runout contains duplicate cards");
  const state = clone(stateInput);
  state.version += 1;
  state.board.push(...cards);
  state.phase = "RIVER";
  state.status = "SHOWDOWN";
  state.actionSeat = null;
  return state;
}
