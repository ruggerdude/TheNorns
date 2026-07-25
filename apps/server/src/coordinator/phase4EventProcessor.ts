import {
  EventEnvelope,
  type EventEnvelopeInputT,
  V2EvidenceRef,
  type V2EvidenceRefT,
  resolveV2BudgetReservation,
} from "@norns/contracts";
import { canonicalSha256 } from "../persistence/migration/canonicalJson.js";
import type { V2SqlExecutor, V2TransactionRunner } from "../persistence/v2/database.js";
import {
  transitionV2AgentRunLifecycle,
  transitionV2TaskLifecycle,
} from "../persistence/v2/lifecycleMutation.js";
import {
  SqlV2ApplicationTransaction,
  SqlV2BudgetTransaction,
} from "../persistence/v2/sqlRepositories.js";
import {
  type Phase4KnowledgeEvent,
  Phase4KnowledgeEventAdapter,
} from "./phase4KnowledgeEventAdapter.js";
import { dismissRecoveryDecisionsForSuccessfulRun } from "./phase4TerminalReconciliation.js";
import { RunIntegrationConflictService } from "./runIntegrationConflicts.js";

/**
 * Per-command output kept on the verification row. Generous enough to hold a
 * real failing test suite's tail, bounded so a runaway one cannot make the row
 * unreadable or the read model expensive.
 */
export const VERIFICATION_OUTPUT_LIMIT = 20_000;

export class Phase4RunnerEventRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Phase4RunnerEventRejectedError";
  }
}

interface RunScope {
  id: string;
  project_id: string;
  phase_id: string;
  task_id: string;
  state: string;
  aggregate_version: number;
  runner_id: string | null;
  repository_binding_id: string;
  expected_revision: string;
  assignment_id: string;
  reviewer_agent_profile_id: string | null;
  execution_mode: "quick" | "planned";
  verification_policy_ref: string;
  task_state: string;
  task_aggregate_version: number;
}

interface ReconciledRunUsage {
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  gateway_events: number;
}

export class Phase4EventProcessor {
  constructor(
    private readonly transactions: V2TransactionRunner,
    private readonly knowledge = new Phase4KnowledgeEventAdapter(),
  ) {}

