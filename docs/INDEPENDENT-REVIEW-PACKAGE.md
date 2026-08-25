# Independent review package index

This index defines the material to send to legal, application-security, cryptography/RNG, Solana-program, penetration-test and incident-response reviewers. It is not a passing review. Every reviewer must bind findings to the same full Git commit and, for the Anchor program, the exact SBF SHA-256.

## Review inputs

| Area | Primary files |
|---|---|
| Legal/compliance | `docs/LEGAL-COMPLIANCE-DECISION-REGISTER.md`, `server/compliance/policy.js`, `server/compliance/service.js`, `db/008_compliance_custody.sql` |
| xStocks/custody | `docs/XSTOCKS-CUSTODY-SETTLEMENT.md`, `server/settlement/custody.js`, `server/settlement/custody-service.js`, `server/settlement/solana-custody-chain.js` |
| Settlement program | `settlement/programs/xpoker_escrow/src/lib.rs`, `server/settlement/plan.js`, `server/settlement/merkle.js`, `docs/SETTLEMENT-PROTOCOL.md` |
| RNG/fair deal | `fairness/`, `server/beacon.js`, `server/hand-coordinator.js`, `docs/FAIR-DEAL-PROTOCOL.md` |
| Game correctness | `server/poker/`, `server/table-coordinator.js`, `docs/POKER-RULES-ENGINE.md` |
| Authentication/private cards | `server/wallet-auth.js`, `server/privy-auth.js`, `server/hole-card-crypto.js`, `server/realtime.js` |
| Operations/IR | `server/monitoring.js`, `server/timeout-worker.js`, `docs/INCIDENT-RESPONSE.md`, hosted incident-drill report |
| Release binding | `server/release-gates.js`, `server/release-manifest.js`, `.github/workflows/release-certification.yml` |

## Required reviewer deliverables

Each report must state scope, commit, binary/artifact digests, methodology, exclusions, severity rubric, findings, retest result, provider identity, issue/expiry dates and a SHA-256. Reports must be independently issued; self-authored tests are evidence inputs, not independent assurance.

Minimum scopes:

- Legal: each launch country, user class, entity and end-to-end funds flow.
- Cryptography/RNG: entropy commitments, drand trust, shuffle/rejection sampling, Merkle privacy, proof timing, key lifecycle and bias/abort attacks.
- Solana: all Anchor instructions/accounts/PDAs, Token-2022 extensions, authority/governance, refund/claim delays, conservation, CPI behavior and upgrade process.
- Application security: authentication, authorization, WebSocket isolation, private cards, idempotency, database/Redis races, PII, logging, dependencies and supply chain.
- Penetration: browser/API/WebSocket/provider/signer boundaries, two-wallet abuse, mobile wallet handoff and rate/DoS paths.
- Incident response: lost signer, compromised operator, RPC disagreement, provider outage, stalled tables, vault shortfall, bad release and rollback/communications.

## Reproducible checks

```bash
npm ci
npm test
npm run test:certification
npm run audit
npm run test:contract
npm run build:contract
npm run smoke:contract-runtime
sha256sum settlement/target/deploy/xpoker_escrow.so
```

Database-backed tests require disposable PostgreSQL 16 and Redis 7.4 via `DATABASE_URL_TEST` and `REDIS_URL_TEST`. The new compliance/custody integration test covers provider-bound evidence, a finalized deposit, actual-delta ledger credit, two-operator withdrawal, finalization, reconciliation and append-only evidence.

## Release decision

The independent review package is complete only when all reports are retained, their hashes and expiries are entered into the signed release manifest, every high/critical issue is fixed and retested, the live build/program hashes match, and `GET /v1/release/status` passes every gate. Until then the only acceptable mode is `safe-preview` and no funds move.
