# xPoker production-readiness specification

Status: **safe production candidate; real-value activation blocked**.

“Production grade” is a release process, not a code label. This repository now contains enforceable foundations, but it must not accept real-value buy-ins until every release gate passes and independent reviewers sign the exact build commit.

## Deployment topology

```text
Browser wallet
    |
    | HTTPS + signed wallet challenge
    v
Vercel frontend (no authoritative game state)
    |
    | authenticated API / realtime transport
    v
Dedicated game service -----------------> Redis (sessions, timers, locks, fanout)
    |                |
    |                +------------------> drand Quicknet (verified future round)
    |
    +-----------------------------------> PostgreSQL (hands, events, ledger, outbox)
    |
    +-----------------------------------> KMS/Vault or attested dealer
    |
    +-----------------------------------> Solana RPC + audited settlement program
    |
    +-----------------------------------> xStocks public API / onboarded xChange API
```

The Vercel deployment remains appropriate for static UI delivery. It is not the system of record for pots, hands, balances, timers, or settlement. The game service is a long-lived container close to its primary database, with at least two instances and no instance-local authority.

## Implemented controls

### Fair dealing

- 256-bit operating-system CSPRNG secrets and pre-hand commitments.
- Player entropy, server entropy, immutable rules and an external beacon mixed through HKDF-SHA-256.
- Pinned drand Quicknet chain hash and public key.
- Official `drand-client` with BLS verification forced on.
- Future round reservation after all player commitments; the operator cannot choose among completed rounds.
- Rejection-sampled Fisher–Yates shuffle and a fixed known-answer vector.
- Merkle commitment covering every card position before dealing.
- Exact public-card position proofs and deterministic NLH/PLO4 deal maps.
- Independent re-fetch/reverification at deck commitment.
- Ed25519-signed, hash-chained hand transcript.

### Authentication and replay protection

- Wallet ownership challenge bound to wallet, HTTPS origin, domain, expiry and one-time request id.
- Ed25519 signature verification against the 32-byte Solana public key.
- Atomic Redis `GETDEL` challenge consumption.
- Opaque 256-bit sessions stored only by SHA-256 hash and explicitly revocable.
- Per-hand optimistic versions and strong idempotency keys.
- Strict-origin `xpoker.v1` WebSockets with wallet-bound commands, reconnect cursors, payload/rate limits, heartbeat and slow-client eviction.
- Per-connection X25519/HKDF/AES-GCM private-card envelopes bound to wallet, table, hand and committed deck root.

### Data integrity

- PostgreSQL hand events are append-only.
- Hand sequence, event hash and idempotency keys are unique per hand.
- Ledger amounts are integer atomic units (`numeric(78,0)`), never floating point.
- Ledger transactions must balance debit and credit per asset before posting.
- Posted ledger entries and transactions are immutable; corrections require reversal transactions.
- Settlement intents are idempotent and chain signatures are unique.
- Transactional outbox table supports reliable event publication.
- Hash-chained table events and checksum-verified, append-only recovery snapshots.
- Cross-instance Redis pub/sub is treated only as transient fanout; reconnects replay from PostgreSQL.
- Checksum-locked, advisory-lock-serialized schema migrations reject altered migration history.

### Poker rules core

- Deterministic NLH and PLO4 betting with heads-up/multiway order, antes, a live straddle, timeouts and optimistic versions.
- Full/short all-in raise behavior, PLO pot-limit maxima and automatic runouts.
- NLH best-five and PLO exactly-two/exactly-three showdown evaluation.
- Side pots, unmatched refunds, one/two-board splits, deterministic odd chips, capped rake and no-flop-no-drop.
- Atomic-unit conservation assertions at pot, rake and payout boundaries.
- Event-sourced NLH/PLO4/ROE orchestration with deterministic button/game rotation, sit-out/return/leave behavior, action clocks, time-bank consumption and leased timeout recovery.
- Deterministic randomized testing covers 500 additional NLH/PLO4 hands for termination, version monotonicity and chip conservation.

### Settlement candidate

- Anchor Token Interface escrow with one canonical mint per table session.
- Raw `u64` credited deposits, session locks, delayed Merkle settlement claims and replay-resistant claim PDAs.
- Transcript-root anchoring, exact payout conservation, timeout refunds and two-step authority rotation.
- Node/Rust cross-language settlement vector and local Solana SBF build/load verification.
- Release gates pin the cluster, program address, SBF digest and upgrade authority.

This candidate is local/devnet-only. It has not been independently audited and its settlement authority remains trusted.

### Release safety

- `REAL_VALUE_MODE` defaults to disabled.
- Readiness returns blocked when real-value mode is requested without every control.
- Release evidence is bound to an immutable 40-character Git commit.
- Audit/certification evidence has a provider, SHA-256 report digest, pass status and expiry.
- The full manifest must be signed by a separate Ed25519 release authority.
- TLS Postgres, TLS Redis, strict HTTPS origins, dedicated Solana RPC, identity, geofencing, monitoring and isolated dealer keys are mandatory.

