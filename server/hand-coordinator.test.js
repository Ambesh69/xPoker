import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import test from "node:test";

import {
  commitPlayerSeed,
  commitServerSeed,
  createCommittedHand,
  dealPlan,
  revealCard,
} from "../fairness/protocol.js";
import { DRAND_QUICKNET } from "./beacon.js";
import {
  AuthoritativeHandCoordinator,
  MemoryDealerSecretStore,
  MemoryHandEventStore,
} from "./hand-coordinator.js";
import { TranscriptSigner, verifyTranscript } from "./transcript.js";

function seed(label) {
  return createHash("sha256").update(label).digest("hex");
}

function setup() {
  const keypair = generateKeyPairSync("ed25519");
  const store = new MemoryHandEventStore();
  const dealerStore = new MemoryDealerSecretStore();
  const signer = new TranscriptSigner(keypair.privateKey);
  const coordinator = new AuthoritativeHandCoordinator({
    store,
    dealerStore,
    signer,
    beaconVerifier: async ({ beacon }) => beacon.signature === "verified-test-signature",
    clock: () => new Date("2026-08-17T12:00:00.000Z"),
  });
  return { coordinator, keypair, store };
}

const handId = "hand-coordinator-001";
const roomId = "018f47a6-7b9d-7cc3-8a23-60bfc31e3f45";
const rules = { game: "NLH", seats: 2, buttonSeat: 0, boards: 1, burns: true };
const playerSeeds = [
  { playerId: "wallet-a", seed: seed("player-a") },
  { playerId: "wallet-b", seed: seed("player-b") },
];
const serverSeed = seed("server-seed");
const beacon = {
  source: DRAND_QUICKNET.source,
  chainHash: DRAND_QUICKNET.chainHash,
  round: 99,
  randomness: seed("beacon-99"),
  signature: "verified-test-signature",
  signatureVerified: true,
};
const reservation = {
  source: beacon.source,
  chainHash: beacon.chainHash,
  round: beacon.round,
  notBefore: "2026-08-17T12:00:10.000Z",
};

async function reachDealing(coordinator) {
  await coordinator.openHand({
    handId,
    roomId,
    rules,
    players: playerSeeds.map((player) => player.playerId),
    serverCommitment: commitServerSeed({ handId, seed: serverSeed }),
    idempotencyKey: "open-hand-request-0001",
  });
  let version = 1;
  for (const player of playerSeeds) {
    await coordinator.submitPlayerCommitment({
      handId,
      playerId: player.playerId,
      commitment: commitPlayerSeed({ handId, playerId: player.playerId, seed: player.seed }),
      expectedVersion: version,
      idempotencyKey: `commit-${player.playerId}-0001`,
    });
    version += 1;
  }
  await coordinator.reserveBeacon({
    handId,
    reservation,
    expectedVersion: version,
    idempotencyKey: "reserve-beacon-0001",
  });
  version += 1;
  const committedHand = createCommittedHand({
    handId,
    rules,
    beacon,
    players: playerSeeds,
    serverSeed,
  });
  await coordinator.commitDeck({
    handId,
    beacon,
    serverSeed,
    playerSeeds,
    expectedVersion: version,
    idempotencyKey: "commit-deck-0001",
  });
  return { committedHand, version: version + 1 };
}

