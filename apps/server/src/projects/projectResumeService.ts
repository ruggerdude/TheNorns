import { V2ProjectResume, type V2ProjectResumeT } from "@norns/contracts";
import { z } from "zod";
import type { V2TransactionRunner } from "../persistence/v2/database.js";
import {
  type AttachmentRow,
  ONBOARDING_ATTACHMENTS_QUERY,
  attachmentView,
  blockerPayload,
  collectBlockers,
  resolveAttachments,
} from "./projectOnboardingService.js";
import { describePushCredential } from "./pushCredentialProvider.js";
import { safeLocalRepositoryDisplayName } from "./repositoryDisplayName.js";

export class ProjectResumeNotFoundError extends Error {
  constructor(readonly projectId: string) {
    super(`project ${projectId} not found`);
    this.name = "ProjectResumeNotFoundError";
  }
}

// ---------------------------------------------------------------------------
// FRONT DOOR P5 (tracking): per-phase / project progress math.
//
// These fields are additive to the `@norns/contracts` V2ProjectResume shape,
// which is a `.strict()` zod object owned by Phase 3 (packages/contracts is
// out of this phase's ownership). Rather than widen that contract, the added
// fields are validated locally with the schemas below and merged onto the
// contract-validated base object in `ProjectResumeService.open`. See the
// deviation note in this phase's report for why.
// ---------------------------------------------------------------------------

/** How many of the most recent samples feed the rolling-window throughput/
 * burn-rate estimate. Small and fixed for MVP predictability; revisit if a
 * real project shows noisy per-task timing. Exported so the phase-scoped
 * read model (attentionService.ts `phase()`) uses the same window. */
export const PROGRESS_WINDOW_SIZE = 5;

export const V2PhaseProgress = z
  .object({
    percent_complete: z.number().int().min(0).max(100),
    tasks_completed: z.number().int().nonnegative(),
    tasks_total: z.number().int().nonnegative(),
    eta_at: z.string().datetime().nullable(),
    burn_rate_usd_per_hour: z.number().nullable(),
  })
  .strict();
export type V2PhaseProgressT = z.infer<typeof V2PhaseProgress>;

export const V2ProjectProgress = z
  .object({
    overall_percent_complete: z.number().int().min(0).max(100),
    blended_eta_at: z.string().datetime().nullable(),
    agents_active: z.number().int().nonnegative(),
    decisions_waiting: z.number().int().nonnegative(),
  })
  .strict();
export type V2ProjectProgressT = z.infer<typeof V2ProjectProgress>;

// ---------------------------------------------------------------------------
// ONBOARDING O2 (read model): every project is GitHub-backed and executes in
// a GitHub Actions job. A project holds two attachments -- a WORKSPACE (where
// execution happens) and a REMOTE (where it pushes) -- which today name the
// same repository but stay distinct in the model.
//
// The payload exposes both, plus anything BLOCKING execution, so the UI can
// say "Runs in github.com/acme/app - Pushes to github.com/acme/app" and, when
// it is not ready, say exactly why instead of failing later at dispatch.
//
// Additive to the `.strict()` V2ProjectResume contract, merged on locally --
// the same pattern FRONT DOOR P5 established above, for the same reason
// (packages/contracts is outside this phase's ownership).
// ---------------------------------------------------------------------------
export const V2OnboardingAttachment = z
  .object({
    id: z.string().min(1),
    /** 'binding' = confirmed; 'candidate' = recorded but not yet confirmed. */
    tier: z.enum(["binding", "candidate"]),
    role: z.enum(["workspace", "remote"]),
    kind: z.enum(["local_runner", "github"]),
    display_name: z.string().min(1),
    status: z.string().min(1),
    verified: z.boolean(),
    default_branch: z.string().nullable(),
    /** Whether the GitHub App installation contains this repository. */
    installation_ready: z.boolean().nullable(),
    /** Whether the Norns Actions workflow file is committed to it. */
    workflow_installed: z.boolean(),
    observed_head: z.string().nullable(),
    github: z.object({ owner: z.string(), name: z.string(), url: z.string() }).strict().nullable(),
    /** Null for attachments that predate GitHub Actions execution. */
    push_credential_strategy: z.literal("actions_github_token").nullable(),
  })
  .strict();
