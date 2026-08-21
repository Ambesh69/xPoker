import { PrivyClient } from "@privy-io/node";

import { decodeBase58 } from "./wallet-auth.js";

function authenticationError(message = "Privy authentication failed") {
  const error = new Error(message);
  error.statusCode = 401;
  return error;
}

function isSolanaAddress(value) {
  try {
    return typeof value === "string" && decodeBase58(value).length === 32;
  } catch {
    return false;
  }
}

function solanaWallets(user) {
  return [...new Set((user?.linked_accounts ?? [])
    .filter((account) => account?.type === "wallet" && account.chain_type === "solana")
    .map((account) => account.address)
    .filter(isSolanaAddress))];
}

export function createPrivyAuthenticator({ appId, appSecret, client } = {}) {
  if (typeof appId !== "string" || !appId) throw new Error("Privy app ID is required");
  if (typeof appSecret !== "string" || !appSecret) throw new Error("Privy app secret is required");
  const privy = client ?? new PrivyClient({ appId, appSecret });

  return Object.freeze({
    async authenticate({ accessToken, wallet } = {}) {
      if (typeof accessToken !== "string" || accessToken.length < 32 || accessToken.length > 16_384) {
        throw authenticationError();
      }
      if (!isSolanaAddress(wallet)) throw authenticationError("A valid linked Solana wallet is required");

      try {
        const claims = await privy.utils().auth().verifyAccessToken(accessToken);
        if (claims.app_id !== appId || typeof claims.user_id !== "string") throw authenticationError();
        const user = await privy.users()._get(claims.user_id);
        if (user?.id !== claims.user_id) throw authenticationError();
        const linkedWallets = solanaWallets(user);
        if (!linkedWallets.includes(wallet)) throw authenticationError("That Solana wallet is not linked to this Privy user");
        return Object.freeze({
          wallet,
          privyUserId: claims.user_id,
          privySessionId: claims.session_id,
        });
      } catch (error) {
        if (error?.statusCode === 401) throw error;
        throw authenticationError();
      }
    },
  });
}
