import { createHash } from "node:crypto";
import { V2EvidenceRef } from "@norns/contracts";
import { upsertV2DecisionPoint } from "../persistence/v2/application.js";
import { sweepV2OrphanReservations } from "../persistence/v2/budget.js";
import type { V2TransactionRunner } from "../persistence/v2/database.js";
import {
  transitionV2AgentRunLifecycle,
  transitionV2TaskLifecycle,
} from "../persistence/v2/lifecycleMutation.js";
import {
  SqlV2ApplicationTransaction,
  sqlV2BudgetSweepRepositoryFactory,
  sqlV2BudgetTransactionFactory,
  sqlV2DecisionPointTransactionFactory,
} from "../persistence/v2/sqlRepositories.js";
import { classifyFailureRetry } from "./failureRetryPolicy.js";
import { Phase4KnowledgeEventAdapter } from "./phase4KnowledgeEventAdapter.js";
import { reconcileObsoleteRecoveryDecisions } from "./phase4TerminalReconciliation.js";
import { SCHEDULABLE_TASKS_SQL } from "./phaseConcurrency.js";

interface StuckRun {
  id: string;
  project_id: string;
  phase_id: string;
  task_id: string;
  state: string;
  aggregate_version: number;
  attempt: number;
  failure_code: string | null;
  failure_detail: string | null;
  updated_at: string | Date;
  max_duration_seconds: number | string | null;
}

/** Grace past a run's own wall-clock bound before the server concludes the
 *  runner that should have enforced it is gone. */
const WATCHDOG_GRACE_MS = 5 * 60_000;
const DEFAULT_RUN_DURATION_SECONDS = 3_600;

export const QUICK_COMPLETION_RECOVERY_BATCH_SIZE = 25;

export interface Phase4RecoveryMonitorOptions {
  onInactiveRun?: (runId: string, reason: string, detectedAt: string) => Promise<void>;
}

export class Phase4RecoveryMonitor {
  constructor(
    private readonly transactions: V2TransactionRunner,
    private readonly knowledge = new Phase4KnowledgeEventAdapter(),
    private readonly options: Phase4RecoveryMonitorOptions = {},
  ) {}

