import { type V2ActorT, V2CancelTaskCommand, V2RetryTaskCommand } from "@norns/contracts";
import { newId } from "../ids.js";
import {
  type V2CommandExecutionResult,
  type V2CommandMutationResult,
  executeV2ApplicationCommand,
  v2ExpectedVersionConflict,
} from "../persistence/v2/application.js";
import {
  type V2SqlExecutor,
  type V2TransactionRunner,
  withTransientPgRetry,
} from "../persistence/v2/database.js";
import { transitionV2TaskLifecycle } from "../persistence/v2/lifecycleMutation.js";
import { SqlV2ApplicationTransaction } from "../persistence/v2/sqlRepositories.js";
import type { PhaseLaunchResult, PhaseLaunchService } from "./phaseLaunchService.js";

class RecoveryTransaction extends SqlV2ApplicationTransaction {
  constructor(readonly executor: V2SqlExecutor) {
    super(executor);
  }
}

const recoveryTransactionFactory = {
  bind(sql: V2SqlExecutor): RecoveryTransaction {
    return new RecoveryTransaction(sql);
  },
};

export class Phase4RecoveryActionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
    readonly retriable = true,
  ) {
    super(message);
    this.name = "Phase4RecoveryActionError";
  }
}

export interface Phase4RecoveryBaseInput {
  project_id: string;
  phase_id: string;
  task_id: string;
  failed_run_id: string;
  expected_task_version: number;
  actor: V2ActorT;
  authorized_by_session_id: string;
  idempotency_key: string;
  correlation_id: string;
  causation_id: string | null;
  issued_at: string;
  adjustment?: {
    budget_limit_usd?: number | undefined;
    provider?: string | undefined;
    model?: string | undefined;
  };
  /**
   * The generic decision-resolution route owns closure when it orchestrates
   * recovery, so failed resolution can leave the decision open and retryable.
   * Direct recovery callers retain the historical auto-close default.
   */
  resolve_decisions?: boolean;
}

export interface Phase4RetryResult {
  action: "retry";
  replayed: boolean;
  started: boolean;
  phase_id: string;
  task_id: string;
  prior_run_id: string;
  run_id: string | null;
  attempt: number | null;
  dispatch_job_id: string | null;
  detail: string;
}

export interface Phase4CancelResult {
  action: "cancel";
  replayed: boolean;
  phase_id: string;
  task_id: string;
  prior_run_id: string;
  phase_status: "cancelled";
}

interface RecoveryScopeRow {
  task_state: string;
  task_aggregate_version: number;
  designated_run_id: string | null;
  phase_status: string;
  run_state: string | null;
  run_attempt: number | null;
  run_is_designated: boolean | null;
  run_superseded_at: string | null;
}

interface RetryStateRow {
  task_state: string;
  designated_run_id: string | null;
  attempt: number | null;
  dispatch_job_id: string | null;
}

function failure(
  code: string,
  detail: string,
  disposition: "terminal" | "retriable" = "retriable",
): V2CommandMutationResult {
  return {
    outcome: "failed",
    failure_disposition: disposition,
    http_status: 409,
    body: { error: code, detail },
  };
}

function errorBody(body: unknown): { code: string; detail: string } {
  if (typeof body !== "object" || body === null) {
    return { code: "recovery_conflict", detail: "recovery could not be applied" };
  }
  const record = body as Record<string, unknown>;
  return {
    code: typeof record.error === "string" ? record.error : "recovery_conflict",
    detail:
      typeof record.detail === "string"
        ? record.detail
        : typeof record.error === "string"
          ? record.error
          : "recovery could not be applied",
  };
}

function recoveryAdjustmentMatches(
  stored: unknown,
  expected: Phase4RecoveryBaseInput["adjustment"],
): boolean {
  if (!expected) return stored === null || stored === undefined;
  if (typeof stored !== "object" || stored === null) return false;
  const record = stored as Record<string, unknown>;
  return (
    record.budget_limit_usd === expected.budget_limit_usd &&
    record.provider === expected.provider &&
    record.model === expected.model
  );
}

