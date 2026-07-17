import { createHash } from "node:crypto";
import {
  V2AttentionItem,
  type V2AttentionItemT,
  V2PhaseExecution,
  type V2PhaseExecutionT,
  V2PortfolioAttention,
  type V2PortfolioAttentionT,
} from "@norns/contracts";
import type { V2TransactionRunner } from "../persistence/v2/database.js";

interface SourceRow {
  project_id: string;
  project_name: string;
  phase_id: string | null;
  task_id: string | null;
  source_type: V2AttentionItemT["source_type"];
  source_id: string;
  condition_class: string;
  kind: V2AttentionItemT["kind"];
  severity: V2AttentionItemT["severity"];
  title: string;
  summary: string;
  explanation: string;
  recommendation: string;
  tradeoffs: unknown;
  impact: string;
  resumes: string;
  occurred_at: string | Date;
  material: unknown;
}

interface StateRow {
  item_key: string;
  condition_fingerprint: string;
  disposition: "acknowledged" | "snoozed";
  snoozed_until: string | Date | null;
}

function keyOf(
  row: Pick<SourceRow, "project_id" | "source_type" | "source_id" | "condition_class">,
) {
  return ["attention", row.project_id, row.source_type, row.source_id, row.condition_class]
    .map(encodeURIComponent)
    .join(":");
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

const severityRank = { critical: 0, high: 1, normal: 2, low: 3 } as const;

export class AttentionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttentionConflictError";
  }
}

export class AttentionService {
  constructor(private readonly transactions: V2TransactionRunner) {}

