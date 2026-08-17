import {
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export const PROTOCOL_VERSION = "xpoker-fair-deal/v1";

const SUITS = ["clubs", "diamonds", "hearts", "spades"];
const SUIT_SYMBOLS = ["♣", "♦", "♥", "♠"];
const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];
const UINT32_SPACE = 0x1_0000_0000;

export class FairDealError extends Error {
  constructor(message, code = "FAIR_DEAL_ERROR") {
    super(message);
    this.name = "FairDealError";
    this.code = code;
  }
}

function assert(condition, message, code) {
  if (!condition) throw new FairDealError(message, code);
}

function uint32(value) {
  const output = Buffer.alloc(4);
  output.writeUInt32BE(value >>> 0);
  return output;
}

function uint64(value) {
  const output = Buffer.alloc(8);
  output.writeBigUInt64BE(BigInt(value));
  return output;
}

function fieldBytes(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string") return Buffer.from(value, "utf8");
  if (typeof value === "number") return uint64(value);
  if (typeof value === "bigint") return uint64(value);
  throw new FairDealError("Unsupported commitment field type", "INVALID_FIELD");
}

function domainHash(domain, ...fields) {
  const hash = createHash("sha256");
  const domainBytes = Buffer.from(domain, "utf8");
  hash.update(uint32(domainBytes.length));
  hash.update(domainBytes);
  for (const field of fields) {
    const bytes = fieldBytes(field);
    hash.update(uint32(bytes.length));
    hash.update(bytes);
  }
  return hash.digest();
}

function toHex(bytes) {
  return Buffer.from(bytes).toString("hex");
}

function fromHex(value, label, expectedBytes = 32) {
  assert(typeof value === "string", `${label} must be a hexadecimal string`, "INVALID_HEX");
  assert(/^[0-9a-f]+$/i.test(value), `${label} contains non-hexadecimal characters`, "INVALID_HEX");
  assert(value.length === expectedBytes * 2, `${label} must be ${expectedBytes} bytes`, "INVALID_LENGTH");
  return Buffer.from(value, "hex");
}

function equalHex(left, right) {
  if (
    typeof left !== "string"
    || typeof right !== "string"
    || left.length !== right.length
    || left.length % 2 !== 0
    || !/^[0-9a-f]+$/i.test(left)
    || !/^[0-9a-f]+$/i.test(right)
  ) return false;
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortObject(value[key])]),
    );
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(sortObject(value));
}

export function generateSecret() {
  return randomBytes(32).toString("hex");
}

export function createDeck() {
  const deck = [];
  for (let suit = 0; suit < SUITS.length; suit += 1) {
    for (let rank = 0; rank < RANKS.length; rank += 1) {
      deck.push(suit * RANKS.length + rank);
    }
  }
  return deck;
}

export function cardFromId(cardId) {
  assert(Number.isInteger(cardId) && cardId >= 0 && cardId < 52, "Card id must be between 0 and 51", "INVALID_CARD");
  const suitIndex = Math.floor(cardId / RANKS.length);
  const rankIndex = cardId % RANKS.length;
  return {
    id: cardId,
    rank: RANKS[rankIndex],
    suit: SUITS[suitIndex],
    symbol: SUIT_SYMBOLS[suitIndex],
    code: `${RANKS[rankIndex]}${SUIT_SYMBOLS[suitIndex]}`,
  };
}

export function rulesHash(rules) {
  return toHex(domainHash(`${PROTOCOL_VERSION}/rules`, canonicalJson(rules)));
}

export function commitServerSeed({ handId, seed }) {
  return toHex(
    domainHash(
      `${PROTOCOL_VERSION}/server-seed`,
      handId,
      fromHex(seed, "Server seed"),
    ),
  );
}

export function commitPlayerSeed({ handId, playerId, seed }) {
  return toHex(
    domainHash(
      `${PROTOCOL_VERSION}/player-seed`,
      handId,
      playerId,
      fromHex(seed, `Seed for ${playerId}`),
    ),
  );
}

