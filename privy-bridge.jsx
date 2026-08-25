import React, { useCallback, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import {
  PrivyProvider,
  useConnectWallet,
  useLoginWithSiws,
  usePrivy,
} from "@privy-io/react-auth";
import { toSolanaWalletConnectors } from "@privy-io/react-auth/solana";

const appId = document.querySelector('meta[name="xpoker-privy-app-id"]')?.content?.trim();
const rootElement = document.querySelector("#privy-root");
const walletLabels = Object.freeze({
  phantom: "Phantom",
  solflare: "Solflare",
  backpack: "Backpack",
  wallet_connect: "WalletConnect",
});

function openPreselectedWallet(walletId) {
  const label = walletLabels[walletId];
  if (!label) return;
  let observer;
  let timeout;
  const select = () => {
    const dialog = document.querySelector("#privy-dialog");
    const walletButton = [...(dialog?.querySelectorAll("button") ?? [])].find((button) => (
      !button.disabled && button.textContent?.trim() === label
    ));
    if (!walletButton) return;
    observer?.disconnect();
    clearTimeout(timeout);
    walletButton.click();
  };
  observer = new MutationObserver(select);
  observer.observe(document.body, { childList: true, subtree: true });
  timeout = window.setTimeout(() => observer.disconnect(), 4_000);
  queueMicrotask(select);
}

function linkedSolanaWallets(user) {
  return (user?.linkedAccounts ?? []).filter((account) => (
    account?.type === "wallet"
    && account.chainType === "solana"
    && typeof account.address === "string"
  ));
}

function preferredSolanaWallet(user, loginAccount, walletClientType) {
  const wallets = linkedSolanaWallets(user);
  const loginAddress = loginAccount?.type === "wallet" && loginAccount.chainType === "solana"
    ? loginAccount.address
    : undefined;
  return wallets.find((wallet) => wallet.address === loginAddress)
    ?? wallets.find((wallet) => wallet.walletClientType === walletClientType)
    ?? wallets.find((wallet) => wallet.walletClientType !== "privy")
    ?? wallets[0];
}

function friendlyPrivyError(error) {
  const code = typeof error === "string" ? error : error?.code;
  const detail = [code, error?.message, error?.cause?.message]
    .filter(Boolean)
    .join(" ");
  if (["exited_auth_flow", "exited_connect_wallet_flow", "generic_connect_wallet_error"].includes(code)) return "Wallet sign-in was closed.";
  if (code === "user_rejected") return "The wallet signature was declined.";
  if (/namespace|accounts?['\"]?\s+of\s+undefined|unsupported.+solana|solana.+unsupported/i.test(detail)) {
    return "That wallet does not support Solana sign-in. Choose Phantom, Solflare, Backpack, or another Solana wallet.";
  }
  return "The Solana wallet could not complete sign-in.";
}

function signatureBase64(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value ?? []);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function bytesFromBase64(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function PrivyBridge() {
  const pending = useRef(null);
  const connectedWallet = useRef(null);
  const {
    ready,
    authenticated,
    user,
    getAccessToken,
    logout,
  } = usePrivy();
  const { generateSiwsMessage, loginWithSiws } = useLoginWithSiws();

  const complete = useCallback(async ({
    user: authenticatedUser,
    loginMethod,
    loginAccount,
    walletAddress,
    walletName,
    walletClientType,
  }) => {
    try {
      const wallet = walletAddress
        ? { address: walletAddress, walletClientType }
        : preferredSolanaWallet(authenticatedUser, loginAccount, walletClientType);
      if (!wallet) throw new Error("Choose a Solana wallet to enter xPoker.");
      const accessToken = await getAccessToken();
      if (!accessToken) throw new Error("Privy did not return a valid session.");
      pending.current?.resolve({
        accessToken,
        wallet: wallet.address,
        walletName: walletName || (wallet.walletClientType && wallet.walletClientType !== "unknown"
          ? wallet.walletClientType
          : loginMethod || "Solana wallet"),
      });
    } catch (error) {
      pending.current?.reject(error);
    } finally {
      pending.current = null;
    }
  }, [getAccessToken]);

  const authenticateConnectedWallet = useCallback(async (wallet) => {
    try {
      if (wallet?.type !== "solana" || !wallet.provider?.signMessage) {
        throw new Error("A Solana wallet with message signing is required.");
      }
      const message = await generateSiwsMessage({ address: wallet.address });
      connectedWallet.current = wallet;
      const signed = await wallet.provider.signMessage({
        message: new TextEncoder().encode(message),
      });
      const authenticatedUser = await loginWithSiws({
        message,
        signature: signatureBase64(signed.signature),
        walletClientType: wallet.walletClientType,
        connectorType: wallet.connectorType,
      });
      await complete({
        user: authenticatedUser,
        walletAddress: wallet.address,
        walletName: wallet.meta?.name,
        walletClientType: wallet.walletClientType,
      });
    } catch (error) {
      pending.current?.reject(error instanceof Error ? error : new Error(friendlyPrivyError(error)));
      pending.current = null;
    }
  }, [complete, generateSiwsMessage, loginWithSiws]);

  const { connectWallet } = useConnectWallet({
    onSuccess: ({ wallet }) => { void authenticateConnectedWallet(wallet); },
    onError: (error) => {
      pending.current?.reject(new Error(friendlyPrivyError(error)));
      pending.current = null;
    },
  });

  useEffect(() => {
    if (!ready) return undefined;
    const bridge = Object.freeze({
      ready: true,
      login(walletId) {
        if (pending.current) return Promise.reject(new Error("Privy sign-in is already open."));
        if (typeof walletId !== "string" || !walletId) return Promise.reject(new Error("Choose a wallet."));
        return new Promise((resolve, reject) => {
          pending.current = { resolve, reject };
          if (authenticated && user) {
            void complete({ user, loginMethod: "Privy session", walletClientType: walletId });
            return;
          }
          connectWallet({
            walletList: [walletId],
            walletChainType: "solana-only",
            preSelectedWalletId: walletId,
            hideHeader: true,
            description: "",
          });
          openPreselectedWallet(walletId);
        });
      },
      async signTransaction({ address, transaction }) {
        const wallet = connectedWallet.current;
        if (!wallet || wallet.address !== address || !wallet.provider?.signTransaction) {
          throw new Error("Reconnect this wallet before signing the swap.");
        }
        const signed = await wallet.provider.signTransaction({
          transaction: bytesFromBase64(transaction),
          address,
          chain: "solana:mainnet",
        });
        const bytes = signed?.signedTransaction ?? signed;
        return signatureBase64(bytes);
      },
      logout,
    });
    window.xPokerPrivy = bridge;
    window.dispatchEvent(new CustomEvent("xpoker:privy-ready", { detail: { ready: true } }));
    return () => {
      if (window.xPokerPrivy === bridge) delete window.xPokerPrivy;
    };
  }, [authenticated, complete, connectWallet, logout, ready, user]);

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
            "wallet_connect",
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
