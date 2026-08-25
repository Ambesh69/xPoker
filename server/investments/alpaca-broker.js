import { isIP } from "node:net";

const CORE_SYMBOLS = new Set([
  "AAPL", "NVDA", "MSFT", "AMZN", "GOOGL", "META", "TSLA", "NFLX", "SPY", "QQQ",
]);

function providerError(message, statusCode = 502, code = "broker_provider_error") {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function cleanText(value, label, maximum = 128) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) {
    throw providerError(`${label} is required`, 400, "invalid_broker_request");
  }
  return value.trim();
}

function positiveMoney(value) {
  const normalized = typeof value === "number" ? value.toFixed(2) : String(value ?? "").trim();
  if (!/^[0-9]+(?:\.[0-9]{1,2})?$/.test(normalized)) {
    throw providerError("Order amount must be a positive dollar value with at most two decimals", 400, "invalid_order_amount");
  }
  const number = Number(normalized);
  if (!Number.isFinite(number) || number < 1 || number > 25_000) {
    throw providerError("Order amount must be between $1 and $25,000", 400, "invalid_order_amount");
  }
  return number.toFixed(2);
}

export class AlpacaBrokerClient {
  constructor({
    baseUrl = "https://broker-api.sandbox.alpaca.markets",
    apiKey,
    apiSecret,
    environment = "sandbox",
    fetchImpl = fetch,
    timeoutMs = 10_000,
  } = {}) {
    if (!new URL(baseUrl).protocol.startsWith("https")) throw new Error("Alpaca Broker API must use HTTPS");
    if (!["sandbox", "production"].includes(environment)) throw new Error("Invalid Alpaca environment");
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.environment = environment;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  get configured() {
    return Boolean(this.apiKey && this.apiSecret);
  }

  status() {
    return Object.freeze({
      provider: "alpaca",
      environment: this.environment,
      configured: this.configured,
      fractionalNotionalOrders: true,
      kycOwner: "alpaca",
      custody: "alpaca-brokerage-account",
    });
  }

  async #request(path, { method = "GET", body } = {}) {
    if (!this.configured) throw providerError("Alpaca Broker API is not configured", 503, "broker_unavailable");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          accept: "application/json",
          authorization: `Basic ${Buffer.from(`${this.apiKey}:${this.apiSecret}`).toString("base64")}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const detail = payload?.message || payload?.error || `Alpaca returned HTTP ${response.status}`;
        throw providerError(detail, response.status >= 500 ? 502 : response.status, "broker_request_rejected");
      }
      return payload;
    } catch (error) {
      if (error?.statusCode) throw error;
      if (error?.name === "AbortError") throw providerError("Alpaca request timed out", 504, "broker_timeout");
      throw providerError("Alpaca is temporarily unavailable");
    } finally {
      clearTimeout(timer);
    }
  }

  async openAccount(input, { ipAddress } = {}) {
    if (this.environment !== "sandbox") {
      throw providerError("Live account opening requires the approved Alpaca production onboarding configuration", 503, "broker_onboarding_unavailable");
    }
    const contact = input?.contact ?? {};
    const identity = input?.identity ?? {};
    const disclosures = input?.disclosures ?? {};
    if (input?.agreementsAccepted !== true) {
      throw providerError("Alpaca account agreements must be accepted", 400, "broker_agreements_required");
    }
    if (!isIP(ipAddress)) {
      throw providerError("A valid originating IP address is required for the Alpaca agreements", 400, "broker_ip_required");
    }
    const signedAt = new Date().toISOString();
    const payload = {
      contact: {
        email_address: cleanText(contact.emailAddress, "Email", 254),
        phone_number: cleanText(contact.phoneNumber, "Phone", 32),
        street_address: [cleanText(contact.streetAddress, "Street address", 160)],
        city: cleanText(contact.city, "City", 80),
        state: cleanText(contact.state, "State", 32),
        postal_code: cleanText(contact.postalCode, "Postal code", 24),
        country: cleanText(contact.country || "USA", "Country", 3).toUpperCase(),
      },
      identity: {
        given_name: cleanText(identity.givenName, "Given name", 80),
        family_name: cleanText(identity.familyName, "Family name", 80),
        date_of_birth: cleanText(identity.dateOfBirth, "Date of birth", 10),
        tax_id: cleanText(identity.taxId, "Tax ID", 32),
        tax_id_type: cleanText(identity.taxIdType || "USA_SSN", "Tax ID type", 32),
        country_of_citizenship: cleanText(identity.countryOfCitizenship || "USA", "Country of citizenship", 3),
        country_of_birth: cleanText(identity.countryOfBirth || "USA", "Country of birth", 3),
        country_of_tax_residence: cleanText(identity.countryOfTaxResidence || "USA", "Country of tax residence", 3),
        funding_source: Array.isArray(identity.fundingSource) && identity.fundingSource.length
          ? identity.fundingSource.map((item) => cleanText(item, "Funding source", 32))
          : ["employment_income"],
      },
      disclosures: {
        is_control_person: Boolean(disclosures.isControlPerson),
        is_affiliated_exchange_or_finra: Boolean(disclosures.isAffiliatedExchangeOrFinra),
        is_politically_exposed: Boolean(disclosures.isPoliticallyExposed),
        immediate_family_exposed: Boolean(disclosures.immediateFamilyExposed),
      },
      agreements: ["margin_agreement", "account_agreement", "customer_agreement"].map((agreement) => ({
        agreement,
        signed_at: signedAt,
        ip_address: ipAddress,
      })),
      documents: [],
      trusted_contact: input?.trustedContact ? {
        given_name: cleanText(input.trustedContact.givenName, "Trusted contact given name", 80),
        family_name: cleanText(input.trustedContact.familyName, "Trusted contact family name", 80),
        email_address: cleanText(input.trustedContact.emailAddress, "Trusted contact email", 254),
      } : undefined,
    };
    return this.#request("/v1/accounts", { method: "POST", body: payload });
  }

  account(accountId) {
    return this.#request(`/v1/accounts/${encodeURIComponent(cleanText(accountId, "Account ID"))}`);
  }

  positions(accountId) {
    return this.#request(`/v1/trading/accounts/${encodeURIComponent(cleanText(accountId, "Account ID"))}/positions`);
  }

  orders(accountId, status = "all") {
    return this.#request(`/v1/trading/accounts/${encodeURIComponent(cleanText(accountId, "Account ID"))}/orders?status=${encodeURIComponent(status)}&limit=50&direction=desc`);
  }

  placeFractionalBuy(accountId, { symbol, notional, clientOrderId }) {
    const normalizedSymbol = cleanText(symbol, "Symbol", 8).toUpperCase().replace(/X$/, "");
    if (!CORE_SYMBOLS.has(normalizedSymbol)) {
      throw providerError("That stock is outside xPoker's Core 10 purchase list", 400, "asset_not_allowed");
    }
    return this.#request(`/v1/trading/accounts/${encodeURIComponent(cleanText(accountId, "Account ID"))}/orders`, {
      method: "POST",
      body: {
        symbol: normalizedSymbol,
        notional: positiveMoney(notional),
        side: "buy",
        type: "market",
        time_in_force: "day",
        client_order_id: cleanText(clientOrderId, "Client order ID", 48),
      },
    });
  }
}
