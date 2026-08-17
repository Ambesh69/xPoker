# xPoker authoritative realtime protocol

Status: production-candidate transport; real-value activation remains release-gated.

The static Vercel site is not authoritative. A long-lived game service owns table versions, validates actions, persists the append-only event stream in PostgreSQL, leases expired turns, and fans committed events across instances through Redis.

## Wallet session

All authentication requests require an exact allowlisted `Origin`; query strings and cookie authentication are not used.

1. `POST /v1/auth/challenge` with `{ "wallet": "<Solana public key>" }`.
2. Sign the returned domain/origin/nonce/expiry-bound message with the wallet.
3. `POST /v1/auth/verify` with `{ "id", "wallet", "signature" }`.
4. Keep the returned opaque bearer token in memory and send it as the first WebSocket message. Redis stores only its SHA-256 hash.
5. `POST /v1/auth/logout` with `Authorization: Bearer <token>` revokes it.

A challenge is one-time even when verification fails. Signing it proves wallet ownership only; the message explicitly does not authorize a transaction.

## WebSocket

Connect to `/v1/realtime` with subprotocol `xpoker.v1`, no query parameters, and an allowlisted browser `Origin`. Compression is disabled and payloads are capped.

The server sends `hello`. The client must then send:

```json
{
  "type": "authenticate",
  "requestId": "auth-unique-request-0001",
  "token": "<opaque session token>"
}
```

After `authenticated`, subscribe with the last durable sequence the client has applied:

```json
{
  "type": "subscribe",
  "requestId": "subscribe-table-0001",
  "tableId": "<uuid>",
  "afterVersion": 41
}
```

`table_snapshot` contains current public state plus committed events after that version. A default subscription is permitted only for a wallet seated at the table. Every subsequent `table_event` has a contiguous sequence and hash-chain link. Clients must stop and resubscribe on any gap; they must never guess the missing state.

Every community-card event and active-hand snapshot carries the exact deck position, card metadata, nonce, and Merkle branch. The authoritative table rejects a card unless its proof verifies against the pre-deal deck root and its position is the next position in the committed NLH/PLO4 deal map. Clients should perform the same verification before rendering the card.

Player commands are bound to the authenticated wallet server-side. A client-supplied player id is ignored:

```json
{
  "type": "command",
  "requestId": "action-request-000001",
  "command": "act",
  "tableId": "<uuid>",
  "expectedVersion": 42,
  "expectedBettingVersion": 8,
  "idempotencyKey": "wallet-generated-unique-key",
  "action": { "type": "raise", "to": "5000000" }
}
```

Supported player commands are `act`, `sit_out`, `return`, and `leave`. Atomic token amounts are decimal strings. The table version and betting version make stale actions fail closed; the idempotency key makes exact retries safe. `command_result` and the corresponding `table_event` may arrive in either order, so clients correlate by request id and event sequence.

The server enforces authentication timeout, heartbeat, per-connection message limits, maximum payload size, slow-client eviction, strict origin/subprotocol checks, and wallet-bound table authorization.

## Private cards

The authenticated client creates a fresh X25519 key pair for each WebSocket connection and sends:

```json
{
  "type": "key_exchange",
  "requestId": "private-key-request-001",
  "clientPublicKey": "<32-byte base64url X25519 public key>"
}
```

The server responds with its ephemeral public key. Hole-card payloads and their Merkle proofs are encrypted with a connection-specific key derived using X25519 and HKDF-SHA-256, then authenticated with AES-256-GCM. Authenticated data binds the ciphertext to the protocol, algorithm, wallet, table, hand, deck root, and card count. A reconnect creates a new key and a new envelope.

Plaintext private cards must come directly from the isolated dealer provider, must never enter table events, Redis pub/sub, ordinary logs, analytics, or browser persistence, and must be destroyed according to the audit-retention policy. The checked-in runtime accepts a private-card provider interface, but real-value release remains blocked until that provider runs in an independently reviewed attested dealer.

## Recovery and timers

PostgreSQL stores immutable, hash-chained table events and checksum-verified append-only snapshots. Snapshots accelerate replay but do not replace event auditability. Every active turn also updates an operational deadline row. Workers claim expired turns with `FOR UPDATE SKIP LOCKED`, a bounded lease, the hand id, and betting version; stale workers cannot time out a newer turn.

Redis pub/sub is only low-latency fanout. It is not the source of truth. If a publish is lost or an instance restarts, reconnect replay comes from PostgreSQL.

## Deployment order

1. Apply checksum-locked migrations with `npm run migrate` using a migration principal.
2. Start at least two game-service instances with TLS PostgreSQL and TLS Redis.
3. Point the frontend at the HTTPS/WSS service origin and allowlist the exact frontend origin.
4. Keep `REAL_VALUE_MODE=disabled` until every signed release gate passes.

The current public deployment is a preview: wallet and buy-in interactions do not move funds, the Vercel frontend does not operate the authoritative runtime, and the settlement candidate is not mainnet-authorized.
