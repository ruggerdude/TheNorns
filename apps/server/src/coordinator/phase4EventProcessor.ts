import {
  EventEnvelope,
  type EventEnvelopeInputT,
  resolveV2BudgetReservation,
} from "@norns/contracts";
import type { V2TransactionRunner } from "../persistence/v2/database.js";
import {
  transitionV2AgentRunLifecycle,
  transitionV2TaskLifecycle,
} from "../persistence/v2/lifecycleMutation.js";
import {
  SqlV2ApplicationTransaction,
  SqlV2BudgetTransaction,
} from "../persistence/v2/sqlRepositories.js";
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
  verification_policy_ref: string;
  task_state: string;
  task_aggregate_version: number;
}

export class Phase4EventProcessor {
  constructor(private readonly transactions: V2TransactionRunner) {}

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
                    task.verification_policy_ref, task.state AS task_state,
                    task.aggregate_version AS task_aggregate_version
             FROM agent_runs run JOIN tasks task ON task.id=run.task_id
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
            const budget = new SqlV2BudgetTransaction(sql);
            const reservation = await budget.lockReservation(`budget-reservation:${scope.id}`);
            if (reservation?.status === "active") {
              const outcome: "cancelled" | "expired" | "rejected" =
                event.payload.state === "cancelled"
                  ? "cancelled"
                  : event.payload.state === "expired"
                    ? "expired"
                    : "rejected";
              const request = {
                reservation_id: reservation.id,
                expected_version: reservation.version,
                outcome,
                attributable_usage_usd: 0,
                reason: `command ${event.payload.state}`,
                actor_type: "runner" as const,
                actor_id: event.runner_id,
                correlation_id: event.correlation_id,
                causation_id: event.causation_id,
                occurred_at: event.occurred_at,
              };
              await budget.applyResolution(
                reservation,
                request,
                resolveV2BudgetReservation(reservation.amount_usd, request),
              );
            }
          }
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
                    task.verification_policy_ref, task.state AS task_state,
                    task.aggregate_version AS task_aggregate_version
             FROM agent_runs run JOIN tasks task ON task.id = run.task_id
             WHERE run.id = $1 FOR UPDATE OF run, task`
          : `SELECT run.id, run.project_id, run.phase_id, run.task_id, run.state,
                    run.aggregate_version, run.runner_id, run.repository_binding_id,
                    task.verification_policy_ref, task.state AS task_state,
                    task.aggregate_version AS task_aggregate_version
             FROM tasks task JOIN agent_runs run ON run.id = task.designated_run_id
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
      const budget = new SqlV2BudgetTransaction(sql);
      const actor = {
        actor_type: "runner" as const,
        actor_id: event.runner_id,
        correlation_id: event.correlation_id,
        causation_id: event.causation_id,
        occurred_at: event.occurred_at,
      };

      if (event.payload.kind === "run_status" && event.payload.status === "started") {
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
          if (currentTask?.state === "verifying") {
            await transitionV2TaskLifecycle(lifecycle, {
              ...actor,
              project_id: scope.project_id,
              phase_id: scope.phase_id,
              task_id: scope.task_id,
              expected_aggregate_version: currentTask.aggregate_version,
              to: "in_review",
              reason: "verified result awaiting review",
            });
          }
          await sql.query("UPDATE agent_runs SET finished_at = $2 WHERE id = $1", [
            scope.id,
            event.occurred_at,
          ]);
        } else if (["failed", "cancelled"].includes(event.payload.status)) {
          const runTarget = event.payload.status === "cancelled" ? "cancelled" : "failed";
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
              reason: `runner reported ${event.payload.status}`,
            });
          }
          if (currentTask && !["completed", "cancelled"].includes(currentTask.state)) {
            await transitionV2TaskLifecycle(lifecycle, {
              ...actor,
              project_id: scope.project_id,
              phase_id: scope.phase_id,
              task_id: scope.task_id,
              expected_aggregate_version: currentTask.aggregate_version,
              to: event.payload.status === "cancelled" ? "cancelled" : "failed",
              reason: `designated run ${event.payload.status}`,
            });
          }
          await sql.query(
            "UPDATE agent_runs SET failure_code=$2, failure_detail=$3, finished_at=$4 WHERE id=$1",
            [
              scope.id,
              `runner_${event.payload.status}`,
              `runner reported ${event.payload.status}`,
              event.occurred_at,
            ],
          );
          const reservation = await budget.lockReservation(`budget-reservation:${scope.id}`);
          if (reservation?.status === "active") {
            const outcome = event.payload.status === "cancelled" ? "cancelled" : "rejected";
            const resolution = resolveV2BudgetReservation(reservation.amount_usd, {
              outcome,
              attributable_usage_usd: 0,
              reason: `runner ${event.payload.status} before attributable usage was recorded`,
            });
            await budget.applyResolution(
              reservation,
              {
                reservation_id: reservation.id,
                expected_version: reservation.version,
                outcome,
                attributable_usage_usd: 0,
                reason: `runner ${event.payload.status}`,
                actor_type: "runner",
                actor_id: event.runner_id,
                correlation_id: event.correlation_id,
                causation_id: event.causation_id,
                occurred_at: event.occurred_at,
              },
              resolution,
            );
          }
        }
      }
      await sql.query("UPDATE runner_events SET applied_at = now() WHERE id = $1", [eventId]);
      return { duplicate: false };
    });
  }
}
