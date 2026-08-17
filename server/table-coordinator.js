import { createHash } from "node:crypto";

import {
  canonicalJson,
  dealPlan,
  verifyAuditBundle,
  verifyCardReveal,
} from "../fairness/protocol.js";
import { decodeBase58 } from "./wallet-auth.js";
import {
  applyAction,
  applyTimeout,
  createBettingState,
  dealRemainingBoard,
  dealStreet,
  legalActions,
} from "./poker/betting.js";
import { settleShowdown, settleUncontested } from "./poker/showdown.js";

const TABLE_EVENT_VERSION = "xpoker-table-events/v1";
const GENESIS_HASH = "0".repeat(64);
const TABLE_STATUSES = new Set(["WAITING", "HAND_ACTIVE", "PAUSED", "CLOSED"]);
const GAME_TYPES = new Set(["NLH", "PLO4", "ROE"]);
const PLAYER_STATUSES = new Set(["SEATED", "PLAYING", "SITTING_OUT", "BUSTED"]);
const ACTIVE_TURN_EVENT_TYPES = new Set([
  "HAND_STARTED",
  "ACTION_APPLIED",
  "ACTION_TIMED_OUT",
  "STREET_DEALT",
  "RUNOUT_DEALT",
  "HAND_FINISHED",
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX_32 = /^[0-9a-f]{64}$/i;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function requestDigest(value) {
  return sha256(canonicalJson(value));
}

function atomic(value, label, { positive = false } = {}) {
  assert(typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value), `${label} must be a decimal atomic-unit string`);
  const parsed = BigInt(value);
  assert(parsed <= 18_446_744_073_709_551_615n, `${label} exceeds u64`);
  assert(!positive || parsed > 0n, `${label} must be positive`);
  return parsed;
}

function integer(value, label, minimum, maximum) {
  assert(Number.isInteger(value) && value >= minimum && value <= maximum, `${label} must be an integer from ${minimum} to ${maximum}`);
  return value;
}

function validWallet(value) {
  try {
    return decodeBase58(value).length === 32;
  } catch {
    return false;
  }
}

function encodeBetting(state) {
  return {
    ...state,
    smallBlind: state.smallBlind.toString(),
    bigBlind: state.bigBlind.toString(),
    ante: state.ante.toString(),
    currentBet: state.currentBet.toString(),
    lastFullRaiseSize: state.lastFullRaiseSize.toString(),
    straddle: state.straddle ? { ...state.straddle, amount: state.straddle.amount.toString() } : undefined,
    players: state.players.map((player) => ({
      ...player,
      stack: player.stack.toString(),
      streetContribution: player.streetContribution.toString(),
      contributed: player.contributed.toString(),
    })),
  };
}

function decodeBetting(state) {
  return {
    ...state,
    smallBlind: BigInt(state.smallBlind),
    bigBlind: BigInt(state.bigBlind),
    ante: BigInt(state.ante),
    currentBet: BigInt(state.currentBet),
    lastFullRaiseSize: BigInt(state.lastFullRaiseSize),
    straddle: state.straddle ? { ...state.straddle, amount: BigInt(state.straddle.amount) } : undefined,
    players: state.players.map((player) => ({
      ...player,
      stack: BigInt(player.stack),
      streetContribution: BigInt(player.streetContribution),
      contributed: BigInt(player.contributed),
    })),
  };
}

function normalizeRules(input) {
  assert(input && typeof input === "object", "Table rules are required");
  assert(GAME_TYPES.has(input.game), "Game must be NLH, PLO4, or ROE");
  const smallBlind = atomic(input.smallBlindAtomic, "Small blind", { positive: true });
  const bigBlind = atomic(input.bigBlindAtomic, "Big blind", { positive: true });
  const ante = atomic(input.anteAtomic ?? "0", "Ante");
  const minimumBuyIn = atomic(input.minimumBuyInAtomic, "Minimum buy-in", { positive: true });
  const maximumBuyIn = atomic(input.maximumBuyInAtomic, "Maximum buy-in", { positive: true });
  const rakeCap = atomic(input.rakeCapAtomic ?? "0", "Rake cap");
  assert(bigBlind >= smallBlind, "Big blind must be at least the small blind");
  assert(maximumBuyIn >= minimumBuyIn, "Maximum buy-in must be at least the minimum buy-in");
  return Object.freeze({
    game: input.game,
    seats: integer(input.seats, "Seats", 2, 9),
    smallBlindAtomic: smallBlind.toString(),
    bigBlindAtomic: bigBlind.toString(),
    anteAtomic: ante.toString(),
    minimumBuyInAtomic: minimumBuyIn.toString(),
    maximumBuyInAtomic: maximumBuyIn.toString(),
    rakeBps: integer(input.rakeBps ?? 0, "Rake basis points", 0, 1_000),
    rakeCapAtomic: rakeCap.toString(),
    actionClockMs: integer(input.actionClockMs ?? 20_000, "Action clock", 5_000, 120_000),
    timeBankMs: integer(input.timeBankMs ?? 60_000, "Time bank", 0, 300_000),
    roeHandsPerGame: integer(input.roeHandsPerGame ?? 1, "ROE hands per game", 1, 20),
  });
}

function clockwiseSeat(seats, afterSeat) {
  const ordered = [...seats].sort((left, right) => left - right);
  return ordered.find((seat) => seat > afterSeat) ?? ordered[0];
}

function turnFor(state, now) {
  if (state.status !== "BETTING" || state.actionSeat === null) return null;
  const actor = state.players.find((player) => player.seat === state.actionSeat);
  const startedAt = now.toISOString();
  const baseDeadlineAt = new Date(now.getTime() + state.actionClockMs).toISOString();
  const deadlineAt = new Date(now.getTime() + state.actionClockMs + actor.timeBankMs).toISOString();
  return { playerId: actor.playerId, startedAt, baseDeadlineAt, deadlineAt };
}

function bettingWithTimeBanks(betting, seats, actionClockMs) {
  return {
    ...betting,
    actionClockMs,
    players: betting.players.map((player) => ({
      ...player,
      timeBankMs: seats.find((seat) => seat.playerId === player.playerId).timeBankMs,
    })),
  };
}

function consumeTimeBank(betting, turn, now) {
  const actor = betting.players.find((player) => player.playerId === turn.playerId);
  const overage = Math.max(0, now.getTime() - Date.parse(turn.baseDeadlineAt));
  actor.timeBankMs = Math.max(0, actor.timeBankMs - overage);
}

function verifiedPublicCards({ reveals, expectedPositions, deckRoot }) {
  assert(Array.isArray(reveals) && reveals.length === expectedPositions.length, "Public-card reveal count is invalid");
  for (let index = 0; index < reveals.length; index += 1) {
    assert(reveals[index]?.position === expectedPositions[index], "Public card is from an unexpected deck position");
    assert(verifyCardReveal(deckRoot, reveals[index]), "Public-card Merkle proof is invalid");
  }
  return reveals.map((reveal) => reveal.card.id);
}

function eventHash(event) {
  const { eventHash: _eventHash, ...base } = event;
  return sha256(canonicalJson(base));
}

function makeEvent({ tableId, sequence, type, occurredAt, previousHash, payload }) {
  const base = {
    version: TABLE_EVENT_VERSION,
    tableId,
    sequence,
    type,
    occurredAt,
    previousHash,
    payload,
  };
  return Object.freeze({ ...base, eventHash: eventHash(base) });
}

export function verifyTableEventChain(events, tableId, {
  startSequence = 0,
  previousHash = GENESIS_HASH,
  priorTime = Number.NEGATIVE_INFINITY,
} = {}) {
  try {
    assert(Array.isArray(events), "Table event chain must be an array");
    let head = previousHash;
    let lastTime = priorTime;
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      assert(event.version === TABLE_EVENT_VERSION, "Unsupported table event version");
      assert(event.tableId === tableId, "Table event belongs to another table");
      assert(event.sequence === startSequence + index + 1, "Table event sequence is not contiguous");
      assert(event.previousHash === head, "Table event hash chain is broken");
      assert(event.eventHash === eventHash(event), "Table event hash is invalid");
      const timestamp = Date.parse(event.occurredAt);
      assert(Number.isFinite(timestamp) && timestamp >= lastTime, "Table event timestamps are invalid");
      head = event.eventHash;
      lastTime = timestamp;
    }
    return { ok: true, head, errors: [] };
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : String(error)] };
  }
}

