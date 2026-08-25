# xStocks custody and settlement design

Status: devnet engineering candidate; **mainnet, real funds, issuer purchase flows and withdrawal signing are disabled**.

## Invariants

1. Assets are identified by canonical mint and Token-2022 program, never by ticker text.
2. The allowlist binds cluster, mint, decimals, exact Token-2022 mint-configuration digest, supported extensions and version.
3. xStocks Scaled UI Amount affects display only. Deposits, stacks, pots, ledger entries, settlement roots and withdrawals use raw integer base units.
4. A deposit is credited only after finality and only for the observed vault balance increase. Signature, instruction index and operation are unique.
5. A withdrawal reserves available player liability, requires two or more distinct active operators, observes a cooling-off period, uses an HSM/multisig submitter, and posts the ledger only after exact finality.
6. Every posted ledger transaction balances per asset. Posted entries and chain observations are append-only.
7. Reconciliation compares finalized vault balance with player plus table-escrow liabilities. Any shortfall freezes the vault and emits a critical outbox event.
8. Mainnet methods throw unless the complete signed release-gate result explicitly authorizes mainnet.

## Implemented flow

```text
approved wallet + current compliance evidence
                |
                v
       create deposit intent
       (mint/profile/account/price pinned)
                |
          wallet transfers
                |
                v
 finalized Solana tx with exactly one Token-2022 transfer
                |
     verify source owner + vault + mint + deltas
                |
                v
 append chain observation + balanced ledger credit (one DB tx)
                |
       player liability available
                |
                +------------------------------+
                |                              |
        audited table escrow             withdrawal hold
        + Merkle settlement              + compliance recheck
                                               |
                                      independent quorum + cool-off
                                               |
                                      HSM/multisig submission
                                               |
                                      exact finalized transfer
                                               |
                                      balanced ledger debit
```

The checked-in Anchor escrow program separately provides raw-delta deposits, session locking, transcript-bound Merkle settlement, delayed pull claims and timeout refunds. It conserves all credited raw units. The off-chain custody service does not replace or weaken those contract invariants.

## Token-2022 extension policy

Solana Token-2022 extensions can materially change transfer behavior. The current engineering candidate accepts only:

- Scaled UI Amount
- Metadata Pointer
- Token Metadata

Transfer Fee, Transfer Hook, Permanent Delegate, Confidential Transfer, Default Account State, Non-transferable and every unknown extension fail closed until an independent contract/client audit explicitly supports them. The live mint configuration is re-read and compared to its pinned SHA-256 before each new intent.

Relevant Solana documentation:

- Token extensions: <https://solana.com/docs/tokens/extensions>
- Scaled UI Amount: <https://solana.com/docs/tokens/extensions/scaled-ui-amount/integration-guide>
- Transfer fees and withheld amounts: <https://solana.com/docs/tokens/extensions/transfer-fees>
- Transfer-hook extra-account requirements: <https://solana.com/docs/tokens/extensions/transfer-hook-integration>

## Transaction-observation rules

The RPC adapter requests `finalized` data, checks signature status and transaction meta, permits exactly one parsed Token-2022 transfer, and derives raw source/destination deltas from pre/post token balances. It rejects ambiguous multi-transfer transactions, wrong cluster/mint/program/owners/accounts, failed or non-finalized transactions, non-positive deltas and mismatched amounts.

Production should use at least two independent RPC providers and compare finalized observations. The current adapter is a single-provider implementation and therefore remains a release blocker until that quorum/failover work and provider SLAs are reviewed.

## xStocks partner boundary

Read-only public asset/multiplier endpoints are not authorization to issue, redeem, distribute or execute RFQs. Production purchase flows require:

- written xStocks/issuer onboarding and distribution approval;
- KYC/AML and whitelisted operational wallets accepted by the issuer;
- approved issuance/redemption/RFQ API credentials;
- legal approval for each user class and jurisdiction;
- quote-expiry, slippage, stablecoin, corporate-action and market-hours handling;
- an independently reviewed transaction builder that simulates every Token-2022 transfer before signature.

Until those exist, `XSTOCKS_CLIENT_APPROVAL_SHA256` and the private API key remain absent, so `xstocks_client_approved` fails.

## Threat model and residual blockers

| Threat | Implemented control | Still required |
|---|---|---|
| Ticker/mint substitution | Canonical mint + cluster + Token-2022 checks | Independent allowlist governance/signatures |
| Mutable mint behavior | Re-inspection and pinned configuration digest | Review actual Core 10 mint authorities/extensions |
| Fake or forked deposit | Finalized signature + owner/account/delta verification | Dual-RPC observation and reorg runbook |
| Duplicate credit | Unique signature/instruction, operation and ledger idempotency | Production concurrency/chaos certification |
| Withdrawal theft | Destination ownership, compliance recheck, quorum, cool-off | HSM/multisig signer implementation and key ceremony |
| Insider collusion | Distinct approvals and append-only evidence | Organizational separation, SIEM and periodic access review |
| Ledger/vault divergence | Per-asset balanced ledger and automatic freeze on shortfall | Continuous reconciler, pager and custodial accounting review |
| Price/multiplier manipulation | Raw units never depend on price/multiplier | Dual price/oracle sources for USD limits and RFQ display |
| Incorrect game result | Transcript-bound Merkle settlement and claim delay | Independent poker/RNG/contract audit and active dispute watcher |
| Provider outage | Fail closed | Redundant providers and customer-support process |

## Mainnet activation checklist

Mainnet remains prohibited until all are complete:

- launch-country legal opinion and regulatory approval evidence;
- xStocks written client/distributor approval;
- actual mint/extension and corporate-action review for every allowlisted asset;
- audited HSM/multisig withdrawal and settlement authority;
- independent application, penetration, cryptography/RNG and Anchor-program audits;
- dual-RPC observation, continuous reconciliation and shortfall drill;
- full devnet deposit, table, claim/refund, withdrawal and recovery acceptance with two wallets;
- signed release manifest matching policy, providers, custody controls, program binary and exact Git commit.
