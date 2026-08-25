import assert from "node:assert/strict";
import test from "node:test";

import { compatibleWallets, connectAndSign, createWalletRegistry, signSerializedTransaction, wrapLegacyProvider } from "./wallet-standard.js";

class FakeWindow extends EventTarget {}

function standardWallet(name = "Test Wallet") {
  const account = { address: "wallet-address", chains: ["solana:mainnet"], features: ["solana:signMessage"] };
  return {
    name,
    chains: ["solana:mainnet"],
    accounts: [],
    features: {
      "standard:connect": { connect: async () => ({ accounts: [account] }) },
      "solana:signMessage": { signMessage: async ({ message }) => [{ account, signedMessage: message, signature: Uint8Array.of(1, 2, 3) }] },
    },
  };
}

test("wallet registry receives wallets registered before and after app readiness", () => {
  const target = new FakeWindow();
  const early = standardWallet("Early");
  target.addEventListener("wallet-standard:app-ready", (event) => event.detail.register(early));
  const registry = createWalletRegistry(target);
  assert.deepEqual(registry.get().map((wallet) => wallet.name), ["Early"]);
  const late = standardWallet("Late");
  const event = new Event("wallet-standard:register-wallet");
  event.detail = ({ register }) => register(late);
  target.dispatchEvent(event);
  assert.deepEqual(registry.get().map((wallet) => wallet.name), ["Early", "Late"]);
});

test("compatible wallet selection prefers a registered standard wallet over its legacy fallback", () => {
  const legacy = standardWallet("Phantom");
  const current = standardWallet("Phantom");
  assert.deepEqual(compatibleWallets([current], [legacy]), [current]);
});

test("standard connection signs only the server-provided login message", async () => {
  const result = await connectAndSign(standardWallet(), (account) => {
    assert.equal(account.address, "wallet-address");
    return "domain-bound challenge";
  });
  assert.equal(result.account.address, "wallet-address");
  assert.deepEqual([...result.signature], [1, 2, 3]);
  assert.equal(new TextDecoder().decode(result.signedMessage), "domain-bound challenge");
});

test("legacy provider wrapper exposes the same connect and sign-message surface", async () => {
  const provider = {
    publicKey: { toString: () => "legacy-wallet", toBytes: () => new Uint8Array(32) },
    connect: async () => ({}),
    signMessage: async () => ({ signature: Uint8Array.of(9, 8, 7) }),
  };
  const wallet = wrapLegacyProvider("Legacy", provider);
  const result = await connectAndSign(wallet, "hello");
  assert.equal(result.account.address, "legacy-wallet");
  assert.deepEqual([...result.signature], [9, 8, 7]);
});

test("standard transaction signing is account-bound and returns serialized bytes", async () => {
  const account = { address: "wallet-address", chains: ["solana:mainnet"], features: ["solana:signMessage", "solana:signTransaction"] };
  const wallet = standardWallet();
  wallet.features["standard:connect"].connect = async () => ({ accounts: [account] });
  wallet.features["solana:signTransaction"] = {
    signTransaction: async ({ transaction, chain }) => {
      assert.equal(chain, "solana:mainnet");
      return [{ signedTransaction: Uint8Array.from([...transaction, 9]) }];
    },
  };
  const result = await signSerializedTransaction(wallet, { transaction: new Uint8Array(40), walletAddress: "wallet-address" });
  assert.equal(result.account.address, "wallet-address");
  assert.equal(result.signedTransaction.at(-1), 9);
  await assert.rejects(() => signSerializedTransaction(wallet, { transaction: new Uint8Array(40), walletAddress: "other" }), /same Solana account/);
});
