import { createHash } from "node:crypto";
import type { ProviderName } from "@norns/adapters";
import { type PmModelT, isPmModelForProvider } from "@norns/contracts";
import { NodeAssignment, type NodeAssignmentT } from "../graph/allocation.js";
import type { GraphNode } from "../graph/graph.js";
import { newId } from "../ids.js";
import type { V2SqlExecutor, V2TransactionRunner } from "../persistence/v2/database.js";
import type { ProjectGraphView, ProjectRepository } from "./repository.js";
import { safeLocalRepositoryDisplayName } from "./repositoryDisplayName.js";
import {
  ProjectNotFoundError,
  ProjectNotPlannedError,
  type ProjectSourceType,
  type ProjectSummary,
  reviewerFor,
} from "./store.js";

interface ProjectReadRow {
  id: string;
  name: string;
  description: string;
  created_at: string | Date;
  pm_provider: ProviderName;
  pm_model: string | null;
  reviewer_provider: ProviderName;
  plan_hash: string | null;
  plan_objective: string | null;
  source_type: ProjectSourceType | null;
  github_owner: string | null;
  github_name: string | null;
  local_repository_display_name: string | null;
}

interface ProjectGraphHeaderRow {
  plan_hash: string | null;
  graph_version: number | null;
  legacy_phase_id: string | null;
  legacy_strategy_version_id: string | null;
  content_hash: string | null;
  approved_at: string | Date | null;
  actor_id: string | null;
  source_actor_text: string | null;
  approval_graph_version: number | null;
  allocation_fingerprint: string | null;
}

interface RelationalTaskRow {
  task_id: string;
  title: string;
  complexity: GraphNode["complexity"];
  risk: GraphNode["risk"];
  state: string;
  legacy_id: string;
  task_source_metadata: Record<string, unknown>;
  assignment_id: string | null;
  assignment_status: string | null;
  rationale: string | null;
  budget_limit_usd: number | string | null;
  provider: string | null;
  model: string | null;
  reviewer_model: string | null;
  assignment_source_metadata: Record<string, unknown> | null;
}

interface DependencyRow {
  predecessor_task_id: string;
  successor_task_id: string;
}

type ReadRecord = Record<string, unknown>;

function record(value: unknown): ReadRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as ReadRecord)
    : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function pmModel(provider: ProviderName, value: string | null): PmModelT | null {
  if (value === null) return null;
  if (!isPmModelForProvider(provider, value)) {
    throw new Error(`invalid imported PM model "${value}" for provider "${provider}"`);
  }
  return value;
}

function sourceLocation(row: ProjectReadRow): string | null {
  if (row.source_type === "local") {
    return safeLocalRepositoryDisplayName(row.local_repository_display_name);
  }
  if (row.source_type === "github" && row.github_owner !== null && row.github_name !== null) {
    return `https://github.com/${row.github_owner}/${row.github_name}.git`;
  }
  return null;
}

function summaryFromRow(row: ProjectReadRow): ProjectSummary {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    pm_provider: row.pm_provider,
    pm_model: pmModel(row.pm_provider, row.pm_model),
    reviewer_provider: row.reviewer_provider,
    status: row.plan_hash === null ? "draft" : "planned",
    created_at: iso(row.created_at),
    plan_objective: row.plan_hash === null ? null : row.plan_objective,
    source_type: row.source_type,
    source_location: sourceLocation(row),
  };
}

function sourceKind(metadata: ReadRecord): string | null {
  const value = metadata.source_kind;
  return typeof value === "string" ? value : null;
}

function localTaskId(projectId: string, row: RelationalTaskRow): string {
  const graphNode = record(row.task_source_metadata.legacy_graph_node);
  if (typeof graphNode.id === "string" && graphNode.id.length > 0) return graphNode.id;
  const module = record(row.task_source_metadata.legacy_module);
  if (typeof module.id === "string" && module.id.length > 0) return module.id;
  const prefix = `${projectId}#`;
  if (row.legacy_id.startsWith(prefix) && row.legacy_id.length > prefix.length) {
    return row.legacy_id.slice(prefix.length);
  }
  throw new Error(`legacy task mapping ${row.task_id} has no local graph identity`);
}

function sourceDependencies(metadata: ReadRecord): string[] {
  const graphNode = record(metadata.legacy_graph_node);
  if (Array.isArray(graphNode.dependencies)) return stringArray(graphNode.dependencies);
  const module = record(metadata.legacy_module);
  return stringArray(module.dependencies);
}

