import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "./config.js";
import { encodeBase58 } from "./wallet-auth.js";

test("operations configuration validates and deduplicates admin wallets", () => {
  const admin = encodeBase58(Buffer.alloc(32, 9));
  const config = loadConfig({
    NODE_ENV: "production",
    PUBLIC_ORIGIN: "https://xpoker.vercel.app",
    ADMIN_WALLETS: `${admin}, ${admin}`,
    BETA_INVITE_REQUIRED: "enabled",
    RAILWAY_REPLICA_ID: "replica-2",
  });
  assert.deepEqual(config.adminWallets, [admin]);
  assert.equal(config.betaInviteRequired, true);
  assert.equal(config.instanceId, "replica-2");
  assert.equal(config.solanaReadRpcUrl, "https://api.mainnet-beta.solana.com/");
  assert.equal(config.xstocksApiBase, "https://api.xstocks.fi/api/v2");
});

test("operations configuration rejects malformed admin wallets", () => {
  assert.throws(
    () => loadConfig({ NODE_ENV: "production", ADMIN_WALLETS: "not-a-solana-wallet" }),
    /ADMIN_WALLETS/,
  );
});

test("monitoring configuration requires HTTPS endpoints and long bearer secrets", () => {
  const config = loadConfig({
    NODE_ENV: "production",
    PUBLIC_ORIGIN: "https://xpoker.vercel.app",
    ALERT_WEBHOOK_URL: "https://alerts.example/xpoker",
    ALERT_WEBHOOK_TOKEN: "a".repeat(32),
    METRICS_BEARER_TOKEN: "m".repeat(32),
    REDIS_TRANSPORT_SECURITY: "railway-private-network",
    EXTERNAL_UPTIME_PROVIDER: "github-actions",
    EXTERNAL_UPTIME_URL: "https://github.com/Ambesh69/xPoker/actions/workflows/uptime.yml",
    MONITOR_HTTP_ERROR_RATE_BPS: "250",
  });
  assert.equal(config.alertWebhookUrl, "https://alerts.example/xpoker");
  assert.equal(config.monitorHttpErrorRate, 0.025);
  assert.equal(config.monitorIntervalMs, 15_000);
  assert.equal(config.redisTransportSecurity, "railway-private-network");
  assert.equal(config.externalUptimeProvider, "github-actions");
  assert.throws(
    () => loadConfig({ ALERT_WEBHOOK_URL: "http://alerts.example/xpoker" }),
    /HTTPS/,
  );
  assert.throws(
    () => loadConfig({ METRICS_BEARER_TOKEN: "short" }),
    /32 to 512/,
  );
  assert.throws(
    () => loadConfig({ REDIS_TRANSPORT_SECURITY: "trust-me" }),
    /REDIS_TRANSPORT_SECURITY/,
  );
  assert.throws(
    () => loadConfig({ SOLANA_READ_RPC_URL: "http://rpc.example" }),
    /HTTPS/,
  );
});

test("release manifest JSON can be supplied as a sealed environment value", () => {
  const config = loadConfig({
    RELEASE_MANIFEST_JSON: '{"version":"xpoker-release/v1"}',
  });
  assert.equal(config.releaseManifestJson, '{"version":"xpoker-release/v1"}');
});

test("Privy credentials are optional as a pair and the secret remains server-only", () => {
  const config = loadConfig({
    PRIVY_APP_ID: "privy-app-test-12345",
    PRIVY_APP_SECRET: "p".repeat(40),
  });
  assert.equal(config.privyAppId, "privy-app-test-12345");
  assert.equal(config.privyAppSecret, "p".repeat(40));
  assert.throws(
    () => loadConfig({ PRIVY_APP_ID: "privy-app-test-12345" }),
    /configured together/,
  );
  assert.throws(
    () => loadConfig({ PRIVY_APP_SECRET: "p".repeat(40) }),
    /configured together/,
  );
});

test("Railway's immutable deployment commit takes precedence over a stale configured commit", () => {
  const config = loadConfig({
    BUILD_COMMIT: "a".repeat(40),
    RAILWAY_GIT_COMMIT_SHA: "b".repeat(40),
  });
  assert.equal(config.buildCommit, "b".repeat(40));
});
