import assert from "node:assert/strict";
import test from "node:test";

import { createCompliancePolicy } from "./compliance/policy.js";
import { PostgresComplianceService } from "./compliance/service.js";
import { applyMigrations } from "./migrate.js";
import { createPostgresPool } from "./postgres-hand-store.js";
import { canonicalMintProfile } from "./settlement/custody.js";
import { PostgresCustodyService, inMemoryCustodyChain } from "./settlement/custody-service.js";
import { TOKEN_2022_PROGRAM } from "./settlement/plan.js";
import { encodeBase58 } from "./wallet-auth.js";

const connectionString = process.env.DATABASE_URL_TEST;
const key = (byte) => encodeBase58(Buffer.alloc(32, byte));
const txSignature = (byte) => encodeBase58(Buffer.alloc(64, byte));

test("compliance evidence gates devnet deposits, dual-approved withdrawals and reconciliation", {
  skip: !connectionString,
}, async () => {
  const pool = await createPostgresPool({ connectionString });
  await applyMigrations({ pool });
  const suffix = `${process.pid}-${Date.now()}`;
  const wallet = key(41);
  const operatorA = key(42);
  const operatorB = key(43);
  const mint = key(44);
  const vaultAddress = key(45);
  const authorityAddress = key(46);
  const sourceTokenAccount = key(47);
  const destinationTokenAccount = key(48);
  const mintProfile = canonicalMintProfile({
    cluster: "devnet",
    mint,
    tokenProgram: TOKEN_2022_PROGRAM,
    decimals: 8,
    extensions: ["scaledUiAmount", "metadataPointer", "tokenMetadata"],
    mintAuthority: key(49),
    freezeAuthority: key(50),
  });
  let now = new Date();
  const observedAt = new Date(now.getTime() - 60_000).toISOString();
  const expiresAt = new Date(now.getTime() + 86_400_000).toISOString();
  let finalizedTransfer;
  let vaultBalanceAtomic = "0";
  const chain = inMemoryCustodyChain({
    inspectMint: async () => ({
      cluster: "devnet",
      mint,
      tokenProgram: TOKEN_2022_PROGRAM,
      decimals: 8,
      extensions: ["scaledUiAmount", "metadataPointer", "tokenMetadata"],
      mintAuthority: key(49),
      freezeAuthority: key(50),
    }),
    inspectTokenAccount: async (address) => ({
      chainId: "solana:devnet",
      mint,
      owner: address === sourceTokenAccount || address === destinationTokenAccount ? wallet : authorityAddress,
      tokenProgram: TOKEN_2022_PROGRAM,
      state: "initialized",
    }),
    getFinalizedTransfer: async () => finalizedTransfer,
    submitWithdrawal: async () => ({ signature: txSignature(52) }),
    getFinalizedTokenBalance: async () => ({
      status: "finalized",
      chainId: "solana:devnet",
      mint,
      amountAtomic: vaultBalanceAtomic,
      finalizedSlot: "9003",
    }),
  });

  try {
    await pool.query(
      `INSERT INTO asset_allowlist (
         mint_address, chain_id, token_program, symbol, decimals, multiplier_source,
         price_source, version, enabled, metadata
       ) VALUES ($1, 'solana:devnet', 'spl-token-2022', $2, 8, 'test', 'test', $3, true, $4)`,
      [mint, `T${process.pid}`, `devnet-${suffix}`, { simulation: true }],
    );
    const vaultResult = await pool.query(
      `INSERT INTO custody_vaults (
         chain_id, asset_mint, token_program, decimals, allowlist_version,
         mint_configuration_sha256, supported_extensions, vault_address, authority_address,
         authority_mode, status
       ) VALUES ('solana:devnet', $1, 'spl-token-2022', 8, $2, $3, $4, $5, $6, 'escrow_program', 'active')
       RETURNING id`,
      [
        mint, `devnet-${suffix}`, Buffer.from(mintProfile.sha256, "hex"), mintProfile.extensions,
        vaultAddress, authorityAddress,
      ],
    );
    assert.equal(vaultResult.rowCount, 1);

    const providers = {
      identity: "identity-test",
      sanctions: "sanctions-test",
      geolocation: "geofence-test",
      source_of_funds: "funds-test",
      xstocks_eligibility: "xstocks-test",
    };
    const compliance = new PostgresComplianceService({
      pool,
      policy: createCompliancePolicy({
        version: "integration-policy-v1",
        policySha256: "ab".repeat(32),
        allowedCountries: ["CH"],
        minimumAge: 21,
      }),
      providers,
      clock: () => now,
    });
    for (const kind of Object.keys(providers)) {
      await compliance.recordEvidence({
        wallet,
        kind,
        provider: providers[kind],
        providerReference: `${kind}-${suffix}`,
        status: "pass",
        countryCode: "CH",
        minimumAgeMet: kind === "identity" ? true : undefined,
        verifiedMinimumAge: kind === "identity" ? 21 : undefined,
        usPerson: kind === "identity" ? false : undefined,
        sanctionsMatch: kind === "sanctions" ? false : undefined,
        pepMatch: kind === "sanctions" ? false : undefined,
        walletEligible: kind === "xstocks_eligibility" ? true : undefined,
        evidenceSha256: "cd".repeat(32),
        idempotencyKey: `evidence:${kind}:${suffix}`,
        observedAt,
        expiresAt,
      });
    }
    const eligibility = await compliance.evaluateEligibility({
      wallet,
      product: "deposit",
      amountUsdMinor: "10000",
    });
    assert.equal(eligibility.eligible, true);
    assert.equal(eligibility.evidenceIds.length, 5);

    const custody = new PostgresCustodyService({
      pool,
      compliance,
      chain,
      cluster: "devnet",
      withdrawalApprovalQuorum: 2,
      withdrawalCoolingOffSeconds: 60,
      authorizeOperator: async (operator) => [operatorA, operatorB].includes(operator),
      clock: () => now,
    });
    const deposit = await custody.createDepositIntent({
      wallet,
      assetMint: mint,
      sourceTokenAccount,
      expectedAmountAtomic: "1000",
      minimumCreditAtomic: "1000",
      valuationUsdMinor: "10000",
      priceSnapshotSha256: "ef".repeat(32),
      idempotencyKey: `deposit:${suffix}`,
    });
    finalizedTransfer = {
      status: "finalized",
      succeeded: true,
      chainId: "solana:devnet",
      signature: txSignature(51),
      instructionIndex: 0,
      finalizedSlot: "9001",
      tokenProgram: TOKEN_2022_PROGRAM,
      mint,
      sourceTokenAccount,
      destinationTokenAccount: vaultAddress,
      sourceOwner: wallet,
      destinationOwner: authorityAddress,
      sourceDeltaAtomic: "1000",
      destinationDeltaAtomic: "1000",
      finalizedAt: now.toISOString(),
    };
    assert.equal((await custody.creditFinalizedDeposit({
      intentId: deposit.id,
      chainSignature: finalizedTransfer.signature,
    })).amountAtomic, "1000");
    vaultBalanceAtomic = "1000";

    const withdrawal = await custody.createWithdrawalRequest({
      wallet,
      assetMint: mint,
      destinationTokenAccount,
      amountAtomic: "400",
      idempotencyKey: `withdrawal:${suffix}`,
    });
    assert.equal((await custody.approveWithdrawal({
      withdrawalId: withdrawal.id,
      operatorWallet: operatorA,
    })).status, "held");
    assert.equal((await custody.approveWithdrawal({
      withdrawalId: withdrawal.id,
      operatorWallet: operatorB,
    })).status, "approved");
    now = new Date(now.getTime() + 61_000);
    assert.equal((await custody.submitWithdrawal({ withdrawalId: withdrawal.id })).status, "submitted");
    finalizedTransfer = {
      status: "finalized",
      succeeded: true,
      chainId: "solana:devnet",
      signature: txSignature(52),
      instructionIndex: 0,
      finalizedSlot: "9002",
      tokenProgram: TOKEN_2022_PROGRAM,
      mint,
      sourceTokenAccount: vaultAddress,
      destinationTokenAccount,
      sourceOwner: authorityAddress,
      destinationOwner: wallet,
      sourceDeltaAtomic: "400",
      destinationDeltaAtomic: "400",
      finalizedAt: now.toISOString(),
    };
    assert.equal((await custody.finalizeWithdrawal({ withdrawalId: withdrawal.id })).amountAtomic, "400");
    vaultBalanceAtomic = "600";
    assert.equal((await custody.reconcileVault({ assetMint: mint })).status, "balanced");

    await assert.rejects(
      pool.query("UPDATE compliance_evidence SET status = 'fail' WHERE wallet_address = $1", [wallet]),
      /append-only/,
    );
    const playerBalance = await pool.query(
      `SELECT SUM(CASE entry.direction WHEN 'credit' THEN entry.amount_atomic ELSE -entry.amount_atomic END)::text AS balance
         FROM ledger_entries AS entry
         JOIN ledger_transactions AS transaction ON transaction.id = entry.transaction_id AND transaction.status = 'posted'
         JOIN ledger_accounts AS account ON account.id = entry.account_id
        WHERE account.owner_wallet = $1 AND entry.asset_mint = $2`,
      [wallet, mint],
    );
    assert.equal(playerBalance.rows[0].balance, "600");
  } finally {
    await pool.end();
  }
});