  portfolio(
    userId: string,
    options: { includeAcknowledged?: boolean; now?: Date } = {},
  ): Promise<V2PortfolioAttentionT> {
    const now = options.now ?? new Date();
    return this.transactions.transaction(async (sql) => {
      const sources = await sql.query<SourceRow>(
        `SELECT * FROM (
           SELECT p.id AS project_id, p.name AS project_name, d.phase_id, d.task_id,
             'decision_point'::text AS source_type, d.id AS source_id,
             d.reason_class AS condition_class, 'decision'::text AS kind,
             CASE WHEN d.urgency='critical' THEN 'critical' ELSE 'high' END AS severity,
             d.question AS title, d.context AS summary,
             'Human judgment is required before the blocked scope can continue.' AS explanation,
             COALESCE((SELECT option->>'label' FROM jsonb_array_elements(d.options) option
                       WHERE option->>'id'=d.recommendation_option_id LIMIT 1),
                      'Review the available options') AS recommendation,
             d.options AS tradeoffs,
             'The declared blocking scope remains paused.' AS impact,
             'Resolving this decision resumes its blocked scope.' AS resumes,
             d.updated_at AS occurred_at,
             jsonb_build_object('status',d.status,'revision',d.condition_revision,
                                'fingerprint',d.condition_fingerprint) AS material
           FROM decision_points d JOIN projects p ON p.id=d.project_id WHERE d.status='open'
           UNION ALL
           SELECT p.id, p.name, s.phase_id, NULL, 'strategy_version', s.id,
             'strategy_approval', 'approval', 'high',
             'Strategy approval required', s.objective,
             'A converged strategy is ready for human authorization.',
             'Review scope, assignments, budget, and approve when correct',
             jsonb_build_array('Approval materializes canonical execution tasks',
                               'Changes require a new immutable strategy version'),
             'The phase cannot begin execution until approved.',
             'Approval materializes tasks and enables scheduling.', s.updated_at,
             jsonb_build_object('status',s.status,'hash',s.content_hash,'version',s.version)
           FROM strategy_versions s JOIN projects p ON p.id=s.project_id
           WHERE s.status='awaiting_approval'
           UNION ALL
           SELECT p.id, p.name, t.phase_id, t.id, 'task', t.id,
             'task_blocked', 'blocker',
             CASE WHEN t.state='failed' THEN 'critical' ELSE 'high' END,
             t.title, 'Task is ' || t.state || ' and requires intervention',
             'Execution cannot make progress automatically from the current task state.',
             'Inspect the latest run and choose retry, rework, or cancellation',
             jsonb_build_array('Retry may repeat work', 'Rework may change phase scope'),
             'Dependent tasks and phase completion are blocked.',
             'A disposition returns the task to an executable state.', t.updated_at,
             jsonb_build_object('state',t.state,'version',t.aggregate_version)
           FROM tasks t JOIN projects p ON p.id=t.project_id
           WHERE t.state IN ('blocked','failed')
             AND NOT EXISTS (
               SELECT 1 FROM decision_points decision
               WHERE decision.task_id=t.id AND decision.status='open'
             )
             AND NOT EXISTS (
               SELECT 1 FROM agent_runs designated
               WHERE designated.id=t.designated_run_id AND designated.state IN ('failed','expired')
             )
           UNION ALL
           SELECT p.id, p.name, r.phase_id, r.task_id, 'agent_run', r.id,
             CASE WHEN r.state='expired' THEN 'stalled_run' ELSE 'run_failed' END,
             CASE WHEN r.state='expired' THEN 'stalled_run' ELSE 'failed_run' END,
             'high', 'Agent run needs recovery',
             COALESCE(r.failure_detail, 'The run ended without a successful verified result.'),
             'The designated execution attempt did not produce reviewable work.',
             'Review evidence and retry with a fresh fenced run when safe',
             jsonb_build_array('Retry can consume additional budget',
                               'Cancellation leaves the task incomplete'),
             'The assigned task cannot advance to review.',
             'A new designated run resumes task execution.', r.updated_at,
             jsonb_build_object('state',r.state,'attempt',r.attempt,
                                'failure',r.failure_code,'version',r.aggregate_version)
           FROM agent_runs r JOIN projects p ON p.id=r.project_id
           WHERE r.state IN ('failed','expired')
           UNION ALL
           SELECT p.id, p.name, b.phase_id, b.task_id, 'budget_reservation', b.id,
             'ambiguous_budget', 'budget_exception', 'critical',
             'Budget usage requires reconciliation',
             'Execution outcome is ambiguous, so reserved budget remains held.',
             'Automatic release could undercount real provider usage.',
             'Reconcile provider usage before releasing or settling funds',
             jsonb_build_array('Release risks overspend', 'Retain reduces available phase budget'),
             'New work may be prevented by the remaining budget hold.',
             'Reconciliation restores an accurate available budget.', b.updated_at,
             jsonb_build_object('status',b.status,'amount',b.amount_usd,
                                'retained',b.retained_usd,'version',b.version)
           FROM budget_reservations b JOIN projects p ON p.id=b.project_id
           WHERE b.status='retained_ambiguous'
           UNION ALL
           SELECT p.id, p.name, phase.id, NULL, 'phase', phase.id,
             'phase_completed', 'milestone', 'low', 'Phase completed',
             phase.objective_summary,
             'The phase closed with reviewed and integrated evidence.',
             'Review the completion summary or create the next phase',
             jsonb_build_array('No action is required'),
             'Project memory and progress have been updated.',
             'A new phase can begin without reconstructing prior context.', phase.closed_at,
             jsonb_build_object('status',phase.status,'version',phase.aggregate_version,
                                'closed_at',phase.closed_at)
           FROM phases phase JOIN projects p ON p.id=phase.project_id
           WHERE phase.status='completed' AND phase.closed_at >= $1::timestamptz - interval '7 days'
         ) attention_sources`,
        [now.toISOString()],
      );
      const states = await sql.query<StateRow>(
        `SELECT item_key, condition_fingerprint, disposition, snoozed_until
         FROM attention_item_states WHERE user_id=$1`,
        [userId],
      );
      const stateByKey = new Map(states.rows.map((state) => [state.item_key, state]));
      const allItems = sources.rows.map((row) => {
        const { material, ...source } = row;
        const key = keyOf(row);
        const currentFingerprint = fingerprint(material);
        const state = stateByKey.get(key);
        const same = state?.condition_fingerprint === currentFingerprint;
        const acknowledged = Boolean(same && state?.disposition === "acknowledged");
        const snoozedUntil = same && state?.disposition === "snoozed" ? state.snoozed_until : null;
        const tradeoffs = Array.isArray(row.tradeoffs)
          ? row.tradeoffs.map((entry) =>
              typeof entry === "string"
                ? entry
                : `${String((entry as { label?: unknown }).label ?? "Option")}: ${String(
                    (entry as { impact?: unknown }).impact ?? "Review impact",
                  )}`,
            )
          : [];
        return V2AttentionItem.parse({
          ...source,
          key,
          condition_fingerprint: currentFingerprint,
          occurred_at: new Date(row.occurred_at).toISOString(),
          tradeoffs,
          acknowledged,
          snoozed_until: snoozedUntil ? new Date(snoozedUntil).toISOString() : null,
        });
      });
      allItems.sort(
        (left, right) =>
          severityRank[left.severity] - severityRank[right.severity] ||
          Date.parse(right.occurred_at) - Date.parse(left.occurred_at),
      );
      const visibleItems = allItems.filter(
        (item) =>
          options.includeAcknowledged ||
          (!item.acknowledged &&
            (!item.snoozed_until || Date.parse(item.snoozed_until) <= now.getTime())),
      );
      const projectRows = await sql.query<{
        id: string;
        name: string;
        status: string;
        current_phase: string | null;
        completed_tasks: number;
        total_tasks: number;
        active_runs: number;
      }>(
        `SELECT p.id, p.name, p.status,
           (SELECT objective_summary FROM phases ph WHERE ph.project_id=p.id
            AND ph.status IN ('active','approved','awaiting_approval','proposed')
            ORDER BY ph.priority DESC, ph.created_at LIMIT 1) AS current_phase,
           (SELECT count(*)::int FROM tasks t WHERE t.project_id=p.id AND t.state='completed') AS completed_tasks,
           (SELECT count(*)::int FROM tasks t WHERE t.project_id=p.id) AS total_tasks,
           (SELECT count(*)::int FROM agent_runs r WHERE r.project_id=p.id
            AND r.state IN ('created','dispatched','running','verifying')) AS active_runs
         FROM projects p WHERE p.status <> 'archived' ORDER BY p.updated_at DESC, p.id`,
      );
      const projects = projectRows.rows.map((project) => {
        const projectItems = visibleItems.filter((item) => item.project_id === project.id);
        const blocked = projectItems.some((item) => item.severity === "critical");
        const attention = projectItems.length > 0;
        return {
          ...project,
          health: blocked
            ? ("blocked" as const)
            : attention
              ? ("attention" as const)
              : ("healthy" as const),
          attention_count: projectItems.length,
          next_action:
            projectItems[0]?.recommendation ??
            (project.current_phase ? "Monitor the current phase" : "Create the next phase"),
        };
      });
      return V2PortfolioAttention.parse({
        schema_version: 2,
        generated_at: now.toISOString(),
        counts: {
          critical: visibleItems.filter((item) => item.severity === "critical").length,
          high: visibleItems.filter((item) => item.severity === "high").length,
          decisions: visibleItems.filter((item) => item.kind === "decision").length,
          approvals: visibleItems.filter((item) => item.kind === "approval").length,
          blockers: visibleItems.filter((item) => item.kind === "blocker").length,
          active_projects: projects.length,
          active_runs: projects.reduce((sum, project) => sum + project.active_runs, 0),
        },
        items: visibleItems,
        projects,
      });
    });
  }

