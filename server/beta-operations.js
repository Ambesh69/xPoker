import { createHash, randomBytes } from "node:crypto";

import { encodeBase58 } from "./wallet-auth.js";

const OPERATOR_ROLES = new Set(["moderator", "admin"]);
const PLAYER_STATUSES = new Set(["active", "suspended", "banned"]);
const REPORT_STATUSES = new Set(["open", "reviewing", "resolved", "dismissed"]);
const INCIDENT_SEVERITIES = new Set(["warning", "error", "critical"]);
const INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const SECRET_KEY = /authorization|cookie|password|secret|seed|signature|token|private.?key/i;
const STATIC_METRIC_ROUTES = new Set([
  "/health/live",
  "/health/ready",
  "/v1/release/status",
  "/v1/auth/challenge",
  "/v1/auth/verify",
  "/v1/auth/logout",
  "/v1/beta/demo-session",
  "/v1/beta/lobby",
  "/v1/beta/profile",
  "/v1/beta/invitations/redeem",
  "/v1/beta/hands",
  "/v1/beta/reports",
  "/v1/beta/rooms",
  "/v1/beta/rooms/join",
  "/v1/beta/tables/join",
  "/v1/admin/overview",
  "/v1/admin/invites",
  "/v1/admin/players",
  "/v1/admin/reports",
]);

function fail(message, statusCode = 400, code = "invalid_request") {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  throw error;
}

function sha256(value) {
  return createHash("sha256").update(value).digest();
}

function accessCode() {
  const bytes = randomBytes(10);
  const groups = ["BETA"];
  for (let group = 0; group < 2; group += 1) {
    let value = "";
    for (let index = group * 5; index < (group + 1) * 5; index += 1) {
      value += INVITE_ALPHABET[bytes[index] % INVITE_ALPHABET.length];
    }
    groups.push(value);
  }
  return groups.join("-");
}

function normalizedCode(value) {
  if (typeof value !== "string") fail("Beta invitation code is required");
  const code = value.trim().toUpperCase();
  if (!/^BETA-[A-Z2-9]{5}-[A-Z2-9]{5}$/.test(code)) fail("Beta invitation code is invalid");
  return code;
}