function assertExecuted(result: V2CommandExecutionResult): {
  replayed: boolean;
  command_id: string;
} {
  if (result.kind === "command_in_progress") {
    throw new Phase4RecoveryActionError(
      "recovery_in_progress",
      "an identical recovery request is still in progress",
    );
  }
  if (result.kind === "idempotency_conflict") {
    throw new Phase4RecoveryActionError(
      "idempotency_conflict",
      `this idempotency key was already used for a different recovery request (${result.reason})`,
      409,
      false,
    );
  }
  if (result.response.outcome === "failed") {
    const body = errorBody(result.response.body);
    throw new Phase4RecoveryActionError(
      body.code,
      body.detail,
      result.response.http_status,
      result.response.retriable,
    );
  }
  return { replayed: result.kind === "replayed", command_id: result.command_id };
}

async function recoveryScope(
  sql: V2SqlExecutor,
  input: Phase4RecoveryBaseInput,
): Promise<RecoveryScopeRow | null> {
  const result = await sql.query<RecoveryScopeRow>(
    `SELECT task.state AS task_state,
            task.aggregate_version AS task_aggregate_version,
            task.designated_run_id,
            phase.status AS phase_status,
            run.state AS run_state,
            run.attempt AS run_attempt,
            run.is_designated AS run_is_designated,
            run.superseded_at AS run_superseded_at
       FROM tasks task
       JOIN phases phase
         ON phase.id=task.phase_id AND phase.project_id=task.project_id
       JOIN agent_runs run
         ON run.id=$4 AND run.task_id=task.id
      WHERE task.project_id=$1 AND task.phase_id=$2 AND task.id=$3
      FOR UPDATE OF task, phase, run`,
    [input.project_id, input.phase_id, input.task_id, input.failed_run_id],
  );
  return result.rows[0] ?? null;
}

/**
 * Human-authorized recovery for a terminal execution attempt.
 *
 * Retry is intentionally two-stage. The idempotent application command first
 * makes the failed task schedulable. PhaseLaunchService then reuses the normal
 * coordinator gates and creates attempt N+1. If the process dies between the
 * two, replaying the same key observes the prepared task and finishes launch.
 */
export class Phase4RecoveryActionService {
  constructor(
    private readonly transactions: V2TransactionRunner,
    private readonly phaseLaunch: PhaseLaunchService,
  ) {}

  /**
   * The saga below is idempotent on `input.idempotency_key` (a replay returns
   * the recorded outcome), so a transient deadlock/serialization failure —
   * live: a retry colliding with the 60s recovery monitor surfaced to the
   * human as "409 deadlock detected" after the run had already started — is
   * simply re-run rather than reported.
   */
  retry(input: Phase4RecoveryBaseInput): Promise<Phase4RetryResult> {
    return withTransientPgRetry(() => this.retryOnce(input));
  }

