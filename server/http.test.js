import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { Readable } from "node:stream";
import test from "node:test";

import { createRequestHandler } from "./http.js";
import { evaluateReleaseGates } from "./release-gates.js";
import { MemoryChallengeStore, encodeBase58 } from "./wallet-auth.js";

async function request(config, path, { method = "GET", body, headers = {}, auth } = {}) {
  const response = {
    status: undefined,
    headers: undefined,
    payload: "",
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(payload) {
      this.payload = payload;
    },
  };
  const gates = evaluateReleaseGates({ config });
  const handler = createRequestHandler({ config, gates, auth });
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const incoming = Readable.from(payload);
  incoming.method = method;
  incoming.url = path;
  incoming.headers = {
    ...(body === undefined ? {} : { "content-type": "application/json" }),
    ...headers,
  };
  await handler(incoming, response);
  return { response, body: JSON.parse(response.payload) };
}

function config(realValueMode) {
  return {
    realValueMode,
    allowedOrigins: ["https://play.xpoker.example"],
    publicOrigin: "https://play.xpoker.example",
    bodyLimitBytes: 16_384,
  };
}

test("safe preview is live and explicitly identifies itself", async () => {
  const { response, body } = await request(config(false), "/health/ready");
  assert.equal(response.status, 200);
  assert.equal(body.status, "ready");
  assert.equal(body.mode, "safe-preview");
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.equal(response.headers["cache-control"], "no-store");
});

test("requesting real-value mode without signed evidence makes readiness fail", async () => {
  const { response, body } = await request(config(true), "/health/ready");
  assert.equal(response.status, 503);
  assert.equal(body.status, "blocked");
  assert.ok(body.failedGates.includes("release_manifest_signature"));
});

test("readiness fails when authoritative dependencies are unavailable", async () => {
  const response = {
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(payload) { this.payload = payload; },
  };
  const value = config(false);
  const handler = createRequestHandler({
    config: value,
    gates: evaluateReleaseGates({ config: value }),
    healthCheck: async () => { throw new Error("database unavailable"); },
  });
  const incoming = Readable.from([]);
  incoming.method = "GET";
  incoming.url = "/health/ready";
  incoming.headers = {};
  await handler(incoming, response);
  const body = JSON.parse(response.payload);
  assert.equal(response.status, 503);
  assert.equal(body.authoritativeRuntime, "unavailable");
  assert.ok(body.failedGates.includes("authoritative_dependencies"));
});

test("wallet challenge, signed verification, and bearer logout are origin-bound", async () => {
  const keypair = generateKeyPairSync("ed25519");
  const wallet = encodeBase58(keypair.publicKey.export({ type: "spki", format: "der" }).subarray(-32));
  const sessions = new Map();
  const auth = {
    challengeStore: new MemoryChallengeStore(),
    clock: () => new Date("2026-08-17T12:00:00.000Z"),
    sessionStore: {
      async issue({ wallet: sessionWallet }) {
        const session = {
          token: "session-token-with-at-least-thirty-two-bytes",
          wallet: sessionWallet,
          issuedAt: "2026-08-17T12:00:00.000Z",
          expiresAt: "2026-08-17T13:00:00.000Z",
        };
        sessions.set(session.token, session);
        return session;
      },
      async revoke(token) { return sessions.delete(token); },
    },
  };
  const originHeaders = { origin: "https://play.xpoker.example" };
  const challenge = await request(config(false), "/v1/auth/challenge", {
    method: "POST",
    body: { wallet },
    headers: originHeaders,
    auth,
  });
  assert.equal(challenge.response.status, 201);
  const signature = sign(null, Buffer.from(challenge.body.message), keypair.privateKey).toString("base64url");
  const verified = await request(config(false), "/v1/auth/verify", {
    method: "POST",
    body: { id: challenge.body.id, wallet, signature },
    headers: originHeaders,
    auth,
  });
  assert.equal(verified.response.status, 200);
  assert.equal(verified.body.wallet, wallet);
  assert.equal(verified.response.headers["access-control-allow-origin"], originHeaders.origin);
  const replay = await request(config(false), "/v1/auth/verify", {
    method: "POST",
    body: { id: challenge.body.id, wallet, signature },
    headers: originHeaders,
    auth,
  });
  assert.equal(replay.response.status, 401);
  const logout = await request(config(false), "/v1/auth/logout", {
    method: "POST",
    headers: { ...originHeaders, authorization: `Bearer ${verified.body.token}` },
    auth,
  });
  assert.equal(logout.body.revoked, true);
  assert.equal(sessions.size, 0);
});

test("wallet auth rejects untrusted browser origins before reading a request", async () => {
  const result = await request(config(false), "/v1/auth/challenge", {
    method: "POST",
    body: { wallet: "ignored" },
    headers: { origin: "https://attacker.example" },
    auth: { challengeStore: {}, sessionStore: {} },
  });
  assert.equal(result.response.status, 403);
  assert.equal(result.body.error, "origin_forbidden");
});

test("wallet auth returns a bounded retry delay when Redis denies a request", async () => {
  const result = await request(config(false), "/v1/auth/challenge", {
    method: "POST",
    body: { wallet: "ignored" },
    headers: { origin: "https://play.xpoker.example" },
    auth: {
      challengeStore: {},
      sessionStore: {},
      rateLimiter: {
        consume: async () => ({ allowed: false, retryAfterMs: 12_345 }),
      },
    },
  });
  assert.equal(result.response.status, 429);
  assert.equal(result.response.headers["retry-after"], "13");
  assert.equal(result.body.error, "rate_limited");
});
