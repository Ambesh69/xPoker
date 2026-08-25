import assert from "node:assert/strict";
import test from "node:test";

import { AlpacaBrokerClient } from "./alpaca-broker.js";

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test("Alpaca fractional orders are Core 10 dollar-notional buys", async () => {
  let request;
  const client = new AlpacaBrokerClient({
    apiKey: "broker-key",
    apiSecret: "broker-secret",
    fetchImpl: async (url, options) => {
      request = { url, options };
      return jsonResponse({ id: "order-1", status: "accepted" });
    },
  });
  await client.placeFractionalBuy("account-123", { symbol: "AAPLx", notional: "25", clientOrderId: "xpoker-order-123" });
  assert.equal(request.url, "https://broker-api.sandbox.alpaca.markets/v1/trading/accounts/account-123/orders");
  assert.equal(request.options.headers.authorization, `Basic ${Buffer.from("broker-key:broker-secret").toString("base64")}`);
  assert.deepEqual(JSON.parse(request.options.body), {
    symbol: "AAPL", notional: "25.00", side: "buy", type: "market", time_in_force: "day", client_order_id: "xpoker-order-123",
  });
});

test("Alpaca orders reject unsupported assets and unconfigured credentials", async () => {
  const configured = new AlpacaBrokerClient({ apiKey: "broker-key", apiSecret: "broker-secret", fetchImpl: async () => jsonResponse({}) });
  assert.throws(() => configured.placeFractionalBuy("account-123", { symbol: "GME", notional: "10", clientOrderId: "xpoker-order-123" }), /Core 10/);
  const unavailable = new AlpacaBrokerClient();
  await assert.rejects(() => unavailable.positions("account-123"), /not configured/);
});

test("account opening is sandbox-only and forwards agreements without retaining identity", async () => {
  let payload;
  const client = new AlpacaBrokerClient({
    apiKey: "broker-key", apiSecret: "broker-secret",
    fetchImpl: async (_url, options) => { payload = JSON.parse(options.body); return jsonResponse({ id: "account-123", status: "SUBMITTED" }); },
  });
  await client.openAccount({
    contact: { emailAddress: "test@example.com", phoneNumber: "+15555550100", streetAddress: "1 Test St", city: "New York", state: "NY", postalCode: "10001", country: "USA" },
    identity: { givenName: "Test", familyName: "Person", dateOfBirth: "1990-01-01", taxId: "111223333", taxIdType: "USA_SSN", countryOfCitizenship: "USA", countryOfBirth: "USA", countryOfTaxResidence: "USA", fundingSource: ["employment_income"] },
    disclosures: {},
    agreementsAccepted: true,
  }, { ipAddress: "203.0.113.4" });
  assert.equal(payload.agreements.length, 3);
  assert.equal(payload.agreements[0].ip_address, "203.0.113.4");
  const production = new AlpacaBrokerClient({ environment: "production", baseUrl: "https://broker-api.alpaca.markets", apiKey: "broker-key", apiSecret: "broker-secret" });
  await assert.rejects(() => production.openAccount({}), /approved Alpaca production onboarding/);
});

test("account agreements reject a missing or fabricated originating IP", async () => {
  const client = new AlpacaBrokerClient({
    apiKey: "broker-key",
    apiSecret: "broker-secret",
    fetchImpl: async () => jsonResponse({ id: "account-123" }),
  });
  const applicant = {
    contact: { emailAddress: "test@example.com", phoneNumber: "+15555550100", streetAddress: "1 Test St", city: "New York", state: "NY", postalCode: "10001" },
    identity: { givenName: "Test", familyName: "Person", dateOfBirth: "1990-01-01", taxId: "111223333" },
    agreementsAccepted: true,
  };
  await assert.rejects(() => client.openAccount(applicant, { ipAddress: "not-an-ip" }), /originating IP address/);
});