  private async retryOnce(input: Phase4RecoveryBaseInput): Promise<Phase4RetryResult> {
    const prepared = await this.preparedRetry(input);
    let replayed = true;
    let recoveryCommandId = prepared?.command_id ?? "";
    if (!prepared) {
      const command = V2RetryTaskCommand.parse({
        schema_version: 2,
        kind: "retry_task",
        command_id: newId("command"),
        command_family: "task_execution",
        actor: input.actor,
        idempotency_key: input.idempotency_key,
        correlation_id: input.correlation_id,
        causation_id: input.causation_id,
        issued_at: input.issued_at,
        project_id: input.project_id,
        phase_id: input.phase_id,
        task_id: input.task_id,
        failed_run_id: input.failed_run_id,
        expected_task_version: input.expected_task_version,
        retry_policy_ref: "retry-policy:terminal-failure",
        adjustment: input.adjustment,
      });
      const execution = await executeV2ApplicationCommand({
        command,
        transactionRunner: this.transactions,
        transactionFactory: recoveryTransactionFactory,
        mutate: async (tx, parsed): Promise<V2CommandMutationResult> => {
          const retry = parsed as typeof command;
          const scope = await recoveryScope(tx.executor, input);
          if (!scope) {
            return failure("recovery_scope_not_found", "the requested task or phase was not found");
          }
          if (scope.task_aggregate_version !== retry.expected_task_version) {
            return v2ExpectedVersionConflict({
              entity_type: "task",
              entity_id: retry.task_id,
              expected_version: retry.expected_task_version,
              actual_version: scope.task_aggregate_version,
            });
          }
          if (!["active", "blocked"].includes(scope.phase_status)) {
            return failure(
              "phase_not_active",
              `the phase is ${scope.phase_status}; only an active or blocked failed phase can be retried`,
            );
          }
          if (
            scope.designated_run_id !== retry.failed_run_id ||
            scope.run_is_designated !== true ||
            scope.run_superseded_at !== null
          ) {
            return failure(
              "failed_run_not_designated",
              "the requested failed run is no longer the current designated attempt",
            );
          }
          // `cancelled` is retryable too: a stop aimed at a hung or dead run
          // (the task ends up `blocked`, not terminally `cancelled`) must
          // leave the user a way to try again.
          if (!["failed", "expired", "cancelled"].includes(scope.run_state ?? "")) {
            return failure(
              "run_not_retryable",
              `the designated run is ${scope.run_state ?? "missing"}, not failed, expired, or cancelled`,
            );
          }
          // `ready` is retryable so a half-completed retry (task prepared,
          // launch refused — runner offline, capacity, context) can be
          // re-kicked instead of dead-ending with no UI path forward.
          if (!["failed", "blocked", "ready"].includes(scope.task_state)) {
            return failure(
              "task_not_retryable",
              `the task is ${scope.task_state}, not failed, blocked, or ready`,
            );
          }
          // A phase the recovery monitor parked as `blocked` (nothing left
          // that could run) goes back to work the moment a human retries.
          await tx.executor.query(
            `UPDATE phases
                SET status='active', aggregate_version=aggregate_version+1, updated_at=now()
              WHERE id=$1 AND project_id=$2 AND status='blocked'`,
            [retry.phase_id, retry.project_id],
          );

          if (retry.adjustment) {
            const assignmentResult = await tx.executor.query<{
              id: string;
              budget_limit_usd: string | number;
              agent_profile_id: string;
            }>(
              `SELECT assignment.id, assignment.budget_limit_usd,
                      assignment.agent_profile_id
                 FROM tasks task
                 JOIN agent_assignments assignment
                   ON assignment.id=task.designated_assignment_id
                WHERE task.project_id=$1 AND task.phase_id=$2 AND task.id=$3
                FOR UPDATE OF assignment`,
              [retry.project_id, retry.phase_id, retry.task_id],
            );
            const assignment = assignmentResult.rows[0];
            if (!assignment) {
              return failure(
                "recovery_assignment_not_found",
                "the task no longer has an agent assignment to adjust",
              );
            }

            let agentProfileId = assignment.agent_profile_id;
            if (retry.adjustment.provider && retry.adjustment.model) {
              const profileResult = await tx.executor.query<{ id: string }>(
                `SELECT id FROM agent_profiles
                  WHERE provider=$1 AND model=$2 AND status IN ('available','busy')
                  ORDER BY CASE WHEN status='available' THEN 0 ELSE 1 END,
                           active_workload, id
                  LIMIT 1`,
                [retry.adjustment.provider, retry.adjustment.model],
              );
              const profile = profileResult.rows[0];
              if (!profile) {
                return failure(
                  "recovery_agent_unavailable",
                  `${retry.adjustment.provider} ${retry.adjustment.model} is not available for development`,
                );
              }
              agentProfileId = profile.id;
            }

            const currentBudget = Number(assignment.budget_limit_usd);
            const nextBudget = retry.adjustment.budget_limit_usd ?? currentBudget;
            if (
              retry.adjustment.budget_limit_usd !== undefined &&
              retry.adjustment.budget_limit_usd <= currentBudget
            ) {
              return failure(
                "recovery_budget_not_increased",
                `the new automatic limit must be greater than the current $${currentBudget.toFixed(2)} limit`,
              );
            }
            await tx.executor.query(
              `UPDATE agent_assignments
                  SET agent_profile_id=$2, budget_limit_usd=$3,
                      aggregate_version=aggregate_version+1, updated_at=$4
                WHERE id=$1`,
              [assignment.id, agentProfileId, nextBudget, retry.issued_at],
            );
            if (retry.adjustment.budget_limit_usd !== undefined) {
              await tx.executor.query(
                `UPDATE phases
                    SET approved_budget_usd=GREATEST(approved_budget_usd,$2),
                        aggregate_version=aggregate_version+1, updated_at=$3
                  WHERE id=$1`,
                [retry.phase_id, nextBudget, retry.issued_at],
              );
            }
          }

          const actor = {
            actor_type: retry.actor.actor_type,
            actor_id: retry.actor.actor_id,
            correlation_id: retry.correlation_id,
            causation_id: retry.causation_id,
            occurred_at: retry.issued_at,
          } as const;
          let task = await tx.lockTaskLifecycle(retry.task_id);
          if (!task) return failure("recovery_scope_not_found", "the task disappeared");
          if (task.state === "failed") {
            task = await transitionV2TaskLifecycle(tx, {
              ...actor,
              project_id: retry.project_id,
              phase_id: retry.phase_id,
              task_id: retry.task_id,
              expected_aggregate_version: task.aggregate_version,
              to: "in_progress",
              reason: `retry authorized for terminal run ${retry.failed_run_id}`,
            });
            task = await transitionV2TaskLifecycle(tx, {
              ...actor,
              project_id: retry.project_id,
              phase_id: retry.phase_id,
              task_id: retry.task_id,
              expected_aggregate_version: task.aggregate_version,
              to: "blocked",
              reason: "closing the failed execution attempt before replacement",
            });
          }
          if (task.state !== "ready") {
            await transitionV2TaskLifecycle(tx, {
              ...actor,
              project_id: retry.project_id,
              phase_id: retry.phase_id,
              task_id: retry.task_id,
              expected_aggregate_version: task.aggregate_version,
              to: "ready",
              reason: `terminal retry prepared for ${retry.failed_run_id}`,
            });
          }
          return {
            outcome: "succeeded",
            http_status: 202,
            body: {
              action: "retry",
              task_id: retry.task_id,
              failed_run_id: retry.failed_run_id,
              prepared: true,
              adjustment: retry.adjustment ?? null,
            },
          };
        },
      });
      const executed = assertExecuted(execution);
      replayed = executed.replayed;
      recoveryCommandId = executed.command_id;
    }

    let launch: PhaseLaunchResult | null = null;
    const before = await this.retryState(input.task_id);
    if (before.task_state === "ready" && before.designated_run_id === input.failed_run_id) {
      launch = await this.phaseLaunch.startPhase({
        project_id: input.project_id,
        phase_id: input.phase_id,
        authorized_by: input.actor,
        authorized_by_session_id: input.authorized_by_session_id,
        issued_at: input.issued_at,
        retry: { task_id: input.task_id, failed_run_id: input.failed_run_id },
      });
    }

    const after = await this.retryState(input.task_id);
    const started =
      after.designated_run_id !== null && after.designated_run_id !== input.failed_run_id;
    if (started && input.resolve_decisions !== false) {
      await this.resolveRecoveryDecisions(input, "retry", recoveryCommandId);
    }
    const blockedDetail = launch?.blocked.find((item) => item.task_id === input.task_id);
    return {
      action: "retry",
      replayed,
      started,
      phase_id: input.phase_id,
      task_id: input.task_id,
      prior_run_id: input.failed_run_id,
      run_id: started ? after.designated_run_id : null,
      attempt: started ? after.attempt : null,
      dispatch_job_id: started ? after.dispatch_job_id : null,
      detail: started
        ? `attempt ${after.attempt ?? "next"} was queued for dispatch`
        : (blockedDetail?.blocked_reason ??
          "retry is prepared and will start when execution prerequisites are available"),
    };
  }