function parallelSafe(metadata: ReadRecord): boolean {
  const graphNode = record(metadata.legacy_graph_node);
  if (typeof graphNode.parallel_safe === "boolean") return graphNode.parallel_safe;
  const module = record(metadata.legacy_module);
  const parallelization = record(module.parallelization);
  return parallelization.safe === true;
}

function assignmentFromRow(row: RelationalTaskRow): NodeAssignmentT | null {
  if (row.assignment_id === null || row.assignment_status === "cancelled") return null;
  const metadata = record(row.assignment_source_metadata);
  const source = metadata.legacy_source;
  if (source !== "auto" && source !== "override") return null;
  if (row.provider !== "anthropic" && row.provider !== "openai") return null;
  if (row.model === null || row.reviewer_model === null || row.rationale === null) return null;
  const workerCount = Number(metadata.legacy_worker_count);
  const budget = Number(row.budget_limit_usd);
  return NodeAssignment.parse({
    provider: row.provider,
    model: row.model,
    role: "implementation",
    worker_count: workerCount,
    reviewer_model: row.reviewer_model,
    budget_usd: budget,
    rationale: row.rationale,
    source,
  });
}

function allocationFingerprint(nodes: readonly GraphNode[]): string {
  const canonical = JSON.stringify(
    [...nodes]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((node) => ({ id: node.id, assignment: node.assignment })),
  );
  return createHash("sha256").update(canonical).digest("hex");
}

async function projectRows(
  sql: V2SqlExecutor,
  migrationRunId: string,
  projectId?: string,
): Promise<ProjectReadRow[]> {
  const params: unknown[] = [migrationRunId];
  const projectPredicate =
    projectId === undefined
      ? ""
      : (() => {
          params.push(projectId);
          return "AND project.id = $2";
        })();
  const result = await sql.query<ProjectReadRow>(
    `SELECT project.id, project.name, project.description, project.created_at,
            preference.pm_provider, preference.pm_model,
            preference.reviewer_provider, imported.plan_hash,
            phase.objective_summary AS plan_objective,
            COALESCE(candidate.source_type,
              CASE binding.binding_type WHEN 'local_runner' THEN 'local'::text WHEN 'github' THEN 'github'::text ELSE NULL END
            )::text AS source_type,
            COALESCE(candidate.github_owner, binding.github_owner) AS github_owner,
            COALESCE(candidate.github_name, binding.github_name) AS github_name,
            CASE WHEN binding.binding_type = 'local_runner' THEN binding.repository_display_name ELSE NULL END AS local_repository_display_name
     FROM projects project
     LEFT JOIN legacy_project_imports imported
       ON imported.project_id = project.id
      AND imported.migration_run_id = $1
     JOIN project_planning_preferences preference
       ON preference.project_id = project.id
     LEFT JOIN legacy_id_mappings phase_mapping
       ON phase_mapping.migration_run_id = imported.migration_run_id
      AND phase_mapping.legacy_entity_type = 'project_initial_phase'
      AND phase_mapping.legacy_id = project.id || '#initial-phase'
      AND phase_mapping.v2_entity_type = 'phase'
     LEFT JOIN phases phase
       ON phase.project_id = project.id
      AND phase.id = phase_mapping.v2_id
     LEFT JOIN LATERAL (
       SELECT source_type, github_owner, github_name
       FROM repository_binding_candidates binding
       WHERE binding.project_id = project.id
         AND binding.status <> 'dismissed'
       ORDER BY CASE binding.status WHEN 'promoted' THEN 0 ELSE 1 END,
                binding.created_at, binding.id
       LIMIT 1
     ) candidate ON true
     LEFT JOIN repository_bindings binding
       ON binding.id = project.primary_repository_binding_id
      AND binding.project_id = project.id
      AND binding.status = 'connected'
     WHERE true ${projectPredicate}
     ORDER BY project.created_at DESC, imported.imported_at DESC NULLS LAST, project.id DESC`,
    params,
  );
  return result.rows;
}

/** Legacy graph mutations require normalized Phase 3 commands after write cutover. */
export class Phase3RequiredError extends Error {
  readonly code = "phase3_required" as const;

  constructor(readonly operation: string) {
    super(`project operation "${operation}" requires Phase 3 relational command support`);
    this.name = "Phase3RequiredError";
  }
}

