import { WebSocketServer, WebSocket } from "ws";

import { createHoleCardCipher } from "./hole-card-crypto.js";
import { tableView } from "./table-coordinator.js";

const PROTOCOL = "xpoker.v1";
const OPEN = WebSocket.OPEN;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function rejectUpgrade(socket, status, reason) {
  const body = `${reason}\n`;
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\n`
    + "Connection: close\r\n"
    + "Content-Type: text/plain; charset=utf-8\r\n"
    + `Content-Length: ${Buffer.byteLength(body)}\r\n`
    + "X-Content-Type-Options: nosniff\r\n"
    + "\r\n"
    + body,
  );
}

function requestId(value) {
  assert(typeof value === "string" && /^[a-z0-9][a-z0-9._:-]{7,127}$/i.test(value), "A valid request id is required");
  return value;
}

function errorCode(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/version conflict|idempotency/i.test(message)) return "conflict";
  if (/current actor|not seated|not sitting out|wallet/i.test(message)) return "forbidden";
  if (/deadline/i.test(message)) return "deadline";
  if (/not found|does not exist|missing/i.test(message)) return "not_found";
  return "invalid_command";
}

function send(socket, body) {
  if (socket.readyState !== OPEN) return false;
  if (socket.bufferedAmount > 1_048_576) {
    socket.close(1013, "client is too slow");
    return false;
  }
  socket.send(JSON.stringify(body));
  return true;
}

export function attachRealtimeServer({
  server,
  sessionStore,
  tableCoordinator,
  allowedOrigins,
  authorizeSubscription = ({ wallet, state }) => state.seats.some((seat) => seat.playerId === wallet),
  getHoleCards,
  path = "/v1/realtime",
  maxPayloadBytes = 65_536,
  authenticationTimeoutMs = 5_000,
  heartbeatMs = 30_000,
  rateWindowMs = 10_000,
  maxMessagesPerWindow = 40,
  subscribeToCoordinator = true,
  onTelemetry = () => {},
  clock = () => new Date(),
} = {}) {
  assert(server?.on, "HTTP server is required");
  assert(sessionStore?.authenticate, "Realtime session store is required");
  assert(tableCoordinator?.state && tableCoordinator?.events, "Table coordinator is required");
  assert(Array.isArray(allowedOrigins) && allowedOrigins.length > 0, "At least one realtime origin is required");
  assert(typeof subscribeToCoordinator === "boolean", "Realtime event source setting is invalid");
  assert(getHoleCards === undefined || typeof getHoleCards === "function", "Private-card provider is invalid");
  assert(typeof onTelemetry === "function", "Realtime telemetry handler is invalid");
  const origins = new Set(allowedOrigins.map((origin) => new URL(origin).origin));
  const clients = new Map();
  const subscriptions = new Map();
  const webSockets = new WebSocketServer({
    noServer: true,
    clientTracking: true,
    maxPayload: maxPayloadBytes,
    perMessageDeflate: false,
    handleProtocols: (protocols) => (protocols.has(PROTOCOL) ? PROTOCOL : false),
  });

  function telemetry(event, context = {}) {
    try { onTelemetry({ event, ...context }); } catch {}
  }

  function unsubscribe(socket) {
    const metadata = clients.get(socket);
    if (!metadata) return;
    for (const tableId of metadata.subscriptions) {
      const group = subscriptions.get(tableId);
      group?.delete(socket);
      if (group?.size === 0) subscriptions.delete(tableId);
    }
    metadata.holeCardCipher?.close();
    clients.delete(socket);
  }

  async function publish(event) {
    const group = subscriptions.get(event.tableId);
    if (!group) return 0;
    let delivered = 0;
    for (const socket of group) {
      if (send(socket, { type: "table_event", tableId: event.tableId, event })) delivered += 1;
    }
    if (event.type === "HAND_STARTED" && getHoleCards) {
      const state = await tableCoordinator.state(event.tableId);
      for (const socket of group) {
        const metadata = clients.get(socket);
        if (!metadata) continue;
        for (const deliveryId of metadata.holeCardDeliveries) {
          if (deliveryId.startsWith(`${event.tableId}:`)) metadata.holeCardDeliveries.delete(deliveryId);
        }
        await deliverHoleCards(socket, metadata, event.tableId, state);
      }
    }
    return delivered;
  }
  const unsubscribeEvents = subscribeToCoordinator ? tableCoordinator.subscribe?.(publish) : undefined;

  async function deliverHoleCards(socket, metadata, tableId, state) {
    if (!getHoleCards || state.status !== "HAND_ACTIVE" || !state.currentHand) return;
    const participating = state.currentHand.betting.players.some((player) => player.playerId === metadata.wallet);
    if (!participating) return;
    const deliveryId = `${tableId}:${state.currentHand.handId}`;
    if (metadata.holeCardDeliveries.has(deliveryId)) return;
    if (!metadata.holeCardCipher) {
      if (!metadata.holeCardNotices.has(deliveryId)) {
        send(socket, {
          type: "hole_card_key_required",
          tableId,
          handId: state.currentHand.handId,
        });
        metadata.holeCardNotices.add(deliveryId);
      }
      return;
    }
    const payload = await getHoleCards({
      tableId,
      handId: state.currentHand.handId,
      wallet: metadata.wallet,
    });
    if (!payload) return;
    assert(payload.handId === state.currentHand.handId, "Private deal belongs to another hand");
    assert(payload.playerId === metadata.wallet, "Private deal belongs to another wallet");
    assert(payload.deckRoot === state.currentHand.deckRoot, "Private deal differs from the committed deck");
    const envelope = metadata.holeCardCipher.encrypt({
      tableId,
      handId: state.currentHand.handId,
      deckRoot: state.currentHand.deckRoot,
      payload,
    });
    if (send(socket, { type: "hole_cards", tableId, handId: state.currentHand.handId, envelope })) {
      metadata.holeCardDeliveries.add(deliveryId);
    }
  }

  async function establishHoleCardKey(socket, metadata, message) {
    assert(!metadata.holeCardCipher, "Private-card key is already established for this connection");
    metadata.holeCardCipher = createHoleCardCipher({
      clientPublicKey: message.clientPublicKey,
      wallet: metadata.wallet,
    });
    send(socket, {
      type: "hole_card_key_established",
      requestId: message.requestId,
      protocol: metadata.holeCardCipher.protocol,
      algorithm: metadata.holeCardCipher.algorithm,
      serverPublicKey: metadata.holeCardCipher.serverPublicKey,
    });
    for (const tableId of metadata.subscriptions) {
      await deliverHoleCards(socket, metadata, tableId, await tableCoordinator.state(tableId));
    }
  }

  async function subscribe(socket, metadata, message) {
    const afterVersion = message.afterVersion ?? 0;
    assert(Number.isSafeInteger(afterVersion) && afterVersion >= 0, "afterVersion must be a non-negative integer");
    const state = await tableCoordinator.state(message.tableId);
    assert(state.status !== "MISSING", "Table was not found");
    assert(await authorizeSubscription({ wallet: metadata.wallet, state }), "Wallet is not authorized for this table");
    metadata.subscriptions.add(message.tableId);
    const group = subscriptions.get(message.tableId) ?? new Set();
    group.add(socket);
    subscriptions.set(message.tableId, group);
    const events = afterVersion < state.version
      ? await tableCoordinator.events(message.tableId, afterVersion)
      : [];
    send(socket, {
      type: "table_snapshot",
      requestId: message.requestId,
      tableId: message.tableId,
      state: tableView(state, { viewerWallet: metadata.wallet, now: clock() }),
      events,
    });
    await deliverHoleCards(socket, metadata, message.tableId, state);
  }

  async function command(socket, metadata, message) {
    assert(typeof message.tableId === "string", "Table id is required");
    const common = {
      tableId: message.tableId,
      playerId: metadata.wallet,
      expectedVersion: message.expectedVersion,
      idempotencyKey: message.idempotencyKey,
    };
    let result;
    switch (message.command) {
      case "act":
        result = await tableCoordinator.act({
          ...common,
          action: message.action,
          expectedBettingVersion: message.expectedBettingVersion,
        });
        break;
      case "sit_out":
        result = await tableCoordinator.sitOut(common);
        break;
      case "return":
        result = await tableCoordinator.returnPlayer(common);
        break;
      case "leave":
        result = await tableCoordinator.leave(common);
        break;
      default:
        throw new Error("Unsupported player command");
    }
    const state = await tableCoordinator.state(message.tableId);
    send(socket, {
      type: "command_result",
      requestId: message.requestId,
      tableId: message.tableId,
      duplicate: result.duplicate,
      version: result.event.sequence,
      state: tableView(state, { viewerWallet: metadata.wallet, now: clock() }),
    });
    if (!result.duplicate && subscribeToCoordinator && !unsubscribeEvents) publish(result.event);
  }

  webSockets.on("connection", (socket) => {
    telemetry("connection_opened");
    const metadata = {
      wallet: null,
      authenticated: false,
      alive: true,
      subscriptions: new Set(),
      holeCardCipher: undefined,
      holeCardDeliveries: new Set(),
      holeCardNotices: new Set(),
      windowStartedAt: clock().getTime(),
      messagesInWindow: 0,
      messageQueue: Promise.resolve(),
    };
    clients.set(socket, metadata);
    const authenticationTimer = setTimeout(() => {
      if (!metadata.authenticated) socket.close(4401, "authentication timeout");
    }, authenticationTimeoutMs);
    authenticationTimer.unref?.();
    send(socket, { type: "hello", protocol: PROTOCOL, authenticationRequired: true });

    socket.on("pong", () => { metadata.alive = true; });
    socket.on("close", (code) => {
      clearTimeout(authenticationTimer);
      telemetry("connection_closed", { code });
      unsubscribe(socket);
    });
    socket.on("error", () => telemetry("socket_error"));
    socket.on("message", (data, isBinary) => {
      metadata.messageQueue = metadata.messageQueue.then(async () => {
        let message;
        try {
          assert(!isBinary, "Binary messages are not supported");
          message = JSON.parse(data.toString("utf8"));
          assert(message && typeof message === "object" && !Array.isArray(message), "Realtime message must be an object");
          const id = requestId(message.requestId);

          const now = clock().getTime();
          if (now - metadata.windowStartedAt >= rateWindowMs) {
            metadata.windowStartedAt = now;
            metadata.messagesInWindow = 0;
          }
          metadata.messagesInWindow += 1;
          if (metadata.messagesInWindow > maxMessagesPerWindow) {
            socket.close(4429, "rate limit exceeded");
            return;
          }

          if (!metadata.authenticated) {
            assert(message.type === "authenticate", "Authenticate before sending commands");
            const session = await sessionStore.authenticate(message.token);
            if (!session || Date.parse(session.expiresAt) <= now) {
              telemetry("authentication_failed");
              socket.close(4401, "authentication failed");
              return;
            }
            metadata.wallet = session.wallet;
            metadata.authenticated = true;
            clearTimeout(authenticationTimer);
            telemetry("authenticated");
            send(socket, { type: "authenticated", requestId: id, wallet: session.wallet, expiresAt: session.expiresAt });
            return;
          }

          if (message.type === "subscribe") {
            await subscribe(socket, metadata, message);
            telemetry("subscribed");
          }
          else if (message.type === "key_exchange") await establishHoleCardKey(socket, metadata, message);
          else if (message.type === "command") {
            await command(socket, metadata, message);
            telemetry("command_applied");
          }
          else throw new Error("Unsupported realtime message type");
        } catch (error) {
          telemetry("command_failed");
          send(socket, {
            type: "error",
            requestId: typeof message?.requestId === "string" ? message.requestId : undefined,
            code: errorCode(error),
            message: error instanceof Error ? error.message : "Realtime command failed",
          });
        }
      });
    });
  });

  function upgrade(request, socket, head) {
    try {
      const url = new URL(request.url, "http://internal");
      if (url.pathname !== path || url.search) {
        rejectUpgrade(socket, 404, "Not Found");
        return;
      }
      const origin = request.headers.origin;
      if (!origin || !origins.has(new URL(origin).origin)) {
        rejectUpgrade(socket, 403, "Forbidden");
        return;
      }
      const protocols = String(request.headers["sec-websocket-protocol"] ?? "")
        .split(",")
        .map((value) => value.trim());
      if (!protocols.includes(PROTOCOL)) {
        rejectUpgrade(socket, 426, "Upgrade Required");
        return;
      }
      webSockets.handleUpgrade(request, socket, head, (client) => webSockets.emit("connection", client, request));
    } catch {
      rejectUpgrade(socket, 400, "Bad Request");
    }
  }
  server.on("upgrade", upgrade);

  const heartbeat = setInterval(() => {
    for (const socket of webSockets.clients) {
      const metadata = clients.get(socket);
      if (!metadata?.alive) {
        telemetry("heartbeat_terminated");
        socket.terminate();
        continue;
      }
      metadata.alive = false;
      socket.ping();
    }
  }, heartbeatMs);
  heartbeat.unref?.();

  async function close() {
    clearInterval(heartbeat);
    unsubscribeEvents?.();
    server.off("upgrade", upgrade);
    for (const socket of webSockets.clients) socket.close(1001, "server shutdown");
    await new Promise((resolve) => webSockets.close(resolve));
  }

  return Object.freeze({ webSockets, publish, close, protocol: PROTOCOL });
}

export { PROTOCOL as REALTIME_PROTOCOL };
