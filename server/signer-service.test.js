import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import { createSignerServer } from "./signer-service.js";
import { RemoteTranscriptSigner, verifyTranscript } from "./transcript.js";

test("remote signer keeps the private key out of the API and returns verifiable transcript events", async (t) => {
  const keypair = generateKeyPairSync("ed25519");
  const token = "remote-signer-test-token".padEnd(40, "x");
  const server = createSignerServer({
    signingKeyPem: keypair.privateKey.export({ type: "pkcs8", format: "pem" }),
    authToken: token,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const signer = await RemoteTranscriptSigner.connect({ url: `http://127.0.0.1:${address.port}`, token });
  const first = await signer.append({
    handId: "hand:remote-signer-1",
    type: "HAND_OPENED",
    payload: { roomId: "room-1" },
    occurredAt: "2026-08-20T00:00:00.000Z",
  });
  const second = await signer.append({
    handId: "hand:remote-signer-1",
    type: "HAND_COMPLETED",
    payload: {},
    previousEvent: first,
    occurredAt: "2026-08-20T00:00:01.000Z",
  });
  assert.equal(verifyTranscript([first, second], keypair.publicKey).ok, true);
  assert.equal("privateKey" in signer, false);
});

test("remote signer rejects missing authentication and unsupported event types", async (t) => {
  const keypair = generateKeyPairSync("ed25519");
  const token = "remote-signer-test-token".padEnd(40, "x");
  const server = createSignerServer({
    signingKeyPem: keypair.privateKey.export({ type: "pkcs8", format: "pem" }),
    authToken: token,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  assert.equal((await fetch(`${base}/v1/public-key`)).status, 401);
  const response = await fetch(`${base}/v1/transcript-events`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      handId: "hand:remote-signer-2",
      type: "ARBITRARY_SIGNATURE",
      payload: {},
      occurredAt: "2026-08-20T00:00:00.000Z",
    }),
  });
  assert.equal(response.status, 400);
});
