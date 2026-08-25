export class InvestmentService {
  constructor({ jupiter, holdingsReader } = {}) {
    if (!jupiter || !holdingsReader) throw new Error("Jupiter and the holdings reader are required");
    this.jupiter = jupiter;
    this.holdingsReader = holdingsReader;
  }

  async status() {
    return Object.freeze({
      swaps: this.jupiter.status(),
      walletHoldings: { supported: true, network: "solana:mainnet", mode: "read-only" },
      pokerFundsLinked: false,
    });
  }

  async portfolio(wallet) {
    const walletHoldings = await this.holdingsReader.read(wallet);
    return { walletHoldings };
  }

  swapOrder({ wallet, inputSymbol, outputSymbol, amountAtomic }) {
    return this.jupiter.order({ wallet, inputSymbol, outputSymbol, amountAtomic });
  }

  executeSwap({ wallet, signedTransaction, requestId }) {
    return this.jupiter.execute({ wallet, signedTransaction, requestId });
  }
}