  apply(input: EventEnvelopeInputT): Promise<{ duplicate: boolean; ignored?: boolean }> {
    const event = EventEnvelope.parse(input);
    return this.transactions.transaction(async (sql) => {
      const revocation = await sql.query<{ revoked_through_generation: number }>(
        "SELECT revoked_through_generation FROM runner_revocations WHERE runner_id=$1",
        [event.runner_id],
      );
      if (revocation.rows[0] && event.generation <= revocation.rows[0].revoked_through_generation) {
        throw new Phase4RunnerEventRejectedError("runner generation is revoked");
      }
      const eventId = `runner-event:${event.runner_id}:${event.generation}:${event.event_seq}`;
      const inserted = await sql.query<{ id: string }>(
        `INSERT INTO runner_events (
           id, runner_id, runner_generation, run_id, sequence, event_type, payload
         ) VALUES ($1,$2,$3,NULL,$4,$5,$6::jsonb)
         ON CONFLICT (runner_id, runner_generation, sequence) DO NOTHING
         RETURNING id`,
        [
          eventId,
          event.runner_id,
          event.generation,
          event.event_seq,
          event.payload.kind,
          JSON.stringify(event.payload),
        ],
      );
      if (!inserted.rows[0]) return { duplicate: true };

      if (event.payload.kind === "heartbeat" || event.payload.kind === "run_log") {
        await sql.query("UPDATE runner_events SET applied_at = now() WHERE id = $1", [eventId]);
        return { duplicate: false };
      }
      if (event.payload.kind === "command_ack") {
        const command = await sql.query<{ runner_generation: number; run_id: string }>(
          "SELECT runner_generation, run_id FROM commands WHERE command_id = $1 FOR UPDATE",
          [event.payload.command_id],
        );
        const row = command.rows[0];
        if (!row) {
          await sql.query("DELETE FROM runner_events WHERE id = $1", [eventId]);
          return { duplicate: false, ignored: true };
        }
        if (row.runner_generation !== event.generation) {
          throw new Phase4RunnerEventRejectedError("command acknowledgement is fenced or unknown");
        }
        await sql.query(
          "UPDATE commands SET status = $2, updated_at = now() WHERE command_id = $1",
          [event.payload.command_id, event.payload.state],
        );
        if (
          ["succeeded", "failed", "rejected", "expired", "cancelled"].includes(event.payload.state)
        ) {
          await sql.query(
            `UPDATE dispatch_jobs SET status = 'completed', completed_at = now(), updated_at = now()
             WHERE command_id = $1 AND status IN ('delivered','completed')`,
            [event.payload.command_id],
          );
        }
        if (["failed", "rejected", "expired", "cancelled"].includes(event.payload.state)) {
          const failedScope = await sql.query<RunScope>(
            `SELECT run.id, run.project_id, run.phase_id, run.task_id, run.state,
                    run.aggregate_version, run.runner_id, run.repository_binding_id,
                    run.expected_revision, run.assignment_id,
                    assignment.reviewer_agent_profile_id,
                    COALESCE(planning.mode, 'planned') AS execution_mode,
                    task.verification_policy_ref, task.state AS task_state,
                    task.aggregate_version AS task_aggregate_version
             FROM agent_runs run
             JOIN tasks task ON task.id=run.task_id
             JOIN agent_assignments assignment ON assignment.id=run.assignment_id
             JOIN phases phase ON phase.id=run.phase_id
             LEFT JOIN planning_runs planning ON planning.id=phase.planning_run_id
             WHERE run.id=$1 FOR UPDATE OF run, task`,
            [row.run_id],
          );
          const scope = failedScope.rows[0];
          if (scope) {
            const lifecycle = new SqlV2ApplicationTransaction(sql);
            const actor = {
              actor_type: "runner" as const,
              actor_id: event.runner_id,
              correlation_id: event.correlation_id,
              causation_id: event.causation_id,
              occurred_at: event.occurred_at,
            };
            const run = await lifecycle.lockAgentRunLifecycle(scope.id);
            if (run && !["succeeded", "failed", "cancelled", "expired"].includes(run.state)) {
              const runTarget =
                event.payload.state === "cancelled"
                  ? "cancelled"
                  : event.payload.state === "expired" || run.state === "created"
                    ? "expired"
                    : "failed";
              await transitionV2AgentRunLifecycle(lifecycle, {
                ...actor,
                project_id: scope.project_id,
                phase_id: scope.phase_id,
                task_id: scope.task_id,
                run_id: scope.id,
                expected_aggregate_version: run.aggregate_version,
                to: runTarget,
                reason: `command ${event.payload.state} before successful completion`,
              });
            }
            const task = await lifecycle.lockTaskLifecycle(scope.task_id);
            if (task && !["completed", "failed", "cancelled"].includes(task.state)) {
              await transitionV2TaskLifecycle(lifecycle, {
                ...actor,
                project_id: scope.project_id,
                phase_id: scope.phase_id,
                task_id: scope.task_id,
                expected_aggregate_version: task.aggregate_version,
                to: event.payload.state === "cancelled" ? "cancelled" : "blocked",
                reason: `command ${event.payload.state} requires operator attention`,
              });
            }
          }
        }
        const terminalCommandState =
          event.payload.state === "succeeded" ||
          event.payload.state === "failed" ||
          event.payload.state === "rejected" ||
          event.payload.state === "expired" ||
          event.payload.state === "cancelled"
            ? event.payload.state
            : null;
        if (terminalCommandState) {
          await this.settleTerminalUsage(sql, row.run_id, terminalCommandState, {
            runner_id: event.runner_id,
            correlation_id: event.correlation_id,
            causation_id: event.causation_id,
            occurred_at: event.occurred_at,
          });
        }
        await sql.query("UPDATE runner_events SET run_id = $2, applied_at = now() WHERE id = $1", [
          eventId,
          row.run_id,
        ]);
        return { duplicate: false };
      }

      const runId = "run_id" in event.payload ? event.payload.run_id : null;
      const scopeResult = await sql.query<RunScope>(
        runId
          ? `SELECT run.id, run.project_id, run.phase_id, run.task_id, run.state,
                    run.aggregate_version, run.runner_id, run.repository_binding_id,
                    run.expected_revision, run.assignment_id,
                    assignment.reviewer_agent_profile_id,
                    COALESCE(planning.mode, 'planned') AS execution_mode,
                    task.verification_policy_ref, task.state AS task_state,
                    task.aggregate_version AS task_aggregate_version
             FROM agent_runs run
             JOIN tasks task ON task.id = run.task_id
             JOIN agent_assignments assignment ON assignment.id=run.assignment_id
             JOIN phases phase ON phase.id=run.phase_id
             LEFT JOIN planning_runs planning ON planning.id=phase.planning_run_id
             WHERE run.id = $1 FOR UPDATE OF run, task`
          : `SELECT run.id, run.project_id, run.phase_id, run.task_id, run.state,
                    run.aggregate_version, run.runner_id, run.repository_binding_id,
                    run.expected_revision, run.assignment_id,
                    assignment.reviewer_agent_profile_id,
                    COALESCE(planning.mode, 'planned') AS execution_mode,
                    task.verification_policy_ref, task.state AS task_state,
                    task.aggregate_version AS task_aggregate_version
             FROM tasks task
             JOIN agent_runs run ON run.id = task.designated_run_id
             JOIN agent_assignments assignment ON assignment.id=run.assignment_id
             JOIN phases phase ON phase.id=run.phase_id
             LEFT JOIN planning_runs planning ON planning.id=phase.planning_run_id
             WHERE task.id = $1 FOR UPDATE OF run, task`,
        [runId ?? (event.payload.kind === "verification_result" ? event.payload.node_id : "")],
      );
      const scope = scopeResult.rows[0];
      if (!scope) {
        await sql.query("DELETE FROM runner_events WHERE id = $1", [eventId]);
        return { duplicate: false, ignored: true };
      }
      if (scope.runner_id !== event.runner_id) {
        throw new Phase4RunnerEventRejectedError("runner event does not match its designated run");
      }
      const commandGeneration = await sql.query<{ runner_generation: number }>(
        "SELECT runner_generation FROM commands WHERE run_id = $1",
        [scope.id],
      );
      if (commandGeneration.rows[0]?.runner_generation !== event.generation) {
        throw new Phase4RunnerEventRejectedError("runner event generation is fenced");
      }
      await sql.query("UPDATE runner_events SET run_id = $2 WHERE id = $1", [eventId, scope.id]);
      const lifecycle = new SqlV2ApplicationTransaction(sql);
      const actor = {
        actor_type: "runner" as const,
        actor_id: event.runner_id,
        correlation_id: event.correlation_id,
        causation_id: event.causation_id,
        occurred_at: event.occurred_at,
      };

      if (
        event.payload.kind === "knowledge_registration" ||
        event.payload.kind === "knowledge_heartbeat" ||
        event.payload.kind === "knowledge_delta" ||
        event.payload.kind === "knowledge_handoff"
      ) {
        await this.knowledge.apply(sql, event as Phase4KnowledgeEvent, scope);
      } else if (event.payload.kind === "run_status" && event.payload.status === "started") {
        if (scope.state === "dispatched") {
          await transitionV2AgentRunLifecycle(lifecycle, {
            ...actor,
            project_id: scope.project_id,
            phase_id: scope.phase_id,
            task_id: scope.task_id,
            run_id: scope.id,
            expected_aggregate_version: scope.aggregate_version,
            to: "running",
            reason: "runner started execution",
          });
        }
        if (scope.task_state === "assigned") {
          await transitionV2TaskLifecycle(lifecycle, {
            ...actor,
            project_id: scope.project_id,
            phase_id: scope.phase_id,
            task_id: scope.task_id,
            expected_aggregate_version: scope.task_aggregate_version,
            to: "in_progress",
            reason: "designated run started",
          });
        }
      } else if (event.payload.kind === "usage_report") {
        await sql.query(
          `UPDATE agent_runs SET usage_input_tokens = $2, usage_output_tokens = $3,
                                 updated_at = now() WHERE id = $1`,
          [scope.id, event.payload.input_tokens, event.payload.output_tokens],
        );
      } else if (event.payload.kind === "runtime_result") {
        await sql.query(
          `UPDATE agent_runs
              SET runtime_session_id = COALESCE($2, runtime_session_id),
                  result_summary = $3, updated_at = now()
            WHERE id = $1`,
          [
            scope.id,
            event.payload.session_id,
            [
              `${event.payload.runtime} ${event.payload.outcome}`,
              event.payload.stop_reason ? `stop=${event.payload.stop_reason}` : null,
              event.payload.detail || null,
            ]
              .filter(Boolean)
              .join(": ")
              .slice(0, 4_000),
          ],
        );
      } else if (event.payload.kind === "verification_result") {
        const currentRun = await lifecycle.lockAgentRunLifecycle(scope.id);
        if (currentRun?.state === "running") {
          await transitionV2AgentRunLifecycle(lifecycle, {
            ...actor,
            project_id: scope.project_id,
            phase_id: scope.phase_id,
            task_id: scope.task_id,
            run_id: scope.id,
            expected_aggregate_version: currentRun.aggregate_version,
            to: "verifying",
            reason: "runner produced exact-commit verification",
          });
        }
        const currentTask = await lifecycle.lockTaskLifecycle(scope.task_id);
        if (currentTask?.state === "in_progress") {
          await transitionV2TaskLifecycle(lifecycle, {
            ...actor,
            project_id: scope.project_id,
            phase_id: scope.phase_id,
            task_id: scope.task_id,
            expected_aggregate_version: currentTask.aggregate_version,
            to: "verifying",
            reason: "verification evidence received",
          });
        }
        const verificationId = `verification:${event.runner_id}:${event.generation}:${event.event_seq}`;
        // EXECUTION E10 — record the REAL per-command results.
        //
        // This column was written as a hardcoded `'[]'::jsonb`. The runner has
        // produced per-command results since E4 and the event contract had
        // nowhere to carry them, so every failed verification reached a human
        // as a red badge above a sha256 digest of text that was never stored.
        // `command_results` now holds what actually ran, in execution order,
        // with the failing command's output attached.
        //
        // The shape is the RUNNER's (`name`, `command`, `exit_code`, `passed`,
        // `output`), not `V2VerificationCommandResult` from the evidence
        // contract, which models each output as a content-addressed artifact
        // reference. Nothing on this path has an artifact store; writing an
        // artifact ref that points at nothing would be worse than storing the
        // output inline. Output is truncated on the way in so one pathological
        // test suite cannot bloat the row unboundedly.
        const commandResults = (event.payload.command_results ?? []).map((result) => ({
          name: result.name,
          command: result.command,
          exit_code: result.exit_code,
          passed: result.passed,
          output: result.output.slice(0, VERIFICATION_OUTPUT_LIMIT),
        }));
        await sql.query(
          `INSERT INTO verification_results (
             id, project_id, phase_id, task_id, run_id, repository_binding_id,
             commit_sha, verification_policy_ref, passed, command_results,
             evidence, produced_by_runner_id
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$12::jsonb,$10::jsonb,$11)`,
          [
            verificationId,
            scope.project_id,
            scope.phase_id,
            scope.task_id,
            scope.id,
            scope.repository_binding_id,
            event.payload.commit_sha,
            scope.verification_policy_ref,
            event.payload.passed,
            JSON.stringify([{ output_digest: event.payload.output_digest }]),
            event.runner_id,
            JSON.stringify(commandResults),
          ],
        );
        await sql.query(
          `UPDATE agent_runs SET commit_sha = $2, verification_status = $3, updated_at = now()
           WHERE id = $1`,
          [scope.id, event.payload.commit_sha, event.payload.passed ? "passed" : "failed"],
        );
      } else if (event.payload.kind === "run_published") {
        // EXECUTION E10 — persist where the run's work went.
        //
        // E4 published a branch and opened a pull request, then reported both
        // as `run_log` prose. Nothing could link a completed task to its
        // review. These columns are that link; the UI reads them straight out
        // of the phase read model.
        //
        // Deliberately NOT a lifecycle transition. Publication is a fact about
        // an existing run, orthogonal to its state — a failed run publishes
        // too, precisely so a human can go read why the tests went red.
        await sql.query(
          `UPDATE agent_runs
              SET published_branch = $2, published_commit_sha = $3,
                  published_remote = $4, pull_request_url = $5,
                  publication_note = $6, publication_outcome = $7,
                  published_at = $8, updated_at = now()
            WHERE id = $1`,
          [
            scope.id,
            event.payload.branch,
            event.payload.commit_sha,
            event.payload.remote,
            event.payload.pull_request_url,
            event.payload.pull_request_note,
            event.payload.outcome,
            event.occurred_at,
          ],
        );
        // EXECUTION E12 — detect an in-phase integration conflict IN THE SAME
        // TRANSACTION as the publication that creates it.
        //
        // Atomicity is the point, not tidiness: if detection ran afterwards
        // and the process died in between, the branch would exist and nothing
        // would have warned anybody. Committing them together makes "a second
        // branch was published" and "a human has been told about it"
        // inseparable facts. Detection never merges, never mutates a run, and
        // never blocks the publication -- it only writes a row a human reads.
        await RunIntegrationConflictService.detect(sql, scope.id);
      } else if (event.payload.kind === "run_status") {
        const currentRun = await lifecycle.lockAgentRunLifecycle(scope.id);
        const currentTask = await lifecycle.lockTaskLifecycle(scope.task_id);
        if (event.payload.status === "completed") {
          const verification = await sql.query<{ verification_status: string }>(
            "SELECT verification_status FROM agent_runs WHERE id = $1",
            [scope.id],
          );
          if (verification.rows[0]?.verification_status !== "passed") {
            throw new Phase4RunnerEventRejectedError("run completion requires green verification");
          }
          if (currentRun?.state === "verifying") {
            await transitionV2AgentRunLifecycle(lifecycle, {
              ...actor,
              project_id: scope.project_id,
              phase_id: scope.phase_id,
              task_id: scope.task_id,
              run_id: scope.id,
              expected_aggregate_version: currentRun.aggregate_version,
              to: "succeeded",
              reason: "runner completed with green verification",
            });
          }
          await dismissRecoveryDecisionsForSuccessfulRun(sql, {
            project_id: scope.project_id,
            phase_id: scope.phase_id,
            task_id: scope.task_id,
            run_id: scope.id,
            actor: { actor_type: "runner", actor_id: event.runner_id },
            occurred_at: event.occurred_at,
          });
          let reviewReadyTask = currentTask;
          if (reviewReadyTask?.state === "verifying") {
            reviewReadyTask = await transitionV2TaskLifecycle(lifecycle, {
              ...actor,
              project_id: scope.project_id,
              phase_id: scope.phase_id,
              task_id: scope.task_id,
              expected_aggregate_version: reviewReadyTask.aggregate_version,
              to: "in_review",
              reason:
                scope.execution_mode === "quick" && scope.reviewer_agent_profile_id === null
                  ? "Quick Change verification passed; independent review is not required"
                  : "verified result awaiting review",
            });
          }
          if (
            scope.execution_mode === "quick" &&
            scope.reviewer_agent_profile_id === null &&
            reviewReadyTask?.state === "in_review"
          ) {
            await this.completeQuickChange(
              sql,
              lifecycle,
              scope,
              reviewReadyTask.aggregate_version,
              actor,
            );
          }
          await sql.query("UPDATE agent_runs SET finished_at = $2 WHERE id = $1", [
            scope.id,
            event.occurred_at,
          ]);
          await this.settleTerminalUsage(sql, scope.id, "succeeded", {
            runner_id: event.runner_id,
            correlation_id: event.correlation_id,
            causation_id: event.causation_id,
            occurred_at: event.occurred_at,
          });
        } else if (["failed", "cancelled"].includes(event.payload.status)) {
          const runTarget = event.payload.status === "cancelled" ? "cancelled" : "failed";
          const failure =
            event.payload.status === "failed"
              ? (event.payload.failure ?? {
                  stage: "unknown",
                  code: "runner_failed",
                  detail: "runner reported failed",
                })
              : {
                  stage: "cancellation",
                  code: "runner_cancelled",
                  detail: "runner reported cancelled",
                };
          const lifecycleReason =
            event.payload.status === "failed"
              ? `${failure.code} during ${failure.stage}: ${failure.detail}`
              : failure.detail;
          if (
            currentRun &&
            !["succeeded", "failed", "cancelled", "expired"].includes(currentRun.state)
          ) {
            await transitionV2AgentRunLifecycle(lifecycle, {
              ...actor,
              project_id: scope.project_id,
              phase_id: scope.phase_id,
              task_id: scope.task_id,
              run_id: scope.id,
              expected_aggregate_version: currentRun.aggregate_version,
              to: runTarget,
              reason: lifecycleReason,
            });
          }
          if (currentTask && !["completed", "cancelled"].includes(currentTask.state)) {
            if (event.payload.status === "cancelled") {
              await transitionV2TaskLifecycle(lifecycle, {
                ...actor,
                project_id: scope.project_id,
                phase_id: scope.phase_id,
                task_id: scope.task_id,
                expected_aggregate_version: currentTask.aggregate_version,
                to: "cancelled",
                reason: lifecycleReason,
              });
            } else if (currentTask.state !== "failed") {
              // A bootstrap failure occurs before `started`, while the task is
              // still assigned. assigned -> failed is intentionally not a
              // legal lifecycle edge, so converge through blocked in the same
              // transaction. Replays see the event row and do nothing.
              const failureReadyTask = ["pending", "ready", "assigned"].includes(currentTask.state)
                ? await transitionV2TaskLifecycle(lifecycle, {
                    ...actor,
                    project_id: scope.project_id,
                    phase_id: scope.phase_id,
                    task_id: scope.task_id,
                    expected_aggregate_version: currentTask.aggregate_version,
                    to: "blocked",
                    reason: lifecycleReason,
                  })
                : currentTask;
              await transitionV2TaskLifecycle(lifecycle, {
                ...actor,
                project_id: scope.project_id,
                phase_id: scope.phase_id,
                task_id: scope.task_id,
                expected_aggregate_version: failureReadyTask.aggregate_version,
                to: "failed",
                reason: lifecycleReason,
              });
            }
          }
          await sql.query(
            "UPDATE agent_runs SET failure_code=$2, failure_detail=$3, finished_at=$4 WHERE id=$1",
            [scope.id, failure.code, `${failure.stage}: ${failure.detail}`, event.occurred_at],
          );
          await this.settleTerminalUsage(
            sql,
            scope.id,
            event.payload.status === "cancelled" ? "cancelled" : "failed",
            {
              runner_id: event.runner_id,
              correlation_id: event.correlation_id,
              causation_id: event.causation_id,
              occurred_at: event.occurred_at,
            },
          );
        }
      }
      await sql.query("UPDATE runner_events SET applied_at = now() WHERE id = $1", [eventId]);
      return { duplicate: false };
    });
  }

