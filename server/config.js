import { decodeBase58 } from "./wallet-auth.js";
import { createCompliancePolicy } from "./compliance/policy.js";

function integer(value, fallback, { minimum, maximum, label }) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function wallets(value) {
  if (!value) return [];
  return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))].map((wallet) => {
    try {
      if (decodeBase58(wallet).length !== 32) throw new Error();
    } catch {
      throw new Error("ADMIN_WALLETS must contain Solana wallet addresses");
    }
    return wallet;
  });
}

function origins(value) {
  if (!value) return [];
  return [...new Set(value.split(",").map((item) => new URL(item.trim()).origin))];
}

function optionalHttpsUrl(value, label) {
  if (!value) return undefined;
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error(`${label} must use HTTPS`);
  if (url.username || url.password) throw new Error(`${label} must not contain credentials`);
  return url.href;
}

function optionalSecret(value, label) {
  if (!value) return undefined;
  if (value.length < 32 || value.length > 512) throw new Error(`${label} must be 32 to 512 characters`);
  return value;
}

function optionalPrivyAppId(value) {
  if (!value) return undefined;
  if (!/^[a-zA-Z0-9_-]{10,128}$/.test(value)) throw new Error("PRIVY_APP_ID is invalid");
  return value;
}

function optionalChoice(value, label, choices) {
  if (!value) return undefined;
  if (!choices.includes(value)) throw new Error(`${label} must be one of: ${choices.join(", ")}`);
  return value;
}

function optionalHex32(value, label) {
  if (!value) return undefined;
  if (!/^[0-9a-f]{64}$/i.test(value) || /^0{64}$/i.test(value)) {
    throw new Error(`${label} must be a nonzero 32-byte hex digest`);
  }
  return value.toLowerCase();
}

function countries(value) {
  if (!value) return [];
  return [...new Set(value.split(",").map((item) => item.trim().toUpperCase()).filter(Boolean))].map((item) => {
    if (!/^[A-Z]{2}$/.test(item)) throw new Error("COMPLIANCE_ALLOWED_COUNTRIES must contain ISO alpha-2 country codes");
    return item;
  }).sort();
}

function optionalSignerUrl(value) {
  if (!value) return undefined;
  const url = new URL(value);
  const railwayPrivate = url.protocol === "http:" && url.hostname.endsWith(".railway.internal");
  if (url.protocol !== "https:" && !railwayPrivate) {
    throw new Error("DEALER_SIGNER_URL must use HTTPS or Railway private networking");
  }
  if (url.username || url.password) throw new Error("DEALER_SIGNER_URL must not contain credentials");
  return url.href.replace(/\/$/, "");
}

