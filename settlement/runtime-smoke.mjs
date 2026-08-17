import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { decodeBase58, encodeBase58 } from "../server/wallet-auth.js";

const PROGRAM_ID = "14dia6Spfd6qu6Q36caisExYQsLA9si4PqFpqfiQ8Z9S";
const RPC_PORT = Number(process.env.XPOKER_SMOKE_RPC_PORT ?? await availablePort());
// Port zero asks the OS for a free faucet port. The smoke test funds its payer
// at genesis, so it never needs to discover or call that port.
const FAUCET_PORT = Number(process.env.XPOKER_SMOKE_FAUCET_PORT ?? 0);
const RPC_URL = `http://127.0.0.1:${RPC_PORT}`;

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

function shortvec(value) {
  const bytes = [];
  let remaining = value;
  do {
    let byte = remaining & 0x7f;
    remaining >>= 7;
    if (remaining > 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining > 0);
  return Buffer.from(bytes);
}

async function rpc(method, params = []) {
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const payload = await response.json();
  if (payload.error) throw new Error(`${method}: ${JSON.stringify(payload.error)}`);
  return payload.result;
}

async function eventually(check, label, timeoutMs = 90_000, child) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      throw new Error(`${label} process exited before becoming ready`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ""}`);
}

function buildFallbackTransaction({ payerPublicKey, privateKey, recentBlockhash }) {
  const payer = decodeBase58(payerPublicKey);
  const program = decodeBase58(PROGRAM_ID);
  const blockhash = decodeBase58(recentBlockhash);
  if (payer.length !== 32 || program.length !== 32 || blockhash.length !== 32) {
    throw new Error("Transaction contains a malformed public key or blockhash");
  }

  const message = Buffer.concat([
    Buffer.from([1, 0, 1]),
    shortvec(2),
    payer,
    program,
    blockhash,
    shortvec(1),
    Buffer.from([1]),
    shortvec(0),
    shortvec(0),
  ]);
  const signature = sign(null, message, privateKey);
  return Buffer.concat([shortvec(1), signature, message]).toString("base64");
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGINT");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 3_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise((resolve) => child.once("exit", resolve));
  }
}

const ledger = await mkdtemp(join(tmpdir(), "xpoker-validator-"));
let validator;
let validatorOutput = "";
try {
  // Do not rely on a developer or CI image having a Solana CLI wallet. The
  // validator otherwise tries to resolve its default genesis mint from the
  // local CLI config before RPC can start.
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const payerBytes = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  const payerPublicKey = encodeBase58(payerBytes);

  validator = spawn("solana-test-validator", [
    "--reset",
    "--ledger", ledger,
    "--mint", payerPublicKey,
    "--bpf-program", PROGRAM_ID, "target/deploy/xpoker_escrow.so",
    "--bind-address", "127.0.0.1",
    "--rpc-port", String(RPC_PORT),
    "--faucet-port", String(FAUCET_PORT),
  ], { cwd: new URL(".", import.meta.url), stdio: ["ignore", "pipe", "pipe"] });
  validator.stdout.on("data", (chunk) => { validatorOutput += chunk; });
  validator.stderr.on("data", (chunk) => { validatorOutput += chunk; });

  await eventually(async () => (await rpc("getHealth")) === "ok", "local validator", 90_000, validator);
  await eventually(async () => {
    const account = await rpc("getAccountInfo", [PROGRAM_ID, { commitment: "processed" }]);
    return account.value?.executable === true;
  }, "escrow program deployment", 90_000, validator);

  await eventually(async () => {
    const balance = await rpc("getBalance", [payerPublicKey, { commitment: "processed" }]);
    return balance.value > 0;
  }, "genesis payer balance");

  await eventually(async () => {
    const latest = await rpc("getLatestBlockhash", [{ commitment: "processed" }]);
    const transaction = buildFallbackTransaction({
      payerPublicKey,
      privateKey,
      recentBlockhash: latest.value.blockhash,
    });
    const simulation = await rpc("simulateTransaction", [transaction, {
      encoding: "base64",
      sigVerify: true,
      commitment: "processed",
    }]);
    const logs = simulation.value.logs ?? [];
    const invoked = logs.some((line) => line.includes(`Program ${PROGRAM_ID} invoke`));
    const expectedFallback = logs.some((line) => line.includes("InstructionFallbackNotFound"));
    if (!invoked || !expectedFallback) {
      throw new Error(`unexpected simulation: ${JSON.stringify({ err: simulation.value.err, logs })}`);
    }
    return true;
  }, "escrow entrypoint execution", 90_000, validator);

  console.log("Escrow SBF entrypoint executed in a local validator; expected fallback error was observed.");
} catch (error) {
  if (validatorOutput) console.error(validatorOutput.trim());
  throw error;
} finally {
  if (validator) await stop(validator);
  await rm(ledger, { recursive: true, force: true });
}
