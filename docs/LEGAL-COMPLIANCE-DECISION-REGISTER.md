# Legal and compliance decision register

Status: engineering controls implemented; **no launch jurisdiction approved and no legal opinion obtained**.

This register is an engineering input for qualified counsel, not legal advice. Real-value mode must remain disabled until counsel signs a jurisdiction-specific opinion, the issuer approves the integration, and the resulting artifacts are hash-bound to the release manifest.

## Primary-source baseline

Reviewed 2026-08-25:

- xStocks describes the instruments as tracker certificates/securities issued by Backed's Jersey issuer and says distribution/licensing obligations vary by jurisdiction: <https://docs.xstocks.fi/docs/product-legal-overview>
- Primary issuance/redemption requires issuer onboarding, KYC/AML and whitelisted wallets: <https://docs.xstocks.fi/docs/issuance-and-redemption>
- The published primary-market flow has a USD 5,000 minimum, operates 24/5 around the U.S. equity market, and settles supported stablecoins only for approved clients/wallets: <https://docs.xstocks.fi/docs/issuance-and-redemption/market-flow>
- The issuer's restricted-country page prohibits U.S. persons and the listed prohibited/non-serviceable jurisdictions. It also says the United Kingdom is generally unavailable except for limited professional-client cases: <https://assets.backed.fi/legal-documentation/restricted-countries>
- Product legal documents and prospectus materials are maintained here: <https://assets.backed.fi/legal-documentation>

The application must re-check these sources and obtain issuer confirmation before every launch-country change. A static page review is not a substitute for a distribution agreement.

## Binding engineering decisions

| ID | Decision | Status | Release consequence |
|---|---|---|---|
| LC-001 | Wallet authentication proves control of a public key only. It is never treated as KYC, age, sanctions, residency, source-of-funds or xStocks eligibility. | Implemented | All five evidence classes must pass independently. |
| LC-002 | Launch countries are an explicit counsel-approved allowlist. The default allowlist is empty. | Implemented | Empty list denies every real-value request. |
| LC-003 | Issuer-prohibited/non-serviceable countries and occupied Ukrainian regions are a hard upper bound; an operator cannot override them by configuration. | Implemented | Configuration containing a hard-blocked country is rejected at startup. |
| LC-004 | U.S. person status must be explicitly false, not merely absent, and current physical location must also be allowed. | Implemented | Unknown/true U.S. status or unknown location denies. |
| LC-005 | Identity, sanctions/PEP, geolocation, source-of-funds and xStocks-wallet evidence must be current, provider-bound and unexpired. Provider outage/staleness fails closed. | Implemented | No grace-open path. |
| LC-006 | Raw identity documents, biometrics and IP addresses stay with approved providers. xPoker stores typed decisions, provider references and SHA-256 evidence digests only. | Implemented in schema/service | Provider contracts and retention schedules still required. |
| LC-007 | Self-exclusion and cooling-off override every commercial or operator decision. Deposit limits use a common USD-minor valuation snapshot, never incomparable token base units. | Implemented in policy/schema | Price source and responsible-gaming policy require review. |
| LC-008 | Direct issuance/redemption or atomic RFQ cannot be enabled with the public xStocks API alone. Written xStocks client/distributor approval and a private API credential are release gates. | Implemented as release gate | Purchase UI remains non-executable. |
| LC-009 | Real-value poker, tokenized-security distribution, custody, payments, financial promotion and tax/reporting are reviewed as separate regulated activities. | Counsel pending | One favorable analysis cannot silently authorize the others. |
| LC-010 | Every compliance policy and provider configuration is digest-pinned in the signed release manifest. | Implemented | Changing policy/provider configuration invalidates release eligibility. |

## Counsel questions required per proposed country

Counsel must answer in writing, with statutes/regulator guidance and scope assumptions:

1. Is the proposed peer-to-peer poker model permitted, licensed, monopolized or prohibited? How are rake, private rooms, public rooms and token-denominated stakes classified?
2. Which entity is operator, custodian, payment service provider, securities distributor, broker/venue, financial promoter and data controller/processor?
3. May retail users acquire, hold, stake and receive the relevant xStocks in that country? Are professional/qualified-investor restrictions required?
4. Does the custody/escrow design create client-money, safeguarding, trust, insolvency-remoteness, capital, insurance or audit obligations?
5. Which age threshold applies? Which approved age/KYC, sanctions, PEP, adverse-media and source-of-funds controls are required, and at what review frequency?
6. What geolocation accuracy, VPN/proxy detection, residency checks and travel rules are required? Which evidence must be retained for disputes/regulators?
7. Which responsible-gaming controls, self-exclusion registers, affordability checks, loss/deposit/session limits and cool-offs are mandatory?
8. What suspicious-activity, transaction-monitoring, Travel Rule, tax withholding/reporting, abandoned-property and regulator reporting applies?
9. What marketing, bonus, affiliate, financial-promotion and risk-warning rules apply on desktop/mobile and through private invitations?
10. What privacy, cross-border transfer, breach notification, retention/deletion and data-subject rights apply to compliance records?

## Required approval artifact

For each country, retain a PDF legal opinion containing the exact product/flow, entity, domains, program ID, custody model, assets, user class and date. Record its SHA-256 in `COMPLIANCE_POLICY_SHA256` and in the signed release manifest's regulatory evidence. Any material change requires a new opinion and release.

No country is approved by this repository. `COMPLIANCE_ALLOWED_COUNTRIES` must stay empty until the above is complete.
