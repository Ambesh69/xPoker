import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import test from "node:test";

import {
  createAuditBundle,
  createCommittedHand,
  dealPlan,
  revealCard,
} from "../fairness/protocol.js";
import { encodeBase58 } from "./wallet-auth.js";
import {
  AuthoritativeTableCoordinator,
  deserializeTableState,
  MemoryTableEventStore,
  nextHandSetup,
  serializeTableState,
  tableView,
  verifyTableEventChain,
} from "./table-coordinator.js";

const TABLE_ID = "018f47a6-7b9d-7cc3-8a23-60bfc31e3f45";
const ROOM_ID = "018f47a6-7b9d-7cc3-8a23-60bfc31e3f46";

function wallet() {
  const { publicKey } = generateKeyPairSync("ed25519");
  return encodeBase58(publicKey.export({ type: "spki", format: "der" }).subarray(-32));
}

function seed(label) {
  return createHash("sha256").update(label).digest("hex");
}

const ASSET_MINT = wallet();
const PLAYER_A = wallet();
const PLAYER_B = wallet();
const PLAYER_C = wallet();
const HASH_A = "aa".repeat(32);
const HASH_B = "bb".repeat(32);
const rules = {
  game: "NLH",
  seats: 6,
  smallBlindAtomic: "10",
  bigBlindAtomic: "20",
  anteAtomic: "0",
  minimumBuyInAtomic: "100",
  maximumBuyInAtomic: "2000",
  rakeBps: 250,
  rakeCapAtomic: "25",
  actionClockMs: 5_000,
  timeBankMs: 10_000,
};

function clock(start = "2026-08-17T12:00:00.000Z") {
  let value = Date.parse(start);
  return {
    now: () => new Date(value),
    advance: (milliseconds) => { value += milliseconds; },
  };
}

function fixture(tableRules = rules) {
  const time = clock();
  const store = new MemoryTableEventStore();
  const published = [];
  const coordinator = new AuthoritativeTableCoordinator({
    store,
    clock: time.now,
    onEvent: async (event) => published.push(event),
  });
  return { coordinator, store, time, published, tableRules };
}

async function createAndSeat(fixtureValue, players = [PLAYER_A, PLAYER_B]) {
  const { coordinator, tableRules } = fixtureValue;
  await coordinator.createTable({
    tableId: TABLE_ID,
    roomId: ROOM_ID,
    assetMint: ASSET_MINT,
    allowlistVersion: "launch-v1",
    rules: tableRules,
    idempotencyKey: "create-table-request-0001",
  });
  let version = 1;
  for (let index = 0; index < players.length; index += 1) {
    await coordinator.seatPlayer({
      tableId: TABLE_ID,
      playerId: players[index],
      seat: index * 2,
      buyInAtomic: "1000",
      expectedVersion: version,
      idempotencyKey: `seat-player-${index}-request-0001`,
    });
    version += 1;
  }
  return version;
}

function committedHand(setup) {
  const playerSeeds = setup.playerIds.map((playerId, index) => ({ playerId, seed: seed(`player-${index}`) }));
  const committed = createCommittedHand({
    handId: setup.handId,
    rules: setup.fairnessRules,
    players: playerSeeds,
    serverSeed: seed("server"),
    beacon: {
      source: "drand-quicknet",
      chainHash: "52db9ba70e0cc16e9715f2c4a1c8e2d9d8c5f4f5a0d1a7fbe9b6d6a5f2e1c3b4",
      round: 999,
      randomness: seed("beacon"),
      signature: "test-signature",
      signatureVerified: true,
    },
  });
  return { committed, auditBundle: createAuditBundle(committed) };
}

async function start(fixtureValue, version) {
  const state = await fixtureValue.coordinator.state(TABLE_ID);
  const setup = nextHandSetup(state);
  const fairness = committedHand(setup);
  await fixtureValue.coordinator.startHand({
    tableId: TABLE_ID,
    handId: setup.handId,
    deckRoot: fairness.committed.publicRecord.deckRoot,
    fairnessTranscriptHead: HASH_A,
    expectedVersion: version,
    idempotencyKey: `start-hand-${setup.handNumber}-request-01`,
  });
  return { setup, ...fairness, version: version + 1 };
}

