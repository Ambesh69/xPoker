# Token-2022 escrow and settlement protocol

Status: local/devnet engineering candidate; **not audited, not deployed, and not approved for real value**.

The Anchor program is under `settlement/programs/xpoker_escrow`. Its current declared program address is `14dia6Spfd6qu6Q36caisExYQsLA9si4PqFpqfiQ8Z9S`. The deployment keypair is intentionally ignored by Git and must be held in the deployment secret store.

## Session model

Each table session fixes one canonical mint and token program. Mixing different xStocks in one game is not supported: tokens with different mints are not fungible, and a price conversion during a poker hand would add oracle, slippage and insolvency risk.

```text
Open --authority--> Locked --commit root--> Settling --players--> Closed
  |                     |                      |
  +------ refund timeout+------ cancel before claim window
                            v
                        Refunding --players--> Closed
```

The program supports:

- A session PDA and program-controlled token vault PDA.
- Token Interface accounts, including Token-2022.
- Deposits in raw `u64` base units; the credited vault delta is recorded after CPI.
- An authority lock before play/settlement.
- A settlement root and independent signed-transcript root committed on-chain.
- A bounded claim delay of 9,000–216,000 slots, leaving an external audit/dispute window without allowing an unbounded authority lock.
- Domain-separated, sorted-pair SHA-256 Merkle payout proofs.
- One claim PDA per player, preventing replay/double claim.
- Exact equality between total payout and total credited deposits.
- Authority-triggered cancellation before claims, plus permissionless timeout refunds while open/locked.
- Per-player pull refunds and vault/session closure only after every base unit is released.
- Two-step authority rotation while the session is still open.
- A maximum 1,512,000-slot refund horizon and a safe final sweep of untracked direct vault donations only after all accounted obligations are released.

The Node adapter in `server/settlement/` constructs the same leaves and proofs. A fixed cross-language vector locks the Node and Rust implementations to the same root.

## xStocks amount handling

The contract never accepts dollars, prices or JavaScript numbers. It transfers raw token base units with `transfer_checked`. Token-2022 Scaled UI Amount changes display conversion, not the raw amount; multiplier and price snapshots belong in the off-chain audit record and cannot change the units held by the vault.

For production, the canonical mint allowlist must also define which Token-2022 extensions are supported. Transfer-hook, transfer-fee, confidential-transfer or future extensions require explicit audit and client/account support. The v1 adapter rejects every token program except Token-2022, and the release manifest pins the exact program binary hash.

The devnet custody control plane in `server/settlement/custody-service.js` and `server/settlement/solana-custody-chain.js` separately validates finalized raw-unit deposits and withdrawals, source/destination ownership, the pinned mint profile, two-person approval, cooling-off, idempotency and reconciliation. It deliberately rejects transfer-fee, transfer-hook, permanent-delegate, confidential-transfer and unknown extensions until each is explicitly designed and audited. See [`XSTOCKS-CUSTODY-SETTLEMENT.md`](XSTOCKS-CUSTODY-SETTLEMENT.md) for the operating state machines and remaining mainnet gates.

## Trust boundary

The program proves custody rules, claim inclusion, replay protection and conservation. It does **not** independently replay poker hands or prove that the settlement authority chose the correct winners. Before value activation, the authority must be replaced with an audited governance design (for example a time-locked multisig or independently attested settlement quorum), and clients/watchers must verify the transcript and proposed root during the claim delay.

## Local verification

```bash
cd settlement
cargo test --workspace
anchor build --ignore-keys
cd ..
npm run smoke:contract-runtime
```

Local compilation costs nothing. Devnet normally uses faucet SOL with no real monetary value, subject to faucet availability. Mainnet deployment, rent, transactions, dedicated RPC, audits, monitoring and compliance do have real costs.

Do not deploy this program to mainnet or send real xStocks until the settlement audit, application/cryptography audits, penetration test, governance review, incident drill and jurisdictional approvals are all bound to the exact Git commit and SBF binary digest by the signed release manifest.