export class MemoryTableEventStore {
  constructor() {
    this.durable = false;
    this.events = new Map();
    this.idempotency = new Map();
    this.deadlines = new Map();
  }

  async load(tableId, { afterVersion = 0 } = {}) {
    return structuredClone((this.events.get(tableId) ?? []).filter((event) => event.sequence > afterVersion));
  }

  async head(tableId) {
    return structuredClone((this.events.get(tableId) ?? []).at(-1));
  }

  async findIdempotency(tableId, key) {
    const found = this.idempotency.get(`${tableId}:${key}`);
    return found ? structuredClone(found) : undefined;
  }

  async append({ tableId, expectedVersion, idempotencyKey, requestDigest: digestValue, event }) {
    const key = `${tableId}:${idempotencyKey}`;
    const prior = this.idempotency.get(key);
    if (prior) {
      assert(prior.requestDigest === digestValue, "Idempotency key was reused with different input");
      return { event: structuredClone(prior.event), duplicate: true };
    }
    const events = this.events.get(tableId) ?? [];
    assert(events.length === expectedVersion, "Table version conflict");
    events.push(structuredClone(event));
    this.events.set(tableId, events);
    this.idempotency.set(key, { requestDigest: digestValue, event: structuredClone(event) });
    this.#syncDeadline(tableId, event);
    return { event: structuredClone(event), duplicate: false };
  }

