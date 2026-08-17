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

### Data integrity

- PostgreSQL hand events are append-only.
- Hand sequence, event hash and idempotency keys are unique per hand.
- Ledger amounts are integer atomic units (`numeric(78,0)`), never floating point.
- Ledger transactions must balance debit and credit per asset before posting.
- Posted ledger entries and transactions are immutable; corrections require reversal transactions.
- Settlement intents are idempotent and chain signatures are unique.
- Transactional outbox table supports reliable event publication.

### Release safety

- `REAL_VALUE_MODE` defaults to disabled.
- Readiness returns blocked when real-value mode is requested without every control.
- Release evidence is bound to an immutable 40-character Git commit.
- Audit/certification evidence has a provider, SHA-256 report digest, pass status and expiry.
- The full manifest must be signed by a separate Ed25519 release authority.
- TLS Postgres, TLS Redis, strict HTTPS origins, dedicated Solana RPC, identity, geofencing, monitoring and isolated dealer keys are mandatory.

## xStocks-specific invariants

Canonical mint addresses—not ticker strings—define the allowlist. On Solana, xStocks use Token-2022 and displayed balances require the current asset multiplier. The service must snapshot the mint, raw atomic quantity, decimals, multiplier value, multiplier timestamp/source, price timestamp/source and allowlist version for every buy-in and cash-out.

Prices are never used past a configured freshness limit. RFQ authorizations are never logged and expired authorizations are rejected. Settlement confirmation uses a dedicated Solana RPC and requires finalized policy appropriate to the risk; websocket notifications alone are not finality proof.

## Still required before money tables

The following are deliberately not represented as complete:

1. A fully tested poker rules engine covering betting rounds, all-ins, side pots, PLO “exactly two from hand,” split pots, rake caps, timeouts, reconnects, sit-out behavior and every room option.
2. An audited Solana escrow/settlement program and audited upgrade/governance controls.
3. Production implementations for encrypted hole-card delivery and dealer key isolation/remote attestation.
4. Frontend integration with Wallet Standard and the production API/realtime service.
5. xStocks integrator credentials and atomic RFQ integration.
6. KYC/age, sanctions, geofencing, responsible-gaming limits, self-exclusion and jurisdiction-specific reporting.
7. Independent application, cryptography and contract audits; penetration testing; RNG/game certification; and legal approval for each launch jurisdiction.
8. Load/soak/chaos testing, disaster-recovery exercises, on-call ownership, DDoS protection and a public incident process.

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
npm test
npm run audit
npm run test:beacon
```

`npm run test:beacon` performs a live signature-verified Quicknet fetch and is intentionally separate from deterministic CI tests. GitHub CI runs the unit tests plus real PostgreSQL 16 and Redis 7.4 adapter tests on Node 20 and Node 22.

## Safe-mode server

```bash
cp .env.example .env
npm start
curl http://127.0.0.1:8787/health/ready
```

Without signed release evidence, the response reports `safe-preview`. Setting `REAL_VALUE_MODE=enabled` without all gates changes readiness to HTTP 503; it does not enable money play.