export type V2OnboardingAttachmentT = z.infer<typeof V2OnboardingAttachment>;

export const V2ProjectOnboardingView = z
  .object({
    scenario: z.string().nullable(),
    workspace: V2OnboardingAttachment.nullable(),
    remote: V2OnboardingAttachment.nullable(),
    push: z
      .object({
        strategy: z.literal("actions_github_token"),
        norns_issues_credential: z.literal(false),
        rationale: z.string(),
      })
      .strict(),
    /**
     * Everything standing between this project and a dispatchable Actions
     * run. Empty when it is ready. Surfaced here rather than discovered at
     * dispatch time.
     */
    /** Distinct blocker codes. See OnboardingResult.blockers for why strings. */
    blockers: z.array(z.string()),
    blocker_details: z.array(
      z
        .object({
          code: z.literal("installation_not_ready"),
          role: z.enum(["workspace", "remote"]),
          message: z.string(),
        })
        .strict(),
    ),
    /** Ready-to-render one-liner, e.g. "Runs in github.com/acme/app - Pushes to github.com/acme/app". */
    summary_line: z.string(),
  })
  .strict();
export type V2ProjectOnboardingViewT = z.infer<typeof V2ProjectOnboardingView>;

export type V2ProjectResumeWithTrackingT = Omit<V2ProjectResumeT, "phases"> & {
  phases: Array<V2ProjectResumeT["phases"][number] & V2PhaseProgressT>;
  progress: V2ProjectProgressT;
  update_interval_seconds: number;
  onboarding: V2ProjectOnboardingViewT;
};

/** The human-readable one-liner. Says only what is actually known. */
export function onboardingSummaryLine(input: {
  workspace: V2OnboardingAttachmentT | null;
  remote: V2OnboardingAttachmentT | null;
}): string {
  const where = (attachment: V2OnboardingAttachmentT): string =>
    attachment.github ? attachment.github.url : attachment.display_name;
  if (!input.workspace) return "No repository connected";
  const parts = [`Runs in ${where(input.workspace)}`];
  if (input.remote) parts.push(`Pushes to ${where(input.remote)}`);
  return parts.join(" · ");
}

/** Task-weighted percent complete, guarded against the empty-phase / no-task
 * division by zero (an empty phase is defined as 0% complete, not NaN). */
export function computePercentComplete(tasksCompleted: number, tasksTotal: number): number {
  if (tasksTotal <= 0) return 0;
  const ratio = Math.min(1, Math.max(0, tasksCompleted / tasksTotal));
  return Math.round(ratio * 100);
}

/**
 * Linear-projection ETA from a rolling window of recent task-completion
 * timestamps. Returns null (never a fabricated timestamp) when:
 *  - the phase is not currently executing,
 *  - the phase has no remaining tasks,
 *  - fewer than 2 completions exist in the window (no throughput signal), or
 *  - the window's timestamps do not span any measurable time (rate would be
 *    infinite / undefined).
 */
export function computePhaseEta(input: {
  isExecuting: boolean;
  tasksCompleted: number;
  tasksTotal: number;
  recentCompletionTimestamps: ReadonlyArray<string | Date>;
}): string | null {
  if (!input.isExecuting) return null;
  const remaining = input.tasksTotal - input.tasksCompleted;
  if (remaining <= 0) return null;
  const timestamps = input.recentCompletionTimestamps
    .map((value) => new Date(value).getTime())
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  if (timestamps.length < 2) return null;
  const first = timestamps[0] as number;
  const last = timestamps[timestamps.length - 1] as number;
  const spanMs = last - first;
  if (spanMs <= 0) return null;
  const completionsInWindow = timestamps.length - 1;
  const ratePerMs = completionsInWindow / spanMs;
  if (!Number.isFinite(ratePerMs) || ratePerMs <= 0) return null;
  const projectedMs = last + remaining / ratePerMs;
  if (!Number.isFinite(projectedMs)) return null;
  return new Date(projectedMs).toISOString();
}

/**
 * USD burn rate from a rolling window of recently finished agent runs.
 * Guards against no-signal (no finished runs) and division-by-zero (zero or
 * negative elapsed wall-clock time, e.g. malformed started/finished pairs).
 */