  async disposition(input: {
    user_id: string;
    item_key: string;
    condition_fingerprint: string;
    disposition: "acknowledged" | "snoozed";
    snoozed_until: string | null;
    now?: Date;
  }): Promise<void> {
    const current = await this.portfolio(input.user_id, {
      includeAcknowledged: true,
      ...(input.now ? { now: input.now } : {}),
    });
    const item = current.items.find((candidate) => candidate.key === input.item_key);
    if (!item || item.condition_fingerprint !== input.condition_fingerprint) {
      throw new AttentionConflictError("attention condition changed; refresh before disposition");
    }
    if ((input.disposition === "snoozed") !== (input.snoozed_until !== null)) {
      throw new AttentionConflictError("snoozed disposition requires snoozed_until");
    }
    await this.transactions.transaction(async (sql) => {
      await sql.query(
        `INSERT INTO attention_item_states (
           user_id, item_key, project_id, source_type, source_id, condition_class,
           condition_fingerprint, disposition, snoozed_until, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (user_id,item_key) DO UPDATE SET
           condition_fingerprint=EXCLUDED.condition_fingerprint,
           disposition=EXCLUDED.disposition, snoozed_until=EXCLUDED.snoozed_until,
           updated_at=EXCLUDED.updated_at`,
        [
          input.user_id,
          item.key,
          item.project_id,
          item.source_type,
          item.source_id,
          item.condition_class,
          item.condition_fingerprint,
          input.disposition,
          input.snoozed_until,
          (input.now ?? new Date()).toISOString(),
        ],
      );
    });
  }

