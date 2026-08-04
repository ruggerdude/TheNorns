import { describe, expect, it } from "vitest";
import type { V2SqlExecutor, V2TransactionRunner } from "../src/persistence/v2/database.js";
import {
  conversationHandoffIdForPlanningRun,
  reconcileConversationExecutionRetry,
} from "../src/planning/executionRecovery.js";

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

  it("leaves a settled first-attempt audit untouched when a retry is still refused", async () => {
    const { calls, transactions } = transactionsReturning([]);
    const report = { started: false, detail: "The local runner is offline." };

    await expect(
      reconcileConversationExecutionRetry(transactions, "project-1", "planning-run-1", report),
    ).resolves.toEqual(report);
    expect(calls).toEqual([]);
  });

  it("projects a successful retry onto the work item without rewriting the action effect", async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const executor: V2SqlExecutor = {
      query: async <TRow>(sql: string, params?: unknown[]) => {
        calls.push({ sql, ...(params ? { params } : {}) });
        return {
          rows: (sql.includes("SELECT id FROM phases") ? [{ id: "phase-1" }] : []) as TRow[],
        };
      },
    };
    const transactions: V2TransactionRunner = {
      transaction: async (work) => work(executor),
    };
    const report = { started: true, detail: "Development started." };

    await expect(
      reconcileConversationExecutionRetry(transactions, "project-1", "planning-run-1", report),
    ).resolves.toEqual(report);
    expect(calls).toHaveLength(2);
    expect(calls.some(({ sql }) => sql.includes("conversation_plan_action_effects"))).toBe(false);
    expect(calls[1]?.params).toEqual(["project-1", "planning-run-1", "phase-1"]);
  });
});
