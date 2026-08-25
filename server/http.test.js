import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { Readable } from "node:stream";
import test from "node:test";

import { createRequestHandler } from "./http.js";
import { evaluateReleaseGates } from "./release-gates.js";
import { MemoryChallengeStore, encodeBase58 } from "./wallet-auth.js";

async function request(config, path, { method = "GET", body, headers = {}, auth, safeBeta, compliance, investments, operations, monitoring } = {}) {
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
  const handler = createRequestHandler({ config, gates, auth, safeBeta, compliance, investments, operations, monitoring });
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const incoming = Readable.from(payload);
  incoming.method = method;
  incoming.url = path;
  incoming.headers = {
    ...(body === undefined ? {} : { "content-type": "application/json" }),
    ...headers,
  };
  await handler(incoming, response);
  let parsed;
  try { parsed = JSON.parse(response.payload); } catch { parsed = response.payload; }
  return { response, body: parsed };
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

test("operational health is public and metrics require a constant-time bearer check", async () => {
  const value = { ...config(false), metricsBearerToken: "m".repeat(32) };
  const monitoring = {
    publicHealth: () => ({
      status: "healthy",
      checkedAt: "2026-08-19T00:00:00.000Z",
      failed: [],
      checks: { postgres: "healthy", redis: "healthy" },
    }),
    prometheus: () => "xpoker_uptime_seconds 42\n",
  };
  const health = await request(value, "/health/ops", { monitoring });
  assert.equal(health.response.status, 200);
  assert.equal(health.body.status, "healthy");
  assert.deepEqual(health.body.failed, []);

  const denied = await request(value, "/metrics", { monitoring });
  assert.equal(denied.response.status, 401);
  assert.equal(denied.response.headers["www-authenticate"], 'Bearer realm="xpoker-metrics"');
  const metrics = await request(value, "/metrics", {
    headers: { authorization: `Bearer ${"m".repeat(32)}` },
    monitoring,
  });
  assert.equal(metrics.response.status, 200);
  assert.equal(metrics.response.headers["content-type"], "text/plain; version=0.0.4; charset=utf-8");
  assert.equal(metrics.body, "xpoker_uptime_seconds 42\n");
});

test("compliance eligibility is wallet-bound and fails closed when controls are unavailable", async () => {
  const wallet = encodeBase58(Buffer.alloc(32, 17));
  const auth = {
    sessionStore: {
      async authenticate(token) {
        return token === "session-token" ? {
          wallet,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        } : undefined;
      },
    },
  };
  const headers = {
    origin: "https://play.xpoker.example",
    authorization: "Bearer session-token",
  };
  const unavailable = await request(config(false), "/v1/compliance/eligibility?product=deposit&amountUsdMinor=1000", {
    headers,
    auth,
  });
  assert.equal(unavailable.response.status, 503);
  assert.equal(unavailable.body.eligible, false);

  const compliance = {
    async evaluateEligibility(input) {
      assert.deepEqual(input, { wallet, product: "deposit", amountUsdMinor: "1000" });
      return { eligible: false, reasonCodes: ["identity_missing"] };
    },
  };
  const result = await request(config(false), "/v1/compliance/eligibility?product=deposit&amountUsdMinor=1000", {
    headers,
    auth,
    compliance,
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.decision.eligible, false);
  assert.deepEqual(result.body.decision.reasonCodes, ["identity_missing"]);
  assert.equal(result.response.headers["access-control-allow-origin"], headers.origin);
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

test("Privy login exchanges a verified linked Solana identity for an xPoker session", async () => {
  const wallet = encodeBase58(Buffer.alloc(32, 6));
  const issued = [];
  const auth = {
    privy: {
      async authenticate({ accessToken, wallet: requestedWallet }) {
        assert.equal(accessToken, "privy-access-token-with-at-least-thirty-two-bytes");
        assert.equal(requestedWallet, wallet);
        return { wallet };
      },
    },
    sessionStore: {
      async issue({ wallet: sessionWallet }) {
        issued.push(sessionWallet);
        return {
          token: "xpoker-session-token-with-at-least-thirty-two-bytes",
          wallet: sessionWallet,
          issuedAt: "2026-08-22T00:00:00.000Z",
          expiresAt: "2026-08-22T01:00:00.000Z",
        };
      },
    },
  };
  const result = await request(config(false), "/v1/auth/privy", {
    method: "POST",
    body: { wallet },
    headers: {
      origin: "https://play.xpoker.example",
      authorization: "Bearer privy-access-token-with-at-least-thirty-two-bytes",
    },
    auth,
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.wallet, wallet);
  assert.equal(result.body.identityProvider, "privy");
  assert.deepEqual(issued, [wallet]);
});

test("Privy login fails closed when the provider is not configured", async () => {
  const result = await request(config(false), "/v1/auth/privy", {
    method: "POST",
    body: { wallet: encodeBase58(Buffer.alloc(32, 6)) },
    headers: {
      origin: "https://play.xpoker.example",
      authorization: "Bearer privy-access-token-with-at-least-thirty-two-bytes",
    },
    auth: { sessionStore: {} },
  });
  assert.equal(result.response.status, 503);
  assert.equal(result.body.error, "privy_unavailable");
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

test("safe-beta lobby is origin-bound and never claims funds move", async () => {
  const result = await request(config(false), "/v1/beta/lobby", {
    headers: { origin: "https://play.xpoker.example" },
    safeBeta: {
      lobby: async () => ({ mode: "safe-beta", fundsMove: false, rooms: [], assets: [] }),
    },
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.fundsMove, false);
  assert.equal(result.body.mode, "safe-beta");
});

test("safe-beta guest issuance is rate-limited before creating an identity", async () => {
  let issued = false;
  const result = await request(config(false), "/v1/beta/demo-session", {
    method: "POST",
    body: { displayName: "Fast Guest" },
    headers: { origin: "https://play.xpoker.example" },
    auth: {
      rateLimiter: { consume: async () => ({ allowed: false, retryAfterMs: 4_100 }) },
    },
    safeBeta: {
      issueGuest: async () => { issued = true; },
    },
  });
  assert.equal(result.response.status, 429);
  assert.equal(result.response.headers["retry-after"], "5");
  assert.equal(issued, false);
});

test("authenticated players can update profiles, inspect history, and submit reports", async () => {
  const wallet = encodeBase58(Buffer.alloc(32, 7));
  const calls = [];
  const auth = {
    sessionStore: { authenticate: async () => ({ wallet, expiresAt: "2099-01-01T00:00:00.000Z" }) },
  };
  const safeBeta = {
    updateProfile: async (input) => { calls.push(["profile", input]); return { wallet, displayName: input.input.displayName }; },
    handHistory: async (input) => { calls.push(["history", input]); return [{ handId: "table:00000000-0000-4000-8000-000000000001:1" }]; },
    createReport: async (input) => { calls.push(["report", input]); return { id: "report-id", status: "open" }; },
  };
  const headers = { origin: "https://play.xpoker.example", authorization: "Bearer test-session" };
  const profile = await request(config(false), "/v1/beta/profile", {
    method: "POST",
    body: { displayName: "River Fox", bio: "Plays the long game", avatarStyle: "river" },
    headers,
    auth,
    safeBeta,
  });
  assert.equal(profile.response.status, 200);
  assert.equal(profile.body.profile.displayName, "River Fox");
  assert.equal(profile.body.fundsMove, false);

  const history = await request(config(false), "/v1/beta/hands?limit=12", { headers, auth, safeBeta });
  assert.equal(history.response.status, 200);
  assert.equal(history.body.hands.length, 1);

  const report = await request(config(false), "/v1/beta/reports", {
    method: "POST",
    body: { category: "fairness", details: "Please review the public hand proof." },
    headers,
    auth,
    safeBeta,
  });
  assert.equal(report.response.status, 201);
  assert.equal(report.body.report.status, "open");
  assert.deepEqual(calls.map(([name]) => name), ["profile", "history", "report"]);
});

test("authenticated wallet holdings are read-only and bound to the session wallet", async () => {
  const wallet = encodeBase58(Buffer.alloc(32, 5));
  const calls = [];
  const result = await request(config(false), "/v1/beta/wallet/holdings", {
    headers: { origin: "https://play.xpoker.example", authorization: "Bearer test-session" },
    auth: { sessionStore: { authenticate: async () => ({ wallet, expiresAt: "2099-01-01T00:00:00.000Z" }) } },
    safeBeta: {
      walletHoldings: async (input) => {
        calls.push(input);
        return { mode: "read-only", wallet, permissionsRequested: [], holdings: [] };
      },
    },
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.wallet, wallet);
  assert.equal(result.body.fundsMove, false);
  assert.deepEqual(result.body.permissionsRequested, []);
  assert.deepEqual(calls, [{ wallet }]);
});

test("investment routes bind wallet holdings and swaps to the signed wallet", async () => {
  const wallet = encodeBase58(Buffer.alloc(32, 15));
  const calls = [];
  const investments = {
    status: async (inputWallet) => { calls.push(["status", inputWallet]); return { swaps: { provider: "jupiter" }, walletHoldings: { supported: true } }; },
    swapOrder: async (input) => { calls.push(["swap", input]); return { requestId: "swap_request_123", transaction: "A".repeat(128) }; },
  };
  const headers = { origin: "https://play.xpoker.example", authorization: "Bearer investment-session" };
  const auth = { sessionStore: { authenticate: async () => ({ wallet, expiresAt: "2099-01-01T00:00:00.000Z" }) } };
  const status = await request(config(false), "/v1/investments/status", { headers, auth, investments });
  assert.equal(status.response.status, 200);
  assert.equal(status.body.swaps.provider, "jupiter");
  const order = await request(config(false), "/v1/investments/swaps/order", {
    method: "POST", headers, auth, investments,
    body: { inputSymbol: "SOL", outputSymbol: "AAPLx", amountAtomic: "100000000" },
  });
  assert.equal(order.response.status, 200);
  assert.deepEqual(calls, [
    ["status", wallet],
    ["swap", { wallet, inputSymbol: "SOL", outputSymbol: "AAPLx", amountAtomic: "100000000" }],
  ]);
});

test("operator routes require a session and keep one-time invite codes out of listings", async () => {
  const wallet = encodeBase58(Buffer.alloc(32, 8));
  const operations = {
    overview: async (operatorWallet) => ({ operatorWallet, summary: { players: 4 }, instances: [] }),
    listInvites: async () => [{ id: "invite-id", label: "Founders", maxUses: 10, useCount: 2 }],
  };
  const origin = { origin: "https://play.xpoker.example" };
  const denied = await request(config(false), "/v1/admin/overview", { headers: origin, operations });
  assert.equal(denied.response.status, 401);

  const auth = {
    sessionStore: { authenticate: async () => ({ wallet, expiresAt: "2099-01-01T00:00:00.000Z" }) },
  };
  const overview = await request(config(false), "/v1/admin/overview", {
    headers: { ...origin, authorization: "Bearer operator-session" },
    auth,
    operations,
  });
  assert.equal(overview.response.status, 200);
  assert.equal(overview.body.operatorWallet, wallet);
  assert.equal(overview.body.summary.players, 4);

  const invites = await request(config(false), "/v1/admin/invites", {
    headers: { ...origin, authorization: "Bearer operator-session" },
    auth,
    operations,
  });
  assert.equal(invites.response.status, 200);
  assert.equal(invites.body.invites[0].code, undefined);
});
