# xPoker

A safe multiplayer beta candidate for public and private poker rooms with xStocks-denominated demo buy-ins.

## Run it

```bash
python3 -m http.server 4173
```

Then open `http://localhost:4173`.

No frontend build step is required. Without the authoritative API, the site remains an explicitly labeled interface preview.

## Safe multiplayer beta

The current client and server now provide real Solana wallet challenge signing, expiring guest sessions, four permanent public rooms, hashed-invite private rooms, closed-beta access codes, player profiles, hand history and proof downloads, player reporting/moderation, an operator dashboard, idempotent table seating, authenticated WebSocket reconnects, encrypted private cards, automatic NLH/PLO 4/ROE hands using a future verified drand round, and post-hand audit retrieval. Demo credits are isolated from the real-value ledger and have no deposit, withdrawal, escrow, settlement, or cash-out path.

Run the complete service with PostgreSQL and Redis after copying `.env.example`:

```bash
npm ci
npm run migrate
npm start
```

Then serve the frontend at `PUBLIC_ORIGIN`. See [`docs/SAFE-BETA.md`](docs/SAFE-BETA.md) for the API, fairness lifecycle, security boundary, and deployment requirements, and [`docs/BETA-OPERATIONS.md`](docs/BETA-OPERATIONS.md) for alerts, backups, restore drills, replicas, and moderation.

## Fair-deal foundation

The repository now includes a dependency-free cryptographic fair-deal protocol and test harness under `fairness/`. It provides:

- 256-bit server and player seed commitments.
- HKDF-SHA-256 hand-seed derivation with an external beacon input.
- Deterministic Fisher–Yates shuffling with rejection sampling.
- A pre-deal Merkle commitment covering all 52 card positions.
- Position proofs for community-card reveals.
- NLH, PLO 4 and run-it-twice dealing maps.
- Post-hand audit bundles that detect altered seeds, rules, beacons and deck roots.

Run it with:

```bash
npm test
npm run fairness:demo
```

This is a protocol foundation, not authorization for real-value play. The repository includes a signature-verifying beacon adapter, but production deployment of that adapter, attested key isolation, immutable external commitments, independent audits and regulatory certification remain release gates. See [`docs/FAIR-DEAL-PROTOCOL.md`](docs/FAIR-DEAL-PROTOCOL.md).

## Production safety foundation

The repository also contains a fail-closed backend candidate under `server/` and `db/`:

- Signature-verified, future-round drand Quicknet integration with pinned trust roots.
- Ed25519-signed, hash-chained hand transcripts.
- Domain-bound, expiring, one-time Solana wallet challenges and hashed sessions.
- An authoritative, versioned and idempotent fairness coordinator.
- A deterministic NLH/PLO4 rules core covering betting, all-ins, PLO pot limits, showdown, side pots, two boards, odd chips and rake.
- An event-sourced NLH/PLO4/ROE table coordinator with reconnect replay, sit-out/return/leave semantics, action clocks, time banks and leased timeout workers.
- An authenticated WebSocket protocol with strict origin checks, wallet-bound commands, rate/size limits and cross-instance Redis fanout.
- Connection-bound X25519/HKDF/AES-GCM hole-card envelopes containing private Merkle proofs; plaintext delivery still requires the release-gated isolated dealer.
- A locally compiled Token-2022 escrow candidate with Merkle pull-claims and timeout refunds; it is devnet-only until audited.
- Durable PostgreSQL and Redis adapters, checksum-locked migrations, hash-chained table events and append-only recovery snapshots.
- Append-only hand events and a per-asset balanced atomic-unit ledger schema.
- A separately signed release manifest that keeps real-value mode disabled until every audit, certification, infrastructure and regulatory gate is valid.
- GitHub CI across Node 20/22 with live PostgreSQL 16 and Redis 7.4 integration tests, plus a weekly zero-value acceptance/concurrency/failure-injection certification.

Run deterministic checks with `npm test`, the focused zero-value baseline with `npm run test:certification`, dependency checks with `npm run audit`, and a live verified beacon smoke test with `npm run test:beacon`. The current Vercel deployment remains a safe frontend preview; it is not an authoritative game server and no funds move. See [`docs/BETA-CERTIFICATION.md`](docs/BETA-CERTIFICATION.md), [`docs/POKER-RULES-ENGINE.md`](docs/POKER-RULES-ENGINE.md), [`docs/REALTIME-PROTOCOL.md`](docs/REALTIME-PROTOCOL.md), [`docs/SETTLEMENT-PROTOCOL.md`](docs/SETTLEMENT-PROTOCOL.md), and [`docs/PRODUCTION-READINESS.md`](docs/PRODUCTION-READINESS.md).

The contract checks are `npm run test:contract`, `npm run build:contract`, and `npm run smoke:contract-runtime`; they require Rust, Solana CLI 3.x and Anchor CLI 1.0.0. CI runs all three in the official version-pinned Anchor 1.0.0 image.

## Included flows

- Four permanent $20-minimum public tables: NLH, PLO 4, and two round-of-each tables.
- Private room creation with NLH/PLO 4/ROE, blinds, seats, min/max buy-ins, rake and cap, action clock, time bank, host approvals, queue, straddle, run-it-twice, rabbit hunt, and anonymous seating controls.
- Wallet connection prototype for Phantom, Backpack, and WalletConnect.
- xStock balance view, asset-based buy-in selection, quantity preview, and table seating.
- One-screen xStock purchase/RFQ concept with USDC payment.
- Playable table UI with fold, call, and raise interactions.
- Responsive desktop and mobile layouts, keyboard focus states, reduced-motion support, and persistent demo private rooms.

## Launch asset allowlist

The prototype uses this ten-asset launch set:

`AAPLx`, `NVDAx`, `MSFTx`, `AMZNx`, `GOOGLx`, `METAx`, `TSLAx`, `NFLXx`, `SPYx`, `QQQx`.

This is a product allowlist, not a claim that xStocks publishes an official top-ten volume ranking. The public xStocks site does not expose a ranked volume table. The set is based on recognizable, high-demand names and matches the compact ten-product basket used in a 2026 xStocks partner rollout. Before launch, replace this static set with an allowlist job ranked by executable onchain liquidity, RFQ availability, oracle freshness, holder concentration, and chain-specific token availability.

## Production integration boundaries

Real token ownership, purchase, escrow, and settlement remain disabled. A real-value production release needs:

1. A wallet adapter and signed wallet-ownership challenge.
2. Canonical mint/contract allowlisting by chain, never ticker-string matching.
3. xStocks multiplier-aware balances and oracle/RFQ price freshness checks.
4. An escrow or non-custodial game-settlement contract audited for NLH and PLO side pots, split pots, disconnects, and disputes.
5. Production wiring for the server-authoritative candidate plus collusion controls, hand-history UX, load/chaos testing, and responsible-gaming limits.
6. xStocks integrator onboarding for the atomic RFQ flow. A quote returns a ready-to-execute EVM authorization or partially signed Solana transaction; the wallet must execute it before expiry.
7. Jurisdiction gating, age checks, KYC/AML where required, sanctions screening, gambling licensing analysis, securities/financial-promotion review, tax reporting, and geofencing. xStocks currently excludes several jurisdictions, including the U.S., U.K., Canada, and Australia.

All prices and balances in the prototype are intentionally marked as indicative/demo data.

A production table is single-mint: all seats and all pots in that table session use the same canonical xStock mint. Public “rooms” can route players into separate table shards for each eligible asset, preserving the four-room UX without creating cross-mint pots.
