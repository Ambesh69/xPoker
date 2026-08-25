import { createServer } from "node:http";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import { loadConfig } from "./config.js";
import { evaluateReleaseGates } from "./release-gates.js";
import { loadReleaseManifest } from "./release-manifest.js";
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

function sendJson(response, statusCode, body, requestId, extraHeaders = {}) {
  response.writeHead(statusCode, {
    ...SECURITY_HEADERS,
    "content-type": "application/json; charset=utf-8",
    "x-request-id": requestId,
    ...extraHeaders,
  });
  response.end(`${JSON.stringify(body)}\n`);
}

function sendText(response, statusCode, body, requestId, extraHeaders = {}) {
  response.writeHead(statusCode, {
    ...SECURITY_HEADERS,
    "content-type": "text/plain; version=0.0.4; charset=utf-8",
    "x-request-id": requestId,
    ...extraHeaders,
  });
  response.end(body);
}

function metricsAuthorized(request, expectedToken) {
  if (!expectedToken) return false;
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) return false;
  const supplied = createHash("sha256").update(authorization.slice(7)).digest();
  const expected = createHash("sha256").update(expectedToken).digest();
  return timingSafeEqual(supplied, expected);
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
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type, x-request-id",
    "access-control-max-age": "600",
    vary: "Origin",
  };
}

async function authenticatedWallet(auth, request) {
  const token = bearerToken(request);
  if (!token || !auth?.sessionStore) return undefined;
  const session = await auth.sessionStore.authenticate(token);
  if (!session || Date.parse(session.expiresAt) <= Date.now()) return undefined;
  return session.wallet;
}

async function handleCompliance({ request, response, requestId, url, config, auth, compliance }) {
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
  if (url.pathname !== "/v1/compliance/eligibility" || request.method !== "GET") {
    sendJson(response, 404, { error: "not_found", requestId }, requestId, cors);
    return;
  }
  const wallet = await authenticatedWallet(auth, request);
  if (!wallet) {
    sendJson(response, 401, { error: "authentication_required", requestId }, requestId, cors);
    return;
  }
  if (!compliance) {
    sendJson(response, 503, {
      error: "compliance_unavailable",
      message: "Real-value eligibility is not configured",
      eligible: false,
      requestId,
    }, requestId, cors);
    return;
  }
  try {
    const product = url.searchParams.get("product") ?? "real_value_poker";
    const amountUsdMinor = url.searchParams.get("amountUsdMinor") ?? undefined;
    const decision = await compliance.evaluateEligibility({ wallet, product, amountUsdMinor });
    sendJson(response, 200, { decision, requestId }, requestId, cors);
  } catch (error) {
    const expected = Number.isInteger(error?.statusCode);
    sendJson(response, expected ? error.statusCode : 500, {
      error: expected ? error.code ?? "invalid_request" : "internal_error",
      message: expected && error instanceof Error ? error.message : "Compliance evaluation failed",
      eligible: false,
      requestId,
    }, requestId, cors);
  }
}

