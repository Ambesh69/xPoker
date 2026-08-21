import React, { useCallback, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { PrivyProvider, useLogin, usePrivy } from "@privy-io/react-auth";
import { toSolanaWalletConnectors } from "@privy-io/react-auth/solana";

const appId = document.querySelector('meta[name="xpoker-privy-app-id"]')?.content?.trim();
const rootElement = document.querySelector("#privy-root");

function linkedSolanaWallets(user) {
  return (user?.linkedAccounts ?? []).filter((account) => (
    account?.type === "wallet"
    && account.chainType === "solana"
    && typeof account.address === "string"
  ));
}

function preferredSolanaWallet(user, loginAccount) {
  const wallets = linkedSolanaWallets(user);
  const loginAddress = loginAccount?.type === "wallet" && loginAccount.chainType === "solana"
    ? loginAccount.address
    : undefined;
  return wallets.find((wallet) => wallet.address === loginAddress)
    ?? wallets.find((wallet) => wallet.walletClientType !== "privy")
    ?? wallets[0];
}

function friendlyPrivyError(error) {
  if (error === "exited_auth_flow") return "Privy sign-in was closed.";
  if (error === "user_rejected") return "The wallet signature was declined.";
  return "Privy could not complete the Solana sign-in.";
}

function PrivyBridge() {
  const pending = useRef(null);
  const {
    ready,
    authenticated,
    user,
    getAccessToken,
    logout,
  } = usePrivy();

  const complete = useCallback(async ({ user, loginMethod, loginAccount }) => {
    try {
      const wallet = preferredSolanaWallet(user, loginAccount);
      if (!wallet) throw new Error("Choose a Solana wallet to enter xPoker.");
      const accessToken = await getAccessToken();
      if (!accessToken) throw new Error("Privy did not return a valid session.");
      pending.current?.resolve({
        accessToken,
        wallet: wallet.address,
        walletName: wallet.walletClientType && wallet.walletClientType !== "unknown"
          ? wallet.walletClientType
          : loginMethod || "Solana wallet",
      });
    } catch (error) {
      pending.current?.reject(error);
    } finally {
      pending.current = null;
    }
  }, [getAccessToken]);

  const { login } = useLogin({
    onComplete: (result) => { void complete(result); },
    onError: (error) => {
      pending.current?.reject(new Error(friendlyPrivyError(error)));
      pending.current = null;
    },
  });

  useEffect(() => {
    if (!ready) return undefined;
    const bridge = Object.freeze({
      ready: true,
      login() {
        if (pending.current) return Promise.reject(new Error("Privy sign-in is already open."));
        return new Promise((resolve, reject) => {
          pending.current = { resolve, reject };
          if (authenticated && user) void complete({ user, loginMethod: "Privy session" });
          else login();
        });
      },
      logout,
    });
    window.xPokerPrivy = bridge;
    window.dispatchEvent(new CustomEvent("xpoker:privy-ready", { detail: { ready: true } }));
    return () => {
      if (window.xPokerPrivy === bridge) delete window.xPokerPrivy;
    };
  }, [authenticated, complete, login, logout, ready, user]);

  return null;
}

if (appId && rootElement) {
  createRoot(rootElement).render(
    <PrivyProvider
      appId={appId}
      config={{
        loginMethods: ["wallet"],
        appearance: {
          theme: "#f7f9f5",
          accentColor: "#174f39",
          landingHeader: "Choose your Solana wallet",
          loginMessage: "One login signature. No transaction or token approval.",
          showWalletLoginFirst: true,
          walletChainType: "solana-only",
          walletList: [
            "phantom",
            "solflare",
            "backpack",
            "detected_solana_wallets",
            "wallet_connect_qr_solana",
          ],
        },
        externalWallets: {
          solana: {
            connectors: toSolanaWalletConnectors({ shouldAutoConnect: false }),
          },
        },
        embeddedWallets: {
          solana: { createOnLogin: "off" },
        },
      }}
    >
      <PrivyBridge />
    </PrivyProvider>,
  );
} else {
  window.dispatchEvent(new CustomEvent("xpoker:privy-ready", { detail: { ready: false } }));
}