  async scan(
    now = new Date(),
    stuckAfterMs = 15 * 60_000,
  ): Promise<{
    decision_points: number;
    repaired_reservations: string[];
    expired_dispatches: number;
    watchdog_stop_requests: number;
    released_phases: number;
  }> {
    const reconciledAt = now.toISOString();
    // Expire delivered-but-never-started commands past their deadline first, so
    // the runs they free land in the stuck-run sweep below as recoverable.
    const expiredDispatches =
      (await this.expireStaleDispatches(now)) + (await this.expireUnanswerableWaits(now));
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
                run.state, run.aggregate_version, run.attempt,
                run.failure_code, run.failure_detail, run.updated_at,
                (SELECT (command.envelope->>'max_duration_seconds')::int
                   FROM commands command
                  WHERE command.run_id=run.id
                  ORDER BY command.created_at DESC, command.command_id DESC
                  LIMIT 1) AS max_duration_seconds
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
    let watchdogStopRequests = 0;
    for (const run of stuck) {
      const terminal = ["failed", "expired"].includes(run.state);
      const retryPolicy = classifyFailureRetry(run.failure_code, run.failure_detail, run.attempt);
      // A run is bounded by money and wall-clock, and the runner enforces the
      // clock. The watchdog is not a second, earlier timeout: it steps in only
      // when a run has been silent past its OWN bound, i.e. the runner that
      // should have stopped it is gone. Quiet-but-alive runs get a decision
      // point below, never a stop.
      const boundMs = (Number(run.max_duration_seconds) || DEFAULT_RUN_DURATION_SECONDS) * 1_000;
      const silentMs = now.getTime() - new Date(run.updated_at).getTime();
      if (!terminal && this.options.onInactiveRun && silentMs >= boundMs + WATCHDOG_GRACE_MS) {
        try {
          await this.options.onInactiveRun(
            run.id,
            `run silent for ${Math.round(silentMs / 60_000)} minutes, past its ${Math.round(boundMs / 60_000)}-minute time bound; the runner did not report an outcome`,
            reconciledAt,
          );
          watchdogStopRequests += 1;
        } catch {
          // The durable recovery decision below remains the fallback for
          // offline/legacy runners that cannot accept a watchdog stop.
        }
      }
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
            ? `Run ${run.id} ended ${run.state} and its task cannot advance. ${retryPolicy.explanation}`
            : `Run ${run.id} remains ${run.state} beyond the recovery threshold.`,
          options: [
            {
              id: "retry",
              label:
                retryPolicy.retryClass === "configuration"
                  ? "Retry after fixing runner"
                  : "Retry safely",
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
          recommendation_option_id: terminal ? retryPolicy.recommendation : "cancel",
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
    // EXEC-PHASE-RELEASE — a phase whose remaining work is all terminal or
    // blocked cannot progress without a human, yet left `active` it holds the
    // project's one-phase-at-a-time slot and refuses every new plan. Park it
    // as `blocked`: retry re-activates it, cancel accepts it.
    let releasedPhases = 0;
    const stalledPhases = new Set(
      stuck
        .filter((run) => ["failed", "expired"].includes(run.state))
        .map((run) => `${run.project_id}\u0000${run.phase_id}`),
    );
    for (const key of stalledPhases) {
      const [projectId, phaseId] = key.split("\u0000");
      if (!projectId || !phaseId) continue;
      const released = await this.transactions.transaction(async (sql) => {
        const schedulable = await sql.query(SCHEDULABLE_TASKS_SQL, [projectId, phaseId]);
        if (schedulable.rows.length > 0) return false;
        const result = await sql.query(
          `UPDATE phases
              SET status='blocked', aggregate_version=aggregate_version+1, updated_at=now()
            WHERE id=$1 AND project_id=$2 AND status='active'
              AND NOT EXISTS (
                SELECT 1 FROM agent_runs run
                 WHERE run.phase_id=$1
                   AND run.state IN ('created','dispatched','running','waiting_for_human','verifying')
              )
              AND NOT EXISTS (
                SELECT 1 FROM tasks task
                 WHERE task.phase_id=$1
                   AND task.state IN ('assigned','in_progress','verifying','in_review')
              )
            RETURNING id`,
          [phaseId, projectId],
        );
        return result.rows.length > 0;
      });
      if (released) releasedPhases += 1;
    }
    const swept = await sweepV2OrphanReservations({
      transactionRunner: this.transactions,
      transactionFactory: sqlV2BudgetTransactionFactory,
      sweepRepositoryFactory: sqlV2BudgetSweepRepositoryFactory,
      now: () => now,
      actorId: "system:phase4-recovery",
    });
    return {
      decision_points: points,
      repaired_reservations: swept.repaired,
      expired_dispatches: expiredDispatches,
      watchdog_stop_requests: watchdogStopRequests,
      released_phases: releasedPhases,
    };
  }

  /**
   * EXEC-CANCEL-2 — a command that was delivered but never started, once its
   * own envelope `expires_at` has passed, can never run: the runner did not
   * pick it up before its deadline, and expiry was only ever enforced BEFORE
   * delivery. Such a run would otherwise sit `created`/`dispatched` until a
   * human noticed and hit Stop (the EXEC-CANCEL-1 incident). A run in those
   * states has provably never emitted `run_status started` (that is the
   * dispatched -> running edge), so expiring it is unambiguous and needs no
   * human. The run goes terminal `expired` and its task cascades to `blocked`,
   * which is exactly the state the existing recovery surfaces offer retry
   * from — so the task self-heals into a recoverable state.
   */
  /**
   * EXEC-WAIT-UNANSWERABLE — a run parked on a question nobody can answer.
   *
   * `waiting_for_human` is normally patient: a human answers and the run
   * resumes. But a wait whose decision point is already closed can never be
   * answered — the answer path needs that row open. Left alone the run waits
   * forever, its phase stays `active` (the release sweep deliberately spares
   * waiting runs), and the project's one-phase-at-a-time slot is held against
   * every future plan. Live: that is exactly how StrumSheetX1 stalled.
   *
   * Expire those runs (a legal edge from `waiting_for_human`) and cascade the
   * task to `blocked`, so the phase-release sweep can park the phase and the
   * human can retry or cancel the task normally.
   */
  private async expireUnanswerableWaits(now: Date): Promise<number> {
    const occurredAt = now.toISOString();
    const candidates = await this.transactions.transaction(async (sql) => {
      const result = await sql.query<{
        id: string;
        project_id: string;
        phase_id: string;
        task_id: string;
      }>(
        `SELECT run.id, run.project_id, run.phase_id, run.task_id
           FROM agent_runs run
           JOIN phases phase ON phase.id=run.phase_id
           JOIN human_waits wait ON wait.source_run_id=run.id
           JOIN decision_points point ON point.id=wait.decision_point_id
          WHERE phase.status='active'
            AND run.is_designated=true
            AND run.state='waiting_for_human'
            AND wait.status='awaiting_human'
            AND point.status <> 'open'
          ORDER BY run.id
          LIMIT 100`,
      );
      return result.rows;
    });
    let expired = 0;
    for (const run of candidates) {
      try {
        await this.transactions.transaction(async (tx) => {
          const lifecycle = new SqlV2ApplicationTransaction(tx);
          const lockedRun = await lifecycle.lockAgentRunLifecycle(run.id);
          if (!lockedRun || lockedRun.state !== "waiting_for_human") return;
          const task = await tx.query<{ aggregate_version: number; state: string }>(
            "SELECT aggregate_version, state FROM tasks WHERE id=$1 FOR UPDATE",
            [run.task_id],
          );
          const taskRow = task.rows[0];
          await transitionV2AgentRunLifecycle(lifecycle, {
            project_id: run.project_id,
            phase_id: run.phase_id,
            task_id: run.task_id,
            run_id: run.id,
            expected_aggregate_version: lockedRun.aggregate_version,
            to: "expired",
            reason:
              "the run's question can no longer be answered (its decision point is closed); retry or cancel the task",
            actor_type: "coordinator",
            actor_id: "system:unanswerable-wait",
            correlation_id: run.id,
            causation_id: run.id,
            occurred_at: occurredAt,
          });
          if (taskRow && taskRow.state !== "blocked") {
            await transitionV2TaskLifecycle(lifecycle, {
              project_id: run.project_id,
              phase_id: run.phase_id,
              task_id: run.task_id,
              expected_aggregate_version: taskRow.aggregate_version,
              to: "blocked",
              reason: "the run's question can no longer be answered",
              actor_type: "coordinator",
              actor_id: "system:unanswerable-wait",
              correlation_id: run.id,
              causation_id: run.id,
              occurred_at: occurredAt,
            });
          }
        });
        expired += 1;
      } catch {
        // Best-effort sweep, exactly like the dispatch expiry below: a
        // concurrent answer or cancellation simply wins and the next tick
        // re-evaluates.
      }
    }
    return expired;
  }

  private async expireStaleDispatches(now: Date): Promise<number> {
    const occurredAt = now.toISOString();
    const candidates = await this.transactions.transaction(async (sql) => {
      const result = await sql.query<{
        id: string;
        project_id: string;
        phase_id: string;
        task_id: string;
      }>(
        `SELECT run.id, run.project_id, run.phase_id, run.task_id
           FROM agent_runs run
           JOIN phases phase ON phase.id=run.phase_id
           JOIN dispatch_jobs job ON job.run_id=run.id
           JOIN commands command ON command.command_id=job.command_id
          WHERE phase.status='active'
            AND run.is_designated=true
            AND run.state IN ('created','dispatched')
          GROUP BY run.id, run.project_id, run.phase_id, run.task_id
          HAVING max((command.envelope->>'expires_at')::timestamptz) <= $1::timestamptz
          ORDER BY run.id
          LIMIT 100`,
        [occurredAt],
      );
      return result.rows;
    });
    let expired = 0;
    for (const run of candidates) {
      try {
        await this.transactions.transaction(async (tx) => {
          const lifecycle = new SqlV2ApplicationTransaction(tx);
          const lockedRun = await lifecycle.lockAgentRunLifecycle(run.id);
          if (!lockedRun || !["created", "dispatched"].includes(lockedRun.state)) return;
          const task = await tx.query<{ aggregate_version: number; state: string }>(
            "SELECT aggregate_version, state FROM tasks WHERE id=$1 FOR UPDATE",
            [run.task_id],
          );
          const taskRow = task.rows[0];
          await transitionV2AgentRunLifecycle(lifecycle, {
            project_id: run.project_id,
            phase_id: run.phase_id,
            task_id: run.task_id,
            run_id: run.id,
            expected_aggregate_version: lockedRun.aggregate_version,
            to: "expired",
            reason: "dispatch expired: the runner did not start the command before its deadline",
            actor_type: "coordinator",
            actor_id: "system:dispatch-expiry",
            correlation_id: run.id,
            causation_id: run.id,
            occurred_at: occurredAt,
          });
          // Cascade only from `assigned` (the state a task holds while its run
          // is created/dispatched). Any other state means something else moved
          // the task concurrently; leave it and let the next tick re-evaluate.
          if (taskRow?.state === "assigned") {
            await transitionV2TaskLifecycle(lifecycle, {
              project_id: run.project_id,
              phase_id: run.phase_id,
              task_id: run.task_id,
              expected_aggregate_version: taskRow.aggregate_version,
              to: "blocked",
              reason: "dispatch expired before execution started",
              actor_type: "coordinator",
              actor_id: "system:dispatch-expiry",
              correlation_id: run.id,
              causation_id: run.id,
              occurred_at: occurredAt,
            });
          }
        });
        expired += 1;
      } catch {
        // Best-effort sweep: a concurrent transition (the runner started, a
        // human cancelled, a version bumped) just means this run is no longer
        // ours to expire. Never let one row abort the whole scan.
      }
    }
    return expired;
  }
}
