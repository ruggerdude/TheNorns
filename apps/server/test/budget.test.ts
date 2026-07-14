// REVIEW-002 Q4 / MVP acceptance #7: concurrent dispatches cannot
// oversubscribe a budget — the reservation race test.
import { describe, expect, it } from "vitest";
import { BudgetExceededError, BudgetLedger } from "../src/engine/budget.js";

describe("budget reservations under concurrency", () => {
  it("never oversubscribes: 10 concurrent $30 reserves against $100 admit at most 3", async () => {
    const ledger = new BudgetLedger(10_000);
    ledger.approve("node", 100);

    const attempts = Array.from({ length: 10 }, async (_, i) => {
      await new Promise((r) => setTimeout(r, Math.random() * 10));
      try {
        return ledger.reserve("node", 30);
      } catch (error) {
        if (error instanceof BudgetExceededError) return null;
        throw error;
      }
    });
    const results = await Promise.all(attempts);
    const admitted = results.filter((r): r is string => r !== null);

    expect(admitted.length).toBeLessThanOrEqual(3);
    expect(ledger.activeReservationsUsd("node")).toBeLessThanOrEqual(100);
    expect(ledger.available("node")).toBeGreaterThanOrEqual(0);
  });

  it("settle caps at the reservation (per-call overshoot bound) and frees the rest", () => {
    const ledger = new BudgetLedger(10_000);
    ledger.approve("node", 100);
    const res = ledger.reserve("node", 40);
    ledger.settle("node", res, 55); // actual exceeded the max charge
    expect(ledger.settledUsd("node")).toBe(40); // bounded by the reservation
    expect(ledger.available("node")).toBe(60);
  });

  it("release returns the full hold", () => {
    const ledger = new BudgetLedger(10_000);
    ledger.approve("node", 100);
    const res = ledger.reserve("node", 70);
    expect(ledger.available("node")).toBe(30);
    ledger.release("node", res);
    expect(ledger.available("node")).toBe(100);
  });

  it("fires the 80% threshold notification from settled + reserved", () => {
    const ledger = new BudgetLedger(10_000);
    ledger.approve("node", 100);
    const notified: string[] = [];
    ledger.notifyThreshold((nodeId) => notified.push(nodeId));
    ledger.reserve("node", 50);
    expect(notified).toHaveLength(0);
    ledger.reserve("node", 30); // 80 held
    expect(notified).toEqual(["node"]);
  });
});
