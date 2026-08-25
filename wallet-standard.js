export const SOLANA_MAINNET_CHAIN = "solana:mainnet";

function guard(callback) {
  try { callback(); } catch (error) { console.error(error); }
}

class AppReadyEvent extends Event {
  constructor(api) {
    super("wallet-standard:app-ready", { bubbles: false, cancelable: false, composed: false });
    this.detail = api;
  }
}

export function createWalletRegistry(target = globalThis.window) {
  const wallets = new Set();
  const listeners = new Set();
  const register = (...candidates) => {
    const additions = candidates.filter((wallet) => wallet && typeof wallet.name === "string" && !wallets.has(wallet));
    additions.forEach((wallet) => wallets.add(wallet));
    if (additions.length) listeners.forEach((listener) => guard(() => listener([...wallets])));
    return () => {
      additions.forEach((wallet) => wallets.delete(wallet));
      if (additions.length) listeners.forEach((listener) => guard(() => listener([...wallets])));
    };
  };
  const api = Object.freeze({ register });
  if (target?.addEventListener && target?.dispatchEvent) {
    target.addEventListener("wallet-standard:register-wallet", (event) => guard(() => event.detail(api)));
    guard(() => target.dispatchEvent(new AppReadyEvent(api)));
  }
  return Object.freeze({
    get: () => [...wallets],
    onChange(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    register,
  });
}

function legacyAccount(provider) {
  const publicKey = provider.publicKey;
  if (!publicKey) return undefined;
  const address = String(publicKey);
  return Object.freeze({
    address,
    publicKey: typeof publicKey.toBytes === "function" ? publicKey.toBytes() : new Uint8Array(),
    chains: [SOLANA_MAINNET_CHAIN],
    features: ["solana:signMessage"],
  });
}

export function wrapLegacyProvider(name, provider) {
  if (!provider?.connect || !provider?.signMessage) return undefined;
  let accounts = [];
  const wallet = {
    version: "1.0.0",
    name,
    icon: "",
    chains: [SOLANA_MAINNET_CHAIN],
    get accounts() { return accounts; },
    features: {
      "standard:connect": {
        version: "1.0.0",
        async connect() {
          const connection = await provider.connect();
          if (connection?.publicKey && !provider.publicKey) provider.publicKey = connection.publicKey;
          const account = legacyAccount({ ...provider, publicKey: connection?.publicKey || provider.publicKey });
          accounts = account ? [account] : [];
          return { accounts };
        },
      },
      "solana:signMessage": {
        version: "1.0.0",
        async signMessage(...inputs) {
          const output = [];
          for (const input of inputs) {
            const signed = await provider.signMessage(input.message, "utf8");
            output.push({
              account: input.account,
              signedMessage: input.message,
              signature: signed.signature || signed,
            });
          }
          return output;
        },
      },
    },
  };
  return wallet;
}

export function legacyWallets(target = globalThis.window) {
  if (!target) return [];
  const candidates = [
    ["Phantom", target.phantom?.solana || (target.solana?.isPhantom ? target.solana : undefined)],
    ["Solflare", target.solflare || (target.solana?.isSolflare ? target.solana : undefined)],
    ["Backpack", target.backpack?.solana || (target.solana?.isBackpack ? target.solana : undefined)],
  ];
  const seen = new Set();
  return candidates.flatMap(([name, provider]) => {
    if (!provider || seen.has(provider)) return [];
    seen.add(provider);
    const wallet = wrapLegacyProvider(name, provider);
    return wallet ? [wallet] : [];
  });
}

export function compatibleWallets(standardWallets, fallbackWallets = []) {
  const byName = new Map();
  for (const wallet of [...fallbackWallets, ...standardWallets]) {
    if (!wallet?.features?.["standard:connect"] || !wallet?.features?.["solana:signMessage"]) continue;
    if (!wallet.chains?.some((chain) => chain === SOLANA_MAINNET_CHAIN || chain.startsWith("solana:"))) continue;
    byName.set(wallet.name, wallet);
  }
  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export async function connectAndSign(wallet, message) {
  const connect = wallet?.features?.["standard:connect"]?.connect;
  const signMessage = wallet?.features?.["solana:signMessage"]?.signMessage;
  if (!connect || !signMessage) throw new Error("This wallet cannot sign Solana login messages.");
  const connection = await connect();
  const accounts = connection?.accounts?.length ? connection.accounts : wallet.accounts;
  const account = accounts?.find((candidate) =>
    candidate?.address
    && candidate.chains?.some((chain) => chain === SOLANA_MAINNET_CHAIN || chain.startsWith("solana:"))
    && candidate.features?.includes("solana:signMessage"));
  if (!account) throw new Error("Choose a Solana account in your wallet and try again.");
  const resolvedMessage = typeof message === "function" ? await message(account) : message;
  const bytes = typeof resolvedMessage === "string" ? new TextEncoder().encode(resolvedMessage) : resolvedMessage;
  const outputs = await signMessage({ account, message: bytes });
  const output = outputs?.[0];
  if (!output?.signature) throw new Error("The wallet did not return a message signature.");
  return { account, signature: output.signature, signedMessage: output.signedMessage || bytes };
}

export async function signSerializedTransaction(wallet, { transaction, walletAddress } = {}) {
  const connect = wallet?.features?.["standard:connect"]?.connect;
  const feature = wallet?.features?.["solana:signTransaction"];
  const signTransaction = feature?.signTransaction;
  if (!connect || !signTransaction) throw new Error("This wallet cannot sign Solana transactions.");
  if (!(transaction instanceof Uint8Array) || transaction.length < 32) throw new Error("The swap transaction is invalid.");
  const connection = await connect();
  const accounts = connection?.accounts?.length ? connection.accounts : wallet.accounts;
  const account = accounts?.find((candidate) => (
    candidate?.address === walletAddress
    && candidate.chains?.some((chain) => chain === SOLANA_MAINNET_CHAIN || chain.startsWith("solana:"))
    && candidate.features?.includes("solana:signTransaction")
  ));
  if (!account) throw new Error("Reconnect the same Solana account used to sign in.");
  const outputs = await signTransaction({ account, transaction, chain: SOLANA_MAINNET_CHAIN });
  const signedTransaction = outputs?.[0]?.signedTransaction;
  if (!(signedTransaction instanceof Uint8Array) || signedTransaction.length < 32) {
    throw new Error("The wallet did not return a signed transaction.");
  }
  return { account, signedTransaction };
}
