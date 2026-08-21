import { conservativeMaxChargeUsd, snapshotModelPricing } from "@norns/adapters";
import {
  type CodexReasoningEffortT,
  type V2ActorT,
  V2ContentAddressedReference,
  type V2ContentAddressedReferenceT,
  V2DispatchCommand,
  type V2DispatchCommandT,
  type V2TaskInputFileT,
  V2_HUMAN_WAIT_CHANNEL_VERSION,
  V2_HUMAN_WAIT_INSTRUCTION_HASH,
  reasoningEffortForModel,
  v2CommandIdForDispatchJob,
} from "@norns/contracts";
import type { PostgresDeviceActionAuthorization } from "../devices/actionAuthorization.js";
import { verificationCommandsFromTaskPackage } from "../execution/verificationPolicy.js";
import {
  CLAUDE_CODE_SONNET_5_MAX_OUTPUT_TOKENS,
  GATEWAY_REQUEST_BODY_LIMIT_BYTES,
  estimateGatewayInputTokens,
} from "../gateway/request.js";
import type { V2TransactionRunner } from "../persistence/v2/database.js";
import { transitionV2TaskLifecycle } from "../persistence/v2/lifecycleMutation.js";
import { SqlV2ApplicationTransaction } from "../persistence/v2/sqlRepositories.js";
import { resolveDispatchRuntime } from "./agenticRuntime.js";
import { resolveProjectVerificationCommands } from "./verificationCommandSource.js";

/**
 * Maximum single-call hold the gateway can require for the installed Claude
 * Code SDK using Sonnet 5: the route's largest accepted body, the SDK's 64k
 * output declaration, and the registry's conservative token prices.
 */
export const CLAUDE_SONNET_5_MAX_GATEWAY_PREFLIGHT_USD = conservativeMaxChargeUsd(
  snapshotModelPricing("anthropic", "claude-sonnet-5"),
  {
    max_input_tokens: estimateGatewayInputTokens(GATEWAY_REQUEST_BODY_LIMIT_BYTES),
    max_output_tokens: CLAUDE_CODE_SONNET_5_MAX_OUTPUT_TOKENS,
  },
);

/**
 * $2 is the smallest practical round-dollar cap above Sonnet 5's $1.341052
 * maximum gateway preflight. The $0.658948 margin absorbs pricing/body-limit
 * rounding while remaining far below the planned-work default.
 */
export const DEFAULT_QUICK_CHANGE_MAX_CHARGE_USD = 2;

export interface Phase4CoordinatorOptions {
  quickChangeMaxChargeUsd?: number;
  deviceAuthorization?: PostgresDeviceActionAuthorization;
}

export class Phase4CoordinatorConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Phase4CoordinatorConflictError";
  }
}

/**
 * EXECUTION E12 — why this refusal is TEMPORARY.
 *
 * Three of this gate's refusals are not "this task cannot run"; they are "this
 * task cannot run YET, and will become runnable when a sibling finishes":
 * the project concurrency cap, the agent profile concurrency cap, and the
 * repository-scope mutual exclusion. Every other refusal here is a real block
 * that needs a human to change something (no verified binding, phase not
 * approved, budget insufficient, dependencies incomplete).
 *
 * Before E12 the caller could not tell those apart except by matching on the
 * message text, so `PhaseLaunchService` reported all of them as BLOCKED and
 * nothing ever retried them: a phase with three ready tasks and a cap of two
 * dispatched two and silently abandoned the third until a human clicked Start
 * again. That is the "fan-out control" hole -- over-cap work FAILED instead of
 * queueing.
 *
 * This is a SUBCLASS, deliberately. Every existing `catch (e) { if (e
 * instanceof Phase4CoordinatorConflictError) }` site keeps behaving exactly as
 * it did, and the messages below are byte-for-byte the ones this gate has
 * always thrown -- callers that never learn about this type lose nothing. The
 * gate's decisions are entirely unchanged; only their *classification* is new.
 */
export type Phase4DeferralReason =
  | "project_concurrency"
  | "profile_concurrency"
  | "repository_scope_conflict";

export class Phase4CoordinatorDeferredError extends Phase4CoordinatorConflictError {
  constructor(
    readonly deferral_reason: Phase4DeferralReason,
    message: string,
  ) {
    super(message);
    this.name = "Phase4CoordinatorDeferredError";
  }
}

export interface Phase4ScheduleInput {
  project_id: string;
  phase_id: string;
  task_id: string;
  assignment_id: string;
  runner_id: string;
  runner_generation: number;
  authorized_by: V2ActorT;
  authorized_by_session_id: string;
  correlation_id: string;
  causation_id: string | null;
  context_refs: V2ContentAddressedReferenceT[];
  input_files?: V2TaskInputFileT[];
  target_branch: string;
  worktree_policy_ref: string;
  sandbox_policy_ref: string;
  max_input_tokens: number;
  max_output_tokens: number;
  max_duration_seconds: number;
  max_turns?: number;
  issued_at: string;
  expires_at: string;
  /**
   * Actions-hosted work is durable before its ephemeral runner enrolls. Such
   * jobs remain outside the ordinary dispatcher retry loop until enrollment
   * proves the exact runner generation.
   */
  awaiting_runner_enrollment?: boolean;
  /**
   * Required when a replacement attempt supersedes the currently designated
   * run. This is accepted only for reviewer rework from a succeeded run or
   * explicit recovery from a terminal failed/expired/cancelled run.
   */
  supersedes_run_id?: string | null;
}