  /**
   * Quick Change has no reviewer by design, but V2 still requires every task
   * to traverse the legal verifying -> in_review -> completed lifecycle and to
   * carry review/completion evidence. Here `in_review` is a transactional
   * waypoint, not a queue: the review evidence records the explicit Quick
   * Change waiver backed by exact-commit verification, and the completion
   * evidence is the durable runner handoff for that same published commit.
   */
  private async completeQuickChange(
    sql: V2SqlExecutor,
    lifecycle: SqlV2ApplicationTransaction,
    scope: RunScope,
    expectedTaskVersion: number,
    actor: {
      actor_type: "runner";
      actor_id: string;
      correlation_id: string;
      causation_id: string | null;
      occurred_at: string;
    },
  ): Promise<void> {
    const evidence = await sql.query<{
      verification_id: string;
      verification_commit: string;
      handoff_id: string;
      handoff_payload: unknown;
      handoff_commit: string;
      run_commit: string | null;
      published_commit: string | null;
      publication_outcome: string | null;
    }>(
      `SELECT verification.id AS verification_id,
              verification.commit_sha AS verification_commit,
              handoff.id AS handoff_id,
              handoff.payload AS handoff_payload,
              handoff.payload->>'commit' AS handoff_commit,
              run.commit_sha AS run_commit,
              run.published_commit_sha AS published_commit,
              run.publication_outcome
         FROM agent_runs run
         JOIN verification_results verification
           ON verification.run_id=run.id AND verification.passed=true
         JOIN agent_handoffs handoff
           ON handoff.run_id=run.id AND handoff.status='completed'
        WHERE run.id=$1
        ORDER BY verification.created_at DESC, handoff.submitted_at DESC
        LIMIT 1`,
      [scope.id],
    );
    const durable = evidence.rows[0];
    if (
      !durable ||
      durable.run_commit !== durable.verification_commit ||
      durable.published_commit !== durable.verification_commit ||
      durable.handoff_commit !== durable.verification_commit ||
      !["pushed", "local_only"].includes(durable.publication_outcome ?? "")
    ) {
      throw new Phase4RunnerEventRejectedError(
        "Quick Change completion requires verification, publication, and handoff for the same commit",
      );
    }
    const reviewEvidence: V2EvidenceRefT[] = [
      V2EvidenceRef.parse({
        artifact_id: `quick-review-waiver:${scope.id}`,
        content_hash: canonicalSha256({
          execution_mode: "quick",
          reviewer_agent_profile_id: null,
          verification_result_id: durable.verification_id,
          commit: durable.verification_commit,
        }),
        media_type: "application/vnd.norns.quick-review-waiver+json",
        label: "Quick Change review waiver with exact-commit verification",
      }),
    ];
    const completionEvidence: V2EvidenceRefT[] = [
      V2EvidenceRef.parse({
        artifact_id: durable.handoff_id,
        content_hash: canonicalSha256(durable.handoff_payload),
        media_type: "application/vnd.norns.agent-handoff+json",
        label: "Verified and published Quick Change handoff",
      }),
    ];
    const openConflicts = await sql.query<{ id: string }>(
      `SELECT id FROM run_integration_conflicts
        WHERE status='awaiting_human'
          AND (task_id=$1 OR counterpart_task_id=$1)
        ORDER BY detected_at`,
      [scope.task_id],
    );
    if (openConflicts.rows.length > 0) {
      throw new Phase4RunnerEventRejectedError(
        `Quick Change has unresolved integration conflict(s): ${openConflicts.rows
          .map((conflict) => conflict.id)
          .join(", ")}`,
      );
    }
    const deltaEvidence = await this.knowledge.acceptQuickCompletionDelta(
      sql,
      scope,
      actor.occurred_at,
    );
    const gate = await this.knowledge.evaluateCompletion(sql, scope.task_id, actor.occurred_at);
    if (!gate.passed) {
      throw new Phase4RunnerEventRejectedError(
        `Quick Change completion requires durable knowledge: ${gate.blockers.join("; ")}`,
      );
    }
    completionEvidence.push(
      V2EvidenceRef.parse({
        artifact_id: deltaEvidence.artifact_id,
        content_hash: deltaEvidence.content_hash,
        media_type: "application/vnd.norns.knowledge-delta+json",
        label: "Accepted Quick Change knowledge delta",
      }),
    );

    await sql.query(
      `UPDATE tasks
          SET review_evidence=$2::jsonb, completion_evidence=$3::jsonb,
              completed_at=$4
        WHERE id=$1`,
      [
        scope.task_id,
        JSON.stringify(reviewEvidence),
        JSON.stringify(completionEvidence),
        actor.occurred_at,
      ],
    );
    await transitionV2TaskLifecycle(lifecycle, {
      ...actor,
      project_id: scope.project_id,
      phase_id: scope.phase_id,
      task_id: scope.task_id,
      expected_aggregate_version: expectedTaskVersion,
      to: "completed",
      reason:
        "Quick Change completed after exact-commit verification, publication, and durable handoff; independent review was not required",
    });
    await sql.query(
      `UPDATE agent_assignments
          SET status='completed', aggregate_version=aggregate_version+1,
              updated_at=now()
        WHERE id=$1`,
      [scope.assignment_id],
    );

    const remaining = await sql.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM tasks
        WHERE phase_id=$1 AND state NOT IN ('completed','cancelled')`,
      [scope.phase_id],
    );
    if ((remaining.rows[0]?.count ?? 0) > 0) return;

    const phaseGate = await this.knowledge.evaluatePhaseCompletion(
      sql,
      scope.project_id,
      scope.phase_id,
      actor.occurred_at,
    );
    if (!phaseGate.passed) {
      throw new Phase4RunnerEventRejectedError(
        `Quick Change phase completion requires reconciled knowledge: ${phaseGate.blockers.join("; ")}`,
      );
    }
    const closureSummary =
      "Quick Change completed with exact-commit verification, publication, durable knowledge handoff, and an accepted runner knowledge delta.";
    await sql.query(
      `UPDATE objectives
          SET status='completed', completion_evidence=$2::jsonb,
              aggregate_version=aggregate_version+1, updated_at=now()
        WHERE phase_id=$1 AND status <> 'cancelled'`,
      [scope.phase_id, JSON.stringify(completionEvidence)],
    );
    await sql.query(
      `UPDATE phases
          SET status='completed', closed_at=$2, closure_summary=$3,
              closure_evidence=$4::jsonb,
              aggregate_version=aggregate_version+1, updated_at=now()
        WHERE id=$1`,
      [scope.phase_id, actor.occurred_at, closureSummary, JSON.stringify(completionEvidence)],
    );
    await sql.query(
      `INSERT INTO project_memory_entries (
         id, project_id, phase_id, category, content, provenance, source_ref,
         confidence, version, status, approved_by_human
       ) VALUES ($1,$2,$3,'phase_completion',$4,'phase4_quick_completion',$5::jsonb,
                 1,1,'active',false)
       ON CONFLICT (id) DO NOTHING`,
      [
        `memory:phase-completion:${scope.phase_id}`,
        scope.project_id,
        scope.phase_id,
        closureSummary,
        JSON.stringify({ run_id: scope.id, task_id: scope.task_id }),
      ],
    );
  }

  /**
   * Replace provisional SDK usage with the gateway's durable per-request
   * aggregate when it exists. This is an absolute SUM assignment, never an
   * increment, so replay and the SDK's session report cannot double-count.
   */
  private async reconcileRunUsage(sql: V2SqlExecutor, runId: string): Promise<ReconciledRunUsage> {
    const aggregate = await sql.query<{
      gateway_events: number | string;
      input_tokens: number | string;
      output_tokens: number | string;
      cost_usd: number | string;
    }>(
      `SELECT count(*)::int AS gateway_events,
              COALESCE(sum(input_tokens), 0) AS input_tokens,
              COALESCE(sum(output_tokens), 0) AS output_tokens,
              COALESCE(sum(cost_usd), 0) AS cost_usd
         FROM usage_events
        WHERE run_id = $1`,
      [runId],
    );
    const row = aggregate.rows[0];
    const usage: ReconciledRunUsage = {
      gateway_events: Number(row?.gateway_events ?? 0),
      input_tokens: Number(row?.input_tokens ?? 0),
      output_tokens: Number(row?.output_tokens ?? 0),
      cost_usd: Number(row?.cost_usd ?? 0),
    };
    if (usage.gateway_events > 0) {
      await sql.query(
        `UPDATE agent_runs
            SET usage_input_tokens = $2, usage_output_tokens = $3,
                usage_cost_usd = $4, updated_at = now()
          WHERE id = $1`,
        [runId, usage.input_tokens, usage.output_tokens, usage.cost_usd],
      );
      return usage;
    }
    const provisional = await sql.query<{
      input_tokens: number | string;
      output_tokens: number | string;
      cost_usd: number | string;
    }>(
      `SELECT usage_input_tokens AS input_tokens,
              usage_output_tokens AS output_tokens,
              usage_cost_usd AS cost_usd
         FROM agent_runs WHERE id = $1`,
      [runId],
    );
    return {
      gateway_events: 0,
      input_tokens: Number(provisional.rows[0]?.input_tokens ?? 0),
      output_tokens: Number(provisional.rows[0]?.output_tokens ?? 0),
      cost_usd: Number(provisional.rows[0]?.cost_usd ?? 0),
    };
  }

  private async settleTerminalUsage(
    sql: V2SqlExecutor,
    runId: string,
    terminal: "succeeded" | "failed" | "rejected" | "expired" | "cancelled",
    actor: {
      runner_id: string;
      correlation_id: string;
      causation_id: string | null;
      occurred_at: string;
    },
  ): Promise<void> {
    const usage = await this.reconcileRunUsage(sql, runId);
    const budget = new SqlV2BudgetTransaction(sql);
    const reservation = await budget.lockReservation(`budget-reservation:${runId}`);
    if (!reservation || reservation.status !== "active") return;

    // A provider can report slightly more than the pre-flight estimate for its
    // final request. The usage row and agent-run cost retain that exact truth;
    // this reservation can settle only the money it actually held.
    const attributableUsage = Math.min(usage.cost_usd, reservation.amount_usd);
    const outcome =
      terminal === "succeeded"
        ? ("success" as const)
        : attributableUsage > 0
          ? ("partial_usage" as const)
          : terminal === "cancelled"
            ? ("cancelled" as const)
            : terminal === "expired"
              ? ("expired" as const)
              : ("rejected" as const);
    const request = {
      reservation_id: reservation.id,
      expected_version: reservation.version,
      outcome,
      attributable_usage_usd: attributableUsage,
      reason: `terminal ${terminal}; reconciled ${usage.gateway_events} gateway usage event(s)`,
      actor_type: "runner" as const,
      actor_id: actor.runner_id,
      correlation_id: actor.correlation_id,
      causation_id: actor.causation_id,
      occurred_at: actor.occurred_at,
    };
    await budget.applyResolution(
      reservation,
      request,
      resolveV2BudgetReservation(reservation.amount_usd, request),
    );
  }
}
