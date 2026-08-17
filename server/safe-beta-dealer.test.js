import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import test from "node:test";

import { DRAND_QUICKNET } from "./beacon.js";
import {
  AuthoritativeHandCoordinator,
  MemoryDealerSecretStore,
  MemoryHandEventStore,
} from "./hand-coordinator.js";
import { SafeBetaDealer } from "./safe-beta-dealer.js";
import {
  AuthoritativeTableCoordinator,
  MemoryTableEventStore,
} from "./table-coordinator.js";
import { TranscriptSigner } from "./transcript.js";
import { encodeBase58 } from "./wallet-auth.js";

function wallet(label) {
  return encodeBase58(createHash("sha256").update(label).digest());
}

class TestRedis {
  constructor() { this.values = new Map(); }
  async set(key, value, options = {}) {
    if (options.NX && this.values.has(key)) return null;
    this.values.set(key, value);
    return "OK";
  }
  async get(key) { return this.values.get(key) ?? null; }
  async del(key) { return this.values.delete(key) ? 1 : 0; }
  async eval(_script, { keys, arguments: values }) {
    if (this.values.get(keys[0]) !== values[0]) return 0;
    return this.del(keys[0]);
  }
}

class TestDealerStore extends MemoryDealerSecretStore {
  constructor() { super(); this.preparations = new Map(); }
  async putPreparation(handId, preparation) {
    if (!this.preparations.has(handId)) this.preparations.set(handId, structuredClone(preparation));
    return structuredClone(this.preparations.get(handId));
  }
  async getPreparation(handId) {
    const value = this.preparations.get(handId);
    return value ? structuredClone(value) : undefined;
  }
}

test("safe-beta dealer commits a future beacon deck, privately deals, and settles a folded hand", async () => {
  const now = new Date("2026-08-17T12:00:00.000Z");
  const clock = () => new Date(now);
  const tableCoordinator = new AuthoritativeTableCoordinator({ store: new MemoryTableEventStore(), clock });
  const dealerStore = new TestDealerStore();
  const handCoordinator = new AuthoritativeHandCoordinator({
    store: new MemoryHandEventStore(),
    dealerStore,
    signer: new TranscriptSigner(generateKeyPairSync("ed25519").privateKey),
    beaconVerifier: async ({ beacon }) => beacon.signature === "verified-test-beacon",
    clock,
  });
  const dealer = new SafeBetaDealer({
    redis: new TestRedis(),
    tableCoordinator,
    handCoordinator,
    dealerStore,
    clock,
    beaconReservation: async () => ({
      source: DRAND_QUICKNET.source,
      chainHash: DRAND_QUICKNET.chainHash,
      round: 123,
      notBefore: new Date(now.getTime() + 1).toISOString(),
    }),
    beaconFetch: async () => ({
      source: DRAND_QUICKNET.source,
      chainHash: DRAND_QUICKNET.chainHash,
      round: 123,
      randomness: "ab".repeat(32),
      signature: "verified-test-beacon",
      signatureVerified: true,
    }),
  });
  const tableId = "20000000-0000-4000-8000-000000000001";
  const roomId = "20000000-0000-4000-8000-000000000002";
  const assetMint = wallet("asset");
  const players = [wallet("player-a"), wallet("player-b")];
  await tableCoordinator.createTable({
    tableId,
    roomId,
    assetMint,
    allowlistVersion: "safe-beta-v1",
    rules: {
      game: "NLH",
      seats: 2,
      smallBlindAtomic: "10",
      bigBlindAtomic: "20",
      minimumBuyInAtomic: "2000",
      maximumBuyInAtomic: "10000",
      actionClockMs: 20_000,
      timeBankMs: 60_000,
    },
    idempotencyKey: "safe-beta-test-create",
  });
  for (let seat = 0; seat < players.length; seat += 1) {
    const state = await tableCoordinator.state(tableId);
    await tableCoordinator.seatPlayer({
      tableId,
      playerId: players[seat],
      seat,
      buyInAtomic: "2000",
      expectedVersion: state.version,
      idempotencyKey: `safe-beta-test-seat-${seat}`,
    });
  }

  await dealer.run(tableId);
  let state = await tableCoordinator.state(tableId);
  assert.equal(state.status, "HAND_ACTIVE");
  assert.match(state.currentHand.deckRoot, /^[0-9a-f]{64}$/);
  const privateDeal = await dealer.getHoleCards({
    handId: state.currentHand.handId,
    wallet: players[0],
  });
  assert.equal(privateDeal.reveals.length, 2);
  assert.ok(privateDeal.reveals.every((reveal) => reveal.proof.length > 0));

  await tableCoordinator.act({
    tableId,
    playerId: state.currentHand.turn.playerId,
    action: { type: "fold" },
    expectedVersion: state.version,
    expectedBettingVersion: state.currentHand.betting.version,
    idempotencyKey: "safe-beta-test-fold",
  });
  await dealer.run(tableId);
  state = await tableCoordinator.state(tableId);
  assert.equal(state.status, "WAITING");
  assert.equal(state.handNumber, 1);
  assert.equal(state.lastResult.handId, `table:${tableId}:1`);
  assert.equal(state.lastResult.rakeAtomic, "0");
  const audit = await dealer.audit(state.lastResult.handId);
  assert.equal(audit.beaconSignatureVerified, true);
  assert.equal(audit.auditBundle.publicRecord.deckRoot, privateDeal.deckRoot);
  assert.match(audit.transcriptHead, /^[0-9a-f]{64}$/);
  await dealer.close();
});
