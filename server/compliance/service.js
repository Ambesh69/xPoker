import { createHash } from "node:crypto";

import { canonicalJson } from "../../fairness/protocol.js";
import { decodeBase58, encodeBase58 } from "../wallet-auth.js";
import { COMPLIANCE_PRODUCTS, evaluateCompliance } from "./policy.js";

const EVIDENCE_KINDS = new Set([
  "identity",
  "sanctions",
  "geolocation",
  "source_of_funds",
  "xstocks_eligibility",
]);
const EVIDENCE_STATUSES = new Set(["pending", "pass", "fail", "manual_review", "expired", "error"]);

function fail(message, statusCode = 400, code = "invalid_request") {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  throw error;
}

function walletAddress(value) {
  try {
    const bytes = decodeBase58(value);
    if (bytes.length !== 32 || encodeBase58(bytes) !== value) throw new Error();
    return value;
  } catch {
    fail("A canonical Solana wallet is required");
  }
}

function bounded(value, label, minimum, maximum) {
  if (typeof value !== "string") fail(`${label} is required`);
  const normalized = value.trim();
  if (normalized.length < minimum || normalized.length > maximum) fail(`${label} is invalid`);
  return normalized;
}

function optionalCountry(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !/^[A-Za-z]{2}$/.test(value)) fail("countryCode is invalid");
  return value.toUpperCase();
}

function optionalRegion(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !/^[A-Za-z]{2}-[A-Za-z0-9]{1,3}$/.test(value)) fail("regionCode is invalid");
  return value.toUpperCase();
}

function optionalBoolean(value, label) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "boolean") fail(`${label} must be a boolean`);
  return value;
}

function optionalMinimumAge(value) {
  if (value === undefined || value === null) return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 18 || number > 25) fail("verifiedMinimumAge is invalid");
  return number;
}

function digest(value) {
  return createHash("sha256").update(canonicalJson(value)).digest();
}

function hexDigest(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/i.test(value) || /^0{64}$/i.test(value)) {
    fail(`${label} must be a nonzero SHA-256 digest`);
  }
  return Buffer.from(value, "hex");
}

function isoTime(value, label) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) fail(`${label} is invalid`);
  return new Date(timestamp).toISOString();
}

