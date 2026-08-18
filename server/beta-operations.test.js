import assert from "node:assert/strict";
import test from "node:test";

import { metricRoute, redact } from "./beta-operations.js";

test("operations metrics keep bounded route cardinality", () => {
  assert.equal(metricRoute("/health/ready"), "/health/ready");
  assert.equal(
    metricRoute("/v1/beta/hands/table:00000000-0000-4000-8000-000000000001:1/audit/download"),
    "/v1/beta/hands/:hand/audit",
  );
  assert.equal(metricRoute("/v1/noise/attacker-controlled"), "/v1/:unmatched");
  assert.equal(metricRoute("/scanner/noise"), "/:unmatched");
});

test("operations incidents redact secrets and bound nested values", () => {
  const value = redact({
    authorization: "Bearer should-never-persist",
    nested: { privateKey: "secret", safe: "x".repeat(700) },
  });
  assert.equal(value.authorization, "[redacted]");
  assert.equal(value.nested.privateKey, "[redacted]");
  assert.equal(value.nested.safe.length, 500);
});
