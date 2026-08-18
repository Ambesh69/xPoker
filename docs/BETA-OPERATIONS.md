# xPoker safe-beta operations

Status: operational runbook for the zero-value beta. It does not authorize real-money play.

## Operator access and invitations

Set `ADMIN_WALLETS` to one or more comma-separated Solana public wallet addresses and redeploy. Runtime bootstrap grants those exact addresses the `admin` role. A wallet must still complete the normal origin-bound signature challenge; knowledge of an address alone grants no session.

The **Pit Board** appears in the authenticated sidebar for an operator. Admins can create global beta codes, copy the code once, review players and reports, suspend or ban accounts, and resolve operational incidents. Listings expose invite metadata but never the code; only a SHA-256 digest is persisted.

Keep `BETA_INVITE_REQUIRED=disabled` while onboarding the first admin. Create at least one access code, confirm redemption in a separate browser, then set it to `enabled`. Operators bypass the access gate. Room invitation codes and global access codes are separate controls.

## Monitoring and alerting

Every API replica writes a Redis heartbeat with a 45-second TTL and increments daily request, status-class, route, and duration counters. It also runs operational probes for PostgreSQL/Redis health and latency, pool pressure, overdue action clocks, stalled active tables and stalled drand reservations. Rolling HTTP error and WebSocket-disconnect thresholds require a minimum sample size. The Pit Board shows the resulting health checks and replica-local live metrics.

Runtime failures and failed probes become deduplicated PostgreSQL incidents; sensitive context keys and oversized values are removed before persistence or delivery. Probe recovery automatically resolves only `monitor_` incidents. A protected Prometheus-compatible `/metrics` endpoint is enabled by `METRICS_BEARER_TOKEN`. An optional HTTPS receiver configured with `ALERT_WEBHOOK_URL` receives cross-replica-deduplicated firing and resolved events.

`.github/workflows/uptime.yml` checks the frontend, authoritative readiness, operational health, four-room lobby contract, ten-asset allowlist, and `fundsMove: false` every five minutes. Failure opens or updates one GitHub issue named `[ops] Production uptime alert`; recovery comments on and closes it. GitHub Actions schedules can be delayed, so this is a baseline monitor rather than an SLA-grade paging provider. The complete triage and recovery process is in [`INCIDENT-RESPONSE.md`](INCIDENT-RESPONSE.md).

Triage order:

1. Check `/health/ready` and `/health/ops`; a 503 identifies dependency/release blocking or an operational probe failure.
2. Check Railway deployment and PostgreSQL/Redis health.
3. Open the Pit Board and compare live heartbeats, 5xx rate, latency, and incident fingerprints.
4. Resolve an incident only after recovery; another occurrence reopens it automatically.

## Backups and restore verification

Enable Railway volume backups for PostgreSQL and retain at least daily, weekly, and monthly restore points. The hosting dashboard controls native backup scheduling and billing; repository code cannot make a missing provider snapshot exist.

The monthly `Backup restore drill` GitHub workflow independently proves the logical process: create a PostgreSQL 16 database, migrate and seed it, produce a custom-format `pg_dump`, restore it into a clean database, and run `npm run verify:restore`. The verifier fails if migrations drift, append-only triggers are missing, hand events are discontinuous, table event chains are invalid, or any posted ledger transaction is imbalanced.

For a production-data disaster-recovery exercise, restore a provider snapshot to a separate service and run:

```bash
VERIFY_DATABASE_URL='postgresql://restored-database' npm run verify:restore
```

Never point the verifier's migration principal at an unapproved production clone. Record the snapshot time, verification output, recovery time, and reviewer. The safe-beta target is a tested restore under 30 minutes; real-value launch additionally requires point-in-time recovery and a one-minute-or-better RPO.

## Replicas and secrets

Run two API replicas in one Railway region for the beta. PostgreSQL optimistic versions, advisory locks, deterministic idempotency keys, Redis locks, and Redis fanout prevent either instance from becoming the authority by itself. The Pit Board should show two live heartbeats after a deployment settles.

`SAFE_BETA_SIGNING_KEY_PEM` must be stable across replicas and deployments. Store it as a Railway sealed variable, restrict project membership, and never copy it to the frontend, logs, repository, issue tracker, or chat. The runtime keeps the PEM server-side and public audit bundles contain only the verification key. Rotate only through an announced maintenance procedure because changing it breaks continuity for in-flight hands.

Sealed hosting variables protect management-plane display and accidental disclosure, but they are not an HSM boundary. Real-value release remains blocked until signing is moved to an independently reviewed KMS/HSM or attested dealer with separate principals, rotation, audit logging, and remote attestation.

## Moderation and privacy

Players can update a bounded public profile, inspect their own immutable hand history, download their audit bundle, and submit a categorized report. Hand history and audit authorization are based on the participant set committed in `HAND_OPENED`, not current table membership.

Moderators can search profiles, work the report queue, and change account status. Admins additionally manage beta invitations and operational incidents. Every decision is written to `safe_beta_moderation_events`; database triggers reject updates and deletes. Avoid putting secrets or unnecessary personal information in report notes.