function evidenceFromRow(row) {
  return {
    id: row.id,
    kind: row.kind,
    provider: row.provider,
    providerReference: row.provider_reference,
    status: row.status,
    countryCode: row.country_code ?? undefined,
    regionCode: row.region_code ?? undefined,
    minimumAgeMet: row.minimum_age_met ?? undefined,
    verifiedMinimumAge: row.verified_minimum_age ?? undefined,
    sanctionsMatch: row.sanctions_match ?? undefined,
    pepMatch: row.pep_match ?? undefined,
    usPerson: row.us_person ?? undefined,
    qualifiedInvestor: row.qualified_investor ?? undefined,
    walletEligible: row.wallet_eligible ?? undefined,
    observedAt: new Date(row.observed_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
  };
}

function decisionFromRow(row) {
  return Object.freeze({
    version: "xpoker-compliance-decision/v1",
    id: row.id,
    wallet: row.wallet_address,
    product: row.product,
    eligible: row.eligible,
    reasonCodes: Object.freeze(row.reason_codes),
    policyVersion: row.policy_version,
    policySha256: Buffer.from(row.policy_sha256).toString("hex"),
    jurisdictionCountry: row.jurisdiction_country,
    evidenceIds: Object.freeze(row.evidence_ids),
    decidedAt: new Date(row.decided_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
  });
}

export class PostgresComplianceService {
  constructor({ pool, policy, providers = {}, clock = () => new Date() } = {}) {
    if (!pool?.query || !pool?.connect) throw new Error("Compliance service requires PostgreSQL");
    if (!policy) throw new Error("Compliance service requires a validated policy");
    this.pool = pool;
    this.policy = policy;
    this.providers = Object.freeze({ ...providers });
    this.clock = clock;
  }

  async recordEvidence({ wallet, ...input }) {
    const canonicalWallet = walletAddress(wallet);
    if (!EVIDENCE_KINDS.has(input.kind)) fail("Evidence kind is invalid");
    if (!EVIDENCE_STATUSES.has(input.status)) fail("Evidence status is invalid");
    const provider = bounded(input.provider, "provider", 2, 64);
    const configuredProvider = this.providers[input.kind];
    if (!configuredProvider || provider !== configuredProvider) {
      fail("Evidence provider is not approved for this evidence kind", 403, "provider_not_approved");
    }
    const normalized = {
      wallet: canonicalWallet,
      kind: input.kind,
      provider,
      providerReference: bounded(input.providerReference, "providerReference", 3, 256),
      status: input.status,
      countryCode: optionalCountry(input.countryCode),
      regionCode: optionalRegion(input.regionCode),
      minimumAgeMet: optionalBoolean(input.minimumAgeMet, "minimumAgeMet"),
      verifiedMinimumAge: optionalMinimumAge(input.verifiedMinimumAge),
      sanctionsMatch: optionalBoolean(input.sanctionsMatch, "sanctionsMatch"),
      pepMatch: optionalBoolean(input.pepMatch, "pepMatch"),
      usPerson: optionalBoolean(input.usPerson, "usPerson"),
      qualifiedInvestor: optionalBoolean(input.qualifiedInvestor, "qualifiedInvestor"),
      walletEligible: optionalBoolean(input.walletEligible, "walletEligible"),
      evidenceSha256: hexDigest(input.evidenceSha256, "evidenceSha256"),
      idempotencyKey: bounded(input.idempotencyKey, "idempotencyKey", 16, 128),
      observedAt: isoTime(input.observedAt, "observedAt"),
      expiresAt: isoTime(input.expiresAt, "expiresAt"),
    };
    if (Date.parse(normalized.expiresAt) <= Date.parse(normalized.observedAt)) fail("Evidence expiry must follow observation");
    const requestDigest = digest({ ...normalized, evidenceSha256: normalized.evidenceSha256.toString("hex") });
    const result = await this.pool.query(
      `INSERT INTO compliance_evidence (
         wallet_address, kind, provider, provider_reference, status, country_code, region_code,
         minimum_age_met, verified_minimum_age, sanctions_match, pep_match, us_person,
         qualified_investor, wallet_eligible, evidence_sha256, request_digest, idempotency_key,
         observed_at, expires_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19
       )
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING *`,
      [
        normalized.wallet, normalized.kind, normalized.provider, normalized.providerReference,
        normalized.status, normalized.countryCode, normalized.regionCode, normalized.minimumAgeMet,
        normalized.verifiedMinimumAge, normalized.sanctionsMatch, normalized.pepMatch,
        normalized.usPerson, normalized.qualifiedInvestor, normalized.walletEligible,
        normalized.evidenceSha256, requestDigest, normalized.idempotencyKey,
        normalized.observedAt, normalized.expiresAt,
      ],
    );
    if (result.rowCount === 1) return evidenceFromRow(result.rows[0]);
    const prior = await this.pool.query(
      "SELECT * FROM compliance_evidence WHERE idempotency_key = $1",
      [normalized.idempotencyKey],
    );
    if (prior.rowCount !== 1 || !Buffer.from(prior.rows[0].request_digest).equals(requestDigest)) {
      fail("Idempotency key was reused with different evidence", 409, "idempotency_conflict");
    }
    return evidenceFromRow(prior.rows[0]);
  }

  async evaluateEligibility({ wallet, product, amountUsdMinor } = {}) {
    const canonicalWallet = walletAddress(wallet);
    if (!COMPLIANCE_PRODUCTS.includes(product)) fail("Compliance product is invalid");
    const now = this.clock();
    const [evidenceResult, controlsResult, depositsResult] = await Promise.all([
      this.pool.query(
        `SELECT DISTINCT ON (kind) *
           FROM compliance_evidence
          WHERE wallet_address = $1
          ORDER BY kind, observed_at DESC, created_at DESC`,
        [canonicalWallet],
      ),
      this.pool.query("SELECT * FROM responsible_gaming_controls WHERE wallet_address = $1", [canonicalWallet]),
      this.pool.query(
        `SELECT
           COALESCE(SUM(valuation_usd_minor) FILTER (WHERE credited_at >= $2::timestamptz - interval '1 day'), 0)::text AS daily,
           COALESCE(SUM(valuation_usd_minor) FILTER (WHERE credited_at >= $2::timestamptz - interval '7 days'), 0)::text AS weekly,
           COALESCE(SUM(valuation_usd_minor) FILTER (WHERE credited_at >= $2::timestamptz - interval '30 days'), 0)::text AS monthly
         FROM value_deposit_intents
        WHERE wallet_address = $1 AND status = 'credited'`,
        [canonicalWallet, now.toISOString()],
      ),
    ]);
    const controls = controlsResult.rows[0] ?? {};
    const rolling = depositsResult.rows[0] ?? { daily: "0", weekly: "0", monthly: "0" };
    const evaluated = evaluateCompliance({
      policy: this.policy,
      wallet: canonicalWallet,
      product,
      evidence: evidenceResult.rows.map(evidenceFromRow),
      responsibleGaming: {
        selfExcludedUntil: controls.self_excluded_until,
        coolingOffUntil: controls.cooling_off_until,
        dailyDepositLimitUsdMinor: controls.daily_deposit_limit_usd_minor,
        weeklyDepositLimitUsdMinor: controls.weekly_deposit_limit_usd_minor,
        monthlyDepositLimitUsdMinor: controls.monthly_deposit_limit_usd_minor,
      },
      amountUsdMinor,
      rollingDeposits: {
        dailyUsdMinor: rolling.daily,
        weeklyUsdMinor: rolling.weekly,
        monthlyUsdMinor: rolling.monthly,
      },
      now,
    });
    const requestDigest = digest(evaluated);
    const idempotencyKey = createHash("sha256")
      .update(`xpoker:compliance:${canonicalWallet}:${product}:`)
      .update(requestDigest)
      .digest("hex");
    const inserted = await this.pool.query(
      `INSERT INTO compliance_decisions (
         wallet_address, product, eligible, reason_codes, policy_version, policy_sha256,
         jurisdiction_country, evidence_ids, request_digest, idempotency_key, decided_at, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING *`,
      [
        canonicalWallet, product, evaluated.eligible, evaluated.reasonCodes, evaluated.policyVersion,
        Buffer.from(evaluated.policySha256, "hex"), evaluated.jurisdictionCountry,
        evaluated.evidenceIds, requestDigest, idempotencyKey, evaluated.decidedAt, evaluated.expiresAt,
      ],
    );
    if (inserted.rowCount === 1) return decisionFromRow(inserted.rows[0]);
    const prior = await this.pool.query("SELECT * FROM compliance_decisions WHERE idempotency_key = $1", [idempotencyKey]);
    if (prior.rowCount !== 1 || !Buffer.from(prior.rows[0].request_digest).equals(requestDigest)) {
      fail("Compliance decision idempotency conflict", 409, "idempotency_conflict");
    }
    return decisionFromRow(prior.rows[0]);
  }
}
