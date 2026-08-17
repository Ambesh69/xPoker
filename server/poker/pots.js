import { compareEvaluations } from "./evaluator.js";

function assertPlayers(players) {
  if (!Array.isArray(players) || players.length < 2) throw new Error("At least two players are required");
  if (new Set(players.map((player) => player.playerId)).size !== players.length) throw new Error("Player ids must be unique");
  for (const player of players) {
    if (typeof player.contributed !== "bigint" || player.contributed < 0n) {
      throw new Error("Contributions must be non-negative bigint atomic units");
    }
  }
}

function addAmount(map, key, amount) {
  map.set(key, (map.get(key) ?? 0n) + amount);
}

export function buildPots(players) {
  assertPlayers(players);
  const levels = [...new Set(players.map((player) => player.contributed).filter((amount) => amount > 0n))]
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  const pots = [];
  const refunds = new Map();
  let previousLevel = 0n;

  for (const level of levels) {
    const participants = players.filter((player) => player.contributed >= level);
    const amount = (level - previousLevel) * BigInt(participants.length);
    if (participants.length === 1) {
      addAmount(refunds, participants[0].playerId, amount);
    } else {
      const eligiblePlayerIds = participants.filter((player) => !player.folded).map((player) => player.playerId);
      if (eligiblePlayerIds.length === 0) throw new Error("A pot has no eligible player");
      pots.push(Object.freeze({
        index: pots.length,
        amount,
        contributionCap: level,
        participantIds: Object.freeze(participants.map((player) => player.playerId)),
        eligiblePlayerIds: Object.freeze(eligiblePlayerIds),
      }));
    }
    previousLevel = level;
  }

  const contributed = players.reduce((sum, player) => sum + player.contributed, 0n);
  const accounted = pots.reduce((sum, pot) => sum + pot.amount, 0n)
    + [...refunds.values()].reduce((sum, amount) => sum + amount, 0n);
  if (accounted !== contributed) throw new Error("Pot construction failed conservation check");
  return { pots: Object.freeze(pots), refunds };
}

export function applyRake({ pots, rakeBps, capAtomic, flopDealt }) {
  if (!Array.isArray(pots)) throw new Error("Pots are required");
  if (!Number.isInteger(rakeBps) || rakeBps < 0 || rakeBps > 10_000) throw new Error("Rake basis points are invalid");
  if (typeof capAtomic !== "bigint" || capAtomic < 0n) throw new Error("Rake cap must be non-negative bigint atomic units");
  const gross = pots.reduce((sum, pot) => sum + pot.amount, 0n);
  const target = flopDealt ? (gross * BigInt(rakeBps)) / 10_000n : 0n;
  let remaining = target < capAtomic ? target : capAtomic;
  const rakedPots = pots.map((pot) => {
    const rake = remaining < pot.amount ? remaining : pot.amount;
    remaining -= rake;
    return Object.freeze({ ...pot, rake, netAmount: pot.amount - rake });
  });
  const totalRake = rakedPots.reduce((sum, pot) => sum + pot.rake, 0n);
  if (rakedPots.reduce((sum, pot) => sum + pot.netAmount, 0n) + totalRake !== gross) {
    throw new Error("Rake failed conservation check");
  }
  return { pots: Object.freeze(rakedPots), totalRake };
}

function rankFor(rankings, playerId) {
  return rankings instanceof Map ? rankings.get(playerId) : rankings[playerId];
}

function orderedWinners(winners, oddChipOrder) {
  const winnerSet = new Set(winners);
  const ordered = oddChipOrder.filter((playerId) => winnerSet.has(playerId));
  if (ordered.length !== winners.length) throw new Error("Odd-chip order does not contain every winner");
  return ordered;
}

export function settlePots({ pots, rankingsByBoard, oddChipOrder }) {
  if (!Array.isArray(pots) || pots.length === 0) throw new Error("At least one pot is required");
  if (!Array.isArray(rankingsByBoard) || rankingsByBoard.length < 1 || rankingsByBoard.length > 2) {
    throw new Error("One or two board rankings are required");
  }
  if (!Array.isArray(oddChipOrder) || new Set(oddChipOrder).size !== oddChipOrder.length) {
    throw new Error("Odd-chip order must contain unique player ids");
  }
  const awards = new Map();
  const details = [];

  for (const pot of pots) {
    const amount = pot.netAmount ?? pot.amount;
    const boardBase = amount / BigInt(rankingsByBoard.length);
    let boardRemainder = amount % BigInt(rankingsByBoard.length);
    for (let boardIndex = 0; boardIndex < rankingsByBoard.length; boardIndex += 1) {
      const boardAmount = boardBase + (boardRemainder > 0n ? 1n : 0n);
      if (boardRemainder > 0n) boardRemainder -= 1n;
      let winners;
      if (pot.eligiblePlayerIds.length === 1) {
        winners = [...pot.eligiblePlayerIds];
      } else {
        const ranked = pot.eligiblePlayerIds.map((playerId) => ({
          playerId,
          rank: rankFor(rankingsByBoard[boardIndex], playerId),
        }));
        if (ranked.some((entry) => !entry.rank)) throw new Error("Missing showdown rank for an eligible player");
        const best = ranked.reduce((current, entry) => (
          !current || compareEvaluations(entry.rank, current.rank) > 0 ? entry : current
        ), undefined);
        winners = ranked
          .filter((entry) => compareEvaluations(entry.rank, best.rank) === 0)
          .map((entry) => entry.playerId);
      }

      const share = boardAmount / BigInt(winners.length);
      let oddChips = boardAmount % BigInt(winners.length);
      for (const playerId of winners) addAmount(awards, playerId, share);
      for (const playerId of orderedWinners(winners, oddChipOrder)) {
        if (oddChips === 0n) break;
        addAmount(awards, playerId, 1n);
        oddChips -= 1n;
      }
      details.push(Object.freeze({
        potIndex: pot.index,
        board: boardIndex + 1,
        amount: boardAmount,
        winnerIds: Object.freeze(winners),
      }));
    }
  }
  const awarded = [...awards.values()].reduce((sum, amount) => sum + amount, 0n);
  const available = pots.reduce((sum, pot) => sum + (pot.netAmount ?? pot.amount), 0n);
  if (awarded !== available) throw new Error("Settlement failed conservation check");
  return { awards, details: Object.freeze(details) };
}
