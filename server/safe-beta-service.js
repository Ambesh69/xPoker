import { createHash, randomBytes, randomUUID } from "node:crypto";

import { canonicalJson } from "../fairness/protocol.js";
import { normalizeRules, tableView } from "./table-coordinator.js";
import { encodeBase58 } from "./wallet-auth.js";

const SAFE_BETA_ALLOWLIST_VERSION = "safe-beta-v1";
const INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function fail(message, statusCode = 400, code = "invalid_request") {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  throw error;
}

function digest(value) {
  return createHash("sha256").update(value).digest();
}

function demoMint(symbol) {
  return encodeBase58(digest(`xpoker/safe-beta/demo-asset/${symbol}`));
}

function roomDigest(rules) {
  return digest(canonicalJson(rules));
}

function inviteCode() {
  const bytes = randomBytes(8);
  let output = "";
  for (let index = 0; index < bytes.length; index += 1) {
    output += INVITE_ALPHABET[bytes[index] % INVITE_ALPHABET.length];
    if (index === 3) output += "-";
  }
  return output;
}

function normalizedInvite(value) {
  if (typeof value !== "string") fail("Invite code is required");
  const code = value.trim().toUpperCase();
  if (!/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code)) fail("Invite code is invalid");
  return code;
}

function displayName(value, wallet) {
  const fallback = `Player ${wallet.slice(0, 4)}`;
  const normalized = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : fallback;
  if (normalized.length < 2 || normalized.length > 24) fail("Display name must be 2 to 24 characters");
  if (!/^[\p{L}\p{N} ._'-]+$/u.test(normalized)) fail("Display name contains unsupported characters");
  return normalized;
}

function dollarsToAtomic(value, label, { minimum = 0.01, maximum = 1_000_000 } = {}) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < minimum || amount > maximum) {
    fail(`${label} must be between $${minimum} and $${maximum}`);
  }
  const cents = Math.round(amount * 100);
  if (Math.abs(cents / 100 - amount) > 1e-9) fail(`${label} supports at most two decimal places`);
  return String(cents);
}

