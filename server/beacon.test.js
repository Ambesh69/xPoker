import assert from "node:assert/strict";
import test from "node:test";

import {
  DRAND_QUICKNET,
  createReservedBeaconVerifier,
  fetchVerifiedBeacon,
  reserveFutureRound,
} from "./beacon.js";

const info = {
  public_key: DRAND_QUICKNET.publicKey,
  period: 3,
  genesis_time: 1_692_803_367,
  hash: DRAND_QUICKNET.chainHash,
};

function client(disableBeaconVerification = false) {
  return {
    options: { disableBeaconVerification },
    chain: () => ({ info: async () => info }),
  };
}

test("beacon reservations select a pinned future Quicknet round", async () => {
  const reservation = await reserveFutureRound({
    client: client(),
    now: Date.parse("2026-08-17T12:00:00.000Z"),
    safetyRounds: 2,
  });
  assert.equal(reservation.source, DRAND_QUICKNET.source);
  assert.equal(reservation.chainHash, DRAND_QUICKNET.chainHash);
  assert.ok(Date.parse(reservation.notBefore) > Date.parse("2026-08-17T12:00:00.000Z"));
});

test("verified beacon fetches fail closed when signature verification is disabled", async () => {
  const reservation = {
    source: DRAND_QUICKNET.source,
    chainHash: DRAND_QUICKNET.chainHash,
    round: 10,
  };
  await assert.rejects(
    fetchVerifiedBeacon({ reservation, client: client(true), fetcher: async () => ({}) }),
    /cannot be disabled/i,
  );
});

test("reserved beacon verifier compares every signed field", async () => {
  const reservation = {
    source: DRAND_QUICKNET.source,
    chainHash: DRAND_QUICKNET.chainHash,
    round: 10,
  };
  const fetched = {
    round: 10,
    randomness: "ab".repeat(32),
    signature: "cd".repeat(48),
  };
  const verifier = createReservedBeaconVerifier({ client: client(), fetcher: async () => fetched });
  const beacon = {
    ...reservation,
    randomness: fetched.randomness,
    signature: fetched.signature,
    signatureVerified: true,
  };
  assert.equal(await verifier({ beacon, reservation }), true);
  assert.equal(await verifier({ beacon: { ...beacon, randomness: "ef".repeat(32) }, reservation }), false);
});
