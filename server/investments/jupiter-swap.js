import { decodeBase58 } from "../wallet-auth.js";
import { CORE_XSTOCKS } from "../xstocks-holdings.js";

export const SWAP_INPUT_ASSETS = Object.freeze([
  Object.freeze({ symbol: "SOL", name: "Solana", mint: "So11111111111111111111111111111111111111112", decimals: 9 }),
  Object.freeze({ symbol: "USDC", name: "USD Coin", mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6 }),
]);

function swapError(message, statusCode = 502, code = "swap_provider_error") {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function validWallet(value) {
  try { return typeof value === "string" && decodeBase58(value).length === 32; } catch { return false; }
}

function atomicAmount(value) {
  const amount = String(value ?? "");
  if (!/^[1-9][0-9]{0,19}$/.test(amount)) throw swapError("Swap amount must be a positive atomic-unit integer", 400, "invalid_swap_amount");
  return amount;
}

export class JupiterSwapClient {
  constructor({
    baseUrl = "https://api.jup.ag/swap/v2",
    apiKey,
    enabled = false,
    fetchImpl = fetch,
    timeoutMs = 12_000,
  } = {}) {
    const url = new URL(baseUrl);
    if (url.protocol !== "https:") throw new Error("Jupiter API must use HTTPS");
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
    this.enabled = Boolean(enabled && apiKey);
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  status() {
    return Object.freeze({
      provider: "jupiter",
      configured: Boolean(this.apiKey),
      enabled: this.enabled,
      custody: "self-custodial",
      signatureOwner: "connected-wallet",
      supportedInputs: SWAP_INPUT_ASSETS,
    });
  }

  async #request(path, { method = "GET", body } = {}) {
    if (!this.enabled) throw swapError("Wallet swaps are not configured", 503, "swap_unavailable");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          accept: "application/json",
          "x-api-key": this.apiKey,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.errorCode) {
        const detail = payload?.errorMessage || payload?.message || `Jupiter returned HTTP ${response.status}`;
        throw swapError(detail, response.status >= 500 ? 502 : response.status, "swap_request_rejected");
      }
      return payload;
    } catch (error) {
      if (error?.statusCode) throw error;
      if (error?.name === "AbortError") throw swapError("Swap quote timed out", 504, "swap_timeout");
      throw swapError("Jupiter is temporarily unavailable");
    } finally {
      clearTimeout(timer);
    }
  }

  async order({ wallet, inputSymbol, outputSymbol, amountAtomic }) {
    if (!validWallet(wallet)) throw swapError("A valid signed Solana wallet is required", 400, "wallet_required");
    const input = SWAP_INPUT_ASSETS.find((asset) => asset.symbol === String(inputSymbol).toUpperCase());
    const output = CORE_XSTOCKS.find((asset) => asset.symbol === String(outputSymbol));
    if (!input || !output) throw swapError("Choose a supported input and Core 10 xStock", 400, "asset_not_allowed");
    const query = new URLSearchParams({
      inputMint: input.mint,
      outputMint: output.mint,
      amount: atomicAmount(amountAtomic),
      taker: wallet,
    });
    const result = await this.#request(`/order?${query}`);
    if (typeof result.transaction !== "string" || typeof result.requestId !== "string") {
      throw swapError("Jupiter returned an incomplete swap order");
    }
    return Object.freeze({ ...result, input, output, wallet });
  }

  async execute({ wallet, signedTransaction, requestId }) {
    if (!validWallet(wallet)) throw swapError("A valid signed Solana wallet is required", 400, "wallet_required");
    if (typeof signedTransaction !== "string" || signedTransaction.length < 64 || signedTransaction.length > 12_000) {
      throw swapError("A signed Solana transaction is required", 400, "signed_transaction_required");
    }
    if (typeof requestId !== "string" || !/^[a-zA-Z0-9_-]{8,160}$/.test(requestId)) {
      throw swapError("A valid Jupiter request ID is required", 400, "invalid_swap_request");
    }
    return this.#request("/execute", { method: "POST", body: { signedTransaction, requestId } });
  }
}

