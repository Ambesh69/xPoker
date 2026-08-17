# xPoker Fair Deal Protocol v1

Status: cryptographic foundation and test harness. Not yet authorized for real-value play.

## Cost boundary

The protocol code and local verification have no paid dependencies. A publicly accessible drand relay can also be queried without a usage charge, although production must verify its threshold signature and should not assume a free public endpoint provides a commercial SLA.

Production is not zero-cost:

- Posting hand/deck commitments or settlement checkpoints to Solana incurs network transaction fees.
- A remotely attested dealer requires compute. AWS does not charge an additional Nitro Enclaves fee, but the parent EC2 instance, storage, networking and KMS remain billable.
- Independent application-security, cryptography and smart-contract audits are paid professional work.
- RNG/game certification and jurisdiction-specific gambling approval are paid and usually quote-based.
- Monitoring, DDoS protection, incident response and immutable log retention require infrastructure.

## Threat model

v1 is designed to prevent the operator or a player from silently replacing a committed seed, changing rules after commitments, substituting a community card, duplicating/removing cards, or presenting different committed deck positions as the same hand.

v1 does not, by itself, prevent an ordinary application server from learning the completed deck. The production dealer must run in an attested enclave or be replaced by the multi-party encrypted shuffle described under “v2 target.” v1 also does not solve collusion, hole-card sharing, bots, compromised clients, traffic analysis or denial-of-service.

## Pre-hand sequence

1. Create an immutable hand id, participant list, button position and rules document.
2. The dealer generates a 256-bit server seed from the operating system CSPRNG and publishes `serverCommitment`.
3. Every seated wallet generates a 256-bit seed and publishes a player commitment.
4. Freeze participants and inputs. A missing reveal follows a predetermined timeout/refund rule; the operator cannot request a replacement beacon because it dislikes an outcome.
5. Request a future externally verifiable randomness round. The production adapter may use Switchboard on Solana or a verified drand Quicknet round.
6. Reveal committed player entropy to the attested dealer.
7. Derive the hand seed with HKDF-SHA-256 over the server seed, beacon randomness, sorted player inputs, hand id and rules hash.
8. Shuffle the canonical 52-card deck using an HMAC-SHA-256 byte stream and Fisher–Yates. Index selection uses rejection sampling to remove modulo bias.
9. Give every card position a deterministic 256-bit nonce and commit all 52 `(position, card, nonce)` leaves in a Merkle tree.
10. Publish the Merkle root before the first hole card leaves the dealer.

The public commitment record must be signed by the dealer’s attested key and either posted directly onchain or entered into an append-only transparency log whose root is regularly anchored onchain.

## Dealing

The deck is shuffled once per hand. Flop, turn and river do not receive fresh randomness.

- NLH: two dealing rounds in active seat order.
- PLO 4: four dealing rounds in active seat order.
- Each board street consumes a committed burn position followed by its committed public card positions.
- Every revealed public card includes its nonce and Merkle branch.
- Hole-card payloads are encrypted to short-lived player session keys and must never be placed in ordinary application logs.

For heads-up play, the button/small blind receives the first card. At tables with three or more players, dealing starts left of the button.

## Run it twice and rabbit hunting

The choice to run twice never creates a new shuffle. Once all-in consent is final, the remaining committed deck is consumed using the public `xpoker-standard/v1` map:

- Each board receives its own burn before each remaining street.
- Board one consumes its complete remaining runout first, followed by board two.
- The decision, current street and exact positional map become part of the signed hand transcript.
- Rabbit hunting only reveals the next positions the original single-board map would have consumed.

Changing the allocation order requires a new protocol version and rules hash.

## Verification

During a hand, clients can verify that every public card belongs to the pre-hand Merkle root. After the configured privacy delay, the audit bundle reveals the server and player seeds. Anyone can then:

1. Verify every seed commitment.
2. Verify the external beacon signature and round using the beacon’s official client library.
3. Recalculate the rules hash and hand seed.
4. Recreate all 52 cards and nonces.
5. Recalculate the Merkle root.
6. Verify that every dealt/revealed position matches the transcript.

The reference verifier deliberately returns `ok: false` when only the local reconstruction passes. It returns `localChecksPassed: true`, but a production adapter must independently verify the beacon signature and explicitly supply that result before the overall result can be accepted.

Revealing v1 seeds also reveals mucked cards. For that reason, production may release full audit bundles after a table/session delay rather than immediately. A zero-knowledge proof system is required to prove the shuffle without eventually exposing mucked cards.

## Abort handling

Selective aborts can bias a system even when the RNG is sound. Therefore:

- Randomness requests cannot be cancelled or replaced.
- A hand id can have exactly one beacon round and one deck root.
- If the dealer fails after commitments, all blinds/bets are automatically refunded.
- Every abort is recorded in the transparency log and monitored for correlation with reconstructed outcomes.
- A production operator bond/slashing rule or independent threshold dealers should make selective aborts economically irrational.

## v2 target: no “god view”

The strongest design is an encrypted mental-poker protocol:

- Each participant re-encrypts and permutes the deck.
- A zero-knowledge proof shows that each output is a valid permutation of the prior encrypted deck.
- Cards are threshold-decrypted only for the entitled player or when a board position becomes public.
- If at least one shuffler is honest, neither xPoker nor any individual player can select or know the undealt deck.

This should be based on a peer-reviewed construction and implemented or reviewed by specialist cryptographers. Research prototypes are not a substitute for a production audit.

## Release gates

Real-value tables stay disabled until all gates pass:

- External beacon signature verification is implemented—not merely fetched.
- Dealer key isolation and remote attestation are validated by clients.
- Server, client and settlement contracts have independent security audits.
- Deterministic known-answer tests, property tests, restart/replay tests and statistical testing pass.
- Selective abort, disconnect, reconnect and side-pot behavior is specified and tested.
- RNG/game certification and gambling/legal approvals are obtained for launch jurisdictions.