  cancel(input: Phase4RecoveryBaseInput & { reason: string }): Promise<Phase4CancelResult> {
    return withTransientPgRetry(() => this.cancelOnce(input));
  }

  private async cancelOnce(
    input: Phase4RecoveryBaseInput & { reason: string },
  ): Promise<Phase4CancelResult> {
    const command = V2CancelTaskCommand.parse({
      schema_version: 2,
      kind: "cancel_task",
      command_id: newId("command"),
      command_family: "task_execution",
      actor: input.actor,
      idempotency_key: input.idempotency_key,
      correlation_id: input.correlation_id,
      causation_id: input.causation_id,
      issued_at: input.issued_at,
      project_id: input.project_id,
      phase_id: input.phase_id,
      task_id: input.task_id,
      expected_task_version: input.expected_task_version,
      reason: input.reason,
    });
    const execution = await executeV2ApplicationCommand({
      command,
      transactionRunner: this.transactions,
      transactionFactory: recoveryTransactionFactory,
      mutate: async (tx, parsed): Promise<V2CommandMutationResult> => {
        const cancel = parsed as typeof command;
        const scope = await recoveryScope(tx.executor, input);
        if (!scope) {
          return failure("recovery_scope_not_found", "the requested task or phase was not found");
        }
        if (scope.task_aggregate_version !== cancel.expected_task_version) {
          return v2ExpectedVersionConflict({
            entity_type: "task",
            entity_id: cancel.task_id,
            expected_version: cancel.expected_task_version,
            actual_version: scope.task_aggregate_version,
          });
        }
        if (!["active", "blocked"].includes(scope.phase_status)) {
          return failure(
            "phase_not_active",
            `the phase is ${scope.phase_status}; only an active or blocked failed phase can be cancelled`,
          );
        }
        if (
          scope.designated_run_id !== input.failed_run_id ||
          scope.run_is_designated !== true ||
          !["failed", "expired"].includes(scope.run_state ?? "")
        ) {
          return failure(
            "failed_run_not_designated",
            "the requested failed run is not the current terminal attempt",
          );
        }
        const live = await tx.executor.query<{ count: number }>(
          `SELECT count(*)::int AS count
             FROM agent_runs
            WHERE phase_id=$1 AND state IN ('created','dispatched','running','verifying')`,
          [input.phase_id],
        );
        if ((live.rows[0]?.count ?? 0) > 0) {
          return failure(
            "phase_has_live_runs",
            "the phase still has live runs; cancel those runs before closing the phase",
          );
        }

        const tasks = await tx.executor.query<{ id: string }>(
          `SELECT id FROM tasks
            WHERE project_id=$1 AND phase_id=$2
              AND state NOT IN ('completed','cancelled')
            ORDER BY id
            FOR UPDATE`,
          [input.project_id, input.phase_id],
        );
        const actor = {
          actor_type: cancel.actor.actor_type,
          actor_id: cancel.actor.actor_id,
          correlation_id: cancel.correlation_id,
          causation_id: cancel.causation_id,
          occurred_at: cancel.issued_at,
        } as const;
        for (const row of tasks.rows) {
          const task = await tx.lockTaskLifecycle(row.id);
          if (!task || task.state === "cancelled" || task.state === "completed") continue;
          await transitionV2TaskLifecycle(tx, {
            ...actor,
            project_id: cancel.project_id,
            phase_id: cancel.phase_id,
            task_id: task.id,
            expected_aggregate_version: task.aggregate_version,
            to: "cancelled",
            reason: cancel.reason,
          });
        }
        await tx.executor.query(
          `UPDATE agent_assignments
              SET status='cancelled', aggregate_version=aggregate_version+1, updated_at=now()
            WHERE phase_id=$1 AND status IN ('proposed','active')`,
          [cancel.phase_id],
        );
        await tx.executor.query(
          `UPDATE objectives
              SET status='cancelled', aggregate_version=aggregate_version+1, updated_at=now()
            WHERE phase_id=$1 AND status IN ('proposed','active')`,
          [cancel.phase_id],
        );
        await tx.executor.query(
          `UPDATE phases
              SET status='cancelled', closed_at=$2, closure_summary=$3,
                  closure_evidence=$4::jsonb,
                  aggregate_version=aggregate_version+1, updated_at=now()
            WHERE id=$1 AND project_id=$5 AND status IN ('active','blocked')`,
          [
            cancel.phase_id,
            cancel.issued_at,
            `Cancelled after terminal run ${input.failed_run_id}: ${cancel.reason}`,
            JSON.stringify([
              {
                kind: "terminal_failure_cancellation",
                failed_run_id: input.failed_run_id,
                actor: cancel.actor,
              },
            ]),
            cancel.project_id,
          ],
        );
        if (input.resolve_decisions !== false) {
          await tx.executor.query(
            `UPDATE decision_points
                SET status='resolved', resolved_at=$2, updated_at=$2
              WHERE phase_id=$1 AND status='open'
                AND (task_id=$3 OR scope_entity_id=$4)`,
            [cancel.phase_id, cancel.issued_at, cancel.task_id, input.failed_run_id],
          );
        }
        return {
          outcome: "succeeded",
          http_status: 200,
          body: {
            action: "cancel",
            task_id: cancel.task_id,
            failed_run_id: input.failed_run_id,
            phase_status: "cancelled",
          },
        };
      },
    });
    const { replayed } = assertExecuted(execution);
    return {
      action: "cancel",
      replayed,
      phase_id: input.phase_id,
      task_id: input.task_id,
      prior_run_id: input.failed_run_id,
      phase_status: "cancelled",
    };
  }