export function computeBurnRateUsdPerHour(
  samples: ReadonlyArray<{
    started_at: string | Date | null;
    finished_at: string | Date | null;
    usage_cost_usd: number | string | null;
  }>,
): number | null {
  let totalCostUsd = 0;
  let totalHours = 0;
  for (const sample of samples) {
    if (!sample.started_at || !sample.finished_at) continue;
    const startedMs = new Date(sample.started_at).getTime();
    const finishedMs = new Date(sample.finished_at).getTime();
    if (!Number.isFinite(startedMs) || !Number.isFinite(finishedMs)) continue;
    if (finishedMs <= startedMs) continue;
    totalHours += (finishedMs - startedMs) / 3_600_000;
    totalCostUsd += Number(sample.usage_cost_usd ?? 0);
  }
  if (totalHours <= 0) return null;
  const rate = totalCostUsd / totalHours;
  return Number.isFinite(rate) ? Math.round(rate * 100) / 100 : null;
}

/** Task-weighted percent complete across all non-cancelled phases (a
 * cancelled phase's scope was withdrawn, so — like an archived project —
 * it should not dilute the aggregate). */
export function computeOverallPercentComplete(
  phases: ReadonlyArray<{ tasksCompleted: number; tasksTotal: number; status: string }>,
): number {
  const totals = phases.reduce(
    (acc, phase) => {
      if (phase.status === "cancelled") return acc;
      return {
        completed: acc.completed + phase.tasksCompleted,
        total: acc.total + phase.tasksTotal,
      };
    },
    { completed: 0, total: 0 },
  );
  return computePercentComplete(totals.completed, totals.total);
}

/** The latest (furthest-out) ETA among phases that have one; null when no
 * phase currently has an ETA signal. */
export function computeBlendedEtaAt(phaseEtas: ReadonlyArray<string | null>): string | null {
  const times = phaseEtas
    .filter((value): value is string => value !== null)
    .map((value) => Date.parse(value))
    .filter((value) => Number.isFinite(value));
  if (times.length === 0) return null;
  return new Date(Math.max(...times)).toISOString();
}

const ALLOWED_UPDATE_INTERVAL_SECONDS = new Set([60, 300, 900]);
const UPDATE_INTERVAL_FLOOR_SECONDS = 60;

export class ProjectSettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectSettingsValidationError";
  }
}

function assertValidUpdateIntervalSeconds(value: number): void {
  if (!Number.isInteger(value) || value < UPDATE_INTERVAL_FLOOR_SECONDS) {
    throw new ProjectSettingsValidationError(
      `update_interval_seconds must be an integer of at least ${UPDATE_INTERVAL_FLOOR_SECONDS} seconds`,
    );
  }
  if (!ALLOWED_UPDATE_INTERVAL_SECONDS.has(value)) {
    throw new ProjectSettingsValidationError(
      `update_interval_seconds must be one of ${[...ALLOWED_UPDATE_INTERVAL_SECONDS].join(", ")}`,
    );
  }
}

function nextAction(input: {
  repositories: number;
  /**
   * ONBOARDING O2: anything blocking a dispatchable Actions run -- most
   * importantly a repository the GitHub App installation does not contain.
   * Ranked just below open decisions and blocked work, because until it is
   * resolved nothing can execute at all.
   */
  onboardingBlockers: ReadonlyArray<{ message: string }>;
  architecture: boolean;
  phases: Array<{ status: string }>;
  openDecisions: number;
  activeRuns: number;
  blockedTasks: number;
}): string {
  if (input.openDecisions > 0) return "Review open decision points";
  if (input.blockedTasks > 0) return "Resolve blocked project work";
  if (input.repositories === 0) return "Connect a project repository";
  const blocker = input.onboardingBlockers[0];
  if (blocker) return `Resolve a setup blocker: ${blocker.message}`;
  if (!input.architecture) return "Analyze the repository and record its architecture";
  if (input.phases.length === 0) return "Create the project's next phase";
  if (input.phases.some((phase) => phase.status === "awaiting_approval")) {
    return "Review and approve the pending phase strategy";
  }
  if (input.activeRuns > 0) return "Monitor active agent work";
  if (input.phases.some((phase) => phase.status === "proposed")) {
    return "Generate a strategy for the proposed phase";
  }
  return "Review project status and choose the next objective";
}

