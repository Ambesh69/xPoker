import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { WebSocket } from "ws";

import { BetaOperationsService } from "./beta-operations.js";
import { createApiServer } from "./http.js";
import { applyMigrations } from "./migrate.js";
import { PostgresHandEventStore, createPostgresPool } from "./postgres-hand-store.js";
import { PostgresTableEventStore } from "./postgres-table-store.js";
import { attachRealtimeServer, REALTIME_PROTOCOL } from "./realtime.js";
import {
  RedisChallengeStore,
  RedisRateLimiter,
  RedisSessionStore,
  createRedisConnection,
} from "./redis-stores.js";
import {
  SAFE_BETA_PUBLIC_ROOMS,
  SafeBetaService,
} from "./safe-beta-service.js";
import { AuthoritativeTableCoordinator } from "./table-coordinator.js";
import { TranscriptSigner } from "./transcript.js";
import { encodeBase58 } from "./wallet-auth.js";

const connectionString = process.env.DATABASE_URL_TEST;
const redisUrl = process.env.REDIS_URL_TEST;
const ORIGIN = "http://localhost:4173";

function identity() {
  const keypair = generateKeyPairSync("ed25519");
  return {
    keypair,
    wallet: encodeBase58(keypair.publicKey.export({ type: "spki", format: "der" }).subarray(-32)),
  };
}

function inbox(socket) {
  const queued = [];
  const waiting = [];
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString("utf8"));
    const waiter = waiting.shift();
    if (waiter) waiter.resolve(message);
    else queued.push(message);
  });
  return {
    next(timeoutMs = 2_000) {
      if (queued.length) return Promise.resolve(queued.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiting.findIndex((entry) => entry.resolve === resolveMessage);
          if (index >= 0) waiting.splice(index, 1);
          reject(new Error("Timed out waiting for an acceptance-test realtime message"));
        }, timeoutMs);
        function resolveMessage(message) {
          clearTimeout(timer);
          resolve(message);
        }
        waiting.push({ resolve: resolveMessage });
      });
    },
  };
}