  /**
   * A retry is deliberately split into durable preparation and launch. If
   * launch throws after preparation, the task version has advanced, so a
   * browser replay cannot reconstruct the original command fingerprint from
   * current task state. Recover the committed preparation by its idempotency
   * scope and verify its exact task/run identity before continuing launch.
   */
  private async preparedRetry(
    input: Phase4RecoveryBaseInput,
  ): Promise<{ command_id: string } | null> {
    return this.transactions.transaction(async (sql) => {
      const result = await sql.query<{
        command_id: string;
        status: string;
        response: unknown;
      }>(
        `SELECT command_id, status, response
           FROM idempotency_records
          WHERE actor_id=$1 AND command_family='task_execution' AND idempotency_key=$2`,
        [input.actor.actor_id, input.idempotency_key],
      );
      const prior = result.rows[0];
      if (!prior) return null;
      if (prior.status === "in_progress") {
        throw new Phase4RecoveryActionError(
          "recovery_in_progress",
          "an identical recovery request is still in progress",
        );
      }
      const response =
        prior.response && typeof prior.response === "object"
          ? (prior.response as Record<string, unknown>)
          : {};
      const body =
        response.body && typeof response.body === "object"
          ? (response.body as Record<string, unknown>)
          : {};
      if (
        prior.status !== "committed_succeeded" ||
        response.outcome !== "succeeded" ||
        body.action !== "retry" ||
        body.task_id !== input.task_id ||
        body.failed_run_id !== input.failed_run_id ||
        body.prepared !== true ||
        !recoveryAdjustmentMatches(body.adjustment, input.adjustment)
      ) {
        throw new Phase4RecoveryActionError(
          "idempotency_conflict",
          "this idempotency key belongs to a different recovery request",
          409,
          false,
        );
      }
      return { command_id: prior.command_id };
    });
  }

