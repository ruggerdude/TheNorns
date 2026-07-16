import { V2ProjectResume, type V2ProjectResumeT } from "@norns/contracts";
import type { V2TransactionRunner } from "../persistence/v2/database.js";

export class ProjectResumeNotFoundError extends Error {
  constructor(readonly projectId: string) {
    super(`project ${projectId} not found`);
    this.name = "ProjectResumeNotFoundError";
  }
}

function nextAction(input: {
  repositories: number;
  architecture: boolean;
  phases: Array<{ status: string }>;
  openDecisions: number;
  activeRuns: number;
  blockedTasks: number;
}): string {
  if (input.openDecisions > 0) return "Review open decision points";
  if (input.blockedTasks > 0) return "Resolve blocked project work";
  if (input.repositories === 0) return "Connect a project repository";
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

  open(projectId: string): Promise<V2ProjectResumeT> {
    return this.transactions.transaction(async (tx) => {
      const projects = await tx.query<{
        id: string;
        name: string;
        description: string;
        status: string;
        aggregate_version: number;
        current_architecture_revision_id: string | null;
      }>(
        `SELECT id, name, description, status, aggregate_version,
                current_architecture_revision_id
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
         FROM repository_bindings WHERE project_id = $1 ORDER BY created_at, id`,
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
      const metrics = attention.rows[0] ?? {
        open_decisions: 0,
        active_runs: 0,
        blocked_tasks: 0,
        active_memory_entries: 0,
      };
      return V2ProjectResume.parse({
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
          display_name: repository.repository_display_name,
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
          architecture: architectures.rows.length > 0,
          phases: phases.rows,
          openDecisions: metrics.open_decisions,
          activeRuns: metrics.active_runs,
          blockedTasks: metrics.blocked_tasks,
        }),
      });
    });
  }
}
