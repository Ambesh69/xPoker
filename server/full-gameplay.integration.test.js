import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { once } from "node:events";
import test from "node:test";

import { WebSocket } from "ws";

import { DRAND_QUICKNET } from "./beacon.js";
import { BetaOperationsService } from "./beta-operations.js";
import { AuthoritativeHandCoordinator } from "./hand-coordinator.js";
import {
  decryptHoleCards,
  generateClientHoleCardKeyPair,
} from "./hole-card-crypto.js";
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
import { RedisSafeBetaDealerStore, SafeBetaDealer } from "./safe-beta-dealer.js";
import { SafeBetaService } from "./safe-beta-service.js";
import { AuthoritativeTableCoordinator, tableView } from "./table-coordinator.js";
import { createTimeoutWorker } from "./timeout-worker.js";
import { TranscriptSigner } from "./transcript.js";
import { encodeBase58 } from "./wallet-auth.js";
import { verifyAuditBundle } from "../fairness/protocol.js";

const connectionString = process.env.DATABASE_URL_TEST;
const redisUrl = process.env.REDIS_URL_TEST;
const ORIGIN = "https://certification.xpoker.test";

function identity() {
  const keypair = generateKeyPairSync("ed25519");
  return {
    keypair,
    wallet: encodeBase58(keypair.publicKey.export({ type: "spki", format: "der" }).subarray(-32)),
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
  return { response, payload: await response.json() };
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
    body: { id: challenge.payload.id, wallet: account.wallet, signature },
  });
  assert.equal(verified.response.status, 200);
  return verified.payload.token;
}