  private async retryState(taskId: string): Promise<RetryStateRow> {
    return this.transactions.transaction(async (sql) => {
      const result = await sql.query<RetryStateRow>(
        `SELECT task.state AS task_state, task.designated_run_id,
                run.attempt, job.id AS dispatch_job_id
           FROM tasks task
           LEFT JOIN agent_runs run ON run.id=task.designated_run_id
           LEFT JOIN dispatch_jobs job ON job.run_id=run.id
          WHERE task.id=$1`,
        [taskId],
      );
      const row = result.rows[0];
      if (!row) {
        throw new Phase4RecoveryActionError(
          "recovery_scope_not_found",
          "the task disappeared during recovery",
          404,
          false,
        );
      }
      return row;
    });
  }

  private async resolveRecoveryDecisions(
    input: Phase4RecoveryBaseInput,
    action: "retry" | "cancel",
    recoveryCommandId: string,
  ): Promise<void> {
    await this.transactions.transaction(async (sql) => {
      await sql.query(
        `UPDATE decision_points
            SET status='resolved', resolved_at=$3, updated_at=$3
          WHERE phase_id=$1 AND status='open'
            AND (task_id=$2 OR scope_entity_id=$4)`,
        [input.phase_id, input.task_id, input.issued_at, input.failed_run_id],
      );
      await sql.query(
        `INSERT INTO audit_events (
           audit_id, audit_type, project_id, phase_id, task_id,
           actor_type, actor_id, outcome, severity, correlation_id,
           causation_id, occurred_at, targets, summary, details,
           redaction_applied
         ) VALUES (
           $1,'execution.recovery.applied',$2,$3,$4,$5,$6,'succeeded','info',
           $7,$8,$9,$10::jsonb,$11,$12::jsonb,true
         )
         ON CONFLICT (audit_id) DO NOTHING`,
        [
          `audit:recovery:${recoveryCommandId}`,
          input.project_id,
          input.phase_id,
          input.task_id,
          input.actor.actor_type,
          input.actor.actor_id,
          input.correlation_id,
          input.causation_id,
          input.issued_at,
          JSON.stringify([{ entity_type: "agent_run", entity_id: input.failed_run_id }]),
          `Terminal run recovery ${action} applied`,
          JSON.stringify({ action, failed_run_id: input.failed_run_id }),
        ],
      );
    });
  }
}
