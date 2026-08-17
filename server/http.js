import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

import { loadConfig } from "./config.js";
import { evaluateReleaseGates } from "./release-gates.js";

const SECURITY_HEADERS = Object.freeze({
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "cross-origin-opener-policy": "same-origin",
  "referrer-policy": "no-referrer",
  "strict-transport-security": "max-age=63072000; includeSubDomains; preload",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
});

async function readManifest(path) {
  if (!path) return undefined;
  return JSON.parse(await readFile(path, "utf8"));
}

function sendJson(response, statusCode, body, requestId) {
  response.writeHead(statusCode, {
    ...SECURITY_HEADERS,
    "content-type": "application/json; charset=utf-8",
    "x-request-id": requestId,
  });
  response.end(`${JSON.stringify(body)}\n`);
}

export function createRequestHandler({ config, gates }) {
  return (request, response) => {
    const requestId = request.headers["x-request-id"]?.slice(0, 128) || randomUUID();
    const url = new URL(request.url, "http://internal");
    if (request.method !== "GET") {
      sendJson(response, 405, { error: "method_not_allowed", requestId }, requestId);
      return;
    }
    if (url.pathname === "/health/live") {
      sendJson(response, 200, { status: "live", requestId }, requestId);
      return;
    }
    if (url.pathname === "/health/ready") {
      const ready = !config.realValueMode || gates.realValueEnabled;
      sendJson(response, ready ? 200 : 503, {
        status: ready ? "ready" : "blocked",
        mode: gates.realValueEnabled ? "real-value" : "safe-preview",
        failedGates: gates.failed,
        requestId,
      }, requestId);
      return;
    }
    if (url.pathname === "/v1/release/status") {
      sendJson(response, 200, {
        realValueRequested: gates.realValueRequested,
        realValueEnabled: gates.realValueEnabled,
        checks: gates.checks,
        requestId,
      }, requestId);
      return;
    }
    sendJson(response, 404, { error: "not_found", requestId }, requestId);
  };
}

export async function createApiServer({ config = loadConfig(), manifest } = {}) {
  const releaseManifest = manifest ?? await readManifest(config.releaseManifestPath);
  const gates = evaluateReleaseGates({ config, manifest: releaseManifest });
  const server = createServer(createRequestHandler({ config, gates }));
  server.releaseGates = gates;
  return server;
}

export async function startApiServer() {
  const config = loadConfig();
  const server = await createApiServer({ config });
  server.listen(config.port, config.host, () => {
    console.log(JSON.stringify({
      level: "info",
      event: "server_listening",
      host: config.host,
      port: config.port,
      realValueEnabled: server.releaseGates.realValueEnabled,
    }));
  });
  const shutdown = (signal) => {
    server.close((error) => {
      if (error) {
        console.error(JSON.stringify({ level: "error", event: "shutdown_failed", signal, error: error.message }));
        process.exitCode = 1;
      }
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) await startApiServer();
