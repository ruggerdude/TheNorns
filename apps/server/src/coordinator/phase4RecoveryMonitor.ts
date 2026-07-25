import { createHash } from "node:crypto";
import { V2EvidenceRef } from "@norns/contracts";
import { upsertV2DecisionPoint } from "../persistence/v2/application.js";
import { sweepV2OrphanReservations } from "../persistence/v2/budget.js";
import type { V2TransactionRunner } from "../persistence/v2/database.js";
import {
  sqlV2BudgetSweepRepositoryFactory,
  sqlV2BudgetTransactionFactory,
  sqlV2DecisionPointTransactionFactory,
} from "../persistence/v2/sqlRepositories.js";
import { Phase4KnowledgeEventAdapter } from "./phase4KnowledgeEventAdapter.js";
import { reconcileObsoleteRecoveryDecisions } from "./phase4TerminalReconciliation.js";

interface StuckRun {
  id: string;
  project_id: string;
  phase_id: string;
  task_id: string;
  state: string;
  aggregate_version: number;
}

export const QUICK_COMPLETION_RECOVERY_BATCH_SIZE = 25;

export class Phase4RecoveryMonitor {
  constructor(
    private readonly transactions: V2TransactionRunner,
    private readonly knowledge = new Phase4KnowledgeEventAdapter(),
  ) {}

  async scan(
    now = new Date(),
    stuckAfterMs = 15 * 60_000,
  ): Promise<{
    decision_points: number;
    repaired_reservations: string[];
  }> {
    const reconciledAt = now.toISOString();
    await this.transactions.transaction(async (sql) => {
      await reconcileObsoleteRecoveryDecisions(sql, reconciledAt);
      const completedQuickRuns = await sql.query<{
        id: string;
        project_id: string;
        phase_id: string;
        task_id: string;
        expected_revision: string;
      }>(
        `SELECT DISTINCT run.id, run.project_id, run.phase_id, run.task_id,
                run.expected_revision
           FROM agent_runs run
           JOIN tasks task
             ON task.id=run.task_id AND task.designated_run_id=run.id
           JOIN phases phase ON phase.id=run.phase_id
           JOIN planning_runs planning ON planning.id=phase.planning_run_id
           JOIN agent_assignments assignment ON assignment.id=run.assignment_id
           JOIN verification_results verification
             ON verification.run_id=run.id AND verification.passed=true
           JOIN agent_handoffs handoff
             ON handoff.run_id=run.id AND handoff.status='completed'
           JOIN knowledge_deltas delta ON delta.id=handoff.knowledge_delta_id
          WHERE planning.mode='quick'
            AND assignment.reviewer_agent_profile_id IS NULL
            AND run.state='succeeded'
            AND task.state='completed'
            AND phase.status='completed'
            AND delta.status='proposed'
            AND run.commit_sha=verification.commit_sha
            AND run.published_commit_sha=verification.commit_sha
            AND handoff.payload->>'commit'=verification.commit_sha
            AND run.publication_outcome IN ('pushed','local_only')
          ORDER BY run.id
          LIMIT $1`,
        [QUICK_COMPLETION_RECOVERY_BATCH_SIZE],
      );
      const repairedPhases = new Set<string>();
      for (const run of completedQuickRuns.rows) {
        const deltaEvidence = await this.knowledge.acceptQuickCompletionDelta(
          sql,
          { ...run, execution_mode: "quick" },
          reconciledAt,
        );
        const evidence = V2EvidenceRef.parse({
          artifact_id: deltaEvidence.artifact_id,
          content_hash: deltaEvidence.content_hash,
          media_type: "application/vnd.norns.knowledge-delta+json",
          label: "Accepted Quick Change knowledge delta",
        });
        for (const target of [
          { table: "tasks", idColumn: "id", id: run.task_id, field: "completion_evidence" },
          {
            table: "objectives",
            idColumn: "phase_id",
            id: run.phase_id,
            field: "completion_evidence",
          },
          { table: "phases", idColumn: "id", id: run.phase_id, field: "closure_evidence" },
        ] as const) {
          await sql.query(
            `UPDATE ${target.table}
                SET ${target.field}=COALESCE(${target.field}, '[]'::jsonb) || jsonb_build_array($2::jsonb),
                    updated_at=now()
              WHERE ${target.idColumn}=$1
                AND NOT EXISTS (
                  SELECT 1 FROM jsonb_array_elements(COALESCE(${target.field}, '[]'::jsonb)) item
                   WHERE item->>'artifact_id'=$3
                )`,
            [target.id, JSON.stringify(evidence), evidence.artifact_id],
          );
        }
        repairedPhases.add(`${run.project_id}\u0000${run.phase_id}`);
      }
      for (const repaired of repairedPhases) {
        const [projectId, phaseId] = repaired.split("\u0000");
        if (!projectId || !phaseId) continue;
        await this.knowledge.evaluatePhaseCompletion(sql, projectId, phaseId, reconciledAt);
      }
    });
    const cutoff = new Date(now.getTime() - stuckAfterMs).toISOString();
    const stuck = await this.transactions.transaction(async (sql) => {
      const result = await sql.query<StuckRun>(
        `SELECT run.id, run.project_id, run.phase_id, run.task_id,
                run.state, run.aggregate_version
           FROM agent_runs run
           JOIN tasks task ON task.id=run.task_id
           JOIN phases phase ON phase.id=run.phase_id
          WHERE phase.status='active'
            AND (
              (run.state IN ('dispatched','running','verifying') AND run.updated_at <= $1)
              OR
              (run.state IN ('failed','expired') AND run.is_designated=true
               AND task.state IN ('failed','blocked'))
            )
          ORDER BY run.updated_at, run.id LIMIT 100`,
        [cutoff],
      );
      return result.rows;
    });
    let points = 0;
    for (const run of stuck) {
      const terminal = ["failed", "expired"].includes(run.state);
      const reasonClass = terminal ? "failed_run" : "stuck_run";
      const conditionKey = ["decision", run.project_id, "agent_run", run.id, reasonClass, run.id]
        .map(encodeURIComponent)
        .join(":");
      const fingerprint = createHash("sha256")
        .update(`${run.id}:${run.state}:${run.aggregate_version}`)
        .digest("hex");
      const result = await upsertV2DecisionPoint({
        transactionRunner: this.transactions,
        transactionFactory: sqlV2DecisionPointTransactionFactory,
        input: {
          id: `decision:${reasonClass}:${run.id}:${run.aggregate_version}`,
          project_id: run.project_id,
          phase_id: run.phase_id,
          task_id: run.task_id,
          scope_entity_type: "agent_run",
          scope_entity_id: run.id,
          reason_class: reasonClass,
          source_instance_id: run.id,
          condition_key: conditionKey,
          condition_fingerprint: fingerprint,
          question: terminal
            ? "How should The Norns recover this failed run?"
            : "How should The Norns recover this stuck run?",
          context: terminal
            ? `Run ${run.id} ended ${run.state} and its task cannot advance.`
            : `Run ${run.id} remains ${run.state} beyond the recovery threshold.`,
          options: [
            {
              id: "retry",
              label: "Retry safely",
              impact: "Start a new fenced attempt after inspecting current evidence.",
              risk: "May repeat external work if the previous outcome is ambiguous.",
            },
            {
              id: "cancel",
              label: "Cancel phase",
              impact: "Cancel this phase and all of its unfinished tasks.",
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
