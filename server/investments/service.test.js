import assert from "node:assert/strict";
import test from "node:test";

import { InvestmentService } from "./service.js";

test("Jupiter-only investment service exposes wallet holdings without a brokerage rail", async () => {
  const calls = [];
  const service = new InvestmentService({
    holdingsReader: {
      read: async (wallet) => {
        calls.push(["holdings", wallet]);
        return { wallet, network: "solana:mainnet", holdings: [{ symbol: "AAPLx", detected: true }] };
      },
    },
    jupiter: {
      status: () => ({ provider: "jupiter", enabled: true }),
      order: async (input) => { calls.push(["order", input]); return { requestId: "swap_request_123" }; },
      execute: async (input) => { calls.push(["execute", input]); return { status: "Success" }; },
    },
  });

  const status = await service.status("wallet-ignored");
  assert.equal(status.swaps.provider, "jupiter");
  assert.equal(status.walletHoldings.mode, "read-only");
  assert.equal(status.pokerFundsLinked, false);
  assert.equal(Object.hasOwn(status, "brokerage"), false);

  const portfolio = await service.portfolio("wallet-123");
  assert.equal(portfolio.walletHoldings.holdings[0].symbol, "AAPLx");
  assert.deepEqual(calls, [["holdings", "wallet-123"]]);
});

test("Jupiter-only investment service forwards the authenticated wallet to order and execution", async () => {
  const calls = [];
  const service = new InvestmentService({
    holdingsReader: { read: async () => ({ holdings: [] }) },
    jupiter: {
      status: () => ({ provider: "jupiter" }),
      order: async (input) => { calls.push(["order", input]); return { requestId: "swap_request_123" }; },
      execute: async (input) => { calls.push(["execute", input]); return { status: "Success" }; },
    },
  });

  await service.swapOrder({ wallet: "wallet-123", inputSymbol: "USDC", outputSymbol: "NVDAx", amountAtomic: "5000000" });
  await service.executeSwap({ wallet: "wallet-123", requestId: "swap_request_123", signedTransaction: "signed" });
  assert.deepEqual(calls, [
    ["order", { wallet: "wallet-123", inputSymbol: "USDC", outputSymbol: "NVDAx", amountAtomic: "5000000" }],
    ["execute", { wallet: "wallet-123", requestId: "swap_request_123", signedTransaction: "signed" }],
  ]);
});
