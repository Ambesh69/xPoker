import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

import { loadConfig } from "./config.js";
import { evaluateReleaseGates } from "./release-gates.js";
import { createAuthoritativeRuntime } from "./runtime.js";
import { issueWalletChallenge, verifyWalletChallenge } from "./wallet-auth.js";

const SECURITY_HEADERS = Object.freeze({
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "cross-origin-opener-policy": "same-origin",
  "referrer-policy": "no-referrer",
  "strict-transport-security": "max-age=63072000; includeSubDomains; preload",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
});

async function readManifest(path) {
  if (!path) return undefined;
  return JSON.parse(await readFile(path, "utf8"));
}

function sendJson(response, statusCode, body, requestId, extraHeaders = {}) {
  response.writeHead(statusCode, {
    ...SECURITY_HEADERS,
    "content-type": "application/json; charset=utf-8",
    "x-request-id": requestId,
    ...extraHeaders,
  });
  response.end(`${JSON.stringify(body)}\n`);
}

function authCors(config, request) {
  const origin = request.headers.origin;
  if (typeof origin !== "string") return undefined;
  let normalized;
  try {
    normalized = new URL(origin).origin;
  } catch {
    return undefined;
  }
  if (!config.allowedOrigins.includes(normalized)) return undefined;
  return {
    "access-control-allow-origin": normalized,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type, x-request-id",
    "access-control-max-age": "600",
    vary: "Origin",
  };
}

async function readJson(request, limitBytes) {
  const contentType = String(request.headers["content-type"] ?? "").toLowerCase();
  if (!contentType.startsWith("application/json")) {
    const error = new Error("Request content type must be application/json");
    error.statusCode = 415;
    throw error;
  }
  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > limitBytes) {
    const error = new Error("Request body is too large");
    error.statusCode = 413;
    throw error;
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limitBytes) {
      const error = new Error("Request body is too large");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (length === 0) {
    const error = new Error("Request body is required");
    error.statusCode = 400;
    throw error;
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    const error = new Error("Request body must be a JSON object");
    error.statusCode = 400;
    throw error;
  }
}

function bearerToken(request) {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) return undefined;
  return authorization.slice(7);
}

async function enforceAuthRateLimit({ auth, request, route, identity }) {
  if (!auth.rateLimiter) return undefined;
  const remoteAddress = request.socket?.remoteAddress ?? "unknown";
  return auth.rateLimiter.consume(`${route}:${remoteAddress}:${identity}`, {
    limit: route === "challenge" ? 20 : 30,
    windowMs: 60_000,
  });
}

async function handleAuth({ request, response, requestId, url, config, auth }) {
  const cors = authCors(config, request);
  if (!cors) {
    sendJson(response, 403, { error: "origin_forbidden", requestId }, requestId);
    return;
  }
  if (request.method === "OPTIONS") {
    response.writeHead(204, { ...SECURITY_HEADERS, ...cors, "x-request-id": requestId });
    response.end();
    return;
  }
  if (request.method !== "POST") {
    sendJson(response, 405, { error: "method_not_allowed", requestId }, requestId, cors);
    return;
  }
  if (!auth?.challengeStore || !auth?.sessionStore) {
    sendJson(response, 503, { error: "authoritative_service_unavailable", requestId }, requestId, cors);
    return;
  }

  const now = auth.clock?.() ?? new Date();
  const domain = new URL(config.publicOrigin).host;
  try {
    if (url.pathname === "/v1/auth/challenge") {
      const body = await readJson(request, config.bodyLimitBytes);
      const rate = await enforceAuthRateLimit({ auth, request, route: "challenge", identity: body.wallet });
      if (rate && !rate.allowed) {
        sendJson(response, 429, { error: "rate_limited", requestId }, requestId, {
          ...cors,
          "retry-after": String(Math.max(1, Math.ceil(rate.retryAfterMs / 1_000))),
        });
        return;
      }
      const challenge = await issueWalletChallenge({
        wallet: body.wallet,
        uri: config.publicOrigin,
        domain,
        store: auth.challengeStore,
        now,
      });
      sendJson(response, 201, { ...challenge, requestId }, requestId, cors);
      return;
    }
    if (url.pathname === "/v1/auth/verify") {
      const body = await readJson(request, config.bodyLimitBytes);
      const rate = await enforceAuthRateLimit({ auth, request, route: "verify", identity: body.wallet });
      if (rate && !rate.allowed) {
        sendJson(response, 429, { error: "rate_limited", requestId }, requestId, {
          ...cors,
          "retry-after": String(Math.max(1, Math.ceil(rate.retryAfterMs / 1_000))),
        });
        return;
      }
      const identity = await verifyWalletChallenge({
        id: body.id,
        wallet: body.wallet,
        signature: body.signature,
        uri: config.publicOrigin,
        domain,
        store: auth.challengeStore,
        now,
      });
      const session = await auth.sessionStore.issue({ wallet: identity.wallet });
      sendJson(response, 200, {
        token: session.token,
        wallet: session.wallet,
        issuedAt: session.issuedAt,
        expiresAt: session.expiresAt,
        requestId,
      }, requestId, cors);
      return;
    }
    if (url.pathname === "/v1/auth/logout") {
      const token = bearerToken(request);
      if (!token) {
        sendJson(response, 401, { error: "authentication_required", requestId }, requestId, cors);
        return;
      }
      await auth.sessionStore.revoke(token);
      sendJson(response, 200, { revoked: true, requestId }, requestId, cors);
      return;
    }
  } catch (error) {
    const statusCode = Number.isInteger(error?.statusCode)
      ? error.statusCode
      : url.pathname === "/v1/auth/verify" ? 401 : 400;
    sendJson(response, statusCode, {
      error: statusCode === 401 ? "authentication_failed" : "invalid_request",
      message: statusCode === 401
        ? "Wallet authentication failed"
        : error instanceof Error ? error.message : "Authentication request failed",
      requestId,
    }, requestId, cors);
    return;
  }
  sendJson(response, 404, { error: "not_found", requestId }, requestId, cors);
}

