import { createHash } from "node:crypto";

import { canonicalJson } from "../../fairness/protocol.js";

export const COMPLIANCE_POLICY_VERSION = "xpoker-compliance-policy/v1";

// These are issuer-level prohibitions/non-serviceable jurisdictions published
// for xStocks. A counsel-approved launch allowlist may be narrower, never wider.
export const XSTOCKS_HARD_BLOCKED_COUNTRIES = Object.freeze(new Set([
  "AF", "BY", "CF", "CD", "CU", "ET", "GB", "HT", "IQ", "IR", "KP", "LB",
  "LY", "ML", "MM", "MZ", "NG", "NI", "PH", "RU", "SD", "SO", "SS", "SY",
  "US", "VE", "YE", "ZW",
]));

// xStocks also blocks occupied regions of Ukraine. This conservative set must
// be reviewed whenever the issuer's restricted-country page changes.
export const XSTOCKS_HARD_BLOCKED_REGIONS = Object.freeze(new Set([
  "UA-09", // Luhansk
  "UA-14", // Donetsk
  "UA-23", // Zaporizhzhia
  "UA-43", // Crimea
  "UA-65", // Kherson
]));

const PRODUCTS = new Set([
  "real_value_poker",
  "deposit",
  "withdrawal",
  "table_buy_in",
  "xstocks_primary_market",
  "xstocks_secondary_transfer",
]);

const REQUIRED_EVIDENCE = Object.freeze([
  "identity",
  "sanctions",
  "geolocation",
  "source_of_funds",
  "xstocks_eligibility",
]);

const EVIDENCE_MAX_AGE_CAP_SECONDS = Object.freeze({
  geolocation: 300,
  sanctions: 86_400,
  xstocks_eligibility: 86_400,
});

function fail(message) {
  throw new Error(message);
}

function country(value, label = "country") {
  if (typeof value !== "string" || !/^[A-Za-z]{2}$/.test(value)) fail(`${label} must be an ISO 3166-1 alpha-2 code`);
  return value.toUpperCase();
}

function region(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !/^[A-Za-z]{2}-[A-Za-z0-9]{1,3}$/.test(value)) {
    fail("region must be an ISO 3166-2 code");
  }
  return value.toUpperCase();
}

function positiveInteger(value, label, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    fail(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function hex32(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/i.test(value) || /^0{64}$/i.test(value)) {
    fail(`${label} must be a nonzero 32-byte hex digest`);
  }
  return value.toLowerCase();
}

function instant(value, label) {
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(timestamp)) fail(`${label} must be a valid timestamp`);
  return timestamp;
}

function atomic(value, label) {
  if (value === undefined || value === null) return undefined;
  try {
    const parsed = BigInt(value);
    if (parsed < 0n || parsed > 18_446_744_073_709_551_615n) throw new Error();
    return parsed;
  } catch {
    fail(`${label} must be an unsigned 64-bit integer`);
  }
}

export function createCompliancePolicy({
  version,
  policySha256,
  allowedCountries = [],
  minimumAge,
  evidenceMaxAgeSeconds = 86_400,
  decisionTtlSeconds = 900,
  requireQualifiedInvestor = false,
} = {}) {
  if (typeof version !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(version)) {
    fail("Compliance policy version is invalid");
  }
  const normalizedCountries = [...new Set(allowedCountries.map((value) => country(value, "allowed country")))].sort();
  if (normalizedCountries.some((value) => XSTOCKS_HARD_BLOCKED_COUNTRIES.has(value))) {
    fail("Compliance launch allowlist includes an issuer-blocked jurisdiction");
  }
  const normalized = {
    schema: COMPLIANCE_POLICY_VERSION,
    version,
    policySha256: hex32(policySha256, "Compliance policy digest"),
    allowedCountries: normalizedCountries,
    minimumAge: positiveInteger(minimumAge, "Compliance minimum age", 18, 25),
    evidenceMaxAgeSeconds: positiveInteger(evidenceMaxAgeSeconds, "Evidence maximum age", 300, 2_592_000),
    decisionTtlSeconds: positiveInteger(decisionTtlSeconds, "Decision TTL", 60, 86_400),
    requireQualifiedInvestor: requireQualifiedInvestor === true,
  };
  return Object.freeze({
    ...normalized,
    allowedCountries: Object.freeze(normalized.allowedCountries),
  });
}