class RealtimeClient {
  constructor(socket) {
    this.socket = socket;
    this.messages = [];
    this.waiters = [];
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString("utf8"));
      const index = this.waiters.findIndex((waiter) => waiter.predicate(message));
      if (index === -1) this.messages.push(message);
      else {
        const [waiter] = this.waiters.splice(index, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
    });
  }

  waitFor(predicate, timeoutMs = 5_000) {
    const index = this.messages.findIndex(predicate);
    if (index !== -1) return Promise.resolve(this.messages.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, timer: undefined };
      waiter.timer = setTimeout(() => {
        const waitingIndex = this.waiters.indexOf(waiter);
        if (waitingIndex !== -1) this.waiters.splice(waitingIndex, 1);
        reject(new Error("Timed out waiting for a realtime certification message"));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  send(message) {
    this.socket.send(JSON.stringify(message));
  }

  async close() {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    const closed = once(this.socket, "close");
    this.socket.close();
    await closed;
  }
}

async function connectPlayer(url, token) {
  const socket = new WebSocket(url, REALTIME_PROTOCOL, { origin: ORIGIN });
  const client = new RealtimeClient(socket);
  await Promise.race([
    once(socket, "open"),
    once(socket, "error").then(([error]) => Promise.reject(error)),
  ]);
  await client.waitFor((message) => message.type === "hello");
  client.send({ type: "authenticate", requestId: "auth-cert-0001", token });
  await client.waitFor((message) => message.type === "authenticated");
  const holeCardKeys = generateClientHoleCardKeyPair();
  client.send({
    type: "key_exchange",
    requestId: "keys-cert-0001",
    clientPublicKey: holeCardKeys.publicKey,
  });
  const established = await client.waitFor((message) => message.type === "hole_card_key_established");
  client.holeCardKeys = holeCardKeys;
  client.serverHoleCardKey = established.serverPublicKey;
  return client;
}

async function subscribe(client, tableId, afterVersion = 0, requestId = "sub-cert-0001") {
  client.send({ type: "subscribe", requestId, tableId, afterVersion });
  return client.waitFor((message) => message.type === "table_snapshot" && message.requestId === requestId);
}

function roomInput(game, suffix, overrides = {}) {
  return {
    name: `${game} ${suffix}`.slice(0, 32),
    game,
    seats: 2,
    minimumBuyIn: 20,
    maximumBuyIn: 100,
    smallBlind: 0.1,
    bigBlind: 0.2,
    rakePercent: 5,
    rakeCap: 3,
    actionClockSeconds: 5,
    timeBankSeconds: 0,
    roeHandsPerGame: 1,
    ...overrides,
  };
}

test("wallet-authenticated players complete NLH, PLO4, ROE, reconnect, timeout, and proof flows", {
  skip: !connectionString || !redisUrl,
  timeout: 120_000,
}, async (context) => {
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const mutableNow = { value: new Date("2026-08-19T00:00:00.000Z") };
  const clock = () => new Date(mutableNow.value);
  const pool = await createPostgresPool({ connectionString, max: 20 });
  const redis = await createRedisConnection(redisUrl);
  redis.on("error", () => {});
  await redis.connect();
  await applyMigrations({ pool });

  const admin = identity();
  const players = [identity(), identity()];
  const sessionStore = new RedisSessionStore(redis, { prefix: `test:gameplay:session:${suffix}:` });
  const auth = {
    challengeStore: new RedisChallengeStore(redis, { prefix: `test:gameplay:challenge:${suffix}:` }),
    sessionStore,
    rateLimiter: new RedisRateLimiter(redis, { prefix: `test:gameplay:rate:${suffix}:` }),
  };
  const operations = new BetaOperationsService({
    pool,
    redis,
    adminWallets: [admin.wallet],
    instanceId: `gameplay-${suffix}`,
    buildCommit: "full-gameplay-certification",
    logger: { error() {} },
  });
  const tableStore = new PostgresTableEventStore({ pool, snapshotEvery: 5 });
  const tableCoordinator = new AuthoritativeTableCoordinator({ store: tableStore, clock });
  const dealerStore = new RedisSafeBetaDealerStore(redis, { prefix: `test:gameplay:dealer:${suffix}:` });
  const beacons = new Map();
  let beaconRound = 90_000;
  const reserveBeacon = async () => {
    beaconRound += 1;
    const beacon = {
      source: DRAND_QUICKNET.source,
      chainHash: DRAND_QUICKNET.chainHash,
      round: beaconRound,
      randomness: Buffer.from(`${suffix}:${beaconRound}`).toString("hex").padEnd(64, "0").slice(0, 64),
      signature: `certified-beacon-${beaconRound}`,
      signatureVerified: true,
    };
    beacons.set(beaconRound, beacon);
    return {
      source: beacon.source,
      chainHash: beacon.chainHash,
      round: beacon.round,
      notBefore: new Date(clock().getTime() + 1).toISOString(),
    };
  };
  const fetchBeacon = async ({ reservation }) => {
    const beacon = beacons.get(reservation.round);
    if (!beacon) throw new Error(`Missing deterministic test beacon ${reservation.round}`);
    return structuredClone(beacon);
  };
  const handCoordinator = new AuthoritativeHandCoordinator({
    store: new PostgresHandEventStore({ pool }),
    dealerStore,
    signer: new TranscriptSigner(generateKeyPairSync("ed25519").privateKey),
    beaconVerifier: async ({ beacon, reservation }) => beacon.signature === beacons.get(reservation.round)?.signature,
    clock,
  });
  const dealer = new SafeBetaDealer({
    redis,
    tableCoordinator,
    handCoordinator,
    dealerStore,
    beaconReservation: reserveBeacon,
    beaconFetch: fetchBeacon,
    logger: { error() {} },
    clock,
  });
  const manualDealer = {
    schedule() {},
    audit: (handId) => dealer.audit(handId),
  };
  const safeBeta = new SafeBetaService({
    pool,
    sessionStore,
    tableCoordinator,
    dealer: manualDealer,
    operations,
    inviteRequired: true,
  });
  await operations.bootstrap();
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
    healthCheck: async () => true,
  });
  const realtime = attachRealtimeServer({
    server,
    sessionStore,
    tableCoordinator,
    allowedOrigins: [ORIGIN],
    getHoleCards: dealer.getHoleCards,
    heartbeatMs: 60_000,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const realtimeUrl = `ws://127.0.0.1:${server.address().port}/v1/realtime`;
  const openClients = new Set();

  context.after(async () => {
    for (const client of openClients) await client.close().catch(() => {});
    await realtime.close();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await dealer.close();
    await operations.close();
    if (redis.isOpen) await redis.quit();
    await pool.end();
  });

  const [adminToken, ...playerTokens] = await Promise.all([
    authenticate(baseUrl, admin),
    ...players.map((player) => authenticate(baseUrl, player)),
  ]);
  const invitation = await apiRequest(baseUrl, "/v1/admin/invites", {
    method: "POST",
    token: adminToken,
    body: { label: "Full gameplay certification", maxUses: 2, expiresHours: 24 },
  });
  assert.equal(invitation.response.status, 201);
  for (const token of playerTokens) {
    const redeemed = await apiRequest(baseUrl, "/v1/beta/invitations/redeem", {
      method: "POST",
      token,
      body: { code: invitation.payload.code },
    });
    assert.equal(redeemed.response.status, 200);
    assert.equal(redeemed.payload.granted, true);
  }

  async function createSeatedTable(game, label) {
    const room = await apiRequest(baseUrl, "/v1/beta/rooms", {
      method: "POST",
      token: playerTokens[0],
      body: roomInput(game, label),
    });
    assert.equal(room.response.status, 201);
    const joinedRoom = await apiRequest(baseUrl, "/v1/beta/rooms/join", {
      method: "POST",
      token: playerTokens[1],
      body: { inviteCode: room.payload.inviteCode },
    });
    assert.equal(joinedRoom.response.status, 200);
    const seats = [];
    for (const token of playerTokens) {
      const joined = await apiRequest(baseUrl, "/v1/beta/tables/join", {
        method: "POST",
        token,
        body: { roomId: room.payload.room.id, assetSymbol: "AAPLx", buyInAtomic: "2000" },
      });
      assert.equal(joined.response.status, 200);
      assert.equal(joined.payload.fundsMove, false);
      seats.push(joined.payload);
    }
    assert.equal(seats[0].tableId, seats[1].tableId);
    return seats[0].tableId;
  }

  async function connectTable(tableId) {
    const clients = new Map();
    for (let index = 0; index < players.length; index += 1) {
      const client = await connectPlayer(realtimeUrl, playerTokens[index]);
      openClients.add(client);
      const snapshot = await subscribe(client, tableId, 0, `sub-cert-${index + 1}`);
      assert.equal(snapshot.state.seats.length, 2);
      clients.set(players[index].wallet, client);
    }
    return clients;
  }

  let commandSequence = 0;
  async function playHand(tableId, clients, expectedGame, { reconnect = false } = {}) {
    await dealer.run(tableId);
    let state = await tableCoordinator.state(tableId);
    assert.equal(state.status, "HAND_ACTIVE");
    assert.equal(state.currentHand.game, expectedGame);
    const handId = state.currentHand.handId;
    const expectedHoleCards = expectedGame === "PLO4" ? 4 : 2;
    for (const player of players) {
      const client = clients.get(player.wallet);
      const privateDeal = await client.waitFor(
        (message) => message.type === "hole_cards" && message.handId === handId,
      );
      const decrypted = decryptHoleCards({
        envelope: privateDeal.envelope,
        clientPrivateKey: client.holeCardKeys.privateKey,
        serverPublicKey: client.serverHoleCardKey,
      });
      assert.equal(decrypted.reveals.length, expectedHoleCards);
      assert.equal(decrypted.handId, handId);
    }

    let reconnected = false;
    while (state.status === "HAND_ACTIVE") {
      if (state.currentHand.betting.status !== "BETTING") {
        await dealer.run(tableId);
        state = await tableCoordinator.state(tableId);
        continue;
      }
      if (reconnect && !reconnected && state.currentHand.betting.version >= 1) {
        const player = players[0];
        const oldClient = clients.get(player.wallet);
        await oldClient.close();
        openClients.delete(oldClient);
        const replacement = await connectPlayer(realtimeUrl, playerTokens[0]);
        openClients.add(replacement);
        const replayFrom = Math.max(0, state.version - 1);
        const resumed = await subscribe(replacement, tableId, replayFrom, "sub-reconnect-01");
        assert.equal(resumed.state.currentHand.handId, handId);
        assert.ok(resumed.events.length >= 1);
        clients.set(player.wallet, replacement);
        reconnected = true;
      }
      const actor = state.currentHand.turn.playerId;
      const actorClient = clients.get(actor);
      assert.ok(actorClient, "The current actor must have an authenticated realtime client");
      const legal = tableView(state, { viewerWallet: actor, now: clock() }).currentHand.legalActions;
      const action = legal.canCheck ? { type: "check" } : { type: "call" };
      commandSequence += 1;
      const requestId = `action-cert-${String(commandSequence).padStart(4, "0")}`;
      actorClient.send({
        type: "command",
        command: "act",
        requestId,
        tableId,
        expectedVersion: state.version,
        expectedBettingVersion: state.currentHand.betting.version,
        idempotencyKey: `${requestId}-${suffix}`,
        action,
      });
      const result = await actorClient.waitFor(
        (message) => message.type === "command_result" && message.requestId === requestId,
      );
      assert.equal(result.duplicate, false);
      assert.equal(result.state.currentHand?.handId ?? handId, handId);
      state = await tableCoordinator.state(tableId);
    }
    assert.equal(state.lastResult.handId, handId);
    assert.equal(state.lastResult.game, expectedGame);
    assert.equal(state.lastResult.boards.length, 1);
    assert.equal(state.lastResult.boards[0].length, 5);
    const proof = await apiRequest(baseUrl, `/v1/beta/hands/${handId}/audit/download`, {
      token: playerTokens[0],
    });
    assert.equal(proof.response.status, 200);
    assert.match(proof.response.headers.get("content-disposition"), /^attachment;/);
    assert.equal(proof.payload.fundsMove, false);
    assert.equal(verifyAuditBundle(proof.payload.auditBundle, { beaconSignatureVerified: true }).ok, true);
    return handId;
  }

  const nlhTable = await createSeatedTable("NLH", `nlh-${suffix}`);
  const nlhClients = await connectTable(nlhTable);
  await playHand(nlhTable, nlhClients, "NLH", { reconnect: true });
  for (const client of nlhClients.values()) {
    await client.close();
    openClients.delete(client);
  }

  const ploTable = await createSeatedTable("PLO4", `plo-${suffix}`);
  const ploClients = await connectTable(ploTable);
  await playHand(ploTable, ploClients, "PLO4");
  for (const client of ploClients.values()) {
    await client.close();
    openClients.delete(client);
  }

  const roeTable = await createSeatedTable("ROE", `roe-${suffix}`);
  const roeClients = await connectTable(roeTable);
  await playHand(roeTable, roeClients, "NLH");
  await playHand(roeTable, roeClients, "PLO4");
  const roeState = await tableCoordinator.state(roeTable);
  assert.equal(roeState.handNumber, 2);
  for (const client of roeClients.values()) {
    await client.close();
    openClients.delete(client);
  }

  const timeoutTable = await createSeatedTable("NLH", `timeout-${suffix}`);
  const timeoutClients = await connectTable(timeoutTable);
  await dealer.run(timeoutTable);
  let timeoutState = await tableCoordinator.state(timeoutTable);
  const timedOutPlayer = timeoutState.currentHand.turn.playerId;
  mutableNow.value = new Date(Date.parse(timeoutState.currentHand.turn.deadlineAt) + 1);
  const worker = createTimeoutWorker({
    store: tableStore,
    coordinator: tableCoordinator,
    ownerId: `timeout-${suffix}`,
    clock,
    intervalMs: 50,
  });
  const timeoutResult = await worker.runOnce();
  assert.equal(timeoutResult.claimed, 1);
  assert.equal(timeoutResult.applied, 1);
  const timeoutEvent = await timeoutClients.get(timedOutPlayer).waitFor(
    (message) => message.type === "table_event" && message.event.type === "ACTION_TIMED_OUT",
  );
  assert.equal(timeoutEvent.event.payload.playerId, timedOutPlayer);
  await dealer.run(timeoutTable);
  timeoutState = await tableCoordinator.state(timeoutTable);
  assert.equal(timeoutState.status, "WAITING");
  assert.equal(timeoutState.lastResult.game, "NLH");
  await worker.stop();
  for (const client of timeoutClients.values()) {
    await client.close();
    openClients.delete(client);
  }

  const history = await apiRequest(baseUrl, "/v1/beta/hands?limit=10", { token: playerTokens[0] });
  assert.equal(history.response.status, 200);
  assert.ok(history.payload.hands.length >= 5);
  assert.equal(history.payload.hands.every((hand) => hand.fundsMove === false), true);
});