export function createRequestHandler({ config, gates, auth, healthCheck }) {
  return async (request, response) => {
    const suppliedRequestId = request.headers["x-request-id"];
    const requestId = typeof suppliedRequestId === "string" ? suppliedRequestId.slice(0, 128) : randomUUID();
    const url = new URL(request.url, "http://internal");
    if (url.pathname.startsWith("/v1/auth/") && !url.search) {
      await handleAuth({ request, response, requestId, url, config, auth });
      return;
    }
    if (request.method !== "GET") {
      sendJson(response, 405, { error: "method_not_allowed", requestId }, requestId);
      return;
    }
    if (url.pathname === "/health/live") {
      sendJson(response, 200, { status: "live", requestId }, requestId);
      return;
    }
    if (url.pathname === "/health/ready") {
      let dependenciesReady = true;
      if (healthCheck) {
        try {
          dependenciesReady = await healthCheck();
        } catch {
          dependenciesReady = false;
        }
      }
      const ready = (!config.realValueMode || gates.realValueEnabled) && dependenciesReady;
      sendJson(response, ready ? 200 : 503, {
        status: ready ? "ready" : "blocked",
        mode: gates.realValueEnabled ? "real-value" : "safe-preview",
        authoritativeRuntime: healthCheck ? (dependenciesReady ? "ready" : "unavailable") : "disabled",
        failedGates: dependenciesReady ? gates.failed : [...gates.failed, "authoritative_dependencies"],
        requestId,
      }, requestId);
      return;
    }
    if (url.pathname === "/v1/release/status") {
      sendJson(response, 200, {
        realValueRequested: gates.realValueRequested,
        realValueEnabled: gates.realValueEnabled,
        checks: gates.checks,
        requestId,
      }, requestId);
      return;
    }
    sendJson(response, 404, { error: "not_found", requestId }, requestId);
  };
}

export async function createApiServer({ config = loadConfig(), manifest, auth, healthCheck } = {}) {
  const releaseManifest = manifest ?? await readManifest(config.releaseManifestPath);
  const gates = evaluateReleaseGates({ config, manifest: releaseManifest });
  const server = createServer(createRequestHandler({ config, gates, auth, healthCheck }));
  server.releaseGates = gates;
  return server;
}

export async function startApiServer({ config = loadConfig(), runtimeFactory = createAuthoritativeRuntime } = {}) {
  const hasDatabase = Boolean(config.databaseUrl);
  const hasRedis = Boolean(config.redisUrl);
  if (hasDatabase !== hasRedis) throw new Error("DATABASE_URL and REDIS_URL must be configured together");
  const runtime = hasDatabase ? await runtimeFactory({ config }) : undefined;
  const server = await createApiServer({ config, auth: runtime?.auth, healthCheck: runtime?.health });
  try {
    if (runtime) await runtime.attach(server);
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, config.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    await runtime?.close();
    throw error;
  }
  console.log(JSON.stringify({
    level: "info",
    event: "server_listening",
    host: config.host,
    port: config.port,
    authoritativeRuntime: Boolean(runtime),
    realValueEnabled: server.releaseGates.realValueEnabled,
  }));

  let shuttingDown;
  const closeGracefully = (signal = "manual") => {
    if (shuttingDown) return shuttingDown;
    shuttingDown = (async () => {
      await runtime?.close();
      if (server.listening) {
        await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      }
    })().catch((error) => {
      console.error(JSON.stringify({ level: "error", event: "shutdown_failed", signal, error: error.message }));
      process.exitCode = 1;
      throw error;
    });
    return shuttingDown;
  };
  server.authoritativeRuntime = runtime;
  server.closeGracefully = closeGracefully;
  const shutdown = (signal) => { closeGracefully(signal).catch(() => {}); };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) await startApiServer();