async function handleSafeBeta({ request, response, requestId, url, config, auth, safeBeta, operations, monitoring }) {
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
  if (!safeBeta) {
    sendJson(response, 503, { error: "safe_beta_unavailable", requestId }, requestId, cors);
    return;
  }
  try {
    if (url.pathname === "/v1/beta/demo-session" && request.method === "POST") {
      const body = await readJson(request, config.bodyLimitBytes);
      const rate = await enforceAuthRateLimit({ auth, request, route: "guest", identity: "safe-beta" });
      if (rate && !rate.allowed) {
        sendJson(response, 429, { error: "rate_limited", requestId }, requestId, {
          ...cors,
          "retry-after": String(Math.max(1, Math.ceil(rate.retryAfterMs / 1_000))),
        });
        return;
      }
      const result = await safeBeta.issueGuest({ name: body.displayName, inviteCode: body.inviteCode });
      sendJson(response, 201, { ...result, fundsMove: false, requestId }, requestId, cors);
      return;
    }
    const wallet = await authenticatedWallet(auth, request);
    if (url.pathname === "/v1/beta/lobby" && request.method === "GET") {
      const result = await safeBeta.lobby({ wallet });
      sendJson(response, 200, { ...result, requestId }, requestId, cors);
      return;
    }
    if (!wallet) {
      sendJson(response, 401, { error: "authentication_required", requestId }, requestId, cors);
      return;
    }
    if (request.method !== "GET") {
      const rate = await enforceAuthRateLimit({ auth, request, route: "beta-write", identity: wallet });
      if (rate && !rate.allowed) {
        sendJson(response, 429, { error: "rate_limited", requestId }, requestId, {
          ...cors,
          "retry-after": String(Math.max(1, Math.ceil(rate.retryAfterMs / 1_000))),
        });
        return;
      }
    }
    if (url.pathname === "/v1/beta/profile" && request.method === "GET") {
      const result = await safeBeta.profile({ wallet });
      sendJson(response, 200, { profile: result, fundsMove: false, requestId }, requestId, cors);
      return;
    }
    if (url.pathname === "/v1/beta/profile" && request.method === "POST") {
      const body = await readJson(request, config.bodyLimitBytes);
      const result = await safeBeta.updateProfile({ wallet, input: body });
      sendJson(response, 200, { profile: result, fundsMove: false, requestId }, requestId, cors);
      return;
    }
    if (url.pathname === "/v1/beta/wallet/holdings" && request.method === "GET") {
      const rate = await enforceAuthRateLimit({ auth, request, route: "holdings", identity: wallet });
      if (rate && !rate.allowed) {
        sendJson(response, 429, { error: "rate_limited", requestId }, requestId, {
          ...cors,
          "retry-after": String(Math.max(1, Math.ceil(rate.retryAfterMs / 1_000))),
        });
        return;
      }
      const result = await safeBeta.walletHoldings({ wallet });
      sendJson(response, 200, { ...result, fundsMove: false, requestId }, requestId, cors);
      return;
    }
    if (url.pathname === "/v1/beta/invitations/redeem" && request.method === "POST") {
      const body = await readJson(request, config.bodyLimitBytes);
      const result = await safeBeta.redeemAccessInvite({ wallet, code: body.code });
      sendJson(response, 200, { ...result, fundsMove: false, requestId }, requestId, cors);
      return;
    }
    if (url.pathname === "/v1/beta/hands" && request.method === "GET") {
      const result = await safeBeta.handHistory({ wallet, limit: url.searchParams.get("limit") ?? 25 });
      sendJson(response, 200, { hands: result, fundsMove: false, requestId }, requestId, cors);
      return;
    }
    if (url.pathname === "/v1/beta/reports" && request.method === "POST") {
      const body = await readJson(request, config.bodyLimitBytes);
      const result = await safeBeta.createReport({ wallet, input: body });
      sendJson(response, 201, { report: result, fundsMove: false, requestId }, requestId, cors);
      return;
    }
    if (url.pathname === "/v1/beta/rooms" && request.method === "POST") {
      const body = await readJson(request, config.bodyLimitBytes);
      const result = await safeBeta.createPrivateRoom({ wallet, input: body });
      sendJson(response, 201, { ...result, fundsMove: false, requestId }, requestId, cors);
      return;
    }
    if (url.pathname === "/v1/beta/rooms/join" && request.method === "POST") {
      const body = await readJson(request, config.bodyLimitBytes);
      const result = await safeBeta.joinPrivateRoom({ wallet, code: body.inviteCode });
      sendJson(response, 200, { ...result, fundsMove: false, requestId }, requestId, cors);
      return;
    }
    if (url.pathname === "/v1/beta/tables/join" && request.method === "POST") {
      const body = await readJson(request, config.bodyLimitBytes);
      const result = await safeBeta.joinTable({
        wallet,
        roomId: body.roomId,
        assetSymbol: body.assetSymbol,
        buyInAtomic: body.buyInAtomic,
      });
      sendJson(response, 200, { ...result, requestId }, requestId, cors);
      return;
    }
    const auditDownloadMatch = /^\/v1\/beta\/hands\/(table:[0-9a-f-]{36}:[1-9][0-9]*)\/audit\/download$/i.exec(url.pathname);
    if (auditDownloadMatch && request.method === "GET") {
      const result = await safeBeta.handAudit({ wallet, handId: auditDownloadMatch[1] });
      sendJson(response, 200, { ...result, requestId }, requestId, {
        ...cors,
        "content-disposition": `attachment; filename="xpoker-${auditDownloadMatch[1].replaceAll(":", "-")}-audit.json"`,
      });
      return;
    }
    const auditMatch = /^\/v1\/beta\/hands\/(table:[0-9a-f-]{36}:[1-9][0-9]*)\/audit$/i.exec(url.pathname);
    if (auditMatch && request.method === "GET") {
      const result = await safeBeta.handAudit({ wallet, handId: auditMatch[1] });
      sendJson(response, 200, { ...result, requestId }, requestId, cors);
      return;
    }
    sendJson(response, 404, { error: "not_found", requestId }, requestId, cors);
  } catch (error) {
    const expected = Number.isInteger(error?.statusCode);
    const statusCode = expected ? error.statusCode : 500;
    if (!expected) {
      const context = {
      level: "error",
      event: "safe_beta_http_failed",
      requestId,
      error: error instanceof Error ? error.message : String(error),
      };
      console.error(JSON.stringify(context));
      const category = /\/audit(?:\/download)?$/.test(url.pathname)
        ? "proof_download_failed"
        : "safe_beta_http_failed";
      const incident = {
        category,
        message: context.error,
        context: { requestId, method: request.method, path: url.pathname },
      };
      if (monitoring) monitoring.capture(incident).catch(() => {});
      else operations?.recordIncident(incident).catch(() => {});
    }
    sendJson(response, statusCode, {
      error: expected ? error?.code ?? "invalid_request" : "internal_error",
      message: expected && error instanceof Error ? error.message : "Safe beta request failed",
      requestId,
    }, requestId, cors);
  }
}

