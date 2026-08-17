import { createHash, randomBytes } from "node:crypto";

function keyHash(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function createRedisConnection(url) {
  const { createClient } = await import("redis");
  return createClient({
    url,
    socket: {
      connectTimeout: 5_000,
      reconnectStrategy: (retries) => Math.min(50 * 2 ** retries, 3_000),
    },
  });
}

export class RedisChallengeStore {
  constructor(client, { prefix = "xpoker:challenge:" } = {}) {
    this.client = client;
    this.prefix = prefix;
    this.durable = true;
  }

  async put(idHash, record) {
    const ttl = Date.parse(record.expiresAt) - Date.now();
    if (!Number.isFinite(ttl) || ttl <= 0) throw new Error("Challenge expiry is invalid");
    const result = await this.client.set(`${this.prefix}${idHash}`, JSON.stringify(record), { PX: ttl, NX: true });
    if (result !== "OK") throw new Error("Challenge id collision");
  }

  async consume(idHash) {
    const value = await this.client.getDel(`${this.prefix}${idHash}`);
    return value ? JSON.parse(value) : undefined;
  }
}

export class RedisSessionStore {
  constructor(client, { prefix = "xpoker:session:" } = {}) {
    this.client = client;
    this.prefix = prefix;
    this.durable = true;
  }

  async issue({ wallet, ttlSeconds = 3_600 }) {
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 86_400) {
      throw new Error("Session TTL is outside the allowed range");
    }
    const token = randomBytes(32).toString("base64url");
    const tokenHash = keyHash(token);
    const record = {
      wallet,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + ttlSeconds * 1_000).toISOString(),
    };
    const result = await this.client.set(`${this.prefix}${tokenHash}`, JSON.stringify(record), {
      EX: ttlSeconds,
      NX: true,
    });
    if (result !== "OK") throw new Error("Session token collision");
    return { token, ...record };
  }

  async authenticate(token) {
    if (typeof token !== "string" || token.length < 32) return undefined;
    const value = await this.client.get(`${this.prefix}${keyHash(token)}`);
    return value ? JSON.parse(value) : undefined;
  }

  async revoke(token) {
    if (typeof token !== "string" || token.length < 32) return false;
    return (await this.client.del(`${this.prefix}${keyHash(token)}`)) === 1;
  }
}
