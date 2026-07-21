// EXECUTION E2: the missing caller.
//
// The EXECUTION audit found two of Norns's five reasons nothing ever ran:
// nothing triggers work, and phases never reach `active`. Both trace to the
// same gap -- `Phase4Coordinator.schedule()` (and its Actions-hosted sibling,
// `ActionsExecutionCoordinator.schedule()`) existed, gated dispatch correctly,
// and set `phases.status = 'active'` on success, but no file in this codebase
// ever called either of them. Approving a strategy materialized tasks and
// stopped there.
//
// `PhaseLaunchService` is that caller. Given an approved (or already active)
// phase, it finds the tasks whose dependencies are already satisfied,
// assembles each one's agent context through EXECUTION E1's assembler, and
// schedules it through the EXISTING coordinator gate -- local-runner projects
// via `Phase4Coordinator.schedule()` directly, GitHub-Actions-hosted projects
// via `ActionsExecutionCoordinator.schedule()`, which itself calls straight
// through to the same gate. Neither path bypasses or weakens it: every check
// below only ever REFUSES work the gate would also refuse, earlier and with a
// clearer reason.
import type { V2ActorT, V2ContentAddressedReferenceT } from "@norns/contracts";
import { type TaskContextAssembler, TaskContextAssemblyError } from "../execution/index.js";
import type { V2TransactionRunner } from "../persistence/v2/database.js";
import {
  type ActionsExecutionCoordinator,
  ActionsExecutionError,
  type ActionsExecutionRepository,
} from "./actionsExecution.js";
import { DispatchContextScopeRepository } from "./dispatchContextScope.js";
import {
  Phase4Coordinator,
  Phase4CoordinatorConflictError,
  type Phase4ScheduleInput,
  type Phase4ScheduledRun,
} from "./phase4Coordinator.js";

/** Everything the caller must show the human when a phase cannot be started
 *  at all -- as opposed to one task within it being individually blocked. */
export type PhaseLaunchBlockingCode =
  | "phase_not_ready"
  | "no_execution_binding"
  | "installation_not_ready"
  | "unverified_binding"
  | "actions_execution_unavailable"
  | "no_schedulable_tasks"
  | "budget_exhausted";

export class PhaseLaunchError extends Error {
  constructor(
    readonly code: PhaseLaunchBlockingCode,
    message: string,
    readonly action_required: string | null = null,
  ) {
    super(message);
    this.name = "PhaseLaunchError";
  }
}

export interface PhaseLaunchTaskOutcome {
  task_id: string;
  task_title: string;
  outcome: "scheduled" | "blocked";
  run_id?: string;
  dispatch_job_id?: string;
  /**
   * A specific, actionable code -- either a `TaskContextAssemblyCode` from
   * EXECUTION E1 (surfaced verbatim, never swallowed into a generic bucket),
   * an `ActionsExecutionError` code, or one of this module's own scheduling
   * codes below.
   */
  blocked_code?: string;
  blocked_reason?: string;
}

export interface PhaseLaunchResult {
  phase_id: string;
  scheduled: PhaseLaunchTaskOutcome[];
  blocked: PhaseLaunchTaskOutcome[];
}

export interface PhaseLaunchReadiness {
  ready: boolean;
  schedulable_task_count: number;
  blocking_code: PhaseLaunchBlockingCode | string | null;
  blocking_reason: string | null;
}

export interface PhaseLaunchExecutionPolicy {
  worktreePolicyRef: string;
  sandboxPolicyRef: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxDurationSeconds: number;
  commandTtlMs: number;
  targetBranch: (taskId: string) => string;
}

/**
 * Placeholder execution-policy defaults for the AUTOMATED start-phase path.
 * The manual `/schedule` and `/schedule-actions` routes still let a human
 * supply every one of these per call; this is what the automated trigger uses
 * when nobody is choosing them by hand. Deliberately simple and documented
 * here as exactly that -- a policy default, not a discovered fact -- so a
 * later phase can replace it with something derived from the agent profile or
 * project settings without touching the scheduling logic itself.
 */
export const DEFAULT_PHASE_LAUNCH_POLICY: PhaseLaunchExecutionPolicy = {
  worktreePolicyRef: "policy:worktree:default",
  sandboxPolicyRef: "policy:sandbox:default",
  maxInputTokens: 100_000,
  maxOutputTokens: 8_000,
  maxDurationSeconds: 3_600,
  commandTtlMs: 5 * 60_000,
  targetBranch: (taskId) => `norns/task-${encodeURIComponent(taskId)}`,
};

