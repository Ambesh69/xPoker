import { TOKEN_2022_PROGRAM } from "./plan.js";
import { clusterChainId } from "./custody.js";

function fail(message, code = "solana_rpc_invalid") {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function pubkey(value) {
  return typeof value === "string" ? value : value?.pubkey;
}

function parsedInfo(value) {
  return value?.data?.parsed?.info;
}

function extensionNames(extensions) {
  if (!Array.isArray(extensions)) return [];
  return extensions.map((entry) => {
    const value = entry?.extension ?? entry?.type ?? Object.keys(entry ?? {})[0];
    return typeof value === "string" ? value.replace(/Config$/, "") : "";
  }).filter(Boolean);
}

function tokenBalanceMap(items, keys) {
  const balances = new Map();
  for (const item of items ?? []) {
    const address = pubkey(keys[item.accountIndex]);
    const amount = item?.uiTokenAmount?.amount;
    if (!address || typeof amount !== "string" || !/^[0-9]+$/.test(amount)) continue;
    balances.set(address, {
      amount: BigInt(amount),
      mint: item.mint,
      owner: item.owner,
      programId: item.programId,
    });
  }
  return balances;
}

function transferInstructions(transaction) {
  const output = [];
  const outer = transaction?.transaction?.message?.instructions ?? [];
  for (let index = 0; index < outer.length; index += 1) output.push({ instruction: outer[index], index: output.length });
  for (const group of transaction?.meta?.innerInstructions ?? []) {
    for (const instruction of group.instructions ?? []) output.push({ instruction, index: output.length });
  }
  return output.filter(({ instruction }) => {
    const type = instruction?.parsed?.type;
    return instruction?.programId === TOKEN_2022_PROGRAM && ["transfer", "transferChecked"].includes(type);
  });
}

export class SolanaCustodyChain {
  constructor({ rpcUrl, cluster = "devnet", fetchImpl = fetch, timeoutMs = 8_000, withdrawalSubmitter } = {}) {
    const endpoint = new URL(rpcUrl);
    if (endpoint.protocol !== "https:") throw new Error("Solana custody RPC must use HTTPS");
    if (!Number.isInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 30_000) throw new Error("Solana RPC timeout is invalid");
    this.rpcUrl = endpoint.href;
    this.cluster = cluster;
    this.chainId = clusterChainId(cluster);
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.withdrawalSubmitter = withdrawalSubmitter;
  }

  async #rpc(method, params) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: `xpoker-${method}`, method, params }),
        signal: controller.signal,
      });
      if (!response.ok) fail(`Solana RPC returned HTTP ${response.status}`, "solana_rpc_unavailable");
      const body = await response.json();
      if (body?.error) fail(`Solana RPC rejected ${method}: ${body.error.message ?? body.error.code}`);
      return body?.result;
    } catch (error) {
      if (error?.code) throw error;
      if (error?.name === "AbortError") fail("Solana RPC timed out", "solana_rpc_timeout");
      fail("Solana RPC is unavailable", "solana_rpc_unavailable");
    } finally {
      clearTimeout(timer);
    }
  }

  async inspectMint(mint) {
    const result = await this.#rpc("getAccountInfo", [mint, { commitment: "finalized", encoding: "jsonParsed" }]);
    if (result?.value?.owner !== TOKEN_2022_PROGRAM) fail("Mint is not owned by Token-2022", "invalid_token_program");
    const info = parsedInfo(result.value);
    if (!info || !Number.isInteger(info.decimals)) fail("Solana RPC did not return parsed mint data");
    return {
      cluster: this.cluster,
      mint,
      tokenProgram: result.value.owner,
      decimals: info.decimals,
      extensions: extensionNames(info.extensions),
      mintAuthority: info.mintAuthority ?? null,
      freezeAuthority: info.freezeAuthority ?? null,
    };
  }

  async inspectTokenAccount(address) {
    const result = await this.#rpc("getAccountInfo", [address, { commitment: "finalized", encoding: "jsonParsed" }]);
    if (result?.value?.owner !== TOKEN_2022_PROGRAM) fail("Token account is not owned by Token-2022", "invalid_token_program");
    const info = parsedInfo(result.value);
    if (!info?.mint || !info?.owner) fail("Solana RPC did not return parsed token-account data");
    return {
      chainId: this.chainId,
      address,
      mint: info.mint,
      owner: info.owner,
      tokenProgram: result.value.owner,
      state: info.state,
      amountAtomic: info.tokenAmount?.amount,
    };
  }

  async getFinalizedTransfer(signature) {
    const [status, transaction] = await Promise.all([
      this.#rpc("getSignatureStatuses", [[signature], { searchTransactionHistory: true }]),
      this.#rpc("getTransaction", [signature, {
        commitment: "finalized",
        encoding: "jsonParsed",
        maxSupportedTransactionVersion: 0,
      }]),
    ]);
    const signatureStatus = status?.value?.[0];
    if (!signatureStatus || signatureStatus.confirmationStatus !== "finalized") {
      fail("Transaction is not finalized", "transfer_not_finalized");
    }
    if (!transaction) fail("Finalized transaction is unavailable", "transfer_not_found");
    if (!Number.isSafeInteger(transaction.blockTime) || transaction.blockTime <= 0) {
      fail("Finalized transaction is missing a valid block time", "invalid_block_time");
    }
    const candidates = transferInstructions(transaction);
    if (candidates.length !== 1) fail("Custody transaction must contain exactly one Token-2022 transfer", "ambiguous_transfer");
    const { instruction, index } = candidates[0];
    const info = instruction.parsed.info;
    const keys = transaction.transaction.message.accountKeys;
    const pre = tokenBalanceMap(transaction.meta?.preTokenBalances, keys);
    const post = tokenBalanceMap(transaction.meta?.postTokenBalances, keys);
    const sourceAddress = info.source;
    const destinationAddress = info.destination;
    const sourceBefore = pre.get(sourceAddress);
    const sourceAfter = post.get(sourceAddress);
    const destinationBefore = pre.get(destinationAddress);
    const destinationAfter = post.get(destinationAddress);
    if (!sourceBefore || !sourceAfter || !destinationAfter) fail("Transaction token balance deltas are incomplete");
    const sourceDelta = sourceBefore.amount - sourceAfter.amount;
    const destinationDelta = destinationAfter.amount - (destinationBefore?.amount ?? 0n);
    if (sourceDelta <= 0n || destinationDelta <= 0n) fail("Transaction does not move positive token balances");
    const mint = info.mint ?? sourceBefore.mint ?? destinationAfter.mint;
    if (!mint || sourceBefore.mint !== mint || destinationAfter.mint !== mint) fail("Transaction mint is inconsistent");
    return {
      status: "finalized",
      succeeded: signatureStatus.err === null && transaction.meta?.err === null,
      chainId: this.chainId,
      signature,
      instructionIndex: index,
      finalizedSlot: String(transaction.slot),
      tokenProgram: instruction.programId,
      mint,
      sourceTokenAccount: sourceAddress,
      destinationTokenAccount: destinationAddress,
      sourceOwner: sourceBefore.owner ?? sourceAfter.owner,
      destinationOwner: destinationAfter.owner ?? destinationBefore?.owner,
      sourceDeltaAtomic: String(sourceDelta),
      destinationDeltaAtomic: String(destinationDelta),
      finalizedAt: new Date(transaction.blockTime * 1_000).toISOString(),
    };
  }

  async submitWithdrawal(request) {
    if (typeof this.withdrawalSubmitter !== "function") {
      fail("Withdrawal signer/HSM integration is not configured", "withdrawal_signer_unavailable");
    }
    return this.withdrawalSubmitter(request);
  }

  async getFinalizedTokenBalance(address) {
    const [balance, slot, account] = await Promise.all([
      this.#rpc("getTokenAccountBalance", [address, { commitment: "finalized" }]),
      this.#rpc("getSlot", [{ commitment: "finalized" }]),
      this.inspectTokenAccount(address),
    ]);
    if (typeof balance?.value?.amount !== "string" || !/^[0-9]+$/.test(balance.value.amount)) {
      fail("Solana RPC returned an invalid token balance");
    }
    return {
      status: "finalized",
      chainId: this.chainId,
      mint: account.mint,
      amountAtomic: balance.value.amount,
      finalizedSlot: String(slot),
    };
  }
}
