import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import {
  loadReleaseManifest,
  parseReleaseManifestJson,
  signReleaseManifest,
  verifyReleaseManifestSignature,
} from "./release-manifest.js";

test("release manifests are signed canonically and reject tampering", () => {
  const authority = generateKeyPairSync("ed25519");
  const signed = signReleaseManifest({
    version: "xpoker-release/v1",
    buildCommit: "a".repeat(40),
    nested: { z: 2, a: 1 },
  }, authority.privateKey);
  const publicKey = authority.publicKey.export({ type: "spki", format: "pem" });
  assert.equal(verifyReleaseManifestSignature(signed, publicKey), true);
  assert.equal(verifyReleaseManifestSignature({ ...signed, buildCommit: "b".repeat(40) }, publicKey), false);
});

test("release manifest JSON is bounded and object-only", () => {
  assert.deepEqual(parseReleaseManifestJson('{"version":"xpoker-release/v1"}'), {
    version: "xpoker-release/v1",
  });
  assert.throws(() => parseReleaseManifestJson("[]"), /JSON object/);
  assert.throws(() => parseReleaseManifestJson(`{"padding":"${"x".repeat(100)}"}`, { maximumBytes: 32 }), /size limit/);
});

test("release manifest accepts exactly one deployment source", async () => {
  await assert.rejects(
    loadReleaseManifest({ path: "manifest.json", json: "{}" }),
    /only one/,
  );
  assert.equal(await loadReleaseManifest({}), undefined);
});
