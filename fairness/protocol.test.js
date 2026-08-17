import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  cardFromId,
  commitDeck,
  commitPlayerSeed,
  commitServerSeed,
  createAuditBundle,
  createCommittedHand,
  dealPlan,
  deriveHandSeed,
  revealCard,
  rulesHash,
  runoutPlan,
  shuffleDeck,
  verifyAuditBundle,
  verifyCardReveal,
  verifyPlayerReveal,
  verifyServerReveal,
} from "./protocol.js";

function seed(label) {
  return createHash("sha256").update(label).digest("hex");
}

const beacon = {
  source: "test-vector",
  round: 42,
  randomness: seed("beacon-42"),
};

const rules = {
  game: "NLH",
  seats: 6,
  buttonSeat: 2,
  boards: 1,
  runItTwice: true,
  burns: true,
};

const players = [
  { playerId: "wallet-a", seed: seed("player-a") },
  { playerId: "wallet-b", seed: seed("player-b") },
  { playerId: "wallet-c", seed: seed("player-c") },
];

test("server and player commitments reject altered reveals", () => {
  const handId = "hand-test-0001";
  const serverSeed = seed("server");
  const serverCommitment = commitServerSeed({ handId, seed: serverSeed });
  assert.equal(verifyServerReveal({ handId, commitment: serverCommitment, seed: serverSeed }), true);
  assert.equal(verifyServerReveal({ handId, commitment: serverCommitment, seed: seed("other-server") }), false);

  const playerCommitment = commitPlayerSeed({ handId, playerId: "wallet-a", seed: players[0].seed });
  assert.equal(verifyPlayerReveal({ handId, playerId: "wallet-a", commitment: playerCommitment, seed: players[0].seed }), true);
  assert.equal(verifyPlayerReveal({ handId, playerId: "wallet-a", commitment: playerCommitment, seed: seed("other-player") }), false);
});

test("the same committed inputs always produce the same unique deck", () => {
  const options = {
    handId: "hand-test-0002",
    rulesDigest: rulesHash(rules),
    serverSeed: seed("server"),
    beacon,
    playerSeeds: players,
  };
  const first = shuffleDeck(deriveHandSeed(options));
  const second = shuffleDeck(deriveHandSeed(options));
  assert.deepEqual(first, second);
  assert.equal(first.length, 52);
  assert.equal(new Set(first).size, 52);
});

test("the published known-answer vector cannot drift", () => {
  const input = {
    handId: "hand-test-0002",
    rulesDigest: rulesHash(rules),
    serverSeed: seed("server"),
    beacon,
    playerSeeds: players,
  };
  const handSeed = deriveHandSeed(input);
  const committed = commitDeck(handSeed);
  assert.equal(input.rulesDigest, "281c55939c15a3fffc530861a851c8c1157a7d9bdd8bdd1001b578c55c8319b0");
  assert.equal(handSeed.toString("hex"), "9e11056e2bd4631cda44cd4f74444c67da8bdfc7cf5ac991ef91d6e58c58466b");
  assert.deepEqual(committed.order.slice(0, 10), [41, 9, 37, 3, 51, 27, 35, 4, 21, 20]);
  assert.equal(committed.root, "844087eddd3f651489b2fb02c424c6e8c267a27a71d0a21e710099238fdabcdf");
});

test("changing any independent entropy source changes the deck", () => {
  const base = {
    handId: "hand-test-0003",
    rulesDigest: rulesHash(rules),
    serverSeed: seed("server"),
    beacon,
    playerSeeds: players,
  };
  const original = shuffleDeck(deriveHandSeed(base));
  const changedPlayer = shuffleDeck(deriveHandSeed({
    ...base,
    playerSeeds: players.map((player, index) => index === 0 ? { ...player, seed: seed("changed-player") } : player),
  }));
  const changedBeacon = shuffleDeck(deriveHandSeed({
    ...base,
    beacon: { ...beacon, randomness: seed("changed-beacon") },
  }));
  assert.notDeepEqual(changedPlayer, original);
  assert.notDeepEqual(changedBeacon, original);
});

test("a revealed community card proves its exact committed position", () => {
  const handSeed = deriveHandSeed({
    handId: "hand-test-0004",
    rulesDigest: rulesHash(rules),
    serverSeed: seed("server"),
    beacon,
    playerSeeds: players,
  });
  const committed = commitDeck(handSeed);
  const flopCard = revealCard(committed, 13);
  assert.equal(verifyCardReveal(committed.root, flopCard), true);
  assert.equal(verifyCardReveal(committed.root, { ...flopCard, position: 14 }), false);
  assert.equal(verifyCardReveal(committed.root, { ...flopCard, card: cardFromId((flopCard.card.id + 1) % 52) }), false);
  assert.equal(verifyCardReveal(committed.root, { ...flopCard, card: { ...flopCard.card, code: "A♠" } }), false);
});

test("the post-hand audit reconstructs the committed deck and catches tampering", () => {
  const hand = createCommittedHand({
    handId: "hand-test-0005",
    rules,
    beacon,
    players,
    serverSeed: seed("server"),
  });
  const bundle = createAuditBundle(hand);
  const localOnly = verifyAuditBundle(bundle);
  assert.equal(localOnly.localChecksPassed, true);
  assert.equal(localOnly.ok, false);
  assert.equal(localOnly.beaconSignatureVerified, false);

  const valid = verifyAuditBundle(bundle, { beaconSignatureVerified: true });
  assert.equal(valid.ok, true);
  assert.equal(valid.deck.length, 52);

  const tampered = structuredClone(bundle);
  tampered.publicRecord.beacon.randomness = seed("tampered-beacon");
  const invalid = verifyAuditBundle(tampered);
  assert.equal(invalid.ok, false);
  assert.match(invalid.errors[0], /deck does not match/i);
});

test("NLH and PLO4 deal plans never reuse a deck position", () => {
  for (const game of ["NLH", "PLO4"]) {
    const plan = dealPlan({ game, seats: 6, buttonSeat: 2 });
    const positions = [
      ...Object.values(plan.holeCards).flat(),
      ...plan.boards.flatMap((board) => [
        ...board.burns.map((burn) => burn.position),
        ...board.flop,
        ...board.turn,
        ...board.river,
      ]),
    ];
    assert.equal(new Set(positions).size, positions.length);
    assert.equal(Object.values(plan.holeCards).every((cards) => cards.length === (game === "NLH" ? 2 : 4)), true);
  }
});

test("run-it-twice consumes two deterministic, non-overlapping runouts", () => {
  const plan = runoutPlan({ startPosition: 20, street: "flop", boards: 2 });
  const positions = plan.boards.flatMap((board) => [
    ...board.burns.map((burn) => burn.position),
    ...board.turn,
    ...board.river,
  ]);
  assert.equal(plan.boards.length, 2);
  assert.equal(positions.length, 8);
  assert.equal(new Set(positions).size, positions.length);
  assert.equal(plan.nextPosition, 28);
});
