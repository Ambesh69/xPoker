import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { WebSocket } from "ws";

import { decryptHoleCards, generateClientHoleCardKeyPair } from "./hole-card-crypto.js";
import { attachRealtimeServer, REALTIME_PROTOCOL } from "./realtime.js";
import {
  AuthoritativeTableCoordinator,
  MemoryTableEventStore,
  nextHandSetup,
} from "./table-coordinator.js";
import { encodeBase58 } from "./wallet-auth.js";

const TABLE_ID = "018f47a6-7b9d-7cc3-8a23-60bfc31e3f45";
const ROOM_ID = "018f47a6-7b9d-7cc3-8a23-60bfc31e3f46";
const ORIGIN = "https://play.xpoker.example";

function wallet() {
  const { publicKey } = generateKeyPairSync("ed25519");
  return encodeBase58(publicKey.export({ type: "spki", format: "der" }).subarray(-32));
}

function inbox(socket) {
  const queued = [];
  const waiting = [];
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString("utf8"));
    const resolve = waiting.shift();
    if (resolve) resolve(message);
    else queued.push(message);
  });
  return {
    next(timeoutMs = 2_000) {
      if (queued.length > 0) return Promise.resolve(queued.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Timed out waiting for realtime message")), timeoutMs);
        waiting.push((message) => {
          clearTimeout(timer);
          resolve(message);
        });
      });
    },
  };
}

async function openSocket(url, origin = ORIGIN) {
  const socket = new WebSocket(url, REALTIME_PROTOCOL, { origin });
  const messages = inbox(socket);
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return { socket, messages };
}

