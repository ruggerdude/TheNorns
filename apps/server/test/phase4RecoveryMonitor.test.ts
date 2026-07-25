import { describe, expect, it } from "vitest";
import {
  Phase4RecoveryMonitor,
  QUICK_COMPLETION_RECOVERY_BATCH_SIZE,
} from "../src/coordinator/phase4RecoveryMonitor.js";

describe("Phase 4 recovery monitor", () => {
  it("bounds each completed Quick Change repair batch", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const transactions = {
      transaction: async <T>(
        work: (executor: {
          query: (
            sql: string,
            params?: unknown[],
          ) => Promise<{ rows: unknown[]; affectedRows: number }>;
        }) => Promise<T>,
      ): Promise<T> =>
        work({
          query: async (sql, params) => {
            queries.push({ sql, ...(params ? { params } : {}) });
            return { rows: [], affectedRows: 0 };
          },
        }),
    };

    await new Phase4RecoveryMonitor(transactions as never).scan(
      new Date("2026-07-25T12:00:00.000Z"),
    );

    const quickRepair = queries.find(({ sql }) => sql.includes("JOIN agent_handoffs handoff"));
    expect(quickRepair?.sql).toContain("ORDER BY run.id");
    expect(quickRepair?.sql).toContain("LIMIT $1");
    expect(quickRepair?.params).toEqual([QUICK_COMPLETION_RECOVERY_BATCH_SIZE]);
  });
});
