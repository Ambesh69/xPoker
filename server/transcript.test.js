import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import { TranscriptSigner, verifyTranscript } from "./transcript.js";

test("signed transcript detects modification, deletion, and reordering", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const signer = new TranscriptSigner(privateKey);
  const first = signer.append({
    handId: "hand-transcript-1",
    type: "HAND_OPENED",
    payload: { rulesHash: "ab".repeat(32) },
    occurredAt: "2026-08-17T12:00:00.000Z",
  });
  const second = signer.append({
    handId: "hand-transcript-1",
    type: "DECK_COMMITTED",
    payload: { deckRoot: "cd".repeat(32) },
    previousEvent: first,
    occurredAt: "2026-08-17T12:00:01.000Z",
  });
  const valid = verifyTranscript([first, second], publicKey);
  assert.equal(valid.ok, true);
  assert.equal(valid.head, second.eventHash);

  const tampered = structuredClone([first, second]);
  tampered[1].payload.deckRoot = "ef".repeat(32);
  assert.equal(verifyTranscript(tampered, publicKey).ok, false);
  assert.equal(verifyTranscript([second], publicKey).ok, false);
  assert.equal(verifyTranscript([second, first], publicKey).ok, false);
  assert.equal(
    verifyTranscript([first], publicKey, { expectedHead: second.eventHash, expectedLength: 2 }).ok,
    false,
  );
});

test("a transcript cannot be verified under another dealer key", () => {
  const dealer = generateKeyPairSync("ed25519");
  const attacker = generateKeyPairSync("ed25519");
  const event = new TranscriptSigner(dealer.privateKey).append({
    handId: "hand-transcript-2",
    type: "HAND_OPENED",
    payload: {},
  });
  assert.equal(verifyTranscript([event], attacker.publicKey).ok, false);
});