async function handleAdmin({ request, response, requestId, url, config, auth, operations, monitoring }) {
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
  if (!operations) {
    sendJson(response, 503, { error: "operations_unavailable", requestId }, requestId, cors);
    return;
  }
  const wallet = await authenticatedWallet(auth, request);
  if (!wallet) {
    sendJson(response, 401, { error: "authentication_required", requestId }, requestId, cors);
    return;
  }
  try {
    if (request.method !== "GET") {
      const rate = await enforceAuthRateLimit({ auth, request, route: "admin-write", identity: wallet });
      if (rate && !rate.allowed) {
        sendJson(response, 429, { error: "rate_limited", requestId }, requestId, {
          ...cors,
          "retry-after": String(Math.max(1, Math.ceil(rate.retryAfterMs / 1_000))),
        });
        return;
      }
    }
    if (url.pathname === "/v1/admin/overview" && request.method === "GET") {
      sendJson(response, 200, {
        ...(await operations.overview(wallet)),
        monitoring: monitoring?.snapshot() ?? null,
        requestId,
      }, requestId, cors);
      return;
    }
    if (url.pathname === "/v1/admin/invites" && request.method === "GET") {
      sendJson(response, 200, { invites: await operations.listInvites(wallet), requestId }, requestId, cors);
      return;
    }
    if (url.pathname === "/v1/admin/invites" && request.method === "POST") {
      const body = await readJson(request, config.bodyLimitBytes);
      sendJson(response, 201, { ...(await operations.createInvite({ wallet, ...body })), requestId }, requestId, cors);
      return;
    }
    const inviteMatch = /^\/v1\/admin\/invites\/([0-9a-f-]{36})\/revoke$/i.exec(url.pathname);
    if (inviteMatch && request.method === "POST") {
      sendJson(response, 200, { ...(await operations.revokeInvite({ wallet, inviteId: inviteMatch[1] })), requestId }, requestId, cors);
      return;
    }
    if (url.pathname === "/v1/admin/players" && request.method === "GET") {
      sendJson(response, 200, { players: await operations.listPlayers({ wallet, search: url.searchParams.get("search") ?? "" }), requestId }, requestId, cors);
      return;
    }
    const playerMatch = /^\/v1\/admin\/players\/([^/]+)$/i.exec(url.pathname);
    if (playerMatch && request.method === "POST") {
      const body = await readJson(request, config.bodyLimitBytes);
      sendJson(response, 200, { player: await operations.moderatePlayer({ wallet, playerWallet: decodeURIComponent(playerMatch[1]), ...body }), requestId }, requestId, cors);
      return;
    }
    if (url.pathname === "/v1/admin/reports" && request.method === "GET") {
      sendJson(response, 200, { reports: await operations.listReports({ wallet, status: url.searchParams.get("status") }), requestId }, requestId, cors);
      return;
    }
    const reportMatch = /^\/v1\/admin\/reports\/([0-9a-f-]{36})$/i.exec(url.pathname);
    if (reportMatch && request.method === "POST") {
      const body = await readJson(request, config.bodyLimitBytes);
      sendJson(response, 200, { report: await operations.moderateReport({ wallet, reportId: reportMatch[1], ...body }), requestId }, requestId, cors);
      return;
    }
    const incidentMatch = /^\/v1\/admin\/incidents\/([0-9a-f-]{36})\/resolve$/i.exec(url.pathname);
    if (incidentMatch && request.method === "POST") {
      sendJson(response, 200, { incident: await operations.resolveIncident({ wallet, incidentId: incidentMatch[1] }), requestId }, requestId, cors);
      return;
    }
    sendJson(response, 404, { error: "not_found", requestId }, requestId, cors);
  } catch (error) {
    const expected = Number.isInteger(error?.statusCode);
    const statusCode = expected ? error.statusCode : 500;
    if (!expected) {
      const incident = {
        category: "admin_http_failed",
        message: error instanceof Error ? error.message : String(error),
        context: { requestId, method: request.method, path: url.pathname },
      };
      if (monitoring) monitoring.capture(incident).catch(() => {});
      else operations.recordIncident(incident).catch(() => {});
    }
    sendJson(response, statusCode, {
      error: expected ? error.code ?? "invalid_request" : "internal_error",
      message: expected && error instanceof Error ? error.message : "Operations request failed",
      requestId,
    }, requestId, cors);
  }
}