export class ProjectResumeService {
  constructor(private readonly transactions: V2TransactionRunner) {}

  open(projectId: string): Promise<V2ProjectResumeWithTrackingT> {
    return this.transactions.transaction(async (tx) => {
      const projects = await tx.query<{
        id: string;
        name: string;
        description: string;
        status: string;
        aggregate_version: number;
        current_architecture_revision_id: string | null;
        update_interval_seconds: number;
        onboarding_scenario: string | null;
      }>(
        `SELECT id, name, description, status, aggregate_version,
                current_architecture_revision_id, update_interval_seconds,
                onboarding_scenario
         FROM projects WHERE id = $1`,
        [projectId],
      );
      const project = projects.rows[0];
      if (!project) throw new ProjectResumeNotFoundError(projectId);

      const architectures = await tx.query<{
        id: string;
        revision: number;
        title: string;
        summary: string;
        repository_revision: string;
      }>(
        `SELECT id, revision, title, summary, repository_revision
         FROM architecture_revisions WHERE id = $1 AND project_id = $2`,
        [project.current_architecture_revision_id, projectId],
      );
      const repositories = await tx.query<{
        id: string;
        binding_type: "local_runner" | "github";
        repository_display_name: string;
        status: V2ProjectResumeT["repositories"][number]["status"];
        repository_health: V2ProjectResumeT["repositories"][number]["health"];
        observed_head: string | null;
      }>(
        `SELECT id, binding_type, repository_display_name, status,
                repository_health, observed_head
         FROM (
           SELECT id, binding_type, repository_display_name, status,
                  repository_health, observed_head, created_at
           FROM repository_bindings
           WHERE project_id = $1
           UNION ALL
           SELECT candidate.id, 'github'::text AS binding_type,
                  candidate.display_name AS repository_display_name,
                  'unverified_candidate'::text AS status,
                  'unknown'::text AS repository_health,
                  NULL::text AS observed_head, candidate.created_at
           FROM repository_binding_candidates candidate
           WHERE candidate.project_id = $1
             AND candidate.source_type = 'github'
             AND candidate.status <> 'dismissed'
             AND NOT EXISTS (
               SELECT 1 FROM repository_bindings binding
               WHERE binding.project_id = candidate.project_id
                 AND binding.repository_id = candidate.external_repository_id
             )
           -- FRONT DOOR P2b (D2): a folder-first local project created with
           -- no runner online has only this candidate row (no real
           -- repository_bindings row exists yet) until a paired runner
           -- verifies the workspace via the existing
           -- source-bindings/local flow, at which point
           -- SourceBindingService.createLocal marks the candidate
           -- 'promoted' and the NOT EXISTS below stops surfacing it (the
           -- real connected binding above takes its place).
           UNION ALL
           SELECT candidate.id, 'local_runner'::text AS binding_type,
                  candidate.display_name AS repository_display_name,
                  'unverified_candidate'::text AS status,
                  'unknown'::text AS repository_health,
                  NULL::text AS observed_head, candidate.created_at
           FROM repository_binding_candidates candidate
           WHERE candidate.project_id = $1
             AND candidate.source_type = 'local'
             AND candidate.status <> 'dismissed'
             AND NOT EXISTS (
               SELECT 1 FROM repository_bindings binding
               WHERE binding.project_id = candidate.project_id
                 AND binding.binding_type = 'local_runner'
             )
         ) repository
         ORDER BY created_at, id`,
        [projectId],
      );
      const phases = await tx.query<{
        id: string;
        objective_summary: string;
        priority: number;
        status: string;
        approved_strategy_version_id: string | null;
        objectives: number;
        tasks: number;
        completed_tasks: number;
        blocked_tasks: number;
      }>(
        `SELECT p.id, p.objective_summary, p.priority, p.status,
                p.approved_strategy_version_id,
                count(DISTINCT o.id)::int AS objectives,
                count(DISTINCT t.id)::int AS tasks,
                count(DISTINCT t.id) FILTER (WHERE t.state = 'completed')::int AS completed_tasks,
                count(DISTINCT t.id) FILTER (WHERE t.state IN ('blocked','failed'))::int AS blocked_tasks
         FROM phases p
         LEFT JOIN objectives o ON o.project_id = p.project_id AND o.phase_id = p.id
         LEFT JOIN tasks t ON t.project_id = p.project_id AND t.phase_id = p.id
         WHERE p.project_id = $1
         GROUP BY p.id
         ORDER BY p.priority DESC, p.created_at, p.id`,
        [projectId],
      );
      const attention = await tx.query<{
        open_decisions: number;
        active_runs: number;
        blocked_tasks: number;
        active_memory_entries: number;
      }>(
        `SELECT
           (SELECT count(*)::int FROM decision_points
            WHERE project_id = $1 AND status = 'open') AS open_decisions,
           (SELECT count(*)::int FROM agent_runs
            WHERE project_id = $1 AND state IN ('created','dispatched','running','verifying')) AS active_runs,
           (SELECT count(*)::int FROM tasks
            WHERE project_id = $1 AND state IN ('blocked','failed')) AS blocked_tasks,
           (SELECT count(*)::int FROM project_memory_entries
            WHERE project_id = $1 AND status = 'active') AS active_memory_entries`,
        [projectId],
      );
      const recent = await tx.query<{
        task_id: string;
        title: string;
        completed_at: Date | string;
      }>(
        `SELECT id AS task_id, title, completed_at
         FROM tasks WHERE project_id = $1 AND state = 'completed'
         ORDER BY completed_at DESC, id LIMIT 10`,
        [projectId],
      );
      // FRONT DOOR P5 (tracking): the most recent PROGRESS_WINDOW_SIZE task
      // completions per phase, feeding the ETA throughput estimate.
      const recentCompletions = await tx.query<{
        phase_id: string;
        completed_at: Date | string;
      }>(
        `SELECT phase_id, completed_at
         FROM (
           SELECT phase_id, completed_at,
                  row_number() OVER (PARTITION BY phase_id ORDER BY completed_at DESC) AS rn
           FROM tasks
           WHERE project_id = $1 AND state = 'completed'
         ) ranked
         WHERE rn <= $2`,
        [projectId, PROGRESS_WINDOW_SIZE],
      );
      // The most recent PROGRESS_WINDOW_SIZE succeeded runs per phase,
      // feeding the burn-rate estimate (cost / wall-clock time).
      const recentRunCosts = await tx.query<{
        phase_id: string;
        started_at: Date | string | null;
        finished_at: Date | string | null;
        usage_cost_usd: string | number;
      }>(
        `SELECT phase_id, started_at, finished_at, usage_cost_usd
         FROM (
           SELECT phase_id, started_at, finished_at, usage_cost_usd,
                  row_number() OVER (PARTITION BY phase_id ORDER BY finished_at DESC) AS rn
           FROM agent_runs
           WHERE project_id = $1 AND state = 'succeeded'
             AND started_at IS NOT NULL AND finished_at IS NOT NULL
         ) ranked
         WHERE rn <= $2`,
        [projectId, PROGRESS_WINDOW_SIZE],
      );
      // ONBOARDING O2: both attachments, resolved by role across both tiers.
      const attachments = await tx.query<AttachmentRow>(ONBOARDING_ATTACHMENTS_QUERY, [projectId]);
      const resolved = resolveAttachments(attachments.rows);
      const workspaceView = resolved.workspace ? attachmentView(resolved.workspace) : null;
      const remoteView = resolved.remote ? attachmentView(resolved.remote) : null;
      const onboardingBlockers = collectBlockers([workspaceView, remoteView]);

      const metrics = attention.rows[0] ?? {
        open_decisions: 0,
        active_runs: 0,
        blocked_tasks: 0,
        active_memory_entries: 0,
      };

      const completionsByPhase = new Map<string, Array<Date | string>>();
      for (const row of recentCompletions.rows) {
        const current = completionsByPhase.get(row.phase_id) ?? [];
        current.push(row.completed_at);
        completionsByPhase.set(row.phase_id, current);
      }
      const runCostsByPhase = new Map<string, typeof recentRunCosts.rows>();
      for (const row of recentRunCosts.rows) {
        const current = runCostsByPhase.get(row.phase_id) ?? [];
        current.push(row);
        runCostsByPhase.set(row.phase_id, current);
      }

      const baseResume = V2ProjectResume.parse({
        schema_version: 2,
        project: {
          id: project.id,
          name: project.name,
          description: project.description,
          status: project.status,
          aggregate_version: project.aggregate_version,
        },
        architecture: architectures.rows[0] ?? null,
        repositories: repositories.rows.map((repository) => ({
          id: repository.id,
          binding_type: repository.binding_type,
          display_name:
            repository.binding_type === "local_runner"
              ? safeLocalRepositoryDisplayName(repository.repository_display_name)
              : repository.repository_display_name,
          status: repository.status,
          health: repository.repository_health,
          observed_head: repository.observed_head,
        })),
        phases: phases.rows,
        attention: {
          open_decisions: metrics.open_decisions,
          active_runs: metrics.active_runs,
          blocked_tasks: metrics.blocked_tasks,
        },
        active_memory_entries: metrics.active_memory_entries,
        recent_completions: recent.rows.map((task) => ({
          task_id: task.task_id,
          title: task.title,
          completed_at: new Date(task.completed_at).toISOString(),
        })),
        next_recommended_action: nextAction({
          repositories: repositories.rows.length,
          onboardingBlockers,
          architecture: architectures.rows.length > 0,
          phases: phases.rows,
          openDecisions: metrics.open_decisions,
          activeRuns: metrics.active_runs,
          blockedTasks: metrics.blocked_tasks,
        }),
      });

      const phasesWithProgress = baseResume.phases.map((phase) => {
        const isExecuting = phase.status === "active";
        const etaAt = computePhaseEta({
          isExecuting,
          tasksCompleted: phase.completed_tasks,
          tasksTotal: phase.tasks,
          recentCompletionTimestamps: completionsByPhase.get(phase.id) ?? [],
        });
        const progress = V2PhaseProgress.parse({
          percent_complete: computePercentComplete(phase.completed_tasks, phase.tasks),
          tasks_completed: phase.completed_tasks,
          tasks_total: phase.tasks,
          eta_at: etaAt,
          burn_rate_usd_per_hour: computeBurnRateUsdPerHour(runCostsByPhase.get(phase.id) ?? []),
        });
        return { ...phase, ...progress };
      });

      const overallPercentComplete = computeOverallPercentComplete(
        phases.rows.map((phase) => ({
          tasksCompleted: phase.completed_tasks,
          tasksTotal: phase.tasks,
          status: phase.status,
        })),
      );
      const blendedEtaAt = computeBlendedEtaAt(phasesWithProgress.map((phase) => phase.eta_at));
      const progress = V2ProjectProgress.parse({
        overall_percent_complete: overallPercentComplete,
        blended_eta_at: blendedEtaAt,
        agents_active: metrics.active_runs,
        decisions_waiting: metrics.open_decisions,
      });

      const onboarding = V2ProjectOnboardingView.parse({
        scenario: project.onboarding_scenario,
        workspace: workspaceView,
        remote: remoteView,
        push: describePushCredential(),
        ...blockerPayload(onboardingBlockers),
        summary_line: onboardingSummaryLine({
          workspace: workspaceView,
          remote: remoteView,
        }),
      });

      return {
        ...baseResume,
        phases: phasesWithProgress,
        progress,
        update_interval_seconds: project.update_interval_seconds,
        onboarding,
      };
    });
  }

  /**
   * FRONT DOOR P5 (tracking): persists the per-project polling cadence for
   * the resume endpoint. Enforces the allowed-value set and a >=60s floor
   * independently of any request-layer validation (defense in depth).
   */
  async updateSettings(
    projectId: string,
    updateIntervalSeconds: number,
  ): Promise<{ update_interval_seconds: number }> {
    // Awaited via `async` so an invalid value is surfaced as a rejected
    // Promise (not a synchronous throw) — callers can uniformly `await` or
    // `.catch()` this method regardless of which branch fails.
    assertValidUpdateIntervalSeconds(updateIntervalSeconds);
    return this.transactions.transaction(async (tx) => {
      const updated = await tx.query<{ update_interval_seconds: number }>(
        `UPDATE projects SET update_interval_seconds = $2, updated_at = now()
         WHERE id = $1
         RETURNING update_interval_seconds`,
        [projectId, updateIntervalSeconds],
      );
      const row = updated.rows[0];
      if (!row) throw new ProjectResumeNotFoundError(projectId);
      return row;
    });
  }
}