function integer(value, label, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    fail(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function text(value, label, minimum, maximum) {
  const normalized = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (normalized.length < minimum || normalized.length > maximum) {
    fail(`${label} must be ${minimum} to ${maximum} characters`);
  }
  return normalized;
}

function redact(value, depth = 0) {
  if (depth > 4) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 20).map((entry) => redact(entry, depth + 1));
  if (!value || typeof value !== "object") {
    if (typeof value === "string") return value.slice(0, 500);
    return value;
  }
  return Object.fromEntries(Object.entries(value).slice(0, 40).map(([key, entry]) => [
    key,
    SECRET_KEY.test(key) ? "[redacted]" : redact(entry, depth + 1),
  ]));
}

function metricRoute(value) {
  const route = String(value || "/").slice(0, 512);
  if (STATIC_METRIC_ROUTES.has(route)) return route;
  if (/^\/v1\/beta\/hands\/[^/]+\/audit(?:\/download)?$/.test(route)) return "/v1/beta/hands/:hand/audit";
  if (/^\/v1\/admin\/invites\/[^/]+\/revoke$/.test(route)) return "/v1/admin/invites/:id/revoke";
  if (/^\/v1\/admin\/players\/[^/]+$/.test(route)) return "/v1/admin/players/:wallet";
  if (/^\/v1\/admin\/reports\/[^/]+$/.test(route)) return "/v1/admin/reports/:id";
  if (/^\/v1\/admin\/incidents\/[^/]+\/resolve$/.test(route)) return "/v1/admin/incidents/:id/resolve";
  return route.startsWith("/v1/") ? "/v1/:unmatched" : "/:unmatched";
}

function profileFromRow(row) {
  return {
    wallet: row.wallet_address,
    displayName: row.display_name,
    isGuest: row.is_guest,
    status: row.status,
    avatarStyle: row.avatar_style,
    bio: row.bio,
    betaAccessGrantedAt: row.beta_access_granted_at ? new Date(row.beta_access_granted_at).toISOString() : null,
    lastSeenAt: new Date(row.last_seen_at).toISOString(),
    createdAt: new Date(row.created_at).toISOString(),
    handsPlayed: Number(row.hands_played ?? 0),
    reportsReceived: Number(row.reports_received ?? 0),
  };
}

export class BetaOperationsService {
  constructor({ pool, redis, adminWallets = [], instanceId, buildCommit, logger = console } = {}) {
    if (!pool?.query || !pool?.connect) throw new Error("Beta operations require PostgreSQL");
    if (!redis?.set || !redis?.hGetAll) throw new Error("Beta operations require Redis");
    this.pool = pool;
    this.redis = redis;
    this.adminWallets = [...new Set(adminWallets)];
    this.instanceId = instanceId || `instance-${encodeBase58(randomBytes(8))}`;
    this.buildCommit = buildCommit || "development";
    this.logger = logger;
    this.startedAt = new Date().toISOString();
    this.heartbeatTimer = undefined;
  }

  async bootstrap() {
    for (const wallet of this.adminWallets) {
      await this.pool.query(
        `INSERT INTO safe_beta_operators (wallet_address, role, active, granted_by_wallet)
         VALUES ($1, 'admin', true, $1)
         ON CONFLICT (wallet_address) DO UPDATE
           SET role = 'admin', active = true, revoked_at = NULL`,
        [wallet],
      );
    }
  }

  async operator(wallet) {
    if (!wallet) return null;
    const result = await this.pool.query(
      `SELECT operator.role
         FROM safe_beta_operators operator
         LEFT JOIN safe_beta_profiles profile ON profile.wallet_address = operator.wallet_address
        WHERE operator.wallet_address = $1
          AND operator.active = true
          AND COALESCE(profile.status, 'active') = 'active'`,
      [wallet],
    );
    return result.rows[0]?.role ?? null;
  }

  async requireOperator(wallet, { admin = false } = {}) {
    const role = await this.operator(wallet);
    if (!role || (admin && role !== "admin")) fail("Operator access is required", 403, "forbidden");
    return role;
  }

  async pulse() {
    const key = `xpoker:ops:instance:${this.instanceId}`;
    await Promise.all([
      this.redis.sAdd("xpoker:ops:instances", this.instanceId),
      this.redis.set(key, JSON.stringify({
        instanceId: this.instanceId,
        buildCommit: this.buildCommit,
        startedAt: this.startedAt,
        lastSeenAt: new Date().toISOString(),
      }), { EX: 45 }),
    ]);
  }

  async start() {
    if (this.heartbeatTimer) return;
    await this.pulse();
    this.heartbeatTimer = setInterval(() => {
      this.pulse().catch((error) => this.logger.error(JSON.stringify({
        level: "error",
        event: "operations_heartbeat_failed",
        error: error.message,
      })));
    }, 15_000);
    this.heartbeatTimer.unref?.();
  }

  async close() {
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    await Promise.all([
      this.redis.del(`xpoker:ops:instance:${this.instanceId}`),
      this.redis.sRem("xpoker:ops:instances", this.instanceId),
    ]).catch(() => {});
  }

  async recordRequest({ method, path, statusCode, durationMs }) {
    const day = new Date().toISOString().slice(0, 10);
    const key = `xpoker:ops:requests:${day}`;
    const statusClass = `${Math.floor(Number(statusCode) / 100)}xx`;
    const route = metricRoute(path);
    const multi = this.redis.multi();
    multi.hIncrBy(key, "total", 1);
    multi.hIncrBy(key, statusClass, 1);
    multi.hIncrBy(key, `${String(method || "GET").toUpperCase()} ${route}`, 1);
    multi.hIncrByFloat(key, "durationMs", Math.max(0, Number(durationMs) || 0));
    multi.expire(key, 8 * 24 * 60 * 60);
    await multi.exec();
  }

  async recordIncident({ category, severity = "error", message, context = {} }) {
    const safeCategory = String(category || "runtime_error").trim().replace(/\s+/g, " ").slice(0, 64) || "runtime_error";
    const safeMessage = String(message || "Unknown runtime error").trim().replace(/\s+/g, " ").slice(0, 1000) || "Unknown runtime error";
    if (!INCIDENT_SEVERITIES.has(severity)) severity = "error";
    const fingerprint = sha256(`${safeCategory}:${safeMessage}`);
    await this.pool.query(
      `INSERT INTO operations_incidents (fingerprint, category, severity, message, context)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (fingerprint) DO UPDATE
         SET severity = EXCLUDED.severity,
             message = EXCLUDED.message,
             context = EXCLUDED.context,
             status = 'open',
             occurrences = operations_incidents.occurrences + 1,
             last_seen_at = now(),
             resolved_at = NULL`,
      [fingerprint, safeCategory, severity, safeMessage, redact(context)],
    );
  }

  async #instances() {
    const ids = await this.redis.sMembers("xpoker:ops:instances");
    if (ids.length === 0) return [];
    const records = await this.redis.mGet(ids.map((id) => `xpoker:ops:instance:${id}`));
    const live = [];
    const stale = [];
    for (let index = 0; index < ids.length; index += 1) {
      if (!records[index]) stale.push(ids[index]);
      else {
        try { live.push(JSON.parse(records[index])); } catch { stale.push(ids[index]); }
      }
    }
    if (stale.length) await this.redis.sRem("xpoker:ops:instances", stale);
    return live.sort((left, right) => left.instanceId.localeCompare(right.instanceId));
  }

  async overview(wallet) {
    await this.requireOperator(wallet);
    const [summary, reports, incidents, metrics, instances] = await Promise.all([
      this.pool.query(
        `SELECT
           (SELECT count(*) FROM safe_beta_profiles) AS players,
           (SELECT count(*) FROM safe_beta_profiles WHERE last_seen_at >= now() - interval '24 hours') AS active_players,
           (SELECT count(*) FROM hands WHERE status = 'complete' AND completed_at >= now() - interval '24 hours') AS hands_24h,
           (SELECT count(*) FROM safe_beta_reports WHERE status IN ('open', 'reviewing')) AS open_reports,
           (SELECT count(*) FROM operations_incidents WHERE status = 'open') AS open_incidents,
           (SELECT count(*) FROM game_tables WHERE status = 'hand_active') AS active_tables`,
      ),
      this.pool.query(
        `SELECT id, reporter_wallet, reported_wallet, hand_id, category, details, status, created_at
           FROM safe_beta_reports
          WHERE status IN ('open', 'reviewing')
          ORDER BY created_at ASC
          LIMIT 8`,
      ),
      this.pool.query(
        `SELECT id, category, severity, message, occurrences, status, first_seen_at, last_seen_at
           FROM operations_incidents
          WHERE status = 'open'
          ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'error' THEN 1 ELSE 2 END, last_seen_at DESC
          LIMIT 8`,
      ),
      this.redis.hGetAll(`xpoker:ops:requests:${new Date().toISOString().slice(0, 10)}`),
      this.#instances(),
    ]);
    const row = summary.rows[0];
    const total = Number(metrics.total ?? 0);
    return {
      generatedAt: new Date().toISOString(),
      summary: {
        players: Number(row.players),
        activePlayers: Number(row.active_players),
        hands24h: Number(row.hands_24h),
        openReports: Number(row.open_reports),
        openIncidents: Number(row.open_incidents),
        activeTables: Number(row.active_tables),
        requestsToday: total,
        errorRate: total ? Number(metrics["5xx"] ?? 0) / total : 0,
        averageLatencyMs: total ? Number(metrics.durationMs ?? 0) / total : 0,
      },
      instances,
      reports: reports.rows.map((report) => ({
        id: report.id,
        reporterWallet: report.reporter_wallet,
        reportedWallet: report.reported_wallet,
        handId: report.hand_id,
        category: report.category,
        details: report.details,
        status: report.status,
        createdAt: new Date(report.created_at).toISOString(),
      })),
      incidents: incidents.rows.map((incident) => ({
        id: incident.id,
        category: incident.category,
        severity: incident.severity,
        message: incident.message,
        occurrences: Number(incident.occurrences),
        status: incident.status,
        firstSeenAt: new Date(incident.first_seen_at).toISOString(),
        lastSeenAt: new Date(incident.last_seen_at).toISOString(),
      })),
    };
  }

  async createInvite({ wallet, label, maxUses = 1, expiresHours = 168 }) {
    await this.requireOperator(wallet, { admin: true });
    const normalizedLabel = text(label, "Invite label", 2, 48);
    const uses = integer(maxUses, "Maximum uses", 1, 1000);
    const hours = integer(expiresHours, "Expiry", 1, 24 * 90);
    const code = accessCode();
    const result = await this.pool.query(
      `INSERT INTO safe_beta_access_invites
        (code_hash, label, max_uses, expires_at, created_by_wallet)
       VALUES ($1, $2, $3, now() + ($4 * interval '1 hour'), $5)
       RETURNING id, label, max_uses, use_count, expires_at, created_at`,
      [sha256(code), normalizedLabel, uses, hours, wallet],
    );
    await this.#audit(wallet, "invite.created", "invite", result.rows[0].id, { label: normalizedLabel, maxUses: uses, expiresHours: hours });
    return { invite: this.#inviteView(result.rows[0]), code };
  }

  #inviteView(row) {
    return {
      id: row.id,
      label: row.label,
      maxUses: Number(row.max_uses),
      useCount: Number(row.use_count),
      expiresAt: new Date(row.expires_at).toISOString(),
      revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
      createdAt: new Date(row.created_at).toISOString(),
    };
  }

  async listInvites(wallet) {
    await this.requireOperator(wallet, { admin: true });
    const result = await this.pool.query(
      `SELECT id, label, max_uses, use_count, expires_at, revoked_at, created_at
         FROM safe_beta_access_invites
        ORDER BY created_at DESC
        LIMIT 100`,
    );
    return result.rows.map((row) => this.#inviteView(row));
  }

  async revokeInvite({ wallet, inviteId }) {
    await this.requireOperator(wallet, { admin: true });
    const result = await this.pool.query(
      `UPDATE safe_beta_access_invites SET revoked_at = COALESCE(revoked_at, now())
        WHERE id = $1 RETURNING id`,
      [inviteId],
    );
    if (result.rowCount !== 1) fail("Invitation was not found", 404, "not_found");
    await this.#audit(wallet, "invite.revoked", "invite", inviteId, {});
    return { revoked: true };
  }

  async redeemInvite({ wallet, code: rawCode }) {
    const code = normalizedCode(rawCode);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const invite = await client.query(
        `SELECT id, label, max_uses, use_count, expires_at, revoked_at
           FROM safe_beta_access_invites
          WHERE code_hash = $1
          FOR UPDATE`,
        [sha256(code)],
      );
      const row = invite.rows[0];
      if (!row || row.revoked_at || Date.parse(row.expires_at) <= Date.now() || row.use_count >= row.max_uses) {
        fail("Invitation is invalid, expired, or fully used", 404, "invite_unavailable");
      }
      const redemption = await client.query(
        `INSERT INTO safe_beta_access_redemptions (invite_id, wallet_address)
         VALUES ($1, $2)
         ON CONFLICT (wallet_address) DO NOTHING
         RETURNING invite_id`,
        [row.id, wallet],
      );
      if (redemption.rowCount === 1) {
        await client.query("UPDATE safe_beta_access_invites SET use_count = use_count + 1 WHERE id = $1", [row.id]);
      }
      await client.query(
        "UPDATE safe_beta_profiles SET beta_access_granted_at = COALESCE(beta_access_granted_at, now()), updated_at = now() WHERE wallet_address = $1",
        [wallet],
      );
      await client.query("COMMIT");
      return { granted: true, label: row.label };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listPlayers({ wallet, search = "" }) {
    await this.requireOperator(wallet);
    const query = typeof search === "string" ? search.trim().slice(0, 80) : "";
    const result = await this.pool.query(
      `SELECT profile.*,
              (SELECT count(*) FROM hand_events opened WHERE opened.event_type = 'HAND_OPENED' AND opened.payload->'players' ? profile.wallet_address) AS hands_played,
              (SELECT count(*) FROM safe_beta_reports report WHERE report.reported_wallet = profile.wallet_address) AS reports_received
         FROM safe_beta_profiles profile
        WHERE $1 = '' OR profile.display_name ILIKE ('%' || $1 || '%') OR profile.wallet_address ILIKE ($1 || '%')
        ORDER BY profile.last_seen_at DESC
        LIMIT 100`,
      [query],
    );
    return result.rows.map(profileFromRow);
  }

  async moderatePlayer({ wallet, playerWallet, status, note = "" }) {
    await this.requireOperator(wallet);
    if (!PLAYER_STATUSES.has(status)) fail("Player status is invalid");
    const safeNote = typeof note === "string" ? note.trim().slice(0, 500) : "";
    const result = await this.pool.query(
      `UPDATE safe_beta_profiles SET status = $2, updated_at = now()
        WHERE wallet_address = $1
        RETURNING wallet_address`,
      [playerWallet, status],
    );
    if (result.rowCount !== 1) fail("Player was not found", 404, "not_found");
    await this.#audit(wallet, `player.${status}`, "player", playerWallet, { note: safeNote });
    return { wallet: playerWallet, status };
  }

  async listReports({ wallet, status }) {
    await this.requireOperator(wallet);
    const normalizedStatus = status && REPORT_STATUSES.has(status) ? status : null;
    const result = await this.pool.query(
      `SELECT id, reporter_wallet, reported_wallet, hand_id, category, details, status,
              assigned_to_wallet, resolution_note, created_at, updated_at, resolved_at
         FROM safe_beta_reports
        WHERE $1::text IS NULL OR status = $1
        ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'reviewing' THEN 1 ELSE 2 END, created_at ASC
        LIMIT 200`,
      [normalizedStatus],
    );
    return result.rows.map((row) => ({
      id: row.id,
      reporterWallet: row.reporter_wallet,
      reportedWallet: row.reported_wallet,
      handId: row.hand_id,
      category: row.category,
      details: row.details,
      status: row.status,
      assignedToWallet: row.assigned_to_wallet,
      resolutionNote: row.resolution_note,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
      resolvedAt: row.resolved_at ? new Date(row.resolved_at).toISOString() : null,
    }));
  }

  async moderateReport({ wallet, reportId, status, note = "" }) {
    await this.requireOperator(wallet);
    if (!REPORT_STATUSES.has(status) || status === "open") fail("Report status is invalid");
    const safeNote = typeof note === "string" ? note.trim().slice(0, 1000) : "";
    if (["resolved", "dismissed"].includes(status) && safeNote.length < 3) fail("A resolution note is required");
    const terminal = ["resolved", "dismissed"].includes(status);
    const result = await this.pool.query(
      `UPDATE safe_beta_reports
          SET status = $2,
              assigned_to_wallet = $3,
              resolution_note = CASE WHEN $4 THEN $5 ELSE resolution_note END,
              resolved_at = CASE WHEN $4 THEN now() ELSE NULL END,
              updated_at = now()
        WHERE id = $1
        RETURNING id`,
      [reportId, status, wallet, terminal, safeNote || null],
    );
    if (result.rowCount !== 1) fail("Report was not found", 404, "not_found");
    await this.#audit(wallet, `report.${status}`, "report", reportId, { note: safeNote });
    return { id: reportId, status };
  }

  async resolveIncident({ wallet, incidentId }) {
    await this.requireOperator(wallet, { admin: true });
    const result = await this.pool.query(
      `UPDATE operations_incidents SET status = 'resolved', resolved_at = now()
        WHERE id = $1 RETURNING id`,
      [incidentId],
    );
    if (result.rowCount !== 1) fail("Incident was not found", 404, "not_found");
    await this.#audit(wallet, "incident.resolved", "incident", incidentId, {});
    return { id: incidentId, status: "resolved" };
  }

  async #audit(operatorWallet, action, subjectType, subjectId, payload) {
    await this.pool.query(
      `INSERT INTO safe_beta_moderation_events
        (operator_wallet, action, subject_type, subject_id, payload)
       VALUES ($1, $2, $3, $4, $5)`,
      [operatorWallet, action, subjectType, String(subjectId), redact(payload)],
    );
  }
}

export { OPERATOR_ROLES, PLAYER_STATUSES, REPORT_STATUSES, metricRoute, normalizedCode, redact };