async function handleInvestments({ request, response, requestId, url, config, auth, investments, monitoring }) {
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
  if (!investments) {
    sendJson(response, 503, { error: "investments_unavailable", requestId }, requestId, cors);
    return;
  }
  const wallet = await authenticatedWallet(auth, request);
  if (!wallet) {
    sendJson(response, 401, { error: "authentication_required", requestId }, requestId, cors);
    return;
  }
  try {
    if (request.method !== "GET") {
      const rate = await enforceAuthRateLimit({ auth, request, route: "investments-write", identity: wallet });
      if (rate && !rate.allowed) {
        sendJson(response, 429, { error: "rate_limited", requestId }, requestId, {
          ...cors,
          "retry-after": String(Math.max(1, Math.ceil(rate.retryAfterMs / 1_000))),
        });
        return;
      }
    }
    if (url.pathname === "/v1/investments/status" && request.method === "GET") {
      sendJson(response, 200, { ...(await investments.status(wallet)), requestId }, requestId, cors);
      return;
    }
    if (url.pathname === "/v1/investments/portfolio" && request.method === "GET") {
      sendJson(response, 200, { ...(await investments.portfolio(wallet)), requestId }, requestId, cors);
      return;
    }
    if (url.pathname === "/v1/investments/alpaca/accounts" && request.method === "POST") {
      const body = await readJson(request, config.bodyLimitBytes);
      const forwarded = String(request.headers["x-forwarded-for"] || "").split(",")[0].trim();
      const ipAddress = forwarded || request.socket?.remoteAddress;
      sendJson(response, 202, {
        ...(await investments.openSandboxAccount({ wallet, applicant: body, ipAddress })),
        requestId,
      }, requestId, cors);
      return;
    }
    if (url.pathname === "/v1/investments/alpaca/orders" && request.method === "POST") {
      const body = await readJson(request, config.bodyLimitBytes);
      sendJson(response, 201, {
        ...(await investments.buyFractional({ wallet, symbol: body.symbol, notional: body.notional })),
        requestId,
      }, requestId, cors);
      return;
    }
    if (url.pathname === "/v1/investments/swaps/order" && request.method === "POST") {
      const body = await readJson(request, config.bodyLimitBytes);
      sendJson(response, 200, {
        ...(await investments.swapOrder({
          wallet,
          inputSymbol: body.inputSymbol,
          outputSymbol: body.outputSymbol,
          amountAtomic: body.amountAtomic,
        })),
        requestId,
      }, requestId, cors);
      return;
    }
    if (url.pathname === "/v1/investments/swaps/execute" && request.method === "POST") {
      const body = await readJson(request, config.bodyLimitBytes);
      sendJson(response, 200, {
        ...(await investments.executeSwap({
          wallet,
          signedTransaction: body.signedTransaction,
          requestId: body.swapRequestId,
        })),
        requestId,
      }, requestId, cors);
      return;
    }
    sendJson(response, 404, { error: "not_found", requestId }, requestId, cors);
  } catch (error) {
    const expected = Number.isInteger(error?.statusCode);
    const statusCode = expected ? error.statusCode : 500;
    if (!expected) monitoring?.capture({
      category: "investment_http_failed",
      message: error instanceof Error ? error.message : String(error),
      context: { requestId, method: request.method, path: url.pathname },
    }).catch(() => {});
    sendJson(response, statusCode, {
      error: expected ? error.code ?? "invalid_request" : "internal_error",
      message: expected && error instanceof Error ? error.message : "Investment request failed",
      requestId,
    }, requestId, cors);
  }
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
  if (!auth?.rateLimiter) return undefined;
  const remoteAddress = request.socket?.remoteAddress ?? "unknown";
  return auth.rateLimiter.consume(`${route}:${remoteAddress}:${identity}`, {
    limit: route === "guest" ? 5 : route === "challenge" ? 20 : 30,
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
  if (!auth?.sessionStore) {
    sendJson(response, 503, { error: "authoritative_service_unavailable", requestId }, requestId, cors);
    return;
  }

  const now = auth.clock?.() ?? new Date();
  const domain = new URL(config.publicOrigin).host;
  try {
    if (url.pathname === "/v1/auth/privy") {
      if (!auth.privy) {
        sendJson(response, 503, { error: "privy_unavailable", requestId }, requestId, cors);
        return;
      }
      const accessToken = bearerToken(request);
      if (!accessToken) {
        sendJson(response, 401, { error: "authentication_required", requestId }, requestId, cors);
        return;
      }
      const body = await readJson(request, config.bodyLimitBytes);
      const rate = await enforceAuthRateLimit({ auth, request, route: "privy", identity: "login" });
      if (rate && !rate.allowed) {
        sendJson(response, 429, { error: "rate_limited", requestId }, requestId, {
          ...cors,
          "retry-after": String(Math.max(1, Math.ceil(rate.retryAfterMs / 1_000))),
        });
        return;
      }
      const identity = await auth.privy.authenticate({ accessToken, wallet: body.wallet });
      const session = await auth.sessionStore.issue({ wallet: identity.wallet });
      sendJson(response, 200, {
        token: session.token,
        wallet: session.wallet,
        issuedAt: session.issuedAt,
        expiresAt: session.expiresAt,
        identityProvider: "privy",
        requestId,
      }, requestId, cors);
      return;
    }
    if (url.pathname === "/v1/auth/challenge") {
      if (!auth.challengeStore) {
        sendJson(response, 503, { error: "authoritative_service_unavailable", requestId }, requestId, cors);
        return;
      }
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
      if (!auth.challengeStore) {
        sendJson(response, 503, { error: "authoritative_service_unavailable", requestId }, requestId, cors);
        return;
      }
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
      : ["/v1/auth/verify", "/v1/auth/privy"].includes(url.pathname) ? 401 : 400;
    sendJson(response, statusCode, {
      error: statusCode === 401 ? "authentication_failed" : "invalid_request",
      message: statusCode === 401
        ? url.pathname === "/v1/auth/privy" ? "Privy authentication failed" : "Wallet authentication failed"
        : error instanceof Error ? error.message : "Authentication request failed",
      requestId,
    }, requestId, cors);
    return;
  }
  sendJson(response, 404, { error: "not_found", requestId }, requestId, cors);
}

export function createRequestHandler({ config, gates, auth, safeBeta, compliance, investments, operations, monitoring, healthCheck }) {
  return async (request, response) => {
    const startedAt = performance.now();
    const suppliedRequestId = request.headers["x-request-id"];
    const requestId = typeof suppliedRequestId === "string" ? suppliedRequestId.slice(0, 128) : randomUUID();
    const url = new URL(request.url, "http://internal");
    response.once?.("finish", () => {
      const requestMetric = {
        method: request.method,
        path: url.pathname,
        statusCode: response.statusCode,
        durationMs: performance.now() - startedAt,
      };
      operations?.recordRequest(requestMetric).catch(() => {});
      monitoring?.observeHttpRequest(requestMetric);
    });
    if (url.pathname.startsWith("/v1/auth/") && !url.search) {
      await handleAuth({ request, response, requestId, url, config, auth });
      return;
    }
    if (url.pathname.startsWith("/v1/compliance/")) {
      await handleCompliance({ request, response, requestId, url, config, auth, compliance });
      return;
    }
    if (url.pathname.startsWith("/v1/beta/")) {
      await handleSafeBeta({ request, response, requestId, url, config, auth, safeBeta, operations, monitoring });
      return;
    }
    if (url.pathname.startsWith("/v1/investments/")) {
      await handleInvestments({ request, response, requestId, url, config, auth, investments, monitoring });
      return;
    }
    if (url.pathname.startsWith("/v1/admin/")) {
      await handleAdmin({ request, response, requestId, url, config, auth, operations, monitoring });
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
    if (url.pathname === "/health/ops") {
      const result = monitoring?.publicHealth() ?? {
        status: "disabled",
        checkedAt: null,
        failed: ["monitoring_unavailable"],
        checks: {},
      };
      sendJson(response, result.status === "healthy" ? 200 : 503, { ...result, requestId }, requestId);
      return;
    }
    if (url.pathname === "/metrics") {
      if (!monitoring || !config.metricsBearerToken) {
        sendJson(response, 404, { error: "not_found", requestId }, requestId);
        return;
      }
      if (!metricsAuthorized(request, config.metricsBearerToken)) {
        sendJson(response, 401, { error: "authentication_required", requestId }, requestId, {
          "www-authenticate": 'Bearer realm="xpoker-metrics"',
        });
        return;
      }
      sendText(response, 200, monitoring.prometheus(), requestId);
      return;
    }
    if (url.pathname === "/v1/release/status") {
      sendJson(response, 200, {
        realValueRequested: gates.realValueRequested,
        realValueEnabled: gates.realValueEnabled,
        checks: gates.checks,
        attestations: gates.attestations,
        requestId,
      }, requestId);
      return;
    }
    sendJson(response, 404, { error: "not_found", requestId }, requestId);
  };
}

export async function createApiServer({ config = loadConfig(), manifest, runtimeAttestations, auth, safeBeta, compliance, investments, operations, monitoring, healthCheck } = {}) {
  const releaseManifest = manifest ?? await loadReleaseManifest({
    path: config.releaseManifestPath,
    json: config.releaseManifestJson,
  });
  const gates = evaluateReleaseGates({ config, manifest: releaseManifest, runtimeAttestations });
  const server = createServer(createRequestHandler({ config, gates, auth, safeBeta, compliance, investments, operations, monitoring, healthCheck }));
  server.releaseGates = gates;
  return server;
}

export async function startApiServer({ config = loadConfig(), runtimeFactory = createAuthoritativeRuntime } = {}) {
  const hasDatabase = Boolean(config.databaseUrl);
  const hasRedis = Boolean(config.redisUrl);
  if (hasDatabase !== hasRedis) throw new Error("DATABASE_URL and REDIS_URL must be configured together");
  const runtime = hasDatabase ? await runtimeFactory({ config }) : undefined;
  const server = await createApiServer({
    config,
    auth: runtime?.auth,
    safeBeta: runtime?.safeBeta,
    compliance: runtime?.compliance,
    investments: runtime?.investments,
    operations: runtime?.operations,
    monitoring: runtime?.monitoring,
    healthCheck: runtime?.health,
    runtimeAttestations: {
      dealerSignerKeyId: runtime?.safeBetaDealer?.signerKeyId,
    },
  });
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
