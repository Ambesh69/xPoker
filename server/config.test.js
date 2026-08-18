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
});

test("operations configuration rejects malformed admin wallets", () => {
  assert.throws(
    () => loadConfig({ NODE_ENV: "production", ADMIN_WALLETS: "not-a-solana-wallet" }),
    /ADMIN_WALLETS/,
  );
});