export function verifyServerReveal({ handId, commitment, seed }) {
  return equalHex(commitment, commitServerSeed({ handId, seed }));
}

export function verifyPlayerReveal({ handId, playerId, commitment, seed }) {
  return equalHex(commitment, commitPlayerSeed({ handId, playerId, seed }));
}

function normalizeBeacon(beacon) {
  assert(beacon && typeof beacon === "object", "A randomness beacon record is required", "INVALID_BEACON");
  assert(typeof beacon.source === "string" && beacon.source.length > 0, "Beacon source is required", "INVALID_BEACON");
  assert(Number.isSafeInteger(beacon.round) && beacon.round >= 0, "Beacon round must be a non-negative integer", "INVALID_BEACON");
  const randomness = fromHex(beacon.randomness, "Beacon randomness");
  return { ...beacon, randomness: toHex(randomness) };
}

export function deriveHandSeed({ handId, rulesDigest, serverSeed, beacon, playerSeeds }) {
  assert(typeof handId === "string" && handId.length >= 8, "Hand id must be at least 8 characters", "INVALID_HAND_ID");
  const serverBytes = fromHex(serverSeed, "Server seed");
  const beaconRecord = normalizeBeacon(beacon);
  const beaconBytes = fromHex(beaconRecord.randomness, "Beacon randomness");
  const ruleBytes = fromHex(rulesDigest, "Rules digest");
  assert(Array.isArray(playerSeeds) && playerSeeds.length >= 2, "At least two player seeds are required", "INVALID_PLAYERS");

  const sortedPlayers = [...playerSeeds].sort((left, right) => left.playerId.localeCompare(right.playerId));
  const uniquePlayers = new Set(sortedPlayers.map((player) => player.playerId));
  assert(uniquePlayers.size === sortedPlayers.length, "Player ids must be unique", "DUPLICATE_PLAYER");

  const playerMaterial = sortedPlayers.flatMap((player) => [
    player.playerId,
    fromHex(player.seed, `Seed for ${player.playerId}`),
  ]);
  const inputMaterial = domainHash(
    `${PROTOCOL_VERSION}/input-material`,
    handId,
    serverBytes,
    beaconRecord.source,
    beaconRecord.round,
    beaconBytes,
    ...playerMaterial,
  );
  const salt = domainHash(`${PROTOCOL_VERSION}/hkdf-salt`, handId, ruleBytes);
  const info = Buffer.from(`${PROTOCOL_VERSION}/deck-seed`, "utf8");
  return Buffer.from(hkdfSync("sha256", inputMaterial, salt, info, 32));
}

class HmacStream {
  #key;
  #counter = 0n;
  #buffer = Buffer.alloc(0);

  constructor(seed) {
    this.#key = Buffer.from(seed);
  }