  #syncDeadline(tableId, event) {
    if (!ACTIVE_TURN_EVENT_TYPES.has(event.type)) return;
    const betting = event.payload.betting;
    const turn = event.payload.turn;
    if (!betting || betting.status !== "BETTING" || !turn) {
      this.deadlines.delete(tableId);
      return;
    }
    this.deadlines.set(tableId, {
      tableId,
      handId: betting.handId,
      bettingVersion: betting.version,
      playerId: turn.playerId,
      deadlineAt: turn.deadlineAt,
      leaseOwner: null,
      leaseUntil: null,
    });
  }

  async claimExpiredDeadlines({ ownerId, now = new Date(), leaseMs = 10_000, limit = 50 }) {
    assert(typeof ownerId === "string" && ownerId.length >= 8, "Timeout owner id is required");
    const claimed = [];
    for (const deadline of [...this.deadlines.values()].sort((left, right) => left.deadlineAt.localeCompare(right.deadlineAt))) {
      if (claimed.length >= limit) break;
      if (Date.parse(deadline.deadlineAt) > now.getTime()) continue;
      if (deadline.leaseUntil && Date.parse(deadline.leaseUntil) > now.getTime()) continue;
      deadline.leaseOwner = ownerId;
      deadline.leaseUntil = new Date(now.getTime() + leaseMs).toISOString();
      claimed.push(structuredClone(deadline));
    }
    return claimed;
  }
}

export function reduceTable(events, initialState) {
  const state = initialState ? structuredClone(initialState) : {
    version: 0,
    status: "MISSING",
    tableId: undefined,
    roomId: undefined,
    assetMint: undefined,
    allowlistVersion: undefined,
    rules: undefined,
    seats: [],
    handNumber: 0,
    buttonSeat: null,
    currentHand: null,
    lastResult: null,
    totalRakeAtomic: 0n,
  };

  for (const event of events) {
    state.version = event.sequence;
    state.tableId = event.tableId;
    switch (event.type) {
      case "TABLE_CREATED":
        state.status = "WAITING";
        state.roomId = event.payload.roomId;
        state.assetMint = event.payload.assetMint;
        state.allowlistVersion = event.payload.allowlistVersion;
        state.rules = event.payload.rules;
        break;
      case "PLAYER_SEATED":
        state.seats.push({ ...event.payload.player, stack: BigInt(event.payload.player.stackAtomic) });
        state.seats.sort((left, right) => left.seat - right.seat);
        break;
      case "PLAYER_SAT_OUT": {
        const player = state.seats.find((seat) => seat.playerId === event.payload.playerId);
        player.sitOutNextHand = event.payload.afterHand;
        if (!event.payload.afterHand) player.status = "SITTING_OUT";
        break;
      }
      case "PLAYER_RETURNED": {
        const player = state.seats.find((seat) => seat.playerId === event.payload.playerId);
        player.sitOutNextHand = false;
        player.status = state.currentHand?.betting.players.some((entry) => entry.playerId === player.playerId)
          ? "PLAYING"
          : "SEATED";
        break;
      }
      case "PLAYER_LEAVING": {
        const player = state.seats.find((seat) => seat.playerId === event.payload.playerId);
        player.leaving = true;
        break;
      }
      case "PLAYER_LEFT":
        state.seats = state.seats.filter((seat) => seat.playerId !== event.payload.playerId);
        break;
      case "HAND_STARTED":
        state.status = "HAND_ACTIVE";
        state.handNumber = event.payload.handNumber;
        state.buttonSeat = event.payload.buttonSeat;
        state.currentHand = {
          handId: event.payload.handId,
          game: event.payload.game,
          fairnessRules: event.payload.fairnessRules,
          deckRoot: event.payload.deckRoot,
          fairnessTranscriptHead: event.payload.fairnessTranscriptHead,
          publicReveals: [],
          betting: decodeBetting(event.payload.betting),
          turn: event.payload.turn,
        };
        for (const player of state.seats) {
          if (state.currentHand.betting.players.some((entry) => entry.playerId === player.playerId)) player.status = "PLAYING";
        }
        break;
      case "ACTION_APPLIED":
      case "ACTION_TIMED_OUT":
      case "STREET_DEALT":
      case "RUNOUT_DEALT":
        state.currentHand.betting = decodeBetting(event.payload.betting);
        state.currentHand.turn = event.payload.turn;
        if (event.payload.reveals) state.currentHand.publicReveals.push(...event.payload.reveals);
        for (const player of state.currentHand.betting.players) {
          state.seats.find((seat) => seat.playerId === player.playerId).timeBankMs = player.timeBankMs;
        }
        break;
      case "HAND_FINISHED":
        state.status = "WAITING";
        state.lastResult = event.payload.result;
        state.totalRakeAtomic += BigInt(event.payload.result.rakeAtomic);
        for (const update of event.payload.stacks) {
          const player = state.seats.find((seat) => seat.playerId === update.playerId);
          player.stack = BigInt(update.stackAtomic);
          player.status = player.stack === 0n ? "BUSTED" : player.sitOutNextHand ? "SITTING_OUT" : "SEATED";
          player.sitOutNextHand = false;
        }
        state.seats = state.seats.filter((seat) => !seat.leaving);
        state.currentHand = null;
        break;
      case "TABLE_PAUSED":
        state.status = "PAUSED";
        break;
      case "TABLE_RESUMED":
        state.status = "WAITING";
        break;
      case "TABLE_CLOSED":
        state.status = "CLOSED";
        break;
      default:
        throw new Error(`Unknown table event: ${event.type}`);
    }
  }
  assert(state.status === "MISSING" || TABLE_STATUSES.has(state.status), "Reduced table status is invalid");
  return state;
}

