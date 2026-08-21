import { writeFile } from "node:fs/promises";

const DEFAULT_FRONTEND = "https://xpoker.vercel.app";
const DEFAULT_API = "https://xpoker-api-production.up.railway.app";
const DEFAULT_ORIGIN = "https://xpoker.vercel.app";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(fetchImpl, url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Production certification request timed out")), 15_000);
  timer.unref?.();
  try {
    const response = await fetchImpl(url, { redirect: "error", ...options, signal: controller.signal });
    const text = await response.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    return { response, body };
  } finally {
    clearTimeout(timer);
  }
}

function checkSecurityHeaders(response) {
  assert(response.headers.get("cache-control")?.includes("no-store"), "API responses must not be cached");
  assert(response.headers.get("x-content-type-options") === "nosniff", "API must send nosniff");
  assert(response.headers.get("x-frame-options") === "DENY", "API must deny framing");
  assert(response.headers.get("strict-transport-security")?.includes("max-age="), "API must send HSTS");
}

export async function certifyProduction({
  fetchImpl = globalThis.fetch,
  frontendUrl = DEFAULT_FRONTEND,
  apiUrl = DEFAULT_API,
  origin = DEFAULT_ORIGIN,
  requireSignedManifest = false,
  expectedBuildCommit,
  clock = () => new Date(),
} = {}) {
  const startedAt = clock().toISOString();
  const frontend = await request(fetchImpl, `${frontendUrl}/`);
  assert(frontend.response.ok, `Frontend returned HTTP ${frontend.response.status}`);

  const ready = await request(fetchImpl, `${apiUrl}/health/ready`);
  assert(ready.response.ok, `Readiness returned HTTP ${ready.response.status}`);
  checkSecurityHeaders(ready.response);
  assert(ready.body.status === "ready", "API is not ready");
  assert(ready.body.authoritativeRuntime === "ready", "Authoritative runtime is not ready");
  assert(ready.body.mode === "safe-preview", "Production must remain in safe-preview mode");

  const ops = await request(fetchImpl, `${apiUrl}/health/ops`);
  assert(ops.response.ok, `Operational health returned HTTP ${ops.response.status}`);
  assert(ops.body.status === "healthy" && ops.body.failed?.length === 0, "Operational probes are degraded");

  const lobby = await request(fetchImpl, `${apiUrl}/v1/beta/lobby`, { headers: { origin } });
  assert(lobby.response.ok, `Lobby returned HTTP ${lobby.response.status}`);
  assert(lobby.response.headers.get("access-control-allow-origin") === origin, "Trusted origin CORS is incorrect");
  assert(lobby.body.fundsMove === false, "Lobby must explicitly disable fund movement");
  assert(lobby.body.assets?.length === 10, "Production lobby must expose exactly 10 allowlisted assets");
  assert(new Set(lobby.body.assets.map((asset) => asset.symbol)).size === 10, "Asset symbols must be unique");
  assert(lobby.body.rooms?.length === 4, "Production lobby must expose exactly four public rooms");
  const games = lobby.body.rooms.map((room) => room.game).sort();
  assert(JSON.stringify(games) === JSON.stringify(["NLH", "PLO4", "ROE", "ROE"]), "Public room game mix changed");
  assert(lobby.body.rooms.every((room) => room.rules?.minimumBuyInAtomic === "2000"), "Public room minimum buy-in changed");

  const forbidden = await request(fetchImpl, `${apiUrl}/v1/beta/lobby`, {
    headers: { origin: "https://certification-origin.invalid" },
  });
  assert(forbidden.response.status === 403, "Untrusted browser origin was not rejected");
  assert(!forbidden.response.headers.get("access-control-allow-origin"), "Untrusted origin received CORS access");

  const release = await request(fetchImpl, `${apiUrl}/v1/release/status`);
  assert(release.response.ok, `Release status returned HTTP ${release.response.status}`);
  assert(release.body.realValueRequested === false && release.body.realValueEnabled === false, "Real-value mode must remain disabled");
  const releaseChecks = Object.fromEntries(release.body.checks.map((check) => [check.name, check.passed]));
  assert(releaseChecks.dealer_key_isolated === true, "Dealer key is not isolated");
  assert(/^[0-9a-f]{40}$/i.test(release.body.attestations?.buildCommit ?? ""), "Runtime build commit is not attested");
  if (expectedBuildCommit) {
    assert(release.body.attestations.buildCommit === expectedBuildCommit, "Production is not running the expected build commit");
  }
  assert(/^[a-z0-9][a-z0-9._-]{7,127}$/i.test(release.body.attestations?.assetAllowlistVersion ?? ""), "Asset allowlist is not versioned");
  assert(/^[0-9a-f]{32}$/i.test(release.body.attestations?.dealerSignerKeyId ?? ""), "Live dealer signer key is not attested");
  if (requireSignedManifest) {
    for (const name of [
      "release_manifest_version",
      "release_matches_build",
      "release_matches_asset_allowlist",
      "release_matches_dealer_key",
      "release_matches_settlement",
      "release_manifest_signature",
    ]) assert(releaseChecks[name] === true, `Signed release binding failed: ${name}`);
  }

  return {
    version: "xpoker-production-certification/v1",
    startedAt,
    completedAt: clock().toISOString(),
    targets: { frontendUrl, apiUrl, origin },
    safePreview: true,
    fundsMove: false,
    signedManifestRequired: requireSignedManifest,
    runtime: release.body.attestations,
    checks: {
      frontendReachable: true,
      authoritativeRuntimeReady: true,
      operationalHealth: true,
      securityHeaders: true,
      trustedOriginCors: true,
      untrustedOriginRejected: true,
      tenAssetAllowlist: true,
      publicRoomContract: true,
      dealerKeyIsolated: true,
      liveDealerKeyAttested: true,
      realValueDisabled: true,
      signedManifestBound: requireSignedManifest,
    },
  };
}

async function main() {
  const report = await certifyProduction({
    frontendUrl: process.env.XPOKER_FRONTEND_URL ?? DEFAULT_FRONTEND,
    apiUrl: process.env.XPOKER_API_URL ?? DEFAULT_API,
    origin: process.env.XPOKER_BROWSER_ORIGIN ?? DEFAULT_ORIGIN,
    requireSignedManifest: process.env.REQUIRE_SIGNED_MANIFEST === "1",
    expectedBuildCommit: process.env.EXPECTED_BUILD_COMMIT,
  });
  const output = process.env.CERTIFICATION_OUTPUT;
  if (output) await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
