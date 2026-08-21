# xPoker safe multiplayer beta

Status: zero-value multiplayer candidate. `REAL_VALUE_MODE` must remain disabled.

## Live safe-beta deployment

- Frontend: `https://xpoker.vercel.app`
- Authoritative API/WebSocket origin: `https://xpoker-api-production.up.railway.app`
- Runtime: Railway container with managed PostgreSQL and Redis on the project-private network
- Schema: migrations `001_core.sql` through `006_dealer_signing_keys.sql` run as a pre-deploy release step
- Health gate: `/health/ready` must confirm both authoritative dependencies before a deployment is promoted
- Operational gate: `/health/ops` must report healthy dependency latency, queues, clocks, table progress, drand reservations, HTTP errors, and realtime disconnects
- Value boundary: `REAL_VALUE_MODE=disabled`; the release-status endpoint deliberately reports the unfulfilled real-value gates

The browser is configured with the exact API origin. API CORS and WebSocket upgrades accept only `https://xpoker.vercel.app`.

The safe beta exercises the production-shaped wallet, room, table, dealer, reconnect, and audit paths without accepting a deposit or creating a token transaction. xStock symbols are table denominations only. All stacks are non-withdrawable demo credits in two-decimal atomic units.

## Safety boundary

- `safe_beta_profiles` and room memberships are separate from `ledger_accounts`, settlement intents, escrow sessions, and onchain claims.
- Demo asset identifiers are deterministic, disabled allowlist rows marked `safeBeta`, `nonTransferable`, and `indicative-demo`; they are not canonical token mints and cannot pass the real-value allowlist gate.
- Every safe-beta table session has status `preview`. It has no escrow program, vault, deposit signature, withdrawal, or cash-out route.
- Wallet authentication signs a domain/origin/nonce/expiry-bound message that explicitly authorizes no transaction.
- Guest identities are random 32-byte public-key-shaped identifiers with expiring Redis sessions. They cannot sign a transaction.
- A signed wallet may request a rate-limited, read-only Solana mainnet scan of the ten issuer-verified Token-2022 mints. The scan requests no wallet capability, applies the issuer's current Solana multiplier when available, and never affects demo-credit seating.
- The browser labels every balance, pot, rake result, and buy-in as simulated. Real xStock acquisition is not imitated by the beta.

## Control-plane API

All browser routes require an exact `Origin` in `ALLOWED_ORIGINS`. Authenticated routes use an opaque bearer token whose hash is stored in Redis.

- `GET /v1/beta/lobby` — public rooms, authorized private rooms, ten demo assets, and the caller's profile.
- `POST /v1/beta/demo-session` — issue a guest identity when safe-beta mode is enabled.
- `GET|POST /v1/beta/profile` — read or update a display name, short bio, and avatar style.
- `GET /v1/beta/wallet/holdings` — read the signed wallet's public Token-2022 accounts for the Core 10 mints; no transaction or wallet approval is created.
- `POST /v1/beta/invitations/redeem` — redeem a closed-beta access code; PostgreSQL stores only its SHA-256 digest.
- `POST /v1/beta/rooms` — create a private room with validated blinds, buy-ins, seats, rake, cap, clocks, and ROE rotation.
- `POST /v1/beta/rooms/join` — join by a one-time-displayed invite code; PostgreSQL stores only SHA-256.
- `POST /v1/beta/tables/join` — route a room and denomination to one preview table shard and seat the authenticated identity idempotently.
- `GET /v1/beta/hands` — return only hands whose immutable `HAND_OPENED` participant set includes the caller.
- `GET /v1/beta/hands/:handId/audit` — for a seated identity, reverify the completed hand's drand round and return its reconstruction bundle and signed transcript head.
- `GET /v1/beta/hands/:handId/audit/download` — download the same authorized bundle as JSON.
- `POST /v1/beta/reports` — report a player, hand, bug, or fairness concern to the moderation queue.

The four bootstrapped public rooms are Opening Bell (NLH), Four Cards (PLO 4), and two ROE rooms. Their minimum demo buy-in is $20.

## Dealer lifecycle

The safe-beta dealer uses the same deterministic fair-deal and table engines as the production candidate:

