import { createHash } from "node:crypto";

import { canonicalJson } from "../../fairness/protocol.js";
import { assertEligible } from "../compliance/policy.js";
import { decodeBase58, encodeBase58 } from "../wallet-auth.js";
import {
  assertPinnedMintProfile,
  clusterChainId,
  reconcileCustody,
  validateFinalizedTransfer,
} from "./custody.js";
import { TOKEN_2022_PROGRAM } from "./plan.js";

function fail(message, statusCode = 400, code = "invalid_request") {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  throw error;
}

function publicKey(value, label) {
  try {
    const bytes = decodeBase58(value);
    if (bytes.length !== 32 || encodeBase58(bytes) !== value) throw new Error();
    return value;
  } catch {
    fail(`${label} must be a canonical Solana public key`);
  }
}

function u64(value, label) {
  try {
    const parsed = BigInt(value);
    if (parsed < 1n || parsed > 18_446_744_073_709_551_615n) throw new Error();
    return parsed;
  } catch {
    fail(`${label} must be an unsigned 64-bit integer greater than zero`);
  }
}

function hex32(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/i.test(value) || /^0{64}$/i.test(value)) {
    fail(`${label} must be a nonzero SHA-256 digest`);
  }
  return Buffer.from(value, "hex");
}

function idempotency(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{16,128}$/.test(value)) fail("Idempotency key is invalid");
  return value;
}

function vaultFromRow(row) {
  return {
    id: row.id,
    chainId: row.chain_id,
    assetMint: row.asset_mint,
    tokenProgram: row.token_program,
    decimals: row.decimals,
    allowlistVersion: row.allowlist_version,
    mintConfigurationSha256: Buffer.from(row.mint_configuration_sha256).toString("hex"),
    supportedExtensions: row.supported_extensions,
    vaultAddress: row.vault_address,
    authorityAddress: row.authority_address,
    authorityMode: row.authority_mode,
    status: row.status,
  };
}

function chainObservationValues(observation, operationId) {
  return [
    observation.operation,
    operationId,
    observation.chainId,
    observation.signature,
    observation.instructionIndex,
    observation.finalizedSlot,
    observation.mint,
    "spl-token-2022",
    observation.sourceTokenAccount,
    observation.destinationTokenAccount,
    observation.sourceOwner,
    observation.destinationOwner,
    observation.sourceDeltaAtomic,
    observation.destinationDeltaAtomic,
    Buffer.from(observation.payloadSha256, "hex"),
    observation.finalizedAt,
  ];
}

function atomicFromRow(value) {
  return typeof value === "bigint" ? value : BigInt(value ?? 0);
}

export class PostgresCustodyService {
  constructor({
    pool,
    compliance,
    chain,
    cluster = "devnet",
    mainnetAuthorized = false,
    withdrawalApprovalQuorum = 2,
    withdrawalCoolingOffSeconds = 900,
    authorizeOperator = async () => false,
    clock = () => new Date(),
  } = {}) {
    if (!pool?.query || !pool?.connect) throw new Error("Custody service requires PostgreSQL");
    if (!compliance?.evaluateEligibility) throw new Error("Custody service requires compliance eligibility");
    for (const method of ["inspectMint", "inspectTokenAccount", "getFinalizedTransfer", "submitWithdrawal", "getFinalizedTokenBalance"]) {
      if (typeof chain?.[method] !== "function") throw new Error(`Custody chain adapter requires ${method}`);
    }
    if (!Number.isInteger(withdrawalApprovalQuorum) || withdrawalApprovalQuorum < 2 || withdrawalApprovalQuorum > 9) {
      throw new Error("Withdrawal approval quorum is invalid");
    }
    if (!Number.isInteger(withdrawalCoolingOffSeconds) || withdrawalCoolingOffSeconds < 60 || withdrawalCoolingOffSeconds > 604_800) {
      throw new Error("Withdrawal cooling-off period is invalid");
    }
    this.pool = pool;
    this.compliance = compliance;
    this.chain = chain;
    this.cluster = cluster;
    this.chainId = clusterChainId(cluster);
    this.mainnetAuthorized = mainnetAuthorized === true;
    this.withdrawalApprovalQuorum = withdrawalApprovalQuorum;
    this.withdrawalCoolingOffSeconds = withdrawalCoolingOffSeconds;
    this.authorizeOperator = authorizeOperator;
    this.clock = clock;
  }