test("authoritative table recovers from its event chain and exposes legal actions only to the actor", async () => {
  const value = fixture();
  let version = await createAndSeat(value);
  const started = await start(value, version);
  version = started.version;

  let state = await value.coordinator.state(TABLE_ID);
  assert.equal(state.currentHand.betting.actionSeat, 0);
  assert.equal(tableView(state, { viewerWallet: PLAYER_A, now: value.time.now() }).currentHand.legalActions.canCall, true);
  assert.equal(tableView(state, { viewerWallet: PLAYER_B, now: value.time.now() }).currentHand.legalActions, undefined);

  value.time.advance(7_000);
  await value.coordinator.act({
    tableId: TABLE_ID,
    playerId: PLAYER_A,
    action: { type: "call" },
    expectedVersion: version,
    expectedBettingVersion: 0,
    idempotencyKey: "player-a-call-request-01",
  });
  version += 1;
  state = await value.coordinator.state(TABLE_ID);
  assert.equal(state.seats.find((player) => player.playerId === PLAYER_A).timeBankMs, 8_000);
  assert.equal(state.currentHand.turn.playerId, PLAYER_B);

  const recovered = new AuthoritativeTableCoordinator({ store: value.store, clock: value.time.now });
  assert.deepEqual(tableView(await recovered.state(TABLE_ID), { now: value.time.now() }), tableView(state, { now: value.time.now() }));
  assert.equal(value.published.length, version);
  assert.equal(verifyTableEventChain(await value.store.load(TABLE_ID), TABLE_ID).ok, true);

  const retry = await value.coordinator.act({
    tableId: TABLE_ID,
    playerId: PLAYER_A,
    action: { type: "call" },
    expectedVersion: version - 1,
    expectedBettingVersion: 0,
    idempotencyKey: "player-a-call-request-01",
  });
  assert.equal(retry.duplicate, true);
  await assert.rejects(
    value.coordinator.act({
      tableId: TABLE_ID,
      playerId: PLAYER_A,
      action: { type: "fold" },
      expectedVersion: version - 1,
      expectedBettingVersion: 0,
      idempotencyKey: "player-a-call-request-01",
    }),
    /reused with different input/i,
  );
});

test("expired action clocks fail closed, consume the time bank, and can be leased once", async () => {
  const value = fixture();
  let version = await createAndSeat(value);
  const started = await start(value, version);
  version = started.version;
  value.time.advance(15_000);

  const leases = await value.store.claimExpiredDeadlines({ ownerId: "worker-0001", now: value.time.now() });
  assert.equal(leases.length, 1);
  assert.equal((await value.store.claimExpiredDeadlines({ ownerId: "worker-0002", now: value.time.now() })).length, 0);
  await value.coordinator.timeout({
    tableId: TABLE_ID,
    expectedVersion: version,
    expectedBettingVersion: 0,
    idempotencyKey: "timeout-hand-1-version-0",
  });
  const state = await value.coordinator.state(TABLE_ID);
  assert.equal(state.currentHand.betting.status, "COMPLETE");
  assert.equal(state.seats.find((player) => player.playerId === PLAYER_A).timeBankMs, 0);
  assert.equal((await value.store.claimExpiredDeadlines({ ownerId: "worker-0003", now: value.time.now() })).length, 0);
});

test("community cards and showdown payouts are derived from the committed audit deck", async () => {
  const value = fixture();
  let version = await createAndSeat(value);
  const started = await start(value, version);
  version = started.version;

  const act = async (playerId, type) => {
    const state = await value.coordinator.state(TABLE_ID);
    await value.coordinator.act({
      tableId: TABLE_ID,
      playerId,
      action: { type },
      expectedVersion: version,
      expectedBettingVersion: state.currentHand.betting.version,
      idempotencyKey: `action-${version}-${playerId.slice(0, 8)}`,
    });
    version += 1;
  };
  await act(PLAYER_A, "call");
  await act(PLAYER_B, "check");

  const plan = dealPlan(started.setup.fairnessRules);
  const deck = started.committed.secretState.deck.order;
  const streets = [
    ["FLOP", plan.boards[0].flop],
    ["TURN", plan.boards[0].turn],
    ["RIVER", plan.boards[0].river],
  ];
  for (const [streetIndex, [street, positions]] of streets.entries()) {
    const cards = positions.map((position) => deck[position]);
    const reveals = positions.map((position) => revealCard(started.committed.secretState.deck, position));
    if (streetIndex === 0) {
      const alteredReveals = structuredClone(reveals);
      alteredReveals[0].card.id = (alteredReveals[0].card.id + 1) % 52;
      await assert.rejects(
        value.coordinator.dealStreet({
          tableId: TABLE_ID,
          street,
          reveals: alteredReveals,
          revealEventHashes: cards.map((_, index) => createHash("sha256").update(`invalid-${index}`).digest("hex")),
          expectedVersion: version,
          idempotencyKey: "deal-invalid-flop-request",
        }),
        /Merkle proof is invalid/i,
      );
    }
    await value.coordinator.dealStreet({
      tableId: TABLE_ID,
      street,
      reveals,
      revealEventHashes: cards.map((_, index) => createHash("sha256").update(`${street}-${index}`).digest("hex")),
      expectedVersion: version,
      idempotencyKey: `deal-${street.toLowerCase()}-request-01`,
    });
    version += 1;
    await act(PLAYER_B, "check");
    await act(PLAYER_A, "check");
  }

  const altered = structuredClone(started.auditBundle);
  altered.reveals.serverSeed = seed("rigged");
  await assert.rejects(
    value.coordinator.finishHand({
      tableId: TABLE_ID,
      auditBundle: altered,
      fairnessTranscriptHead: HASH_B,
      expectedVersion: version,
      idempotencyKey: "finish-rigged-request-01",
    }),
    /audit bundle rejected/i,
  );

  const finished = await value.coordinator.finishHand({
    tableId: TABLE_ID,
    auditBundle: started.auditBundle,
    fairnessTranscriptHead: HASH_B,
    expectedVersion: version,
    idempotencyKey: "finish-showdown-request-01",
  });
  assert.equal(finished.event.type, "HAND_FINISHED");
  const state = await value.coordinator.state(TABLE_ID);
  assert.equal(state.status, "WAITING");
  assert.equal(state.lastResult.fairnessTranscriptHead, HASH_B);
  assert.equal(state.seats.reduce((sum, player) => sum + player.stack, 0n) + state.totalRakeAtomic, 2_000n);

});

