import assert from "node:assert/strict";
import test from "node:test";

import {
  createHoleCardCipher,
  decryptHoleCards,
  generateClientHoleCardKeyPair,
} from "./hole-card-crypto.js";

test("hole cards decrypt only with the authenticated connection key and immutable AAD", () => {
  const client = generateClientHoleCardKeyPair();
  const cipher = createHoleCardCipher({ clientPublicKey: client.publicKey, wallet: "wallet-a" });
  const payload = {
    version: "xpoker-private-deal/v1",
    reveals: [
      { position: 0, card: 12, nonce: "aa".repeat(32), proof: [] },
      { position: 2, card: 51, nonce: "bb".repeat(32), proof: [] },
    ],
  };
  const envelope = cipher.encrypt({
    tableId: "018f47a6-7b9d-7cc3-8a23-60bfc31e3f45",
    handId: "table:018f47a6-7b9d-7cc3-8a23-60bfc31e3f45:1",
    deckRoot: "ab".repeat(32),
    payload,
  });
  assert.deepEqual(decryptHoleCards({
    envelope,
    clientPrivateKey: client.privateKey,
    serverPublicKey: cipher.serverPublicKey,
  }), payload);
  assert.throws(() => decryptHoleCards({
    envelope: { ...envelope, handId: `${envelope.handId}:altered` },
    clientPrivateKey: client.privateKey,
    serverPublicKey: cipher.serverPublicKey,
  }));
  const attacker = generateClientHoleCardKeyPair();
  assert.throws(() => decryptHoleCards({
    envelope,
    clientPrivateKey: attacker.privateKey,
    serverPublicKey: cipher.serverPublicKey,
  }));
  cipher.close();
  assert.throws(() => cipher.encrypt({
    tableId: envelope.tableId,
    handId: envelope.handId,
    deckRoot: envelope.deckRoot,
    payload,
  }), /closed/i);
});
