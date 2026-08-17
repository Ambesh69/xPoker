function integer(value, fallback, { minimum, maximum, label }) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function origins(value) {
  if (!value) return [];
  return [...new Set(value.split(",").map((item) => new URL(item.trim()).origin))];
}

export function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV ?? "development";
  if (!["development", "test", "production"].includes(nodeEnv)) throw new Error("Invalid NODE_ENV");
  return Object.freeze({
    nodeEnv,
    host: env.HOST ?? "127.0.0.1",
    port: integer(env.PORT, 8787, { minimum: 1, maximum: 65_535, label: "PORT" }),
    publicOrigin: env.PUBLIC_ORIGIN ?? "http://localhost:4173",
    allowedOrigins: origins(env.ALLOWED_ORIGINS ?? env.PUBLIC_ORIGIN),
    realValueMode: env.REAL_VALUE_MODE === "enabled",
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    dealerKeyProvider: env.DEALER_KEY_PROVIDER,
    dealerSigningKeyPem: env.DEALER_SIGNING_KEY_PEM,
    solanaRpcUrl: env.SOLANA_RPC_URL,
    xstocksApiBase: env.XSTOCKS_API_BASE ?? "https://api.xstocks.com",
    xstocksApiKey: env.XSTOCKS_API_KEY,
    geofencingProvider: env.GEOFENCING_PROVIDER,
    identityProvider: env.IDENTITY_PROVIDER,
    monitoringDsn: env.MONITORING_DSN,
    assetAllowlistVersion: env.ASSET_ALLOWLIST_VERSION,
    buildCommit: env.BUILD_COMMIT,
    releaseManifestPath: env.RELEASE_MANIFEST_PATH,
    releaseAuthorityPublicKeyPem: env.RELEASE_AUTHORITY_PUBLIC_KEY_PEM,
    bodyLimitBytes: integer(env.BODY_LIMIT_BYTES, 16_384, {
      minimum: 1_024,
      maximum: 1_048_576,
      label: "BODY_LIMIT_BYTES",
    }),
  });
}
