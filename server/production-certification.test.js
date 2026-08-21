import assert from "node:assert/strict";
import test from "node:test";

import { certifyProduction } from "./production-certification.js";

function response(status, body, headers = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
}

function fixtureFetch({ signed = true } = {}) {
  return async (url, options = {}) => {
    if (url === "https://front.example/") return response(200, "ok");
    if (url.endsWith("/health/ready")) return response(200, {
      status: "ready",
      authoritativeRuntime: "ready",
      mode: "safe-preview",
    }, {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "strict-transport-security": "max-age=100",
    });
    if (url.endsWith("/health/ops")) return response(200, { status: "healthy", failed: [] });
    if (url.endsWith("/v1/beta/lobby") && options.headers?.origin?.includes("invalid")) {
      return response(403, { error: "origin_forbidden" });
    }
    if (url.endsWith("/v1/beta/lobby")) return response(200, {
      fundsMove: false,
      assets: Array.from({ length: 10 }, (_, index) => ({ symbol: `ASSET${index}` })),
      rooms: ["NLH", "PLO4", "ROE", "ROE"].map((game) => ({
        tableRules: { game, minimumBuyInAtomic: "2000" },
      })),
    }, { "access-control-allow-origin": "https://front.example" });
    if (url.endsWith("/v1/release/status")) return response(200, {
      realValueRequested: false,
      realValueEnabled: false,
      attestations: {
        buildCommit: "a".repeat(40),
        assetAllowlistVersion: "allowlist-v1",
        dealerSignerKeyId: "b".repeat(64),
      },
      checks: [
        { name: "dealer_key_isolated", passed: true },
        ...[
          "release_manifest_version",
          "release_matches_build",
          "release_matches_asset_allowlist",
          "release_matches_dealer_key",
          "release_matches_settlement",
          "release_manifest_signature",
        ].map((name) => ({ name, passed: signed })),
      ],
    });
    throw new Error(`Unexpected request: ${url}`);
  };
}

test("production certification verifies safe live contracts and signed runtime bindings", async () => {
  const report = await certifyProduction({
    fetchImpl: fixtureFetch(),
    frontendUrl: "https://front.example",
    apiUrl: "https://api.example",
    origin: "https://front.example",
    requireSignedManifest: true,
    clock: () => new Date("2026-08-21T00:00:00.000Z"),
  });
  assert.equal(report.safePreview, true);
  assert.equal(report.fundsMove, false);
  assert.equal(report.checks.signedManifestBound, true);
});

test("production certification rejects an unbound manifest when required", async () => {
  await assert.rejects(certifyProduction({
    fetchImpl: fixtureFetch({ signed: false }),
    frontendUrl: "https://front.example",
    apiUrl: "https://api.example",
    origin: "https://front.example",
    requireSignedManifest: true,
  }), /Signed release binding failed/);
});
