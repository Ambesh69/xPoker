import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import {
  MemoryChallengeStore,
  encodeBase58,
  issueWalletChallenge,
  verifyWalletChallenge,
} from "./wallet-auth.js";

function walletFixture() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ type: "spki", format: "der" });
  return { privateKey, wallet: encodeBase58(der.subarray(-32)) };
}

test("wallet challenge proves ownership once and is bound to origin", async () => {
  const fixture = walletFixture();
  const store = new MemoryChallengeStore();
  const now = new Date("2026-08-17T12:00:00.000Z");
  const challenge = await issueWalletChallenge({
    wallet: fixture.wallet,
    uri: "https://xpoker.example/play",
    domain: "xpoker.example",
    store,
    now,
  });
  const signature = sign(null, Buffer.from(challenge.message), fixture.privateKey).toString("base64url");
  const authenticated = await verifyWalletChallenge({
    id: challenge.id,
    wallet: fixture.wallet,
    signature,
    uri: "https://xpoker.example/table/1",
    domain: "xpoker.example",
    store,
    now: new Date(now.getTime() + 1_000),
  });
  assert.equal(authenticated.wallet, fixture.wallet);
  await assert.rejects(
    verifyWalletChallenge({
      id: challenge.id,
      wallet: fixture.wallet,
      signature,
      uri: "https://xpoker.example",
      domain: "xpoker.example",
      store,
      now,
    }),
    /already used/i,
  );
});

test("wallet challenge rejects invalid signatures and consumes the nonce", async () => {
  const owner = walletFixture();
  const attacker = walletFixture();
  const store = new MemoryChallengeStore();
  const now = new Date("2026-08-17T12:00:00.000Z");
  const challenge = await issueWalletChallenge({
    wallet: owner.wallet,
    uri: "https://xpoker.example",
    domain: "xpoker.example",
    store,
    now,
  });
  const badSignature = sign(null, Buffer.from(challenge.message), attacker.privateKey).toString("base64url");
  await assert.rejects(
    verifyWalletChallenge({
      id: challenge.id,
      wallet: owner.wallet,
      signature: badSignature,
      uri: "https://xpoker.example",
      domain: "xpoker.example",
      store,
      now,
    }),
    /invalid/i,
  );
  await assert.rejects(
    verifyWalletChallenge({
      id: challenge.id,
      wallet: owner.wallet,
      signature: badSignature,
      uri: "https://xpoker.example",
      domain: "xpoker.example",
      store,
      now,
    }),
    /already used/i,
  );
});