1. Freeze the active seat order and next deterministic hand id.
2. Generate server and per-player entropy, persist the preparation in Redis, and commit every value to the signed PostgreSQL hand transcript.
3. Reserve a future pinned drand Quicknet round. The round is unknown when all commitments are fixed.
4. Fetch and BLS-verify that exact round, derive the deck, and publish its Merkle root before dealing.
5. Encrypt each player's private cards and Merkle proofs to a fresh browser X25519 connection key with HKDF-SHA-256 and AES-256-GCM.
6. Reveal community cards only in the committed deal order and attach a proof for each position.
7. Reconstruct the deck at completion, derive showdown/rake results from it, and bind the result to the signed transcript head.
8. Allow a seated player to retrieve the post-hand bundle; the endpoint re-fetches and verifies the pinned drand round before returning it.

Redis locks serialize dealer progress across instances. PostgreSQL table and hand versions plus deterministic idempotency keys are the final concurrency boundary. Redis is not the table source of truth.

The beta currently generates player entropy on the server before the future beacon. That still prevents choosing a desired deck after the beacon is known, but production real-value play remains gated on independently reviewed entropy custody, selective-abort monitoring, key isolation, and external certification.

## Production-shaped deployment

Required environment:

```text
NODE_ENV=production
SAFE_BETA_MODE=enabled
REAL_VALUE_MODE=disabled
BETA_INVITE_REQUIRED=disabled
ADMIN_WALLETS=<comma-separated Solana public addresses>
PUBLIC_ORIGIN=https://<frontend>
ALLOWED_ORIGINS=https://<frontend>
DATABASE_URL=postgresql://...?...sslmode=verify-full
REDIS_URL=rediss://...
SAFE_BETA_SIGNING_KEY_PEM=<Ed25519 private key secret>
SOLANA_READ_RPC_URL=https://api.mainnet-beta.solana.com
XSTOCKS_API_BASE=https://api.xstocks.fi/api/v2
METRICS_BEARER_TOKEN=<random 32+ character secret>
# Optional external notification receiver:
ALERT_WEBHOOK_URL=https://<alert receiver>
ALERT_WEBHOOK_TOKEN=<sealed receiver secret>
```

For API-process key isolation, deploy `Dockerfile.signer` as a private service, move the existing PEM to its sealed `DEALER_SIGNING_KEY_PEM`, and configure the API with `DEALER_KEY_PROVIDER=remote-signer`, `DEALER_SIGNER_URL=http://<signer>.railway.internal:<port>`, and the same 32+ character token stored as `SIGNER_AUTH_TOKEN` on the signer and `DEALER_SIGNER_TOKEN` on the API. Remove `SAFE_BETA_SIGNING_KEY_PEM` from the API only after the signer public key ID matches the current transcript key and no hand is in flight. If the existing sealed key cannot be transferred and a controlled rotation is explicitly approved, first deploy migration `006_dealer_signing_keys.sql` under the old key. Runtime bootstrap records each public verification key and rejects a key change while any old-key hand is nonterminal. Proof downloads include the exact verification key and signed events used by that hand.

Apply migrations before starting the service:

```bash
npm ci
npm run migrate
npm start
```

The service needs a long-lived process with WebSocket support; the static Vercel frontend is not that process. Use TLS PostgreSQL, TLS Redis, and a container host that supports long-lived WebSockets. Put the API behind HTTPS/WSS, set the frontend `xpoker-api-origin` meta value to the exact API origin, and keep both origins exact—never `*`.

The repository includes a five-minute production smoke workflow, a monthly clean-database backup/restore drill, protected Prometheus metrics, operational probes, persisted redacted incidents, replica heartbeats, and an authenticated Pit Board for moderation. See [`BETA-OPERATIONS.md`](BETA-OPERATIONS.md) and [`INCIDENT-RESPONSE.md`](INCIDENT-RESPONSE.md) for setup, triage, and recovery. Managed database backups, point-in-time recovery, and a sealed stable Ed25519 secret still depend on the hosting plan and must be verified in the Railway dashboard. Free hosting tiers are suitable for testing availability, not for a production SLA.
