import assert from "node:assert/strict";
import test from "node:test";

import { MonitoringMetrics, RuntimeMonitoring } from "./monitoring.js";

function dependencies() {
  const state = {
    row: {
      overdue_deadlines: 0,
      oldest_deadline_ms: 0,
      stalled_tables: 0,
      stalled_beacons: 0,
      recent_application_incidents: 0,
    },
    waiting: 0,
    deliveries: new Set(),
  };
  const pool = {
    totalCount: 2,
    idleCount: 1,
    get waitingCount() { return state.waiting; },
    async query() { return { rows: [state.row] }; },
  };
  const redis = {
    async ping() { return "PONG"; },
    async set(key, _value, options) {
      if (options?.NX && state.deliveries.has(key)) return null;
      state.deliveries.add(key);
      return "OK";
    },
  };
  return { state, pool, redis };
}

test("metrics export bounded HTTP, realtime, timeout, failure, and health series", () => {
  let now = new Date("2026-08-19T00:00:00.000Z");
  const metrics = new MonitoringMetrics({
    instanceId: "replica-a",
    buildCommit: "a".repeat(40),
    clock: () => now,
  });
  metrics.observeHttpRequest({
    method: "GET",
    path: "/v1/attacker-controlled/high-cardinality-value",
    statusCode: 503,
    durationMs: 87,
  });
  metrics.recordRealtime({ event: "connection_opened" });
  metrics.recordRealtime({ event: "connection_closed", code: 1006 });
  metrics.recordTimeout({ claimed: 2, applied: 1 });
  metrics.recordFailure("safe_beta_dealer_failed", "drand beacon unavailable");
  metrics.setGauge("postgres_healthy", 1);
  now = new Date("2026-08-19T00:00:05.000Z");

  const snapshot = metrics.snapshot();
  assert.equal(snapshot.uptimeSeconds, 5);
  assert.equal(snapshot.totalRequests, 1);
  assert.equal(snapshot.activeRealtimeConnections, 0);
  assert.equal(snapshot.timeoutActionsApplied, 1);
  assert.equal(snapshot.failures.drand_failure, 1);

  const output = metrics.prometheus();
  assert.match(output, /xpoker_http_requests_total\{method="GET",route="\/v1\/:unmatched",status_class="5xx"\} 1/);
  assert.doesNotMatch(output, /attacker-controlled/);
  assert.match(output, /xpoker_timeout_actions_total\{outcome="claimed"\} 2/);
  assert.match(output, /xpoker_realtime_events_total\{event="connection_closed",code="1006"\} 1/);
  assert.match(output, /xpoker_runtime_gauge\{name="postgres_healthy"\} 1/);
});

test("runtime probes alert once, expose degradation, and emit recovery", async () => {
  const { state, pool, redis } = dependencies();
  const incidents = [];
  const resolved = [];
  const deliveries = [];
  const operations = {
    async recordIncident(value) { incidents.push(value); return { id: `incident-${incidents.length}` }; },
    async resolveAutomatedIncidents(value) { resolved.push(value.category); return { resolved: 1 }; },
  };
  const monitoring = new RuntimeMonitoring({
    pool,
    redis,
    operations,
    config: {
      instanceId: "replica-a",
      buildCommit: "b".repeat(40),
      alertWebhookUrl: "https://alerts.example/xpoker",
      alertWebhookToken: "t".repeat(32),
      monitorMinimumRequests: 5,
      monitorHttpErrorRate: 0.2,
      monitorRealtimeDisconnectRate: 0.4,
      monitorPoolWaitingLimit: 1,
      monitorProbeTimeoutMs: 500,
      alertCooldownMs: 60_000,
    },
    fetchImpl: async (_url, request) => {
      deliveries.push({ headers: request.headers, payload: JSON.parse(request.body) });
      return { ok: true, status: 202 };
    },
  });

  assert.equal((await monitoring.runOnce()).status, "healthy");
  state.row = {
    overdue_deadlines: 2,
    oldest_deadline_ms: 91_000,
    stalled_tables: 1,
    stalled_beacons: 1,
    recent_application_incidents: 1,
  };
  state.waiting = 3;
  for (let index = 0; index < 5; index += 1) {
    monitoring.observeHttpRequest({ method: "POST", path: "/v1/beta/tables/join", statusCode: 500, durationMs: 20 });
    monitoring.recordRealtime({ event: "connection_opened" });
    monitoring.recordRealtime({ event: "connection_closed", code: 1006 });
  }
  const degraded = await monitoring.runOnce();
  assert.equal(degraded.status, "degraded");
  assert.deepEqual(degraded.failed.sort(), [
    "action_deadlines",
    "application_incidents",
    "drand",
    "http_errors",
    "postgres_pool",
    "realtime_disconnects",
    "table_progress",
  ]);
  assert.ok(incidents.some((incident) => incident.category === "monitor_action_deadlines"));
  assert.ok(incidents.some((incident) => incident.category === "monitor_drand"));
  assert.ok(deliveries.every((delivery) => delivery.headers.authorization === `Bearer ${"t".repeat(32)}`));
  assert.ok(deliveries.every((delivery) => delivery.payload.version === "xpoker-alert/v1"));

  state.row = {
    overdue_deadlines: 0,
    oldest_deadline_ms: 0,
    stalled_tables: 0,
    stalled_beacons: 0,
    recent_application_incidents: 0,
  };
  state.waiting = 0;
  for (let index = 0; index < 5; index += 1) {
    monitoring.observeHttpRequest({ method: "GET", path: "/health/ready", statusCode: 200, durationMs: 2 });
    monitoring.recordRealtime({ event: "connection_opened" });
  }
  const recovered = await monitoring.runOnce();
  assert.equal(recovered.status, "healthy");
  assert.ok(resolved.includes("monitor_action_deadlines"));
  assert.ok(resolved.includes("monitor_drand"));
  assert.ok(deliveries.some((delivery) => delivery.payload.status === "resolved"));
  await monitoring.close();
});

test("runtime failure alerts redact secrets and deduplicate webhook delivery", async () => {
  const { pool, redis } = dependencies();
  const incidents = [];
  const deliveries = [];
  const monitoring = new RuntimeMonitoring({
    pool,
    redis,
    operations: { recordIncident: async (value) => incidents.push(value) },
    config: {
      instanceId: "replica-a",
      alertWebhookUrl: "https://alerts.example/xpoker",
      monitorProbeTimeoutMs: 500,
      alertCooldownMs: 60_000,
    },
    fetchImpl: async (_url, request) => {
      deliveries.push(JSON.parse(request.body));
      return { ok: true, status: 200 };
    },
  });
  const failure = {
    category: "proof_download_failed",
    severity: "error",
    message: "Proof generation failed",
    context: { authorization: "Bearer secret", nested: { privateKey: "never-send" } },
  };
  await monitoring.capture(failure);
  await monitoring.capture(failure);
  assert.equal(incidents.length, 2);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].context.authorization, "[redacted]");
  assert.equal(deliveries[0].context.nested.privateKey, "[redacted]");
  await monitoring.close();
});