export function policyConfigurationDigest(policy) {
  return createHash("sha256").update(canonicalJson({
    schema: policy.schema,
    version: policy.version,
    policySha256: policy.policySha256,
    allowedCountries: policy.allowedCountries,
    minimumAge: policy.minimumAge,
    evidenceMaxAgeSeconds: policy.evidenceMaxAgeSeconds,
    decisionTtlSeconds: policy.decisionTtlSeconds,
    requireQualifiedInvestor: policy.requireQualifiedInvestor,
  })).digest("hex");
}

function latestEvidence(evidence, kind) {
  return evidence
    .filter((item) => item?.kind === kind)
    .sort((left, right) => instant(right.observedAt, "evidence observedAt") - instant(left.observedAt, "evidence observedAt"))[0];
}

function activeEvidence(item, now, policy) {
  if (!item || item.status !== "pass") return false;
  const observedAt = instant(item.observedAt, "evidence observedAt");
  const expiresAt = instant(item.expiresAt, "evidence expiresAt");
  const maximumAgeSeconds = Math.min(
    policy.evidenceMaxAgeSeconds,
    EVIDENCE_MAX_AGE_CAP_SECONDS[item.kind] ?? policy.evidenceMaxAgeSeconds,
  );
  return observedAt <= now
    && expiresAt > now
    && now - observedAt < maximumAgeSeconds * 1_000;
}

function effectiveEvidenceExpiry(item, policy) {
  const maximumAgeSeconds = Math.min(
    policy.evidenceMaxAgeSeconds,
    EVIDENCE_MAX_AGE_CAP_SECONDS[item.kind] ?? policy.evidenceMaxAgeSeconds,
  );
  return Math.min(
    instant(item.expiresAt, "evidence expiresAt"),
    instant(item.observedAt, "evidence observedAt") + maximumAgeSeconds * 1_000,
  );
}

function add(reasons, value, condition = true) {
  if (condition === true) reasons.add(value);
}

function evidenceId(item) {
  return typeof item?.id === "string" && /^[0-9a-f-]{36}$/i.test(item.id) ? item.id : undefined;
}

