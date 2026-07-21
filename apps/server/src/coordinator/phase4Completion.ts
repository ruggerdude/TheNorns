import {
  type V2ActorT,
  V2EvidenceRef,
  type V2EvidenceRefT,
  resolveV2BudgetReservation,
} from "@norns/contracts";
import type { V2TransactionRunner } from "../persistence/v2/database.js";
import { transitionV2TaskLifecycle } from "../persistence/v2/lifecycleMutation.js";
import {
  SqlV2ApplicationTransaction,
  SqlV2BudgetTransaction,
} from "../persistence/v2/sqlRepositories.js";

export class Phase4CompletionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Phase4CompletionConflictError";
  }
}

export interface Phase4CompletionInput {
  project_id: string;
  phase_id: string;
  task_id: string;
  run_id: string;
  actor: V2ActorT;
  correlation_id: string;
  review_evidence: V2EvidenceRefT[];
  integration_evidence: V2EvidenceRefT[];
  review_summary: string;
  completed_at: string;
}

export class Phase4CompletionService {
  constructor(private readonly transactions: V2TransactionRunner) {}

  complete(input: Phase4CompletionInput): Promise<{ task_completed: true; phase_closed: boolean }> {
    const reviewEvidence = input.review_evidence.map((evidence) => V2EvidenceRef.parse(evidence));
    const integrationEvidence = input.integration_evidence.map((evidence) =>
      V2EvidenceRef.parse(evidence),
    );
    if (reviewEvidence.length === 0 || integrationEvidence.length === 0) {
      throw new Phase4CompletionConflictError("review and integration evidence are required");
    }
    return this.transactions.transaction(async (sql) => {
      const state = await sql.query<{
        task_state: string;
        run_state: string;
        verification_status: string;
        assignment_id: string;
        usage_cost_usd: string | number;
      }>(
        `SELECT task.state AS task_state, run.state AS run_state,
                run.verification_status, run.assignment_id, run.usage_cost_usd
         FROM tasks task JOIN agent_runs run ON run.id = task.designated_run_id
         WHERE task.id=$1 AND task.project_id=$2 AND task.phase_id=$3 AND run.id=$4
         FOR UPDATE OF task, run`,
        [input.task_id, input.project_id, input.phase_id, input.run_id],
      );
      const current = state.rows[0];
      if (
        !current ||
        current.run_state !== "succeeded" ||
        current.verification_status !== "passed"
      ) {
        throw new Phase4CompletionConflictError("completion requires the designated green run");
      }
      if (current.task_state === "completed") return { task_completed: true, phase_closed: false };
      if (current.task_state !== "in_review") {
        throw new Phase4CompletionConflictError("task is not awaiting review");
      }
      // EXECUTION E12 — the confirmation gate.
      //
      // Completing a task asserts that its work has been INTEGRATED (the
      // caller must supply integration evidence, above). When a sibling run in
      // the same phase published unintegrated work off the same base that
      // Norns cannot prove is disjoint, that assertion cannot be made honestly
      // until a human has looked. This is where the refoundation's "explicit
      // human confirmation before integrating a conflict" rule lands in V2 --
      // and, since nothing here ever merges, it is the ONLY place it can land.
      //
      // The gate is a refusal, never a resolution: it does not merge, choose a
      // winner, or mark anything resolved. It stops, names the conflict, and
      // says what the human must do. Resolving (or dismissing) the row is the
      // human's act, recorded with their identity by
      // `RunIntegrationConflictService.resolve()`, and completion succeeds
      // immediately afterwards.
      const openConflicts = await sql.query<{ id: string; counterpart_branch: string }>(
        `SELECT id, counterpart_branch FROM run_integration_conflicts
          WHERE status = 'awaiting_human' AND (task_id = $1 OR counterpart_task_id = $1)
          ORDER BY detected_at ASC`,
        [input.task_id],
      );
      if (openConflicts.rows.length > 0) {
        const ids = openConflicts.rows.map((conflict) => conflict.id).join(", ");
        throw new Phase4CompletionConflictError(
          `task has ${openConflicts.rows.length} unresolved integration conflict(s) (${ids}) with a sibling run's published branch; a human must reconcile the branches and record the resolution before this task can be completed`,
        );
      }
      await sql.query(
        `UPDATE tasks SET review_evidence=$2::jsonb, completion_evidence=$3::jsonb,
                          completed_at=$4 WHERE id=$1`,
        [
          input.task_id,
          JSON.stringify(reviewEvidence),
          JSON.stringify(integrationEvidence),
          input.completed_at,
        ],
      );
      const lifecycle = new SqlV2ApplicationTransaction(sql);
      const budget = new SqlV2BudgetTransaction(sql);
      const task = await lifecycle.lockTaskLifecycle(input.task_id);
      if (!task) throw new Phase4CompletionConflictError("task disappeared during review");
      await transitionV2TaskLifecycle(lifecycle, {
        project_id: input.project_id,
        phase_id: input.phase_id,
        task_id: input.task_id,
        expected_aggregate_version: task.aggregate_version,
        to: "completed",
        reason: input.review_summary,
        actor_type: input.actor.actor_type,
        actor_id: input.actor.actor_id,
        correlation_id: input.correlation_id,
        causation_id: input.run_id,
        occurred_at: input.completed_at,
      });
      await sql.query(
        `UPDATE agent_assignments SET status='completed', aggregate_version=aggregate_version+1,
                                      updated_at=now() WHERE id=$1`,
        [current.assignment_id],
      );
      const reservation = await budget.lockReservation(`budget-reservation:${input.run_id}`);
      if (!reservation)
        throw new Phase4CompletionConflictError("run budget reservation is missing");
      if (reservation.status === "active") {
        const resolution = resolveV2BudgetReservation(reservation.amount_usd, {
          outcome: "success",
          attributable_usage_usd: Number(current.usage_cost_usd),
          reason: "reviewed and integrated task completion",
        });
        await budget.applyResolution(
          reservation,
          {
            reservation_id: reservation.id,
            expected_version: reservation.version,
            outcome: "success",
            attributable_usage_usd: Number(current.usage_cost_usd),
            reason: "reviewed and integrated task completion",
            actor_type: input.actor.actor_type,
            actor_id: input.actor.actor_id ?? "system:completion",
            correlation_id: input.correlation_id,
            causation_id: input.run_id,
            occurred_at: input.completed_at,
          },
          resolution,
        );
      }
      const remaining = await sql.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM tasks
         WHERE phase_id=$1 AND state NOT IN ('completed','cancelled')`,
        [input.phase_id],
      );
      const phaseClosed = (remaining.rows[0]?.count ?? 0) === 0;
      if (phaseClosed) {
        await sql.query(
          `UPDATE objectives SET status='completed', completion_evidence=$2::jsonb,
                                 aggregate_version=aggregate_version+1, updated_at=now()
           WHERE phase_id=$1 AND status <> 'cancelled'`,
          [input.phase_id, JSON.stringify(integrationEvidence)],
        );
        await sql.query(
          `UPDATE phases SET status='completed', closed_at=$2, closure_summary=$3,
                             closure_evidence=$4::jsonb,
                             aggregate_version=aggregate_version+1, updated_at=now()
           WHERE id=$1`,
          [
            input.phase_id,
            input.completed_at,
            input.review_summary,
            JSON.stringify(integrationEvidence),
          ],
        );
        await sql.query(
          `INSERT INTO project_memory_entries (
             id, project_id, phase_id, category, content, provenance, source_ref,
             confidence, version, status, approved_by_human
           ) VALUES ($1,$2,$3,'phase_completion',$4,'phase4_completion',$5::jsonb,
                     1,1,'active',false)
           ON CONFLICT (id) DO NOTHING`,
          [
            `memory:phase-completion:${input.phase_id}`,
            input.project_id,
            input.phase_id,
            input.review_summary,
            JSON.stringify({ run_id: input.run_id, task_id: input.task_id }),
          ],
        );
      }
      return { task_completed: true, phase_closed: phaseClosed };
    });
  }
}