  #assertValueMutationAllowed() {
    if (this.cluster === "mainnet-beta" && !this.mainnetAuthorized) {
      fail("Mainnet custody is blocked by release gates", 503, "mainnet_release_blocked");
    }
  }

  async #availableVault(assetMint, operation) {
    const statuses = {
      deposit: ["active"],
      withdrawal: ["active", "deposits_paused"],
      reconciliation: ["active", "deposits_paused", "withdrawals_paused", "frozen"],
    }[operation];
    if (!statuses) throw new Error("Custody vault operation is invalid");
    const result = await this.pool.query(
      `SELECT vault.*
         FROM custody_vaults AS vault
         JOIN asset_allowlist AS asset
           ON asset.mint_address = vault.asset_mint
          AND asset.chain_id = vault.chain_id
          AND asset.version = vault.allowlist_version
          AND asset.enabled = true
        WHERE vault.chain_id = $1 AND vault.asset_mint = $2 AND vault.status = ANY($3::text[])`,
      [this.chainId, publicKey(assetMint, "Asset mint"), statuses],
    );
    if (result.rowCount !== 1) fail("Asset custody vault is unavailable", 503, "vault_unavailable");
    const vault = vaultFromRow(result.rows[0]);
    assertPinnedMintProfile(await this.chain.inspectMint(vault.assetMint), vault);
    return vault;
  }

  async createDepositIntent({
    wallet,
    assetMint,
    sourceTokenAccount,
    expectedAmountAtomic,
    minimumCreditAtomic = expectedAmountAtomic,
    valuationUsdMinor,
    priceSnapshotSha256,
    idempotencyKey,
  } = {}) {
    this.#assertValueMutationAllowed();
    const canonicalWallet = publicKey(wallet, "Wallet");
    const expected = u64(expectedAmountAtomic, "Expected deposit amount");
    const minimum = u64(minimumCreditAtomic, "Minimum deposit credit");
    if (minimum > expected) fail("Minimum deposit credit cannot exceed expected amount");
    const valuation = u64(valuationUsdMinor, "Deposit USD valuation");
    const decision = assertEligible(await this.compliance.evaluateEligibility({
      wallet: canonicalWallet,
      product: "deposit",
      amountUsdMinor: String(valuation),
    }));
    const vault = await this.#availableVault(assetMint, "deposit");
    const source = publicKey(sourceTokenAccount, "Source token account");
    const account = await this.chain.inspectTokenAccount(source);
    if (account?.chainId !== this.chainId
      || account?.mint !== vault.assetMint
      || account?.owner !== canonicalWallet
      || account?.tokenProgram !== TOKEN_2022_PROGRAM
      || account?.state !== "initialized") {
      fail("Source token account does not belong to the eligible wallet and mint", 400, "source_account_mismatch");
    }
    const now = this.clock();
    const result = await this.pool.query(
      `INSERT INTO value_deposit_intents (
         wallet_address, custody_vault_id, compliance_decision_id, source_token_account,
         expected_amount_atomic, minimum_credit_atomic, valuation_usd_minor,
         price_snapshot_sha256, status, idempotency_key, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'created', $9, $10)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING *`,
      [
        canonicalWallet, vault.id, decision.id, source, String(expected), String(minimum),
        String(valuation), hex32(priceSnapshotSha256, "Price snapshot"), idempotency(idempotencyKey),
        new Date(now.getTime() + 10 * 60_000).toISOString(),
      ],
    );
    if (result.rowCount !== 1) {
      const prior = await this.pool.query("SELECT * FROM value_deposit_intents WHERE idempotency_key = $1", [idempotencyKey]);
      if (prior.rowCount !== 1
        || prior.rows[0].wallet_address !== canonicalWallet
        || prior.rows[0].custody_vault_id !== vault.id
        || atomicFromRow(prior.rows[0].expected_amount_atomic) !== expected
        || prior.rows[0].source_token_account !== source) {
        fail("Idempotency key was reused with a different deposit", 409, "idempotency_conflict");
      }
      return { ...prior.rows[0], vault };
    }
    return { ...result.rows[0], vault };
  }

  async creditFinalizedDeposit({ intentId, chainSignature } = {}) {
    this.#assertValueMutationAllowed();
    const loaded = await this.pool.query(
      `SELECT intent.*, vault.*,
              intent.id AS intent_id, vault.id AS vault_id,
              intent.status AS intent_status, vault.status AS vault_status
         FROM value_deposit_intents AS intent
         JOIN custody_vaults AS vault ON vault.id = intent.custody_vault_id
        WHERE intent.id = $1`,
      [intentId],
    );
    if (loaded.rowCount !== 1) fail("Deposit intent was not found", 404, "not_found");
    const row = loaded.rows[0];
    const vault = vaultFromRow({ ...row, id: row.vault_id, status: row.vault_status });
    const transfer = await this.chain.getFinalizedTransfer(chainSignature);
    const observation = validateFinalizedTransfer({
      operation: "deposit",
      transfer,
      vault,
      wallet: row.wallet_address,
      amountAtomic: row.expected_amount_atomic,
      minimumCreditAtomic: row.minimum_credit_atomic,
    });
    if (observation.sourceTokenAccount !== row.source_token_account) {
      fail("Deposit originated from a different token account", 400, "transfer_mismatch");
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query(
        `SELECT intent.*, vault.asset_mint
           FROM value_deposit_intents AS intent
           JOIN custody_vaults AS vault ON vault.id = intent.custody_vault_id
          WHERE intent.id = $1 FOR UPDATE OF intent`,
        [intentId],
      );
      if (locked.rowCount !== 1) fail("Deposit intent was not found", 404, "not_found");
      const intent = locked.rows[0];
      if (intent.status === "credited") {
        if (intent.chain_signature !== observation.signature) fail("Deposit intent already used another transfer", 409, "transfer_conflict");
        await client.query("COMMIT");
        return { intentId, status: "credited", amountAtomic: String(intent.actual_credit_atomic), duplicate: true };
      }
      if (!["created", "submitted", "finalized"].includes(intent.status)) {
        fail("Deposit intent cannot be credited in its current state", 409, "deposit_state_conflict");
      }
      if (Date.parse(intent.expires_at) <= this.clock().getTime()) fail("Deposit intent expired", 409, "deposit_expired");
      await client.query(
        `INSERT INTO value_chain_observations (
           operation_type, operation_id, chain_id, chain_signature, instruction_index,
           finalized_slot, asset_mint, token_program, source_token_account,
           destination_token_account, source_owner, destination_owner,
           source_delta_atomic, destination_delta_atomic, payload_sha256, finalized_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        chainObservationValues(observation, intentId),
      );
      const custodyAccount = await client.query(
        `INSERT INTO ledger_accounts (owner_wallet, purpose)
         VALUES (NULL, 'deposit')
         ON CONFLICT (owner_wallet, purpose) DO UPDATE SET purpose = EXCLUDED.purpose
         RETURNING id`,
      );
      const playerAccount = await client.query(
        `INSERT INTO ledger_accounts (owner_wallet, purpose)
         VALUES ($1, 'player')
         ON CONFLICT (owner_wallet, purpose) DO UPDATE SET purpose = EXCLUDED.purpose
         RETURNING id`,
        [intent.wallet_address],
      );
      const transaction = await client.query(
        `INSERT INTO ledger_transactions (kind, idempotency_key, metadata)
         VALUES ('deposit', $1, $2)
         RETURNING id`,
        [`deposit:${intentId}`, { depositIntentId: intentId, chainSignature: observation.signature }],
      );
      await client.query(
        `INSERT INTO ledger_entries (transaction_id, account_id, asset_mint, direction, amount_atomic)
         VALUES ($1, $2, $4, 'debit', $5), ($1, $3, $4, 'credit', $5)`,
        [transaction.rows[0].id, custodyAccount.rows[0].id, playerAccount.rows[0].id, intent.asset_mint, observation.destinationDeltaAtomic],
      );
      await client.query(
        "UPDATE ledger_transactions SET status = 'posted', posted_at = now() WHERE id = $1",
        [transaction.rows[0].id],
      );
      await client.query(
        `UPDATE value_deposit_intents
            SET status = 'credited', actual_credit_atomic = $2, chain_signature = $3,
                finalized_at = $4, credited_at = now(), updated_at = now()
          WHERE id = $1`,
        [intentId, observation.destinationDeltaAtomic, observation.signature, observation.finalizedAt],
      );
      await client.query("COMMIT");
      return { intentId, status: "credited", amountAtomic: observation.destinationDeltaAtomic, duplicate: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async createWithdrawalRequest({ wallet, assetMint, destinationTokenAccount, amountAtomic, idempotencyKey } = {}) {
    this.#assertValueMutationAllowed();
    const canonicalWallet = publicKey(wallet, "Wallet");
    const amount = u64(amountAtomic, "Withdrawal amount");
    const decision = assertEligible(await this.compliance.evaluateEligibility({ wallet: canonicalWallet, product: "withdrawal" }));
    const vault = await this.#availableVault(assetMint, "withdrawal");
    const destination = publicKey(destinationTokenAccount, "Destination token account");
    const account = await this.chain.inspectTokenAccount(destination);
    if (account?.chainId !== this.chainId
      || account?.mint !== vault.assetMint
      || account?.owner !== canonicalWallet
      || account?.tokenProgram !== TOKEN_2022_PROGRAM
      || account?.state !== "initialized") {
      fail("Withdrawal destination does not belong to the eligible wallet and mint", 400, "destination_account_mismatch");
    }
    const balanceResult = await this.pool.query(
      `SELECT COALESCE(SUM(CASE entry.direction WHEN 'credit' THEN entry.amount_atomic ELSE -entry.amount_atomic END), 0)::text AS balance
         FROM ledger_entries AS entry
         JOIN ledger_transactions AS transaction ON transaction.id = entry.transaction_id AND transaction.status = 'posted'
         JOIN ledger_accounts AS account ON account.id = entry.account_id
        WHERE account.owner_wallet = $1 AND account.purpose = 'player' AND entry.asset_mint = $2`,
      [canonicalWallet, vault.assetMint],
    );
    const holdsResult = await this.pool.query(
      `SELECT COALESCE(SUM(request.amount_atomic), 0)::text AS held
         FROM value_withdrawal_requests AS request
         JOIN custody_vaults AS vault ON vault.id = request.custody_vault_id
        WHERE request.wallet_address = $1 AND vault.asset_mint = $2
          AND request.status IN ('held', 'approved', 'submitting', 'submitted')`,
      [canonicalWallet, vault.assetMint],
    );
    const available = BigInt(balanceResult.rows[0]?.balance ?? 0) - BigInt(holdsResult.rows[0]?.held ?? 0);
    if (available < amount) fail("Available balance is insufficient", 409, "insufficient_balance");
    const now = this.clock();
    const result = await this.pool.query(
      `INSERT INTO value_withdrawal_requests (
         wallet_address, custody_vault_id, compliance_decision_id, destination_token_account,
         amount_atomic, status, approval_quorum, idempotency_key, earliest_submit_at
       ) VALUES ($1, $2, $3, $4, $5, 'held', $6, $7, $8)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING *`,
      [
        canonicalWallet, vault.id, decision.id, destination, String(amount), this.withdrawalApprovalQuorum,
        idempotency(idempotencyKey), new Date(now.getTime() + this.withdrawalCoolingOffSeconds * 1_000).toISOString(),
      ],
    );
    if (result.rowCount === 1) return { ...result.rows[0], vault };
    const prior = await this.pool.query("SELECT * FROM value_withdrawal_requests WHERE idempotency_key = $1", [idempotencyKey]);
    if (prior.rowCount !== 1
      || prior.rows[0].wallet_address !== canonicalWallet
      || prior.rows[0].custody_vault_id !== vault.id
      || atomicFromRow(prior.rows[0].amount_atomic) !== amount
      || prior.rows[0].destination_token_account !== destination) {
      fail("Idempotency key was reused with a different withdrawal", 409, "idempotency_conflict");
    }
    return { ...prior.rows[0], vault };
  }

  async approveWithdrawal({ withdrawalId, operatorWallet, decision = "approve" } = {}) {
    const operator = publicKey(operatorWallet, "Operator wallet");
    if (!(await this.authorizeOperator(operator))) fail("Active withdrawal operator authorization is required", 403, "operator_required");
    if (!["approve", "reject"].includes(decision)) fail("Approval decision is invalid");
    const requestDigest = createHash("sha256").update(canonicalJson({ withdrawalId, operator, decision })).digest();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query("SELECT * FROM value_withdrawal_requests WHERE id = $1 FOR UPDATE", [withdrawalId]);
      if (locked.rowCount !== 1) fail("Withdrawal request was not found", 404, "not_found");
      const request = locked.rows[0];
      if (request.wallet_address === operator) fail("A withdrawal owner cannot approve their own request", 403, "self_approval_forbidden");
      if (!["held", "approved"].includes(request.status)) fail("Withdrawal cannot be approved in its current state", 409, "withdrawal_state_conflict");
      const inserted = await client.query(
        `INSERT INTO value_withdrawal_approvals (withdrawal_request_id, operator_wallet, decision, request_digest)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (withdrawal_request_id, operator_wallet) DO NOTHING
         RETURNING decision, request_digest`,
        [withdrawalId, operator, decision, requestDigest],
      );
      if (inserted.rowCount === 0) {
        const prior = await client.query(
          "SELECT decision, request_digest FROM value_withdrawal_approvals WHERE withdrawal_request_id = $1 AND operator_wallet = $2",
          [withdrawalId, operator],
        );
        if (prior.rows[0]?.decision !== decision || !Buffer.from(prior.rows[0].request_digest).equals(requestDigest)) {
          fail("Operator already made a different decision", 409, "approval_conflict");
        }
      }
      if (decision === "reject") {
        await client.query(
          "UPDATE value_withdrawal_requests SET status = 'rejected', terminal_code = 'operator_rejected', updated_at = now() WHERE id = $1",
          [withdrawalId],
        );
        await client.query("COMMIT");
        return { withdrawalId, status: "rejected", approvals: 0 };
      }
      const approvals = await client.query(
        "SELECT COUNT(*)::integer AS count FROM value_withdrawal_approvals WHERE withdrawal_request_id = $1 AND decision = 'approve'",
        [withdrawalId],
      );
      const count = approvals.rows[0].count;
      const status = count >= request.approval_quorum ? "approved" : "held";
      await client.query("UPDATE value_withdrawal_requests SET status = $2, updated_at = now() WHERE id = $1", [withdrawalId, status]);
      await client.query("COMMIT");
      return { withdrawalId, status, approvals: count };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async submitWithdrawal({ withdrawalId } = {}) {
    this.#assertValueMutationAllowed();
    const client = await this.pool.connect();
    let request;
    let vault;
    try {
      await client.query("BEGIN");
      const locked = await client.query(
        `SELECT request.*, vault.*, request.id AS request_id, request.status AS request_status,
                vault.id AS vault_id, vault.status AS vault_status
           FROM value_withdrawal_requests AS request
           JOIN custody_vaults AS vault ON vault.id = request.custody_vault_id
          WHERE request.id = $1 FOR UPDATE OF request`,
        [withdrawalId],
      );
      if (locked.rowCount !== 1) fail("Withdrawal request was not found", 404, "not_found");
      request = { ...locked.rows[0], id: locked.rows[0].request_id, status: locked.rows[0].request_status };
      vault = vaultFromRow({ ...locked.rows[0], id: locked.rows[0].vault_id, status: locked.rows[0].vault_status });
      if (request.status === "submitted") {
        await client.query("COMMIT");
        return { withdrawalId, status: "submitted", chainSignature: request.chain_signature, duplicate: true };
      }
      if (request.status !== "approved") fail("Withdrawal is not approved", 409, "withdrawal_state_conflict");
      if (Date.parse(request.earliest_submit_at) > this.clock().getTime()) fail("Withdrawal cooling-off period is active", 409, "withdrawal_cooling_off");
      await client.query(
        `UPDATE value_withdrawal_requests
            SET status = 'submitting', submission_attempts = submission_attempts + 1,
                last_error_code = NULL, updated_at = now()
          WHERE id = $1`,
        [withdrawalId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    try {
      const submitted = await this.chain.submitWithdrawal({
        idempotencyKey: `xpoker-withdrawal:${withdrawalId}`,
        chainId: this.chainId,
        mint: vault.assetMint,
        decimals: vault.decimals,
        sourceTokenAccount: vault.vaultAddress,
        sourceAuthority: vault.authorityAddress,
        destinationTokenAccount: request.destination_token_account,
        amountAtomic: String(request.amount_atomic),
      });
      if (typeof submitted?.signature !== "string" || submitted.signature.length < 64 || submitted.signature.length > 128) {
        fail("Chain adapter returned an invalid withdrawal signature", 502, "chain_submission_invalid");
      }
      const updated = await this.pool.query(
        `UPDATE value_withdrawal_requests
            SET status = 'submitted', chain_signature = $2, submitted_at = now(), updated_at = now()
          WHERE id = $1 AND status = 'submitting'
          RETURNING id`,
        [withdrawalId, submitted.signature],
      );
      if (updated.rowCount !== 1) fail("Withdrawal submission state changed unexpectedly", 409, "withdrawal_state_conflict");
      return { withdrawalId, status: "submitted", chainSignature: submitted.signature, duplicate: false };
    } catch (error) {
      await this.pool.query(
        `UPDATE value_withdrawal_requests
            SET status = 'approved', last_error_code = $2, updated_at = now()
          WHERE id = $1 AND status = 'submitting'`,
        [withdrawalId, String(error?.code ?? "chain_submission_failed").slice(0, 128)],
      ).catch(() => {});
      throw error;
    }
  }

  async finalizeWithdrawal({ withdrawalId } = {}) {
    this.#assertValueMutationAllowed();
    const loaded = await this.pool.query(
      `SELECT request.*, vault.*, request.id AS request_id, request.status AS request_status,
              vault.id AS vault_id, vault.status AS vault_status
         FROM value_withdrawal_requests AS request
         JOIN custody_vaults AS vault ON vault.id = request.custody_vault_id
        WHERE request.id = $1`,
      [withdrawalId],
    );
    if (loaded.rowCount !== 1) fail("Withdrawal request was not found", 404, "not_found");
    const request = { ...loaded.rows[0], id: loaded.rows[0].request_id, status: loaded.rows[0].request_status };
    if (request.status === "finalized") return { withdrawalId, status: "finalized", amountAtomic: String(request.actual_debit_atomic), duplicate: true };
    if (request.status !== "submitted") fail("Withdrawal has not been submitted", 409, "withdrawal_state_conflict");
    const vault = vaultFromRow({ ...loaded.rows[0], id: loaded.rows[0].vault_id, status: loaded.rows[0].vault_status });
    const transfer = await this.chain.getFinalizedTransfer(request.chain_signature);
    const observation = validateFinalizedTransfer({
      operation: "withdrawal",
      transfer,
      vault,
      wallet: request.wallet_address,
      amountAtomic: request.amount_atomic,
    });
    if (observation.destinationTokenAccount !== request.destination_token_account) {
      fail("Withdrawal reached a different token account", 400, "transfer_mismatch");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query("SELECT * FROM value_withdrawal_requests WHERE id = $1 FOR UPDATE", [withdrawalId]);
      if (locked.rows[0]?.status === "finalized") {
        await client.query("COMMIT");
        return { withdrawalId, status: "finalized", amountAtomic: String(locked.rows[0].actual_debit_atomic), duplicate: true };
      }
      if (locked.rows[0]?.status !== "submitted" || locked.rows[0].chain_signature !== observation.signature) {
        fail("Withdrawal finalization state conflict", 409, "withdrawal_state_conflict");
      }
      await client.query(
        `INSERT INTO value_chain_observations (
           operation_type, operation_id, chain_id, chain_signature, instruction_index,
           finalized_slot, asset_mint, token_program, source_token_account,
           destination_token_account, source_owner, destination_owner,
           source_delta_atomic, destination_delta_atomic, payload_sha256, finalized_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        chainObservationValues(observation, withdrawalId),
      );
      const playerAccount = await client.query(
        "SELECT id FROM ledger_accounts WHERE owner_wallet = $1 AND purpose = 'player'",
        [request.wallet_address],
      );
      if (playerAccount.rowCount !== 1) fail("Player ledger account is missing", 500, "ledger_invariant_failed");
      const withdrawalAccount = await client.query(
        `INSERT INTO ledger_accounts (owner_wallet, purpose)
         VALUES (NULL, 'withdrawal')
         ON CONFLICT (owner_wallet, purpose) DO UPDATE SET purpose = EXCLUDED.purpose
         RETURNING id`,
      );
      const transaction = await client.query(
        `INSERT INTO ledger_transactions (kind, idempotency_key, metadata)
         VALUES ('withdrawal', $1, $2)
         RETURNING id`,
        [`withdrawal:${withdrawalId}`, { withdrawalRequestId: withdrawalId, chainSignature: observation.signature }],
      );
      await client.query(
        `INSERT INTO ledger_entries (transaction_id, account_id, asset_mint, direction, amount_atomic)
         VALUES ($1, $2, $4, 'debit', $5), ($1, $3, $4, 'credit', $5)`,
        [transaction.rows[0].id, playerAccount.rows[0].id, withdrawalAccount.rows[0].id, vault.assetMint, observation.sourceDeltaAtomic],
      );
      await client.query("UPDATE ledger_transactions SET status = 'posted', posted_at = now() WHERE id = $1", [transaction.rows[0].id]);
      await client.query(
        `UPDATE value_withdrawal_requests
            SET status = 'finalized', actual_debit_atomic = $2, finalized_at = $3, updated_at = now()
          WHERE id = $1`,
        [withdrawalId, observation.sourceDeltaAtomic, observation.finalizedAt],
      );
      await client.query("COMMIT");
      return { withdrawalId, status: "finalized", amountAtomic: observation.sourceDeltaAtomic, duplicate: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async reconcileVault({ assetMint } = {}) {
    const vault = await this.#availableVault(assetMint, "reconciliation");
    const chainBalance = await this.chain.getFinalizedTokenBalance(vault.vaultAddress);
    if (chainBalance?.chainId !== this.chainId || chainBalance?.mint !== vault.assetMint || chainBalance?.status !== "finalized") {
      fail("Finalized vault balance is unavailable", 502, "reconciliation_unavailable");
    }
    const [playerResult, escrowResult, pendingResult] = await Promise.all([
      this.pool.query(
        `SELECT COALESCE(SUM(CASE entry.direction WHEN 'credit' THEN entry.amount_atomic ELSE -entry.amount_atomic END), 0)::text AS amount
           FROM ledger_entries AS entry
           JOIN ledger_transactions AS transaction ON transaction.id = entry.transaction_id AND transaction.status = 'posted'
           JOIN ledger_accounts AS account ON account.id = entry.account_id
          WHERE account.purpose = 'player' AND entry.asset_mint = $1`,
        [vault.assetMint],
      ),
      this.pool.query(
        `SELECT COALESCE(SUM(total_deposited_atomic - total_released_atomic), 0)::text AS amount
           FROM table_sessions
          WHERE asset_mint = $1 AND status IN ('open', 'locked', 'settling', 'refunding')`,
        [vault.assetMint],
      ),
      this.pool.query(
        `SELECT COALESCE(SUM(amount_atomic), 0)::text AS amount
           FROM value_withdrawal_requests
          WHERE custody_vault_id = $1 AND status IN ('held', 'approved', 'submitting', 'submitted')`,
        [vault.id],
      ),
    ]);
    const result = reconcileCustody({
      vaultBalanceAtomic: chainBalance.amountAtomic,
      playerLiabilityAtomic: playerResult.rows[0]?.amount ?? "0",
      escrowLiabilityAtomic: escrowResult.rows[0]?.amount ?? "0",
      pendingWithdrawalAtomic: pendingResult.rows[0]?.amount ?? "0",
    });
    const evidence = {
      version: "xpoker-custody-reconciliation/v1",
      vaultId: vault.id,
      finalizedSlot: String(chainBalance.finalizedSlot),
      ...result,
    };
    const evidenceSha256 = createHash("sha256").update(canonicalJson(evidence)).digest();
    const inserted = await this.pool.query(
      `INSERT INTO custody_reconciliations (
         custody_vault_id, finalized_slot, vault_balance_atomic, player_liability_atomic,
         escrow_liability_atomic, pending_withdrawal_atomic, difference_atomic, status, evidence_sha256
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (custody_vault_id, finalized_slot) DO NOTHING
       RETURNING id`,
      [
        vault.id, chainBalance.finalizedSlot, result.vaultBalanceAtomic, result.playerLiabilityAtomic,
        result.escrowLiabilityAtomic, result.pendingWithdrawalAtomic, result.differenceAtomic,
        result.status, evidenceSha256,
      ],
    );
    if (result.status === "shortfall") {
      await this.pool.query("UPDATE custody_vaults SET status = 'frozen', updated_at = now() WHERE id = $1", [vault.id]);
      await this.pool.query(
        `INSERT INTO outbox_events (topic, aggregate_id, payload)
         VALUES ('custody.shortfall', $1, $2)`,
        [vault.id, { ...evidence, evidenceSha256: evidenceSha256.toString("hex") }],
      );
    }
    return Object.freeze({ ...evidence, evidenceSha256: evidenceSha256.toString("hex"), duplicate: inserted.rowCount === 0 });
  }
}

export function inMemoryCustodyChain(overrides = {}) {
  return {
    inspectMint: async () => { throw new Error("inspectMint is not configured"); },
    inspectTokenAccount: async () => { throw new Error("inspectTokenAccount is not configured"); },
    getFinalizedTransfer: async () => { throw new Error("getFinalizedTransfer is not configured"); },
    submitWithdrawal: async () => { throw new Error("submitWithdrawal is not configured"); },
    getFinalizedTokenBalance: async () => { throw new Error("getFinalizedTokenBalance is not configured"); },
    ...overrides,
  };
}
