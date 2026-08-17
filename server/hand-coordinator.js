import { createHash } from "node:crypto";

import {
  canonicalJson,
  createAuditBundle,
  createCommittedHand,
  dealPlan,
  revealCard,
  verifyAuditBundle,
  verifyCardReveal,
} from "../fairness/protocol.js";

const TERMINAL = new Set(["COMPLETE", "ABORTED"]);
const ABORT_REASONS = new Set([
  "BEACON_UNAVAILABLE",
  "COMMITMENT_TIMEOUT",
  "DEALER_FAILURE",
  "INTEGRITY_FAILURE",
  "OPERATOR_SHUTDOWN",
]);

function digest(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export class MemoryHandEventStore {
  constructor() {
    this.durable = false;
    this.hands = new Map();
    this.idempotency = new Map();
  }

  async load(handId) {
    return structuredClone(this.hands.get(handId) ?? []);
  }

  async findIdempotency(handId, idempotencyKey) {
    const prior = this.idempotency.get(`${handId}:${idempotencyKey}`);
    return prior ? structuredClone(prior) : undefined;
  }

  async append({ handId, expectedVersion, idempotencyKey, requestDigest, event }) {
    const key = `${handId}:${idempotencyKey}`;
    const prior = this.idempotency.get(key);
    if (prior) {
      if (prior.requestDigest !== requestDigest) throw new Error("Idempotency key was reused with different input");
      return { event: structuredClone(prior.event), duplicate: true };
    }
    const events = this.hands.get(handId) ?? [];
    if (events.length !== expectedVersion) throw new Error("Hand version conflict");
    events.push(structuredClone(event));
    this.hands.set(handId, events);
    this.idempotency.set(key, { requestDigest, event: structuredClone(event) });
    return { event: structuredClone(event), duplicate: false };
  }
}

export class MemoryDealerSecretStore {
  constructor() {
    this.durable = false;
    this.hands = new Map();
  }

  async put(handId, committedHand) {
    const existing = this.hands.get(handId);
    if (existing) {
      if (canonicalJson(existing.publicRecord) !== canonicalJson(committedHand.publicRecord)) {
        throw new Error("Dealer secret already exists with different committed inputs");
      }
      return false;
    }
    this.hands.set(handId, structuredClone(committedHand));
    return true;
  }

  async get(handId) {
    const hand = this.hands.get(handId);
    return hand ? structuredClone(hand) : undefined;
  }

  async delete(handId) {
    return this.hands.delete(handId);
  }
}

export function reduceHand(events) {
  const state = {
    version: 0,
    status: "MISSING",
    handId: undefined,
    rules: undefined,
    players: [],
    serverCommitment: undefined,
    playerCommitments: {},
    beaconReservation: undefined,
    verifiedBeacon: undefined,
    deckRoot: undefined,
    publicPositions: [],
  };

  for (const event of events) {
    state.version = event.sequence;
    state.handId = event.handId;
    switch (event.type) {
      case "HAND_OPENED":
        state.status = "COMMITTING";
        state.rules = event.payload.rules;
        state.players = event.payload.players;
        state.serverCommitment = event.payload.serverCommitment;
        break;
      case "PLAYER_COMMITTED":
        state.playerCommitments[event.payload.playerId] = event.payload.commitment;
        break;
      case "BEACON_RESERVED":
        state.status = "BEACON_RESERVED";
        state.beaconReservation = event.payload;
        break;
      case "DECK_COMMITTED":
        state.status = "DEALING";
        state.verifiedBeacon = event.payload.beacon;
        state.deckRoot = event.payload.deckRoot;
        break;
      case "PUBLIC_CARD_REVEALED":
        state.publicPositions.push(event.payload.reveal.position);
        break;
      case "HAND_COMPLETED":
        state.status = "COMPLETE";
        break;
      case "HAND_ABORTED":
        state.status = "ABORTED";
        break;
      default:
        throw new Error(`Unknown hand event: ${event.type}`);
    }
  }
  return state;
}

export class AuthoritativeHandCoordinator {
  constructor({ store, dealerStore, signer, beaconVerifier, clock = () => new Date() }) {
    assert(store?.load && store?.append, "Hand event store is required");
    assert(dealerStore?.put && dealerStore?.get && dealerStore?.delete, "Dealer secret store is required");
    assert(signer?.append, "Transcript signer is required");
    assert(typeof beaconVerifier === "function", "A cryptographic beacon verifier is required");
    this.store = store;
    this.dealerStore = dealerStore;
    this.signer = signer;
    this.beaconVerifier = beaconVerifier;
    this.clock = clock;
  }

  async state(handId) {
    return reduceHand(await this.store.load(handId));
  }

  async #record({ handId, expectedVersion, idempotencyKey, type, payload }) {
    assert(typeof idempotencyKey === "string" && idempotencyKey.length >= 16, "A strong idempotency key is required");
    const events = await this.store.load(handId);
    const previousEvent = events.at(-1);
    const requestDigest = digest({ type, payload });
    const event = this.signer.append({
      handId,
      type,
      payload,
      previousEvent,
      occurredAt: this.clock().toISOString(),
    });
    return this.store.append({ handId, expectedVersion, idempotencyKey, requestDigest, event });
  }

  async #replay({ handId, idempotencyKey, type, payload }) {
    if (!this.store.findIdempotency) return undefined;
    const prior = await this.store.findIdempotency(handId, idempotencyKey);
    if (!prior) return undefined;
    if (prior.requestDigest !== digest({ type, payload })) {
      throw new Error("Idempotency key was reused with different input");
    }
    return { event: prior.event, duplicate: true };
  }

  async openHand({ handId, roomId, rules, players, serverCommitment, idempotencyKey }) {
    // The participant array is authoritative seat order. Entropy inputs are
    // independently sorted by player id inside the fair-deal derivation.
    const payload = { roomId, rules, players: [...players], serverCommitment };
    const replay = await this.#replay({ handId, idempotencyKey, type: "HAND_OPENED", payload });
    if (replay) return replay;
    assert(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(roomId), "A valid room id is required");
    assert(/^[0-9a-f]{64}$/i.test(serverCommitment), "Server commitment must be 32-byte hex");
    assert(rules?.game === "NLH" || rules?.game === "PLO4", "Only NLH and PLO4 are supported");
    assert(Number.isInteger(rules.seats) && rules.seats >= 2 && rules.seats <= 9, "Rules require 2 to 9 seats");
    assert(Array.isArray(players) && players.length === rules.seats, "Player count must match active seats");
    assert(new Set(players).size === players.length, "Player ids must be unique");
    return this.#record({
      handId,
      expectedVersion: 0,
      idempotencyKey,
      type: "HAND_OPENED",
      payload,
    });
  }

  async submitPlayerCommitment({ handId, playerId, commitment, expectedVersion, idempotencyKey }) {
    const payload = { playerId, commitment: commitment.toLowerCase() };
    const replay = await this.#replay({ handId, idempotencyKey, type: "PLAYER_COMMITTED", payload });
    if (replay) return replay;
    const state = await this.state(handId);
    assert(state.status === "COMMITTING", "Player commitments are closed");
    assert(state.players.includes(playerId), "Player is not seated in this hand");
    assert(!state.playerCommitments[playerId], "Player already committed a seed");
    assert(/^[0-9a-f]{64}$/i.test(commitment), "Player commitment must be 32-byte hex");
    return this.#record({
      handId,
      expectedVersion,
      idempotencyKey,
      type: "PLAYER_COMMITTED",
      payload,
    });
  }

  async reserveBeacon({ handId, reservation, expectedVersion, idempotencyKey }) {
    const replay = await this.#replay({ handId, idempotencyKey, type: "BEACON_RESERVED", payload: reservation });
    if (replay) return replay;
    const state = await this.state(handId);
    assert(state.status === "COMMITTING", "Beacon can only be reserved after commitments");
    assert(Object.keys(state.playerCommitments).length === state.players.length, "All players must commit before reserving randomness");
    assert(Number.isSafeInteger(reservation?.round) && reservation.round > 0, "Beacon reservation requires a round");
    assert(Date.parse(reservation.notBefore) > this.clock().getTime(), "Beacon round must be in the future");
    return this.#record({
      handId,
      expectedVersion,
      idempotencyKey,
      type: "BEACON_RESERVED",
      payload: reservation,
    });
  }

  async commitDeck({
    handId,
    beacon,
    serverSeed,
    playerSeeds,
    expectedVersion,
    idempotencyKey,
  }) {
    const state = await this.state(handId);
    assert(beacon?.signatureVerified === true, "Unsigned or unverified beacon rejected");
    assert(beacon.source === state.beaconReservation.source, "Beacon source does not match reservation");
    assert(beacon.chainHash === state.beaconReservation.chainHash, "Beacon chain does not match reservation");
    assert(beacon.round === state.beaconReservation.round, "Beacon round does not match reservation");
    const committedHand = createCommittedHand({
      handId,
      rules: state.rules,
      beacon,
      players: playerSeeds,
      serverSeed,
    });
    assert(
      committedHand.publicRecord.serverCommitment === state.serverCommitment,
      "Server seed does not match the pre-hand commitment",
    );
    const expectedPlayerCommitments = new Map(
      Object.entries(state.playerCommitments),
    );
    assert(
      committedHand.publicRecord.playerCommitments.length === expectedPlayerCommitments.size,
      "Player reveal count does not match commitments",
    );
    for (const player of committedHand.publicRecord.playerCommitments) {
      assert(
        expectedPlayerCommitments.get(player.playerId) === player.commitment,
        `Seed for ${player.playerId} does not match its pre-hand commitment`,
      );
    }
    const payload = { beacon, deckRoot: committedHand.publicRecord.deckRoot };
    const replay = await this.#replay({ handId, idempotencyKey, type: "DECK_COMMITTED", payload });
    if (replay) return { ...replay, publicRecord: committedHand.publicRecord };
    assert(state.status === "BEACON_RESERVED", "Deck cannot be committed in the current state");
    assert(
      await this.beaconVerifier({ beacon, reservation: state.beaconReservation }),
      "Beacon could not be independently reverified",
    );
    const insertedSecret = await this.dealerStore.put(handId, committedHand);
    try {
      const result = await this.#record({
        handId,
        expectedVersion,
        idempotencyKey,
        type: "DECK_COMMITTED",
        payload,
      });
      return { ...result, publicRecord: committedHand.publicRecord };
    } catch (error) {
      if (insertedSecret) await this.dealerStore.delete(handId);
      throw error;
    }
  }

  async revealPublicCard({ handId, position, expectedVersion, idempotencyKey }) {
    const state = await this.state(handId);
    const plan = dealPlan({
      game: state.rules.game,
      seats: state.rules.seats,
      buttonSeat: state.rules.buttonSeat,
      boards: state.rules.boards ?? 1,
    });
    const publicSequence = plan.boards.flatMap((board) => [...board.flop, ...board.turn, ...board.river]);
    assert(publicSequence.includes(position), "Position is not a public card in the committed deal map");
    const committedHand = await this.dealerStore.get(handId);
    assert(committedHand, "Dealer secret is unavailable");
    const reveal = revealCard(committedHand.secretState.deck, position);
    const payload = { reveal };
    const replay = await this.#replay({ handId, idempotencyKey, type: "PUBLIC_CARD_REVEALED", payload });
    if (replay) return { ...replay, reveal };
    assert(state.status === "DEALING", "Cards cannot be revealed in the current state");
    assert(!state.publicPositions.includes(position), "Deck position was already revealed");
    assert(
      publicSequence[state.publicPositions.length] === position,
      "Public cards must be revealed in committed deal order",
    );
    assert(verifyCardReveal(state.deckRoot, reveal), "Community-card Merkle proof is invalid");
    const result = await this.#record({
      handId,
      expectedVersion,
      idempotencyKey,
      type: "PUBLIC_CARD_REVEALED",
      payload,
    });
    return { ...result, reveal };
  }

  async holeCardsFor({ handId, playerId }) {
    const state = await this.state(handId);
    assert(state.status === "DEALING", "Hole cards are unavailable in the current hand state");
    const seat = state.players.indexOf(playerId);
    assert(seat >= 0, "Player is not seated in this hand");
    const committedHand = await this.dealerStore.get(handId);
    assert(committedHand, "Dealer secret is unavailable");
    assert(committedHand.publicRecord.deckRoot === state.deckRoot, "Dealer secret differs from the committed deck");
    const plan = dealPlan({
      game: state.rules.game,
      seats: state.rules.seats,
      buttonSeat: state.rules.buttonSeat,
      boards: state.rules.boards ?? 1,
    });
    const reveals = plan.holeCards[seat].map((position) => revealCard(committedHand.secretState.deck, position));
    assert(reveals.every((reveal) => verifyCardReveal(state.deckRoot, reveal)), "Private-card proof is invalid");
    return Object.freeze({
      version: "xpoker-private-deal/v1",
      handId,
      playerId,
      game: state.rules.game,
      deckRoot: state.deckRoot,
      reveals,
    });
  }

  async completeHand({ handId, expectedVersion, idempotencyKey }) {
    const state = await this.state(handId);
    const committedHand = await this.dealerStore.get(handId);
    assert(committedHand, "Dealer secret is unavailable");
    const auditBundle = createAuditBundle(committedHand);
    assert(auditBundle.publicRecord.deckRoot === state.deckRoot, "Audit root differs from committed deck root");
    const verification = verifyAuditBundle(auditBundle, { beaconSignatureVerified: true });
    assert(verification.ok, `Audit bundle rejected: ${verification.errors.join(", ")}`);
    const payload = { auditDigest: digest(auditBundle), deckRoot: state.deckRoot };
    const replay = await this.#replay({ handId, idempotencyKey, type: "HAND_COMPLETED", payload });
    if (replay) return { ...replay, auditBundle };
    assert(state.status === "DEALING", "Hand cannot be completed in the current state");
    const result = await this.#record({
      handId,
      expectedVersion,
      idempotencyKey,
      type: "HAND_COMPLETED",
      payload,
    });
    return { ...result, auditBundle };
  }

  async abortHand({ handId, reason, expectedVersion, idempotencyKey, refundsScheduled }) {
    const payload = { reason, refundsScheduled };
    const replay = await this.#replay({ handId, idempotencyKey, type: "HAND_ABORTED", payload });
    if (replay) return replay;
    const state = await this.state(handId);
    assert(state.status !== "MISSING" && !TERMINAL.has(state.status), "Hand cannot be aborted in the current state");
    assert(ABORT_REASONS.has(reason), "Abort reason is not allowlisted");
    assert(refundsScheduled === true, "Aborted real-value hands must schedule refunds");
    const result = await this.#record({
      handId,
      expectedVersion,
      idempotencyKey,
      type: "HAND_ABORTED",
      payload,
    });
    await this.dealerStore.delete(handId);
    return result;
  }
}

export { ABORT_REASONS };
