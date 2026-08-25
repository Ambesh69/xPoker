import assert from "node:assert/strict";
import test from "node:test";

import { encodeBase58 } from "../wallet-auth.js";
import { TOKEN_2022_PROGRAM } from "./plan.js";
import { SolanaCustodyChain } from "./solana-custody-chain.js";

const key = (byte) => encodeBase58(Buffer.alloc(32, byte));
const txSignature = encodeBase58(Buffer.alloc(64, 9));

function response(result) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: "test", result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("the RPC adapter derives a single finalized transfer from raw pre/post balances", async () => {
  const wallet = key(1);
  const authority = key(2);
  const mint = key(3);
  const source = key(4);
  const destination = key(5);
  const transaction = {
    slot: 123,
    blockTime: 1_777_000_000,
    meta: {
      err: null,
      innerInstructions: [],
      preTokenBalances: [
        { accountIndex: 0, mint, owner: wallet, programId: TOKEN_2022_PROGRAM, uiTokenAmount: { amount: "1000" } },
        { accountIndex: 1, mint, owner: authority, programId: TOKEN_2022_PROGRAM, uiTokenAmount: { amount: "50" } },
      ],
      postTokenBalances: [
        { accountIndex: 0, mint, owner: wallet, programId: TOKEN_2022_PROGRAM, uiTokenAmount: { amount: "900" } },
        { accountIndex: 1, mint, owner: authority, programId: TOKEN_2022_PROGRAM, uiTokenAmount: { amount: "150" } },
      ],
    },
    transaction: {
      message: {
        accountKeys: [{ pubkey: source }, { pubkey: destination }],
        instructions: [{
          programId: TOKEN_2022_PROGRAM,
          parsed: { type: "transferChecked", info: { source, destination, mint, tokenAmount: { amount: "100" } } },
        }],
      },
    },
  };
  const chain = new SolanaCustodyChain({
    rpcUrl: "https://rpc.example",
    fetchImpl: async (_url, options) => {
      const { method } = JSON.parse(options.body);
      if (method === "getSignatureStatuses") return response({ value: [{ confirmationStatus: "finalized", err: null }] });
      if (method === "getTransaction") return response(transaction);
      throw new Error(`Unexpected method ${method}`);
    },
  });
  const result = await chain.getFinalizedTransfer(txSignature);
  assert.equal(result.sourceDeltaAtomic, "100");
  assert.equal(result.destinationDeltaAtomic, "100");
  assert.equal(result.sourceOwner, wallet);
  assert.equal(result.destinationOwner, authority);
});

test("the RPC adapter rejects ambiguous multi-transfer transactions", async () => {
  const source = key(4);
  const destination = key(5);
  const instruction = {
    programId: TOKEN_2022_PROGRAM,
    parsed: { type: "transferChecked", info: { source, destination, mint: key(3) } },
  };
  const chain = new SolanaCustodyChain({
    rpcUrl: "https://rpc.example",
    fetchImpl: async (_url, options) => {
      const { method } = JSON.parse(options.body);
      if (method === "getSignatureStatuses") return response({ value: [{ confirmationStatus: "finalized", err: null }] });
      if (method === "getTransaction") return response({
        slot: 1,
        blockTime: 1,
        meta: { err: null, innerInstructions: [], preTokenBalances: [], postTokenBalances: [] },
        transaction: { message: { accountKeys: [], instructions: [instruction, instruction] } },
      });
      throw new Error("unexpected");
    },
  });
  await assert.rejects(chain.getFinalizedTransfer(txSignature), /exactly one/);
});

test("the RPC adapter rejects finalized transactions without a valid block time", async () => {
  const chain = new SolanaCustodyChain({
    rpcUrl: "https://rpc.example",
    fetchImpl: async (_url, options) => {
      const { method } = JSON.parse(options.body);
      if (method === "getSignatureStatuses") return response({ value: [{ confirmationStatus: "finalized", err: null }] });
      if (method === "getTransaction") return response({
        slot: 1,
        blockTime: null,
        meta: { err: null, innerInstructions: [], preTokenBalances: [], postTokenBalances: [] },
        transaction: { message: { accountKeys: [], instructions: [] } },
      });
      throw new Error("unexpected");
    },
  });
  await assert.rejects(chain.getFinalizedTransfer(txSignature), /valid block time/);
});
