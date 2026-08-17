import { fetchBeacon, quicknetClient, roundAt } from "drand-client";

import { DRAND_QUICKNET, fetchVerifiedBeacon } from "./beacon.js";

const client = quicknetClient();
const info = await client.chain().info();
const round = Math.max(1, roundAt(Date.now(), info) - 1);
const beacon = await fetchVerifiedBeacon({
  client,
  fetcher: fetchBeacon,
  reservation: {
    source: DRAND_QUICKNET.source,
    chainHash: DRAND_QUICKNET.chainHash,
    round,
  },
});

console.log(JSON.stringify({
  source: beacon.source,
  chainHash: beacon.chainHash,
  round: beacon.round,
  signatureVerified: beacon.signatureVerified,
}, null, 2));