  phase(projectId: string, phaseId: string): Promise<V2PhaseExecutionT> {
    return this.transactions.transaction(async (sql) => {
      const phase = await sql.query<{
        id: string;
        objective_summary: string;
        status: string;
        completed_tasks: number;
        total_tasks: number;
      }>(
        `SELECT p.id, p.objective_summary, p.status,
          count(t.id) FILTER (WHERE t.state='completed')::int AS completed_tasks,
          count(t.id)::int AS total_tasks
         FROM phases p LEFT JOIN tasks t ON t.phase_id=p.id
         WHERE p.id=$1 AND p.project_id=$2 GROUP BY p.id`,
        [phaseId, projectId],
      );
      if (!phase.rows[0]) throw new AttentionConflictError("phase not found");
      const tasks = await sql.query<{
        id: string;
        title: string;
        state: string;
        complexity: string;
        risk: string;
        dependencies: string[];
        provider: string | null;
        model: string | null;
        assignment_status: string | null;
        run_id: string | null;
        run_state: string | null;
        attempt: number | null;
        verification_status: string | null;
        commit_sha: string | null;
        failure_detail: string | null;
        evidence_count: number;
      }>(
        `SELECT t.id, t.title, t.state, t.complexity, t.risk,
          COALESCE((SELECT jsonb_agg(d.predecessor_task_id ORDER BY d.predecessor_task_id)
                    FROM task_dependencies d WHERE d.successor_task_id=t.id),'[]'::jsonb) AS dependencies,
          profile.provider, profile.model, assignment.status AS assignment_status,
          run.id AS run_id, run.state AS run_state, run.attempt, run.verification_status,
          run.commit_sha, run.failure_detail,
          (SELECT count(*)::int FROM verification_results verification
           WHERE verification.task_id=t.id) AS evidence_count
         FROM tasks t
         LEFT JOIN agent_assignments assignment ON assignment.id=t.designated_assignment_id
         LEFT JOIN agent_profiles profile ON profile.id=assignment.agent_profile_id
         LEFT JOIN agent_runs run ON run.id=t.designated_run_id
         WHERE t.project_id=$1 AND t.phase_id=$2 ORDER BY t.created_at, t.id`,
        [projectId, phaseId],
      );
      return V2PhaseExecution.parse({
        schema_version: 2,
        project_id: projectId,
        phase: phase.rows[0],
        tasks: tasks.rows.map((task) => ({
          id: task.id,
          title: task.title,
          state: task.state,
          complexity: task.complexity,
          risk: task.risk,
          dependencies: task.dependencies,
          assignment:
            task.provider && task.model && task.assignment_status
              ? { provider: task.provider, model: task.model, status: task.assignment_status }
              : null,
          run:
            task.run_id && task.run_state && task.attempt && task.verification_status
              ? {
                  id: task.run_id,
                  state: task.run_state,
                  attempt: task.attempt,
                  verification_status: task.verification_status,
                  commit_sha: task.commit_sha,
                  failure_detail: task.failure_detail,
                }
              : null,
          evidence_count: task.evidence_count,
        })),
      });
    });
  }
}