test("authoritative coordinator completes a signed, verifiable hand lifecycle", async () => {
  const { coordinator, keypair, store } = setup();
  const { committedHand, version } = await reachDealing(coordinator);
  const flopPosition = dealPlan(rules).boards[0].flop[0];
  const reveal = revealCard(committedHand.secretState.deck, flopPosition);
  const revealed = await coordinator.revealPublicCard({
    handId,
    position: flopPosition,
    expectedVersion: version,
    idempotencyKey: "reveal-flop-card-01",
  });
  assert.deepEqual(revealed.reveal, reveal);
  const revealRetry = await coordinator.revealPublicCard({
    handId,
    position: flopPosition,
    expectedVersion: version,
    idempotencyKey: "reveal-flop-card-01",
  });
  assert.equal(revealRetry.duplicate, true);
  const completed = await coordinator.completeHand({
    handId,
    expectedVersion: version + 1,
    idempotencyKey: "complete-hand-00001",
  });
  const completionRetry = await coordinator.completeHand({
    handId,
    expectedVersion: version + 1,
    idempotencyKey: "complete-hand-00001",
  });
  assert.equal(completionRetry.duplicate, true);
  assert.deepEqual(completionRetry.auditBundle, completed.auditBundle);
  const state = await coordinator.state(handId);
  assert.equal(state.status, "COMPLETE");
  assert.deepEqual(state.publicPositions, [flopPosition]);
  const transcript = await store.load(handId);
  assert.equal(verifyTranscript(transcript, keypair.publicKey).ok, true);
});

test("coordinator rejects stale versions, fake beacons, and non-public positions", async () => {
  const { coordinator } = setup();
  await coordinator.openHand({
    handId,
    roomId,
    rules,
    players: playerSeeds.map((player) => player.playerId),
    serverCommitment: commitServerSeed({ handId, seed: serverSeed }),
    idempotencyKey: "open-hand-request-0001",
  });
  await coordinator.submitPlayerCommitment({
    handId,
    playerId: "wallet-a",
    commitment: commitPlayerSeed({ handId, playerId: "wallet-a", seed: playerSeeds[0].seed }),
    expectedVersion: 1,
    idempotencyKey: "commit-wallet-a-0001",
  });
  await assert.rejects(
    coordinator.submitPlayerCommitment({
      handId,
      playerId: "wallet-b",
      commitment: commitPlayerSeed({ handId, playerId: "wallet-b", seed: playerSeeds[1].seed }),
      expectedVersion: 1,
      idempotencyKey: "commit-wallet-b-0001",
    }),
    /version conflict/i,
  );
  await coordinator.submitPlayerCommitment({
    handId,
    playerId: "wallet-b",
    commitment: commitPlayerSeed({ handId, playerId: "wallet-b", seed: playerSeeds[1].seed }),
    expectedVersion: 2,
    idempotencyKey: "commit-wallet-b-0002",
  });
  await coordinator.reserveBeacon({
    handId,
    reservation,
    expectedVersion: 3,
    idempotencyKey: "reserve-beacon-0002",
  });
  await assert.rejects(
    coordinator.commitDeck({
      handId,
      beacon,
      serverSeed: seed("substituted-server-seed"),
      playerSeeds,
      expectedVersion: 4,
      idempotencyKey: "fake-server-seed-01",
    }),
    /server seed does not match/i,
  );

  const other = setup().coordinator;
  const { committedHand, version } = await reachDealing(other);
  await assert.rejects(
    other.revealPublicCard({
      handId,
      position: 0,
      expectedVersion: version,
      idempotencyKey: "reveal-private-card-1",
    }),
    /not a public card/i,
  );
  const turnPosition = dealPlan(rules).boards[0].turn[0];
  await assert.rejects(
    other.revealPublicCard({
      handId,
      position: turnPosition,
      expectedVersion: version,
      idempotencyKey: "reveal-turn-too-early",
    }),
    /deal order/i,
  );
});

test("idempotent retries return the original event and changed payloads are rejected", async () => {
  const { coordinator } = setup();
  const input = {
    handId,
    roomId,
    rules,
    players: playerSeeds.map((player) => player.playerId),
    serverCommitment: commitServerSeed({ handId, seed: serverSeed }),
    idempotencyKey: "open-hand-request-0001",
  };
  const first = await coordinator.openHand(input);
  const retry = await coordinator.openHand(input);
  assert.equal(retry.duplicate, true);
  assert.deepEqual(retry.event, first.event);
  await assert.rejects(
    coordinator.openHand({ ...input, serverCommitment: "ab".repeat(32) }),
    /reused with different input/i,
  );
});
