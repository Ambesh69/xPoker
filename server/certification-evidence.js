import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

async function record(path) {
  const bytes = await readFile(path);
  return {
    path,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function main(paths) {
  if (paths.length < 2) throw new Error("Usage: node server/certification-evidence.js <output> <evidence...>");
  const [output, ...evidencePaths] = paths;
  const report = {
    version: "xpoker-certification-evidence/v1",
    generatedAt: new Date().toISOString(),
    buildCommit: process.env.BUILD_COMMIT ?? "",
    fundsMove: false,
    evidence: await Promise.all(evidencePaths.map(record)),
  };
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ output, evidence: report.evidence.length }));
}

await main(process.argv.slice(2));