interface PhaseBindingRow {
  phase_status: string;
  approved_budget_usd: string | number;
  binding_id: string | null;
  binding_type: "local_runner" | "github" | null;
  binding_status: string | null;
  binding_runner_id: string | null;
  installation_ready: boolean | null;
}

interface SchedulableTaskRow {
  task_id: string;
  task_title: string;
  assignment_id: string;
  budget_limit_usd: string | number;
}

function numeric(value: string | number): number {
  return typeof value === "number" ? value : Number(value);
}

export interface ResolvedLocalRunner {
  runner_id: string;
  runner_generation: number;
}

export interface PhaseLaunchActionsDeps {
  coordinator: ActionsExecutionCoordinator;
  repository: ActionsExecutionRepository;
}

export class PhaseLaunchService {
  private readonly policy: PhaseLaunchExecutionPolicy;

  constructor(
    private readonly transactions: V2TransactionRunner,
    private readonly coordinator: Phase4Coordinator,
    private readonly taskContext: TaskContextAssembler,
    private readonly dispatchScope: DispatchContextScopeRepository,
    /** Looks up a local runner's CURRENT relay identity (generation), the
     *  same one `/api/v2/.../schedule` expects a human caller to supply.
     *  Returns null for an unknown/never-paired runner. */
    private readonly resolveLocalRunner: (runnerId: string) => ResolvedLocalRunner | null,
    private readonly actionsExecution?: PhaseLaunchActionsDeps,
    policy: PhaseLaunchExecutionPolicy = DEFAULT_PHASE_LAUNCH_POLICY,
  ) {
    this.policy = policy;
  }

  private async loadPhaseBinding(projectId: string, phaseId: string): Promise<PhaseBindingRow> {
    return this.transactions.transaction(async (tx) => {
      const result = await tx.query<PhaseBindingRow>(
        `SELECT p.status AS phase_status, p.approved_budget_usd AS approved_budget_usd,
                proj.primary_repository_binding_id AS binding_id,
                binding.binding_type AS binding_type,
                binding.status AS binding_status,
                binding.runner_id AS binding_runner_id,
                binding.installation_ready AS installation_ready
           FROM phases p
           JOIN projects proj ON proj.id = p.project_id
           LEFT JOIN repository_bindings binding
             ON binding.id = proj.primary_repository_binding_id
            AND binding.project_id = proj.id
          WHERE p.id = $2 AND p.project_id = $1`,
        [projectId, phaseId],
      );
      const row = result.rows[0];
      if (!row) {
        throw new PhaseLaunchError("phase_not_ready", `phase ${phaseId} does not exist`);
      }
      return row;
    });
  }

  /** Global preconditions that block the WHOLE phase, before any per-task
   *  work is attempted. Every one of these is a condition the coordinator
   *  gate(s) would also refuse on -- checked here first only so the human
   *  gets a specific reason instead of a generic scheduling conflict. */
  private assertLaunchable(row: PhaseBindingRow): void {
    if (!["approved", "active"].includes(row.phase_status)) {
      throw new PhaseLaunchError(
        "phase_not_ready",
        `phase is ${row.phase_status}, not approved for execution`,
        "Approve a strategy version for this phase before starting it.",
      );
    }
    if (!row.binding_id || !row.binding_type) {
      throw new PhaseLaunchError(
        "no_execution_binding",
        "this project has no execution binding (no local runner workspace and no GitHub repository).",
        "Connect a runner workspace or a GitHub repository for this project.",
      );
    }
    if (row.binding_type === "github" && row.installation_ready === false) {
      throw new PhaseLaunchError(
        "installation_not_ready",
        "the GitHub App installation does not include this project's repository yet.",
        "Grant the Norns GitHub App installation access to this repository.",
      );
    }
    if (row.binding_status !== "connected") {
      throw new PhaseLaunchError(
        "unverified_binding",
        `the project's execution binding is ${row.binding_status ?? "unknown"}, not connected.`,
        "Connect and verify a runner workspace (or GitHub repository) for this project.",
      );
    }
    if (row.binding_type === "github" && !this.actionsExecution) {
      throw new PhaseLaunchError(
        "actions_execution_unavailable",
        "this project executes through GitHub Actions, but Actions-hosted execution is not configured on this server.",
        "Ask an operator to configure GitHub Actions execution for this deployment.",
      );
    }
  }