export interface Phase4ScheduledRun {
  run_id: string;
  dispatch_job_id: string;
  command_id: string;
  budget_reservation_id: string;
  command: V2DispatchCommandT;
  /**
   * EXECUTION E10 — ingested verification facts that could not be turned into
   * an argv vector and were therefore NOT sent. Reported rather than swallowed:
   * a dropped test command is exactly the kind of silent degradation that made
   * a green verification badge meaningless before E4.
   */
  rejected_verification_commands: { name: string; value: string }[];
}

interface SchedulingRow {
  task_state: string;
  task_aggregate_version: number;
  task_title: string;
  initiated_by_user_id: string | null;
  verification_policy_ref: string;
  phase_status: string;
  approved_budget_usd: string | number;
  assignment_status: string;
  budget_limit_usd: string | number;
  agent_profile_id: string;
  provider: string;
  runtime: string;
  model: string;
  reasoning_effort: CodexReasoningEffortT | null;
  credential_mode: "api" | "subscription";
  repository_binding_id: string | null;
  runner_repository_id: string | null;
  repository_binding_type: "local_runner" | "github" | null;
  repository_default_branch: string | null;
  repository_runner_id: string | null;
  project_device_repository_grant_id: string | null;
  /**
   * FRONT DOOR P2b (D2): null when the project has no repository binding at
   * all (e.g. a folder-first local project that only has an unverified
   * repository_binding_candidates row); otherwise the binding's actual
   * status ('unverified_candidate' | 'validating' | 'connected' | ...).
   * Only 'connected' clears the execution-dispatch gate below.
   */
  repository_binding_status: string | null;
  expected_revision: string | null;
  max_concurrent_tasks: number;
  max_concurrent_runs: number;
  active_workload: number;
  execution_mode: "quick" | "planned";
}

interface ConversationTaskPackageBindingRow {
  handoff_id: string;
  work_item_id: string;
  work_item_status: string;
  pause_pending: boolean;
  pause_point_blocked: boolean;
  package_id: string | null;
  content_hash: string | null;
  context_document_id: string | null;
  byte_size: number | string | null;
  package: unknown | null;
}

interface ConversationTaskPackageSupplementRow {
  supplement_id: string;
  task_id: string;
  base_package_id: string;
  ordinal: number | string;
  content_hash: string;
  context_document_id: string;
  byte_size: number | string;
}

function runIdentity(taskId: string, attempt: number): string {
  return `run:${encodeURIComponent(taskId)}:${attempt}`;
}

export class Phase4Coordinator {
  private readonly quickChangeMaxChargeUsd: number;
  private readonly deviceAuthorization: PostgresDeviceActionAuthorization | undefined;

  constructor(
    private readonly transactions: V2TransactionRunner,
    options: Phase4CoordinatorOptions = {},
  ) {
    this.quickChangeMaxChargeUsd =
      options.quickChangeMaxChargeUsd ?? DEFAULT_QUICK_CHANGE_MAX_CHARGE_USD;
    this.deviceAuthorization = options.deviceAuthorization;
    if (!Number.isFinite(this.quickChangeMaxChargeUsd) || this.quickChangeMaxChargeUsd < 0) {
      throw new Error("quickChangeMaxChargeUsd must be finite and nonnegative");
    }
  }

