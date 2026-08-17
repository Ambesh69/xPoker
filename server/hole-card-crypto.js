import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from "node:crypto";

import { canonicalJson } from "../fairness/protocol.js";

const PROTOCOL = "xpoker-hole-cards/v1";
const ALGORITHM = "X25519-HKDF-SHA256+A256GCM";
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
const X25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");

function rawKey(value, label) {
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== 32) throw new Error(`${label} must be a 32-byte X25519 key`);
  return bytes;
}

function publicKeyFromRaw(value) {
  return createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, rawKey(value, "Client public key")]),
    format: "der",
    type: "spki",
  });
}

function privateKeyFromRaw(value) {
  return createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, rawKey(value, "Client private key")]),
    format: "der",
    type: "pkcs8",
  });
}

function exportRawPublic(key) {
  return key.export({ type: "spki", format: "der" }).subarray(-32).toString("base64url");
}

function deriveKey({ privateKey, publicKey, wallet }) {
  const shared = diffieHellman({ privateKey, publicKey });
  const salt = createHash("sha256").update(`${PROTOCOL}:${wallet}`).digest();
  const key = Buffer.from(hkdfSync("sha256", shared, salt, Buffer.from(PROTOCOL), 32));
  shared.fill(0);
  return key;
}

export function createHoleCardCipher({ clientPublicKey, wallet }) {
  if (typeof wallet !== "string" || wallet.length === 0) throw new Error("Authenticated wallet is required");
  const clientKey = publicKeyFromRaw(clientPublicKey);
  const server = generateKeyPairSync("x25519");
  const key = deriveKey({ privateKey: server.privateKey, publicKey: clientKey, wallet });
  let closed = false;

  function encrypt({ tableId, handId, deckRoot, payload }) {
    if (closed) throw new Error("Hole-card cipher is closed");
    if (!Array.isArray(payload?.reveals) || payload.reveals.length < 2 || payload.reveals.length > 4) {
      throw new Error("Private deal payload is invalid");
    }
    const aad = {
      protocol: PROTOCOL,
      algorithm: ALGORITHM,
      tableId,
      handId,
      wallet,
      deckRoot,
      cardCount: payload.reveals.length,
    };
    const aadBytes = Buffer.from(canonicalJson(aad));
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(aadBytes);
    const ciphertext = Buffer.concat([
      cipher.update(Buffer.from(canonicalJson(payload))),
      cipher.final(),
    ]);
    return Object.freeze({
      ...aad,
      iv: iv.toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
    });
  }

  function close() {
    if (!closed) key.fill(0);
    closed = true;
  }

  return Object.freeze({
    protocol: PROTOCOL,
    algorithm: ALGORITHM,
    serverPublicKey: exportRawPublic(server.publicKey),
    encrypt,
    close,
  });
}

// Reference client-side decryptor used by conformance tests and native clients.
export function decryptHoleCards({ envelope, clientPrivateKey, serverPublicKey }) {
  const privateKey = privateKeyFromRaw(clientPrivateKey);
  const publicKey = publicKeyFromRaw(serverPublicKey);
  const key = deriveKey({ privateKey, publicKey, wallet: envelope.wallet });
  try {
    const {
      iv,
      ciphertext,
      tag,
      ...aad
    } = envelope;
    if (aad.protocol !== PROTOCOL || aad.algorithm !== ALGORITHM) throw new Error("Unsupported hole-card envelope");
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
    decipher.setAAD(Buffer.from(canonicalJson(aad)));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertext, "base64url")),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString("utf8"));
  } finally {
    key.fill(0);
  }
}

export function generateClientHoleCardKeyPair() {
  const keypair = generateKeyPairSync("x25519");
  return Object.freeze({
    publicKey: exportRawPublic(keypair.publicKey),
    privateKey: keypair.privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32).toString("base64url"),
  });
}

export { ALGORITHM as HOLE_CARD_ALGORITHM, PROTOCOL as HOLE_CARD_PROTOCOL };