  private async schedulableTasks(
    projectId: string,
    phaseId: string,
  ): Promise<SchedulableTaskRow[]> {
    return this.transactions.transaction(async (tx) => {
      const result = await tx.query<SchedulableTaskRow>(
        `SELECT t.id AS task_id, t.title AS task_title,
                t.designated_assignment_id AS assignment_id,
                a.budget_limit_usd AS budget_limit_usd
           FROM tasks t
           JOIN agent_assignments a ON a.id = t.designated_assignment_id
          WHERE t.project_id = $1 AND t.phase_id = $2
            AND t.state IN ('pending', 'ready')
            AND t.designated_assignment_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM task_dependencies d
              JOIN tasks pred ON pred.id = d.predecessor_task_id
             WHERE d.successor_task_id = t.id AND pred.state <> 'completed'
            )
          ORDER BY t.created_at ASC, t.id ASC`,
        [projectId, phaseId],
      );
      return result.rows;
    });
  }

  private async budgetHeadroomUsd(phaseId: string): Promise<number> {
    return this.transactions.transaction(async (tx) => {
      const result = await tx.query<{ amount: string | number }>(
        `SELECT COALESCE(sum(amount_usd), 0) AS amount FROM budget_reservations
          WHERE phase_id = $1 AND status IN ('active', 'retained_ambiguous')`,
        [phaseId],
      );
      return numeric(result.rows[0]?.amount ?? 0);
    });
  }

  /**
   * Read-only preflight for the UI trigger. Never schedules anything, never
   * mutates state (aside from EXECUTION E1's ordinary content-addressed
   * writes when it dry-runs context assembly) -- so it can back a disabled
   * button honestly without side effects a human didn't ask for.
   */
  async readiness(input: {
    project_id: string;
    phase_id: string;
  }): Promise<PhaseLaunchReadiness> {
    let row: PhaseBindingRow;
    try {
      row = await this.loadPhaseBinding(input.project_id, input.phase_id);
      this.assertLaunchable(row);
    } catch (error) {
      if (error instanceof PhaseLaunchError) {
        return {
          ready: false,
          schedulable_task_count: 0,
          blocking_code: error.code,
          blocking_reason: error.action_required
            ? `${error.message} ${error.action_required}`
            : error.message,
        };
      }
      throw error;
    }

    const tasks = await this.schedulableTasks(input.project_id, input.phase_id);
    if (tasks.length === 0) {
      return {
        ready: false,
        schedulable_task_count: 0,
        blocking_code: "no_schedulable_tasks",
        blocking_reason: "no dependency-ready tasks remain to schedule right now.",
      };
    }

    const phaseBudget = numeric(row.approved_budget_usd);
    const reserved = await this.budgetHeadroomUsd(input.phase_id);
    const cheapest = Math.min(...tasks.map((task) => numeric(task.budget_limit_usd)));
    if (reserved + cheapest > phaseBudget) {
      return {
        ready: false,
        schedulable_task_count: tasks.length,
        blocking_code: "budget_exhausted",
        blocking_reason: `the approved phase budget ($${phaseBudget.toFixed(2)}) has no room left for another task (already reserved $${reserved.toFixed(2)}).`,
      };
    }

    const firstTask = tasks[0];
    if (firstTask) {
      try {
        await this.taskContext.assembleForTask(firstTask.task_id);
      } catch (error) {
        if (error instanceof TaskContextAssemblyError) {
          return {
            ready: false,
            schedulable_task_count: tasks.length,
            blocking_code: error.code,
            blocking_reason: `${error.message} ${error.action_required}`,
          };
        }
        throw error;
      }
    }

    return {
      ready: true,
      schedulable_task_count: tasks.length,
      blocking_code: null,
      blocking_reason: null,
    };
  }

