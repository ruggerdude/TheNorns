import { createHash } from "node:crypto";
import {
  EventEnvelope,
  type EventEnvelopeInputT,
  V2DispatchCommand,
  V2EvidenceRef,
  type V2EvidenceRefT,
  resolveV2BudgetReservation,
} from "@norns/contracts";
import type {
  PostgresDeviceActionAuthorization,
  RunnerAuthorizationIdentity,
} from "../devices/actionAuthorization.js";
import { canonicalJson, canonicalSha256 } from "../persistence/migration/canonicalJson.js";
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
  initiated_by_user_id: string | null;
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
    private readonly deviceAuthorization?: PostgresDeviceActionAuthorization,
  ) {}

  /**
   * Highest contiguous sequence durably committed for one runner generation.
   *
   * Device reconciliation must use this relational watermark rather than the
   * legacy RelayStores snapshot. The snapshot is flushed independently and can
   * trail the authoritative event log after a restart, which otherwise causes
   * the runner to replay a full send window that the server can never advance.
   */
  watermark(runnerId: string, generation: number): Promise<number> {
    return this.transactions.transaction(async (sql) => {
      const result = await sql.query<{ watermark: number | string }>(
        `WITH ordered AS (
           SELECT sequence,
                  row_number() OVER (ORDER BY sequence) AS expected_sequence
             FROM runner_events
            WHERE runner_id=$1 AND runner_generation=$2
         )
         SELECT COALESCE(
                  MIN(expected_sequence) FILTER (WHERE sequence <> expected_sequence) - 1,
                  MAX(sequence),
                  0
                ) AS watermark
           FROM ordered`,
        [runnerId, generation],
      );
      return Number(result.rows[0]?.watermark ?? 0);
    });
  }

  apply(
    input: EventEnvelopeInputT,
    authenticatedIdentity?: RunnerAuthorizationIdentity,
  ): Promise<{ duplicate: boolean; ignored?: boolean }> {
    const event = EventEnvelope.parse(input);
    return this.transactions.transaction(async (sql) => {
      if (this.deviceAuthorization && !authenticatedIdentity) {
        throw new Phase4RunnerEventRejectedError(
          "authenticated transport identity is required for event ingestion",
        );
      }
      const authorizationIdentity: RunnerAuthorizationIdentity = authenticatedIdentity ?? {
        subject: "legacy_runner",
        runner_id: event.runner_id,
        generation: event.generation,
      };
      if (
        authorizationIdentity.runner_id !== event.runner_id ||
        authorizationIdentity.generation !== event.generation
      ) {
        throw new Phase4RunnerEventRejectedError(
          "authenticated transport identity does not match the event",
        );
      }
      if (this.deviceAuthorization) {
        await this.deviceAuthorization
          .lockTransportIdentity(sql, authorizationIdentity)
          .catch(() => {
            throw new Phase4RunnerEventRejectedError(
              "runner identity is no longer authorized for event ingestion",
            );
          });
      }
      const directlyNamedRunId =
        "run_id" in event.payload && typeof event.payload.run_id === "string"
          ? event.payload.run_id
          : null;
      if (directlyNamedRunId && this.deviceAuthorization) {
        await this.deviceAuthorization
          .assertRun(sql, {
            ...authorizationIdentity,
            run_id: directlyNamedRunId,
          })
          .catch(() => {
            throw new Phase4RunnerEventRejectedError(
              "runner is not currently authorized for the event run",
            );
          });
      }
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
           id, runner_id, runner_generation, run_id, sequence, event_type, payload,
           correlation_id,causation_id,occurred_at
         ) VALUES ($1,$2,$3,NULL,$4,$5,$6::jsonb,$7,$8,$9)
         ON CONFLICT (runner_id, runner_generation, sequence) DO NOTHING
         RETURNING id`,
        [
          eventId,
          event.runner_id,
          event.generation,
          event.event_seq,
          event.payload.kind,
          JSON.stringify(event.payload),
          event.correlation_id,
          event.causation_id,
          event.occurred_at,
        ],
      );
      if (!inserted.rows[0]) return { duplicate: true };

      if (event.payload.kind === "heartbeat" || event.payload.kind === "run_log") {
        await sql.query("UPDATE runner_events SET applied_at = now() WHERE id = $1", [eventId]);
        return { duplicate: false };
      }
      if (event.payload.kind === "command_ack") {
        const command = await sql.query<{
          kind: string;
          runner_generation: number;
          runner_id: string;
          run_id: string;
          correlation_id: string;
        }>(
          `SELECT kind,runner_generation,runner_id,run_id,correlation_id
             FROM commands WHERE command_id=$1 FOR UPDATE`,
          [event.payload.command_id],
        );
        const row = command.rows[0];
        if (!row) {
          await sql.query("DELETE FROM runner_events WHERE id = $1", [eventId]);
          return { duplicate: false, ignored: true };
        }
        if (
          row.runner_generation !== event.generation ||
          row.runner_id !== event.runner_id ||
          event.causation_id !== event.payload.command_id ||
          event.correlation_id !== row.correlation_id
        ) {
          throw new Phase4RunnerEventRejectedError("command acknowledgement is fenced or unknown");
        }
        if (this.deviceAuthorization) {
          await this.deviceAuthorization
            .assertRun(sql, {
              ...authorizationIdentity,
              run_id: row.run_id,
            })
            .catch(() => {
              throw new Phase4RunnerEventRejectedError(
                "runner is not currently authorized for the acknowledged command",
              );
            });
        }
        await sql.query(
          "UPDATE commands SET status = $2, updated_at = now() WHERE command_id = $1",
          [event.payload.command_id, event.payload.state],
        );
        const terminalCommandState =
          event.payload.state === "succeeded" ||
          event.payload.state === "waiting_for_human" ||
          event.payload.state === "failed" ||
          event.payload.state === "rejected" ||
          event.payload.state === "expired" ||
          event.payload.state === "cancelled"
            ? event.payload.state
            : null;
        if (
          ["waiting_for_human", "succeeded", "failed", "rejected", "expired", "cancelled"].includes(
            event.payload.state,
          )
        ) {
          await sql.query(
            `UPDATE dispatch_jobs SET status = 'completed', completed_at = now(), updated_at = now()
             WHERE command_id = $1 AND status IN ('delivered','completed')`,
            [event.payload.command_id],
          );
          await sql.query(
            `UPDATE github_actions_runs actions
                SET status=CASE
                      WHEN $2 IN ('waiting_for_human','succeeded') THEN 'completed'
                      ELSE 'failed'
                    END,
                    conclusion=$2,completed_at=COALESCE(actions.completed_at,$3),
                    launch_lease_owner=NULL,launch_lease_expires_at=NULL,
                    reconcile_lease_owner=NULL,reconcile_lease_expires_at=NULL,
                    last_error=CASE
                      WHEN $2 IN ('waiting_for_human','succeeded') THEN NULL
                      ELSE NULLIF($4,'')
                    END,
                    updated_at=now()
               FROM dispatch_jobs job
              WHERE job.command_id=$1
                AND actions.dispatch_job_id=job.id
                AND actions.runner_id=$5
                AND actions.runner_generation=$6
                AND actions.status='enrolled'`,
            [
              event.payload.command_id,
              event.payload.state,
              event.occurred_at,
              event.payload.detail,
              event.runner_id,
              event.generation,
            ],
          );
        }
        if (row.kind === "collect_visual_evidence") {
          if (terminalCommandState) {
            const successfulUpload = event.payload.state === "succeeded";
            await sql.query(
              `UPDATE implementation_visual_evidence_collections
                  SET status=CASE
                        WHEN $2 AND evidence_id IS NOT NULL THEN 'completed'
                        ELSE 'failed'
                      END,
                      last_error=CASE
                        WHEN $2 AND evidence_id IS NOT NULL THEN NULL
                        WHEN $2 THEN 'visual_evidence_upload_missing'
                        ELSE COALESCE(NULLIF($3,''),'visual_evidence_collection_failed')
                      END,
                      completed_at=COALESCE(completed_at,now()),updated_at=now()
                WHERE command_id=$1
                  AND status IN ('awaiting_runner','delivered','completed')`,
              [event.payload.command_id, successfulUpload, event.payload.detail],
            );
          }
          await sql.query(
            "UPDATE runner_events SET run_id = $2, applied_at = now() WHERE id = $1",
            [eventId, row.run_id],
          );
          return { duplicate: false };
        }
        const pauseApplied =
          terminalCommandState && terminalCommandState !== "waiting_for_human"
            ? await this.applyQueuedPauseAtTerminal(
                sql,
                row.run_id,
                eventId,
                event.payload.command_id,
                event.occurred_at,
              )
            : false;
        const deferredTerminalApplied =
          terminalCommandState && terminalCommandState !== "waiting_for_human" && !pauseApplied
            ? await this.applyDeferredTerminalStatus(
                sql,
                row.run_id,
                eventId,
                event.payload.command_id,
              )
            : false;
        if (
          !pauseApplied &&
          !deferredTerminalApplied &&
          ["failed", "rejected", "expired", "cancelled"].includes(event.payload.state)
        ) {
          const failedScope = await sql.query<RunScope>(
            `SELECT run.id, run.project_id, run.phase_id, run.task_id,
                    run.initiated_by_user_id, run.state,
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
        if (terminalCommandState && terminalCommandState !== "waiting_for_human" && !pauseApplied) {
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
          ? `SELECT run.id, run.project_id, run.phase_id, run.task_id,
                    run.initiated_by_user_id, run.state,
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
          : `SELECT run.id, run.project_id, run.phase_id, run.task_id,
                    run.initiated_by_user_id, run.state,
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
      if (!directlyNamedRunId && this.deviceAuthorization) {
        await this.deviceAuthorization
          .assertRun(sql, {
            ...authorizationIdentity,
            run_id: scope.id,
            project_id: scope.project_id,
          })
          .catch(() => {
            throw new Phase4RunnerEventRejectedError(
              "runner is not currently authorized for the resolved event run",
            );
          });
      }
      const commandGeneration = await sql.query<{ runner_generation: number }>(
        `SELECT runner_generation FROM commands
          WHERE run_id = $1 AND ($2::text IS NULL OR command_id=$2)
          ORDER BY created_at DESC, command_id DESC LIMIT 1`,
        [scope.id, event.causation_id],
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
        if (event.causation_id) {
          await this.applyCheckpointDirections(
            sql,
            scope,
            eventId,
            event.causation_id,
            event.occurred_at,
          );
          await this.applyPauseResumeContext(
            sql,
            scope,
            eventId,
            event.causation_id,
            event.occurred_at,
          );
        }
      } else if (event.payload.kind === "usage_report") {
        await this.recordCommandUsageReport(
          sql,
          scope,
          eventId,
          event.causation_id,
          event.payload.input_tokens,
          event.payload.output_tokens,
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
        await this.finalizeCommandUsage(sql, scope, eventId, event.causation_id, event.occurred_at);
        await this.recordRuntimeUsageFallback(
          sql,
          scope,
          eventId,
          event.causation_id,
          event.payload,
          event.occurred_at,
        );
      } else if (event.payload.kind === "human_wait_requested") {
        await this.openHumanWait(sql, scope, eventId, event.payload, actor);
      } else if (event.payload.kind === "continuation_context_applied") {
        await this.applyContinuationContext(sql, scope, eventId, event.payload, actor);
        if (event.causation_id) {
          await this.applyCheckpointDirections(
            sql,
            scope,
            eventId,
            event.causation_id,
            event.occurred_at,
          );
        }
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
        // EXEC-INTEGRATE-1 — when the runner advanced the base branch to this
        // commit, move the binding's observed_head with it. That head is the
        // base every subsequent dispatch branches from (phase4Coordinator), so
        // this is what lets the next phase build on the completed phase's work
        // instead of a stale base. A `conflict` outcome carries the base's
        // actual (unmoved) tip and must NOT advance anything.
        if (
          (event.payload.integration_outcome === "integrated" ||
            event.payload.integration_outcome === "already_integrated") &&
          event.payload.integrated_base_commit
        ) {
          await sql.query(
            `UPDATE repository_bindings
                SET observed_head = $2, updated_at = now()
               FROM projects
              WHERE projects.id = $1
                AND repository_bindings.id = projects.primary_repository_binding_id
                AND repository_bindings.project_id = projects.id`,
            [scope.project_id, event.payload.integrated_base_commit],
          );
        }
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
        const pausePending =
          ["completed", "failed", "cancelled"].includes(event.payload.status) &&
          (await this.hasQueuedPause(sql, scope.id));
        if (pausePending) {
          // A runner publishes before its final command acknowledgement. Keep
          // the run and reservation open so that acknowledgement can atomically
          // bind the exact publication to the confirmed pause. The event itself
          // remains durable and applied for restart/replay.
        } else if (event.payload.status === "completed") {
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

  private async hasQueuedPause(sql: V2SqlExecutor, runId: string): Promise<boolean> {
    const row = (
      await sql.query<{ pending: boolean }>(
        `SELECT EXISTS (
           SELECT 1
             FROM conversation_actions action
             JOIN conversation_action_delivery_intents intent ON intent.action_id=action.id
            WHERE action.action_type='pause_work'
              AND action.status IN ('recorded','sent','agent_acknowledged')
              AND intent.status='fallback_queued'
              AND intent.target_run_id=$1
         ) AS pending`,
        [runId],
      )
    ).rows[0];
    return row?.pending === true;
  }

  private async applyDeferredTerminalStatus(
    sql: V2SqlExecutor,
    runId: string,
    commandAckEventId: string,
    commandId: string,
  ): Promise<boolean> {
    const row = (
      await sql.query<
        RunScope & {
          terminal_payload: unknown;
          terminal_occurred_at: Date | string;
          terminal_runner_id: string;
          terminal_correlation_id: string;
          terminal_causation_id: string | null;
        }
      >(
        `SELECT run.id,run.project_id,run.phase_id,run.task_id,
                run.initiated_by_user_id,run.state,run.aggregate_version,
                run.runner_id,run.repository_binding_id,run.expected_revision,
                run.assignment_id,assignment.reviewer_agent_profile_id,
                COALESCE(planning.mode,'planned') AS execution_mode,
                task.verification_policy_ref,task.state AS task_state,
                task.aggregate_version AS task_aggregate_version,
                terminal.payload AS terminal_payload,
                terminal.occurred_at AS terminal_occurred_at,
                terminal.runner_id AS terminal_runner_id,
                terminal.correlation_id AS terminal_correlation_id,
                terminal.causation_id AS terminal_causation_id
           FROM agent_runs run
           JOIN tasks task ON task.id=run.task_id
           JOIN agent_assignments assignment ON assignment.id=run.assignment_id
           JOIN phases phase ON phase.id=run.phase_id
           LEFT JOIN planning_runs planning ON planning.id=phase.planning_run_id
           JOIN runner_events ack ON ack.id=$2
           JOIN LATERAL (
             SELECT event.payload,event.occurred_at,event.runner_id,
                    event.correlation_id,event.causation_id
               FROM runner_events event
              WHERE event.run_id=run.id AND event.event_type='run_status'
                AND event.runner_id=ack.runner_id
                AND event.runner_generation=ack.runner_generation
                AND event.sequence<ack.sequence
                AND event.causation_id=$3
                AND event.payload->>'status' IN ('completed','failed','cancelled')
              ORDER BY event.sequence DESC LIMIT 1
           ) terminal ON true
          WHERE run.id=$1
          FOR UPDATE OF run,task`,
        [runId, commandAckEventId, commandId],
      )
    ).rows[0];
    if (!row) return false;
    const payload =
      typeof row.terminal_payload === "string"
        ? (JSON.parse(row.terminal_payload) as {
            status: "completed" | "failed" | "cancelled";
            failure?: { stage: string; code: string; detail: string };
          })
        : (row.terminal_payload as {
            status: "completed" | "failed" | "cancelled";
            failure?: { stage: string; code: string; detail: string };
          });
    if (
      !["running", "verifying", "dispatched"].includes(row.state) ||
      ["completed", "cancelled"].includes(row.task_state)
    ) {
      return false;
    }
    const occurredAt = new Date(row.terminal_occurred_at).toISOString();
    const actor = {
      actor_type: "runner" as const,
      actor_id: row.terminal_runner_id,
      correlation_id: row.terminal_correlation_id,
      causation_id: row.terminal_causation_id,
      occurred_at: occurredAt,
    };
    const lifecycle = new SqlV2ApplicationTransaction(sql);
    const currentRun = await lifecycle.lockAgentRunLifecycle(runId);
    const currentTask = await lifecycle.lockTaskLifecycle(row.task_id);
    if (!currentRun || !currentTask) return false;
    if (payload.status === "completed") {
      const verification = await sql.query<{ verification_status: string }>(
        "SELECT verification_status FROM agent_runs WHERE id=$1",
        [runId],
      );
      if (
        verification.rows[0]?.verification_status !== "passed" ||
        currentRun.state !== "verifying"
      ) {
        return false;
      }
      await transitionV2AgentRunLifecycle(lifecycle, {
        ...actor,
        project_id: row.project_id,
        phase_id: row.phase_id,
        task_id: row.task_id,
        run_id: runId,
        expected_aggregate_version: currentRun.aggregate_version,
        to: "succeeded",
        reason: "runner completed with green verification",
      });
      await dismissRecoveryDecisionsForSuccessfulRun(sql, {
        project_id: row.project_id,
        phase_id: row.phase_id,
        task_id: row.task_id,
        run_id: runId,
        actor: { actor_type: "runner", actor_id: row.terminal_runner_id },
        occurred_at: occurredAt,
      });
      let reviewReadyTask = currentTask;
      if (reviewReadyTask.state === "verifying") {
        reviewReadyTask = await transitionV2TaskLifecycle(lifecycle, {
          ...actor,
          project_id: row.project_id,
          phase_id: row.phase_id,
          task_id: row.task_id,
          expected_aggregate_version: reviewReadyTask.aggregate_version,
          to: "in_review",
          reason:
            row.execution_mode === "quick" && row.reviewer_agent_profile_id === null
              ? "Quick Change verification passed; independent review is not required"
              : "verified result awaiting review",
        });
      }
      if (
        row.execution_mode === "quick" &&
        row.reviewer_agent_profile_id === null &&
        reviewReadyTask.state === "in_review"
      ) {
        await this.completeQuickChange(
          sql,
          lifecycle,
          row,
          reviewReadyTask.aggregate_version,
          actor,
        );
      }
      await sql.query("UPDATE agent_runs SET finished_at=$2 WHERE id=$1", [runId, occurredAt]);
      return true;
    }
    const failure =
      payload.status === "failed"
        ? (payload.failure ?? {
            stage: "unknown",
            code: "runner_failed",
            detail: "runner reported failed",
          })
        : {
            stage: "cancellation",
            code: "runner_cancelled",
            detail: "runner reported cancelled",
          };
    const reason =
      payload.status === "failed"
        ? `${failure.code} during ${failure.stage}: ${failure.detail}`
        : failure.detail;
    await transitionV2AgentRunLifecycle(lifecycle, {
      ...actor,
      project_id: row.project_id,
      phase_id: row.phase_id,
      task_id: row.task_id,
      run_id: runId,
      expected_aggregate_version: currentRun.aggregate_version,
      to: payload.status === "cancelled" ? "cancelled" : "failed",
      reason,
    });
    if (payload.status === "cancelled") {
      await transitionV2TaskLifecycle(lifecycle, {
        ...actor,
        project_id: row.project_id,
        phase_id: row.phase_id,
        task_id: row.task_id,
        expected_aggregate_version: currentTask.aggregate_version,
        to: "cancelled",
        reason,
      });
    } else if (currentTask.state !== "failed") {
      const failureReadyTask = ["pending", "ready", "assigned"].includes(currentTask.state)
        ? await transitionV2TaskLifecycle(lifecycle, {
            ...actor,
            project_id: row.project_id,
            phase_id: row.phase_id,
            task_id: row.task_id,
            expected_aggregate_version: currentTask.aggregate_version,
            to: "blocked",
            reason,
          })
        : currentTask;
      await transitionV2TaskLifecycle(lifecycle, {
        ...actor,
        project_id: row.project_id,
        phase_id: row.phase_id,
        task_id: row.task_id,
        expected_aggregate_version: failureReadyTask.aggregate_version,
        to: "failed",
        reason,
      });
    }
    await sql.query(
      "UPDATE agent_runs SET failure_code=$2,failure_detail=$3,finished_at=$4 WHERE id=$1",
      [runId, failure.code, `${failure.stage}: ${failure.detail}`, occurredAt],
    );
    return true;
  }

  private async applyContinuationContext(
    sql: V2SqlExecutor,
    scope: RunScope,
    eventId: string,
    receipt: Extract<EventEnvelopeInputT["payload"], { kind: "continuation_context_applied" }>,
    actor: {
      actor_type: "runner";
      actor_id: string;
      correlation_id: string;
      causation_id: string | null;
      occurred_at: string;
    },
  ): Promise<void> {
    if (scope.state !== "running" || scope.task_state !== "in_progress") {
      throw new Phase4RunnerEventRejectedError(
        "continuation context can be applied only after the resumed run starts",
      );
    }
    if (!actor.causation_id) {
      throw new Phase4RunnerEventRejectedError(
        "continuation context receipt requires exact command causation",
      );
    }
    const row = (
      await sql.query<{
        continuation_id: string;
        continuation_status: string;
        wait_id: string;
        wait_status: string;
        action_id: string;
        project_id: string;
        work_item_id: string;
        conversation_id: string;
        resume_command_id: string;
        context_hash: string;
        replay_context_ref: unknown;
        envelope: unknown;
      }>(
        `SELECT continuation.id AS continuation_id,
                continuation.status AS continuation_status,
                continuation.wait_id,wait.status AS wait_status,
                answer.action_id,wait.project_id,wait.work_item_id,
                wait.conversation_id,continuation.resume_command_id,
                continuation.context_hash,continuation.replay_context_ref,
                command.envelope
           FROM human_wait_continuations continuation
           JOIN human_waits wait ON wait.id=continuation.wait_id
           JOIN human_wait_answers answer ON answer.id=continuation.answer_id
           JOIN commands command ON command.command_id=continuation.resume_command_id
          WHERE continuation.root_run_id=$1
            AND continuation.resume_command_id=$2
          FOR UPDATE OF continuation,wait`,
        [scope.id, actor.causation_id],
      )
    ).rows[0];
    if (!row) {
      throw new Phase4RunnerEventRejectedError(
        "continuation context receipt is not bound to this run and command",
      );
    }
    const command = V2DispatchCommand.parse(
      typeof row.envelope === "string" ? JSON.parse(row.envelope) : row.envelope,
    );
    const continuation = command.continuation;
    if (!continuation) {
      throw new Phase4RunnerEventRejectedError(
        "continuation context receipt references a non-continuation command",
      );
    }
    const replay = continuation.replay_context_ref;
    if (
      command.command_id !== row.resume_command_id ||
      command.run_id !== scope.id ||
      command.runner_id !== actor.actor_id ||
      receipt.wait_id !== row.wait_id ||
      receipt.root_command_id !== continuation.root_command_id ||
      receipt.context_hash !== row.context_hash ||
      receipt.context_hash !== continuation.context_hash ||
      receipt.replay_context_hash !== replay.content_hash ||
      canonicalJson(replay) !== canonicalJson(row.replay_context_ref)
    ) {
      throw new Phase4RunnerEventRejectedError(
        "continuation context receipt does not match the immutable replay command",
      );
    }
    if (row.continuation_status === "applied" && row.wait_status === "resumed") {
      return;
    }
    if (row.continuation_status !== "dispatched" || row.wait_status !== "continuation_queued") {
      throw new Phase4RunnerEventRejectedError(
        "continuation context receipt arrived from an invalid lifecycle state",
      );
    }
    const contextReceiptHash = canonicalSha256({
      wait_id: receipt.wait_id,
      root_command_id: receipt.root_command_id,
      context_hash: receipt.context_hash,
      replay_context_hash: receipt.replay_context_hash,
      target_command_id: command.command_id,
      runner_id: actor.actor_id,
    });
    const acknowledgedAction = await sql.query<{ id: string }>(
      `UPDATE conversation_actions
          SET status='agent_acknowledged',acknowledged_at=now(),updated_at=now()
        WHERE id=$1 AND status='sent'
        RETURNING id`,
      [row.action_id],
    );
    if (!acknowledgedAction.rows[0]) {
      throw new Phase4RunnerEventRejectedError("continuation action was not in the sent state");
    }
    await sql.query(
      `INSERT INTO conversation_action_delivery_events (
         id,project_id,work_item_id,conversation_id,action_id,sequence,status,
         delivery_mode,target_run_id,target_command_id,receipt
       ) VALUES ($1,$2,$3,$4,$5,4,'agent_acknowledged','continuation',$6,$7,$8::jsonb)`,
      [
        `action-delivery-event:${row.action_id}:4`,
        row.project_id,
        row.work_item_id,
        row.conversation_id,
        row.action_id,
        scope.id,
        command.command_id,
        JSON.stringify({ kind: "agent_ack", ack_event_id: eventId }),
      ],
    );
    const appliedAction = await sql.query<{ id: string }>(
      `UPDATE conversation_actions
          SET status='applied',applied_at=now(),updated_at=now()
        WHERE id=$1 AND status='agent_acknowledged'
        RETURNING id`,
      [row.action_id],
    );
    if (!appliedAction.rows[0]) {
      throw new Phase4RunnerEventRejectedError(
        "continuation action acknowledgement could not be applied",
      );
    }
    await sql.query(
      `INSERT INTO conversation_action_delivery_events (
         id,project_id,work_item_id,conversation_id,action_id,sequence,status,
         delivery_mode,target_run_id,target_command_id,receipt
       ) VALUES ($1,$2,$3,$4,$5,5,'applied','continuation',$6,$7,$8::jsonb)`,
      [
        `action-delivery-event:${row.action_id}:5`,
        row.project_id,
        row.work_item_id,
        row.conversation_id,
        row.action_id,
        scope.id,
        command.command_id,
        JSON.stringify({ kind: "applied", context_receipt_hash: contextReceiptHash }),
      ],
    );
    await sql.query(
      `UPDATE human_wait_continuations
          SET status='applied',updated_at=now()
        WHERE id=$1 AND status='dispatched'`,
      [row.continuation_id],
    );
    const resumed = await sql.query<{ id: string }>(
      `UPDATE human_waits
          SET status='resumed',resumed_at=now(),version=version+1,updated_at=now()
        WHERE id=$1 AND status='continuation_queued'
        RETURNING id`,
      [row.wait_id],
    );
    if (!resumed.rows[0]) {
      throw new Phase4RunnerEventRejectedError(
        "continuation wait could not be marked resumed exactly once",
      );
    }
    const conversation = (
      await sql.query<{ next_message_sequence: string | number }>(
        `SELECT next_message_sequence FROM work_conversations
          WHERE id=$1 FOR UPDATE`,
        [row.conversation_id],
      )
    ).rows[0];
    if (!conversation) {
      throw new Phase4RunnerEventRejectedError(
        "continuation conversation disappeared before receipt",
      );
    }
    await sql.query(
      `INSERT INTO work_messages (
         id,project_id,work_item_id,conversation_id,initiated_by_user_id,
         actor_type,actor_id,role,visibility_status,sequence,parts
       )
       SELECT $1,$2,$3,$4,created_by_user_id,
              'coordinator',NULL,'assistant','complete',$5,$6::jsonb
         FROM work_conversations WHERE id=$4`,
      [
        `message:resumed:${row.wait_id}`,
        row.project_id,
        row.work_item_id,
        row.conversation_id,
        Number(conversation.next_message_sequence),
        JSON.stringify([
          {
            type: "text",
            format: "markdown",
            text: "Execution resumed from the published checkpoint with the recorded decision.",
          },
          {
            type: "human_wait_update",
            human_wait_id: row.wait_id,
            status: "resumed",
          },
        ]),
      ],
    );
    await sql.query(
      `UPDATE work_conversations
          SET next_message_sequence=next_message_sequence+1,updated_at=now()
        WHERE id=$1`,
      [row.conversation_id],
    );
  }

  /**
   * Open one durable, user-visible wait from a typed runner request.
   *
   * Every authoritative field that the runner must not choose is re-derived
   * from locked server state: source command/context, approved task package,
   * remotely pushed publication, reservation, expiry, and session policy.
   */
  private async openHumanWait(
    sql: V2SqlExecutor,
    scope: RunScope,
    eventId: string,
    request: Extract<EventEnvelopeInputT["payload"], { kind: "human_wait_requested" }>,
    actor: {
      actor_type: "runner";
      actor_id: string;
      correlation_id: string;
      causation_id: string | null;
      occurred_at: string;
    },
  ): Promise<void> {
    if (
      createHash("sha256").update(request.question).digest("hex") !== request.question_hash ||
      createHash("sha256").update(request.compact_summary).digest("hex") !==
        request.compact_summary_hash
    ) {
      throw new Phase4RunnerEventRejectedError(
        "human-wait question or visible-summary hash does not match its exact content",
      );
    }
    if (scope.state !== "running" || scope.task_state !== "in_progress") {
      throw new Phase4RunnerEventRejectedError(
        "human wait can open only from an actively running task",
      );
    }
    const evidence = await sql.query<{
      published_branch: string | null;
      published_commit_sha: string | null;
      published_remote: string | null;
      publication_outcome: string | null;
      runtime_session_id: string | null;
      command_id: string;
      command_runner_id: string;
      command_runner_generation: number;
      envelope: unknown;
      publication_event_id: string;
      runtime_event_id: string;
      budget_reservation_id: string;
      reservation_project_id: string;
      reservation_phase_id: string;
      reservation_task_id: string;
      reservation_run_id: string;
      reservation_status: string;
      work_item_id: string;
      conversation_id: string;
      initiated_by_user_id: string;
      next_message_sequence: number | string;
      task_package_hash: string | null;
    }>(
      `SELECT run.published_branch, run.published_commit_sha, run.published_remote,
              run.publication_outcome, run.runtime_session_id,
              command.command_id, command.runner_id AS command_runner_id,
              command.runner_generation AS command_runner_generation, command.envelope,
              publication_event.id AS publication_event_id,
              runtime_event.id AS runtime_event_id,
              reservation.id AS budget_reservation_id,
              reservation.project_id AS reservation_project_id,
              reservation.phase_id AS reservation_phase_id,
              reservation.task_id AS reservation_task_id,
              reservation.run_id AS reservation_run_id,
              reservation.status AS reservation_status,
              item.id AS work_item_id, conversation.id AS conversation_id,
              item.created_by_user_id AS initiated_by_user_id,
              conversation.next_message_sequence,
              package_run.content_hash AS task_package_hash
         FROM agent_runs run
         JOIN LATERAL (
           SELECT command_id, runner_id, runner_generation, envelope
             FROM commands
            WHERE run_id=run.id AND command_id=$2
            ORDER BY created_at DESC, command_id DESC
            LIMIT 1
         ) command ON true
         JOIN runner_events current_event ON current_event.id=$3
           AND current_event.causation_id=command.command_id
         JOIN LATERAL (
           SELECT published.id
             FROM runner_events published
            WHERE published.run_id=run.id
              AND published.runner_id=current_event.runner_id
              AND published.runner_generation=current_event.runner_generation
              AND published.sequence < current_event.sequence
              AND published.event_type='run_published'
              AND published.causation_id=command.command_id
              AND published.payload->>'outcome'='pushed'
              AND published.payload->>'branch'=command.envelope->>'target_branch'
              AND published.payload->>'branch'=run.published_branch
              AND published.payload->>'commit_sha'=run.published_commit_sha
              AND published.payload->>'remote'=run.published_remote
            ORDER BY published.sequence DESC
            LIMIT 1
         ) publication_event ON true
         JOIN LATERAL (
           SELECT runtime.id
             FROM runner_events runtime
            WHERE runtime.run_id=run.id
              AND runtime.runner_id=current_event.runner_id
              AND runtime.runner_generation=current_event.runner_generation
              AND runtime.sequence < current_event.sequence
              AND runtime.event_type='runtime_result'
              AND runtime.causation_id=command.command_id
              AND runtime.payload->>'outcome'='waiting_for_human'
              AND runtime.payload->>'runtime'=$4
              AND coalesce(runtime.payload->>'session_id','')
                    =coalesce($5::text,'')
            ORDER BY runtime.sequence DESC
            LIMIT 1
         ) runtime_event ON true
         JOIN budget_reservations reservation
           ON reservation.run_id=run.id
         JOIN work_items item
           ON item.project_id=run.project_id AND item.phase_id=run.phase_id
         JOIN work_conversations conversation
           ON conversation.project_id=item.project_id
          AND conversation.work_item_id=item.id
          AND conversation.kind='execution_pm'
          AND conversation.status='active'
         LEFT JOIN conversation_task_package_runs package_run
           ON package_run.run_id=run.id
        WHERE run.id=$1
        ORDER BY conversation.created_at DESC
        LIMIT 1
        FOR UPDATE OF run, reservation, conversation`,
      [scope.id, actor.causation_id, eventId, request.runtime, request.session_id],
    );
    const row = evidence.rows[0];
    if (!row) {
      throw new Phase4RunnerEventRejectedError(
        "human wait requires an active execution PM conversation and budget reservation",
      );
    }
    if (
      row.publication_outcome !== "pushed" ||
      !row.published_branch ||
      !row.published_commit_sha ||
      !row.published_remote
    ) {
      throw new Phase4RunnerEventRejectedError(
        "human wait requires an exact remotely pushed checkpoint applied first",
      );
    }
    if (
      row.reservation_status !== "active" ||
      row.reservation_project_id !== scope.project_id ||
      row.reservation_phase_id !== scope.phase_id ||
      row.reservation_task_id !== scope.task_id ||
      row.reservation_run_id !== scope.id
    ) {
      throw new Phase4RunnerEventRejectedError(
        "human wait budget reservation does not match the source run scope",
      );
    }
    const command = V2DispatchCommand.parse(
      typeof row.envelope === "string" ? JSON.parse(row.envelope) : row.envelope,
    );
    if (
      command.command_id !== row.command_id ||
      command.run_id !== scope.id ||
      command.project_id !== scope.project_id ||
      command.phase_id !== scope.phase_id ||
      command.task_id !== scope.task_id ||
      command.budget_reservation_id !== row.budget_reservation_id
    ) {
      throw new Phase4RunnerEventRejectedError(
        "human wait source command is not bound to the locked run and reservation",
      );
    }
    if (
      row.command_runner_id !== actor.actor_id ||
      !row.publication_event_id ||
      !row.runtime_event_id ||
      command.runner_generation !== row.command_runner_generation
    ) {
      throw new Phase4RunnerEventRejectedError(
        "human wait source command/publication is fenced from the requesting runner",
      );
    }
    if (request.runtime !== command.runtime) {
      throw new Phase4RunnerEventRejectedError(
        "human wait runtime does not match the source command",
      );
    }
    if ((command.task_package_content_hash ?? null) !== row.task_package_hash) {
      throw new Phase4RunnerEventRejectedError(
        "human wait task package binding drifted from the source command",
      );
    }
    if (
      !command.human_wait_channel ||
      command.human_wait_channel.version !== request.ask_channel_version ||
      command.human_wait_channel.instruction_hash !== request.ask_instruction_hash
    ) {
      throw new Phase4RunnerEventRejectedError(
        "human wait ask-channel receipt does not match the source command",
      );
    }

    const waitId = `human-wait:${eventId}`;
    const messageId = `message:${waitId}`;
    const decisionPointId = `decision-point:${waitId}`;
    const rootContextRefs = command.context_refs;
    const contextHash = canonicalSha256({
      root_command_id: command.command_id,
      ask_channel_version: request.ask_channel_version,
      ask_instruction_hash: request.ask_instruction_hash,
      root_context_refs: rootContextRefs,
      task_package_hash: row.task_package_hash,
    });
    const canonicalContextManifest = canonicalJson({
      root_command_id: command.command_id,
      root_context_refs: rootContextRefs,
      task_package_hash: row.task_package_hash,
    });
    await sql.query(
      `INSERT INTO decision_points (
         id, project_id, phase_id, task_id, scope_entity_type, scope_entity_id,
         reason_class, source_instance_id, condition_key, condition_fingerprint,
         question, context, options, recommendation_option_id, urgency,
         blocking_scope, status
       ) VALUES (
         $1,$2,$3,$4,'task',$4,'human_input_required',$5,$6,$7,$8,$9,
         $10::jsonb,'provide_answer','normal',$11::jsonb,'open'
       )`,
      [
        decisionPointId,
        scope.project_id,
        scope.phase_id,
        scope.task_id,
        scope.id,
        `human-wait:${scope.id}`,
        request.question_hash,
        request.question,
        request.compact_summary,
        JSON.stringify([{ id: "provide_answer", label: "Provide direction" }]),
        JSON.stringify({ task_id: scope.task_id, run_id: scope.id }),
      ],
    );
    await sql.query(
      `INSERT INTO work_messages (
         id, project_id, work_item_id, conversation_id, initiated_by_user_id,
         actor_type, actor_id, role, visibility_status, sequence, parts
       ) VALUES ($1,$2,$3,$4,$5,'coordinator',NULL,'assistant','complete',$6,$7::jsonb)`,
      [
        messageId,
        scope.project_id,
        row.work_item_id,
        row.conversation_id,
        row.initiated_by_user_id,
        Number(row.next_message_sequence),
        JSON.stringify([
          { type: "text", format: "markdown", text: request.question },
          { type: "human_wait", human_wait_id: waitId },
        ]),
      ],
    );
    await sql.query(
      `UPDATE work_conversations
          SET next_message_sequence=next_message_sequence+1, updated_at=now()
        WHERE id=$1`,
      [row.conversation_id],
    );
    const insertedWait = await sql.query<{ expires_at: Date | string }>(
      `INSERT INTO human_waits (
         id, project_id, work_item_id, conversation_id, phase_id, task_id,
         source_run_id, source_event_id, source_command_id, message_id,
         decision_point_id, decision_point, question, question_hash,
         published_branch, published_commit_sha, published_remote,
         runtime_id, runtime_session_id, session_portability,
         session_portability_evidence, ask_channel_version, ask_instruction_hash,
         context_manifest, canonical_context_manifest, root_context_refs,
         context_hash, task_package_hash, compact_summary, compact_summary_hash,
         budget_reservation_id, root_run_id, expires_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
         $18,$19,'transcript_only',NULL,$20,$21,$22::jsonb,$23,$24::jsonb,$25,$26,$27,$28,$29,$7,
         now() + interval '7 days'
       )
       RETURNING expires_at`,
      [
        waitId,
        scope.project_id,
        row.work_item_id,
        row.conversation_id,
        scope.phase_id,
        scope.task_id,
        scope.id,
        eventId,
        command.command_id,
        messageId,
        decisionPointId,
        request.decision_point,
        request.question,
        request.question_hash,
        row.published_branch,
        row.published_commit_sha,
        row.published_remote,
        request.runtime,
        request.session_id ?? row.runtime_session_id,
        request.ask_channel_version,
        request.ask_instruction_hash,
        JSON.stringify({
          root_command_id: command.command_id,
          ask_channel_version: request.ask_channel_version,
          ask_instruction_hash: request.ask_instruction_hash,
          root_context_refs: rootContextRefs,
          context_hash: contextHash,
        }),
        canonicalContextManifest,
        JSON.stringify(rootContextRefs),
        contextHash,
        row.task_package_hash,
        request.compact_summary,
        request.compact_summary_hash,
        row.budget_reservation_id,
      ],
    );
    const expiresAt = insertedWait.rows[0]?.expires_at;
    if (!expiresAt) {
      throw new Phase4RunnerEventRejectedError("human wait expiry was not persisted");
    }
    const extendedReservation = await sql.query<{ id: string }>(
      `UPDATE budget_reservations
          SET expires_at=GREATEST(expires_at,$2::timestamptz),
              version=version+1, updated_at=now()
        WHERE id=$1 AND status='active' RETURNING id`,
      [row.budget_reservation_id, expiresAt],
    );
    if (!extendedReservation.rows[0]) {
      throw new Phase4RunnerEventRejectedError(
        "human wait reservation expired while the wait was opening",
      );
    }

    const lifecycle = new SqlV2ApplicationTransaction(sql);
    const currentRun = await lifecycle.lockAgentRunLifecycle(scope.id);
    if (currentRun?.state === "running") {
      await transitionV2AgentRunLifecycle(lifecycle, {
        ...actor,
        project_id: scope.project_id,
        phase_id: scope.phase_id,
        task_id: scope.task_id,
        run_id: scope.id,
        expected_aggregate_version: currentRun.aggregate_version,
        to: "waiting_for_human",
        reason: `waiting for human decision ${waitId}`,
      });
    }
    const currentTask = await lifecycle.lockTaskLifecycle(scope.task_id);
    if (currentTask && currentTask.state !== "blocked") {
      await transitionV2TaskLifecycle(lifecycle, {
        ...actor,
        project_id: scope.project_id,
        phase_id: scope.phase_id,
        task_id: scope.task_id,
        expected_aggregate_version: currentTask.aggregate_version,
        to: "blocked",
        reason: `waiting for human decision ${waitId}`,
      });
    }
  }

  private async applyQueuedPauseAtTerminal(
    sql: V2SqlExecutor,
    runId: string,
    eventId: string,
    commandId: string,
    occurredAt: string,
  ): Promise<boolean> {
    const pauses = (
      await sql.query<{
        action_id: string;
        project_id: string;
        work_item_id: string;
        conversation_id: string;
        action_status: string;
        intent_id: string;
        task_scoped: boolean;
      }>(
        `SELECT action.id AS action_id,action.project_id,action.work_item_id,
                action.conversation_id,action.status AS action_status,
                intent.id AS intent_id,
                (action.payload->'parameters'->>'task_id' IS NOT NULL) AS task_scoped
           FROM conversation_actions action
           JOIN conversation_action_delivery_intents intent ON intent.action_id=action.id
          WHERE action.action_type='pause_work'
            AND action.status IN ('recorded','sent','agent_acknowledged')
            AND intent.status='fallback_queued' AND intent.target_run_id=$1
          ORDER BY action.confirmed_at,action.id
          FOR UPDATE OF action,intent`,
        [runId],
      )
    ).rows;
    const firstPause = pauses[0];
    if (!firstPause) return false;
    const checkpoint = (
      await sql.query<{
        project_id: string;
        phase_id: string;
        task_id: string;
        run_state: string;
        run_aggregate_version: number;
        task_state: string;
        task_aggregate_version: number;
        published_branch: string;
        published_commit_sha: string;
        published_remote: string;
        budget_reservation_id: string;
        context_refs: unknown;
      }>(
        `SELECT run.project_id,run.phase_id,run.task_id,run.state AS run_state,
                run.aggregate_version AS run_aggregate_version,
                task.state AS task_state,task.aggregate_version AS task_aggregate_version,
                run.published_branch,run.published_commit_sha,run.published_remote,
                reservation.id AS budget_reservation_id,
                command.envelope->'context_refs' AS context_refs
           FROM agent_runs run
           JOIN tasks task ON task.id=run.task_id
           JOIN budget_reservations reservation
             ON reservation.run_id=run.id AND reservation.status='active'
           JOIN commands command ON command.command_id=$2 AND command.run_id=run.id
           JOIN runner_events terminal ON terminal.id=$3
             AND terminal.runner_id=command.runner_id
             AND terminal.runner_generation=command.runner_generation
             AND terminal.causation_id=command.command_id
             AND terminal.event_type='command_ack'
           JOIN runner_events published ON published.run_id=run.id
             AND published.runner_id=terminal.runner_id
             AND published.runner_generation=terminal.runner_generation
             AND published.sequence<terminal.sequence
             AND published.event_type='run_published'
             AND published.causation_id=command.command_id
             AND published.payload->>'outcome'='pushed'
             AND published.payload->>'branch'=run.published_branch
             AND published.payload->>'commit_sha'=run.published_commit_sha
             AND published.payload->>'remote'=run.published_remote
          WHERE run.id=$1
          ORDER BY published.sequence DESC
          LIMIT 1
          FOR UPDATE OF run,task`,
        [runId, commandId, eventId],
      )
    ).rows[0];
    if (!checkpoint || !Array.isArray(checkpoint.context_refs)) {
      for (const pause of pauses) {
        await sql.query(
          `UPDATE conversation_action_delivery_intents
              SET status='failed',last_error='pause_checkpoint_not_published',updated_at=now()
            WHERE id=$1 AND status='fallback_queued'`,
          [pause.intent_id],
        );
        await sql.query(
          `UPDATE conversation_actions
              SET status='failed',failure_code='pause_checkpoint_not_published',updated_at=now()
            WHERE id=$1 AND status IN ('recorded','sent','agent_acknowledged')`,
          [pause.action_id],
        );
        await sql.query(
          `INSERT INTO conversation_action_delivery_events (
             id,project_id,work_item_id,conversation_id,action_id,sequence,status,
             delivery_mode,target_run_id,target_command_id,receipt,occurred_at
           ) SELECT $1,$2,$3,$4,$5,COALESCE(max(sequence),0)+1,
                    'failed','checkpoint',$6,$7,$8::jsonb,$9
               FROM conversation_action_delivery_events WHERE action_id=$5`,
          [
            `action-delivery-event:${pause.action_id}:checkpoint-failed:${eventId}`,
            pause.project_id,
            pause.work_item_id,
            pause.conversation_id,
            pause.action_id,
            runId,
            commandId,
            JSON.stringify({ kind: "failed", failure_code: "pause_checkpoint_not_published" }),
            occurredAt,
          ],
        );
      }
      return false;
    }
    if (
      !["running", "verifying"].includes(checkpoint.run_state) ||
      !["in_progress", "verifying"].includes(checkpoint.task_state)
    ) {
      return false;
    }
    const lifecycle = new SqlV2ApplicationTransaction(sql);
    await transitionV2AgentRunLifecycle(lifecycle, {
      project_id: checkpoint.project_id,
      phase_id: checkpoint.phase_id,
      task_id: checkpoint.task_id,
      run_id: runId,
      expected_aggregate_version: checkpoint.run_aggregate_version,
      to: "waiting_for_human",
      reason: "work paused at a published terminal checkpoint",
      actor_type: "coordinator",
      actor_id: "conversation-pause",
      correlation_id: firstPause.action_id,
      causation_id: commandId,
      occurred_at: occurredAt,
    });
    await transitionV2TaskLifecycle(lifecycle, {
      project_id: checkpoint.project_id,
      phase_id: checkpoint.phase_id,
      task_id: checkpoint.task_id,
      expected_aggregate_version: checkpoint.task_aggregate_version,
      to: "blocked",
      reason: "work paused at a published terminal checkpoint",
      actor_type: "coordinator",
      actor_id: "conversation-pause",
      correlation_id: firstPause.action_id,
      causation_id: commandId,
      occurred_at: occurredAt,
    });
    for (const pause of pauses) {
      const leased = await sql.query<{ id: string }>(
        `UPDATE conversation_action_delivery_intents
            SET status='leased',lease_owner='terminal-pause-checkpoint',
                lease_expires_at=now()+interval '30 seconds',attempts=attempts+1,
                updated_at=now()
          WHERE id=$1 AND status='fallback_queued' RETURNING id`,
        [pause.intent_id],
      );
      if (!leased.rows[0]) continue;
      await sql.query(
        `UPDATE conversation_action_delivery_intents
            SET status='sent',target_command_id=$2,
                target_runner_generation=(
                  SELECT runner_generation FROM commands WHERE command_id=$2
                ),
                lease_owner=NULL,lease_expires_at=NULL,last_error=NULL,updated_at=now()
          WHERE id=$1 AND status='leased'`,
        [pause.intent_id, commandId],
      );
      if (pause.action_status === "recorded") {
        await sql.query(
          `UPDATE conversation_actions SET status='sent',sent_at=$2,updated_at=now()
            WHERE id=$1 AND status='recorded'`,
          [pause.action_id, occurredAt],
        );
      }
      const current = (
        await sql.query<{ status: string }>(
          "SELECT status FROM conversation_actions WHERE id=$1 FOR UPDATE",
          [pause.action_id],
        )
      ).rows[0]?.status;
      if (current === "sent") {
        await sql.query(
          `UPDATE conversation_actions
              SET status='agent_acknowledged',acknowledged_at=$2,updated_at=now()
            WHERE id=$1 AND status='sent'`,
          [pause.action_id, occurredAt],
        );
      }
      await sql.query(
        `UPDATE conversation_action_delivery_intents SET status='acknowledged',updated_at=now()
          WHERE id=$1 AND status='sent'`,
        [pause.intent_id],
      );
      const applied = await sql.query<{ id: string }>(
        `UPDATE conversation_actions SET status='applied',applied_at=$2,updated_at=now()
          WHERE id=$1 AND status='agent_acknowledged' RETURNING id`,
        [pause.action_id, occurredAt],
      );
      const appliedIntent = await sql.query<{ id: string }>(
        `UPDATE conversation_action_delivery_intents SET status='applied',updated_at=now()
          WHERE id=$1 AND status='acknowledged' RETURNING id`,
        [pause.intent_id],
      );
      if (!applied.rows[0] || !appliedIntent.rows[0]) {
        throw new Phase4RunnerEventRejectedError(
          "terminal pause checkpoint lost its acknowledged action",
        );
      }
      if (!pause.task_scoped) {
        await sql.query(
          `UPDATE work_items SET status='blocked',aggregate_version=aggregate_version+1,
                                 updated_at=now()
            WHERE id=$1 AND project_id=$2 AND status='executing'`,
          [pause.work_item_id, pause.project_id],
        );
      }
      const contextHash = canonicalSha256(checkpoint.context_refs);
      await sql.query(
        `INSERT INTO conversation_pause_checkpoints (
           pause_action_id,project_id,work_item_id,conversation_id,phase_id,task_id,
           run_id,source_command_id,budget_reservation_id,published_branch,
           published_commit_sha,published_remote,root_context_refs,context_hash,paused_at
           ,expires_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,
                   $15::timestamptz+interval '7 days')
         ON CONFLICT(pause_action_id) DO NOTHING`,
        [
          pause.action_id,
          pause.project_id,
          pause.work_item_id,
          pause.conversation_id,
          checkpoint.phase_id,
          checkpoint.task_id,
          runId,
          commandId,
          checkpoint.budget_reservation_id,
          checkpoint.published_branch,
          checkpoint.published_commit_sha,
          checkpoint.published_remote,
          JSON.stringify(checkpoint.context_refs),
          contextHash,
          occurredAt,
        ],
      );
      const protectedReservation = await sql.query<{ id: string }>(
        `UPDATE budget_reservations
            SET expires_at=GREATEST(expires_at,$2::timestamptz+interval '7 days'),
                version=version+1,updated_at=now()
          WHERE id=$1 AND status='active' RETURNING id`,
        [checkpoint.budget_reservation_id, occurredAt],
      );
      if (!protectedReservation.rows[0]) {
        throw new Phase4RunnerEventRejectedError("pause checkpoint reservation is not active");
      }
      const receiptHash = canonicalSha256({
        action_id: pause.action_id,
        run_id: runId,
        command_id: commandId,
        terminal_event_id: eventId,
      });
      const events = [
        ["sent", { kind: "sent", outbox_id: commandId }],
        ["agent_acknowledged", { kind: "agent_ack", ack_event_id: eventId }],
        ["applied", { kind: "applied", context_receipt_hash: receiptHash }],
      ] as const;
      for (const [status, receipt] of events) {
        await sql.query(
          `INSERT INTO conversation_action_delivery_events (
             id,project_id,work_item_id,conversation_id,action_id,sequence,status,
             delivery_mode,target_run_id,target_command_id,receipt,occurred_at
           ) SELECT $1,$2,$3,$4,$5,COALESCE(max(sequence),0)+1,$6,
                    'checkpoint',$7,$8,$9::jsonb,$10
               FROM conversation_action_delivery_events WHERE action_id=$5`,
          [
            `action-delivery-event:${pause.action_id}:terminal:${status}:${eventId}`,
            pause.project_id,
            pause.work_item_id,
            pause.conversation_id,
            pause.action_id,
            status,
            runId,
            commandId,
            JSON.stringify(receipt),
            occurredAt,
          ],
        );
      }
    }
    return true;
  }

  private async applyCheckpointDirections(
    sql: V2SqlExecutor,
    scope: RunScope,
    eventId: string,
    commandId: string,
    occurredAt: string,
  ): Promise<void> {
    const rows = (
      await sql.query<{
        action_id: string;
        project_id: string;
        work_item_id: string;
        conversation_id: string;
        action_status: string;
        intent_id: string;
        intent_status: string;
        context_hash: string;
        delivery_mode: "checkpoint" | "continuation";
      }>(
        `SELECT checkpoint.action_id,checkpoint.project_id,checkpoint.work_item_id,
                checkpoint.conversation_id,checkpoint.context_hash,
                action.status AS action_status,intent.id AS intent_id,
                intent.status AS intent_status,
                CASE WHEN command.envelope ? 'continuation'
                     THEN 'continuation' ELSE 'checkpoint' END AS delivery_mode
           FROM conversation_action_checkpoint_contexts checkpoint
           JOIN conversation_actions action ON action.id=checkpoint.action_id
           JOIN conversation_action_delivery_intents intent
             ON intent.action_id=checkpoint.action_id
           JOIN commands command ON command.command_id=checkpoint.command_id
          WHERE checkpoint.task_id=$1 AND checkpoint.command_id=$2
            AND checkpoint.status='sent'
          ORDER BY action.confirmed_at,action.id
          FOR UPDATE OF checkpoint,action,intent`,
        [scope.task_id, commandId],
      )
    ).rows;
    for (const row of rows) {
      if (row.intent_status !== "sent") {
        throw new Phase4RunnerEventRejectedError(
          "checkpoint direction intent is not in sent state",
        );
      }
      if (row.action_status === "sent") {
        const acknowledged = await sql.query<{ id: string }>(
          `UPDATE conversation_actions
              SET status='agent_acknowledged',acknowledged_at=$2,updated_at=now()
            WHERE id=$1 AND status='sent' RETURNING id`,
          [row.action_id, occurredAt],
        );
        if (!acknowledged.rows[0]) {
          throw new Phase4RunnerEventRejectedError(
            "checkpoint direction acknowledgement lost its action",
          );
        }
        await sql.query(
          `INSERT INTO conversation_action_delivery_events (
             id,project_id,work_item_id,conversation_id,action_id,sequence,status,
             delivery_mode,target_run_id,target_command_id,receipt,occurred_at
           ) SELECT $1,$2,$3,$4,$5,COALESCE(max(sequence),0)+1,
                    'agent_acknowledged',$10,$6,$7,$8::jsonb,$9
               FROM conversation_action_delivery_events WHERE action_id=$5`,
          [
            `action-delivery-event:${row.action_id}:checkpoint-ack:${eventId}`,
            row.project_id,
            row.work_item_id,
            row.conversation_id,
            row.action_id,
            scope.id,
            commandId,
            JSON.stringify({ kind: "agent_ack", ack_event_id: eventId }),
            occurredAt,
            row.delivery_mode,
          ],
        );
      }
      const acknowledgedIntent = await sql.query<{ id: string }>(
        `UPDATE conversation_action_delivery_intents
            SET status='acknowledged',updated_at=now()
          WHERE id=$1 AND status='sent' RETURNING id`,
        [row.intent_id],
      );
      if (!acknowledgedIntent.rows[0]) {
        throw new Phase4RunnerEventRejectedError(
          "checkpoint direction acknowledgement lost its intent",
        );
      }
      const appliedAction = await sql.query<{ id: string }>(
        `UPDATE conversation_actions
            SET status='applied',applied_at=$2,updated_at=now()
          WHERE id=$1 AND status='agent_acknowledged' RETURNING id`,
        [row.action_id, occurredAt],
      );
      const appliedIntent = await sql.query<{ id: string }>(
        `UPDATE conversation_action_delivery_intents SET status='applied',updated_at=now()
          WHERE id=$1 AND status='acknowledged' RETURNING id`,
        [row.intent_id],
      );
      if (!appliedAction.rows[0] || !appliedIntent.rows[0]) {
        throw new Phase4RunnerEventRejectedError(
          "checkpoint direction application lost its acknowledged action",
        );
      }
      const receiptHash = canonicalSha256({
        action_id: row.action_id,
        command_id: commandId,
        context_hash: row.context_hash,
        event_id: eventId,
      });
      await sql.query(
        `UPDATE conversation_action_checkpoint_contexts
            SET status='applied',applied_at=$2
          WHERE action_id=$1 AND status='sent'`,
        [row.action_id, occurredAt],
      );
      await sql.query(
        `INSERT INTO conversation_action_delivery_events (
           id,project_id,work_item_id,conversation_id,action_id,sequence,status,
           delivery_mode,target_run_id,target_command_id,receipt,occurred_at
         ) SELECT $1,$2,$3,$4,$5,COALESCE(max(sequence),0)+1,
                  'applied',$10,$6,$7,$8::jsonb,$9
             FROM conversation_action_delivery_events WHERE action_id=$5`,
        [
          `action-delivery-event:${row.action_id}:checkpoint-applied:${eventId}`,
          row.project_id,
          row.work_item_id,
          row.conversation_id,
          row.action_id,
          scope.id,
          commandId,
          JSON.stringify({ kind: "applied", context_receipt_hash: receiptHash }),
          occurredAt,
          row.delivery_mode,
        ],
      );
    }
  }

  private async applyPauseResumeContext(
    sql: V2SqlExecutor,
    scope: RunScope,
    eventId: string,
    commandId: string,
    occurredAt: string,
  ): Promise<void> {
    const row = (
      await sql.query<{
        pause_action_id: string;
        resume_action_id: string;
        project_id: string;
        work_item_id: string;
        conversation_id: string;
        context_hash: string;
        intent_id: string;
      }>(
        `SELECT checkpoint.pause_action_id,checkpoint.resume_action_id,
                checkpoint.project_id,checkpoint.work_item_id,checkpoint.conversation_id,
                checkpoint.resume_context_ref->>'content_hash' AS context_hash,
                intent.id AS intent_id
           FROM conversation_pause_checkpoints checkpoint
           JOIN conversation_actions action ON action.id=checkpoint.resume_action_id
           JOIN conversation_action_delivery_intents intent ON intent.action_id=action.id
           JOIN commands command ON command.command_id=checkpoint.resume_command_id
             AND command.run_id=checkpoint.run_id
          WHERE checkpoint.run_id=$1 AND checkpoint.resume_command_id=$2
            AND checkpoint.status='dispatched' AND action.status='sent'
            AND intent.status='sent'
            AND command.envelope->'context_refs' @> jsonb_build_array(checkpoint.resume_context_ref)
          FOR UPDATE OF checkpoint,action,intent`,
        [scope.id, commandId],
      )
    ).rows[0];
    if (!row) return;
    const acknowledgedAction = await sql.query<{ id: string }>(
      `UPDATE conversation_actions
          SET status='agent_acknowledged',acknowledged_at=$2,updated_at=now()
        WHERE id=$1 AND status='sent' RETURNING id`,
      [row.resume_action_id, occurredAt],
    );
    const acknowledgedIntent = await sql.query<{ id: string }>(
      `UPDATE conversation_action_delivery_intents SET status='acknowledged',updated_at=now()
        WHERE id=$1 AND status='sent' RETURNING id`,
      [row.intent_id],
    );
    if (!acknowledgedAction.rows[0] || !acknowledgedIntent.rows[0]) {
      throw new Phase4RunnerEventRejectedError("pause resume acknowledgement lost its receipt");
    }
    await sql.query(
      `INSERT INTO conversation_action_delivery_events (
         id,project_id,work_item_id,conversation_id,action_id,sequence,status,
         delivery_mode,target_run_id,target_command_id,receipt,occurred_at
       ) SELECT $1,$2,$3,$4,$5,COALESCE(max(sequence),0)+1,
                'agent_acknowledged','continuation',$6,$7,$8::jsonb,$9
           FROM conversation_action_delivery_events WHERE action_id=$5`,
      [
        `action-delivery-event:${row.resume_action_id}:ack:${eventId}`,
        row.project_id,
        row.work_item_id,
        row.conversation_id,
        row.resume_action_id,
        scope.id,
        commandId,
        JSON.stringify({ kind: "agent_ack", ack_event_id: eventId }),
        occurredAt,
      ],
    );
    const appliedAction = await sql.query<{ id: string }>(
      `UPDATE conversation_actions SET status='applied',applied_at=$2,updated_at=now()
        WHERE id=$1 AND status='agent_acknowledged' RETURNING id`,
      [row.resume_action_id, occurredAt],
    );
    const appliedIntent = await sql.query<{ id: string }>(
      `UPDATE conversation_action_delivery_intents SET status='applied',updated_at=now()
        WHERE id=$1 AND status='acknowledged' RETURNING id`,
      [row.intent_id],
    );
    const resumed = await sql.query<{ pause_action_id: string }>(
      `UPDATE conversation_pause_checkpoints
          SET status='resumed',resumed_at=$2,updated_at=now()
        WHERE pause_action_id=$1 AND status='dispatched' RETURNING pause_action_id`,
      [row.pause_action_id, occurredAt],
    );
    if (!appliedAction.rows[0] || !appliedIntent.rows[0] || !resumed.rows[0]) {
      throw new Phase4RunnerEventRejectedError("pause resume application lost its exact receipt");
    }
    await sql.query(
      `UPDATE work_items SET status='executing',aggregate_version=aggregate_version+1,
                             updated_at=now()
        WHERE id=$1 AND project_id=$2 AND status='blocked'`,
      [row.work_item_id, row.project_id],
    );
    await sql.query(
      `INSERT INTO conversation_action_delivery_events (
         id,project_id,work_item_id,conversation_id,action_id,sequence,status,
         delivery_mode,target_run_id,target_command_id,receipt,occurred_at
       ) SELECT $1,$2,$3,$4,$5,COALESCE(max(sequence),0)+1,
                'applied','continuation',$6,$7,$8::jsonb,$9
           FROM conversation_action_delivery_events WHERE action_id=$5`,
      [
        `action-delivery-event:${row.resume_action_id}:applied:${eventId}`,
        row.project_id,
        row.work_item_id,
        row.conversation_id,
        row.resume_action_id,
        scope.id,
        commandId,
        JSON.stringify({
          kind: "applied",
          context_receipt_hash: canonicalSha256({
            pause_action_id: row.pause_action_id,
            resume_action_id: row.resume_action_id,
            command_id: commandId,
            context_hash: row.context_hash,
            event_id: eventId,
          }),
        }),
        occurredAt,
      ],
    );
  }

  private async recordCommandUsageReport(
    sql: V2SqlExecutor,
    scope: RunScope,
    eventId: string,
    commandId: string | null,
    inputTokens: number,
    outputTokens: number,
  ): Promise<void> {
    if (!commandId) {
      throw new Phase4RunnerEventRejectedError("usage report has no command causation");
    }
    const receipt = await sql.query<{ command_id: string }>(
      `INSERT INTO run_command_usage_receipts (
         command_id,run_id,project_id,phase_id,task_id,input_tokens,output_tokens,
         usage_source,status,last_usage_event_id,started_at
       )
       SELECT command.command_id,command.run_id,command.project_id,command.phase_id,
              command.task_id,$3,$4,'runner_report','observing',$5,
              (
                SELECT min(started.occurred_at)
                  FROM runner_events started
                 WHERE started.run_id=command.run_id
                   AND started.causation_id=command.command_id
                   AND started.event_type='run_status'
                   AND started.payload->>'status'='started'
              )
         FROM commands command
        WHERE command.command_id=$1 AND command.run_id=$2
       ON CONFLICT(command_id) DO UPDATE SET
         input_tokens=GREATEST(run_command_usage_receipts.input_tokens,EXCLUDED.input_tokens),
         output_tokens=GREATEST(run_command_usage_receipts.output_tokens,EXCLUDED.output_tokens),
         last_usage_event_id=EXCLUDED.last_usage_event_id,
         started_at=COALESCE(run_command_usage_receipts.started_at,EXCLUDED.started_at),
         updated_at=now()
       WHERE run_command_usage_receipts.status='observing'
       RETURNING command_id`,
      [commandId, scope.id, inputTokens, outputTokens, eventId],
    );
    if (!receipt.rows[0]) {
      const finalized = await sql.query<{ command_id: string }>(
        `SELECT command_id FROM run_command_usage_receipts
          WHERE command_id=$1 AND run_id=$2 AND status='final'
            AND input_tokens>=$3 AND output_tokens>=$4`,
        [commandId, scope.id, inputTokens, outputTokens],
      );
      if (!finalized.rows[0]) {
        throw new Phase4RunnerEventRejectedError("usage report command scope is invalid");
      }
    }
    await this.refreshRunUsageFromCommandReceipts(sql, scope.id);
  }

  private async finalizeCommandUsage(
    sql: V2SqlExecutor,
    scope: RunScope,
    eventId: string,
    commandId: string | null,
    terminalAt: string,
  ): Promise<void> {
    if (!commandId) {
      throw new Phase4RunnerEventRejectedError("runtime result has no command causation");
    }
    await sql.query(
      `INSERT INTO run_command_usage_receipts (
         command_id,run_id,project_id,phase_id,task_id,usage_source,status,started_at
       )
       SELECT command.command_id,command.run_id,command.project_id,command.phase_id,
              command.task_id,'unavailable','observing',
              (
                SELECT min(started.occurred_at)
                  FROM runner_events started
                 WHERE started.run_id=command.run_id
                   AND started.causation_id=command.command_id
                   AND started.event_type='run_status'
                   AND started.payload->>'status'='started'
              )
         FROM commands command
        WHERE command.command_id=$1 AND command.run_id=$2
       ON CONFLICT(command_id) DO NOTHING`,
      [commandId, scope.id],
    );
    const finalized = await sql.query<{ command_id: string }>(
      `WITH current_receipt AS (
         SELECT * FROM run_command_usage_receipts
          WHERE command_id=$1 AND run_id=$2 FOR UPDATE
       ), exact_usage AS (
         SELECT count(usage.id)::int AS event_count,
                COALESCE(sum(usage.input_tokens),0) AS input_tokens,
                COALESCE(sum(usage.output_tokens),0) AS output_tokens,
                COALESCE(sum(usage.cost_usd),0) AS cost_usd
           FROM current_receipt receipt
           LEFT JOIN usage_events usage
             ON usage.run_id=receipt.run_id
            AND usage.occurred_at>=COALESCE(receipt.started_at,usage.occurred_at)
            AND usage.occurred_at<=$3::timestamptz
       )
       UPDATE run_command_usage_receipts receipt
          SET input_tokens=CASE WHEN exact.event_count>0
                                THEN GREATEST(receipt.input_tokens,exact.input_tokens)
                                ELSE receipt.input_tokens END,
              output_tokens=CASE WHEN exact.event_count>0
                                 THEN GREATEST(receipt.output_tokens,exact.output_tokens)
                                 ELSE receipt.output_tokens END,
              cost_usd=CASE WHEN exact.event_count>0
                            THEN GREATEST(receipt.cost_usd,exact.cost_usd)
                            ELSE receipt.cost_usd END,
              active_ms=GREATEST(
                receipt.active_ms,
                CASE WHEN receipt.started_at IS NULL THEN 0
                     ELSE floor(EXTRACT(EPOCH FROM (
                       $3::timestamptz-receipt.started_at
                     ))*1000)::bigint END
              ),
              usage_source=CASE WHEN exact.event_count>0 THEN 'gateway_exact'
                                WHEN receipt.last_usage_event_id IS NOT NULL THEN 'runner_report'
                                ELSE 'unavailable' END,
              status='final',terminal_event_id=$4,terminal_at=$3,updated_at=now()
         FROM exact_usage exact
        WHERE receipt.command_id=$1 AND receipt.run_id=$2 AND receipt.status='observing'
       RETURNING receipt.command_id`,
      [commandId, scope.id, terminalAt, eventId],
    );
    if (!finalized.rows[0]) {
      const replay = await sql.query<{ command_id: string }>(
        `SELECT command_id FROM run_command_usage_receipts
          WHERE command_id=$1 AND run_id=$2 AND status='final'
            AND terminal_event_id=$3`,
        [commandId, scope.id, eventId],
      );
      if (!replay.rows[0]) {
        throw new Phase4RunnerEventRejectedError("runtime usage receipt could not be finalized");
      }
    }
    await this.refreshRunUsageFromCommandReceipts(sql, scope.id);
  }

  private async refreshRunUsageFromCommandReceipts(
    sql: V2SqlExecutor,
    runId: string,
  ): Promise<void> {
    await sql.query(
      `UPDATE agent_runs run
          SET usage_input_tokens=receipt.input_tokens,
              usage_output_tokens=receipt.output_tokens,
              usage_cost_usd=receipt.cost_usd,
              updated_at=now()
         FROM (
           SELECT run_id,COALESCE(sum(input_tokens),0) AS input_tokens,
                  COALESCE(sum(output_tokens),0) AS output_tokens,
                  COALESCE(sum(cost_usd),0) AS cost_usd
             FROM run_command_usage_receipts
            WHERE run_id=$1
            GROUP BY run_id
         ) receipt
        WHERE run.id=receipt.run_id`,
      [runId],
    );
  }

  /**
   * Runtime usage is an aggregate fallback, not another provider request.
   * Record it only when the run has no canonical provider/gateway requests;
   * otherwise it would double count the same tokens.
   */
  private async recordRuntimeUsageFallback(
    sql: V2SqlExecutor,
    scope: RunScope,
    eventId: string,
    commandId: string | null,
    runtime: {
      runtime: string;
      outcome: "completed" | "waiting_for_human" | "failed" | "cancelled";
    },
    occurredAt: string,
  ): Promise<void> {
    const profile = await sql.query<{
      provider: string;
      model: string;
      credential_mode: "api" | "subscription";
    }>(
      `SELECT profile.provider, profile.model,
              CASE WHEN profile.cost_metadata->>'billing_mode' = 'subscription'
                THEN 'subscription' ELSE 'api' END AS credential_mode
       FROM agent_assignments assignment
       JOIN agent_profiles profile ON profile.id = assignment.agent_profile_id
       WHERE assignment.id = $1`,
      [scope.assignment_id],
    );
    const selection = profile.rows[0];
    if (!selection) return;
    if (!commandId) return;
    const usage = await sql.query<{
      input_tokens: string | number;
      output_tokens: string | number;
      started_at: Date | string | null;
      terminal_at: Date | string;
    }>(
      `SELECT input_tokens,output_tokens,started_at,terminal_at
         FROM run_command_usage_receipts
        WHERE run_id=$1 AND command_id=$2 AND status='final'`,
      [scope.id, commandId],
    );
    const totals = usage.rows[0];
    if (!totals) return;
    const providerRequests = await sql.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM ai_usage_events
          WHERE run_id=$1 AND request_type<>'runtime_aggregate_report'
            AND occurred_at>=COALESCE($2::timestamptz,occurred_at)
            AND occurred_at<=$3::timestamptz
       ) AS exists`,
      [scope.id, totals.started_at, totals.terminal_at],
    );
    if (providerRequests.rows[0]?.exists) return;

    const requestId = `runtime-report:${scope.id}:${commandId}`;
    const endpoint = `runner-runtime:${runtime.runtime}`;
    const costClassification =
      selection.credential_mode === "subscription" ? "subscription_consumption" : "unavailable";
    const common = [
      requestId,
      occurredAt,
      selection.provider,
      selection.model,
      endpoint,
      scope.initiated_by_user_id,
      scope.project_id,
      scope.phase_id,
      scope.task_id,
      scope.id,
    ] as const;
    await sql.query(
      `INSERT INTO ai_usage_events (
         id, request_id, sequence, event_type, status, occurred_at,
         provider, model, endpoint, request_type, retry_attempt,
         initiated_by_user_id, project_id, phase_id, task_id, run_id,
         usage_source, confidence,
         cost_classification
       ) VALUES (
         $1,$2,1,'request_started','started',$3,$4,$5,$6,
         'runtime_aggregate_report',0,$7,$8,$9,$10,$11,
         'unavailable',0,'unavailable'
       )`,
      [`${requestId}:started`, ...common],
    );
    await sql.query(
      `INSERT INTO ai_usage_events (
         id, request_id, sequence, event_type, status, occurred_at,
         provider, model, endpoint, request_type, retry_attempt,
         initiated_by_user_id, project_id, phase_id, task_id, run_id,
         usage_source, confidence,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
         cost_classification
       ) VALUES (
         $1,$2,2,'usage_observed','in_progress',$3,$4,$5,$6,
         'runtime_aggregate_report',0,$7,$8,$9,$10,$11,'runtime_report',0.6,
         $12,$13,0,0,$14
       )`,
      [
        `${requestId}:usage`,
        ...common,
        Number(totals.input_tokens),
        Number(totals.output_tokens),
        costClassification,
      ],
    );
    const completed = runtime.outcome === "completed" || runtime.outcome === "waiting_for_human";
    await sql.query(
      `INSERT INTO ai_usage_events (
         id, request_id, sequence, event_type, status, occurred_at,
         provider, model, endpoint, request_type, retry_attempt,
         initiated_by_user_id, project_id, phase_id, task_id, run_id,
         usage_source, confidence,
         cost_classification, error_code, error_category, error_message_redacted,
         sanitized_error
       ) VALUES (
         $1,$2,3,$12,$13,$3,$4,$5,$6,'runtime_aggregate_report',0,
         $7,$8,$9,$10,$11,'unavailable',0,'unavailable',$14,$15,$16,$17::jsonb
       )`,
      [
        `${requestId}:terminal`,
        ...common,
        completed ? "request_completed" : "request_failed",
        completed ? "succeeded" : "failed",
        completed ? null : `runtime_${runtime.outcome}`,
        completed ? null : "runtime",
        completed ? null : `runner runtime ${runtime.outcome}`,
        completed ? null : JSON.stringify({ outcome: runtime.outcome }),
      ],
    );
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
    const commandReceipts = await sql.query<{
      receipt_count: number | string;
      gateway_events: number | string;
      input_tokens: number | string;
      output_tokens: number | string;
      cost_usd: number | string;
    }>(
      `SELECT count(*)::int AS receipt_count,
              count(*) FILTER (WHERE usage_source='gateway_exact')::int AS gateway_events,
              COALESCE(sum(input_tokens),0) AS input_tokens,
              COALESCE(sum(output_tokens),0) AS output_tokens,
              COALESCE(sum(cost_usd),0) AS cost_usd
         FROM run_command_usage_receipts
        WHERE run_id=$1`,
      [runId],
    );
    const receipt = commandReceipts.rows[0];
    if (Number(receipt?.receipt_count ?? 0) > 0) {
      const reconciled = {
        gateway_events: Number(receipt?.gateway_events ?? 0),
        input_tokens: Number(receipt?.input_tokens ?? 0),
        output_tokens: Number(receipt?.output_tokens ?? 0),
        cost_usd: Number(receipt?.cost_usd ?? 0),
      };
      await sql.query(
        `UPDATE agent_runs
            SET usage_input_tokens=$2,usage_output_tokens=$3,
                usage_cost_usd=$4,updated_at=now()
          WHERE id=$1`,
        [runId, reconciled.input_tokens, reconciled.output_tokens, reconciled.cost_usd],
      );
      return reconciled;
    }
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
