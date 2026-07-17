import {
  type V2ActorT,
  V2ContentAddressedReference,
  type V2ContentAddressedReferenceT,
  V2DispatchCommand,
  type V2DispatchCommandT,
  v2CommandIdForDispatchJob,
} from "@norns/contracts";
import type { V2TransactionRunner } from "../persistence/v2/database.js";
import { transitionV2TaskLifecycle } from "../persistence/v2/lifecycleMutation.js";
import { SqlV2ApplicationTransaction } from "../persistence/v2/sqlRepositories.js";

export class Phase4CoordinatorConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Phase4CoordinatorConflictError";
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
  target_branch: string;
  worktree_policy_ref: string;
  sandbox_policy_ref: string;
  max_input_tokens: number;
  max_output_tokens: number;
  max_duration_seconds: number;
  issued_at: string;
  expires_at: string;
  /** Required when reviewer rework supersedes the currently designated run. */
  supersedes_run_id?: string | null;
}

export interface Phase4ScheduledRun {
  run_id: string;
  dispatch_job_id: string;
  command_id: string;
  budget_reservation_id: string;
  command: V2DispatchCommandT;
}

interface SchedulingRow {
  task_state: string;
  task_aggregate_version: number;
  task_title: string;
  verification_policy_ref: string;
  phase_status: string;
  approved_budget_usd: string | number;
  assignment_status: string;
  budget_limit_usd: string | number;
  agent_profile_id: string;
  provider: string;
  runtime: string;
  model: string;
  repository_binding_id: string;
  expected_revision: string | null;
  max_concurrent_tasks: number;
  max_concurrent_runs: number;
  active_workload: number;
}

function runIdentity(taskId: string, attempt: number): string {
  return `run:${encodeURIComponent(taskId)}:${attempt}`;
}

export class Phase4Coordinator {
  constructor(private readonly transactions: V2TransactionRunner) {}

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
                t.title AS task_title, t.verification_policy_ref,
                p.status AS phase_status, p.approved_budget_usd,
                a.status AS assignment_status, a.budget_limit_usd, a.agent_profile_id,
                profile.provider, profile.runtime, profile.model,
                project.primary_repository_binding_id AS repository_binding_id,
                project.max_concurrent_tasks, profile.max_concurrent_runs,
                profile.active_workload,
                binding.observed_head AS expected_revision
         FROM tasks t
         JOIN phases p ON p.id = t.phase_id AND p.project_id = t.project_id
         JOIN projects project ON project.id = t.project_id
         JOIN agent_assignments a ON a.id = $4 AND a.task_id = t.id
         JOIN agent_profiles profile ON profile.id = a.agent_profile_id
         JOIN repository_bindings binding
           ON binding.id = project.primary_repository_binding_id
          AND binding.project_id = project.id AND binding.status = 'connected'
         WHERE t.project_id = $1 AND t.phase_id = $2 AND t.id = $3
         FOR UPDATE OF t, p, a`,
        [input.project_id, input.phase_id, input.task_id, input.assignment_id],
      );
      const row = rows.rows[0];
      if (!row) throw new Phase4CoordinatorConflictError("task scheduling scope is unavailable");
      if (!input.authorized_by.actor_id) {
        throw new Phase4CoordinatorConflictError("dispatch authorization must be attributable");
      }
      if (!row.expected_revision) {
        throw new Phase4CoordinatorConflictError("repository binding has no verified revision");
      }
      if (!["approved", "active"].includes(row.phase_status)) {
        throw new Phase4CoordinatorConflictError("phase is not approved for execution");
      }
      const isRework = input.supersedes_run_id !== undefined && input.supersedes_run_id !== null;
      if (
        !["pending", "ready"].includes(row.task_state) &&
        !(isRework && row.task_state === "in_review")
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
      if (capacity.project_count >= row.max_concurrent_tasks) {
        throw new Phase4CoordinatorConflictError("project concurrency capacity is exhausted");
      }
      if (capacity.profile_count >= row.max_concurrent_runs) {
        throw new Phase4CoordinatorConflictError("agent profile concurrency capacity is exhausted");
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
        throw new Phase4CoordinatorConflictError("task conflicts with active repository scope");
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
      const maxCharge = Number(row.budget_limit_usd);
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
      if (isRework) {
        const prior = await sql.query<{ id: string }>(
          `SELECT id FROM agent_runs
           WHERE id=$1 AND task_id=$2 AND is_designated=true AND state='succeeded'
           FOR UPDATE`,
          [input.supersedes_run_id, input.task_id],
        );
        if (!prior.rows[0]) {
          throw new Phase4CoordinatorConflictError(
            "rework must supersede the designated green run",
          );
        }
      }
      await sql.query(
        `INSERT INTO agent_runs (
           id, project_id, phase_id, task_id, assignment_id, attempt, state,
           is_designated, runner_id, repository_binding_id, expected_revision,
           verification_status, lifecycle_version, aggregate_version
         ) VALUES ($1,$2,$3,$4,$5,$6,'created',$10,$7,$8,$9,'pending',0,1)`,
        [
          runId,
          input.project_id,
          input.phase_id,
          input.task_id,
          input.assignment_id,
          attempt,
          input.runner_id,
          row.repository_binding_id,
          row.expected_revision,
          !isRework,
        ],
      );
      if (isRework) {
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
      } else if (task.state === "in_review" && isRework) {
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
        expected_revision: row.expected_revision,
        target_branch: input.target_branch,
        worktree_policy_ref: input.worktree_policy_ref,
        runtime: row.runtime,
        provider: row.provider,
        model: row.model,
        context_refs: contextRefs,
        budget_reservation_id: reservationId,
        max_charge_usd: maxCharge,
        max_input_tokens: input.max_input_tokens,
        max_output_tokens: input.max_output_tokens,
        max_duration_seconds: input.max_duration_seconds,
        verification_policy_ref: row.verification_policy_ref,
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
      await sql.query(
        `INSERT INTO dispatch_jobs (
           id, project_id, phase_id, task_id, run_id, command_id, runner_id, status
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,'queued')`,
        [
          dispatchJobId,
          input.project_id,
          input.phase_id,
          input.task_id,
          runId,
          commandId,
          input.runner_id,
        ],
      );
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
      };
    });
  }
}
