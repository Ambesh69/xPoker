import assert from "node:assert/strict";
import test from "node:test";

import { recoverSafeBetaTables } from "./runtime.js";

test("safe-beta startup reconstructs action deadlines and resumes every preview table", async () => {
  const calls = [];
  const states = new Map([
    ["table-active", {
      version: 9,
      status: "HAND_ACTIVE",
      currentHand: {
        betting: { handId: "hand-3", version: 4, status: "BETTING" },
        turn: {
          playerId: "player-a",
          deadlineAt: "2026-08-17T12:01:00.000Z",
        },
      },
    }],
    ["table-waiting", { version: 2, status: "WAITING", currentHand: null }],
  ]);
  const result = await recoverSafeBetaTables({
    tableStore: {
      listPreviewTableIds: async () => [...states.keys()],
      reconcileDeadline: async (input) => {
        calls.push(input);
        return true;
      },
    },
    tableCoordinator: { state: async (tableId) => states.get(tableId) },
    dealer: { schedule: (tableId) => calls.push({ scheduled: tableId }) },
  });

  assert.deepEqual(result, { recovered: 2 });
  assert.deepEqual(calls, [
    {
      tableId: "table-active",
      expectedVersion: 9,
      turn: {
        handId: "hand-3",
        bettingVersion: 4,
        playerId: "player-a",
        deadlineAt: "2026-08-17T12:01:00.000Z",
      },
    },
    { scheduled: "table-active" },
    { tableId: "table-waiting", expectedVersion: 2, turn: undefined },
    { scheduled: "table-waiting" },
  ]);
});
