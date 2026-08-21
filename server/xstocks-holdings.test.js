import assert from "node:assert/strict";
import test from "node:test";

import { encodeBase58 } from "./wallet-auth.js";
import { CORE_XSTOCKS, CORE_XSTOCKS_ALLOWLIST_VERSION, ReadOnlyXStocksHoldings, TOKEN_2022_PROGRAM_ID } from "./xstocks-holdings.js";

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test("core xStocks contains ten unique issuer mints", () => {
  assert.equal(CORE_XSTOCKS.length, 10);
  assert.equal(new Set(CORE_XSTOCKS.map((asset) => asset.symbol)).size, 10);
  assert.equal(new Set(CORE_XSTOCKS.map((asset) => asset.mint)).size, 10);
});

test("read-only holdings aggregate Token-2022 accounts and apply the issuer multiplier", async () => {
  const wallet = encodeBase58(Buffer.alloc(32, 8));
  const asset = CORE_XSTOCKS[0];
  const calls = [];
  const reader = new ReadOnlyXStocksHoldings({
    rpcUrl: "https://rpc.example",
    apiBase: "https://issuer.example/api/v2",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url === "https://rpc.example") {
        return jsonResponse({ result: { value: [
          { account: { data: { parsed: { info: { mint: asset.mint, tokenAmount: { amount: "1250000", decimals: 6 } } } } } },
          { account: { data: { parsed: { info: { mint: asset.mint, tokenAmount: { amount: "250000", decimals: 6 } } } } } },
          { account: { data: { parsed: { info: { mint: "ignored", tokenAmount: { amount: "99", decimals: 2 } } } } } },
        ] } });
      }
      assert.equal(url, `https://issuer.example/api/v2/public/assets/${asset.symbol}/multiplier?network=Solana`);
      return jsonResponse({ currentMultiplier: 1.2 });
    },
  });
  const result = await reader.read(wallet);
  assert.equal(result.mode, "read-only");
  assert.equal(result.allowlistVersion, CORE_XSTOCKS_ALLOWLIST_VERSION);
  assert.equal(result.detectedCount, 1);
  assert.deepEqual(result.permissionsRequested, []);
  assert.equal(result.holdings[0].rawAmountAtomic, "1500000");
  assert.equal(result.holdings[0].displayAmount, "1.8");
  assert.equal(result.holdings[1].detected, false);
  const rpcBody = JSON.parse(calls[0].options.body);
  assert.equal(rpcBody.method, "getTokenAccountsByOwner");
  assert.equal(rpcBody.params[1].programId, TOKEN_2022_PROGRAM_ID);
});

test("read-only holdings preserve exact raw balance when multiplier lookup is unavailable", async () => {
  const wallet = encodeBase58(Buffer.alloc(32, 6));
  const asset = CORE_XSTOCKS[2];
  const reader = new ReadOnlyXStocksHoldings({
    rpcUrl: "https://rpc.example",
    fetchImpl: async (url) => url === "https://rpc.example"
      ? jsonResponse({ result: { value: [{ account: { data: { parsed: { info: {
        mint: asset.mint,
        tokenAmount: { amount: "900719925474099312345", decimals: 8 },
      } } } } }] } })
      : jsonResponse({}, 503),
  });
  const result = await reader.read(wallet);
  const holding = result.holdings.find((item) => item.symbol === asset.symbol);
  assert.equal(holding.rawAmountAtomic, "900719925474099312345");
  assert.equal(holding.multiplier, null);
  assert.equal(holding.displayAmount, null);
});

test("read-only holdings reject non-Solana session identities before RPC access", async () => {
  let fetched = false;
  const reader = new ReadOnlyXStocksHoldings({
    rpcUrl: "https://rpc.example",
    fetchImpl: async () => { fetched = true; },
  });
  await assert.rejects(() => reader.read("guest:not-a-wallet"), /valid signed Solana wallet/i);
  assert.equal(fetched, false);
});