export function serializeTableState(state) {
  return {
    ...structuredClone(state),
    seats: state.seats.map((player) => ({ ...player, stack: player.stack.toString() })),
    currentHand: state.currentHand ? {
      ...state.currentHand,
      betting: encodeBetting(state.currentHand.betting),
    } : null,
    totalRakeAtomic: state.totalRakeAtomic.toString(),
  };
}

export function deserializeTableState(state) {
  assert(state && typeof state === "object", "Stored table snapshot is invalid");
  assert(Number.isSafeInteger(state.version) && state.version >= 0, "Stored table snapshot version is invalid");
  return {
    ...structuredClone(state),
    seats: state.seats.map((player) => ({ ...player, stack: BigInt(player.stack) })),
    currentHand: state.currentHand ? {
      ...state.currentHand,
      betting: decodeBetting(state.currentHand.betting),
    } : null,
    totalRakeAtomic: BigInt(state.totalRakeAtomic),
  };
}

export function nextHandSetup(state) {
  assert(state.status === "WAITING", "Table is not ready to prepare a hand");
  const players = state.seats.filter((player) => player.status === "SEATED" && player.stack > 0n && !player.leaving);
  assert(players.length >= 2, "At least two active players are required");
  const seats = players.map((player) => player.seat);
  const buttonSeat = state.buttonSeat === null || !seats.includes(state.buttonSeat)
    ? Math.min(...seats)
    : clockwiseSeat(seats, state.buttonSeat);
  const handNumber = state.handNumber + 1;
  const game = state.rules.game === "ROE"
    ? (Math.floor((handNumber - 1) / state.rules.roeHandsPerGame) % 2 === 0 ? "NLH" : "PLO4")
    : state.rules.game;
  const orderedPlayers = [...players].sort((left, right) => left.seat - right.seat);
  const buttonIndex = orderedPlayers.findIndex((player) => player.seat === buttonSeat);
  return Object.freeze({
    handId: `table:${state.tableId}:${handNumber}`,
    handNumber,
    game,
    buttonSeat,
    playerIds: orderedPlayers.map((player) => player.playerId),
    fairnessRules: Object.freeze({
      game,
      seats: orderedPlayers.length,
      buttonSeat: buttonIndex,
      boards: 1,
      burns: true,
    }),
  });
}

function publicPlayer(player) {
  return {
    playerId: player.playerId,
    seat: player.seat,
    stackAtomic: player.stack.toString(),
    status: player.status,
    timeBankMs: player.timeBankMs,
    sitOutNextHand: Boolean(player.sitOutNextHand),
    leaving: Boolean(player.leaving),
  };
}

export function tableView(state, { viewerWallet, now = new Date() } = {}) {
  const view = {
    version: state.version,
    status: state.status,
    tableId: state.tableId,
    roomId: state.roomId,
    assetMint: state.assetMint,
    allowlistVersion: state.allowlistVersion,
    rules: state.rules,
    seats: state.seats.map(publicPlayer),
    handNumber: state.handNumber,
    buttonSeat: state.buttonSeat,
    totalRakeAtomic: state.totalRakeAtomic.toString(),
    serverTime: now.toISOString(),
    currentHand: null,
    lastResult: state.lastResult,
  };
  if (state.currentHand) {
    const betting = encodeBetting(state.currentHand.betting);
    view.currentHand = {
      handId: state.currentHand.handId,
      game: state.currentHand.game,
      fairnessRules: state.currentHand.fairnessRules,
      deckRoot: state.currentHand.deckRoot,
      fairnessTranscriptHead: state.currentHand.fairnessTranscriptHead,
      publicReveals: state.currentHand.publicReveals,
      betting,
      turn: state.currentHand.turn,
    };
    if (viewerWallet && state.currentHand.turn?.playerId === viewerWallet) {
      const legal = legalActions(state.currentHand.betting, viewerWallet);
      view.currentHand.legalActions = {
        ...legal,
        toCall: legal.toCall.toString(),
        callAmount: legal.callAmount.toString(),
        minimumTarget: legal.minimumTarget.toString(),
        maximumTarget: legal.maximumTarget.toString(),
        allInTarget: legal.allInTarget.toString(),
      };
    }
  }
  return view;
}