async function closeHttp(server) {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

test("authenticated realtime clients receive reconnect snapshots, ordered events, and wallet-bound commands", async (context) => {
  const playerA = wallet();
  const playerB = wallet();
  const assetMint = wallet();
  const tableStore = new MemoryTableEventStore();
  const coordinator = new AuthoritativeTableCoordinator({
    store: tableStore,
    clock: () => new Date("2026-08-17T12:00:00.000Z"),
  });
  await coordinator.createTable({
    tableId: TABLE_ID,
    roomId: ROOM_ID,
    assetMint,
    allowlistVersion: "launch-v1",
    rules: {
      game: "NLH",
      seats: 2,
      smallBlindAtomic: "10",
      bigBlindAtomic: "20",
      minimumBuyInAtomic: "100",
      maximumBuyInAtomic: "2000",
    },
    idempotencyKey: "realtime-create-table-001",
  });
  await coordinator.seatPlayer({
    tableId: TABLE_ID,
    playerId: playerA,
    seat: 0,
    buyInAtomic: "1000",
    expectedVersion: 1,
    idempotencyKey: "realtime-seat-player-a-1",
  });
  await coordinator.seatPlayer({
    tableId: TABLE_ID,
    playerId: playerB,
    seat: 1,
    buyInAtomic: "1000",
    expectedVersion: 2,
    idempotencyKey: "realtime-seat-player-b-1",
  });

  const http = createServer((_request, response) => {
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address();
  const url = `ws://127.0.0.1:${port}/v1/realtime`;
  const sessions = {
    async authenticate(token) {
      if (token !== "valid-session-token-that-is-long-enough") return undefined;
      return { playerId: playerA, wallet: playerA, expiresAt: "2026-08-17T13:00:00.000Z" };
    },
  };
  const telemetry = [];
  const realtime = attachRealtimeServer({
    server: http,
    sessionStore: sessions,
    tableCoordinator: coordinator,
    allowedOrigins: [ORIGIN],
    clock: () => new Date("2026-08-17T12:00:00.000Z"),
    heartbeatMs: 60_000,
    onTelemetry: (event) => telemetry.push(event),
  });
  context.after(async () => {
    await realtime.close();
    await closeHttp(http);
  });

  const { socket, messages } = await openSocket(url);
  assert.equal((await messages.next()).type, "hello");
  socket.send(JSON.stringify({
    type: "authenticate",
    requestId: "auth-request-001",
    token: "valid-session-token-that-is-long-enough",
  }));
  assert.equal((await messages.next()).type, "authenticated");
  const privateKey = generateClientHoleCardKeyPair();
  socket.send(JSON.stringify({
    type: "key_exchange",
    requestId: "private-key-request-001",
    clientPublicKey: privateKey.publicKey,
  }));
  const keyEstablished = await messages.next();
  assert.equal(keyEstablished.type, "hole_card_key_established");
  assert.equal(typeof keyEstablished.serverPublicKey, "string");
  socket.send(JSON.stringify({
    type: "subscribe",
    requestId: "subscribe-request-001",
    tableId: TABLE_ID,
    afterVersion: 0,
  }));
  const snapshot = await messages.next();
  assert.equal(snapshot.type, "table_snapshot");
  assert.equal(snapshot.state.version, 3);
  assert.equal(snapshot.events.length, 3);

  socket.send(JSON.stringify({
    type: "command",
    requestId: "sit-out-request-001",
    command: "sit_out",
    tableId: TABLE_ID,
    expectedVersion: 3,
    idempotencyKey: "realtime-sit-out-0001",
    playerId: playerB,
  }));
  const responses = [await messages.next(), await messages.next()];
  const command = responses.find((message) => message.type === "command_result");
  const event = responses.find((message) => message.type === "table_event");
  assert.ok(command);
  assert.ok(event);
  assert.equal(command.type, "command_result");
  assert.equal(command.version, 4);
  assert.equal(command.state.seats.find((seat) => seat.playerId === playerA).status, "SITTING_OUT");
  assert.equal(command.state.seats.find((seat) => seat.playerId === playerB).status, "SEATED");
  assert.equal(event.type, "table_event");
  assert.equal(event.event.payload.playerId, playerA);
  socket.close();
  await new Promise((resolve) => socket.once("close", resolve));

  const { socket: reconnect, messages: reconnectMessages } = await openSocket(url);
  await reconnectMessages.next();
  reconnect.send(JSON.stringify({
    type: "authenticate",
    requestId: "auth-request-002",
    token: "valid-session-token-that-is-long-enough",
  }));
  await reconnectMessages.next();
  reconnect.send(JSON.stringify({
    type: "subscribe",
    requestId: "subscribe-request-002",
    tableId: TABLE_ID,
    afterVersion: 3,
  }));
  const resumed = await reconnectMessages.next();
  assert.equal(resumed.state.version, 4);
  assert.equal(resumed.events.length, 1);
  assert.equal(resumed.events[0].type, "PLAYER_SAT_OUT");
  reconnect.close();
  await new Promise((resolve) => reconnect.once("close", resolve));
  for (let attempt = 0; attempt < 20 && telemetry.filter((event) => event.event === "connection_closed").length < 2; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(telemetry.filter((event) => event.event === "connection_opened").length, 2);
  assert.equal(telemetry.filter((event) => event.event === "authenticated").length, 2);
  assert.equal(telemetry.filter((event) => event.event === "subscribed").length, 2);
  assert.equal(telemetry.filter((event) => event.event === "command_applied").length, 1);
  assert.equal(telemetry.filter((event) => event.event === "connection_closed").length, 2);
});

test("realtime transport rejects cross-origin upgrades and invalid sessions", async (context) => {
  const http = createServer();
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address();
  const coordinator = new AuthoritativeTableCoordinator({ store: new MemoryTableEventStore() });
  const realtime = attachRealtimeServer({
    server: http,
    sessionStore: { authenticate: async () => undefined },
    tableCoordinator: coordinator,
    allowedOrigins: [ORIGIN],
    authenticationTimeoutMs: 1_000,
    heartbeatMs: 60_000,
  });
  context.after(async () => {
    await realtime.close();
    await closeHttp(http);
  });

  const forbiddenStatus = await new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/realtime`, REALTIME_PROTOCOL, {
      origin: "https://attacker.example",
    });
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve(response.statusCode);
    });
    socket.once("error", reject);
  });
  assert.equal(forbiddenStatus, 403);

  const { socket, messages } = await openSocket(`ws://127.0.0.1:${port}/v1/realtime`);
  await messages.next();
  socket.send(JSON.stringify({ type: "authenticate", requestId: "bad-auth-request-1", token: "invalid" }));
  const close = await new Promise((resolve) => socket.once("close", (code) => resolve(code)));
  assert.equal(close, 4401);
});

test("private cards are encrypted to the authenticated connection key", async (context) => {
  const playerA = wallet();
  const playerB = wallet();
  const coordinator = new AuthoritativeTableCoordinator({
    store: new MemoryTableEventStore(),
    clock: () => new Date("2026-08-17T12:00:00.000Z"),
  });
  await coordinator.createTable({
    tableId: TABLE_ID,
    roomId: ROOM_ID,
    assetMint: wallet(),
    allowlistVersion: "launch-v1",
    rules: {
      game: "NLH",
      seats: 2,
      smallBlindAtomic: "10",
      bigBlindAtomic: "20",
      minimumBuyInAtomic: "100",
      maximumBuyInAtomic: "2000",
    },
    idempotencyKey: "private-create-table-001",
  });
  for (const [seat, playerId] of [playerA, playerB].entries()) {
    await coordinator.seatPlayer({
      tableId: TABLE_ID,
      playerId,
      seat,
      buyInAtomic: "1000",
      expectedVersion: seat + 1,
      idempotencyKey: `private-seat-player-${seat}-001`,
    });
  }
  const setup = nextHandSetup(await coordinator.state(TABLE_ID));
  const deckRoot = "ab".repeat(32);
  await coordinator.startHand({
    tableId: TABLE_ID,
    handId: setup.handId,
    deckRoot,
    fairnessTranscriptHead: "cd".repeat(32),
    expectedVersion: 3,
    idempotencyKey: "private-start-hand-001",
  });

  const http = createServer();
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address();
  const realtime = attachRealtimeServer({
    server: http,
    sessionStore: {
      authenticate: async () => ({ wallet: playerA, expiresAt: "2026-08-17T13:00:00.000Z" }),
    },
    tableCoordinator: coordinator,
    allowedOrigins: [ORIGIN],
    clock: () => new Date("2026-08-17T12:00:00.000Z"),
    heartbeatMs: 60_000,
    getHoleCards: async ({ handId, wallet: recipient }) => ({
      version: "xpoker-private-deal/v1",
      handId,
      playerId: recipient,
      game: "NLH",
      deckRoot,
      reveals: [
        { position: 0, card: { id: 10 }, nonce: "11".repeat(32), proof: [] },
        { position: 2, card: { id: 20 }, nonce: "22".repeat(32), proof: [] },
      ],
    }),
  });
  context.after(async () => {
    await realtime.close();
    await closeHttp(http);
  });

  const { socket, messages } = await openSocket(`ws://127.0.0.1:${port}/v1/realtime`);
  await messages.next();
  socket.send(JSON.stringify({
    type: "authenticate",
    requestId: "private-auth-request-001",
    token: "valid-session-token-that-is-long-enough",
  }));
  await messages.next();
  const client = generateClientHoleCardKeyPair();
  socket.send(JSON.stringify({
    type: "key_exchange",
    requestId: "private-exchange-request-01",
    clientPublicKey: client.publicKey,
  }));
  const established = await messages.next();
  socket.send(JSON.stringify({
    type: "subscribe",
    requestId: "private-subscribe-request-1",
    tableId: TABLE_ID,
    afterVersion: 0,
  }));
  assert.equal((await messages.next()).type, "table_snapshot");
  const privateMessage = await messages.next();
  assert.equal(privateMessage.type, "hole_cards");
  const privateDeal = decryptHoleCards({
    envelope: privateMessage.envelope,
    clientPrivateKey: client.privateKey,
    serverPublicKey: established.serverPublicKey,
  });
  assert.equal(privateDeal.playerId, playerA);
  assert.deepEqual(privateDeal.reveals.map((reveal) => reveal.card.id), [10, 20]);
  socket.close();
  await new Promise((resolve) => socket.once("close", resolve));
});
