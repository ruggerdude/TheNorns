import { describe, expect, it } from "vitest";
import type { V2SqlExecutor, V2TransactionRunner } from "../src/persistence/v2/database.js";
import { conversationHandoffIdForPlanningRun } from "../src/planning/executionRecovery.js";

function transactionsReturning(rows: { handoff_id: string }[]) {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const executor: V2SqlExecutor = {
    query: async <TRow>(sql: string, params?: unknown[]) => {
      calls.push({ sql, ...(params ? { params } : {}) });
      return { rows: rows as TRow[] };
    },
  };
  const transactions: V2TransactionRunner = {
    transaction: async (work) => work(executor),
  };
  return { calls, transactions };
}

describe("planning execution recovery", () => {
  it("recovers the latest immutable conversation handoff for the planning run", async () => {
    const { calls, transactions } = transactionsReturning([{ handoff_id: "handoff-1" }]);

    await expect(
      conversationHandoffIdForPlanningRun(transactions, "project-1", "planning-run-1"),
    ).resolves.toBe("handoff-1");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.params).toEqual(["project-1", "planning-run-1"]);
    expect(calls[0]?.sql).toContain("ORDER BY created_at DESC, id DESC");
  });

  it("returns undefined for planning runs that did not originate in a conversation", async () => {
    const { transactions } = transactionsReturning([]);

    await expect(
      conversationHandoffIdForPlanningRun(transactions, "project-1", "planning-run-1"),
    ).resolves.toBeUndefined();
  });
});