export class AuthoritativeTableCoordinator {
  constructor({ store, clock = () => new Date(), onEvent = async () => {}, onEventError = () => {} }) {
    assert(store?.load && store?.append, "Table event store is required");
    assert(typeof onEvent === "function", "Table event publisher must be a function");
    assert(typeof onEventError === "function", "Table event error handler must be a function");
    this.store = store;
    this.clock = clock;
    this.listeners = new Set([onEvent]);
    this.onEventError = onEventError;
  }

  subscribe(listener) {
    assert(typeof listener === "function", "Table event subscriber must be a function");
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async state(tableId) {
    if (this.store.loadAggregate) {
      const aggregate = await this.store.loadAggregate(tableId);
      const verification = verifyTableEventChain(aggregate.events, tableId, aggregate.snapshot ? {
        startSequence: aggregate.snapshot.sequence,
        previousHash: aggregate.snapshot.eventHash,
        priorTime: Date.parse(aggregate.snapshot.occurredAt),
      } : undefined);
      assert(verification.ok, `Table event chain rejected: ${verification.errors.join(", ")}`);
      return reduceTable(aggregate.events, aggregate.state);
    }
    const events = await this.store.load(tableId);
    const verification = verifyTableEventChain(events, tableId);
    assert(verification.ok, `Table event chain rejected: ${verification.errors.join(", ")}`);
    return reduceTable(events);
  }

  async events(tableId, afterVersion = 0) {
    return this.store.load(tableId, { afterVersion });
  }

  async #replay(tableId, idempotencyKey, request) {
    assert(typeof idempotencyKey === "string" && idempotencyKey.length >= 16 && idempotencyKey.length <= 128, "A strong idempotency key is required");
    if (!this.store.findIdempotency) return undefined;
    const prior = await this.store.findIdempotency(tableId, idempotencyKey);
    if (!prior) return undefined;
    assert(prior.requestDigest === requestDigest(request), "Idempotency key was reused with different input");
    return { event: prior.event, duplicate: true };
  }

