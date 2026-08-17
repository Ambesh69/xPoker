import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";

import { canonicalJson } from "../fairness/protocol.js";

const TRANSCRIPT_VERSION = "xpoker-hand-transcript/v1";
const GENESIS_HASH = "0".repeat(64);

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function signingPayload(event) {
  const { signature: _signature, ...unsigned } = event;
  return Buffer.from(canonicalJson(unsigned), "utf8");
}

export function transcriptKeyId(publicKey) {
  const key = publicKey?.type === "public" ? publicKey : createPublicKey(publicKey);
  return hash(key.export({ type: "spki", format: "der" })).slice(0, 32);
}

export class TranscriptSigner {
  constructor(privateKey) {
    this.privateKey = privateKey?.type === "private" ? privateKey : createPrivateKey(privateKey);
    assertEd25519(this.privateKey);
    this.publicKey = createPublicKey(this.privateKey);
    this.keyId = transcriptKeyId(this.publicKey);
  }

  publicKeyPem() {
    return this.publicKey.export({ type: "spki", format: "pem" });
  }

  append({ handId, type, payload, previousEvent, occurredAt = new Date().toISOString() }) {
    if (!/^[a-z0-9][a-z0-9:_-]{7,127}$/i.test(handId)) throw new Error("Invalid hand id");
    if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(type)) throw new Error("Invalid transcript event type");
    if (!Number.isFinite(Date.parse(occurredAt))) throw new Error("Invalid transcript timestamp");
    if (previousEvent && Date.parse(occurredAt) < Date.parse(previousEvent.occurredAt)) {
      throw new Error("Transcript timestamps must be monotonic");
    }
    const sequence = previousEvent ? previousEvent.sequence + 1 : 1;
    const previousHash = previousEvent ? previousEvent.eventHash : GENESIS_HASH;
    const base = {
      version: TRANSCRIPT_VERSION,
      handId,
      sequence,
      type,
      occurredAt,
      previousHash,
      signerKeyId: this.keyId,
      payload,
    };
    const eventHash = hash(signingPayload(base));
    const unsigned = { ...base, eventHash };
    const signature = sign(null, signingPayload(unsigned), this.privateKey).toString("base64url");
    return Object.freeze({ ...unsigned, signature });
  }
}

function assertEd25519(key) {
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Transcript key must be Ed25519");
}

export function verifyTranscript(events, publicKey, { expectedHead, expectedLength } = {}) {
  try {
    if (!Array.isArray(events) || events.length === 0) throw new Error("Transcript is empty");
    const key = publicKey?.type === "public" ? publicKey : createPublicKey(publicKey);
    assertEd25519(key);
    const expectedKeyId = transcriptKeyId(key);
    let previousHash = GENESIS_HASH;
    let handId;
    let previousTimestamp = Number.NEGATIVE_INFINITY;

    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      if (event.version !== TRANSCRIPT_VERSION) throw new Error("Unsupported transcript version");
      if (event.sequence !== index + 1) throw new Error("Transcript sequence is not contiguous");
      if (event.previousHash !== previousHash) throw new Error("Transcript hash chain is broken");
      if (event.signerKeyId !== expectedKeyId) throw new Error("Unexpected transcript signing key");
      if (handId && event.handId !== handId) throw new Error("Transcript contains multiple hand ids");
      handId = event.handId;
      const timestamp = Date.parse(event.occurredAt);
      if (!Number.isFinite(timestamp) || timestamp < previousTimestamp) throw new Error("Transcript timestamps are invalid");
      previousTimestamp = timestamp;

      const { eventHash, signature, ...base } = event;
      const calculatedHash = hash(signingPayload(base));
      if (calculatedHash !== eventHash) throw new Error("Transcript event hash is invalid");
      const validSignature = verify(
        null,
        signingPayload({ ...base, eventHash }),
        key,
        Buffer.from(signature, "base64url"),
      );
      if (!validSignature) throw new Error("Transcript signature is invalid");
      previousHash = eventHash;
    }

    if (expectedLength !== undefined && events.length !== expectedLength) {
      throw new Error("Transcript length differs from the anchored length");
    }
    if (expectedHead !== undefined && previousHash !== expectedHead) {
      throw new Error("Transcript head differs from the anchored head");
    }

    return { ok: true, errors: [], head: previousHash, handId };
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : String(error)] };
  }
}

export { GENESIS_HASH, TRANSCRIPT_VERSION };
