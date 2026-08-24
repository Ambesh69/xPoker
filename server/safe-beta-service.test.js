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
  assert.equal(new Set(SAFE_BETA_ASSETS.map((asset) => asset.mainnetMint)).size, 10);
  assert.ok(SAFE_BETA_ASSETS.every((asset) => decodeBase58(asset.demoMint).length === 32));
  assert.ok(SAFE_BETA_ASSETS.every((asset) => decodeBase58(asset.mainnetMint).length === 32));
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

test("closed-beta guest sessions redeem an access invite before becoming playable", async () => {
  const calls = [];
  const pool = {
    connect() {},
    async query(sql, params) {
      if (!sql.includes("INSERT INTO safe_beta_profiles")) throw new Error(`Unexpected query: ${sql}`);
      return { rows: [{
        wallet_address: params[0],
        display_name: params[1],
        is_guest: true,
        demo_credit_atomic: "100000",
        bio: "",
        avatar_style: "felt",
        status: "active",
        beta_access_granted_at: null,
        last_seen_at: "2026-08-18T00:00:00.000Z",
        created_at: "2026-08-18T00:00:00.000Z",
      }] };
    },
  };
  const service = new SafeBetaService({
    pool,
    sessionStore: { issue: async (input) => { calls.push(["session", input]); return { token: "guest-token", wallet: input.wallet }; } },
    tableCoordinator: { state() {}, seatPlayer() {} },
    operations: { redeemInvite: async (input) => { calls.push(["invite", input]); return { granted: true }; } },
    inviteRequired: true,
  });
  const result = await service.issueGuest({ name: "Invited Guest", inviteCode: "BETA-ABCDE-FGHJK" });
  assert.equal(result.profile.betaAccessGrantedAt !== null, true);
  assert.deepEqual(calls.map(([name]) => name), ["invite", "session"]);
  assert.equal(calls[0][1].code, "BETA-ABCDE-FGHJK");
});

test("hand history filters participant events before resolving hand results", async () => {
  let captured;
  const pool = {
    connect() {},
    async query(sql, params) {
      captured = { sql, params };
      return { rows: [{
        id: "table:00000000-0000-4000-8000-000000000001:7",
        status: "complete",
        started_at: "2026-08-24T18:00:00.000Z",
        completed_at: "2026-08-24T18:01:00.000Z",
        deck_root: Buffer.from("ab".repeat(32), "hex"),
        beacon_round: "1234",
        rules: { name: "Rotation A", tableRules: { game: "ROE" } },
        players: ["wallet-a", "wallet-b"],
        result: { game: "PLO4", rakeAtomic: "2", payouts: [] },
      }] };
    },
  };
  const service = new SafeBetaService({
    pool,
    sessionStore: { issue() {} },
    tableCoordinator: { state() {}, seatPlayer() {} },
  });
  const hands = await service.handHistory({ wallet: "wallet-a", limit: 10 });
  assert.match(captured.sql, /FROM hand_events opened\s+JOIN hands hand ON hand\.id = opened\.hand_id/);
  assert.match(captured.sql, /opened\.event_type = 'HAND_OPENED'/);
  assert.match(captured.sql, /opened\.payload->'players' \? \$1/);
  assert.deepEqual(captured.params, ["wallet-a", 10]);
  assert.equal(hands[0].game, "PLO4");
  assert.equal(hands[0].auditAvailable, true);
});
