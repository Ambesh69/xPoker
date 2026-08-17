import { createHash, randomUUID } from "node:crypto";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function timeoutKey(lease) {
  const digest = createHash("sha256")
    .update(`${lease.tableId}:${lease.handId}:${lease.bettingVersion}`)
    .digest("hex");
  return `timeout:${digest}`;
}

function staleLease(error) {
  return /version conflict|no pending action timeout|betting state version conflict|deadline has not elapsed/i
    .test(error instanceof Error ? error.message : String(error));
}

export function createTimeoutWorker({
  store,
  coordinator,
  ownerId = `worker-${randomUUID()}`,
  clock = () => new Date(),
  intervalMs = 250,
  leaseMs = 10_000,
  batchSize = 50,
  onError = () => {},
} = {}) {
  assert(store?.claimExpiredDeadlines, "A timeout lease store is required");
  assert(coordinator?.timeout && coordinator?.state, "A table coordinator is required");
  assert(typeof ownerId === "string" && ownerId.length >= 8, "Timeout worker owner id is required");
  assert(Number.isInteger(intervalMs) && intervalMs >= 50 && intervalMs <= 60_000, "Timeout poll interval is invalid");
  assert(Number.isInteger(leaseMs) && leaseMs >= 1_000 && leaseMs <= 60_000, "Timeout lease is invalid");
  assert(Number.isInteger(batchSize) && batchSize >= 1 && batchSize <= 500, "Timeout batch size is invalid");
  assert(typeof onError === "function", "Timeout error handler must be a function");

  let interval;
  let activeRun;
  let stopped = false;

  async function runOnce() {
    if (activeRun) return activeRun;
    activeRun = (async () => {
      const now = clock();
      const leases = await store.claimExpiredDeadlines({
        ownerId,
        now,
        leaseMs,
        limit: batchSize,
      });
      let applied = 0;
      for (const lease of leases) {
        try {
          const state = await coordinator.state(lease.tableId);
          if (
            state.status !== "HAND_ACTIVE"
            || state.currentHand?.handId !== lease.handId
            || state.currentHand?.betting.version !== lease.bettingVersion
            || state.currentHand?.turn?.playerId !== lease.playerId
          ) continue;
          await coordinator.timeout({
            tableId: lease.tableId,
            expectedVersion: state.version,
            expectedBettingVersion: lease.bettingVersion,
            idempotencyKey: timeoutKey(lease),
          });
          applied += 1;
        } catch (error) {
          if (!staleLease(error)) onError(error, lease);
        }
      }
      return { claimed: leases.length, applied };
    })();
    try {
      return await activeRun;
    } finally {
      activeRun = undefined;
    }
  }

  function start() {
    assert(!stopped, "A stopped timeout worker cannot be restarted");
    if (interval) return;
    interval = setInterval(() => {
      runOnce().catch((error) => onError(error));
    }, intervalMs);
    interval.unref?.();
  }

  async function stop() {
    stopped = true;
    clearInterval(interval);
    interval = undefined;
    if (activeRun) await activeRun;
  }

  return Object.freeze({ ownerId, runOnce, start, stop });
}
