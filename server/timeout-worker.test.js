import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import { AuthoritativeTableCoordinator, MemoryTableEventStore, nextHandSetup } from "./table-coordinator.js";
import { createTimeoutWorker } from "./timeout-worker.js";
import { encodeBase58 } from "./wallet-auth.js";

const TABLE_ID = "018f47a6-7b9d-7cc3-8a23-60bfc31e3f45";
const ROOM_ID = "018f47a6-7b9d-7cc3-8a23-60bfc31e3f46";

function wallet() {
  const { publicKey } = generateKeyPairSync("ed25519");
  return encodeBase58(publicKey.export({ type: "spki", format: "der" }).subarray(-32));
}

test("leased timeout worker applies an expired turn exactly once", async () => {
  let now = new Date("2026-08-17T12:00:00.000Z");
  const store = new MemoryTableEventStore();
  const coordinator = new AuthoritativeTableCoordinator({ store, clock: () => now });
  const players = [wallet(), wallet()];
  await coordinator.createTable({
    tableId: TABLE_ID,
    roomId: ROOM_ID,
    assetMint: wallet(),
    allowlistVersion: "launch-v1",
    rules: {
      game: "NLH",
      seats: 2,
      smallBlindAtomic: "10",
      bigBlindAtomic: "20",
      minimumBuyInAtomic: "100",
      maximumBuyInAtomic: "2000",
      actionClockMs: 5_000,
      timeBankMs: 5_000,
    },
    idempotencyKey: "worker-create-table-001",
  });
  for (const [seat, playerId] of players.entries()) {
    await coordinator.seatPlayer({
      tableId: TABLE_ID,
      playerId,
      seat,
      buyInAtomic: "1000",
      expectedVersion: seat + 1,
      idempotencyKey: `worker-seat-player-${seat}-001`,
    });
  }
  const setup = nextHandSetup(await coordinator.state(TABLE_ID));
  await coordinator.startHand({
    tableId: TABLE_ID,
    handId: setup.handId,
    deckRoot: "ab".repeat(32),
    fairnessTranscriptHead: "cd".repeat(32),
    expectedVersion: 3,
    idempotencyKey: "worker-start-hand-001",
  });
  await coordinator.leave({
    tableId: TABLE_ID,
    playerId: players[1],
    expectedVersion: 4,
    idempotencyKey: "worker-leave-during-clock-001",
  });
  now = new Date("2026-08-17T12:00:11.000Z");
  const worker = createTimeoutWorker({
    store,
    coordinator,
    ownerId: "timeout-worker-test",
    clock: () => now,
  });
  assert.deepEqual(await worker.runOnce(), { claimed: 1, applied: 1 });
  assert.deepEqual(await worker.runOnce(), { claimed: 0, applied: 0 });
  const state = await coordinator.state(TABLE_ID);
  assert.equal(state.version, 6);
  assert.equal((await coordinator.events(TABLE_ID)).filter((event) => event.type === "ACTION_TIMED_OUT").length, 1);
  await worker.stop();
});

test("event fanout failure cannot roll back or disguise a committed command", async () => {
  const errors = [];
  const coordinator = new AuthoritativeTableCoordinator({
    store: new MemoryTableEventStore(),
    onEvent: async () => { throw new Error("fanout unavailable"); },
    onEventError: (error) => errors.push(error.message),
  });
  const result = await coordinator.createTable({
    tableId: TABLE_ID,
    roomId: ROOM_ID,
    assetMint: wallet(),
    allowlistVersion: "launch-v1",
    rules: {
      game: "NLH",
      seats: 2,
      smallBlindAtomic: "10",
      bigBlindAtomic: "20",
      minimumBuyInAtomic: "100",
      maximumBuyInAtomic: "2000",
    },
    idempotencyKey: "fanout-create-table-001",
  });
  assert.equal(result.event.sequence, 1);
  assert.deepEqual(errors, ["fanout unavailable"]);
  assert.equal((await coordinator.state(TABLE_ID)).version, 1);
});
