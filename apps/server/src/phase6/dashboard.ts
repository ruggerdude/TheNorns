import {
  V2ArtifactKind,
  V2EvidenceRef,
  V2ProjectDashboard,
  type V2ProjectDashboardT,
  V2WorkConversation,
  V2WorkItem,
} from "@norns/contracts";
import type { V2SqlExecutor, V2TransactionRunner } from "../persistence/v2/database.js";
import type { Phase6DeploymentService } from "./deployments.js";
import type { Phase6MockupService } from "./mockups.js";
import { ProjectCodingMetricsService } from "./projectCodingMetrics.js";

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function json<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return (value as T) ?? fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function workDeepLink(projectId: string, conversationId: string | null): string {
  const workRoot = `/projects/${encodeURIComponent(projectId)}/work`;
  return conversationId ? `${workRoot}/${encodeURIComponent(conversationId)}` : workRoot;
}

function available<S extends string, T>(source: S, observedAt: string, data: T) {
  return { availability: "available" as const, source, observed_at: observedAt, data };
}

function unavailable<S extends string>(source: S, error: unknown) {
  const known = error instanceof DashboardSectionUnavailableError ? error : null;
  return {
    availability: "unavailable" as const,
    source,
    observed_at: null,
    data: null,
    reason_code: known?.reasonCode ?? "source_unavailable",
    detail: error instanceof Error ? error.message.slice(0, 500) : null,
    retryable: known?.retryable ?? true,
  };
}

class DashboardSectionUnavailableError extends Error {
  constructor(
    readonly reasonCode: string,
    readonly retryable: boolean,
    message: string,
  ) {
    super(message);
  }
}

async function section<S extends string, T>(source: S, observedAt: string, read: () => Promise<T>) {
  try {
    return available(source, observedAt, await read());
  } catch (error) {
    return unavailable(source, error);
  }
}

interface WorkRow {
  schema_version: number;
  id: string;
  project_id: string;
  created_by_user_id: string;
  title: string;
  objective: string;
  status: string;
  workflow: string;
  planning_run_id: string | null;
  phase_id: string | null;
  approved_plan_version_id: string | null;
  aggregate_version: number | string;
  created_at: string | Date;
  updated_at: string | Date;
  execution_started_at: string | Date | null;
  completed_at: string | Date | null;
  tasks_completed: number | string;
  tasks_total: number | string;
  conversation_id: string | null;
}

interface ConversationRow {
  schema_version: number;
  id: string;
  project_id: string;
  work_item_id: string;
  created_by_user_id: string;
  kind: string;
  status: string;
  provider: string;
  model: string;
  next_message_sequence: number | string;
  created_at: string | Date;
  updated_at: string | Date;
  archived_at: string | Date | null;
}

