import assert from "node:assert/strict";
import test from "node:test";

import { createPrivyAuthenticator } from "./privy-auth.js";
import { encodeBase58 } from "./wallet-auth.js";

const APP_ID = "privy-app-test-12345";
const APP_SECRET = "s".repeat(40);
const WALLET = encodeBase58(Buffer.alloc(32, 7));

function fakeClient({ userId = "did:privy:test-user", linkedWallet = WALLET, claimsAppId = APP_ID } = {}) {
  return {
    utils: () => ({
      auth: () => ({
        verifyAccessToken: async () => ({
          app_id: claimsAppId,
          user_id: userId,
          session_id: "privy-session-1",
        }),
      }),
    }),
    users: () => ({
      _get: async () => ({
        id: userId,
        linked_accounts: [{ type: "wallet", chain_type: "solana", address: linkedWallet }],
      }),
    }),
  };
}

test("Privy access tokens resolve only to a linked Solana wallet", async () => {
  const auth = createPrivyAuthenticator({ appId: APP_ID, appSecret: APP_SECRET, client: fakeClient() });
  const identity = await auth.authenticate({ accessToken: "t".repeat(64), wallet: WALLET });
  assert.equal(identity.wallet, WALLET);
  assert.equal(identity.privyUserId, "did:privy:test-user");
  assert.equal(identity.privySessionId, "privy-session-1");
});

test("Privy authentication rejects app mismatches and unlinked wallets", async () => {
  const wrongApp = createPrivyAuthenticator({
    appId: APP_ID,
    appSecret: APP_SECRET,
    client: fakeClient({ claimsAppId: "different-app" }),
  });
  await assert.rejects(
    wrongApp.authenticate({ accessToken: "t".repeat(64), wallet: WALLET }),
    /Privy authentication failed/,
  );

  const unlinked = createPrivyAuthenticator({ appId: APP_ID, appSecret: APP_SECRET, client: fakeClient() });
  const otherWallet = encodeBase58(Buffer.alloc(32, 8));
  await assert.rejects(
    unlinked.authenticate({ accessToken: "t".repeat(64), wallet: otherWallet }),
    /not linked/,
  );
});

test("Privy authentication rejects malformed tokens and wallet addresses before API calls", async () => {
  let called = false;
  const client = fakeClient();
  client.utils = () => ({ auth: () => ({ verifyAccessToken: async () => { called = true; } }) });
  const auth = createPrivyAuthenticator({ appId: APP_ID, appSecret: APP_SECRET, client });
  await assert.rejects(auth.authenticate({ accessToken: "short", wallet: WALLET }), /Privy authentication failed/);
  await assert.rejects(auth.authenticate({ accessToken: "t".repeat(64), wallet: "bad" }), /valid linked Solana wallet/);
  assert.equal(called, false);
});
