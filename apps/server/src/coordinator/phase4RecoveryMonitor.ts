import { createHash } from "node:crypto";
import { upsertV2DecisionPoint } from "../persistence/v2/application.js";
import { sweepV2OrphanReservations } from "../persistence/v2/budget.js";
import type { V2TransactionRunner } from "../persistence/v2/database.js";
import {
  sqlV2BudgetSweepRepositoryFactory,
  sqlV2BudgetTransactionFactory,
  sqlV2DecisionPointTransactionFactory,
} from "../persistence/v2/sqlRepositories.js";

interface StuckRun {
  id: string;
  project_id: string;
  phase_id: string;
  task_id: string;
  state: string;
  aggregate_version: number;
}

export class Phase4RecoveryMonitor {
  constructor(private readonly transactions: V2TransactionRunner) {}

  async scan(
    now = new Date(),
    stuckAfterMs = 15 * 60_000,
  ): Promise<{
    decision_points: number;
    repaired_reservations: string[];
  }> {
    const cutoff = new Date(now.getTime() - stuckAfterMs).toISOString();
    const stuck = await this.transactions.transaction(async (sql) => {
      const result = await sql.query<StuckRun>(
        `SELECT id, project_id, phase_id, task_id, state, aggregate_version
         FROM agent_runs
         WHERE state IN ('dispatched','running','verifying') AND updated_at <= $1
         ORDER BY updated_at, id LIMIT 100`,
        [cutoff],
      );
      return result.rows;
    });
    let points = 0;
    for (const run of stuck) {
      const conditionKey = ["decision", run.project_id, "agent_run", run.id, "stuck_run", run.id]
        .map(encodeURIComponent)
        .join(":");
      const fingerprint = createHash("sha256")
        .update(`${run.id}:${run.state}:${run.aggregate_version}`)
        .digest("hex");
      const result = await upsertV2DecisionPoint({
        transactionRunner: this.transactions,
        transactionFactory: sqlV2DecisionPointTransactionFactory,
        input: {
          id: `decision:stuck-run:${run.id}:${run.aggregate_version}`,
          project_id: run.project_id,
          phase_id: run.phase_id,
          task_id: run.task_id,
          scope_entity_type: "agent_run",
          scope_entity_id: run.id,
          reason_class: "stuck_run",
          source_instance_id: run.id,
          condition_key: conditionKey,
          condition_fingerprint: fingerprint,
          question: "How should The Norns recover this stuck run?",
          context: `Run ${run.id} remains ${run.state} beyond the recovery threshold.`,
          options: [
            {
              id: "retry",
              label: "Retry safely",
              impact: "Start a new fenced attempt after inspecting current evidence.",
              risk: "May repeat external work if the previous outcome is ambiguous.",
            },
            {
              id: "cancel",
              label: "Cancel work",
              impact: "Stop this task and release safely attributable budget.",
              risk: "The phase remains incomplete until replanned.",
            },
          ],
          recommendation_option_id: "retry",
          urgency: "high",
          blocking_scope: { entity_type: "task", entity_id: run.task_id },
          occurred_at: now.toISOString(),
          actor_id: "system:phase4-recovery",
          correlation_id: `stuck-run:${run.id}`,
          causation_id: run.id,
        },
      });
      if (result.kind === "created" || result.kind === "superseded") points += 1;
    }
    const swept = await sweepV2OrphanReservations({
      transactionRunner: this.transactions,
      transactionFactory: sqlV2BudgetTransactionFactory,
      sweepRepositoryFactory: sqlV2BudgetSweepRepositoryFactory,
      now: () => now,
      actorId: "system:phase4-recovery",
    });
    return { decision_points: points, repaired_reservations: swept.repaired };
  }
}
