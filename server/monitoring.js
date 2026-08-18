import { createHash } from "node:crypto";

import { metricRoute, redact } from "./beta-operations.js";

const HTTP_BUCKETS_MS = Object.freeze([5, 10, 25, 50, 100, 250, 500, 1_000, 2_000, 5_000]);
const REALTIME_EVENTS = new Set([
  "connection_opened",
  "connection_closed",
  "authenticated",
  "authentication_failed",
  "subscribed",
  "command_applied",
  "command_failed",
  "heartbeat_terminated",
  "socket_error",
]);
const FAILURE_CATEGORIES = new Set([
  "admin_http_failed",
  "drand_failure",
  "operations_heartbeat_failed",
  "proof_download_failed",
  "runtime_error",
  "safe_beta_dealer_failed",
  "safe_beta_http_failed",
  "table_event_fanout_failed",
  "table_timeout_failed",
]);

const MONITOR_QUERY = `SELECT
  (SELECT count(*)::integer
     FROM table_timeout_leases
    WHERE deadline_at < now() - ($1::double precision * interval '1 millisecond')) AS overdue_deadlines,
  (SELECT COALESCE(EXTRACT(epoch FROM (now() - min(deadline_at))) * 1000, 0)
     FROM table_timeout_leases
    WHERE deadline_at < now() - ($1::double precision * interval '1 millisecond')) AS oldest_deadline_ms,
  (SELECT count(*)::integer
     FROM game_tables
    WHERE status = 'hand_active'
      AND updated_at < now() - ($2::double precision * interval '1 millisecond')) AS stalled_tables,
  (SELECT count(*)::integer
     FROM hands
    WHERE status = 'beacon_reserved'
      AND COALESCE(
        (SELECT max(occurred_at) FROM hand_events WHERE hand_id = hands.id),
        started_at
      ) < now() - ($3::double precision * interval '1 millisecond')) AS stalled_beacons`;