  async #record({ tableId, expectedVersion, idempotencyKey, type, payload, request }) {
    const previous = this.store.head
      ? await this.store.head(tableId)
      : (await this.store.load(tableId)).at(-1);
    const event = makeEvent({
      tableId,
      sequence: expectedVersion + 1,
      type,
      occurredAt: this.clock().toISOString(),
      previousHash: previous?.eventHash ?? GENESIS_HASH,
      payload,
    });
    const result = await this.store.append({
      tableId,
      expectedVersion,
      idempotencyKey,
      requestDigest: requestDigest(request),
      event,
    });
    if (!result.duplicate) {
      for (const listener of this.listeners) {
        try {
          await listener(result.event);
        } catch (error) {
          this.onEventError(error, result.event);
        }
      }
    }
    return result;
  }

  async createTable({ tableId, roomId, assetMint, allowlistVersion, rules, idempotencyKey }) {
    const request = { tableId, roomId, assetMint, allowlistVersion, rules };
    const replay = await this.#replay(tableId, idempotencyKey, request);
    if (replay) return replay;
    assert(UUID.test(tableId) && UUID.test(roomId), "Valid table and room ids are required");
    assert(validWallet(assetMint), "Asset mint must be a 32-byte Solana public key");
    assert(typeof allowlistVersion === "string" && /^[a-z0-9][a-z0-9._-]{2,63}$/i.test(allowlistVersion), "Allowlist version is invalid");
    const normalized = normalizeRules(rules);
    return this.#record({
      tableId,
      expectedVersion: 0,
      idempotencyKey,
      type: "TABLE_CREATED",
      payload: { roomId, assetMint, allowlistVersion, rules: normalized },
      request,
    });
  }

  async seatPlayer({ tableId, playerId, seat, buyInAtomic, expectedVersion, idempotencyKey }) {
    const request = { playerId, seat, buyInAtomic, expectedVersion };
    const replay = await this.#replay(tableId, idempotencyKey, request);
    if (replay) return replay;
    const state = await this.state(tableId);
    assert(state.status === "WAITING", "Players may only take seats between hands");
    assert(validWallet(playerId), "Player id must be an authenticated Solana wallet");
    integer(seat, "Seat", 0, state.rules.seats - 1);
    assert(!state.seats.some((player) => player.seat === seat), "Seat is occupied");
    assert(!state.seats.some((player) => player.playerId === playerId), "Wallet is already seated");
    const buyIn = atomic(buyInAtomic, "Buy-in", { positive: true });
    assert(buyIn >= BigInt(state.rules.minimumBuyInAtomic), "Buy-in is below the table minimum");
    assert(buyIn <= BigInt(state.rules.maximumBuyInAtomic), "Buy-in exceeds the table maximum");
    return this.#record({
      tableId,
      expectedVersion,
      idempotencyKey,
      type: "PLAYER_SEATED",
      payload: {
        player: {
          playerId,
          seat,
          stackAtomic: buyIn.toString(),
          status: "SEATED",
          timeBankMs: state.rules.timeBankMs,
          sitOutNextHand: false,
          leaving: false,
        },
      },
      request,
    });
  }

  async sitOut({ tableId, playerId, expectedVersion, idempotencyKey }) {
    const request = { playerId, expectedVersion };
    const replay = await this.#replay(tableId, idempotencyKey, request);
    if (replay) return replay;
    const state = await this.state(tableId);
    const player = state.seats.find((entry) => entry.playerId === playerId);
    assert(player, "Player is not seated");
    assert(player.status !== "SITTING_OUT" && !player.sitOutNextHand, "Player is already sitting out");
    const afterHand = state.status === "HAND_ACTIVE" && state.currentHand.betting.players.some((entry) => entry.playerId === playerId);
    return this.#record({
      tableId,
      expectedVersion,
      idempotencyKey,
      type: "PLAYER_SAT_OUT",
      payload: { playerId, afterHand },
      request,
    });
  }

  async returnPlayer({ tableId, playerId, expectedVersion, idempotencyKey }) {
    const request = { playerId, expectedVersion };
    const replay = await this.#replay(tableId, idempotencyKey, request);
    if (replay) return replay;
    const state = await this.state(tableId);
    const player = state.seats.find((entry) => entry.playerId === playerId);
    assert(player, "Player is not seated");
    assert(player.stack > 0n, "Busted player must buy in again before returning");
    assert(player.status === "SITTING_OUT" || player.sitOutNextHand, "Player is not sitting out");
    return this.#record({ tableId, expectedVersion, idempotencyKey, type: "PLAYER_RETURNED", payload: { playerId }, request });
  }

  async leave({ tableId, playerId, expectedVersion, idempotencyKey }) {
    const request = { playerId, expectedVersion };
    const replay = await this.#replay(tableId, idempotencyKey, request);
    if (replay) return replay;
    const state = await this.state(tableId);
    const player = state.seats.find((entry) => entry.playerId === playerId);
    assert(player, "Player is not seated");
    const inHand = state.status === "HAND_ACTIVE" && state.currentHand.betting.players.some((entry) => entry.playerId === playerId);
    return this.#record({
      tableId,
      expectedVersion,
      idempotencyKey,
      type: inHand ? "PLAYER_LEAVING" : "PLAYER_LEFT",
      payload: { playerId },
      request,
    });
  }

  async startHand({ tableId, handId, deckRoot, fairnessTranscriptHead, expectedVersion, idempotencyKey }) {
    const request = { handId, deckRoot, fairnessTranscriptHead, expectedVersion };
    const replay = await this.#replay(tableId, idempotencyKey, request);
    if (replay) return replay;
    const state = await this.state(tableId);
    const setup = nextHandSetup(state);
    assert(handId === setup.handId, "Hand id does not match the next deterministic table hand");
    assert(HEX_32.test(deckRoot) && HEX_32.test(fairnessTranscriptHead), "Committed deck and fairness transcript hashes are required");
    const participants = state.seats.filter((player) => setup.playerIds.includes(player.playerId));
    let betting = createBettingState({
      handId,
      game: setup.game,
      players: participants.map((player) => ({ playerId: player.playerId, seat: player.seat, stack: player.stack })),
      buttonSeat: setup.buttonSeat,
      smallBlind: BigInt(state.rules.smallBlindAtomic),
      bigBlind: BigInt(state.rules.bigBlindAtomic),
      ante: BigInt(state.rules.anteAtomic),
    });
    betting = bettingWithTimeBanks(betting, participants, state.rules.actionClockMs);
    const turn = turnFor(betting, this.clock());
    return this.#record({
      tableId,
      expectedVersion,
      idempotencyKey,
      type: "HAND_STARTED",
      payload: {
        ...setup,
        deckRoot: deckRoot.toLowerCase(),
        fairnessTranscriptHead: fairnessTranscriptHead.toLowerCase(),
        betting: encodeBetting(betting),
        turn,
      },
      request,
    });
  }

  async act({ tableId, playerId, action, expectedVersion, expectedBettingVersion, idempotencyKey }) {
    const request = { playerId, action, expectedVersion, expectedBettingVersion };
    const replay = await this.#replay(tableId, idempotencyKey, request);
    if (replay) return replay;
    const state = await this.state(tableId);
    assert(state.status === "HAND_ACTIVE", "Table does not have an active hand");
    assert(state.currentHand.turn?.playerId === playerId, "Player is not the current actor");
    assert(state.currentHand.betting.version === expectedBettingVersion, "Betting state version conflict");
    const now = this.clock();
    assert(now.getTime() <= Date.parse(state.currentHand.turn.deadlineAt), "Action deadline elapsed");
    const betting = structuredClone(state.currentHand.betting);
    consumeTimeBank(betting, state.currentHand.turn, now);
    const normalizedAction = { ...action, playerId, expectedVersion: expectedBettingVersion };
    if (action.to !== undefined) normalizedAction.to = atomic(action.to, "Action target", { positive: true });
    const next = applyAction(betting, normalizedAction);
    const turn = turnFor(next, now);
    return this.#record({
      tableId,
      expectedVersion,
      idempotencyKey,
      type: "ACTION_APPLIED",
      payload: { playerId, action, betting: encodeBetting(next), turn },
      request,
    });
  }

  async timeout({ tableId, expectedVersion, expectedBettingVersion, idempotencyKey }) {
    const request = { expectedVersion, expectedBettingVersion };
    const replay = await this.#replay(tableId, idempotencyKey, request);
    if (replay) return replay;
    const state = await this.state(tableId);
    assert(state.status === "HAND_ACTIVE" && state.currentHand.turn, "Table has no pending action timeout");
    assert(state.currentHand.betting.version === expectedBettingVersion, "Betting state version conflict");
    const now = this.clock();
    assert(now.getTime() >= Date.parse(state.currentHand.turn.deadlineAt), "Action deadline has not elapsed");
    const betting = structuredClone(state.currentHand.betting);
    betting.players.find((player) => player.playerId === state.currentHand.turn.playerId).timeBankMs = 0;
    const next = applyTimeout(betting, {
      playerId: state.currentHand.turn.playerId,
      expectedVersion: expectedBettingVersion,
    });
    const turn = turnFor(next, now);
    return this.#record({
      tableId,
      expectedVersion,
      idempotencyKey,
      type: "ACTION_TIMED_OUT",
      payload: { playerId: state.currentHand.turn.playerId, betting: encodeBetting(next), turn },
      request,
    });
  }

  async dealStreet({ tableId, street, reveals, revealEventHashes, expectedVersion, idempotencyKey }) {
    const request = { street, reveals, revealEventHashes, expectedVersion };
    const replay = await this.#replay(tableId, idempotencyKey, request);
    if (replay) return replay;
    const state = await this.state(tableId);
    assert(state.status === "HAND_ACTIVE", "Table does not have an active hand");
    assert(["FLOP", "TURN", "RIVER"].includes(street), "Street must be FLOP, TURN, or RIVER");
    const positions = dealPlan(state.currentHand.fairnessRules).boards[0][street.toLowerCase()];
    const cards = verifiedPublicCards({ reveals, expectedPositions: positions, deckRoot: state.currentHand.deckRoot });
    assert(Array.isArray(revealEventHashes) && revealEventHashes.length === reveals.length, "Every dealt card requires a fairness transcript event");
    assert(revealEventHashes.every((hash) => HEX_32.test(hash)), "Fairness transcript event hash is invalid");
    const next = dealStreet(state.currentHand.betting, {
      expectedVersion: state.currentHand.betting.version,
      street,
      cards,
    });
    next.actionClockMs = state.rules.actionClockMs;
    for (const player of next.players) {
      player.timeBankMs = state.currentHand.betting.players.find((prior) => prior.playerId === player.playerId).timeBankMs;
    }
    const turn = turnFor(next, this.clock());
    return this.#record({
      tableId,
      expectedVersion,
      idempotencyKey,
      type: "STREET_DEALT",
      payload: { street, reveals, revealEventHashes, betting: encodeBetting(next), turn },
      request,
    });
  }

  async dealRunout({ tableId, reveals, revealEventHashes, expectedVersion, idempotencyKey }) {
    const request = { reveals, revealEventHashes, expectedVersion };
    const replay = await this.#replay(tableId, idempotencyKey, request);
    if (replay) return replay;
    const state = await this.state(tableId);
    assert(state.status === "HAND_ACTIVE", "Table does not have an active hand");
    const boardPositions = (() => {
      const board = dealPlan(state.currentHand.fairnessRules).boards[0];
      return [...board.flop, ...board.turn, ...board.river];
    })();
    const positions = boardPositions.slice(state.currentHand.betting.board.length);
    const cards = verifiedPublicCards({ reveals, expectedPositions: positions, deckRoot: state.currentHand.deckRoot });
    assert(Array.isArray(revealEventHashes) && revealEventHashes.length === reveals.length, "Every runout card requires a fairness transcript event");
    assert(revealEventHashes.every((hash) => HEX_32.test(hash)), "Fairness transcript event hash is invalid");
    const next = dealRemainingBoard(state.currentHand.betting, {
      expectedVersion: state.currentHand.betting.version,
      cards,
    });
    next.actionClockMs = state.rules.actionClockMs;
    for (const player of next.players) {
      player.timeBankMs = state.currentHand.betting.players.find((prior) => prior.playerId === player.playerId).timeBankMs;
    }
    return this.#record({
      tableId,
      expectedVersion,
      idempotencyKey,
      type: "RUNOUT_DEALT",
      payload: { reveals, revealEventHashes, betting: encodeBetting(next), turn: null },
      request,
    });
  }

  async finishHand({ tableId, auditBundle, fairnessTranscriptHead, expectedVersion, idempotencyKey }) {
    const request = { auditBundle, fairnessTranscriptHead, expectedVersion };
    const replay = await this.#replay(tableId, idempotencyKey, request);
    if (replay) return replay;
    const state = await this.state(tableId);
    assert(state.status === "HAND_ACTIVE", "Table does not have an active hand");
    assert(HEX_32.test(fairnessTranscriptHead), "Completed fairness transcript head is required");
    const betting = state.currentHand.betting;
    assert(betting.status === "COMPLETE" || betting.status === "SHOWDOWN", "Betting is not complete");
    const audit = verifyAuditBundle(auditBundle, { beaconSignatureVerified: true });
    assert(audit.ok, `Fair-deal audit bundle rejected: ${audit.errors.join(", ")}`);
    assert(auditBundle.publicRecord.handId === state.currentHand.handId, "Audit bundle belongs to another hand");
    assert(auditBundle.publicRecord.deckRoot === state.currentHand.deckRoot, "Audit deck root differs from the pre-hand commitment");
    assert(
      canonicalJson(auditBundle.publicRecord.rules) === canonicalJson(state.currentHand.fairnessRules),
      "Audit rules differ from the table's committed hand setup",
    );
    const deck = audit.deck.map((card) => card.id);
    const plan = dealPlan(state.currentHand.fairnessRules);
    const expectedBoard = [
      ...plan.boards[0].flop,
      ...plan.boards[0].turn,
      ...plan.boards[0].river,
    ].map((position) => deck[position]);
    assert(
      betting.board.every((card, index) => card === expectedBoard[index]),
      "Dealt board differs from the committed deck",
    );
    const orderedPlayers = [...betting.players].sort((left, right) => left.seat - right.seat);
    const holeCards = Object.fromEntries(orderedPlayers.map((player, index) => [
      player.playerId,
      plan.holeCards[index].map((position) => deck[position]),
    ]));
    const boards = betting.status === "SHOWDOWN" ? [expectedBoard] : [];
    const players = betting.players.map((player) => ({
      playerId: player.playerId,
      seat: player.seat,
      contributed: player.contributed,
      folded: player.folded,
      holeCards: holeCards[player.playerId],
    }));
    const settlement = betting.status === "COMPLETE"
      ? settleUncontested({
        players,
        buttonSeat: betting.buttonSeat,
        flopDealt: betting.board.length >= 3,
        rakeBps: state.rules.rakeBps,
        rakeCapAtomic: BigInt(state.rules.rakeCapAtomic),
      })
      : settleShowdown({
        game: state.currentHand.game,
        players,
        boards,
        buttonSeat: betting.buttonSeat,
        rakeBps: state.rules.rakeBps,
        rakeCapAtomic: BigInt(state.rules.rakeCapAtomic),
      });
    const stacks = betting.players.map((player) => ({
      playerId: player.playerId,
      stackAtomic: (player.stack + (settlement.payouts.get(player.playerId) ?? 0n)).toString(),
    }));
    const totalBefore = state.currentHand.betting.players.reduce((sum, player) => sum + player.stack + player.contributed, 0n);
    const totalAfter = stacks.reduce((sum, player) => sum + BigInt(player.stackAtomic), 0n) + settlement.totalRake;
    assert(totalBefore === totalAfter, "Finished hand failed table-stack conservation");
    const result = {
      handId: state.currentHand.handId,
      game: state.currentHand.game,
      boards,
      payouts: [...settlement.payouts].map(([playerId, amount]) => ({ playerId, amountAtomic: amount.toString() })),
      refunds: [...settlement.refunds].map(([playerId, amount]) => ({ playerId, amountAtomic: amount.toString() })),
      rakeAtomic: settlement.totalRake.toString(),
      fairnessTranscriptHead: fairnessTranscriptHead.toLowerCase(),
    };
    return this.#record({
      tableId,
      expectedVersion,
      idempotencyKey,
      type: "HAND_FINISHED",
      payload: { result, stacks },
      request,
    });
  }
}

export { GENESIS_HASH, PLAYER_STATUSES, TABLE_EVENT_VERSION, normalizeRules };