  bytes(length) {
    assert(Number.isInteger(length) && length > 0, "Requested byte length must be positive", "INVALID_LENGTH");
    while (this.#buffer.length < length) {
      const block = createHmac("sha256", this.#key)
        .update(Buffer.from(`${PROTOCOL_VERSION}/stream`, "utf8"))
        .update(uint64(this.#counter))
        .digest();
      this.#counter += 1n;
      this.#buffer = Buffer.concat([this.#buffer, block]);
    }
    const output = this.#buffer.subarray(0, length);
    this.#buffer = this.#buffer.subarray(length);
    return output;
  }

  below(range) {
    assert(Number.isInteger(range) && range >= 1 && range <= 52, "Shuffle range must be between 1 and 52", "INVALID_RANGE");
    const limit = Math.floor(UINT32_SPACE / range) * range;
    let sample;
    do {
      sample = this.bytes(4).readUInt32BE(0);
    } while (sample >= limit);
    return sample % range;
  }
}

export function shuffleDeck(handSeed) {
  const seed = Buffer.isBuffer(handSeed)
    ? Buffer.from(handSeed)
    : fromHex(handSeed, "Hand seed");
  assert(seed.length === 32, "Hand seed must be 32 bytes", "INVALID_LENGTH");
  const deck = createDeck();
  const stream = new HmacStream(seed);
  for (let index = deck.length - 1; index > 0; index -= 1) {
    const swapIndex = stream.below(index + 1);
    [deck[index], deck[swapIndex]] = [deck[swapIndex], deck[index]];
  }
  return deck;
}

function cardNonce(handSeed, position, cardId) {
  return createHmac("sha256", handSeed)
    .update(Buffer.from(`${PROTOCOL_VERSION}/card-nonce`, "utf8"))
    .update(uint32(position))
    .update(uint32(cardId))
    .digest();
}

function cardLeaf(position, cardId, nonce) {
  return domainHash(
    `${PROTOCOL_VERSION}/card-leaf`,
    position,
    cardId,
    nonce,
  );
}

function merkleParent(left, right) {
  return domainHash(`${PROTOCOL_VERSION}/merkle-node`, left, right);
}

function buildMerkleLayers(leaves) {
  assert(leaves.length > 0, "Merkle tree requires at least one leaf", "EMPTY_TREE");
  const layers = [leaves.map((leaf) => Buffer.from(leaf))];
  while (layers.at(-1).length > 1) {
    const current = layers.at(-1);
    const next = [];
    for (let index = 0; index < current.length; index += 2) {
      const left = current[index];
      const right = current[index + 1] ?? left;
      next.push(merkleParent(left, right));
    }
    layers.push(next);
  }
  return layers;
}

function merkleProof(layers, leafIndex) {
  const proof = [];
  let index = leafIndex;
  for (let layerIndex = 0; layerIndex < layers.length - 1; layerIndex += 1) {
    const layer = layers[layerIndex];
    const isRight = index % 2 === 1;
    let siblingIndex = isRight ? index - 1 : index + 1;
    if (siblingIndex >= layer.length) siblingIndex = index;
    proof.push({
      side: isRight ? "left" : "right",
      hash: toHex(layer[siblingIndex]),
    });
    index = Math.floor(index / 2);
  }
  return proof;
}

export function commitDeck(handSeed) {
  const seed = Buffer.isBuffer(handSeed)
    ? Buffer.from(handSeed)
    : fromHex(handSeed, "Hand seed");
  const order = shuffleDeck(seed);
  const nonces = order.map((cardId, position) => cardNonce(seed, position, cardId));
  const leaves = order.map((cardId, position) => cardLeaf(position, cardId, nonces[position]));
  const layers = buildMerkleLayers(leaves);
  return {
    order,
    nonces,
    layers,
    root: toHex(layers.at(-1)[0]),
  };
}

export function revealCard(committedDeck, position) {
  assert(Number.isInteger(position) && position >= 0 && position < 52, "Deck position must be between 0 and 51", "INVALID_POSITION");
  const cardId = committedDeck.order[position];
  return {
    position,
    card: cardFromId(cardId),
    nonce: toHex(committedDeck.nonces[position]),
    proof: merkleProof(committedDeck.layers, position),
  };
}

export function verifyCardReveal(deckRoot, reveal) {
  try {
    const canonicalCard = cardFromId(reveal.card.id);
    assert(
      canonicalJson(reveal.card) === canonicalJson(canonicalCard),
      "Revealed card metadata does not match its card id",
      "INVALID_CARD_METADATA",
    );
    let current = cardLeaf(
      reveal.position,
      reveal.card.id,
      fromHex(reveal.nonce, "Card nonce"),
    );
    for (const proofItem of reveal.proof) {
      const sibling = fromHex(proofItem.hash, "Merkle sibling");
      assert(proofItem.side === "left" || proofItem.side === "right", "Merkle proof side must be left or right", "INVALID_PROOF");
      current = proofItem.side === "left"
        ? merkleParent(sibling, current)
        : merkleParent(current, sibling);
    }
    return equalHex(toHex(current), deckRoot);
  } catch {
    return false;
  }
}

function activeSeatOrder(seats, buttonSeat) {
  assert(Number.isInteger(seats) && seats >= 2 && seats <= 9, "A table must have 2 to 9 active seats", "INVALID_SEATS");
  assert(Number.isInteger(buttonSeat) && buttonSeat >= 0 && buttonSeat < seats, "Button seat is outside the active seat range", "INVALID_BUTTON");
  const firstSeat = seats === 2 ? buttonSeat : (buttonSeat + 1) % seats;
  return Array.from({ length: seats }, (_, index) => (firstSeat + index) % seats);
}

export function runoutPlan({ startPosition, street = "preflop", boards = 1 }) {
  assert(Number.isInteger(startPosition) && startPosition >= 0 && startPosition < 52, "Runout start position is invalid", "INVALID_POSITION");
  assert(["preflop", "flop", "turn", "river"].includes(street), "Street must be preflop, flop, turn, or river", "INVALID_STREET");
  assert(Number.isInteger(boards) && boards >= 1 && boards <= 2, "One or two boards are supported", "INVALID_BOARDS");

  const remaining = {
    preflop: ["flop", "turn", "river"],
    flop: ["turn", "river"],
    turn: ["river"],
    river: [],
  }[street];
  let position = startPosition;
  const boardPlans = [];

  for (let boardIndex = 0; boardIndex < boards; boardIndex += 1) {
    const plan = { board: boardIndex + 1, burns: [], flop: [], turn: [], river: [] };
    for (const nextStreet of remaining) {
      plan.burns.push({ before: nextStreet, position });
      position += 1;
      const cardCount = nextStreet === "flop" ? 3 : 1;
      plan[nextStreet] = Array.from({ length: cardCount }, () => position++);
    }
    boardPlans.push(plan);
  }

  assert(position <= 52, "Deal plan consumes more than 52 cards", "DECK_EXHAUSTED");
  return { boards: boardPlans, nextPosition: position };
}

export function dealPlan({ game, seats, buttonSeat = 0, boards = 1 }) {
  assert(game === "NLH" || game === "PLO4", "Game must be NLH or PLO4", "INVALID_GAME");
  const rounds = game === "NLH" ? 2 : 4;
  const order = activeSeatOrder(seats, buttonSeat);
  const holeCards = Object.fromEntries(order.map((seat) => [seat, []]));
  let position = 0;

  for (let round = 0; round < rounds; round += 1) {
    for (const seat of order) holeCards[seat].push(position++);
  }

  const runout = runoutPlan({ startPosition: position, street: "preflop", boards });
  return {
    game,
    seats,
    buttonSeat,
    dealingOrder: order,
    holeCards,
    boards: runout.boards,
    nextPosition: runout.nextPosition,
  };
}

function normalizePlayers({ handId, players }) {
  assert(Array.isArray(players) && players.length >= 2 && players.length <= 9, "A hand requires 2 to 9 players", "INVALID_PLAYERS");
  const ids = new Set();
  return players
    .map((player) => {
      assert(typeof player.playerId === "string" && player.playerId.length > 0, "Every player needs an id", "INVALID_PLAYER");
      assert(!ids.has(player.playerId), `Duplicate player id: ${player.playerId}`, "DUPLICATE_PLAYER");
      ids.add(player.playerId);
      const seed = player.seed ?? generateSecret();
      fromHex(seed, `Seed for ${player.playerId}`);
      return {
        playerId: player.playerId,
        seed,
        commitment: commitPlayerSeed({ handId, playerId: player.playerId, seed }),
      };
    })
    .sort((left, right) => left.playerId.localeCompare(right.playerId));
}

export function createCommittedHand({ handId, rules, beacon, players, serverSeed = generateSecret() }) {
  const normalizedBeacon = normalizeBeacon(beacon);
  const normalizedPlayers = normalizePlayers({ handId, players });
  const digest = rulesHash(rules);
  const serverCommitment = commitServerSeed({ handId, seed: serverSeed });
  const handSeed = deriveHandSeed({
    handId,
    rulesDigest: digest,
    serverSeed,
    beacon: normalizedBeacon,
    playerSeeds: normalizedPlayers,
  });
  const deck = commitDeck(handSeed);

  return {
    publicRecord: {
      version: PROTOCOL_VERSION,
      handId,
      rules: sortObject(rules),
      rulesHash: digest,
      serverCommitment,
      playerCommitments: normalizedPlayers.map(({ playerId, commitment }) => ({ playerId, commitment })),
      beacon: normalizedBeacon,
      deckRoot: deck.root,
    },
    secretState: {
      serverSeed,
      playerSeeds: normalizedPlayers.map(({ playerId, seed }) => ({ playerId, seed })),
      handSeed: toHex(handSeed),
      deck,
    },
  };
}

export function createAuditBundle(committedHand) {
  return {
    publicRecord: committedHand.publicRecord,
    reveals: {
      serverSeed: committedHand.secretState.serverSeed,
      playerSeeds: committedHand.secretState.playerSeeds,
    },
  };
}

export function verifyAuditBundle(bundle, { beaconSignatureVerified = false } = {}) {
  const errors = [];
  let reconstructedDeck;
  try {
    const { publicRecord, reveals } = bundle;
    assert(publicRecord.version === PROTOCOL_VERSION, "Unsupported fair-deal protocol version", "INVALID_VERSION");
    assert(
      verifyServerReveal({
        handId: publicRecord.handId,
        commitment: publicRecord.serverCommitment,
        seed: reveals.serverSeed,
      }),
      "Server seed does not match its pre-hand commitment",
      "SERVER_COMMITMENT_MISMATCH",
    );

    const commitments = new Map(publicRecord.playerCommitments.map((item) => [item.playerId, item.commitment]));
    assert(commitments.size === publicRecord.playerCommitments.length, "Duplicate player commitments", "DUPLICATE_PLAYER");
    assert(reveals.playerSeeds.length === commitments.size, "Player reveal count does not match commitments", "PLAYER_COUNT_MISMATCH");
    for (const player of reveals.playerSeeds) {
      assert(commitments.has(player.playerId), `Unexpected player reveal: ${player.playerId}`, "UNEXPECTED_PLAYER");
      assert(
        verifyPlayerReveal({
          handId: publicRecord.handId,
          playerId: player.playerId,
          commitment: commitments.get(player.playerId),
          seed: player.seed,
        }),
        `Seed for ${player.playerId} does not match its commitment`,
        "PLAYER_COMMITMENT_MISMATCH",
      );
    }

    const digest = rulesHash(publicRecord.rules);
    assert(equalHex(digest, publicRecord.rulesHash), "Rules changed after the hand was committed", "RULES_MISMATCH");
    const handSeed = deriveHandSeed({
      handId: publicRecord.handId,
      rulesDigest: publicRecord.rulesHash,
      serverSeed: reveals.serverSeed,
      beacon: publicRecord.beacon,
      playerSeeds: reveals.playerSeeds,
    });
    reconstructedDeck = commitDeck(handSeed);
    assert(equalHex(reconstructedDeck.root, publicRecord.deckRoot), "Reconstructed deck does not match the pre-hand root", "DECK_ROOT_MISMATCH");
    assert(new Set(reconstructedDeck.order).size === 52, "Reconstructed deck contains duplicates", "DUPLICATE_CARD");
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  const localChecksPassed = errors.length === 0;
  return {
    ok: localChecksPassed && beaconSignatureVerified,
    localChecksPassed,
    errors,
    deck: reconstructedDeck?.order.map(cardFromId),
    beaconSignatureVerified,
    note: beaconSignatureVerified
      ? "Local reconstruction and the caller-supplied beacon verification both passed."
      : "Not production-verified: independently verify the external beacon signature and round before accepting this result.",
  };
}