/** Compatibility projection over V2 rows, including relational project creation. */
export class RelationalProjectReadRepository implements ProjectRepository {
  readonly repositoryKind = "project_repository" as const;

  constructor(
    private readonly transactions: V2TransactionRunner,
    private readonly migrationRunId: string,
  ) {}

  async list(): Promise<ProjectSummary[]> {
    return this.transactions.transaction(async (sql) => {
      const rows = await projectRows(sql, this.migrationRunId);
      const unique = new Map<string, ProjectSummary>();
      for (const row of rows) {
        if (!unique.has(row.id)) unique.set(row.id, summaryFromRow(row));
      }
      return [...unique.values()];
    });
  }

  async summary(id: string): Promise<ProjectSummary> {
    return this.transactions.transaction(async (sql) => {
      const row = (await projectRows(sql, this.migrationRunId, id))[0];
      if (!row) throw new ProjectNotFoundError(id);
      return summaryFromRow(row);
    });
  }

  async pmSelectionOf(id: string): Promise<{ provider: ProviderName; model: PmModelT | null }> {
    const summary = await this.summary(id);
    return { provider: summary.pm_provider, model: summary.pm_model };
  }

  async graph(id: string): Promise<ProjectGraphView> {
    return this.transactions.transaction(async (sql) => {
      const headerResult = await sql.query<ProjectGraphHeaderRow>(
        `SELECT imported.plan_hash, imported.graph_version,
                phase_mapping.v2_id AS legacy_phase_id,
                strategy_mapping.v2_id AS legacy_strategy_version_id,
                approval.content_hash, approval.approved_at,
                approval.actor_id, approval.source_actor_text,
                approval.graph_version AS approval_graph_version,
                approval.allocation_fingerprint
         FROM legacy_project_imports imported
         LEFT JOIN legacy_id_mappings phase_mapping
           ON phase_mapping.migration_run_id = imported.migration_run_id
          AND phase_mapping.legacy_entity_type = 'project_initial_phase'
          AND phase_mapping.legacy_id = imported.project_id || '#initial-phase'
          AND phase_mapping.v2_entity_type = 'phase'
         LEFT JOIN legacy_id_mappings strategy_mapping
           ON strategy_mapping.migration_run_id = imported.migration_run_id
          AND strategy_mapping.legacy_entity_type = 'project_strategy'
          AND strategy_mapping.legacy_id = imported.project_id || '#strategy'
          AND strategy_mapping.v2_entity_type = 'strategy_version'
         LEFT JOIN LATERAL (
           SELECT evidence.content_hash, evidence.approved_at,
                  evidence.actor_id, evidence.source_actor_text,
                  evidence.graph_version, evidence.allocation_fingerprint
           FROM legacy_approval_evidence evidence
           WHERE evidence.migration_run_id = imported.migration_run_id
             AND evidence.project_id = imported.project_id
             AND evidence.phase_id = phase_mapping.v2_id
           ORDER BY evidence.approved_at DESC, evidence.id DESC
           LIMIT 1
         ) approval ON true
         WHERE imported.migration_run_id = $1 AND imported.project_id = $2`,
        [this.migrationRunId, id],
      );
      const header = headerResult.rows[0];
      if (!header) {
        const project = await sql.query("SELECT id FROM projects WHERE id = $1", [id]);
        if (project.rows.length > 0) throw new ProjectNotPlannedError(id);
        throw new ProjectNotFoundError(id);
      }
      if (header.plan_hash === null) throw new ProjectNotPlannedError(id);
      if (header.legacy_phase_id === null || header.legacy_strategy_version_id === null) {
        throw new Error(`legacy project ${id} has no phase/strategy projection provenance`);
      }

      const taskResult = await sql.query<RelationalTaskRow>(
        `SELECT task.id AS task_id, task.title, task.complexity, task.risk,
                task.state, task_mapping.legacy_id,
                task_mapping.source_metadata AS task_source_metadata,
                assignment.id AS assignment_id,
                assignment.status AS assignment_status,
                assignment.rationale, assignment.budget_limit_usd,
                profile.provider, profile.model,
                reviewer.model AS reviewer_model,
                assignment_mapping.source_metadata AS assignment_source_metadata
         FROM tasks task
         JOIN legacy_id_mappings task_mapping
           ON task_mapping.migration_run_id = $1
          AND task_mapping.v2_entity_type = 'task'
          AND task_mapping.v2_id = task.id
         LEFT JOIN agent_assignments assignment
           ON assignment.id = task.designated_assignment_id
          AND assignment.project_id = task.project_id
          AND assignment.phase_id = task.phase_id
          AND assignment.task_id = task.id
         LEFT JOIN agent_profiles profile ON profile.id = assignment.agent_profile_id
         LEFT JOIN agent_profiles reviewer
           ON reviewer.id = assignment.reviewer_agent_profile_id
         LEFT JOIN legacy_id_mappings assignment_mapping
           ON assignment_mapping.migration_run_id = $1
          AND assignment_mapping.v2_entity_type = 'agent_assignment'
          AND assignment_mapping.v2_id = assignment.id
         WHERE task.project_id = $2
           AND task.phase_id = $3
           AND task.strategy_version_id = $4
         ORDER BY task_mapping.legacy_id, task.id`,
        [this.migrationRunId, id, header.legacy_phase_id, header.legacy_strategy_version_id],
      );
      const visibleRows = taskResult.rows.filter(
        (row) =>
          !(
            row.state === "cancelled" &&
            sourceKind(row.task_source_metadata) === "plan_only_deleted"
          ),
      );
      const localByTask = new Map<string, string>();
      const rowByTask = new Map<string, RelationalTaskRow>();
      for (const row of visibleRows) {
        const localId = localTaskId(id, row);
        if ([...localByTask.values()].includes(localId)) {
          throw new Error(`duplicate legacy graph identity "${localId}" for project "${id}"`);
        }
        localByTask.set(row.task_id, localId);
        rowByTask.set(row.task_id, row);
      }

      const dependencyResult = await sql.query<DependencyRow>(
        `SELECT predecessor_task_id, successor_task_id
         FROM task_dependencies
         WHERE project_id = $1
           AND phase_id = $2
         ORDER BY id`,
        [id, header.legacy_phase_id],
      );
      const dependenciesBySuccessor = new Map<string, string[]>();
      for (const dependency of dependencyResult.rows) {
        const predecessor = localByTask.get(dependency.predecessor_task_id);
        if (predecessor === undefined || !localByTask.has(dependency.successor_task_id)) continue;
        const current = dependenciesBySuccessor.get(dependency.successor_task_id) ?? [];
        current.push(predecessor);
        dependenciesBySuccessor.set(dependency.successor_task_id, current);
      }

      const nodes: GraphNode[] = [...rowByTask.entries()].map(([taskId, row]) => {
        const currentDependencies = [...new Set(dependenciesBySuccessor.get(taskId) ?? [])];
        const sourceOrder = sourceDependencies(row.task_source_metadata);
        const currentSet = new Set(currentDependencies);
        const dependencies = [
          ...sourceOrder.filter((dependency) => currentSet.delete(dependency)),
          ...[...currentSet].sort(),
        ];
        return {
          id: localByTask.get(taskId) ?? localTaskId(id, row),
          title: row.title,
          complexity: row.complexity,
          risk: row.risk,
          parallel_safe: parallelSafe(row.task_source_metadata),
          dependencies,
          assignment: assignmentFromRow(row),
        };
      });
      const version = Number(header.graph_version ?? 1);
      const perNode = nodes.map((node) => ({
        node_id: node.id,
        budget_usd: node.assignment?.budget_usd ?? null,
      }));
      const currentFingerprint = allocationFingerprint(nodes);
      const approval =
        header.content_hash === null ||
        header.approved_at === null ||
        header.approval_graph_version === null ||
        header.allocation_fingerprint === null
          ? null
          : {
              content_hash: header.content_hash,
              approved_at: iso(header.approved_at),
              actor: header.source_actor_text ?? header.actor_id ?? "unknown",
              current:
                Number(header.approval_graph_version) === version &&
                header.allocation_fingerprint === currentFingerprint,
            };
      return {
        graph: { version, nodes },
        cost: {
          total_usd:
            Math.round(perNode.reduce((sum, entry) => sum + (entry.budget_usd ?? 0), 0) * 100) /
            100,
          per_node: perNode,
          unallocated: perNode
            .filter((entry) => entry.budget_usd === null)
            .map((entry) => entry.node_id),
        },
        approval,
      };
    });
  }