  /**
   * Schedule every currently dependency-ready task in this phase. Idempotent
   * to call repeatedly (e.g. after each task completion unblocks its
   * successors): tasks already assigned/in-progress/completed are simply not
   * in the candidate set, and calling this with nothing schedulable is a
   * no-op that returns an empty result, not an error.
   */
  async startPhase(input: {
    project_id: string;
    phase_id: string;
    authorized_by: V2ActorT;
    authorized_by_session_id: string;
    issued_at: string;
  }): Promise<PhaseLaunchResult> {
    const row = await this.loadPhaseBinding(input.project_id, input.phase_id);
    this.assertLaunchable(row);

    const tasks = await this.schedulableTasks(input.project_id, input.phase_id);
    const scheduled: PhaseLaunchTaskOutcome[] = [];
    const blocked: PhaseLaunchTaskOutcome[] = [];
    const expiresAt = new Date(
      Date.parse(input.issued_at) + this.policy.commandTtlMs,
    ).toISOString();

    for (const task of tasks) {
      let contextRefs: V2ContentAddressedReferenceT[];
      try {
        contextRefs = await this.taskContext.assembleForTask(task.task_id);
      } catch (error) {
        if (error instanceof TaskContextAssemblyError) {
          blocked.push({
            task_id: task.task_id,
            task_title: task.task_title,
            outcome: "blocked",
            blocked_code: error.code,
            blocked_reason: `${error.message} ${error.action_required}`,
          });
          continue;
        }
        throw error;
      }

      const scheduleInput: Omit<Phase4ScheduleInput, "runner_id" | "runner_generation"> = {
        project_id: input.project_id,
        phase_id: input.phase_id,
        task_id: task.task_id,
        assignment_id: task.assignment_id,
        authorized_by: input.authorized_by,
        authorized_by_session_id: input.authorized_by_session_id,
        correlation_id: `correlation:${task.task_id}:${input.issued_at}`,
        causation_id: null,
        context_refs: contextRefs,
        target_branch: this.policy.targetBranch(task.task_id),
        worktree_policy_ref: this.policy.worktreePolicyRef,
        sandbox_policy_ref: this.policy.sandboxPolicyRef,
        max_input_tokens: this.policy.maxInputTokens,
        max_output_tokens: this.policy.maxOutputTokens,
        max_duration_seconds: this.policy.maxDurationSeconds,
        issued_at: input.issued_at,
        expires_at: expiresAt,
      };

      try {
        let result: Phase4ScheduledRun;
        let runnerId: string;
        if (row.binding_type === "github") {
          // The base gate is called unchanged, inside
          // ActionsExecutionCoordinator.schedule() -- see that file's header.
          const withActions = await this.mustActionsExecution().coordinator.schedule(scheduleInput);
          result = withActions;
          runnerId = withActions.actions.runner_id;
        } else {
          const resolved = this.resolveLocalRunner(row.binding_runner_id ?? "");
          if (!resolved) {
            blocked.push({
              task_id: task.task_id,
              task_title: task.task_title,
              outcome: "blocked",
              blocked_code: "unverified_binding",
              blocked_reason: `local runner ${row.binding_runner_id ?? "(none)"} has never paired with this relay.`,
            });
            continue;
          }
          result = await this.coordinator.schedule({
            ...scheduleInput,
            runner_id: resolved.runner_id,
            runner_generation: resolved.runner_generation,
          });
          runnerId = resolved.runner_id;
        }

        await this.dispatchScope.recordScope(
          { runnerId, dispatchJobId: result.dispatch_job_id, runId: result.run_id },
          contextRefs,
        );

        scheduled.push({
          task_id: task.task_id,
          task_title: task.task_title,
          outcome: "scheduled",
          run_id: result.run_id,
          dispatch_job_id: result.dispatch_job_id,
        });
      } catch (error) {
        if (error instanceof Phase4CoordinatorConflictError) {
          blocked.push({
            task_id: task.task_id,
            task_title: task.task_title,
            outcome: "blocked",
            blocked_code: classifyConflict(error.message),
            blocked_reason: error.message,
          });
          continue;
        }
        if (error instanceof ActionsExecutionError) {
          blocked.push({
            task_id: task.task_id,
            task_title: task.task_title,
            outcome: "blocked",
            blocked_code: error.code,
            blocked_reason: error.action_required
              ? `${error.message} ${error.action_required}`
              : error.message,
          });
          continue;
        }
        throw error;
      }
    }

    return { phase_id: input.phase_id, scheduled, blocked };
  }

  private mustActionsExecution(): PhaseLaunchActionsDeps {
    if (!this.actionsExecution) {
      throw new PhaseLaunchError(
        "actions_execution_unavailable",
        "Actions-hosted execution is not configured on this server.",
      );
    }
    return this.actionsExecution;
  }
}

/**
 * `Phase4CoordinatorConflictError` carries only a message, by design (it is
 * the gate's file, off limits to this phase's changes). Classified here,
 * outside the gate, purely for the UI's benefit -- the message itself is
 * always shown verbatim too, so misclassification loses labeling, not truth.
 */
function classifyConflict(message: string): string {
  if (/budget/i.test(message)) return "budget_exhausted";
  if (/repository binding/i.test(message)) return "unverified_binding";
  if (/dependencies are not complete/i.test(message)) return "task_dependencies_incomplete";
  if (/not schedulable/i.test(message)) return "task_not_schedulable";
  if (/concurrency capacity/i.test(message)) return "concurrency_exhausted";
  return "schedule_conflict";
}

export { Phase4Coordinator, Phase4CoordinatorConflictError, DispatchContextScopeRepository };
