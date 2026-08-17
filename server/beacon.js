import {
  fetchBeacon,
  quicknetClient,
  roundAt,
  roundTime,
} from "drand-client";

export const DRAND_QUICKNET = Object.freeze({
  chainHash: "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971",
  publicKey: "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a",
  source: "drand-quicknet",
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export async function reserveFutureRound({
  client = quicknetClient(),
  now = Date.now(),
  safetyRounds = 2,
} = {}) {
  assert(Number.isInteger(safetyRounds) && safetyRounds >= 1, "safetyRounds must be a positive integer");
  assert(client.options?.disableBeaconVerification !== true, "Beacon signature verification cannot be disabled");
  const info = await client.chain().info();
  assert(info.hash === DRAND_QUICKNET.chainHash, "Unexpected drand chain hash");
  assert(info.public_key === DRAND_QUICKNET.publicKey, "Unexpected drand public key");
  const currentRound = roundAt(now, info);
  const round = currentRound + safetyRounds;
  return {
    source: DRAND_QUICKNET.source,
    chainHash: DRAND_QUICKNET.chainHash,
    round,
    notBefore: new Date(roundTime(info, round)).toISOString(),
  };
}

export async function fetchVerifiedBeacon({
  reservation,
  client = quicknetClient(),
  fetcher = fetchBeacon,
} = {}) {
  assert(reservation?.source === DRAND_QUICKNET.source, "Unexpected beacon source");
  assert(reservation?.chainHash === DRAND_QUICKNET.chainHash, "Unexpected reserved chain hash");
  assert(Number.isSafeInteger(reservation?.round) && reservation.round > 0, "A positive reserved round is required");
  assert(client.options?.disableBeaconVerification !== true, "Beacon signature verification cannot be disabled");

  const info = await client.chain().info();
  assert(info.hash === DRAND_QUICKNET.chainHash, "Unexpected drand chain hash");
  assert(info.public_key === DRAND_QUICKNET.publicKey, "Unexpected drand public key");

  // drand-client verifies the BLS signature before returning when verification is enabled.
  const beacon = await fetcher(client, reservation.round);
  assert(beacon.round === reservation.round, "Beacon round does not match the reserved round");
  assert(/^[0-9a-f]{64}$/i.test(beacon.randomness), "Beacon randomness must be 32-byte hex");
  assert(typeof beacon.signature === "string" && beacon.signature.length > 0, "Beacon signature is missing");

  return Object.freeze({
    source: DRAND_QUICKNET.source,
    chainHash: DRAND_QUICKNET.chainHash,
    round: beacon.round,
    randomness: beacon.randomness.toLowerCase(),
    signature: beacon.signature.toLowerCase(),
    signatureVerified: true,
  });
}

export function createReservedBeaconVerifier({ client = quicknetClient(), fetcher = fetchBeacon } = {}) {
  return async ({ beacon, reservation }) => {
    const verified = await fetchVerifiedBeacon({ reservation, client, fetcher });
    return beacon?.signatureVerified === true
      && beacon.source === verified.source
      && beacon.chainHash === verified.chainHash
      && beacon.round === verified.round
      && beacon.randomness === verified.randomness
      && beacon.signature === verified.signature;
  };
}
