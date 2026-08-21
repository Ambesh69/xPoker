import { decodeBase58 } from "./wallet-auth.js";

export const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const CORE_XSTOCKS_ALLOWLIST_VERSION = "core-10-v1";

// Verified against the issuer's public v2 asset API. These addresses are used
// only for an authenticated, read-only mainnet lookup in the safe beta.
export const CORE_XSTOCKS = Object.freeze([
  ["AAPLx", "Apple", "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp"],
  ["NVDAx", "NVIDIA", "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh"],
  ["MSFTx", "Microsoft", "XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX"],
  ["AMZNx", "Amazon", "Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg"],
  ["GOOGLx", "Alphabet", "XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN"],
  ["METAx", "Meta", "Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu"],
  ["TSLAx", "Tesla", "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB"],
  ["NFLXx", "Netflix", "XsEH7wWfJJu2ZT3UCFeVfALnVA6CP5ur7Ee11KmzVpL"],
  ["SPYx", "S&P 500 ETF", "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W"],
  ["QQQx", "Nasdaq 100 ETF", "Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ"],
].map(([symbol, name, mint]) => Object.freeze({ symbol, name, mint })));

function validWallet(wallet) {
  try {
    return typeof wallet === "string" && decodeBase58(wallet).length === 32;
  } catch {
    return false;
  }
}

function requestError(message, statusCode = 502, code = "holdings_unavailable") {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

async function jsonRequest(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...options, signal: controller.signal });
    if (!response.ok) throw requestError(`Read-only data source returned HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    if (error?.statusCode) throw error;
    if (error?.name === "AbortError") throw requestError("Read-only holdings lookup timed out", 504);
    throw requestError("Read-only holdings lookup is temporarily unavailable");
  } finally {
    clearTimeout(timer);
  }
}

function parsedTokenAccount(entry) {
  const info = entry?.account?.data?.parsed?.info;
  const amount = info?.tokenAmount?.amount;
  const decimals = info?.tokenAmount?.decimals;
  if (typeof info?.mint !== "string" || typeof amount !== "string" || !/^[0-9]+$/.test(amount)) return undefined;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) return undefined;
  return { mint: info.mint, amount: BigInt(amount), decimals };
}

function displayedAmount(rawAmount, decimals, multiplier) {
  const value = Number(rawAmount) / (10 ** decimals) * multiplier;
  if (!Number.isFinite(value)) return null;
  return value.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 8 });
}

export class ReadOnlyXStocksHoldings {
  constructor({ rpcUrl, apiBase = "https://api.xstocks.fi/api/v2", fetchImpl = fetch, timeoutMs = 6_000 } = {}) {
    if (!rpcUrl) throw new Error("Read-only xStocks holdings require a Solana mainnet RPC URL");
    this.rpcUrl = rpcUrl;
    this.apiBase = apiBase.replace(/\/$/, "");
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async #multiplier(symbol) {
    const payload = await jsonRequest(
      this.fetchImpl,
      `${this.apiBase}/public/assets/${encodeURIComponent(symbol)}/multiplier?network=Solana`,
      { headers: { accept: "application/json" } },
      this.timeoutMs,
    );
    const multiplier = Number(payload.currentMultiplier);
    if (!Number.isFinite(multiplier) || multiplier <= 0) throw requestError("xStocks returned an invalid multiplier");
    return multiplier;
  }

  async read(wallet) {
    if (!validWallet(wallet)) throw requestError("A valid signed Solana wallet is required", 400, "wallet_required");
    const payload = await jsonRequest(this.fetchImpl, this.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "xpoker-readonly-holdings",
        method: "getTokenAccountsByOwner",
        params: [
          wallet,
          { programId: TOKEN_2022_PROGRAM_ID },
          { commitment: "confirmed", encoding: "jsonParsed" },
        ],
      }),
    }, this.timeoutMs);
    if (payload?.error) throw requestError("Solana RPC rejected the read-only holdings lookup");
    if (!Array.isArray(payload?.result?.value)) throw requestError("Solana RPC returned an invalid holdings response");

    const balances = new Map();
    for (const entry of payload.result.value) {
      const account = parsedTokenAccount(entry);
      if (!account) continue;
      const previous = balances.get(account.mint);
      if (previous && previous.decimals !== account.decimals) throw requestError("Solana RPC returned inconsistent token decimals");
      balances.set(account.mint, { amount: (previous?.amount ?? 0n) + account.amount, decimals: account.decimals });
    }

    const holdings = await Promise.all(CORE_XSTOCKS.map(async (asset) => {
      const balance = balances.get(asset.mint);
      if (!balance || balance.amount === 0n) {
        return { ...asset, detected: false, rawAmountAtomic: "0", decimals: null, multiplier: null, displayAmount: "0" };
      }
      try {
        const multiplier = await this.#multiplier(asset.symbol);
        return {
          ...asset,
          detected: true,
          rawAmountAtomic: String(balance.amount),
          decimals: balance.decimals,
          multiplier,
          displayAmount: displayedAmount(balance.amount, balance.decimals, multiplier),
        };
      } catch {
        return {
          ...asset,
          detected: true,
          rawAmountAtomic: String(balance.amount),
          decimals: balance.decimals,
          multiplier: null,
          displayAmount: null,
        };
      }
    }));

    return Object.freeze({
      mode: "read-only",
      network: "solana:mainnet",
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      wallet,
      fetchedAt: new Date().toISOString(),
      allowlistVersion: CORE_XSTOCKS_ALLOWLIST_VERSION,
      allowlistCount: CORE_XSTOCKS.length,
      detectedCount: holdings.filter((holding) => holding.detected).length,
      permissionsRequested: [],
      mintSource: `${this.apiBase}/public/assets/{symbol}`,
      multiplierSource: `${this.apiBase}/public/assets/{symbol}/multiplier?network=Solana`,
      holdings,
    });
  }
}
