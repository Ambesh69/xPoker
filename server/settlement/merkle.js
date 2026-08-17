import { createHash, timingSafeEqual } from "node:crypto";
import { decodeBase58, encodeBase58 } from "../wallet-auth.js";

const LEAF_DOMAIN = Buffer.from("xpoker:settlement:leaf:v1", "utf8");
const NODE_DOMAIN = Buffer.from("xpoker:settlement:node:v1", "utf8");
const U64_MAX = (1n << 64n) - 1n;

function sha256(parts) {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest();
}

function publicKeyBytes(value, label) {
  const bytes = decodeBase58(value);
  if (bytes.length !== 32 || encodeBase58(bytes) !== value) {
    throw new Error(`${label} must be a canonical 32-byte Solana public key`);
  }
  return bytes;
}

function atomicU64(value, label = "amountAtomic") {
  if (typeof value !== "bigint" && !(typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value))) {
    throw new Error(`${label} must be a bigint or canonical unsigned decimal string`);
  }
  const amount = BigInt(value);
  if (amount <= 0n || amount > U64_MAX) throw new Error(`${label} must fit a positive u64`);
  return amount;
}

function u64be(value) {
  const output = Buffer.alloc(8);
  output.writeBigUInt64BE(value);
  return output;
}

function hashNode(first, second) {
  const [left, right] = Buffer.compare(first, second) <= 0
    ? [first, second]
    : [second, first];
  return sha256([NODE_DOMAIN, left, right]);
}

function decodeHash(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label} must be a lowercase 32-byte hex string`);
  }
  return Buffer.from(value, "hex");
}

export function settlementLeaf({ session, player, amountAtomic }) {
  const sessionBytes = publicKeyBytes(session, "session");
  const playerBytes = publicKeyBytes(player, "player");
  const amount = atomicU64(amountAtomic);
  return sha256([LEAF_DOMAIN, sessionBytes, playerBytes, u64be(amount)]).toString("hex");
}

export function buildSettlementTree({ session, payouts, expectedTotalAtomic }) {
  const sessionBytes = publicKeyBytes(session, "session");
  if (!Array.isArray(payouts) || payouts.length === 0) {
    throw new Error("At least one payout is required");
  }

  const seenPlayers = new Set();
  const leaves = payouts.map((payout) => {
    const playerBytes = publicKeyBytes(payout.player, "player");
    const player = encodeBase58(playerBytes);
    if (seenPlayers.has(player)) throw new Error("A settlement can contain only one payout per player");
    seenPlayers.add(player);
    const amount = atomicU64(payout.amountAtomic);
    return {
      player,
      playerBytes,
      amount,
      hash: sha256([LEAF_DOMAIN, sessionBytes, playerBytes, u64be(amount)]),
      proof: [],
    };
  }).sort((left, right) => Buffer.compare(left.playerBytes, right.playerBytes));

  const totalAtomic = leaves.reduce((sum, leaf) => sum + leaf.amount, 0n);
  if (totalAtomic > U64_MAX) throw new Error("Settlement total exceeds u64");
  if (expectedTotalAtomic !== undefined && totalAtomic !== atomicU64(expectedTotalAtomic, "expectedTotalAtomic")) {
    throw new Error("Settlement payouts do not equal the expected vault balance");
  }

  let level = leaves.map((leaf, index) => ({ hash: leaf.hash, indexes: [index] }));
  while (level.length > 1) {
    const next = [];
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index];
      const right = level[index + 1];
      if (!right) {
        next.push(left);
        continue;
      }
      for (const leafIndex of left.indexes) leaves[leafIndex].proof.push(right.hash);
      for (const leafIndex of right.indexes) leaves[leafIndex].proof.push(left.hash);
      next.push({
        hash: hashNode(left.hash, right.hash),
        indexes: [...left.indexes, ...right.indexes],
      });
    }
    level = next;
  }

  return Object.freeze({
    session,
    root: level[0].hash.toString("hex"),
    totalAtomic: totalAtomic.toString(),
    claims: Object.freeze(leaves.map((leaf) => Object.freeze({
      player: leaf.player,
      amountAtomic: leaf.amount.toString(),
      leaf: leaf.hash.toString("hex"),
      proof: Object.freeze(leaf.proof.map((hash) => hash.toString("hex"))),
    }))),
  });
}

export function verifySettlementClaim({ session, root, player, amountAtomic, proof }) {
  let current = Buffer.from(settlementLeaf({ session, player, amountAtomic }), "hex");
  if (!Array.isArray(proof) || proof.length > 32) return false;
  try {
    for (const sibling of proof) current = hashNode(current, decodeHash(sibling, "proof node"));
    return timingSafeEqual(current, decodeHash(root, "root"));
  } catch {
    return false;
  }
}

export const SETTLEMENT_MERKLE_VERSION = "xpoker-settlement-v1";

