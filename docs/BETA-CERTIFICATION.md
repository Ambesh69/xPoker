# Closed-beta certification

This suite exercises the zero-value beta in a disposable, production-shaped environment. It never connects to the production database, consumes a live invitation, invokes a wallet transaction, or moves funds.

## Automated acceptance path

`server/beta-acceptance.integration.test.js` starts the real HTTP and WebSocket services against PostgreSQL and Redis, then verifies:

- Ed25519 Solana wallet challenge signing, one-time challenge use, Redis sessions, and origin binding.
- Closed-beta invitation denial, creation, two-player redemption, and access grants.
- The four permanent public rooms and their NLH, PLO4, ROE, ROE game mix.
- Private NLH, PLO4, and ROE room creation with zero-value table seating.
- Two wallets sharing one authoritative table shard.
- Authenticated WebSocket subscription, wallet-bound commands, disconnect, cursor replay, and recovered state.
- Profile editing, player reports, report resolution, suspension enforcement, and the operator overview.
- Participant-authorized hand history and downloadable audit responses.
- `fundsMove: false` throughout every player-facing value boundary.

`server/full-gameplay.integration.test.js` extends that path through the real dealer and verifies:

- Encrypted private-card delivery and client-side decryption for two-card NLH and four-card PLO4 hands.
- Complete preflop, flop, turn, river, showdown, rake, and stack-conservation lifecycles.
- Consecutive ROE hands rotating from NLH to PLO4 at the configured boundary.
- Mid-hand WebSocket replacement with PostgreSQL cursor replay before play continues.
- PostgreSQL timeout-lease claiming, automatic check/fold, exhausted time bank, and hand completion.
- Participant-authorized downloads of the real completed audit bundle, including deck and Merkle verification.

The shorter acceptance test retains a signed synthetic hand opening so authorization and operator paths remain isolated from gameplay failures. The full-gameplay test uses real deterministic decks and completed proofs.

## Concurrency and failure injection

`server/resilience-certification.integration.test.js` creates 16 tables, seats 64 generated wallets, and commits 80 authoritative commands concurrently. The baseline passes only when all commands finish within 20 seconds on the GitHub runner and every table can be reconstructed from its PostgreSQL event chain and snapshots.

It then verifies:

- A retry storm returns idempotent duplicates without appending more events.
- Two wallets racing for the same seat produce exactly one durable winner.
- A closed Redis publisher cannot roll back an already committed PostgreSQL event.
- A fresh coordinator reconstructs the event after transient fanout loss.

`server/safe-beta-dealer.test.js` also injects a drand-fetch outage after reservation. The hand remains `BEACON_RESERVED`, the table remains `WAITING`, and no deck root or dealer secret is committed.

`server/chaos-certification.integration.test.js` places TCP fault proxies between the application and both state services. It verifies:

- All Redis connections are severed, session access fails during the interruption, and the same session recovers after reconnect.
- A PostgreSQL table event committed during the Redis outage remains durable even though fanout fails.
- Ten PostgreSQL queries contend for a two-connection pool while bidirectional latency is injected; pressure and p95 latency must be observable and bounded.
- Removing the database delay restores the healthy query path.
- A complete HTTP/WebSocket replica is shut down, a fresh replica is built from PostgreSQL and Redis, the existing session reconnects, missed events replay, and a new command commits.

`server/soak-certification.integration.test.js` runs 16 tables concurrently for 30 seconds in the scheduled certification workflow. It continuously commits state transitions, requires zero command errors and a p95 below two seconds, then reconstructs every table and verifies every event hash chain. Duration, table count, and the p95 gate are configurable.

## Running it

Provide empty test services, never production connection strings:

```bash
DATABASE_URL_TEST=postgresql://postgres:postgres@127.0.0.1:5432/xpoker_certification \
REDIS_URL_TEST=redis://127.0.0.1:6379 \
npm run test:certification
```

Run the sustained profile locally with explicit bounds:

```bash
DATABASE_URL_TEST=postgresql://postgres:postgres@127.0.0.1:5432/xpoker_certification \
RUN_SOAK_CERTIFICATION=1 SOAK_DURATION_MS=30000 SOAK_TABLE_COUNT=16 \
npm run test:soak
```

The normal `npm test` run executes the E2E and bounded chaos files on every push in the Node 20/22 PostgreSQL 16 and Redis 7.4 matrix. Test files run serially because the stateful integration scenarios intentionally share those PostgreSQL and Redis services while exercising leases and fault injection; concurrency and load are generated inside the dedicated load and soak tests. `.github/workflows/beta-certification.yml` repeats the complete focused certification, including the 30-second soak, weekly and on manual dispatch.

## Interpretation

A green run is a closed-beta software baseline, not permission to enable money play. The automated profile covers bounded service interruption, latency, replica replacement, and sustained table traffic; it does not replace peak target-volume capacity planning, multi-region evacuation, DDoS exercises, independent penetration testing, cryptography/RNG certification, contract audits, or regulatory approval. Those remain release gates.