test("ROE rotation, deferred sit-out, leaving, and event tamper detection are deterministic", async () => {
  const value = fixture({ ...rules, game: "ROE", roeHandsPerGame: 1 });
  let version = await createAndSeat(value, [PLAYER_A, PLAYER_B, PLAYER_C]);
  let state = await value.coordinator.state(TABLE_ID);
  assert.equal(nextHandSetup(state).game, "NLH");
  const started = await start(value, version);
  version = started.version;

  await value.coordinator.sitOut({
    tableId: TABLE_ID,
    playerId: PLAYER_C,
    expectedVersion: version,
    idempotencyKey: "sit-out-player-c-request",
  });
  version += 1;
  await value.coordinator.leave({
    tableId: TABLE_ID,
    playerId: PLAYER_B,
    expectedVersion: version,
    idempotencyKey: "leave-player-b-request-1",
  });
  version += 1;

  state = await value.coordinator.state(TABLE_ID);
  const actor = state.currentHand.turn.playerId;
  await value.coordinator.act({
    tableId: TABLE_ID,
    playerId: actor,
    action: { type: "fold" },
    expectedVersion: version,
    expectedBettingVersion: 0,
    idempotencyKey: "first-player-folds-hand-1",
  });
  version += 1;
  state = await value.coordinator.state(TABLE_ID);
  while (state.currentHand.betting.status === "BETTING") {
    await value.coordinator.act({
      tableId: TABLE_ID,
      playerId: state.currentHand.turn.playerId,
      action: { type: "fold" },
      expectedVersion: version,
      expectedBettingVersion: state.currentHand.betting.version,
      idempotencyKey: `fold-version-${version}-request`,
    });
    version += 1;
    state = await value.coordinator.state(TABLE_ID);
  }
  await value.coordinator.finishHand({
    tableId: TABLE_ID,
    auditBundle: started.auditBundle,
    fairnessTranscriptHead: HASH_B,
    expectedVersion: version,
    idempotencyKey: "finish-uncontested-request",
  });
  state = await value.coordinator.state(TABLE_ID);
  assert.equal(state.seats.some((player) => player.playerId === PLAYER_B), false);
  assert.equal(state.seats.find((player) => player.playerId === PLAYER_C).status, "SITTING_OUT");
  assert.throws(() => nextHandSetup(state), /at least two active players/i);

  const events = value.store.events.get(TABLE_ID);
  events[1].payload.player.stackAtomic = "999";
  await assert.rejects(value.coordinator.state(TABLE_ID), /hash is invalid/i);
});

test("append-only snapshots resume hash verification at the anchored event", async () => {
  const value = fixture();
  await createAndSeat(value, [PLAYER_A, PLAYER_B]);
  const events = await value.store.load(TABLE_ID);
  const prefix = events.slice(0, 2);
  const suffix = events.slice(2);
  const snapshotState = deserializeTableState(serializeTableState(
    (await (new AuthoritativeTableCoordinator({
      store: {
        load: async () => prefix,
        append: async () => { throw new Error("unused"); },
      },
    })).state(TABLE_ID)),
  ));
  const snapshotStore = {
    load: (...args) => value.store.load(...args),
    append: (...args) => value.store.append(...args),
    loadAggregate: async () => ({
      state: snapshotState,
      snapshot: {
        sequence: 2,
        eventHash: prefix.at(-1).eventHash,
        occurredAt: prefix.at(-1).occurredAt,
      },
      events: suffix,
    }),
  };
  const recovered = await (new AuthoritativeTableCoordinator({ store: snapshotStore })).state(TABLE_ID);
  assert.equal(recovered.version, 3);
  assert.deepEqual(recovered.seats.map((player) => player.playerId), [PLAYER_A, PLAYER_B]);
  const altered = structuredClone(suffix);
  altered[0].previousHash = "ff".repeat(32);
  snapshotStore.loadAggregate = async () => ({
    state: snapshotState,
    snapshot: {
      sequence: 2,
      eventHash: prefix.at(-1).eventHash,
      occurredAt: prefix.at(-1).occurredAt,
    },
    events: altered,
  });
  await assert.rejects(
    (new AuthoritativeTableCoordinator({ store: snapshotStore })).state(TABLE_ID),
    /hash chain is broken/i,
  );
});
