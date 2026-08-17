import { evaluateHoldem, evaluateOmaha4 } from "./evaluator.js";
import { applyRake, buildPots, settlePots } from "./pots.js";

function add(map, key, amount) {
  map.set(key, (map.get(key) ?? 0n) + amount);
}

function oddChipOrder(players, buttonSeat) {
  const sorted = [...players].sort((left, right) => left.seat - right.seat);
  const split = sorted.findIndex((player) => player.seat > buttonSeat);
  return (split === -1 ? sorted : [...sorted.slice(split), ...sorted.slice(0, split)])
    .map((player) => player.playerId);
}

function evaluate(game, holeCards, board) {
  return game === "NLH" ? evaluateHoldem(holeCards, board) : evaluateOmaha4(holeCards, board);
}

function validatePlayers(players, game) {
  const expectedHoleCards = game === "NLH" ? 2 : 4;
  for (const player of players) {
    if (!Number.isInteger(player.seat)) throw new Error("Every player requires a seat");
    if (!player.folded && (!Array.isArray(player.holeCards) || player.holeCards.length !== expectedHoleCards)) {
      throw new Error(`Every live ${game} player requires ${expectedHoleCards} hole cards`);
    }
  }
}

function finalize({ players, pots, refunds, rankingsByBoard, buttonSeat, totalRake }) {
  const settlement = settlePots({
    pots,
    rankingsByBoard,
    oddChipOrder: oddChipOrder(players, buttonSeat),
  });
  const payouts = new Map(settlement.awards);
  for (const [playerId, amount] of refunds) add(payouts, playerId, amount);
  const contributed = players.reduce((sum, player) => sum + player.contributed, 0n);
  const paid = [...payouts.values()].reduce((sum, amount) => sum + amount, 0n);
  if (paid + totalRake !== contributed) throw new Error("Showdown failed conservation check");
  return {
    payouts,
    refunds,
    totalRake,
    pots,
    details: settlement.details,
    rankingsByBoard,
  };
}

export function settleShowdown({
  game,
  players,
  boards,
  buttonSeat,
  rakeBps = 0,
  rakeCapAtomic = 0n,
}) {
  if (game !== "NLH" && game !== "PLO4") throw new Error("Game must be NLH or PLO4");
  if (!Array.isArray(boards) || boards.length < 1 || boards.length > 2 || boards.some((board) => board.length !== 5)) {
    throw new Error("Showdown requires one or two complete boards");
  }
  validatePlayers(players, game);
  const { pots, refunds } = buildPots(players);
  const raked = applyRake({ pots, rakeBps, capAtomic: rakeCapAtomic, flopDealt: true });
  const rankingsByBoard = boards.map((board) => Object.fromEntries(
    players
      .filter((player) => !player.folded)
      .map((player) => [player.playerId, evaluate(game, player.holeCards, board)]),
  ));
  return finalize({
    players,
    pots: raked.pots,
    refunds,
    rankingsByBoard,
    buttonSeat,
    totalRake: raked.totalRake,
  });
}

export function settleUncontested({
  players,
  buttonSeat,
  flopDealt,
  rakeBps = 0,
  rakeCapAtomic = 0n,
}) {
  const live = players.filter((player) => !player.folded);
  if (live.length !== 1) throw new Error("Uncontested settlement requires exactly one live player");
  const { pots, refunds } = buildPots(players);
  const raked = applyRake({ pots, rakeBps, capAtomic: rakeCapAtomic, flopDealt });
  return finalize({
    players,
    pots: raked.pots,
    refunds,
    rankingsByBoard: [{}],
    buttonSeat,
    totalRake: raked.totalRake,
  });
}
