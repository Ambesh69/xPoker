# xPoker incident response

Status: operational runbook for the zero-value safe beta. It is not evidence of regulatory approval or authorization to move funds.

## Detection and notification

Every API replica runs a 15-second operational probe loop. `/health/ops` exposes only coarse check state for the public uptime monitor; it does not expose database addresses, player identities, secrets, table identifiers, or alert context. A non-healthy result makes the five-minute GitHub uptime check open one `[ops] Production uptime alert`. Later degraded checks keep that single issue authoritative without generating repeated failed-run emails or comments. Recovery closes the issue automatically.

The probes cover:

- PostgreSQL and Redis availability and response latency.
- PostgreSQL connection-pool waiters.
- Action deadlines still pending 30 seconds after expiry.
- Active tables with no durable progress for two minutes.
- Hands waiting on a reserved drand beacon for more than one minute.
- Rolling HTTP 5xx and unexpected WebSocket-disconnect rates after a minimum sample size.
- Dealer/drand, proof-download, timeout-worker, Redis fanout, heartbeat and unexpected HTTP failures.
- Recent unresolved error/critical application incidents, so the external GitHub receiver sees failures captured inside the runtime.

All failures are counted in bounded metrics and deduplicated in `operations_incidents`. Automated check recovery resolves only incidents whose category begins with `monitor_`; application failures remain open for human review. If `ALERT_WEBHOOK_URL` is configured, one API replica sends a redacted `xpoker-alert/v1` firing or resolved event. Redis provides cross-replica delivery deduplication, with a local fallback during a Redis outage.

## Severity

- **Critical:** PostgreSQL or Redis unavailable, stalled drand reservations, transcript/integrity risk, or any suspicion that a private card was disclosed incorrectly.
- **Error:** overdue action clocks, stalled active tables, pool exhaustion, sustained 5xx errors, proof failures or timeout-worker failures.
- **Warning:** elevated latency, elevated unexpected WebSocket disconnects, or replica-heartbeat loss while another replica remains healthy.

No automated response enables value movement, changes a game result, deletes data, skips proof verification, or selects a replacement randomness round.

## First five minutes

1. Acknowledge the GitHub issue or external page and record the UTC start time.
2. Check `/health/ready` and `/health/ops`, then open the Pit Board to review live replicas, failed probes and incident fingerprints.
3. Check the current Railway deployment, PostgreSQL and Redis service health. Confirm whether the failure began immediately after a deployment.
4. Stop new beta entry if integrity or private-card confidentiality could be affected. Keep `REAL_VALUE_MODE=disabled`.
5. Preserve logs, the deployment commit, request IDs and affected hand IDs. Never place wallet signatures, session tokens, seeds or private keys in the incident record.

## Playbooks

### PostgreSQL unavailable or pool saturated

Do not promote an unverified database or run migrations manually against an unknown target. Check provider health and connection limits. If the failure followed a deploy, roll back the application to the last green commit. If restoration is necessary, restore to an isolated service first and run `npm run verify:restore` before changing traffic. Confirm table and hand event chains after recovery.

### Redis unavailable

PostgreSQL remains authoritative; Redis is session, lease, lock and fanout infrastructure. Do not recreate state by editing PostgreSQL events. Restore Redis connectivity, then confirm session behavior, replica heartbeats and WebSocket cursor replay. Durable events committed during fanout loss must appear after reconnect.

### Overdue clocks or stalled tables

Confirm at least one timeout worker is polling and PostgreSQL is writable. Inspect the incident age and the table event chain. A worker retry must use the existing lease/version checks; do not force an action or modify a pot. After recovery, confirm exactly one `ACTION_TIMED_OUT` event and chip conservation.

### drand or dealer failure

The affected hand must remain waiting or fail closed. Never choose another completed round, weaken BLS verification, reveal the server seed early, or rotate `SAFE_BETA_SIGNING_KEY_PEM` during the incident. Restore access to the pinned Quicknet chain, then confirm the reservation, beacon signature, deck root and transcript head before play resumes.

### Proof-download failure

Keep the hand immutable. Verify the completed transcript, Redis committed-hand bundle and independent beacon refetch. Do not synthesize a proof from UI state. Restore proof availability and download the bundle as a participant before resolving the incident.

### Elevated HTTP errors or WebSocket disconnects

Compare the deployment time, dependency latency and replica heartbeats. Roll back a recent application regression. For WebSockets, confirm origin enforcement, Redis fanout, heartbeat operation and PostgreSQL cursor replay before declaring recovery.

## Recovery criteria

An incident is recovered only when:

- `/health/ready` is ready and `/health/ops` is healthy across two consecutive external checks.
- The Pit Board shows the intended replica count and no new occurrences of the incident fingerprint.
- A wallet can authenticate, reconnect to a table and download a valid proof in the safe beta.
- Any affected table reconstructs from PostgreSQL and passes event-chain verification.
- The responder records the cause, containment, recovery time, affected scope and follow-up owner.

Application incidents should be resolved manually only after these checks. Automated `monitor_` incidents close when the underlying probe recovers and will reopen on recurrence.

## Metrics and alert receiver

Set a random `METRICS_BEARER_TOKEN` of at least 32 characters to enable `GET /metrics`. The endpoint uses a constant-time hashed bearer comparison and emits Prometheus text with bounded routes and failure categories. Never place this token in frontend code.

The production safe beta uses the GitHub Actions uptime workflow as its external receiver. Configure `EXTERNAL_UPTIME_PROVIDER=github-actions` and the HTTPS workflow URL in `EXTERNAL_UPTIME_URL`. Runtime incidents degrade `/health/ops` for a bounded window, opening the same deduplicated issue. `ALERT_WEBHOOK_URL` remains available for a future paging provider; its token must be a sealed secret and alert context is recursively redacted before delivery.

## Drill

At least quarterly, use a non-production environment to inject Redis interruption, PostgreSQL latency, a replica restart and a drand failure. Confirm firing and resolved notifications, GitHub issue automation, Pit Board state, proof availability and recovery against the targets in this runbook. The uptime workflow's `simulate_failure` input is a non-disruptive notification drill: it must open one issue while the workflow itself remains successful; a normal follow-up run must close that issue. Store the dated drill report and digest outside the application repository; only independently reviewed evidence may satisfy the release manifest's incident-response gate.
