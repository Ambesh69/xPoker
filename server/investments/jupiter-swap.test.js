import assert from "node:assert/strict";
import test from "node:test";

import { encodeBase58 } from "../wallet-auth.js";
import { CORE_XSTOCKS } from "../xstocks-holdings.js";
import { JupiterSwapClient, SWAP_INPUT_ASSETS } from "./jupiter-swap.js";

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test("Jupiter order is bound to the authenticated taker and canonical xStock mint", async () => {
  const wallet = encodeBase58(Buffer.alloc(32, 12));
  let request;
  const client = new JupiterSwapClient({
    apiKey: "jupiter-key", enabled: true,
    fetchImpl: async (url, options) => { request = { url, options }; return jsonResponse({ transaction: "A".repeat(128), requestId: "swap_request_123", outAmount: "42" }); },
  });
  const order = await client.order({ wallet, inputSymbol: "USDC", outputSymbol: "AAPLx", amountAtomic: "25000000" });
  const url = new URL(request.url);
  assert.equal(url.pathname, "/swap/v2/order");
  assert.equal(url.searchParams.get("taker"), wallet);
  assert.equal(url.searchParams.get("inputMint"), SWAP_INPUT_ASSETS[1].mint);
  assert.equal(url.searchParams.get("outputMint"), CORE_XSTOCKS[0].mint);
  assert.equal(request.options.headers["x-api-key"], "jupiter-key");
  assert.equal(order.output.symbol, "AAPLx");
});

test("Jupiter execution accepts only a wallet-bound signed transaction", async () => {
  const wallet = encodeBase58(Buffer.alloc(32, 13));
  let body;
  const client = new JupiterSwapClient({
    apiKey: "jupiter-key", enabled: true,
    fetchImpl: async (_url, options) => { body = JSON.parse(options.body); return jsonResponse({ status: "Success", signature: "sig" }); },
  });
  await client.execute({ wallet, signedTransaction: "A".repeat(128), requestId: "swap_request_123" });
  assert.deepEqual(body, { signedTransaction: "A".repeat(128), requestId: "swap_request_123" });
  await assert.rejects(() => client.execute({ wallet: "bad", signedTransaction: "A".repeat(128), requestId: "swap_request_123" }), /valid signed Solana wallet/);
});

test("Jupiter remains unavailable until explicitly enabled with an API key", async () => {
  const client = new JupiterSwapClient({ apiKey: "jupiter-key", enabled: false });
  assert.equal(client.status().enabled, false);
  await assert.rejects(() => client.order({ wallet: encodeBase58(Buffer.alloc(32, 14)), inputSymbol: "SOL", outputSymbol: "AAPLx", amountAtomic: "1" }), /not configured/);
});