  create(input: Parameters<ProjectRepository["create"]>[0]): Promise<ProjectSummary> {
    const projectId = newId("proj");
    const createdAt = new Date().toISOString();
    const reviewerProvider = reviewerFor(input.pmProvider);
    return this.transactions.transaction(async (sql) => {
      await sql.query(
        `INSERT INTO projects (
           id, name, description, status, assignment_policy_ref,
           verification_policy_ref, budget_policy_ref, created_at, updated_at
         ) VALUES ($1,$2,$3,'initializing',$4,$5,$6,$7,$7)`,
        [
          projectId,
          input.name,
          input.description,
          "assignment-policy:default-v1",
          "verification-policy:default-v1",
          "budget-policy:default-v1",
          createdAt,
        ],
      );
      await sql.query(
        `INSERT INTO project_planning_preferences (
           project_id, pm_provider, pm_model, reviewer_provider, source,
           created_at, updated_at
         ) VALUES ($1,$2,$3,$4,'native',$5,$5)`,
        [projectId, input.pmProvider, input.pmModel ?? null, reviewerProvider, createdAt],
      );

      if (input.sourceType && input.sourceLocation) {
        const sourceFingerprint = createHash("sha256").update(input.sourceLocation).digest("hex");
        const githubMatch =
          input.sourceType === "github"
            ? /github\.com[/:]([^/]+)\/([^/]+)$/.exec(input.sourceLocation)
            : null;
        const github =
          githubMatch === null
            ? null
            : [githubMatch[0], githubMatch[1], githubMatch[2]?.replace(/\.git$/, "")];
        const displayName =
          github?.[2] ?? input.sourceLocation.split(/[\\/]/).filter(Boolean).at(-1) ?? "repository";
        await sql.query(
          `INSERT INTO repository_binding_candidates (
             id, project_id, source_type, source_fingerprint, display_name,
             github_owner, github_name, service_connection_id,
             external_repository_id, default_branch, status, created_at, updated_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'unverified',$11,$11)`,
          [
            newId("binding_candidate"),
            projectId,
            input.sourceType,
            sourceFingerprint,
            displayName,
            github?.[1] ?? null,
            github?.[2] ?? null,
            input.sourceConnectionId ?? null,
            input.sourceRepositoryId ?? null,
            input.sourceDefaultBranch ?? null,
            createdAt,
          ],
        );
      }

      await sql.query(
        `INSERT INTO domain_events (
           event_id, stream_type, stream_id, stream_version, event_type,
           project_id, actor_type, actor_id, correlation_id, occurred_at, payload
         ) VALUES ($1,'project',$2,1,'project.created',$2,'system',NULL,$3,$4,$5::jsonb)`,
        [
          newId("event"),
          projectId,
          newId("correlation"),
          createdAt,
          JSON.stringify({
            name: input.name,
            pm_provider: input.pmProvider,
            pm_model: input.pmModel ?? null,
            reviewer_provider: reviewerProvider,
          }),
        ],
      );
      const row = (await projectRows(sql, this.migrationRunId, projectId))[0];
      if (!row) throw new Error(`project ${projectId} disappeared after creation`);
      return summaryFromRow(row);
    });
  }

