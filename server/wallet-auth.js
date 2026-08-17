import {
  createHash,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify,
} from "node:crypto";

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_INDEX = new Map([...BASE58_ALPHABET].map((character, index) => [character, index]));
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function sha256(value) {
  return createHash("sha256").update(value).digest();
}

export function decodeBase58(value) {
  if (typeof value !== "string" || value.length === 0) throw new Error("Base58 value is required");
  let number = 0n;
  for (const character of value) {
    const digit = BASE58_INDEX.get(character);
    if (digit === undefined) throw new Error("Invalid base58 character");
    number = number * 58n + BigInt(digit);
  }
  const bytes = [];
  while (number > 0n) {
    bytes.push(Number(number % 256n));
    number /= 256n;
  }
  bytes.reverse();
  let leadingZeroes = 0;
  while (value[leadingZeroes] === "1") leadingZeroes += 1;
  return Buffer.concat([Buffer.alloc(leadingZeroes), Buffer.from(bytes)]);
}

export function encodeBase58(bytes) {
  const input = Buffer.from(bytes);
  let number = 0n;
  for (const byte of input) number = number * 256n + BigInt(byte);
  let output = "";
  while (number > 0n) {
    output = BASE58_ALPHABET[Number(number % 58n)] + output;
    number /= 58n;
  }
  for (const byte of input) {
    if (byte !== 0) break;
    output = `1${output}`;
  }
  return output || "1";
}

export class MemoryChallengeStore {
  constructor() {
    this.durable = false;
    this.challenges = new Map();
  }

  async put(idHash, record) {
    this.challenges.set(idHash, structuredClone(record));
  }

  async consume(idHash) {
    const record = this.challenges.get(idHash);
    this.challenges.delete(idHash);
    return record ? structuredClone(record) : undefined;
  }
}

function normalizeOrigin(uri) {
  const parsed = new URL(uri);
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost") throw new Error("Wallet auth URI must use HTTPS");
  return parsed;
}

export async function issueWalletChallenge({
  wallet,
  uri,
  domain,
  store,
  now = new Date(),
  ttlMs = 5 * 60_000,
}) {
  const walletBytes = decodeBase58(wallet);
  if (walletBytes.length !== 32) throw new Error("Solana wallet must be a 32-byte public key");
  if (!store?.put) throw new Error("Challenge store is required");
  const parsedUri = normalizeOrigin(uri);
  if (parsedUri.host !== domain) throw new Error("Wallet auth domain does not match URI");
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 30_000 || ttlMs > 10 * 60_000) throw new Error("Challenge TTL is outside the allowed range");

  const id = randomBytes(32).toString("base64url");
  const nonce = randomBytes(16).toString("base64url");
  const issuedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  const message = [
    `${domain} wants you to authenticate with your Solana account:`,
    wallet,
    "",
    "Sign in to xPoker. This request does not authorize a transaction.",
    "",
    `URI: ${parsedUri.origin}`,
    "Version: 1",
    "Chain ID: solana:mainnet",
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
    `Expiration Time: ${expiresAt}`,
    `Request ID: ${id}`,
  ].join("\n");
  const idHash = sha256(id).toString("hex");
  await store.put(idHash, { wallet, domain, origin: parsedUri.origin, message, issuedAt, expiresAt });
  return { id, message, expiresAt };
}

export async function verifyWalletChallenge({
  id,
  wallet,
  signature,
  uri,
  domain,
  store,
  now = new Date(),
}) {
  if (!store?.consume) throw new Error("Challenge store is required");
  const idHash = sha256(id).toString("hex");
  const record = await store.consume(idHash);
  if (!record) throw new Error("Challenge is missing, expired, or already used");
  const parsedUri = normalizeOrigin(uri);
  const sameWallet = timingSafeEqual(sha256(wallet), sha256(record.wallet));
  if (!sameWallet || domain !== record.domain || parsedUri.origin !== record.origin) throw new Error("Challenge binding does not match");
  if (now.getTime() >= Date.parse(record.expiresAt)) throw new Error("Challenge has expired");
  if (now.getTime() < Date.parse(record.issuedAt) - 30_000) throw new Error("Challenge is not valid yet");

  const publicKeyBytes = decodeBase58(wallet);
  if (publicKeyBytes.length !== 32) throw new Error("Solana wallet must be a 32-byte public key");
  const publicKey = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, publicKeyBytes]),
    format: "der",
    type: "spki",
  });
  const signatureBytes = Buffer.from(signature, "base64url");
  if (signatureBytes.length !== 64) throw new Error("Wallet signature must be 64 bytes");
  if (!verify(null, Buffer.from(record.message, "utf8"), publicKey, signatureBytes)) {
    throw new Error("Wallet signature is invalid");
  }
  return Object.freeze({ wallet, authenticatedAt: now.toISOString(), challengeIdHash: idHash });
}
