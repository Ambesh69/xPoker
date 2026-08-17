# Security policy

## Reporting

Do not open a public issue for a suspected vulnerability. Until a dedicated security mailbox and bug-bounty platform are configured, contact the repository owner privately through the verified contact attached to the GitHub account.

Do not test with real funds, mainnet transactions, other users' wallets, denial of service, social engineering, or data exfiltration. The deployed site is a preview and real-value mode is disabled.

## Supported releases

Only the current `main` commit is supported. A production release must identify an immutable Git commit and container digest in its signed release evidence.

## Security invariants

- Real-value mode must fail closed when any release gate is missing or expired.
- Dealer keys must be held in KMS, Vault, HSM, or an attested enclave; plaintext environment keys are not accepted for real-value mode.
- Wallet challenges and sessions are single-use/revocable and stored by hash.
- Hand events and ledger entries are append-only after posting.
- Monetary quantities use integer atomic units—never floating-point values.
- A randomness response is accepted only after verification against the pinned drand Quicknet chain hash and public key.
- Logs must never contain wallet signatures, session tokens, player seeds, hole cards, private keys, RFQ authorizations, or unredacted identity data.
