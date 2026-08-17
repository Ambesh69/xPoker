import assert from "node:assert/strict";
import test from "node:test";

import { createRequestHandler } from "./http.js";
import { evaluateReleaseGates } from "./release-gates.js";

function request(config, path) {
  const response = {
    status: undefined,
    headers: undefined,
    payload: "",
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(payload) {
      this.payload = payload;
    },
  };
  const gates = evaluateReleaseGates({ config });
  const handler = createRequestHandler({ config, gates });
  handler({ method: "GET", url: path, headers: {} }, response);
  return { response, body: JSON.parse(response.payload) };
}

function config(realValueMode) {
  return {
    realValueMode,
    allowedOrigins: [],
  };
}

test("safe preview is live and explicitly identifies itself", async () => {
  const { response, body } = request(config(false), "/health/ready");
  assert.equal(response.status, 200);
  assert.equal(body.status, "ready");
  assert.equal(body.mode, "safe-preview");
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.equal(response.headers["cache-control"], "no-store");
});

test("requesting real-value mode without signed evidence makes readiness fail", async () => {
  const { response, body } = request(config(true), "/health/ready");
  assert.equal(response.status, 503);
  assert.equal(body.status, "blocked");
  assert.ok(body.failedGates.includes("release_manifest_signature"));
});
