# xPoker

A high-fidelity frontend prototype for public and private poker rooms with xStocks-denominated buy-ins.

## Run it

```bash
python3 -m http.server 4173
```

Then open `http://localhost:4173`.

No build step or dependencies are required.

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

The wallet and purchase steps are simulated. A production release needs:

1. A wallet adapter and signed wallet-ownership challenge.
2. Canonical mint/contract allowlisting by chain, never ticker-string matching.
3. xStocks multiplier-aware balances and oracle/RFQ price freshness checks.
4. An escrow or non-custodial game-settlement contract audited for NLH and PLO side pots, split pots, disconnects, and disputes.
5. Server-authoritative game state, verifiable shuffle/RNG, collusion controls, hand histories, and responsible-gaming limits.
6. xStocks integrator onboarding for the atomic RFQ flow. A quote returns a ready-to-execute EVM authorization or partially signed Solana transaction; the wallet must execute it before expiry.
7. Jurisdiction gating, age checks, KYC/AML where required, sanctions screening, gambling licensing analysis, securities/financial-promotion review, tax reporting, and geofencing. xStocks currently excludes several jurisdictions, including the U.S., U.K., Canada, and Australia.

All prices and balances in the prototype are intentionally marked as indicative/demo data.