export function evaluateCompliance({
  policy,
  wallet,
  product,
  evidence = [],
  responsibleGaming = {},
  amountUsdMinor,
  rollingDeposits = {},
  now = new Date(),
} = {}) {
  if (!policy || policy.schema !== COMPLIANCE_POLICY_VERSION) fail("A validated compliance policy is required");
  if (typeof wallet !== "string" || wallet.length < 32 || wallet.length > 64) fail("Wallet is invalid");
  if (!PRODUCTS.has(product)) fail("Compliance product is invalid");
  const nowMs = instant(now, "now");
  const latest = Object.fromEntries(REQUIRED_EVIDENCE.map((kind) => [kind, latestEvidence(evidence, kind)]));
  const reasons = new Set();

  if (policy.allowedCountries.length === 0) add(reasons, "launch_jurisdiction_unconfigured");
  for (const kind of REQUIRED_EVIDENCE) {
    const item = latest[kind];
    if (!item) add(reasons, `${kind}_missing`);
    else if (item.status !== "pass") add(reasons, `${kind}_${item.status}`);
    else if (!activeEvidence(item, nowMs, policy)) add(reasons, `${kind}_stale`);
  }

  const identity = latest.identity;
  const sanctions = latest.sanctions;
  const geolocation = latest.geolocation;
  const xstocks = latest.xstocks_eligibility;
  const residencyCountry = identity?.countryCode ? country(identity.countryCode, "identity country") : undefined;
  const locationCountry = geolocation?.countryCode ? country(geolocation.countryCode, "geolocation country") : undefined;
  const locationRegion = region(geolocation?.regionCode);

  add(reasons, "age_not_verified", identity?.minimumAgeMet !== true
    || !Number.isInteger(identity?.verifiedMinimumAge)
    || identity.verifiedMinimumAge < policy.minimumAge);
  add(reasons, "us_person_prohibited", identity?.usPerson !== false);
  add(reasons, "sanctions_not_clear", sanctions?.sanctionsMatch !== false);
  add(reasons, "pep_manual_review", sanctions?.pepMatch === true);
  add(reasons, "residency_unknown", !residencyCountry);
  add(reasons, "location_unknown", !locationCountry);
  add(reasons, "issuer_restricted_residency", Boolean(residencyCountry && XSTOCKS_HARD_BLOCKED_COUNTRIES.has(residencyCountry)));
  add(reasons, "issuer_restricted_location", Boolean(locationCountry && XSTOCKS_HARD_BLOCKED_COUNTRIES.has(locationCountry)));
  add(reasons, "issuer_restricted_region", Boolean(locationRegion && XSTOCKS_HARD_BLOCKED_REGIONS.has(locationRegion)));
  add(reasons, "residency_not_launch_approved", Boolean(residencyCountry && !policy.allowedCountries.includes(residencyCountry)));
  add(reasons, "location_not_launch_approved", Boolean(locationCountry && !policy.allowedCountries.includes(locationCountry)));
  add(reasons, "xstocks_wallet_not_eligible", xstocks?.walletEligible !== true);
  add(reasons, "qualified_investor_required", Boolean(policy.requireQualifiedInvestor && identity?.qualifiedInvestor !== true));

  const selfExcludedUntil = responsibleGaming.selfExcludedUntil ? instant(responsibleGaming.selfExcludedUntil, "self exclusion") : 0;
  const coolingOffUntil = responsibleGaming.coolingOffUntil ? instant(responsibleGaming.coolingOffUntil, "cooling off") : 0;
  const gamblingEntry = ["real_value_poker", "deposit", "table_buy_in"].includes(product);
  add(reasons, "self_excluded", gamblingEntry && selfExcludedUntil > nowMs);
  add(reasons, "cooling_off", gamblingEntry && coolingOffUntil > nowMs);

  if (product === "deposit") {
    const amount = atomic(amountUsdMinor, "deposit USD minor amount");
    if (amount === undefined || amount === 0n) add(reasons, "deposit_amount_invalid");
    const periods = [
      ["daily", responsibleGaming.dailyDepositLimitUsdMinor],
      ["weekly", responsibleGaming.weeklyDepositLimitUsdMinor],
      ["monthly", responsibleGaming.monthlyDepositLimitUsdMinor],
    ];
    for (const [period, rawLimit] of periods) {
      const limit = atomic(rawLimit, `${period} deposit limit`);
      if (limit === undefined || amount === undefined) continue;
      const used = atomic(rollingDeposits[`${period}UsdMinor`] ?? 0, `${period} deposits`) ?? 0n;
      add(reasons, `${period}_deposit_limit`, used + amount > limit);
    }
  }

  const activeExpiry = Object.values(latest)
    .filter((item) => item && activeEvidence(item, nowMs, policy))
    .map((item) => effectiveEvidenceExpiry(item, policy));
  const expiresAtMs = Math.min(nowMs + policy.decisionTtlSeconds * 1_000, ...activeExpiry);
  const reasonCodes = [...reasons].sort();
  if (reasonCodes.length === 0) reasonCodes.push("eligible");
  return Object.freeze({
    version: "xpoker-compliance-decision/v1",
    wallet,
    product,
    eligible: reasonCodes.length === 1 && reasonCodes[0] === "eligible",
    reasonCodes: Object.freeze(reasonCodes),
    policyVersion: policy.version,
    policySha256: policy.policySha256,
    jurisdictionCountry: locationCountry ?? null,
    evidenceIds: Object.freeze(Object.values(latest).map(evidenceId).filter(Boolean)),
    decidedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
  });
}

export function assertEligible(decision) {
  if (decision?.eligible !== true) {
    const error = new Error("Real-value eligibility was denied");
    error.statusCode = 403;
    error.code = "real_value_ineligible";
    error.reasonCodes = decision?.reasonCodes ?? ["eligibility_unavailable"];
    throw error;
  }
  return decision;
}

export const COMPLIANCE_PRODUCTS = Object.freeze([...PRODUCTS]);