async function apiRequest(baseUrl, path, { method = "GET", token, body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      origin: ORIGIN,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  return { response, payload };
}

async function authenticate(baseUrl, account) {
  const challenge = await apiRequest(baseUrl, "/v1/auth/challenge", {
    method: "POST",
    body: { wallet: account.wallet },
  });
  assert.equal(challenge.response.status, 201);
  const signature = sign(
    null,
    Buffer.from(challenge.payload.message, "utf8"),
    account.keypair.privateKey,
  ).toString("base64url");
  const verified = await apiRequest(baseUrl, "/v1/auth/verify", {
    method: "POST",
    body: {
      id: challenge.payload.id,
      wallet: account.wallet,
      signature,
    },
  });
  assert.equal(verified.response.status, 200);
  assert.equal(verified.payload.wallet, account.wallet);
  return verified.payload.token;
}

async function createRoom(baseUrl, token, game, name) {
  const created = await apiRequest(baseUrl, "/v1/beta/rooms", {
    method: "POST",
    token,
    body: {
      name,
      game,
      seats: 6,
      minimumBuyIn: 20,
      maximumBuyIn: 100,
      smallBlind: 0.1,
      bigBlind: 0.2,
      rakePercent: 5,
      rakeCap: 3,
      actionClockSeconds: 20,
      timeBankSeconds: 60,
      roeHandsPerGame: 6,
    },
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.payload.fundsMove, false);
  assert.equal(created.payload.room.game, game);
  return created.payload;
}

async function openSocket(url) {
  const socket = new WebSocket(url, REALTIME_PROTOCOL, { origin: ORIGIN });
  const messages = inbox(socket);
  await Promise.race([
    once(socket, "open"),
    once(socket, "error").then(([error]) => Promise.reject(error)),
  ]);
  return { socket, messages };
}

test("closed beta accepts signed wallets, enforces invitations, and spans gameplay and operations", {
  skip: !connectionString || !redisUrl,
  timeout: 30_000,
}, async (context) => {
  const suffix = `${process.pid}:${Date.now()}:${Math.random().toString(16).slice(2)}:`;
  const admin = identity();
  const playerA = identity();
  const playerB = identity();
  const pool = await createPostgresPool({ connectionString, max: 12 });
  const redis = await createRedisConnection(redisUrl);
  await redis.connect();
  await applyMigrations({ pool });

  const sessionStore = new RedisSessionStore(redis, { prefix: `test:acceptance:session:${suffix}` });
  const auth = {
    challengeStore: new RedisChallengeStore(redis, { prefix: `test:acceptance:challenge:${suffix}` }),
    sessionStore,
    rateLimiter: new RedisRateLimiter(redis, { prefix: `test:acceptance:rate:${suffix}` }),
  };
  const operations = new BetaOperationsService({
    pool,
    redis,
    adminWallets: [admin.wallet],
    instanceId: `acceptance-${suffix}`,
    buildCommit: "acceptance-test",
    logger: { error() {} },
  });
  const coordinator = new AuthoritativeTableCoordinator({
    store: new PostgresTableEventStore({ pool, snapshotEvery: 4 }),
  });
  const auditByHand = new Map();
  const dealer = {
    schedule() {},
    async audit(handId) {
      const audit = auditByHand.get(handId);
      if (!audit) throw new Error("Acceptance audit was not prepared");
      return audit;
    },
  };
  const safeBeta = new SafeBetaService({
    pool,
    sessionStore,
    tableCoordinator: coordinator,
    dealer,
    operations,
    inviteRequired: true,
  });
  await operations.bootstrap();
  await operations.start();
  await safeBeta.bootstrap();

  const config = {
    realValueMode: false,
    safeBetaMode: true,
    allowedOrigins: [ORIGIN],
    publicOrigin: ORIGIN,
    bodyLimitBytes: 16_384,
  };
  const server = await createApiServer({
    config,
    auth,
    safeBeta,
    operations,
    healthCheck: async () => {
      const [database, cache] = await Promise.all([pool.query("SELECT 1"), redis.ping()]);
      return database.rowCount === 1 && cache === "PONG";
    },
  });
  const realtime = attachRealtimeServer({
    server,
    sessionStore,
    tableCoordinator: coordinator,
    allowedOrigins: [ORIGIN],
    heartbeatMs: 60_000,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const realtimeUrl = `ws://127.0.0.1:${port}/v1/realtime`;

  context.after(async () => {
    await realtime.close();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await operations.close();
    await redis.quit();
    await pool.end();
  });

  const ready = await apiRequest(baseUrl, "/health/ready");
  assert.equal(ready.response.status, 200);
  assert.equal(ready.payload.mode, "safe-preview");
  assert.equal(ready.payload.authoritativeRuntime, "ready");

  const [adminToken, playerAToken, playerBToken] = await Promise.all([
    authenticate(baseUrl, admin),
    authenticate(baseUrl, playerA),
    authenticate(baseUrl, playerB),
  ]);

  const lobby = await apiRequest(baseUrl, "/v1/beta/lobby", { token: playerAToken });
  assert.equal(lobby.response.status, 200);
  assert.equal(lobby.payload.fundsMove, false);
  assert.equal(lobby.payload.rooms.filter((room) => room.visibility === "public").length, 4);
  assert.deepEqual(
    lobby.payload.rooms.filter((room) => room.visibility === "public").map((room) => room.game).sort(),
    ["NLH", "PLO4", "ROE", "ROE"],
  );

  const blocked = await apiRequest(baseUrl, "/v1/beta/tables/join", {
    method: "POST",
    token: playerAToken,
    body: {
      roomId: SAFE_BETA_PUBLIC_ROOMS[0].id,
      assetSymbol: "AAPLx",
      buyInAtomic: "2000",
    },
  });
  assert.equal(blocked.response.status, 403);
  assert.equal(blocked.payload.error, "invite_required");

  const invitation = await apiRequest(baseUrl, "/v1/admin/invites", {
    method: "POST",
    token: adminToken,
    body: { label: "Acceptance cohort", maxUses: 2, expiresHours: 24 },
  });
  assert.equal(invitation.response.status, 201);
  assert.match(invitation.payload.code, /^BETA-[A-Z2-9]{5}-[A-Z2-9]{5}$/);

  for (const token of [playerAToken, playerBToken]) {
    const redeemed = await apiRequest(baseUrl, "/v1/beta/invitations/redeem", {
      method: "POST",
      token,
      body: { code: invitation.payload.code },
    });
    assert.equal(redeemed.response.status, 200);
    assert.equal(redeemed.payload.granted, true);
    assert.equal(redeemed.payload.fundsMove, false);
  }

  const profile = await apiRequest(baseUrl, "/v1/beta/profile", {
    method: "POST",
    token: playerAToken,
    body: { displayName: "Acceptance Ace", bio: "Testing the closed beta.", avatarStyle: "river" },
  });
  assert.equal(profile.response.status, 200);
  assert.equal(profile.payload.profile.displayName, "Acceptance Ace");
  assert.equal(profile.payload.profile.avatarStyle, "river");

  const nlhRoom = await createRoom(baseUrl, playerAToken, "NLH", `NLH ${suffix.slice(-8)}`);
  const joinedPrivate = await apiRequest(baseUrl, "/v1/beta/rooms/join", {
    method: "POST",
    token: playerBToken,
    body: { inviteCode: nlhRoom.inviteCode },
  });
  assert.equal(joinedPrivate.response.status, 200);
  const firstSeat = await apiRequest(baseUrl, "/v1/beta/tables/join", {
    method: "POST",
    token: playerAToken,
    body: { roomId: nlhRoom.room.id, assetSymbol: "AAPLx", buyInAtomic: "2000" },
  });
  assert.equal(firstSeat.response.status, 200);
  assert.equal(firstSeat.payload.state.rules.game, "NLH");
  assert.equal(firstSeat.payload.fundsMove, false);
  const secondSeat = await apiRequest(baseUrl, "/v1/beta/tables/join", {
    method: "POST",
    token: playerBToken,
    body: { roomId: nlhRoom.room.id, assetSymbol: "AAPLx", buyInAtomic: "2000" },
  });
  assert.equal(secondSeat.response.status, 200);
  assert.equal(secondSeat.payload.tableId, firstSeat.payload.tableId);
  assert.equal(secondSeat.payload.state.seats.length, 2);

  for (const [game, name] of [["PLO4", "PLO Acceptance"], ["ROE", "ROE Acceptance"]]) {
    const room = await createRoom(baseUrl, playerAToken, game, `${name} ${suffix.slice(-5)}`);
    const joined = await apiRequest(baseUrl, "/v1/beta/tables/join", {
      method: "POST",
      token: playerAToken,
      body: { roomId: room.room.id, assetSymbol: "NVDAx", buyInAtomic: "2000" },
    });
    assert.equal(joined.response.status, 200);
    assert.equal(joined.payload.state.rules.game, game);
    assert.equal(joined.payload.fundsMove, false);
  }

  const firstSocket = await openSocket(realtimeUrl);
  assert.equal((await firstSocket.messages.next()).type, "hello");
  firstSocket.socket.send(JSON.stringify({
    type: "authenticate",
    requestId: "acceptance-auth-0001",
    token: playerAToken,
  }));
  assert.equal((await firstSocket.messages.next()).type, "authenticated");
  firstSocket.socket.send(JSON.stringify({
    type: "subscribe",
    requestId: "acceptance-subscribe-0001",
    tableId: firstSeat.payload.tableId,
    afterVersion: 0,
  }));
  const snapshot = await firstSocket.messages.next();
  assert.equal(snapshot.type, "table_snapshot");
  assert.equal(snapshot.state.seats.length, 2);
  const beforeSitOut = snapshot.state.version;
  firstSocket.socket.send(JSON.stringify({
    type: "command",
    requestId: "acceptance-sitout-0001",
    command: "sit_out",
    tableId: firstSeat.payload.tableId,
    expectedVersion: beforeSitOut,
    idempotencyKey: "acceptance-sitout-idempotency-0001",
  }));
  const commandMessages = [await firstSocket.messages.next(), await firstSocket.messages.next()];
  assert.equal(commandMessages.some((message) => message.type === "table_event"), true);
  assert.equal(commandMessages.some((message) => message.type === "command_result" && message.version === beforeSitOut + 1), true);
  const firstClosed = once(firstSocket.socket, "close");
  firstSocket.socket.close();
  await firstClosed;

  const reconnect = await openSocket(realtimeUrl);
  await reconnect.messages.next();
  reconnect.socket.send(JSON.stringify({
    type: "authenticate",
    requestId: "acceptance-auth-0002",
    token: playerAToken,
  }));
  await reconnect.messages.next();
  reconnect.socket.send(JSON.stringify({
    type: "subscribe",
    requestId: "acceptance-subscribe-0002",
    tableId: firstSeat.payload.tableId,
    afterVersion: beforeSitOut,
  }));
  const recovered = await reconnect.messages.next();
  assert.equal(recovered.type, "table_snapshot");
  assert.equal(recovered.events.length, 1);
  assert.equal(recovered.events[0].type, "PLAYER_SAT_OUT");
  const reconnectClosed = once(reconnect.socket, "close");
  reconnect.socket.close();
  await reconnectClosed;

  const handId = `table:${firstSeat.payload.tableId}:1`;
  const signer = new TranscriptSigner(generateKeyPairSync("ed25519").privateKey);
  const opened = signer.append({
    handId,
    type: "HAND_OPENED",
    payload: {
      roomId: nlhRoom.room.id,
      rules: { game: "NLH", seats: 2, buttonSeat: 0, boards: 1 },
      players: [playerA.wallet, playerB.wallet],
      serverCommitment: "ab".repeat(32),
    },
    occurredAt: new Date().toISOString(),
  });
  await new PostgresHandEventStore({ pool }).append({
    handId,
    expectedVersion: 0,
    idempotencyKey: `acceptance-hand-open:${firstSeat.payload.tableId}`,
    requestDigest: createHash("sha256").update(handId).digest("hex"),
    event: opened,
  });
  auditByHand.set(handId, {
    version: "xpoker-safe-beta-audit/v1",
    fundsMove: false,
    transcriptHead: opened.eventHash,
    beaconSignatureVerified: true,
    auditBundle: { publicRecord: { handId } },
  });
  const proof = await apiRequest(baseUrl, `/v1/beta/hands/${handId}/audit/download`, {
    token: playerAToken,
  });
  assert.equal(proof.response.status, 200);
  assert.match(proof.response.headers.get("content-disposition"), /^attachment;/);
  assert.equal(proof.payload.version, "xpoker-safe-beta-audit/v1");
  assert.equal(proof.payload.fundsMove, false);
  assert.equal(proof.payload.transcriptHead, opened.eventHash);

  const history = await apiRequest(baseUrl, "/v1/beta/hands?limit=10", { token: playerAToken });
  assert.equal(history.response.status, 200);
  assert.equal(history.payload.hands.some((hand) => hand.handId === handId), true);
  assert.equal(history.payload.hands.every((hand) => hand.fundsMove === false), true);

  const reported = await apiRequest(baseUrl, "/v1/beta/reports", {
    method: "POST",
    token: playerAToken,
    body: {
      reportedWallet: playerB.wallet,
      category: "stalling",
      details: "Acceptance test report for repeated action-clock delays.",
    },
  });
  assert.equal(reported.response.status, 201);
  assert.equal(reported.payload.fundsMove, false);
  const reports = await apiRequest(baseUrl, "/v1/admin/reports?status=open", { token: adminToken });
  assert.equal(reports.response.status, 200);
  assert.equal(reports.payload.reports.some((report) => report.id === reported.payload.report.id), true);
  const resolved = await apiRequest(baseUrl, `/v1/admin/reports/${reported.payload.report.id}`, {
    method: "POST",
    token: adminToken,
    body: { status: "resolved", note: "Acceptance review completed." },
  });
  assert.equal(resolved.response.status, 200);
  assert.equal(resolved.payload.report.status, "resolved");

  const suspended = await apiRequest(baseUrl, `/v1/admin/players/${playerB.wallet}`, {
    method: "POST",
    token: adminToken,
    body: { status: "suspended", note: "Acceptance moderation check." },
  });
  assert.equal(suspended.response.status, 200);
  assert.equal(suspended.payload.player.status, "suspended");
  const restricted = await apiRequest(baseUrl, "/v1/beta/tables/join", {
    method: "POST",
    token: playerBToken,
    body: { roomId: nlhRoom.room.id, assetSymbol: "NVDAx", buyInAtomic: "2000" },
  });
  assert.equal(restricted.response.status, 403);
  assert.equal(restricted.payload.error, "account_restricted");

  const overview = await apiRequest(baseUrl, "/v1/admin/overview", { token: adminToken });
  assert.equal(overview.response.status, 200);
  assert.equal(overview.payload.instances.some((instance) => instance.instanceId === `acceptance-${suffix}`), true);
  assert.ok(overview.payload.summary.players >= 2);
  assert.ok(overview.payload.summary.requestsToday > 0);
  const players = await apiRequest(baseUrl, "/v1/admin/players", { token: adminToken });
  assert.equal(players.response.status, 200);
  assert.equal(players.payload.players.some((entry) => entry.wallet === playerA.wallet), true);
  assert.equal(players.payload.players.some((entry) => entry.wallet === playerB.wallet), true);
});
