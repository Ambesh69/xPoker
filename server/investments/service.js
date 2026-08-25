import { randomUUID } from "node:crypto";

function investmentError(message, statusCode = 400, code = "invalid_investment_request") {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

export class PostgresInvestmentService {
  constructor({ pool, alpaca, jupiter, holdingsReader } = {}) {
    if (!pool?.query) throw new Error("Investment service requires PostgreSQL");
    if (!alpaca || !jupiter || !holdingsReader) throw new Error("Investment providers are required");
    this.pool = pool;
    this.alpaca = alpaca;
    this.jupiter = jupiter;
    this.holdingsReader = holdingsReader;
  }

  async #brokerBinding(wallet) {
    const result = await this.pool.query(
      `SELECT provider_account_id, environment, status, opened_at, updated_at
       FROM player_investment_accounts
       WHERE wallet_address = $1 AND provider = 'alpaca' AND environment = $2`,
      [wallet, this.alpaca.environment],
    );
    return result.rows[0];
  }

  async status(wallet) {
    const binding = await this.#brokerBinding(wallet);
    return Object.freeze({
      brokerage: { ...this.alpaca.status(), account: binding ? {
        status: binding.status,
        openedAt: binding.opened_at,
        updatedAt: binding.updated_at,
      } : null },
      swaps: this.jupiter.status(),
      walletHoldings: { supported: true, network: "solana:mainnet", mode: "read-only" },
      pokerFundsLinked: false,
    });
  }

  async openSandboxAccount({ wallet, applicant, ipAddress }) {
    if (await this.#brokerBinding(wallet)) throw investmentError("This wallet already has an Alpaca sandbox account", 409, "broker_account_exists");
    const account = await this.alpaca.openAccount(applicant, { ipAddress });
    if (typeof account?.id !== "string" || !account.id) throw investmentError("Alpaca returned an invalid account", 502, "broker_provider_error");
    await this.pool.query(
      `INSERT INTO player_investment_accounts
       (wallet_address, provider, provider_account_id, environment, status, opened_at, updated_at)
       VALUES ($1, 'alpaca', $2, $3, $4, now(), now())`,
      [wallet, account.id, this.alpaca.environment, String(account.status || "SUBMITTED").toUpperCase()],
    );
    return { account: { id: account.id, status: account.status || "SUBMITTED" } };
  }

  async portfolio(wallet) {
    const binding = await this.#brokerBinding(wallet);
    const walletHoldings = await this.holdingsReader.read(wallet);
    if (!binding || !this.alpaca.configured) {
      return { brokerage: { account: binding ?? null, positions: [], orders: [] }, walletHoldings };
    }
    const [account, positions, orders] = await Promise.all([
      this.alpaca.account(binding.provider_account_id),
      this.alpaca.positions(binding.provider_account_id),
      this.alpaca.orders(binding.provider_account_id),
    ]);
    const nextStatus = String(account.status || binding.status).toUpperCase();
    if (nextStatus !== binding.status) {
      await this.pool.query(
        `UPDATE player_investment_accounts SET status = $3, updated_at = now()
         WHERE wallet_address = $1 AND provider = 'alpaca' AND environment = $2`,
        [wallet, this.alpaca.environment, nextStatus],
      );
    }
    return { brokerage: { account: { status: nextStatus }, positions, orders }, walletHoldings };
  }

  async buyFractional({ wallet, symbol, notional }) {
    const binding = await this.#brokerBinding(wallet);
    if (!binding) throw investmentError("Complete Alpaca onboarding before placing an order", 409, "broker_account_required");
    if (!["ACTIVE", "APPROVED"].includes(binding.status)) {
      throw investmentError("Alpaca has not approved this brokerage account yet", 409, "broker_account_pending");
    }
    const order = await this.alpaca.placeFractionalBuy(binding.provider_account_id, {
      symbol,
      notional,
      clientOrderId: `xpoker-${randomUUID()}`,
    });
    await this.pool.query(
      `INSERT INTO investment_order_receipts
       (wallet_address, provider, provider_order_id, client_order_id, symbol, notional_usd, status, provider_payload)
       VALUES ($1, 'alpaca', $2, $3, $4, $5, $6, $7::jsonb)`,
      [wallet, order.id, order.client_order_id, order.symbol, order.notional, order.status, JSON.stringify({
        id: order.id, symbol: order.symbol, notional: order.notional, status: order.status, submitted_at: order.submitted_at,
      })],
    );
    return { order };
  }

  swapOrder({ wallet, inputSymbol, outputSymbol, amountAtomic }) {
    return this.jupiter.order({ wallet, inputSymbol, outputSymbol, amountAtomic });
  }

  executeSwap({ wallet, signedTransaction, requestId }) {
    return this.jupiter.execute({ wallet, signedTransaction, requestId });
  }
}