export function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV ?? "development";
  if (!["development", "test", "production"].includes(nodeEnv)) throw new Error("Invalid NODE_ENV");
  const publicOrigin = new URL(env.PUBLIC_ORIGIN ?? "http://localhost:4173").origin;
  const realValueMode = env.REAL_VALUE_MODE === "enabled";
  const safeBetaMode = !realValueMode && (
    env.SAFE_BETA_MODE === "enabled"
    || (nodeEnv !== "production" && env.SAFE_BETA_MODE !== "disabled")
  );
  const privyAppId = optionalPrivyAppId(env.PRIVY_APP_ID);
  const privyAppSecret = optionalSecret(env.PRIVY_APP_SECRET, "PRIVY_APP_SECRET");
  if (Boolean(privyAppId) !== Boolean(privyAppSecret)) {
    throw new Error("PRIVY_APP_ID and PRIVY_APP_SECRET must be configured together");
  }
  const complianceAllowedCountries = countries(env.COMPLIANCE_ALLOWED_COUNTRIES);
  const compliancePolicySha256 = optionalHex32(env.COMPLIANCE_POLICY_SHA256, "COMPLIANCE_POLICY_SHA256");
  const compliancePolicyConfigured = Boolean(
    env.COMPLIANCE_POLICY_VERSION
    || compliancePolicySha256
    || complianceAllowedCountries.length
    || env.COMPLIANCE_MINIMUM_AGE,
  );
  const compliancePolicy = compliancePolicyConfigured ? createCompliancePolicy({
    version: env.COMPLIANCE_POLICY_VERSION,
    policySha256: compliancePolicySha256,
    allowedCountries: complianceAllowedCountries,
    minimumAge: env.COMPLIANCE_MINIMUM_AGE,
    evidenceMaxAgeSeconds: integer(env.COMPLIANCE_EVIDENCE_MAX_AGE_SECONDS, 86_400, {
      minimum: 300,
      maximum: 2_592_000,
      label: "COMPLIANCE_EVIDENCE_MAX_AGE_SECONDS",
    }),
    decisionTtlSeconds: integer(env.COMPLIANCE_DECISION_TTL_SECONDS, 900, {
      minimum: 60,
      maximum: 86_400,
      label: "COMPLIANCE_DECISION_TTL_SECONDS",
    }),
    requireQualifiedInvestor: env.COMPLIANCE_REQUIRE_QUALIFIED_INVESTOR === "enabled",
  }) : undefined;
  return Object.freeze({
    nodeEnv,
    host: env.HOST ?? "127.0.0.1",
    port: integer(env.PORT, 8787, { minimum: 1, maximum: 65_535, label: "PORT" }),
    publicOrigin,
    allowedOrigins: origins(env.ALLOWED_ORIGINS ?? publicOrigin),
    realValueMode,
    safeBetaMode,
    betaInviteRequired: env.BETA_INVITE_REQUIRED === "enabled",
    privyAppId,
    privyAppSecret,
    adminWallets: wallets(env.ADMIN_WALLETS),
    instanceId: env.RAILWAY_REPLICA_ID ?? env.RAILWAY_DEPLOYMENT_ID ?? env.HOSTNAME,
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    redisTransportSecurity: optionalChoice(env.REDIS_TRANSPORT_SECURITY, "REDIS_TRANSPORT_SECURITY", [
      "tls",
      "railway-private-network",
    ]),
    dealerKeyProvider: env.DEALER_KEY_PROVIDER,
    dealerKeyReference: env.DEALER_KEY_REFERENCE,
    dealerSigningKeyPem: env.DEALER_SIGNING_KEY_PEM,
    dealerSignerUrl: optionalSignerUrl(env.DEALER_SIGNER_URL),
    dealerSignerToken: optionalSecret(env.DEALER_SIGNER_TOKEN, "DEALER_SIGNER_TOKEN"),
    safeBetaSigningKeyPem: env.SAFE_BETA_SIGNING_KEY_PEM,
    solanaRpcUrl: env.SOLANA_RPC_URL,
    solanaReadRpcUrl: optionalHttpsUrl(
      env.SOLANA_READ_RPC_URL ?? "https://api.mainnet-beta.solana.com",
      "SOLANA_READ_RPC_URL",
    ),
    settlementCluster: env.SETTLEMENT_CLUSTER,
    settlementProgramId: env.SETTLEMENT_PROGRAM_ID,
    settlementProgramBinarySha256: env.SETTLEMENT_PROGRAM_BINARY_SHA256,
    settlementUpgradeAuthority: env.SETTLEMENT_UPGRADE_AUTHORITY,
    xstocksApiBase: optionalHttpsUrl(
      env.XSTOCKS_API_BASE ?? "https://api.xstocks.fi/api/v2",
      "XSTOCKS_API_BASE",
    ).replace(/\/$/, ""),
    xstocksApiKey: env.XSTOCKS_API_KEY,
    geofencingProvider: env.GEOFENCING_PROVIDER,
    geofencingConfigurationSha256: optionalHex32(
      env.GEOFENCING_CONFIGURATION_SHA256,
      "GEOFENCING_CONFIGURATION_SHA256",
    ),
    identityProvider: env.IDENTITY_PROVIDER,
    identityConfigurationSha256: optionalHex32(
      env.IDENTITY_CONFIGURATION_SHA256,
      "IDENTITY_CONFIGURATION_SHA256",
    ),
    sanctionsProvider: env.SANCTIONS_PROVIDER,
    sanctionsConfigurationSha256: optionalHex32(
      env.SANCTIONS_CONFIGURATION_SHA256,
      "SANCTIONS_CONFIGURATION_SHA256",
    ),
    sourceOfFundsProvider: env.SOURCE_OF_FUNDS_PROVIDER,
    sourceOfFundsConfigurationSha256: optionalHex32(
      env.SOURCE_OF_FUNDS_CONFIGURATION_SHA256,
      "SOURCE_OF_FUNDS_CONFIGURATION_SHA256",
    ),
    complianceAllowedCountries,
    compliancePolicy,
    compliancePolicySha256,
    xstocksClientApprovalSha256: optionalHex32(
      env.XSTOCKS_CLIENT_APPROVAL_SHA256,
      "XSTOCKS_CLIENT_APPROVAL_SHA256",
    ),
    xstocksEligibilityProvider: env.XSTOCKS_ELIGIBILITY_PROVIDER,
    xstocksEligibilityConfigurationSha256: optionalHex32(
      env.XSTOCKS_ELIGIBILITY_CONFIGURATION_SHA256,
      "XSTOCKS_ELIGIBILITY_CONFIGURATION_SHA256",
    ),
    custodyPolicySha256: optionalHex32(env.CUSTODY_POLICY_SHA256, "CUSTODY_POLICY_SHA256"),
    custodyAuthorityMode: optionalChoice(env.CUSTODY_AUTHORITY_MODE, "CUSTODY_AUTHORITY_MODE", [
      "escrow_program",
      "hsm_multisig",
    ]),
    withdrawalApprovalQuorum: integer(env.WITHDRAWAL_APPROVAL_QUORUM, 2, {
      minimum: 2,
      maximum: 9,
      label: "WITHDRAWAL_APPROVAL_QUORUM",
    }),
    withdrawalCoolingOffSeconds: integer(env.WITHDRAWAL_COOLING_OFF_SECONDS, 900, {
      minimum: 60,
      maximum: 604_800,
      label: "WITHDRAWAL_COOLING_OFF_SECONDS",
    }),
    monitoringDsn: env.MONITORING_DSN,
    externalUptimeProvider: optionalChoice(env.EXTERNAL_UPTIME_PROVIDER, "EXTERNAL_UPTIME_PROVIDER", ["github-actions"]),
    externalUptimeUrl: optionalHttpsUrl(env.EXTERNAL_UPTIME_URL, "EXTERNAL_UPTIME_URL"),
    alertWebhookUrl: optionalHttpsUrl(env.ALERT_WEBHOOK_URL, "ALERT_WEBHOOK_URL"),
    alertWebhookToken: optionalSecret(env.ALERT_WEBHOOK_TOKEN, "ALERT_WEBHOOK_TOKEN"),
    metricsBearerToken: optionalSecret(env.METRICS_BEARER_TOKEN, "METRICS_BEARER_TOKEN"),
    monitorIntervalMs: integer(env.MONITOR_INTERVAL_MS, 15_000, {
      minimum: 5_000,
      maximum: 300_000,
      label: "MONITOR_INTERVAL_MS",
    }),
    monitorProbeTimeoutMs: integer(env.MONITOR_PROBE_TIMEOUT_MS, 2_000, {
      minimum: 250,
      maximum: 10_000,
      label: "MONITOR_PROBE_TIMEOUT_MS",
    }),
    alertCooldownMs: integer(env.ALERT_COOLDOWN_MS, 300_000, {
      minimum: 60_000,
      maximum: 86_400_000,
      label: "ALERT_COOLDOWN_MS",
    }),
    monitorOverdueGraceMs: integer(env.MONITOR_OVERDUE_GRACE_MS, 30_000, {
      minimum: 5_000,
      maximum: 300_000,
      label: "MONITOR_OVERDUE_GRACE_MS",
    }),
    monitorStalledTableMs: integer(env.MONITOR_STALLED_TABLE_MS, 120_000, {
      minimum: 60_000,
      maximum: 3_600_000,
      label: "MONITOR_STALLED_TABLE_MS",
    }),
    monitorStalledBeaconMs: integer(env.MONITOR_STALLED_BEACON_MS, 60_000, {
      minimum: 15_000,
      maximum: 900_000,
      label: "MONITOR_STALLED_BEACON_MS",
    }),
    monitorApplicationIncidentWindowMs: integer(env.MONITOR_APPLICATION_INCIDENT_WINDOW_MS, 600_000, {
      minimum: 60_000,
      maximum: 86_400_000,
      label: "MONITOR_APPLICATION_INCIDENT_WINDOW_MS",
    }),
    monitorDatabaseLatencyMs: integer(env.MONITOR_DATABASE_LATENCY_MS, 1_000, {
      minimum: 100,
      maximum: 10_000,
      label: "MONITOR_DATABASE_LATENCY_MS",
    }),
    monitorRedisLatencyMs: integer(env.MONITOR_REDIS_LATENCY_MS, 500, {
      minimum: 50,
      maximum: 10_000,
      label: "MONITOR_REDIS_LATENCY_MS",
    }),
    monitorPoolWaitingLimit: integer(env.MONITOR_POOL_WAITING_LIMIT, 10, {
      minimum: 1,
      maximum: 1_000,
      label: "MONITOR_POOL_WAITING_LIMIT",
    }),
    monitorMinimumRequests: integer(env.MONITOR_MINIMUM_REQUESTS, 20, {
      minimum: 5,
      maximum: 100_000,
      label: "MONITOR_MINIMUM_REQUESTS",
    }),
    monitorHttpErrorRate: integer(env.MONITOR_HTTP_ERROR_RATE_BPS, 500, {
      minimum: 1,
      maximum: 10_000,
      label: "MONITOR_HTTP_ERROR_RATE_BPS",
    }) / 10_000,
    monitorRealtimeDisconnectRate: integer(env.MONITOR_REALTIME_DISCONNECT_RATE_BPS, 5_000, {
      minimum: 1,
      maximum: 10_000,
      label: "MONITOR_REALTIME_DISCONNECT_RATE_BPS",
    }) / 10_000,
    assetAllowlistVersion: env.ASSET_ALLOWLIST_VERSION,
    buildCommit: env.RAILWAY_GIT_COMMIT_SHA ?? env.BUILD_COMMIT,
    releaseManifestPath: env.RELEASE_MANIFEST_PATH,
    releaseManifestJson: env.RELEASE_MANIFEST_JSON,
    releaseAuthorityPublicKeyPem: env.RELEASE_AUTHORITY_PUBLIC_KEY_PEM,
    bodyLimitBytes: integer(env.BODY_LIMIT_BYTES, 16_384, {
      minimum: 1_024,
      maximum: 1_048_576,
      label: "BODY_LIMIT_BYTES",
    }),
  });
}
