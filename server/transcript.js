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
const TRANSCRIPT_EVENT_TYPES = new Set([
  "HAND_OPENED",
  "PLAYER_COMMITTED",
  "BEACON_RESERVED",
  "DECK_COMMITTED",
  "PUBLIC_CARD_REVEALED",
  "HAND_COMPLETED",
  "HAND_ABORTED",
]);

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function signingPayload(event) {
  const { signature: _signature, ...unsigned } = event;
  return Buffer.from(canonicalJson(unsigned), "utf8");
}

function eventBase({ handId, type, payload, previousEvent, occurredAt, signerKeyId }) {
  if (!/^[a-z0-9][a-z0-9:_-]{7,127}$/i.test(handId)) throw new Error("Invalid hand id");
  if (!TRANSCRIPT_EVENT_TYPES.has(type)) throw new Error("Invalid transcript event type");
  if (!Number.isFinite(Date.parse(occurredAt))) throw new Error("Invalid transcript timestamp");
  if (previousEvent && Date.parse(occurredAt) < Date.parse(previousEvent.occurredAt)) {
    throw new Error("Transcript timestamps must be monotonic");
  }
  return {
    version: TRANSCRIPT_VERSION,
    handId,
    sequence: previousEvent ? previousEvent.sequence + 1 : 1,
    type,
    occurredAt,
    previousHash: previousEvent ? previousEvent.eventHash : GENESIS_HASH,
    signerKeyId,
    payload,
  };
}

function eventMatchesRequest(event, input) {
  const expected = eventBase({ ...input, signerKeyId: event.signerKeyId });
  const { eventHash: _eventHash, signature: _signature, ...base } = event;
  return canonicalJson(base) === canonicalJson(expected);
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
    const base = eventBase({ handId, type, payload, previousEvent, occurredAt, signerKeyId: this.keyId });
    const eventHash = hash(signingPayload(base));
    const unsigned = { ...base, eventHash };
    const signature = sign(null, signingPayload(unsigned), this.privateKey).toString("base64url");
    return Object.freeze({ ...unsigned, signature });
  }
}

function requestHeaders(token) {
  return {
    accept: "application/json",
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "user-agent": "xpoker-api/remote-transcript-signer",
  };
}

async function requestJson(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Remote signer request timed out")), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error(`Remote signer returned HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

export class RemoteTranscriptSigner {
  constructor({ url, token, publicKeyPem, fetchImpl = globalThis.fetch, timeoutMs = 2_000 } = {}) {
    if (!url || !token || token.length < 32) throw new Error("Remote signer URL and strong token are required");
    if (typeof fetchImpl !== "function") throw new Error("Remote signer requires fetch");
    this.url = url.replace(/\/$/, "");
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.publicKey = createPublicKey(publicKeyPem);
    assertEd25519(this.publicKey);
    this.keyId = transcriptKeyId(this.publicKey);
  }

  static async connect({ url, token, fetchImpl = globalThis.fetch, timeoutMs = 2_000 } = {}) {
    const endpoint = url?.replace(/\/$/, "");
    if (!endpoint || !token || token.length < 32) throw new Error("Remote signer URL and strong token are required");
    const record = await requestJson(fetchImpl, `${endpoint}/v1/public-key`, {
      method: "GET",
      headers: requestHeaders(token),
    }, timeoutMs);
    return new RemoteTranscriptSigner({ url: endpoint, token, publicKeyPem: record.publicKeyPem, fetchImpl, timeoutMs });
  }

  publicKeyPem() {
    return this.publicKey.export({ type: "spki", format: "pem" });
  }

  async append({ handId, type, payload, previousEvent, occurredAt = new Date().toISOString() }) {
    const input = { handId, type, payload, previousEvent, occurredAt };
    eventBase({ ...input, signerKeyId: this.keyId });
    const event = await requestJson(this.fetchImpl, `${this.url}/v1/transcript-events`, {
      method: "POST",
      headers: requestHeaders(this.token),
      body: JSON.stringify(input),
    }, this.timeoutMs);
    if (event.signerKeyId !== this.keyId || !eventMatchesRequest(event, input)) {
      throw new Error("Remote signer response does not match the requested transcript event");
    }
    const { signature, eventHash, ...base } = event;
    if (hash(signingPayload(base)) !== eventHash || !verify(
      null,
      signingPayload({ ...base, eventHash }),
      this.publicKey,
      Buffer.from(signature, "base64url"),
    )) throw new Error("Remote signer returned an invalid transcript signature");
    return Object.freeze(event);
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

export { GENESIS_HASH, TRANSCRIPT_EVENT_TYPES, TRANSCRIPT_VERSION };
