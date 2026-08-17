const CATEGORY_NAMES = Object.freeze([
  "high-card",
  "one-pair",
  "two-pair",
  "three-of-a-kind",
  "straight",
  "flush",
  "full-house",
  "four-of-a-kind",
  "straight-flush",
]);

function assertCardIds(cards, expected, label) {
  if (!Array.isArray(cards) || cards.length !== expected) throw new Error(`${label} requires exactly ${expected} cards`);
  if (cards.some((card) => !Number.isInteger(card) || card < 0 || card >= 52)) {
    throw new Error(`${label} contains an invalid card id`);
  }
  if (new Set(cards).size !== cards.length) throw new Error(`${label} contains duplicate cards`);
}

function combinations(items, count) {
  const output = [];
  const choose = (start, selected) => {
    if (selected.length === count) {
      output.push(selected);
      return;
    }
    for (let index = start; index <= items.length - (count - selected.length); index += 1) {
      choose(index + 1, [...selected, items[index]]);
    }
  };
  choose(0, []);
  return output;
}

function straightHigh(ranks) {
  const unique = new Set(ranks);
  for (let high = 12; high >= 4; high -= 1) {
    if ([0, 1, 2, 3, 4].every((offset) => unique.has(high - offset))) return high;
  }
  if ([12, 0, 1, 2, 3].every((rank) => unique.has(rank))) return 3;
  return undefined;
}

function result(category, tiebreak, cards) {
  return Object.freeze({
    category,
    name: CATEGORY_NAMES[category],
    tiebreak: Object.freeze(tiebreak),
    cards: Object.freeze([...cards]),
  });
}

export function evaluateFive(cards) {
  assertCardIds(cards, 5, "Five-card evaluation");
  const ranks = cards.map((card) => card % 13);
  const suits = cards.map((card) => Math.floor(card / 13));
  const counts = new Map();
  for (const rank of ranks) counts.set(rank, (counts.get(rank) ?? 0) + 1);
  const groups = [...counts.entries()].sort((left, right) => right[1] - left[1] || right[0] - left[0]);
  const highStraight = straightHigh(ranks);
  const flush = new Set(suits).size === 1;

  if (flush && highStraight !== undefined) return result(8, [highStraight], cards);
  if (groups[0][1] === 4) {
    return result(7, [groups[0][0], groups.find((group) => group[1] === 1)[0]], cards);
  }
  if (groups[0][1] === 3 && groups[1][1] === 2) return result(6, [groups[0][0], groups[1][0]], cards);
  if (flush) return result(5, [...ranks].sort((left, right) => right - left), cards);
  if (highStraight !== undefined) return result(4, [highStraight], cards);
  if (groups[0][1] === 3) {
    return result(3, [groups[0][0], ...groups.filter((group) => group[1] === 1).map(([rank]) => rank).sort((a, b) => b - a)], cards);
  }
  const pairs = groups.filter((group) => group[1] === 2).map(([rank]) => rank).sort((a, b) => b - a);
  if (pairs.length === 2) {
    const kicker = groups.find((group) => group[1] === 1)[0];
    return result(2, [pairs[0], pairs[1], kicker], cards);
  }
  if (pairs.length === 1) {
    const kickers = groups.filter((group) => group[1] === 1).map(([rank]) => rank).sort((a, b) => b - a);
    return result(1, [pairs[0], ...kickers], cards);
  }
  return result(0, [...ranks].sort((left, right) => right - left), cards);
}

export function compareEvaluations(left, right) {
  if (left.category !== right.category) return Math.sign(left.category - right.category);
  const length = Math.max(left.tiebreak.length, right.tiebreak.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left.tiebreak[index] ?? 0) - (right.tiebreak[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function best(evaluations) {
  return evaluations.reduce((current, candidate) => (
    !current || compareEvaluations(candidate, current) > 0 ? candidate : current
  ), undefined);
}

export function evaluateHoldem(holeCards, board) {
  assertCardIds(holeCards, 2, "NLH hole cards");
  assertCardIds(board, 5, "NLH board");
  const allCards = [...holeCards, ...board];
  if (new Set(allCards).size !== allCards.length) throw new Error("NLH cards contain duplicates across hand and board");
  return best(combinations(allCards, 5).map(evaluateFive));
}

export function evaluateOmaha4(holeCards, board) {
  assertCardIds(holeCards, 4, "PLO4 hole cards");
  assertCardIds(board, 5, "PLO4 board");
  const allCards = [...holeCards, ...board];
  if (new Set(allCards).size !== allCards.length) throw new Error("PLO4 cards contain duplicates across hand and board");
  const evaluations = [];
  for (const holeSelection of combinations(holeCards, 2)) {
    for (const boardSelection of combinations(board, 3)) {
      evaluations.push(evaluateFive([...holeSelection, ...boardSelection]));
    }
  }
  return best(evaluations);
}

export { CATEGORY_NAMES };
