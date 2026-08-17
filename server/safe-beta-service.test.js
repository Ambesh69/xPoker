import assert from "node:assert/strict";
import test from "node:test";

import {
  SAFE_BETA_ASSETS,
  SAFE_BETA_PUBLIC_ROOMS,
  SafeBetaService,
  normalizePrivateRoom,
} from "./safe-beta-service.js";
import { decodeBase58 } from "./wallet-auth.js";

test("safe beta exposes exactly ten isolated demo assets and four public rooms", () => {
  assert.equal(SAFE_BETA_ASSETS.length, 10);
  assert.equal(new Set(SAFE_BETA_ASSETS.map((asset) => asset.symbol)).size, 10);
  assert.equal(new Set(SAFE_BETA_ASSETS.map((asset) => asset.demoMint)).size, 10);
  assert.ok(SAFE_BETA_ASSETS.every((asset) => decodeBase58(asset.demoMint).length === 32));
  assert.equal(SAFE_BETA_PUBLIC_ROOMS.length, 4);
  assert.deepEqual(SAFE_BETA_PUBLIC_ROOMS.map((room) => room.tableRules.game), ["NLH", "PLO4", "ROE", "ROE"]);
  assert.ok(SAFE_BETA_PUBLIC_ROOMS.every((room) => room.tableRules.minimumBuyInAtomic === "2000"));
});

test("private room input is converted to exact demo-credit atomic units", () => {
  const room = normalizePrivateRoom({
    name: "Sunday Friends",
    game: "PLO4",
    seats: 8,
    smallBlind: 0.25,
    bigBlind: 0.5,
    minimumBuyIn: 20,
    maximumBuyIn: 200,
    rakePercent: 4.5,
    rakeCap: 5,
    actionClockSeconds: 30,
    timeBankSeconds: 90,
  });
  assert.equal(room.tableRules.game, "PLO4");
  assert.equal(room.tableRules.smallBlindAtomic, "25");
  assert.equal(room.tableRules.maximumBuyInAtomic, "20000");
  assert.equal(room.tableRules.rakeBps, 450);
  assert.equal(room.tableRules.actionClockMs, 30_000);
});

test("private room validation rejects inverted buy-in limits", () => {
  assert.throws(
    () => normalizePrivateRoom({ name: "Bad limits", minimumBuyIn: 100, maximumBuyIn: 20 }),
    /maximum buy-in/i,
  );
});

test("lobby seat counts follow authoritative table state after players leave", async () => {
  const room = SAFE_BETA_PUBLIC_ROOMS[0];
  const pool = {
    connect() {},
    async query(sql) {
      if (sql.includes("FROM rooms room")) return { rows: [{
        id: room.id,
        owner_wallet: null,
        visibility: "public",
        rules: { name: room.name, description: room.description, tableRules: room.tableRules },
      }] };
      if (sql.includes("FROM table_sessions")) return { rows: [
        { id: "table-live", room_id: room.id },
        { id: "table-empty", room_id: room.id },
      ] };
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  const tableCoordinator = {
    seatPlayer() {},
    async state(tableId) {
      return { status: "WAITING", seats: tableId === "table-live" ? [{ playerId: "still-seated" }] : [] };
    },
  };
  const service = new SafeBetaService({ pool, sessionStore: { issue() {} }, tableCoordinator });
  const result = await service.lobby();
  assert.equal(result.rooms[0].tables, 2);
  assert.equal(result.rooms[0].seatsTaken, 1);
});