  addEdge(_id: string, _from: string, _to: string): Promise<never> {
    return Promise.reject(new Phase3RequiredError("addEdge"));
  }

  removeEdge(_id: string, _from: string, _to: string): Promise<never> {
    return Promise.reject(new Phase3RequiredError("removeEdge"));
  }

  addNode(_id: string, _input: Parameters<ProjectRepository["addNode"]>[1]): Promise<never> {
    return Promise.reject(new Phase3RequiredError("addNode"));
  }

  removeNode(
    _id: string,
    _nodeId: string,
    _mode?: Parameters<ProjectRepository["removeNode"]>[2],
  ): Promise<never> {
    return Promise.reject(new Phase3RequiredError("removeNode"));
  }

  allocate(_id: string, _strategy: Parameters<ProjectRepository["allocate"]>[1]): Promise<never> {
    return Promise.reject(new Phase3RequiredError("allocate"));
  }

  overrideAssignment(
    _id: string,
    _nodeId: string,
    _patch: Parameters<ProjectRepository["overrideAssignment"]>[2],
  ): Promise<never> {
    return Promise.reject(new Phase3RequiredError("overrideAssignment"));
  }

  approveAllocation(_id: string, _actor: string): Promise<never> {
    return Promise.reject(new Phase3RequiredError("approveAllocation"));
  }

  loadPlan(_id: string, _plan: Parameters<ProjectRepository["loadPlan"]>[1]): Promise<never> {
    return Promise.reject(new Phase3RequiredError("loadPlan"));
  }
}