function finite(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function metricLabel(value) {
  return String(value ?? "unknown")
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll('"', '\\"')
    .slice(0, 160);
}

function labels(value) {
  const entries = Object.entries(value ?? {});
  if (entries.length === 0) return "";
  return `{${entries.map(([key, entry]) => `${key}="${metricLabel(entry)}"`).join(",")}}`;
}

function hash(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}

async function within(milliseconds, operation, label) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function classifiedFailure(category, errorMessage) {
  if (/drand|beacon/i.test(`${category} ${errorMessage}`)) return "drand_failure";
  return FAILURE_CATEGORIES.has(category) ? category : "other";
}

export class MonitoringMetrics {
  constructor({ instanceId = "development", buildCommit = "development", clock = () => new Date() } = {}) {
    this.instanceId = instanceId;
    this.buildCommit = buildCommit;
    this.clock = clock;
    this.startedAt = clock();
    this.requestCounts = new Map();
    this.requestDurations = new Map();
    this.realtimeCounts = new Map();
    this.failureCounts = new Map();
    this.timeoutCounts = { polls: 0, claimed: 0, applied: 0 };
    this.activeRealtimeConnections = 0;
    this.gauges = new Map();
    this.window = this.#emptyWindow();
  }

  #emptyWindow() {
    return {
      requests: 0,
      serverErrors: 0,
      realtimeOpened: 0,
      realtimeUnexpectedClosed: 0,
    };
  }

  observeHttpRequest({ method, path, statusCode, durationMs }) {
    const safeMethod = /^[A-Z]{3,8}$/.test(String(method ?? "").toUpperCase())
      ? String(method).toUpperCase()
      : "OTHER";
    const route = metricRoute(path);
    const statusClass = /^[1-5]$/.test(String(Math.floor(Number(statusCode) / 100)))
      ? `${Math.floor(Number(statusCode) / 100)}xx`
      : "unknown";
    const countKey = JSON.stringify([safeMethod, route, statusClass]);
    const durationKey = JSON.stringify([safeMethod, route]);
    this.requestCounts.set(countKey, (this.requestCounts.get(countKey) ?? 0) + 1);
    const histogram = this.requestDurations.get(durationKey) ?? {
      count: 0,
      sum: 0,
      buckets: HTTP_BUCKETS_MS.map(() => 0),
    };
    const observed = Math.max(0, finite(durationMs));
    histogram.count += 1;
    histogram.sum += observed;
    for (let index = 0; index < HTTP_BUCKETS_MS.length; index += 1) {
      if (observed <= HTTP_BUCKETS_MS[index]) histogram.buckets[index] += 1;
    }
    this.requestDurations.set(durationKey, histogram);
    this.window.requests += 1;
    if (statusClass === "5xx") this.window.serverErrors += 1;
  }

  recordRealtime({ event, code } = {}) {
    const safeEvent = REALTIME_EVENTS.has(event) ? event : "other";
    const safeCode = Number.isInteger(code) && code >= 1000 && code <= 4999 ? String(code) : "none";
    const key = JSON.stringify([safeEvent, safeCode]);
    this.realtimeCounts.set(key, (this.realtimeCounts.get(key) ?? 0) + 1);
    if (safeEvent === "connection_opened") {
      this.activeRealtimeConnections += 1;
      this.window.realtimeOpened += 1;
    }
    if (safeEvent === "connection_closed") {
      this.activeRealtimeConnections = Math.max(0, this.activeRealtimeConnections - 1);
      if (!["1000", "1001"].includes(safeCode)) this.window.realtimeUnexpectedClosed += 1;
    }
  }

  recordTimeout({ claimed = 0, applied = 0 } = {}) {
    this.timeoutCounts.polls += 1;
    this.timeoutCounts.claimed += Math.max(0, Math.trunc(finite(claimed)));
    this.timeoutCounts.applied += Math.max(0, Math.trunc(finite(applied)));
  }

  recordFailure(category, errorMessage = "") {
    const safeCategory = classifiedFailure(String(category ?? "runtime_error"), errorMessage);
    this.failureCounts.set(safeCategory, (this.failureCounts.get(safeCategory) ?? 0) + 1);
  }

  setGauge(name, value) {
    if (!/^[a-z][a-z0-9_]{2,80}$/.test(name)) throw new Error("Monitoring gauge name is invalid");
    this.gauges.set(name, finite(value));
  }

  drainWindow() {
    const result = this.window;
    this.window = this.#emptyWindow();
    return result;
  }

  snapshot() {
    const totalRequests = [...this.requestCounts.values()].reduce((sum, value) => sum + value, 0);
    const failures = Object.fromEntries([...this.failureCounts.entries()].sort(([left], [right]) => left.localeCompare(right)));
    return {
      startedAt: this.startedAt.toISOString(),
      uptimeSeconds: Math.max(0, Math.floor((this.clock().getTime() - this.startedAt.getTime()) / 1_000)),
      totalRequests,
      activeRealtimeConnections: this.activeRealtimeConnections,
      timeoutPolls: this.timeoutCounts.polls,
      timeoutActionsApplied: this.timeoutCounts.applied,
      failures,
      gauges: Object.fromEntries([...this.gauges.entries()].sort(([left], [right]) => left.localeCompare(right))),
    };
  }

  prometheus() {
    const lines = [
      "# HELP xpoker_build_info Build and instance information.",
      "# TYPE xpoker_build_info gauge",
      `xpoker_build_info${labels({ commit: this.buildCommit, instance: this.instanceId })} 1`,
      "# HELP xpoker_uptime_seconds Process uptime in seconds.",
      "# TYPE xpoker_uptime_seconds gauge",
      `xpoker_uptime_seconds ${this.snapshot().uptimeSeconds}`,
      "# HELP xpoker_http_requests_total Completed HTTP requests.",
      "# TYPE xpoker_http_requests_total counter",
    ];
    for (const [key, count] of [...this.requestCounts.entries()].sort()) {
      const [method, route, statusClass] = JSON.parse(key);
      lines.push(`xpoker_http_requests_total${labels({ method, route, status_class: statusClass })} ${count}`);
    }
    lines.push(
      "# HELP xpoker_http_request_duration_ms HTTP request duration in milliseconds.",
      "# TYPE xpoker_http_request_duration_ms histogram",
    );
    for (const [key, histogram] of [...this.requestDurations.entries()].sort()) {
      const [method, route] = JSON.parse(key);
      for (let index = 0; index < HTTP_BUCKETS_MS.length; index += 1) {
        lines.push(`xpoker_http_request_duration_ms_bucket${labels({ method, route, le: HTTP_BUCKETS_MS[index] })} ${histogram.buckets[index]}`);
      }
      lines.push(`xpoker_http_request_duration_ms_bucket${labels({ method, route, le: "+Inf" })} ${histogram.count}`);
      lines.push(`xpoker_http_request_duration_ms_sum${labels({ method, route })} ${histogram.sum}`);
      lines.push(`xpoker_http_request_duration_ms_count${labels({ method, route })} ${histogram.count}`);
    }
    lines.push(
      "# HELP xpoker_realtime_connections Current WebSocket connections.",
      "# TYPE xpoker_realtime_connections gauge",
      `xpoker_realtime_connections ${this.activeRealtimeConnections}`,
      "# HELP xpoker_realtime_events_total WebSocket lifecycle and command events.",
      "# TYPE xpoker_realtime_events_total counter",
    );
    for (const [key, count] of [...this.realtimeCounts.entries()].sort()) {
      const [event, code] = JSON.parse(key);
      lines.push(`xpoker_realtime_events_total${labels({ event, code })} ${count}`);
    }
    lines.push(
      "# HELP xpoker_runtime_failures_total Bounded runtime failure categories.",
      "# TYPE xpoker_runtime_failures_total counter",
    );
    for (const [category, count] of [...this.failureCounts.entries()].sort()) {
      lines.push(`xpoker_runtime_failures_total${labels({ category })} ${count}`);
    }
    lines.push(
      "# HELP xpoker_timeout_polls_total Timeout-worker polls.",
      "# TYPE xpoker_timeout_polls_total counter",
      `xpoker_timeout_polls_total ${this.timeoutCounts.polls}`,
      "# HELP xpoker_timeout_actions_total Timeout leases claimed and applied.",
      "# TYPE xpoker_timeout_actions_total counter",
      `xpoker_timeout_actions_total${labels({ outcome: "claimed" })} ${this.timeoutCounts.claimed}`,
      `xpoker_timeout_actions_total${labels({ outcome: "applied" })} ${this.timeoutCounts.applied}`,
      "# HELP xpoker_runtime_gauge Operational dependency and queue gauges.",
      "# TYPE xpoker_runtime_gauge gauge",
    );
    for (const [name, value] of [...this.gauges.entries()].sort()) {
      lines.push(`xpoker_runtime_gauge${labels({ name })} ${value}`);
    }
    return `${lines.join("\n")}\n`;
  }
}