### Safe-beta operations

- Authenticated operator roles are stored in PostgreSQL; only configured admin public wallets can create access codes or resolve infrastructure incidents.
- The Pit Board shows live replica heartbeats, request volume, average latency, HTTP 5xx rate, active tables, reports, and deduplicated incidents.
- Incident context is bounded and recursively redacted before persistence; authorization, cookies, signatures, seeds, tokens, secrets, and private-key fields are never retained.
- Player suspension/bans and report decisions produce immutable append-only moderation events.
- Five-minute public smoke checks open one deduplicated GitHub incident and close it automatically after recovery.
- A scheduled monthly logical-backup drill restores into a clean PostgreSQL database and verifies current migrations, append-only triggers, transcript continuity, table chains, and ledger balance.
- A disposable closed-beta certification signs generated wallets, enforces invitations, completes NLH/PLO4/ROE hands and proofs, exercises reconnects and timeout leases, replaces an API replica, interrupts Redis, injects PostgreSQL latency/pool pressure, and runs 16 concurrent tables through a bounded soak plus retry, contention, and drand-outage checks.

## xStocks-specific invariants

Canonical mint addresses—not ticker strings—define the allowlist. On Solana, xStocks use Token-2022 and displayed balances require the current asset multiplier. The service must snapshot the mint, raw atomic quantity, decimals, multiplier value, multiplier timestamp/source, price timestamp/source and allowlist version for every buy-in and cash-out.

Prices are never used past a configured freshness limit. RFQ authorizations are never logged and expired authorizations are rejected. Settlement confirmation uses a dedicated Solana RPC and requires finalized policy appropriate to the risk; websocket notifications alone are not finality proof.

## Still required before money tables

The following are deliberately not represented as complete:

1. Complete frontend Wallet Standard/API integration; the transport, recovery, timers, ROE scheduling, encrypted envelopes and deterministic randomized tests are implemented.
2. Independent audit of the Solana escrow program plus an audited multisig/attestation, dispute watcher and upgrade/governance process.
3. Production attested-dealer wiring for the implemented encrypted hole-card transport, plus dealer key isolation/remote attestation.
4. Frontend integration with Wallet Standard and the production API/realtime service.
5. xStocks integrator credentials and atomic RFQ integration.
6. KYC/age, sanctions, geofencing, responsible-gaming limits, self-exclusion and jurisdiction-specific reporting.
7. Independent application, cryptography and contract audits; penetration testing; RNG/game certification; and legal approval for each launch jurisdiction.
8. Peak target-traffic capacity testing, multi-region evacuation, quarterly recovery exercises, on-call ownership, DDoS protection and a public incident process. The repository's bounded 16-table soak and TCP dependency-fault baseline is necessary but not a substitute for this prelaunch work.

## Operational acceptance targets

- No loss or duplication of confirmed ledger entries under retries or process termination.
- Recovery point objective for PostgreSQL: at most one minute, with point-in-time recovery tested quarterly.
- Recovery time objective: under 30 minutes, tested through restore—not assumed from backup existence.
- Every completed hand has a valid signed transcript; every abort schedules a refund and is monitored for outcome correlation.
- Alert on beacon verification failures, transcript discontinuities, ledger imbalance attempts, repeated aborts, stale xStocks data, settlement divergence, elevated authentication failures and geofence/identity-provider outages.
- Secrets rotate without downtime; dealer/release keys have separate principals and approval paths.

## Local verification

```bash
npm ci
npm run migrate
npm test
npm run test:certification
npm run audit
npm run test:beacon
```

`npm run test:beacon` performs a live signature-verified Quicknet fetch and is intentionally separate from deterministic CI tests. GitHub CI runs the unit tests plus real PostgreSQL 16 and Redis 7.4 adapter tests on Node 20 and Node 22. The focused closed-beta suite and its limits are documented in [`BETA-CERTIFICATION.md`](BETA-CERTIFICATION.md).

## Safe-mode server

```bash
cp .env.example .env
npm start
curl http://127.0.0.1:8787/health/ready
```

Without signed release evidence, the response reports `safe-preview`. Setting `REAL_VALUE_MODE=enabled` without all gates changes readiness to HTTP 503; it does not enable money play.

For the multiplayer safe beta, set `SAFE_BETA_MODE=enabled`, apply migration `005_beta_operations.sql`, and provide a stable Ed25519 `SAFE_BETA_SIGNING_KEY_PEM` as a sealed production secret. The beta automatically reserves future signature-verified drand rounds and exposes completed reconstruction bundles, but all value paths remain disabled. See [`SAFE-BETA.md`](SAFE-BETA.md) and [`BETA-OPERATIONS.md`](BETA-OPERATIONS.md).
