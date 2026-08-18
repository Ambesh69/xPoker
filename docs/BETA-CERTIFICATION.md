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

The proof-download route uses a signed synthetic hand-opening transcript. The cryptographic deck, Merkle proof, community-card, showdown, and complete audit-bundle behavior remains covered separately by the real deterministic dealer and rules tests.

## Concurrency and failure injection

`server/resilience-certification.integration.test.js` creates 16 tables, seats 64 generated wallets, and commits 80 authoritative commands concurrently. The baseline passes only when all commands finish within 20 seconds on the GitHub runner and every table can be reconstructed from its PostgreSQL event chain and snapshots.

It then verifies:

- A retry storm returns idempotent duplicates without appending more events.
- Two wallets racing for the same seat produce exactly one durable winner.
- A closed Redis publisher cannot roll back an already committed PostgreSQL event.
- A fresh coordinator reconstructs the event after transient fanout loss.

`server/safe-beta-dealer.test.js` also injects a drand-fetch outage after reservation. The hand remains `BEACON_RESERVED`, the table remains `WAITING`, and no deck root or dealer secret is committed.

## Running it

Provide empty test services, never production connection strings:

```bash
DATABASE_URL_TEST=postgresql://postgres:postgres@127.0.0.1:5432/xpoker_certification \
REDIS_URL_TEST=redis://127.0.0.1:6379 \
npm run test:certification
```

The normal `npm test` run executes these files on every push in the Node 20/22 PostgreSQL 16 and Redis 7.4 matrix. `.github/workflows/beta-certification.yml` repeats the focused certification weekly and on manual dispatch.

## Interpretation

A green run is a closed-beta software baseline, not permission to enable money play. It does not replace sustained target-traffic soak tests, network-level packet loss/latency tests, region evacuation, DDoS exercises, independent penetration testing, cryptography/RNG certification, contract audits, or regulatory approval. Those remain release gates.