export class RuntimeMonitoring {
  constructor({
    pool,
    redis,
    operations,
    config = {},
    logger = console,
    clock = () => new Date(),
    fetchImpl = globalThis.fetch,
  } = {}) {
    if (!pool?.query) throw new Error("Runtime monitoring requires PostgreSQL");
    if (!redis?.ping || !redis?.set) throw new Error("Runtime monitoring requires Redis");
    this.pool = pool;
    this.redis = redis;
    this.operations = operations;
    this.config = config;
    this.logger = logger;
    this.clock = clock;
    this.fetchImpl = fetchImpl;
    this.metrics = new MonitoringMetrics({
      instanceId: config.instanceId,
      buildCommit: config.buildCommit,
      clock,
    });
    this.conditions = new Map();
    this.localDelivery = new Map();
    this.timer = undefined;
    this.activeRun = undefined;
    this.closed = false;
    this.lastCheckedAt = null;
  }

  observeHttpRequest = (input) => this.metrics.observeHttpRequest(input);

  recordRealtime = (input) => this.metrics.recordRealtime(input);

  recordTimeout = (input) => this.metrics.recordTimeout(input);

  async #deliveryLease(key) {
    const cooldownMs = this.config.alertCooldownMs ?? 300_000;
    const digest = hash(key);
    try {
      return (await within(
        Math.min(1_000, this.config.monitorProbeTimeoutMs ?? 2_000),
        this.redis.set(`xpoker:monitor:delivery:${digest}`, this.config.instanceId ?? "instance", {
          NX: true,
          PX: cooldownMs,
        }),
        "Monitoring delivery lease",
      )) === "OK";
    } catch {
      const previous = this.localDelivery.get(digest) ?? 0;
      const now = this.clock().getTime();
      if (previous + cooldownMs > now) return false;
      this.localDelivery.set(digest, now);
      return true;
    }
  }

  async #webhook(payload) {
    if (!this.config.alertWebhookUrl || typeof this.fetchImpl !== "function") return false;
    const headers = {
      "content-type": "application/json",
      "user-agent": "xpoker-monitor/1",
    };
    if (this.config.alertWebhookToken) headers.authorization = `Bearer ${this.config.alertWebhookToken}`;
    const response = await within(
      this.config.monitorProbeTimeoutMs ?? 2_000,
      this.fetchImpl(this.config.alertWebhookUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      }),
      "Alert webhook",
    );
    if (!response?.ok) throw new Error(`Alert webhook returned HTTP ${response?.status ?? "unknown"}`);
    return true;
  }

  async #emit({ category, severity, alertMessage, context, status = "firing" }) {
    const key = `${status}:${category}:${alertMessage}`;
    if (!(await this.#deliveryLease(key))) return false;
    const payload = {
      version: "xpoker-alert/v1",
      status,
      severity,
      category,
      message: alertMessage,
      occurredAt: this.clock().toISOString(),
      service: "xpoker-api",
      instanceId: this.config.instanceId ?? "unknown",
      buildCommit: this.config.buildCommit ?? "development",
      context: redact(context ?? {}),
      runbook: "docs/INCIDENT-RESPONSE.md",
    };
    try {
      await this.#webhook(payload);
    } catch (error) {
      this.logger.error(JSON.stringify({
        level: "error",
        event: "monitoring_delivery_failed",
        category,
        error: message(error),
      }));
    }
    return true;
  }

  capture = async ({ category = "runtime_error", severity = "error", message: errorMessage, context = {} } = {}) => {
    const safeMessage = String(errorMessage || "Unknown runtime failure").slice(0, 1_000);
    this.metrics.recordFailure(category, safeMessage);
    await this.operations?.recordIncident({ category, severity, message: safeMessage, context }).catch((error) => {
      this.logger.error(JSON.stringify({
        level: "error",
        event: "monitoring_incident_persistence_failed",
        category,
        error: message(error),
      }));
    });
    await this.#emit({ category, severity, alertMessage: safeMessage, context });
  };

  async #condition(name, failed, { severity, alertMessage, context = {} }) {
    if (failed === undefined) return;
    const previous = this.conditions.get(name);
    this.conditions.set(name, {
      status: failed ? "failed" : "healthy",
      severity,
      message: alertMessage,
      checkedAt: this.clock().toISOString(),
    });
    this.metrics.setGauge(`condition_${name}`, failed ? 0 : 1);
    const category = `monitor_${name}`;
    if (failed && previous?.status !== "failed") {
      await this.capture({ category, severity, message: alertMessage, context });
    }
    if (!failed && previous?.status === "failed") {
      await this.operations?.resolveAutomatedIncidents({ category }).catch(() => {});
      await this.#emit({
        category,
        severity: "warning",
        alertMessage,
        context,
        status: "resolved",
      });
    }
  }

  async runOnce() {
    if (this.activeRun) return this.activeRun;
    this.activeRun = (async () => {
      const timeoutMs = this.config.monitorProbeTimeoutMs ?? 2_000;
      const timed = async (operation) => {
        const startedAt = performance.now();
        const value = await operation;
        return { value, latencyMs: Math.max(0, performance.now() - startedAt) };
      };
      const [database, redis] = await Promise.allSettled([
        timed(within(timeoutMs, this.pool.query(MONITOR_QUERY, [
          this.config.monitorOverdueGraceMs ?? 30_000,
          this.config.monitorStalledTableMs ?? 120_000,
          this.config.monitorStalledBeaconMs ?? 60_000,
        ]), "PostgreSQL monitoring probe")),
        timed(within(timeoutMs, this.redis.ping(), "Redis monitoring probe")),
      ]);
      const databaseLatencyMs = database.status === "fulfilled" ? database.value.latencyMs : timeoutMs;
      const redisLatencyMs = redis.status === "fulfilled" ? redis.value.latencyMs : timeoutMs;
      this.metrics.setGauge("postgres_healthy", database.status === "fulfilled" ? 1 : 0);
      this.metrics.setGauge("postgres_latency_ms", databaseLatencyMs);
      this.metrics.setGauge("postgres_pool_total", finite(this.pool.totalCount));
      this.metrics.setGauge("postgres_pool_idle", finite(this.pool.idleCount));
      this.metrics.setGauge("postgres_pool_waiting", finite(this.pool.waitingCount));
      this.metrics.setGauge("redis_healthy", redis.status === "fulfilled" ? 1 : 0);
      this.metrics.setGauge("redis_latency_ms", redisLatencyMs);

      await this.#condition("postgres", database.status === "rejected", {
        severity: "critical",
        alertMessage: "PostgreSQL monitoring probe failed",
        context: database.status === "rejected" ? { error: message(database.reason) } : { latencyMs: databaseLatencyMs },
      });
      await this.#condition("redis", redis.status === "rejected", {
        severity: "critical",
        alertMessage: "Redis monitoring probe failed",
        context: redis.status === "rejected" ? { error: message(redis.reason) } : { latencyMs: redisLatencyMs },
      });
      await this.#condition("postgres_latency", database.status === "fulfilled"
        ? databaseLatencyMs > (this.config.monitorDatabaseLatencyMs ?? 1_000)
        : undefined, {
        severity: "warning",
        alertMessage: "PostgreSQL monitoring latency exceeded its threshold",
        context: { latencyMs: databaseLatencyMs, thresholdMs: this.config.monitorDatabaseLatencyMs ?? 1_000 },
      });
      await this.#condition("redis_latency", redis.status === "fulfilled"
        ? redisLatencyMs > (this.config.monitorRedisLatencyMs ?? 500)
        : undefined, {
        severity: "warning",
        alertMessage: "Redis monitoring latency exceeded its threshold",
        context: { latencyMs: redisLatencyMs, thresholdMs: this.config.monitorRedisLatencyMs ?? 500 },
      });
      await this.#condition("postgres_pool", database.status === "fulfilled"
        ? finite(this.pool.waitingCount) > (this.config.monitorPoolWaitingLimit ?? 10)
        : undefined, {
        severity: "error",
        alertMessage: "PostgreSQL connection pool waiters exceeded the threshold",
        context: {
          waiting: finite(this.pool.waitingCount),
          total: finite(this.pool.totalCount),
          idle: finite(this.pool.idleCount),
          threshold: this.config.monitorPoolWaitingLimit ?? 10,
        },
      });

      if (database.status === "fulfilled") {
        const row = database.value.value.rows[0] ?? {};
        const overdueDeadlines = finite(row.overdue_deadlines);
        const oldestDeadlineMs = finite(row.oldest_deadline_ms);
        const stalledTables = finite(row.stalled_tables);
        const stalledBeacons = finite(row.stalled_beacons);
        this.metrics.setGauge("overdue_action_deadlines", overdueDeadlines);
        this.metrics.setGauge("oldest_action_deadline_ms", oldestDeadlineMs);
        this.metrics.setGauge("stalled_tables", stalledTables);
        this.metrics.setGauge("stalled_beacon_reservations", stalledBeacons);
        await this.#condition("action_deadlines", overdueDeadlines > 0, {
          severity: "error",
          alertMessage: "One or more poker action deadlines are overdue",
          context: { overdueDeadlines, oldestDeadlineMs },
        });
        await this.#condition("table_progress", stalledTables > 0, {
          severity: "error",
          alertMessage: "One or more active poker tables stopped progressing",
          context: { stalledTables, thresholdMs: this.config.monitorStalledTableMs ?? 120_000 },
        });
        await this.#condition("drand", stalledBeacons > 0, {
          severity: "critical",
          alertMessage: "One or more hands are stalled waiting for a drand beacon",
          context: { stalledBeacons, thresholdMs: this.config.monitorStalledBeaconMs ?? 60_000 },
        });
      }

      const window = this.metrics.drainWindow();
      const minimumRequests = this.config.monitorMinimumRequests ?? 20;
      const errorRate = window.requests ? window.serverErrors / window.requests : 0;
      this.metrics.setGauge("http_window_requests", window.requests);
      this.metrics.setGauge("http_window_error_rate", errorRate);
      await this.#condition("http_errors", window.requests >= minimumRequests
        ? errorRate > (this.config.monitorHttpErrorRate ?? 0.05)
        : false, {
        severity: "error",
        alertMessage: "HTTP 5xx error rate exceeded the threshold",
        context: {
          requests: window.requests,
          serverErrors: window.serverErrors,
          errorRate,
          threshold: this.config.monitorHttpErrorRate ?? 0.05,
        },
      });
      const disconnectRate = window.realtimeOpened
        ? window.realtimeUnexpectedClosed / window.realtimeOpened
        : 0;
      this.metrics.setGauge("realtime_window_opened", window.realtimeOpened);
      this.metrics.setGauge("realtime_window_unexpected_disconnect_rate", disconnectRate);
      await this.#condition("realtime_disconnects", window.realtimeOpened >= minimumRequests
        ? disconnectRate > (this.config.monitorRealtimeDisconnectRate ?? 0.5)
        : false, {
        severity: "warning",
        alertMessage: "Unexpected WebSocket disconnect rate exceeded the threshold",
        context: {
          opened: window.realtimeOpened,
          unexpectedClosed: window.realtimeUnexpectedClosed,
          disconnectRate,
          threshold: this.config.monitorRealtimeDisconnectRate ?? 0.5,
        },
      });
      this.lastCheckedAt = this.clock().toISOString();
      return this.publicHealth();
    })();
    try {
      return await this.activeRun;
    } finally {
      this.activeRun = undefined;
    }
  }

  async start() {
    if (this.closed) throw new Error("Closed monitoring cannot be restarted");
    if (this.timer) return;
    await this.runOnce();
    this.timer = setInterval(() => {
      this.runOnce().catch((error) => this.capture({
        category: "runtime_error",
        severity: "error",
        message: `Monitoring loop failed: ${message(error)}`,
      }));
    }, this.config.monitorIntervalMs ?? 15_000);
    this.timer.unref?.();
  }

  async close() {
    this.closed = true;
    clearInterval(this.timer);
    this.timer = undefined;
    if (this.activeRun) await this.activeRun;
  }

  publicHealth() {
    const checks = Object.fromEntries([...this.conditions.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => [name, value.status]));
    const failed = Object.entries(checks).filter(([, status]) => status === "failed").map(([name]) => name);
    return {
      status: this.lastCheckedAt ? (failed.length ? "degraded" : "healthy") : "starting",
      checkedAt: this.lastCheckedAt,
      failed,
      checks,
    };
  }

  snapshot() {
    return {
      ...this.publicHealth(),
      ...this.metrics.snapshot(),
    };
  }

  prometheus() {
    return this.metrics.prometheus();
  }
}

export { MONITOR_QUERY };
