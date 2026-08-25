import assert from "node:assert/strict";
import test from "node:test";

import {
  assertEligible,
  createCompliancePolicy,
  evaluateCompliance,
  policyConfigurationDigest,
} from "./policy.js";

const WALLET = "FU6tKVhjJc2cFZuk4pQ8V4cgA5TiD9YGUsnyDi21neYX";
const NOW = new Date("2026-08-25T12:00:00.000Z");

function policy(overrides = {}) {
  return createCompliancePolicy({
    version: "in-counsel-review-v1",
    policySha256: "ab".repeat(32),
    allowedCountries: ["CH"],
    minimumAge: 21,
    evidenceMaxAgeSeconds: 86_400,
    decisionTtlSeconds: 900,
    ...overrides,
  });
}

function evidence(kind, overrides = {}) {
  return {
    id: `${{ identity: 1, sanctions: 2, geolocation: 3, source_of_funds: 4, xstocks_eligibility: 5 }[kind]}0000000-0000-4000-8000-000000000000`,
    kind,
    status: "pass",
    countryCode: "CH",
    observedAt: kind === "geolocation" ? "2026-08-25T11:59:00.000Z" : "2026-08-25T11:55:00.000Z",
    expiresAt: "2026-08-26T11:55:00.000Z",
    minimumAgeMet: kind === "identity" ? true : undefined,
    verifiedMinimumAge: kind === "identity" ? 21 : undefined,
    usPerson: kind === "identity" ? false : undefined,
    sanctionsMatch: kind === "sanctions" ? false : undefined,
    pepMatch: kind === "sanctions" ? false : undefined,
    walletEligible: kind === "xstocks_eligibility" ? true : undefined,
    ...overrides,
  };
}

function allEvidence(overrides = {}) {
  return ["identity", "sanctions", "geolocation", "source_of_funds", "xstocks_eligibility"]
    .map((kind) => evidence(kind, overrides[kind]));
}

test("a fully current, counsel-allowlisted decision passes and is short-lived", () => {
  const configured = policy();
  const result = evaluateCompliance({
    policy: configured,
    wallet: WALLET,
    product: "deposit",
    evidence: allEvidence(),
    responsibleGaming: { dailyDepositLimitUsdMinor: "50000" },
    rollingDeposits: { dailyUsdMinor: "10000" },
    amountUsdMinor: "20000",
    now: NOW,
  });
  assert.equal(result.eligible, true);
  assert.deepEqual(result.reasonCodes, ["eligible"]);
  assert.equal(result.expiresAt, "2026-08-25T12:04:00.000Z");
  assert.match(policyConfigurationDigest(configured), /^[0-9a-f]{64}$/);
  assert.equal(assertEligible(result), result);
});

test("eligibility fails closed when evidence or the jurisdiction allowlist is missing", () => {
  const result = evaluateCompliance({
    policy: policy({ allowedCountries: [] }),
    wallet: WALLET,
    product: "withdrawal",
    evidence: [evidence("identity")],
    now: NOW,
  });
  assert.equal(result.eligible, false);
  assert.ok(result.reasonCodes.includes("launch_jurisdiction_unconfigured"));
  assert.ok(result.reasonCodes.includes("sanctions_missing"));
  assert.ok(result.reasonCodes.includes("location_unknown"));
  assert.throws(() => assertEligible(result), (error) => error.code === "real_value_ineligible");
});

test("issuer restrictions cannot be overridden by a launch policy", () => {
  assert.throws(() => policy({ allowedCountries: ["US"] }), /issuer-blocked/);
  const result = evaluateCompliance({
    policy: policy(),
    wallet: WALLET,
    product: "table_buy_in",
    evidence: allEvidence({ geolocation: { countryCode: "US" } }),
    now: NOW,
  });
  assert.equal(result.eligible, false);
  assert.ok(result.reasonCodes.includes("issuer_restricted_location"));
});

test("age, US-person, sanctions, PEP and xStocks wallet checks are independent blockers", () => {
  const result = evaluateCompliance({
    policy: policy(),
    wallet: WALLET,
    product: "real_value_poker",
    evidence: allEvidence({
      identity: { verifiedMinimumAge: 18, usPerson: true },
      sanctions: { sanctionsMatch: true, pepMatch: true },
      xstocks_eligibility: { walletEligible: false },
    }),
    now: NOW,
  });
  assert.equal(result.eligible, false);
  assert.ok(result.reasonCodes.includes("age_not_verified"));
  assert.ok(result.reasonCodes.includes("us_person_prohibited"));
  assert.ok(result.reasonCodes.includes("sanctions_not_clear"));
  assert.ok(result.reasonCodes.includes("pep_manual_review"));
  assert.ok(result.reasonCodes.includes("xstocks_wallet_not_eligible"));
});

test("stale evidence, self-exclusion and value-based deposit limits block deposits", () => {
  const result = evaluateCompliance({
    policy: policy(),
    wallet: WALLET,
    product: "deposit",
    evidence: allEvidence({ sanctions: { observedAt: "2026-08-20T00:00:00.000Z" } }),
    responsibleGaming: {
      selfExcludedUntil: "2026-09-01T00:00:00.000Z",
      dailyDepositLimitUsdMinor: "25000",
    },
    rollingDeposits: { dailyUsdMinor: "10000" },
    amountUsdMinor: "20000",
    now: NOW,
  });
  assert.equal(result.eligible, false);
  assert.ok(result.reasonCodes.includes("sanctions_stale"));
  assert.ok(result.reasonCodes.includes("self_excluded"));
  assert.ok(result.reasonCodes.includes("daily_deposit_limit"));
});

test("self-exclusion blocks play and deposits without blocking an otherwise lawful withdrawal", () => {
  const responsibleGaming = { selfExcludedUntil: "2026-09-01T00:00:00.000Z" };
  const withdrawal = evaluateCompliance({
    policy: policy(),
    wallet: WALLET,
    product: "withdrawal",
    evidence: allEvidence(),
    responsibleGaming,
    now: NOW,
  });
  assert.equal(withdrawal.eligible, true);
  const play = evaluateCompliance({
    policy: policy(),
    wallet: WALLET,
    product: "table_buy_in",
    evidence: allEvidence(),
    responsibleGaming,
    now: NOW,
  });
  assert.equal(play.eligible, false);
  assert.ok(play.reasonCodes.includes("self_excluded"));
});

test("geolocation is refreshed at real-value action time even when provider evidence has a longer expiry", () => {
  const result = evaluateCompliance({
    policy: policy(),
    wallet: WALLET,
    product: "table_buy_in",
    evidence: allEvidence({ geolocation: { observedAt: "2026-08-25T11:53:00.000Z" } }),
    now: NOW,
  });
  assert.equal(result.eligible, false);
  assert.ok(result.reasonCodes.includes("geolocation_stale"));
});