export class Phase6DashboardService {
  constructor(
    private readonly transactions: V2TransactionRunner,
    private readonly mockups: Phase6MockupService,
    private readonly deployments: Phase6DeploymentService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async read(projectId: string): Promise<V2ProjectDashboardT> {
    const generatedAt = this.now().toISOString();
    const [
      activeWork,
      needsAttention,
      openDecisions,
      budget,
      codingMetrics,
      recentDeployments,
      recentVerification,
      conversations,
      approvedMockups,
      recentArtifacts,
      legacyPlanningRuns,
    ] = await Promise.all([
      section("workflow_state", generatedAt, () => this.activeWork(projectId)),
      section("attention_projection", generatedAt, () => this.needsAttention(projectId)),
      section("human_waits_and_decisions", generatedAt, () => this.openDecisions(projectId)),
      section("usage_ledger_and_approved_plan", generatedAt, () => this.budget(projectId)),
      section("coding_metrics", generatedAt, () =>
        new ProjectCodingMetricsService(this.transactions, this.now).read(projectId),
      ),
      section("deployment_observations", generatedAt, () => this.recentDeployments(projectId)),
      section("verification_results", generatedAt, () => this.verification(projectId)),
      section("work_conversations", generatedAt, () => this.conversations(projectId)),
      section("mockup_decisions", generatedAt, () => this.approvedMockups(projectId)),
      section("artifact_metadata", generatedAt, () => this.artifacts(projectId)),
      section("legacy_planning_runs", generatedAt, () => this.legacyPlanningRuns(projectId)),
    ]);
    return V2ProjectDashboard.parse({
      schema_version: 2,
      project_id: projectId,
      generated_at: generatedAt,
      active_work: activeWork,
      needs_attention: needsAttention,
      open_decisions: openDecisions,
      budget,
      coding_metrics: codingMetrics,
      recent_deployments: recentDeployments,
      recent_verification: recentVerification,
      conversations,
      approved_mockups: approvedMockups,
      recent_artifacts: recentArtifacts,
      legacy_planning_runs: legacyPlanningRuns,
    });
  }

  private query<T>(work: (tx: V2SqlExecutor) => Promise<T>): Promise<T> {
    return this.transactions.transaction(work);
  }

  private activeWork(projectId: string) {
    return this.query(async (tx) => {
      const rows = await tx.query<WorkRow>(
        `SELECT item.*,
                (
                  SELECT count(*)::int
                    FROM conversation_task_package_bindings binding
                    JOIN tasks task
                      ON task.project_id=binding.project_id AND task.id=binding.task_id
                   WHERE binding.project_id=item.project_id
                     AND binding.work_item_id=item.id
                ) AS tasks_total,
                (
                  SELECT count(*)::int
                    FROM conversation_task_package_bindings binding
                    JOIN tasks task
                      ON task.project_id=binding.project_id AND task.id=binding.task_id
                   WHERE binding.project_id=item.project_id
                     AND binding.work_item_id=item.id
                     AND task.state='completed'
                ) AS tasks_completed,
                (
                  SELECT conversation.id
                    FROM work_conversations conversation
                   WHERE conversation.project_id=item.project_id
                     AND conversation.work_item_id=item.id
                   ORDER BY (conversation.kind='execution_pm') DESC,
                            conversation.updated_at DESC,conversation.id
                   LIMIT 1
                ) AS conversation_id
           FROM work_items item
          WHERE item.project_id=$1 AND item.status NOT IN ('completed','cancelled')
          ORDER BY item.updated_at DESC,item.id`,
        [projectId],
      );
      return rows.rows.map((row) => {
        const total = Number(row.tasks_total);
        const complete = Number(row.tasks_completed);
        return {
          work_item: V2WorkItem.parse({
            schema_version: 2,
            id: row.id,
            project_id: row.project_id,
            created_by_user_id: row.created_by_user_id,
            title: row.title,
            objective: row.objective,
            status: row.status,
            workflow: row.workflow,
            planning_run_id: row.planning_run_id,
            phase_id: row.phase_id,
            approved_plan_version_id: row.approved_plan_version_id,
            aggregate_version: Number(row.aggregate_version),
            created_at: iso(row.created_at),
            updated_at: iso(row.updated_at),
            execution_started_at: row.execution_started_at ? iso(row.execution_started_at) : null,
            completed_at: row.completed_at ? iso(row.completed_at) : null,
          }),
          conversation_id: row.conversation_id,
          deep_link: row.conversation_id ? workDeepLink(projectId, row.conversation_id) : null,
          phase_progress:
            row.phase_id === null
              ? null
              : {
                  phase_id: row.phase_id,
                  percent_complete: total === 0 ? 0 : Math.floor((complete * 100) / total),
                  tasks_completed: complete,
                  tasks_total: total,
                },
        };
      });
    });
  }

  private async recentDeployments(projectId: string) {
    const deployments = await this.deployments.list(projectId);
    const taskIds = deployments.flatMap((deployment) =>
      deployment.task_id ? [deployment.task_id] : [],
    );
    const scopes =
      taskIds.length === 0
        ? []
        : await this.query(async (tx) => {
            const rows = await tx.query<{
              task_id: string;
              work_item_id: string;
              conversation_id: string;
            }>(
              `SELECT task_id,work_item_id,conversation_id
                 FROM conversation_task_package_bindings
                WHERE project_id=$1 AND task_id=ANY($2::text[])
                ORDER BY task_id,package_id`,
              [projectId, taskIds],
            );
            return rows.rows;
          });
    const scopeByTask = new Map<string, { work_item_id: string; conversation_id: string }>();
    for (const scope of scopes) {
      if (!scopeByTask.has(scope.task_id)) scopeByTask.set(scope.task_id, scope);
    }
    return deployments.map((deployment) => {
      const scope = deployment.task_id ? scopeByTask.get(deployment.task_id) : undefined;
      return {
        deployment,
        work_item_id: scope?.work_item_id ?? null,
        conversation_id: scope?.conversation_id ?? null,
        deep_link: scope ? workDeepLink(projectId, scope.conversation_id) : null,
      };
    });
  }

  private needsAttention(projectId: string) {
    return this.query(async (tx) => {
      const result = await tx.query<{
        key: string;
        source_type:
          | "human_wait"
          | "decision"
          | "blocker"
          | "mockup"
          | "deployment"
          | "visual_evidence";
        source_id: string;
        work_item_id: string | null;
        conversation_id: string | null;
        phase_id: string | null;
        task_id: string | null;
        title: string;
        summary: string;
        severity: "critical" | "high" | "normal" | "low";
        deep_link: string | null;
        occurred_at: string | Date;
      }>(
        `SELECT 'human-wait:'||wait.id AS key,'human_wait'::text AS source_type,
                wait.id AS source_id,wait.work_item_id,wait.conversation_id,
                wait.phase_id,wait.task_id,'Agent needs a decision' AS title,
                wait.question AS summary,'high'::text AS severity,
                '/projects/'||wait.project_id||'/work/'||wait.conversation_id AS deep_link,
                wait.created_at AS occurred_at
           FROM human_waits wait
          WHERE wait.project_id=$1 AND wait.status='awaiting_human'
         UNION ALL
         SELECT 'decision:'||decision.id,'decision',decision.id,
                item.id,conversation.id,decision.phase_id,decision.task_id,
                'Open project decision',decision.question,decision.urgency,
                CASE WHEN conversation.id IS NULL THEN '/projects/'||decision.project_id||'/work'
                     ELSE '/projects/'||decision.project_id||'/work/'||conversation.id END,
                decision.created_at
           FROM decision_points decision
           LEFT JOIN LATERAL (
             SELECT binding.work_item_id,binding.conversation_id
               FROM conversation_task_package_bindings binding
              WHERE binding.project_id=decision.project_id
                AND binding.task_id=decision.task_id
              ORDER BY binding.package_id LIMIT 1
           ) task_scope ON true
           LEFT JOIN work_items item
             ON item.project_id=decision.project_id
            AND item.id=CASE
              WHEN decision.scope_entity_type='work_item' THEN decision.scope_entity_id
              ELSE task_scope.work_item_id
            END
           LEFT JOIN LATERAL (
             SELECT id FROM work_conversations candidate
              WHERE candidate.project_id=decision.project_id
                AND candidate.work_item_id=item.id
                AND (task_scope.conversation_id IS NULL
                     OR candidate.id=task_scope.conversation_id)
              ORDER BY (candidate.kind='execution_pm') DESC,candidate.updated_at DESC,candidate.id
              LIMIT 1
           ) conversation ON true
          WHERE decision.project_id=$1 AND decision.status='open'
         UNION ALL
         SELECT 'blocked-work:'||item.id,'blocker',item.id,
                item.id,conversation.id,item.phase_id,NULL,
                'Work is blocked',item.title,'high',
                CASE WHEN conversation.id IS NULL THEN '/projects/'||item.project_id||'/work'
                     ELSE '/projects/'||item.project_id||'/work/'||conversation.id END,
                item.updated_at
           FROM work_items item
           LEFT JOIN LATERAL (
             SELECT id FROM work_conversations candidate
              WHERE candidate.project_id=item.project_id AND candidate.work_item_id=item.id
              ORDER BY (candidate.kind='execution_pm') DESC,candidate.updated_at DESC,candidate.id
              LIMIT 1
           ) conversation ON true
          WHERE item.project_id=$1 AND item.status='blocked'
         UNION ALL
         SELECT 'mockup:'||version.id,'mockup',version.id,
                version.work_item_id,version.conversation_id,NULL,version.task_id,
                'Mockup needs review',version.brief,'normal',
                '/projects/'||version.project_id||'/work/'||version.conversation_id,
                version.created_at
           FROM conversation_mockup_versions version
          WHERE version.project_id=$1
            AND NOT EXISTS (
              SELECT 1 FROM conversation_mockup_decisions decision
               WHERE decision.mockup_version_id=version.id
            )
         UNION ALL
         SELECT 'deployment:'||delivery.id,'deployment',delivery.id,
                item.id,conversation.id,delivery.phase_id,delivery.task_id,
                'Deployment failed',delivery.service||' in '||delivery.environment,
                'critical',
                CASE WHEN conversation.id IS NULL THEN '/projects/'||delivery.project_id||'/work'
                     ELSE '/projects/'||delivery.project_id||'/work/'||conversation.id END,
                delivery.updated_at
           FROM project_delivery_records delivery
           LEFT JOIN LATERAL (
             SELECT binding.work_item_id,binding.conversation_id
               FROM conversation_task_package_bindings binding
              WHERE binding.project_id=delivery.project_id
                AND binding.task_id=delivery.task_id
              ORDER BY binding.package_id LIMIT 1
           ) delivery_scope ON true
           LEFT JOIN work_items item
             ON item.project_id=delivery.project_id AND item.id=delivery_scope.work_item_id
           LEFT JOIN work_conversations conversation
             ON conversation.project_id=delivery.project_id
            AND conversation.id=delivery_scope.conversation_id
          WHERE delivery.project_id=$1 AND delivery.status='failed'
         UNION ALL
         SELECT 'visual-evidence:'||collection.id,'visual_evidence',collection.id,
                collection.work_item_id,collection.conversation_id,
                collection.phase_id,collection.task_id,
                'Implementation screenshots need attention',
                COALESCE(collection.last_error,'Screenshot collection failed'),
                'high',
                '/projects/'||collection.project_id||'/work/'||collection.conversation_id,
                collection.updated_at
           FROM implementation_visual_evidence_collections collection
          WHERE collection.project_id=$1 AND collection.status='failed'
          ORDER BY occurred_at DESC,key`,
        [projectId],
      );
      return result.rows.map((row) => ({
        project_id: projectId,
        ...row,
        deep_link: workDeepLink(projectId, row.conversation_id),
        occurred_at: iso(row.occurred_at),
      }));
    });
  }

  private openDecisions(projectId: string) {
    return this.query(async (tx) => {
      const result = await tx.query<{
        id: string;
        project_id: string;
        work_item_id: string | null;
        phase_id: string | null;
        conversation_id: string | null;
        source_type: "human_wait" | "decision_point" | "blocked_work_item" | "blocked_task";
        source_id: string;
        title: string;
        detail: string;
        status: "awaiting_human" | "open" | "blocked";
        deep_link: string | null;
        created_at: string | Date;
      }>(
        `SELECT 'human-wait:'||wait.id AS id,wait.project_id,wait.work_item_id,
                wait.phase_id,wait.conversation_id,'human_wait'::text AS source_type,
                wait.id AS source_id,wait.decision_point AS title,wait.question AS detail,
                'awaiting_human'::text AS status,
                '/projects/'||wait.project_id||'/work/'||wait.conversation_id AS deep_link,
                wait.created_at
           FROM human_waits wait
          WHERE wait.project_id=$1 AND wait.status='awaiting_human'
         UNION ALL
         SELECT 'decision-point:'||decision.id,decision.project_id,item.id,
                decision.phase_id,conversation.id,'decision_point',decision.id,
                decision.question,decision.context,'open',
                CASE WHEN conversation.id IS NULL THEN '/projects/'||decision.project_id||'/work'
                     ELSE '/projects/'||decision.project_id||'/work/'||conversation.id END,
                decision.created_at
           FROM decision_points decision
           LEFT JOIN LATERAL (
             SELECT binding.work_item_id,binding.conversation_id
               FROM conversation_task_package_bindings binding
              WHERE binding.project_id=decision.project_id
                AND binding.task_id=decision.task_id
              ORDER BY binding.package_id LIMIT 1
           ) task_scope ON true
           LEFT JOIN work_items item
             ON item.project_id=decision.project_id
            AND item.id=CASE
              WHEN decision.scope_entity_type='work_item' THEN decision.scope_entity_id
              ELSE task_scope.work_item_id
            END
           LEFT JOIN LATERAL (
             SELECT id FROM work_conversations candidate
              WHERE candidate.project_id=decision.project_id
                AND candidate.work_item_id=item.id
                AND (task_scope.conversation_id IS NULL
                     OR candidate.id=task_scope.conversation_id)
              ORDER BY (candidate.kind='execution_pm') DESC,candidate.updated_at DESC,candidate.id
              LIMIT 1
           ) conversation ON true
          WHERE decision.project_id=$1 AND decision.status='open'
         UNION ALL
         SELECT 'blocked-work:'||item.id,item.project_id,item.id,item.phase_id,
                conversation.id,'blocked_work_item',item.id,item.title,item.objective,
                'blocked',
                CASE WHEN conversation.id IS NULL THEN '/projects/'||item.project_id||'/work'
                     ELSE '/projects/'||item.project_id||'/work/'||conversation.id END,
                item.updated_at
           FROM work_items item
           LEFT JOIN LATERAL (
             SELECT id FROM work_conversations candidate
              WHERE candidate.project_id=item.project_id AND candidate.work_item_id=item.id
              ORDER BY (candidate.kind='execution_pm') DESC,candidate.updated_at DESC,candidate.id
              LIMIT 1
           ) conversation ON true
          WHERE item.project_id=$1 AND item.status='blocked'
         UNION ALL
         SELECT 'blocked-task:'||task.id,task.project_id,item.id,task.phase_id,
                conversation.id,'blocked_task',task.id,task.title,task.description,
                'blocked',
                CASE WHEN conversation.id IS NULL THEN '/projects/'||task.project_id||'/work'
                     ELSE '/projects/'||task.project_id||'/work/'||conversation.id END,
                task.updated_at
           FROM tasks task
           JOIN conversation_task_package_bindings binding
             ON binding.project_id=task.project_id AND binding.task_id=task.id
           JOIN work_items item
             ON item.project_id=binding.project_id AND item.id=binding.work_item_id
           LEFT JOIN LATERAL (
             SELECT id FROM work_conversations candidate
              WHERE candidate.project_id=item.project_id
                AND candidate.id=binding.conversation_id
              LIMIT 1
           ) conversation ON true
          WHERE task.project_id=$1 AND task.state='blocked'
          ORDER BY created_at DESC,id`,
        [projectId],
      );
      return result.rows.map((row) => ({
        ...row,
        deep_link: workDeepLink(projectId, row.conversation_id),
        created_at: iso(row.created_at),
      }));
    });
  }

  private budget(projectId: string) {
    return this.query(async (tx) => {
      const usage = await tx.query<{
        spend: number | string | null;
        entries: number | string;
        priced_entries: number | string;
      }>(
        `SELECT sum(cost_usd) AS spend,count(*) AS entries,
                count(cost_usd) AS priced_entries
           FROM ai_usage_events
          WHERE project_id=$1
            AND event_type IN ('usage_observed','adjustment')`,
        [projectId],
      );
      const plan = await tx.query<{ budget: number | string | null; phases: number | string }>(
        `SELECT sum(approved_budget_usd) AS budget,
                count(approved_budget_usd) AS phases
           FROM phases
          WHERE project_id=$1 AND approved_strategy_version_id IS NOT NULL`,
        [projectId],
      );
      const usageEntries = Number(usage.rows[0]?.entries ?? 0);
      const pricedUsageEntries = Number(usage.rows[0]?.priced_entries ?? 0);
      if (pricedUsageEntries !== usageEntries) {
        throw new DashboardSectionUnavailableError(
          "incomplete_usage_pricing",
          false,
          `${usageEntries - pricedUsageEntries} usage ledger entr${
            usageEntries - pricedUsageEntries === 1 ? "y is" : "ies are"
          } missing authoritative cost.`,
        );
      }
      const hasUsage = pricedUsageEntries > 0;
      const hasPlan = Number(plan.rows[0]?.phases ?? 0) > 0;
      if (!hasUsage && !hasPlan) {
        throw new DashboardSectionUnavailableError(
          "no_authoritative_budget_source",
          false,
          "No usage ledger entries or approved phase budget exists yet.",
        );
      }
      return {
        project_id: projectId,
        current_spend_usd: hasUsage ? Number(usage.rows[0]?.spend ?? 0) : null,
        projected_budget_usd: hasPlan ? Number(plan.rows[0]?.budget ?? 0) : null,
        projection_source:
          hasUsage && hasPlan
            ? ("usage_and_plan" as const)
            : hasUsage
              ? ("usage_only" as const)
              : ("plan_only" as const),
      };
    });
  }

  private verification(projectId: string) {
    return this.query(async (tx) => {
      const result = await tx.query<{
        id: string;
        project_id: string;
        phase_id: string;
        task_id: string;
        run_id: string;
        work_item_id: string | null;
        conversation_id: string | null;
        commit_sha: string;
        passed: boolean;
        evidence: unknown;
        created_at: string | Date;
      }>(
        `SELECT verification.id,verification.project_id,verification.phase_id,
                verification.task_id,verification.run_id,item.id AS work_item_id,
                conversation.id AS conversation_id,verification.commit_sha,
                verification.passed,verification.evidence,verification.created_at
           FROM verification_results verification
           LEFT JOIN LATERAL (
             SELECT binding.work_item_id,binding.conversation_id
               FROM conversation_task_package_bindings binding
              WHERE binding.project_id=verification.project_id
                AND binding.task_id=verification.task_id
              ORDER BY binding.package_id LIMIT 1
           ) verification_scope ON true
           LEFT JOIN work_items item
             ON item.project_id=verification.project_id
            AND item.id=verification_scope.work_item_id
           LEFT JOIN work_conversations conversation
             ON conversation.project_id=verification.project_id
            AND conversation.id=verification_scope.conversation_id
          WHERE verification.project_id=$1
          ORDER BY verification.created_at DESC,verification.id DESC LIMIT 20`,
        [projectId],
      );
      return result.rows.map((row) => ({
        ...row,
        evidence: V2EvidenceRef.array().parse(json(row.evidence, [])),
        deep_link: workDeepLink(projectId, row.conversation_id),
        created_at: iso(row.created_at),
      }));
    });
  }

  private conversations(projectId: string) {
    return this.query(async (tx) => {
      const result = await tx.query<ConversationRow>(
        `SELECT * FROM work_conversations
          WHERE project_id=$1
          ORDER BY updated_at DESC,id DESC`,
        [projectId],
      );
      return result.rows.map((row) =>
        V2WorkConversation.parse({
          schema_version: 2,
          id: row.id,
          project_id: row.project_id,
          work_item_id: row.work_item_id,
          created_by_user_id: row.created_by_user_id,
          kind: row.kind,
          status: row.status,
          provider: row.provider,
          model: row.model,
          next_message_sequence: Number(row.next_message_sequence),
          created_at: iso(row.created_at),
          updated_at: iso(row.updated_at),
          archived_at: row.archived_at ? iso(row.archived_at) : null,
        }),
      );
    });
  }

  private async approvedMockups(projectId: string) {
    const identities = await this.query(async (tx) => {
      const result = await tx.query<{ id: string; conversation_id: string }>(
        `SELECT version.id,version.conversation_id
           FROM conversation_mockup_versions version
           JOIN conversation_mockup_decisions decision
             ON decision.mockup_version_id=version.id AND decision.decision='approved'
          WHERE version.project_id=$1
          ORDER BY decision.created_at DESC,version.id DESC LIMIT 20`,
        [projectId],
      );
      return result.rows;
    });
    return Promise.all(
      identities.map((identity) =>
        this.mockups.version(projectId, identity.conversation_id, identity.id),
      ),
    );
  }

  private artifacts(projectId: string) {
    return this.query(async (tx) => {
      const result = await tx.query<{
        project_id: string;
        kind: string;
        id: string;
        content_hash: string;
        media_type: string;
        label: string;
        created_at: string | Date;
      }>(
        `SELECT project_id,kind,id,content_hash,media_type,label,created_at
           FROM artifacts
          WHERE project_id=$1
          ORDER BY created_at DESC,id DESC LIMIT 50`,
        [projectId],
      );
      return result.rows.map((row) => ({
        project_id: row.project_id,
        kind: V2ArtifactKind.parse(row.kind),
        artifact: V2EvidenceRef.parse({
          artifact_id: row.id,
          content_hash: row.content_hash,
          media_type: row.media_type,
          label: row.label,
        }),
        created_at: iso(row.created_at),
      }));
    });
  }

  private legacyPlanningRuns(projectId: string) {
    return this.query(async (tx) => {
      const result = await tx.query<{
        id: string;
        project_id: string;
        objective: string;
        status: string;
        result: unknown;
        created_at: string | Date;
      }>(
        `SELECT id,project_id,objective,status,result,created_at
           FROM planning_runs
          WHERE project_id=$1 ORDER BY created_at DESC,id DESC LIMIT 20`,
        [projectId],
      );
      return result.rows.map((row) => {
        const parsed = json<Record<string, unknown>>(row.result, {});
        return {
          id: row.id,
          project_id: row.project_id,
          label: row.objective,
          status: row.status,
          content_hash:
            typeof parsed.content_hash === "string" && /^[a-f0-9]{64}$/.test(parsed.content_hash)
              ? parsed.content_hash
              : null,
          created_at: iso(row.created_at),
          legacy: true as const,
        };
      });
    });
  }
}