  schedule(input: Phase4ScheduleInput): Promise<Phase4ScheduledRun> {
    const contextRefs = input.context_refs.map((reference) =>
      V2ContentAddressedReference.parse(reference),
    );
    if (contextRefs.length === 0) {
      throw new Phase4CoordinatorConflictError("dispatch requires content-addressed context");
    }
    return this.transactions.transaction(async (sql) => {
      const rows = await sql.query<SchedulingRow>(
        `SELECT t.state AS task_state, t.aggregate_version AS task_aggregate_version,
                t.title AS task_title,t.initiated_by_user_id,t.verification_policy_ref,
                p.status AS phase_status, p.approved_budget_usd,
                a.status AS assignment_status, a.budget_limit_usd, a.agent_profile_id,
                profile.provider, profile.runtime, profile.model, profile.reasoning_effort,
                CASE WHEN profile.cost_metadata->>'billing_mode' = 'subscription'
                  THEN 'subscription' ELSE 'api' END AS credential_mode,
                project.primary_repository_binding_id AS repository_binding_id,
                project.max_concurrent_tasks, profile.max_concurrent_runs,
                profile.active_workload,
                CASE WHEN planning.mode='quick' THEN 'quick' ELSE 'planned' END
                  AS execution_mode,
                binding.observed_head AS expected_revision,
                binding.repository_id AS runner_repository_id,
                binding.binding_type AS repository_binding_type,
                binding.default_branch AS repository_default_branch,
                binding.runner_id AS repository_runner_id,
                binding.project_device_repository_grant_id,
                binding.status AS repository_binding_status
         FROM tasks t
         JOIN phases p ON p.id = t.phase_id AND p.project_id = t.project_id
         JOIN projects project ON project.id = t.project_id
         JOIN agent_assignments a ON a.id = $4 AND a.task_id = t.id
         JOIN agent_profiles profile ON profile.id = a.agent_profile_id
         LEFT JOIN planning_runs planning
           ON planning.id = p.planning_run_id
          AND planning.project_id = p.project_id
         -- FRONT DOOR P2b (D2): deliberately a LEFT JOIN (not the prior
         -- inner join requiring status = 'connected'). Planning, staffing,
         -- and approval must all work with no repository binding at all —
         -- a folder-first local project created with no runner online has
         -- only an unverified repository_binding_candidates row until a
         -- runner verifies it. Execution dispatch is the one place that
         -- gate belongs; it is enforced explicitly below, with a message
         -- that says exactly what's missing, instead of silently vanishing
         -- into the generic "scheduling scope is unavailable" conflict.
         LEFT JOIN repository_bindings binding
           ON binding.id = project.primary_repository_binding_id
          AND binding.project_id = project.id
         WHERE t.project_id = $1 AND t.phase_id = $2 AND t.id = $3
         FOR UPDATE OF t, p, a`,
        [input.project_id, input.phase_id, input.task_id, input.assignment_id],
      );
      const row = rows.rows[0];
      if (!row) throw new Phase4CoordinatorConflictError("task scheduling scope is unavailable");
      const packageScope = (
        await sql.query<ConversationTaskPackageBindingRow>(
          `SELECT intent.handoff_id,intent.work_item_id,
                  item.status AS work_item_status,
                  EXISTS (
                    SELECT 1
                      FROM conversation_actions pause
                     WHERE pause.work_item_id=intent.work_item_id
                       AND pause.action_type='pause_work'
                       AND pause.status IN ('recorded','sent','agent_acknowledged')
                       AND (
                         NOT (pause.payload->'parameters' ? 'task_id')
                         OR pause.payload->'parameters'->>'task_id' IS NULL
                         OR pause.payload->'parameters'->>'task_id'=$3
                       )
                  ) AS pause_pending,
                  EXISTS (
                    SELECT 1
                      FROM conversation_development_pause_points pause_point
                     WHERE pause_point.phase_id=phase.id
                       AND pause_point.pause_after_completion=true
                       AND pause_point.phase_position < (
                         SELECT current_point.phase_position
                           FROM conversation_development_pause_points current_point
                          WHERE current_point.task_id=$3
                       )
                  ) AS pause_point_blocked,
                  package_binding.package_id, package_binding.content_hash,
                  package_binding.context_document_id, document.byte_size,
                  task_package.package
             FROM phases phase
             JOIN conversation_kickoff_intents intent
               ON intent.project_id=phase.project_id
              AND intent.planning_run_id=phase.planning_run_id
             JOIN work_items item
               ON item.id=intent.work_item_id
              AND item.project_id=intent.project_id
             LEFT JOIN conversation_task_package_bindings package_binding
               ON package_binding.handoff_id=intent.handoff_id
              AND package_binding.task_id=$3
             LEFT JOIN task_context_documents document
               ON document.id=package_binding.context_document_id
             LEFT JOIN conversation_task_packages task_package
               ON task_package.id=package_binding.package_id
            WHERE phase.project_id=$1 AND phase.id=$2
            ORDER BY intent.created_at DESC, intent.id DESC
            LIMIT 1`,
          [input.project_id, input.phase_id, input.task_id],
        )
      ).rows[0];
      if (
        packageScope?.work_item_status === "blocked" ||
        packageScope?.pause_pending ||
        packageScope?.pause_point_blocked
      ) {
        throw new Phase4CoordinatorConflictError(
          "conversation work is paused and cannot dispatch until its selected pause point is cleared",
        );
      }
      if (packageScope && !packageScope.package_id) {
        throw new Phase4CoordinatorConflictError(
          "conversation-originated task is missing its immutable task package binding",
        );
      }
      const taskPackageContextRefs = packageScope?.package_id
        ? contextRefs.filter(
            (reference) =>
              reference.artifact_id === packageScope.context_document_id &&
              reference.content_hash === packageScope.content_hash &&
              reference.byte_size === Number(packageScope.byte_size),
          )
        : [];
      if (packageScope?.package_id && taskPackageContextRefs.length !== 1) {
        throw new Phase4CoordinatorConflictError(
          "dispatch context does not contain exactly one ref for the bound immutable task package",
        );
      }
      const taskPackageDispatch =
        packageScope?.package_id &&
        packageScope.content_hash &&
        packageScope.context_document_id &&
        taskPackageContextRefs[0]
          ? {
              id: packageScope.package_id,
              contentHash: packageScope.content_hash,
              contextDocumentId: packageScope.context_document_id,
              contextRef: taskPackageContextRefs[0],
              package: packageScope.package,
            }
          : null;
      if (packageScope?.package_id && !taskPackageDispatch) {
        throw new Phase4CoordinatorConflictError("immutable task package binding is incomplete");
      }
      // Both relations are append-only/content-addressed. A row lock adds no
      // safety here and PostgreSQL would require UPDATE permission from the
      // intentionally restricted runtime role merely to read them.
      const supplementRows = taskPackageDispatch
        ? (
            await sql.query<ConversationTaskPackageSupplementRow>(
              `SELECT supplement.id AS supplement_id,supplement.task_id,
                      supplement.base_package_id,supplement.ordinal,
                      supplement.content_hash,supplement.context_document_id,
                      document.byte_size
                 FROM conversation_task_package_supplements supplement
                 JOIN task_context_documents document
                   ON document.id=supplement.context_document_id
                WHERE supplement.project_id=$1 AND supplement.task_id=$2
                  AND supplement.base_package_id=$3
                ORDER BY supplement.ordinal,supplement.id`,
              [input.project_id, input.task_id, taskPackageDispatch.id],
            )
          ).rows
        : [];
      const taskPackageSupplements = supplementRows.map((supplement, index) => {
        if (Number(supplement.ordinal) !== index + 1) {
          throw new Phase4CoordinatorConflictError(
            "immutable task package supplements are not a contiguous append-only sequence",
          );
        }
        const matches = contextRefs.filter(
          (reference) =>
            reference.artifact_id === supplement.context_document_id &&
            reference.content_hash === supplement.content_hash &&
            reference.byte_size === Number(supplement.byte_size),
        );
        if (matches.length !== 1 || !matches[0]) {
          throw new Phase4CoordinatorConflictError(
            `dispatch context does not contain exact approved mockup supplement ${supplement.supplement_id}`,
          );
        }
        return {
          supplement_id: supplement.supplement_id,
          task_id: supplement.task_id,
          base_package_id: supplement.base_package_id,
          ordinal: Number(supplement.ordinal),
          content_hash: supplement.content_hash,
          context_ref: matches[0],
        };
      });
      const deviceBackedBinding = row.project_device_repository_grant_id !== null;
      const bindingReady =
        row.repository_binding_status === "connected" ||
        (deviceBackedBinding &&
          (row.repository_binding_status === "degraded" ||
            row.repository_binding_status === "disconnected"));
      if (!bindingReady) {
        throw new Phase4CoordinatorConflictError(
          "execution requires a verified repository binding that has not been revoked",
        );
      }
      const revocation = await sql.query<{ revoked_through_generation: number }>(
        "SELECT revoked_through_generation FROM runner_revocations WHERE runner_id=$1",
        [input.runner_id],
      );
      if (
        revocation.rows[0] &&
        input.runner_generation <= revocation.rows[0].revoked_through_generation
      ) {
        throw new Phase4CoordinatorConflictError("runner generation has been revoked");
      }
      if (!input.authorized_by.actor_id) {
        throw new Phase4CoordinatorConflictError("dispatch authorization must be attributable");
      }
      if (!row.repository_binding_id) {
        throw new Phase4CoordinatorConflictError(
          "device dispatch requires an immutable repository binding",
        );
      }
      if (deviceBackedBinding && !this.deviceAuthorization) {
        throw new Phase4CoordinatorConflictError(
          "device repository binding requires typed authorization",
        );
      }
      if (this.deviceAuthorization) {
        try {
          if (!row.initiated_by_user_id) {
            throw new Error("device dispatch requires an attributable original actor");
          }
          const identity = await this.deviceAuthorization.resolveDispatchTargetIdentity(sql, {
            runner_id: input.runner_id,
            generation: input.runner_generation,
          });
          await this.deviceAuthorization.assertDispatchBinding(sql, {
            ...identity,
            actor_user_id: row.initiated_by_user_id,
            project_id: input.project_id,
            repository_binding_id: row.repository_binding_id,
          });
        } catch {
          throw new Phase4CoordinatorConflictError(
            "device repository binding is not currently authorized for dispatch",
          );
        }
      }
      if (!row.expected_revision) {
        throw new Phase4CoordinatorConflictError("repository binding has no verified revision");
      }
      if (
        row.repository_binding_type === "local_runner" &&
        !deviceBackedBinding &&
        row.repository_runner_id !== input.runner_id
      ) {
        throw new Phase4CoordinatorConflictError(
          "local repository binding belongs to a different runner",
        );
      }
      if (!["approved", "active"].includes(row.phase_status)) {
        throw new Phase4CoordinatorConflictError("phase is not approved for execution");
      }
      const isReplacement =
        input.supersedes_run_id !== undefined && input.supersedes_run_id !== null;
      if (
        !["pending", "ready"].includes(row.task_state) &&
        !(isReplacement && row.task_state === "in_review")
      ) {
        throw new Phase4CoordinatorConflictError(`task is not schedulable from ${row.task_state}`);
      }
      const activeCapacity = await sql.query<{ project_count: number; profile_count: number }>(
        `SELECT
           (SELECT count(*)::int FROM agent_runs
            WHERE project_id=$1 AND state IN ('created','dispatched','running','verifying')) AS project_count,
           (SELECT count(*)::int FROM agent_runs run
            JOIN agent_assignments assigned ON assigned.id=run.assignment_id
            WHERE assigned.agent_profile_id=$2
              AND run.state IN ('created','dispatched','running','verifying')) AS profile_count`,
        [input.project_id, row.agent_profile_id],
      );
      const capacity = activeCapacity.rows[0] ?? { project_count: 0, profile_count: 0 };
      // EXECUTION E12 — the fan-out cap, enforced here and nowhere else.
      //
      // This count is the authority. `PhaseLaunchService` pre-computes free
      // slots to avoid assembling context for work it knows cannot run, but
      // that is an optimisation, not a second gate: this transaction takes
      // `FOR UPDATE` on the task/phase/assignment rows and re-counts inside
      // it, so two concurrent launches racing for the last slot cannot both
      // win. Over-cap work is DEFERRED (queued), never failed -- see
      // Phase4CoordinatorDeferredError.
      if (capacity.project_count >= row.max_concurrent_tasks) {
        throw new Phase4CoordinatorDeferredError(
          "project_concurrency",
          "project concurrency capacity is exhausted",
        );
      }
      if (capacity.profile_count >= row.max_concurrent_runs) {
        throw new Phase4CoordinatorDeferredError(
          "profile_concurrency",
          "agent profile concurrency capacity is exhausted",
        );
      }
      const conflictRows = await sql.query<{ task_id: string; conflict_keys: unknown }>(
        `SELECT constraint_row.task_id, constraint_row.conflict_keys
         FROM task_coordination_constraints constraint_row
         JOIN tasks conflict_task ON conflict_task.id=constraint_row.task_id
         WHERE constraint_row.phase_id=$1
           AND (constraint_row.task_id=$2
                OR conflict_task.state IN ('assigned','in_progress','verifying','in_review'))`,
        [input.phase_id, input.task_id],
      );
      const ownConflictKeys = conflictRows.rows.find(
        (entry) => entry.task_id === input.task_id,
      )?.conflict_keys;
      const ownKeys = new Set(
        Array.isArray(ownConflictKeys)
          ? ownConflictKeys.filter((key): key is string => typeof key === "string")
          : [],
      );
      if (
        ownKeys.size > 0 &&
        conflictRows.rows.some(
          (entry) =>
            entry.task_id !== input.task_id &&
            Array.isArray(entry.conflict_keys) &&
            entry.conflict_keys.some((key) => typeof key === "string" && ownKeys.has(key)),
        )
      ) {
        // EXECUTION E12 — the FIRST of two conflict-safety layers, and the
        // cheap one: two tasks that declare overlapping file scope are never
        // allowed to run at the same time, so the conflict never gets written.
        // Deferred, not blocked: the moment the sibling reaches a terminal
        // state this task becomes dispatchable, and E12's drainer retries it.
        //
        // Its reach is exactly as wide as `task_coordination_constraints`
        // actually being populated -- which, before E12, was never. See
        // `TaskConflictScopeRepository` and the second (fail-closed) layer in
        // `runIntegrationConflicts.ts` for what covers the undeclared case.
        throw new Phase4CoordinatorDeferredError(
          "repository_scope_conflict",
          "task conflicts with active repository scope",
        );
      }
      const incompleteDependencies = await sql.query<{ count: number }>(
        `SELECT count(*)::int AS count
         FROM task_dependencies dependency
         JOIN tasks predecessor ON predecessor.id = dependency.predecessor_task_id
         WHERE dependency.successor_task_id = $1 AND predecessor.state <> 'completed'`,
        [input.task_id],
      );
      if ((incompleteDependencies.rows[0]?.count ?? 0) > 0) {
        throw new Phase4CoordinatorConflictError("task dependencies are not complete");
      }
      const attemptResult = await sql.query<{ attempt: number }>(
        "SELECT COALESCE(max(attempt), 0)::int + 1 AS attempt FROM agent_runs WHERE task_id = $1",
        [input.task_id],
      );
      const attempt = attemptResult.rows[0]?.attempt ?? 1;
      const runId = runIdentity(input.task_id, attempt);
      const dispatchJobId = `dispatch-job:${runId}`;
      const commandId = v2CommandIdForDispatchJob(dispatchJobId);
      const reservationId = `budget-reservation:${runId}`;
      const assignmentMaxCharge = Number(row.budget_limit_usd);
      const maxCharge =
        row.execution_mode === "quick"
          ? Math.min(assignmentMaxCharge, this.quickChangeMaxChargeUsd)
          : assignmentMaxCharge;
      const existingReservations = await sql.query<{ amount: string | number }>(
        `SELECT COALESCE(sum(amount_usd), 0) AS amount FROM budget_reservations
         WHERE phase_id = $1 AND status IN ('active','retained_ambiguous')`,
        [input.phase_id],
      );
      if (
        Number(existingReservations.rows[0]?.amount ?? 0) + maxCharge >
        Number(row.approved_budget_usd)
      ) {
        throw new Phase4CoordinatorConflictError("approved phase budget is insufficient");
      }
      let recovery:
        | {
            previous_run_id: string;
            resume_session_id: string;
            session_portability: "same_runner";
          }
        | undefined;
      let recoveryBaseRevision: string | null = null;
      if (isReplacement) {
        const prior = await sql.query<{
          id: string;
          state: string;
          runner_id: string;
          runtime_session_id: string | null;
          provider: string;
          runtime: string;
          model: string;
          published_commit_sha: string | null;
        }>(
          `SELECT run.id, run.state, run.runner_id, run.runtime_session_id,
                  run.published_commit_sha, profile.provider, profile.runtime, profile.model
             FROM agent_runs run
             JOIN agent_assignments assignment ON assignment.id=run.assignment_id
             JOIN agent_profiles profile ON profile.id=assignment.agent_profile_id
           WHERE run.id=$1 AND run.task_id=$2 AND run.is_designated=true
             AND run.superseded_at IS NULL
           FOR UPDATE`,
          [input.supersedes_run_id, input.task_id],
        );
        const priorRun = prior.rows[0];
        const validReviewRework = priorRun?.state === "succeeded" && row.task_state === "in_review";
        const validTerminalRetry =
          priorRun !== undefined &&
          ["failed", "expired", "cancelled"].includes(priorRun.state) &&
          row.task_state === "ready";
        if (!validReviewRework && !validTerminalRetry) {
          throw new Phase4CoordinatorConflictError(
            "replacement must supersede the current designated green review run or a terminal failed run prepared for retry",
          );
        }
        if (validTerminalRetry && priorRun.published_commit_sha) {
          recoveryBaseRevision = priorRun.published_commit_sha;
        }
        if (
          validTerminalRetry &&
          priorRun.runtime_session_id &&
          priorRun.runner_id === input.runner_id &&
          priorRun.provider === row.provider &&
          resolveDispatchRuntime(priorRun.runtime, priorRun.provider) ===
            resolveDispatchRuntime(row.runtime, row.provider) &&
          priorRun.model === row.model
        ) {
          recovery = {
            previous_run_id: priorRun.id,
            resume_session_id: priorRun.runtime_session_id,
            session_portability: "same_runner",
          };
        }
      }
      await sql.query(
        `INSERT INTO agent_runs (
           id, project_id, phase_id, task_id, assignment_id, attempt, state,
           is_designated, runner_id, repository_binding_id, expected_revision,
           verification_status, lifecycle_version, aggregate_version,
           initiated_by_user_id
         ) VALUES ($1,$2,$3,$4,$5,$6,'created',$10,$7,$8,$9,'pending',0,1,$11)`,
        [
          runId,
          input.project_id,
          input.phase_id,
          input.task_id,
          input.assignment_id,
          attempt,
          input.runner_id,
          row.repository_binding_id,
          recoveryBaseRevision ?? row.expected_revision,
          !isReplacement,
          row.initiated_by_user_id,
        ],
      );
      if (taskPackageDispatch) {
        await sql.query(
          `INSERT INTO conversation_task_package_runs (
             run_id, package_id, project_id, phase_id, task_id,
             content_hash, context_document_id
           ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            runId,
            taskPackageDispatch.id,
            input.project_id,
            input.phase_id,
            input.task_id,
            taskPackageDispatch.contentHash,
            taskPackageDispatch.contextDocumentId,
          ],
        );
      }
      if (isReplacement) {
        await sql.query(
          `UPDATE agent_runs
           SET is_designated=false, superseded_at=$3, superseded_by_run_id=$2, updated_at=now()
           WHERE id=$1`,
          [input.supersedes_run_id, runId, input.issued_at],
        );
        await sql.query("UPDATE agent_runs SET is_designated=true WHERE id=$1", [runId]);
      }
      await sql.query(
        `UPDATE tasks SET designated_assignment_id = $2, designated_run_id = $3
         WHERE id = $1`,
        [input.task_id, input.assignment_id, runId],
      );
      const lifecycle = new SqlV2ApplicationTransaction(sql);
      const actor = {
        actor_type: input.authorized_by.actor_type,
        actor_id: input.authorized_by.actor_id,
        correlation_id: input.correlation_id,
        causation_id: input.causation_id,
        occurred_at: input.issued_at,
      } as const;
      let task = await lifecycle.lockTaskLifecycle(input.task_id);
      if (!task) throw new Phase4CoordinatorConflictError("task disappeared during scheduling");
      if (task.state === "pending") {
        task = await transitionV2TaskLifecycle(lifecycle, {
          ...actor,
          project_id: input.project_id,
          phase_id: input.phase_id,
          task_id: input.task_id,
          expected_aggregate_version: task.aggregate_version,
          to: "ready",
          reason: "dependencies satisfied",
        });
      }
      if (task.state === "ready") {
        await transitionV2TaskLifecycle(lifecycle, {
          ...actor,
          project_id: input.project_id,
          phase_id: input.phase_id,
          task_id: input.task_id,
          expected_aggregate_version: task.aggregate_version,
          to: "assigned",
          reason: `designated run ${runId}`,
        });
      } else if (task.state === "in_review" && isReplacement) {
        await transitionV2TaskLifecycle(lifecycle, {
          ...actor,
          project_id: input.project_id,
          phase_id: input.phase_id,
          task_id: input.task_id,
          expected_aggregate_version: task.aggregate_version,
          to: "in_progress",
          reason: `reviewer requested rework in ${runId}`,
        });
      }
      await sql.query(
        "UPDATE agent_assignments SET status = 'active', aggregate_version = aggregate_version + 1, updated_at = now() WHERE id = $1",
        [input.assignment_id],
      );
      await sql.query(
        `INSERT INTO budget_reservations (
           id, project_id, phase_id, task_id, run_id, amount_usd, status, expires_at
         ) VALUES ($1,$2,$3,$4,$5,$6,'active',$7)`,
        [
          reservationId,
          input.project_id,
          input.phase_id,
          input.task_id,
          runId,
          maxCharge,
          input.expires_at,
        ],
      );
      // Carry the project's real build/test/lint commands or its explicit
      // committed-manifest source.
      //
      // Exact commands remain highest precedence. A manifest fact is carried
      // separately so the runner reads the full file at the tested commit and
      // does not silently substitute its built-in hygiene-only default. A
      // greenfield conversation task may fall back to the explicit commands
      // frozen in its human-approved package until the repository commits its
      // own verification policy.
      const verification = await resolveProjectVerificationCommands(sql, input.project_id);
      const packageVerificationCommands = taskPackageDispatch
        ? verificationCommandsFromTaskPackage(taskPackageDispatch.package)
        : [];
      const verificationCommands =
        verification.commands.length > 0 || verification.repository_manifest
          ? verification.commands
          : packageVerificationCommands;
      const command = V2DispatchCommand.parse({
        schema_version: 2,
        protocol_version: 2,
        kind: "launch_run",
        dispatch_job_id: dispatchJobId,
        command_id: commandId,
        delivery_attempt: 1,
        idempotency_key: commandId,
        correlation_id: input.correlation_id,
        causation_id: input.causation_id,
        project_id: input.project_id,
        phase_id: input.phase_id,
        task_id: input.task_id,
        assignment_id: input.assignment_id,
        run_id: runId,
        runner_id: input.runner_id,
        runner_generation: input.runner_generation,
        repository_binding_id: row.repository_binding_id,
        ...(row.repository_binding_type === "local_runner" && row.runner_repository_id
          ? { runner_repository_id: row.runner_repository_id }
          : {}),
        expected_revision: recoveryBaseRevision ?? row.expected_revision,
        target_branch: input.target_branch,
        // EXEC-INTEGRATE-1: a local runner integrates a verified run into the
        // binding's default branch directly (no PR review path), so the next
        // phase branches from it. GitHub-Actions bindings integrate through a
        // pull request instead, so the field stays absent for them.
        ...(row.repository_binding_type === "local_runner" && row.repository_default_branch
          ? { integrate_base_branch: row.repository_default_branch }
          : {}),
        worktree_policy_ref: input.worktree_policy_ref,
        // EXECUTION E10 (E9-9) — dispatch a runtime the runner can construct.
        // `agent_profiles.runtime` has historically been written as the
        // PROVIDER name by the planning bridge, which is not a key in the
        // runner's runtime map; such a run failed before doing any work. Real
        // runtime names pass through untouched.
        runtime: resolveDispatchRuntime(row.runtime, row.provider),
        provider: row.provider,
        model: row.model,
        credential_mode: row.credential_mode,
        // Clamp a legacy `minimal` effort (a valid enum choice, but rejected by
        // every gpt-5.6 model) to a supported level so the model never 400s.
        ...(row.reasoning_effort
          ? { reasoning_effort: reasoningEffortForModel(row.model, row.reasoning_effort) }
          : {}),
        context_refs: contextRefs,
        input_files: input.input_files ?? [],
        ...(taskPackageDispatch
          ? {
              task_package_id: taskPackageDispatch.id,
              task_package_content_hash: taskPackageDispatch.contentHash,
              task_package_context_ref: taskPackageDispatch.contextRef,
              task_package_supplements: taskPackageSupplements,
            }
          : {}),
        human_wait_channel: {
          version: V2_HUMAN_WAIT_CHANNEL_VERSION,
          instruction_hash: V2_HUMAN_WAIT_INSTRUCTION_HASH,
        },
        ...(recovery ? { recovery } : {}),
        budget_reservation_id: reservationId,
        max_charge_usd: maxCharge,
        max_input_tokens: input.max_input_tokens,
        max_output_tokens: input.max_output_tokens,
        max_duration_seconds: input.max_duration_seconds,
        ...(input.max_turns !== undefined ? { max_turns: input.max_turns } : {}),
        execution_mode: row.execution_mode,
        verification_policy_ref: row.verification_policy_ref,
        ...(verificationCommands.length > 0 ? { verification_commands: verificationCommands } : {}),
        ...(verification.repository_manifest
          ? { repository_verification_manifest: ".norns/verification.json" as const }
          : {}),
        sandbox_policy_ref: input.sandbox_policy_ref,
        authorized_by: input.authorized_by,
        authorized_by_session_id: input.authorized_by_session_id,
        issued_at: input.issued_at,
        expires_at: input.expires_at,
      });
      await sql.query(
        `INSERT INTO commands (
           command_id, dispatch_job_id, project_id, phase_id, task_id, run_id,
           runner_id, runner_generation, kind, envelope, status, correlation_id,
           causation_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'launch_run',$9::jsonb,'queued',$10,$11)`,
        [
          commandId,
          dispatchJobId,
          input.project_id,
          input.phase_id,
          input.task_id,
          runId,
          input.runner_id,
          input.runner_generation,
          JSON.stringify(command),
          input.correlation_id,
          input.causation_id,
        ],
      );
      for (const supplement of taskPackageSupplements) {
        await sql.query(
          `INSERT INTO conversation_task_package_supplement_dispatch_receipts (
             command_id,run_id,supplement_id,project_id,phase_id,task_id,
             base_package_id,ordinal,content_hash,context_document_id,context_ref
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
          [
            commandId,
            runId,
            supplement.supplement_id,
            input.project_id,
            input.phase_id,
            input.task_id,
            supplement.base_package_id,
            supplement.ordinal,
            supplement.content_hash,
            supplement.context_ref.artifact_id,
            JSON.stringify(supplement.context_ref),
          ],
        );
      }
      await sql.query(
        `INSERT INTO dispatch_jobs (
           id, project_id, phase_id, task_id, run_id, command_id, runner_id, status
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          dispatchJobId,
          input.project_id,
          input.phase_id,
          input.task_id,
          runId,
          commandId,
          input.runner_id,
          input.awaiting_runner_enrollment ? "awaiting_enrollment" : "queued",
        ],
      );
      const steeringContexts = (
        await sql.query<{
          action_id: string;
          project_id: string;
          work_item_id: string;
          conversation_id: string;
          action_status: string;
          intent_id: string;
        }>(
          `SELECT checkpoint.action_id,checkpoint.project_id,checkpoint.work_item_id,
                  checkpoint.conversation_id,action.status AS action_status,
                  intent.id AS intent_id
             FROM conversation_action_checkpoint_contexts checkpoint
             JOIN conversation_actions action ON action.id=checkpoint.action_id
             JOIN conversation_action_delivery_intents intent
               ON intent.action_id=checkpoint.action_id
            WHERE checkpoint.task_id=$1 AND checkpoint.status='prepared'
              AND checkpoint.context_document_id=ANY($2::text[])
              AND checkpoint.context_hash=ANY($3::text[])
            ORDER BY action.confirmed_at,action.id
            FOR UPDATE OF checkpoint,action,intent`,
          [
            input.task_id,
            contextRefs.map((reference) => reference.artifact_id),
            contextRefs.map((reference) => reference.content_hash),
          ],
        )
      ).rows;
      for (const steering of steeringContexts) {
        const leased = await sql.query<{ id: string }>(
          `UPDATE conversation_action_delivery_intents
              SET status='leased',lease_owner='phase4-context-dispatch',
                  lease_expires_at=now()+interval '30 seconds',attempts=attempts+1,
                  updated_at=now()
            WHERE id=$1 AND status='fallback_queued' RETURNING id`,
          [steering.intent_id],
        );
        if (!leased.rows[0]) {
          throw new Phase4CoordinatorConflictError(
            `queued direction ${steering.action_id} lost its checkpoint lease`,
          );
        }
        await sql.query(
          `UPDATE conversation_action_delivery_intents
              SET status='sent',target_command_id=$2,target_runner_generation=$3,
                  lease_owner=NULL,lease_expires_at=NULL,last_error=NULL,updated_at=now()
            WHERE id=$1 AND status='leased'`,
          [steering.intent_id, commandId, input.runner_generation],
        );
        if (steering.action_status === "recorded") {
          const sent = await sql.query<{ id: string }>(
            `UPDATE conversation_actions SET status='sent',sent_at=now(),updated_at=now()
              WHERE id=$1 AND status='recorded' RETURNING id`,
            [steering.action_id],
          );
          if (!sent.rows[0]) {
            throw new Phase4CoordinatorConflictError(
              `queued direction ${steering.action_id} lost its recorded state`,
            );
          }
        }
        await sql.query(
          `UPDATE conversation_action_checkpoint_contexts
              SET status='sent',command_id=$2,sent_at=now()
            WHERE action_id=$1 AND status='prepared'`,
          [steering.action_id, commandId],
        );
        await sql.query(
          `INSERT INTO conversation_action_delivery_events (
             id,project_id,work_item_id,conversation_id,action_id,sequence,status,
             delivery_mode,target_run_id,target_command_id,receipt
           ) SELECT $1,$2,$3,$4,$5,COALESCE(max(sequence),0)+1,'sent','checkpoint',
                    $6,$7,$8::jsonb
               FROM conversation_action_delivery_events WHERE action_id=$5`,
          [
            `action-delivery-event:${steering.action_id}:checkpoint:${commandId}`,
            steering.project_id,
            steering.work_item_id,
            steering.conversation_id,
            steering.action_id,
            runId,
            commandId,
            JSON.stringify({ kind: "sent", outbox_id: commandId }),
          ],
        );
      }
      await sql.query(
        `UPDATE phases SET status = 'active', started_at = COALESCE(started_at, $2),
                           aggregate_version = aggregate_version + 1, updated_at = now()
         WHERE id = $1`,
        [input.phase_id, input.issued_at],
      );
      return {
        run_id: runId,
        dispatch_job_id: dispatchJobId,
        command_id: commandId,
        budget_reservation_id: reservationId,
        command,
        rejected_verification_commands: verification.rejected,
      };
    });
  }
}