function integer(value, label, minimum, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    fail(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return number;
}

export const SAFE_BETA_ASSETS = Object.freeze([
  ["AAPLx", "Apple", 231.42],
  ["NVDAx", "NVIDIA", 182.19],
  ["MSFTx", "Microsoft", 516.73],
  ["AMZNx", "Amazon", 218.64],
  ["GOOGLx", "Alphabet", 201.88],
  ["METAx", "Meta", 742.06],
  ["TSLAx", "Tesla", 338.11],
  ["NFLXx", "Netflix", 1194.7],
  ["SPYx", "S&P 500 ETF", 648.23],
  ["QQQx", "Nasdaq 100 ETF", 576.91],
].map(([symbol, name, indicativePrice]) => Object.freeze({
  symbol,
  name,
  indicativePrice,
  demoMint: demoMint(symbol),
})));

const PUBLIC_ROOM_INPUTS = [
  ["10000000-0000-4000-8000-000000000001", "Opening Bell", "NLH", "Fast six-max no-limit hold'em"],
  ["10000000-0000-4000-8000-000000000002", "Four Cards", "PLO4", "Four-card pot-limit Omaha"],
  ["10000000-0000-4000-8000-000000000003", "Rotation A", "ROE", "One orbit NLH, one orbit PLO 4"],
  ["10000000-0000-4000-8000-000000000004", "Rotation B", "ROE", "Round-of-each with a second public lineup"],
];

export const SAFE_BETA_PUBLIC_ROOMS = Object.freeze(PUBLIC_ROOM_INPUTS.map(([id, name, game, description]) => {
  const tableRules = normalizeRules({
    game,
    seats: 6,
    smallBlindAtomic: "10",
    bigBlindAtomic: "20",
    anteAtomic: "0",
    minimumBuyInAtomic: "2000",
    maximumBuyInAtomic: "10000",
    rakeBps: 500,
    rakeCapAtomic: "300",
    actionClockMs: 20_000,
    timeBankMs: 60_000,
    roeHandsPerGame: 6,
  });
  return Object.freeze({ id, name, description, tableRules });
}));

export function normalizePrivateRoom(input = {}) {
  const name = typeof input.name === "string" ? input.name.trim().replace(/\s+/g, " ") : "";
  if (name.length < 3 || name.length > 32) fail("Room name must be 3 to 32 characters");
  const game = String(input.game ?? "NLH").toUpperCase();
  if (!["NLH", "PLO4", "ROE"].includes(game)) fail("Game must be NLH, PLO4, or ROE");
  const minimumBuyInAtomic = dollarsToAtomic(input.minimumBuyIn ?? 20, "Minimum buy-in", { minimum: 1, maximum: 100_000 });
  const maximumBuyInAtomic = dollarsToAtomic(input.maximumBuyIn ?? 100, "Maximum buy-in", { minimum: 1, maximum: 100_000 });
  if (BigInt(maximumBuyInAtomic) < BigInt(minimumBuyInAtomic)) fail("Maximum buy-in must be at least the minimum buy-in");
  const smallBlindAtomic = dollarsToAtomic(input.smallBlind ?? 0.1, "Small blind", { minimum: 0.01, maximum: 10_000 });
  const bigBlindAtomic = dollarsToAtomic(input.bigBlind ?? 0.2, "Big blind", { minimum: 0.01, maximum: 20_000 });
  const rakePercent = Number(input.rakePercent ?? 5);
  if (!Number.isFinite(rakePercent) || rakePercent < 0 || rakePercent > 10) fail("Rake must be between 0% and 10%");
  const rakeBps = Math.round(rakePercent * 100);
  const rakeCapAtomic = dollarsToAtomic(input.rakeCap ?? 3, "Rake cap", { minimum: 0.01, maximum: 10_000 });
  const tableRules = normalizeRules({
    game,
    seats: integer(input.seats ?? 6, "Seats", 2, 9),
    smallBlindAtomic,
    bigBlindAtomic,
    anteAtomic: dollarsToAtomic(input.ante ?? 0, "Ante", { minimum: 0, maximum: 10_000 }),
    minimumBuyInAtomic,
    maximumBuyInAtomic,
    rakeBps,
    rakeCapAtomic,
    actionClockMs: integer(input.actionClockSeconds ?? 20, "Action clock", 5, 120) * 1_000,
    timeBankMs: integer(input.timeBankSeconds ?? 60, "Time bank", 0, 300) * 1_000,
    roeHandsPerGame: integer(input.roeHandsPerGame ?? 6, "ROE rotation", 1, 20),
  });
  return Object.freeze({ name, description: "Private safe-beta table", tableRules });
}

function roomView(row) {
  const rules = row.rules;
  return {
    id: row.id,
    name: rules.name,
    description: rules.description,
    visibility: row.visibility,
    ownerWallet: row.owner_wallet,
    game: rules.tableRules.game,
    rules: rules.tableRules,
    seatsTaken: Number(row.seats_taken ?? 0),
    tables: Number(row.tables ?? 0),
  };
}

export class SafeBetaService {
  constructor({ pool, sessionStore, tableCoordinator, dealer } = {}) {
    if (!pool?.query || !pool?.connect) throw new Error("Safe beta requires PostgreSQL");
    if (!sessionStore?.issue) throw new Error("Safe beta requires a session store");
    if (!tableCoordinator?.state || !tableCoordinator?.seatPlayer) throw new Error("Safe beta requires a table coordinator");
    this.pool = pool;
    this.sessionStore = sessionStore;
    this.tableCoordinator = tableCoordinator;
    this.dealer = dealer;
  }

  async bootstrap() {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('xpoker-safe-beta-bootstrap'))");
      for (const asset of SAFE_BETA_ASSETS) {
        await client.query(
          `INSERT INTO asset_allowlist (
             mint_address, chain_id, token_program, symbol, decimals,
             multiplier_source, price_source, version, enabled, metadata
           ) VALUES ($1, 'solana:mainnet', 'spl-token-2022', $2, 2,
                     'safe-beta', 'indicative-demo', $3, false, $4)
           ON CONFLICT (mint_address) DO UPDATE
             SET symbol = EXCLUDED.symbol,
                 version = EXCLUDED.version,
                 enabled = false,
                 metadata = EXCLUDED.metadata,
                 updated_at = now()`,
          [asset.demoMint, asset.symbol, SAFE_BETA_ALLOWLIST_VERSION, {
            safeBeta: true,
            nonTransferable: true,
            displayName: asset.name,
            indicativePrice: asset.indicativePrice,
          }],
        );
      }
      for (const room of SAFE_BETA_PUBLIC_ROOMS) {
        const rules = { name: room.name, description: room.description, tableRules: room.tableRules, safeBeta: true };
        await client.query(
          `INSERT INTO rooms (id, owner_wallet, visibility, status, rules, rules_hash)
           VALUES ($1, NULL, 'public', 'open', $2, $3)
           ON CONFLICT (id) DO UPDATE
             SET status = 'open', rules = EXCLUDED.rules, rules_hash = EXCLUDED.rules_hash`,
          [room.id, rules, roomDigest(rules)],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async ensureProfile({ wallet, name, isGuest = false }) {
    const normalized = displayName(name, wallet);
    const result = await this.pool.query(
      `INSERT INTO safe_beta_profiles (wallet_address, display_name, is_guest)
       VALUES ($1, $2, $3)
       ON CONFLICT (wallet_address) DO UPDATE
         SET display_name = CASE
               WHEN safe_beta_profiles.is_guest THEN EXCLUDED.display_name
               ELSE safe_beta_profiles.display_name
             END,
             updated_at = now()
       RETURNING wallet_address, display_name, is_guest, demo_credit_atomic`,
      [wallet, normalized, isGuest],
    );
    const row = result.rows[0];
    return {
      wallet: row.wallet_address,
      displayName: row.display_name,
      isGuest: row.is_guest,
      demoCreditAtomic: String(row.demo_credit_atomic),
    };
  }

  async issueGuest({ name }) {
    const wallet = encodeBase58(randomBytes(32));
    const profile = await this.ensureProfile({ wallet, name, isGuest: true });
    const session = await this.sessionStore.issue({ wallet, ttlSeconds: 12 * 60 * 60 });
    return { ...session, profile };
  }

  async lobby({ wallet } = {}) {
    if (wallet) await this.ensureProfile({ wallet });
    const values = SAFE_BETA_PUBLIC_ROOMS.map((room) => room.id);
    const params = [values];
    let privateFilter = "FALSE";
    if (wallet) {
      params.push(wallet);
      privateFilter = `EXISTS (
        SELECT 1 FROM safe_beta_room_memberships membership
         WHERE membership.room_id = room.id AND membership.wallet_address = $2
      )`;
    }
    const result = await this.pool.query(
      `SELECT room.id, room.owner_wallet, room.visibility, room.rules,
              COUNT(DISTINCT session.id) AS tables,
              COUNT(seat.wallet_address) FILTER (WHERE seat.status <> 'left') AS seats_taken
         FROM rooms room
         LEFT JOIN table_sessions session
           ON session.room_id = room.id AND session.status = 'preview'
         LEFT JOIN table_seats seat ON seat.table_session_id = session.id
        WHERE room.status = 'open'
          AND (room.id = ANY($1::uuid[]) OR ${privateFilter})
        GROUP BY room.id
        ORDER BY room.visibility DESC, room.created_at ASC`,
      params,
    );
    const profile = wallet
      ? (await this.pool.query(
        "SELECT display_name, is_guest, demo_credit_atomic FROM safe_beta_profiles WHERE wallet_address = $1",
        [wallet],
      )).rows[0]
      : undefined;
    return {
      mode: "safe-beta",
      fundsMove: false,
      assets: SAFE_BETA_ASSETS,
      rooms: result.rows.map(roomView),
      profile: profile ? {
        wallet,
        displayName: profile.display_name,
        isGuest: profile.is_guest,
        demoCreditAtomic: String(profile.demo_credit_atomic),
      } : null,
    };
  }

  async createPrivateRoom({ wallet, input }) {
    const normalized = normalizePrivateRoom(input);
    await this.ensureProfile({ wallet });
    const code = inviteCode();
    const rules = { ...normalized, safeBeta: true };
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const created = await client.query(
        `INSERT INTO rooms (owner_wallet, visibility, status, rules, rules_hash)
         VALUES ($1, 'private', 'open', $2, $3)
         RETURNING id, owner_wallet, visibility, rules`,
        [wallet, rules, roomDigest(rules)],
      );
      const row = created.rows[0];
      await client.query(
        "INSERT INTO safe_beta_room_memberships (room_id, wallet_address, role) VALUES ($1, $2, 'owner')",
        [row.id, wallet],
      );
      await client.query(
        "INSERT INTO safe_beta_room_invites (room_id, code_hash) VALUES ($1, $2)",
        [row.id, digest(code)],
      );
      await client.query("COMMIT");
      return { room: roomView(row), inviteCode: code };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async joinPrivateRoom({ wallet, code: rawCode }) {
    const code = normalizedInvite(rawCode);
    await this.ensureProfile({ wallet });
    const result = await this.pool.query(
      `SELECT room.id, room.owner_wallet, room.visibility, room.rules
         FROM safe_beta_room_invites invite
         JOIN rooms room ON room.id = invite.room_id
        WHERE invite.code_hash = $1 AND room.status = 'open' AND room.visibility = 'private'`,
      [digest(code)],
    );
    if (result.rowCount !== 1) fail("Invite code was not found", 404, "invite_not_found");
    const room = result.rows[0];
    await this.pool.query(
      `INSERT INTO safe_beta_room_memberships (room_id, wallet_address, role)
       VALUES ($1, $2, 'member')
       ON CONFLICT (room_id, wallet_address) DO NOTHING`,
      [room.id, wallet],
    );
    return { room: roomView(room) };
  }

  async #authorizedRoom(wallet, roomId) {
    const result = await this.pool.query(
      `SELECT room.id, room.owner_wallet, room.visibility, room.rules
         FROM rooms room
        WHERE room.id = $1 AND room.status = 'open'
          AND (
            room.visibility = 'public'
            OR EXISTS (
              SELECT 1 FROM safe_beta_room_memberships membership
               WHERE membership.room_id = room.id AND membership.wallet_address = $2
            )
          )`,
      [roomId, wallet],
    );
    if (result.rowCount !== 1) fail("Room was not found or is private", 404, "room_not_found");
    return result.rows[0];
  }

  async joinTable({ wallet, roomId, assetSymbol, buyInAtomic }) {
    const room = await this.#authorizedRoom(wallet, roomId);
    const asset = SAFE_BETA_ASSETS.find((candidate) => candidate.symbol === assetSymbol);
    if (!asset) fail("Asset is not in the safe-beta launch set");
    const rules = room.rules.tableRules;
    const buyIn = typeof buyInAtomic === "string" && /^(0|[1-9][0-9]*)$/.test(buyInAtomic)
      ? BigInt(buyInAtomic)
      : -1n;
    if (buyIn < BigInt(rules.minimumBuyInAtomic) || buyIn > BigInt(rules.maximumBuyInAtomic)) {
      fail("Demo buy-in is outside the room limits");
    }
    await this.ensureProfile({ wallet });

    const client = await this.pool.connect();
    let tableId;
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${roomId}:${asset.demoMint}`]);
      const shard = await client.query(
        `INSERT INTO table_sessions (
           room_id, asset_mint, asset_allowlist_version, token_program, status
         ) VALUES ($1, $2, $3, 'spl-token-2022', 'preview')
         ON CONFLICT (room_id, asset_mint) WHERE status = 'preview'
         DO UPDATE SET asset_allowlist_version = EXCLUDED.asset_allowlist_version
         RETURNING id`,
        [roomId, asset.demoMint, SAFE_BETA_ALLOWLIST_VERSION],
      );
      tableId = shard.rows[0].id;
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    let state = await this.tableCoordinator.state(tableId);
    if (state.status === "MISSING") {
      try {
        await this.tableCoordinator.createTable({
          tableId,
          roomId,
          assetMint: asset.demoMint,
          allowlistVersion: SAFE_BETA_ALLOWLIST_VERSION,
          rules,
          idempotencyKey: `safe-beta-create:${tableId}`,
        });
      } catch (error) {
        if (!/duplicate|already|conflict/i.test(error.message)) throw error;
      }
      state = await this.tableCoordinator.state(tableId);
    }

    const existing = state.seats.find((seat) => seat.playerId === wallet);
    if (!existing) {
      let seated = false;
      for (let attempt = 0; attempt < 3 && !seated; attempt += 1) {
        state = await this.tableCoordinator.state(tableId);
        if (state.status !== "WAITING") fail("A hand is in progress; join the next hand", 409, "hand_in_progress");
        const occupied = new Set(state.seats.map((seat) => seat.seat));
        const seat = Array.from({ length: rules.seats }, (_, index) => index).find((index) => !occupied.has(index));
        if (seat === undefined) fail("Table is full", 409, "table_full");
        try {
          await this.tableCoordinator.seatPlayer({
            tableId,
            playerId: wallet,
            seat,
            buyInAtomic: buyIn.toString(),
            expectedVersion: state.version,
            idempotencyKey: `safe-beta-seat:${tableId}:${wallet}`,
          });
          await this.pool.query(
            `INSERT INTO table_seats (
               table_session_id, seat, wallet_address, buy_in_atomic, stack_atomic, status
             ) VALUES ($1, $2, $3, $4, $4, 'seated')
             ON CONFLICT (table_session_id, wallet_address) DO NOTHING`,
            [tableId, seat, wallet, buyIn.toString()],
          );
          seated = true;
        } catch (error) {
          if (attempt === 2 || !/version conflict|occupied/i.test(error.message)) throw error;
        }
      }
    }
    state = await this.tableCoordinator.state(tableId);
    this.dealer?.schedule(tableId);
    return {
      tableId,
      asset,
      room: roomView(room),
      state: tableView(state, { viewerWallet: wallet }),
      fundsMove: false,
    };
  }

  async handAudit({ wallet, handId }) {
    const match = /^table:([0-9a-f-]{36}):[1-9][0-9]*$/i.exec(handId);
    if (!match) fail("Hand id is invalid");
    if (!this.dealer?.audit) fail("Fairness audit service is unavailable", 503, "audit_unavailable");
    const authorized = await this.pool.query(
      `SELECT 1 FROM table_seats
        WHERE table_session_id = $1 AND wallet_address = $2
        LIMIT 1`,
      [match[1], wallet],
    );
    if (authorized.rowCount !== 1) fail("Wallet is not authorized for this hand", 403, "forbidden");
    return this.dealer.audit(handId);
  }
}

export { SAFE_BETA_ALLOWLIST_VERSION };
