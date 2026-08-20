import { createHash, createPrivateKey, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

import { TranscriptSigner } from "./transcript.js";

const BODY_LIMIT = 64 * 1024;

function digest(value) {
  return createHash("sha256").update(String(value)).digest();
}

function authorized(request, token) {
  const header = request.headers.authorization ?? "";
  const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
  return timingSafeEqual(digest(supplied), digest(token));
}

function json(response, statusCode, body) {
  const payload = Buffer.from(JSON.stringify(body));
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-length": payload.length,
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(payload);
}

async function body(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw Object.assign(new Error("Request body is too large"), { statusCode: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {
    throw Object.assign(new Error("Request body must be valid JSON"), { statusCode: 400 });
  }
}

export function createSignerServer({ signingKeyPem, authToken } = {}) {
  if (!signingKeyPem) throw new Error("DEALER_SIGNING_KEY_PEM is required");
  if (!authToken || authToken.length < 32) throw new Error("SIGNER_AUTH_TOKEN must contain at least 32 characters");
  const signer = new TranscriptSigner(createPrivateKey(signingKeyPem));
  return createServer(async (request, response) => {
    const url = new URL(request.url, "http://signer.internal");
    if (request.method === "GET" && url.pathname === "/health/ready") {
      json(response, 200, { status: "ready", signerKeyId: signer.keyId });
      return;
    }
    if (!authorized(request, authToken)) {
      json(response, 401, { error: "authentication_required" });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/public-key") {
      json(response, 200, { signerKeyId: signer.keyId, publicKeyPem: signer.publicKeyPem() });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/transcript-events") {
      try {
        json(response, 201, signer.append(await body(request)));
      } catch (error) {
        json(response, error.statusCode ?? 400, { error: "invalid_signing_request" });
      }
      return;
    }
    json(response, 404, { error: "not_found" });
  });
}

export async function startSignerServer(env = process.env) {
  const server = createSignerServer({
    signingKeyPem: env.DEALER_SIGNING_KEY_PEM,
    authToken: env.SIGNER_AUTH_TOKEN,
  });
  const port = Number(env.PORT ?? 8790);
  const host = env.HOST ?? "::";
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  console.log(JSON.stringify({ level: "info", event: "signer_listening", host, port }));
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startSignerServer().catch((error) => {
    console.error(JSON.stringify({ level: "error", event: "signer_start_failed", error: error.message }));
    process.exitCode = 1;
  });
}
