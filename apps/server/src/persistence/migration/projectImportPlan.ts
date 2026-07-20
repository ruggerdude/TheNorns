import type { AcceptanceCriterionT, PlanModuleT } from "@norns/contracts";
import { canonicalSha256 } from "./canonicalJson.js";
import type {
  LegacyAllocationApprovalT,
  LegacyGraphNodeT,
  LegacyProjectSnapshotT,
} from "./legacyProjectSchemas.js";
import {
  type LegacyProjectReconciliationFinding,
  type LegacyProjectReconciliationReport,
  type ReconcileLegacyProjectOptions,
  analyzeLegacyProject,
} from "./projectReconciliation.js";

export type LegacyImportedTaskIntent = "pending" | "cancelled";
export type LegacyImportedTaskSource =
  | "plan_and_graph"
  | "graph_only"
  | "plan_only_deleted"
  | "plan_unverified";

export interface LegacyImportedAgentProfile {
  id: string;
  provider: string;
  model: string;
  runtime: "legacy-import";
  roles: ["implementation"] | ["review"];
  status: "disabled";
  context_limit_tokens: 1;
  security_restrictions: ["legacy-import-not-executable"];
  source_hash: string;
}

export interface LegacyImportedAssignment {
  id: string;
  project_id: string;
  phase_id: string;
  task_id: string;
  agent_profile_id: string;
  reviewer_agent_profile_id: string | null;
  status: "proposed" | "cancelled";
  rationale: string;
  rationale_factors: ["capability", "budget"];
  budget_limit_usd: number;
  allocation_policy_ref: string;
  legacy_worker_count: number;
  legacy_source: "auto" | "pm" | "override" | "unassigned";
  source_hash: string;
  non_executable: true;
}

export interface LegacyImportedTask {
  id: string;
  local_id: string;
  project_id: string;
  phase_id: string;
  objective_id: string;
  strategy_version_id: string;
  title: string;
  description: string;
  deliverables: string[];
  acceptance_criteria: string[];
  complexity: "S" | "M" | "L" | "XL";
  risk: "low" | "medium" | "high" | "critical";
  required_roles: ["implementation"];
  required_capabilities: string[];
  required_inputs: [];
  expected_outputs: string[];
  environment_policy_ref: string;
  verification_policy_ref: string;
  state: LegacyImportedTaskIntent;
  designated_assignment_id: string;
  source_kind: LegacyImportedTaskSource;
  non_executable: true;
  blocked_by_finding_ids: string[];
  legacy_module: PlanModuleT | null;
  legacy_graph_node: LegacyGraphNodeT | null;
  legacy_acceptance: AcceptanceCriterionT[];
}

export interface LegacyImportedTaskDependency {
  id: string;
  project_id: string;
  phase_id: string;
  predecessor_task_id: string;
  successor_task_id: string;
  source: "graph";
}

export interface LegacyHistoricalApprovalEvidence {
  id: string;
  project_id: string;
  phase_id: string;
  kind: "legacy_allocation";
  actor_type: "legacy";
  actor_id: null;
  source_actor_text: string;
  approved_at: string;
  content_hash: string;
  graph_version: number;
  allocation_fingerprint: string;
  current_at_freeze: boolean;
  eligible_as_v2_strategy_approval: false;
  source_hash: string;
}

export interface LegacyImportIdMapping {
  legacy_entity_type: string;
  legacy_id: string;
  v2_entity_type: string;
  v2_id: string;
  source_hash: string;
}

export interface LegacyProjectImportPlan {
  source_frozen_at: string;
  source_hash: string;
  legacy_graph_version: number | null;
  project: {
    id: string;
    name: string;
    description: string;
    status: "initializing" | "paused" | "blocked";
    created_at: string;
    updated_at: string;
    pm_provider: "anthropic" | "openai";
    pm_model: string | null;
    reviewer_provider: "anthropic" | "openai";
    source_type: "local" | "github" | null;
    source_location: string | null;
    max_executing_phases: 1;
    max_concurrent_tasks: 1;
    assignment_policy_ref: string;
    verification_policy_ref: string;
    budget_policy_ref: string;
  };
  phase: {
    id: string;
    project_id: string;
    objective_summary: string;
    priority: 0;
    status: "awaiting_approval";
    approved_strategy_version_id: null;
    approved_budget_usd: 0;
    created_at: string;
    updated_at: string;
  } | null;
  strategy: {
    id: string;
    project_id: string;
    phase_id: string;
    version: 1;
    status: "awaiting_approval";
    objective: string;
    convergence: "pending";
    review_rounds: 0;
    content_hash: string;
    approval_id: null;
    requires_fresh_v2_approval: true;
    content: {
      assumptions: string[];
      risks: { description: string; mitigation: string }[];
      out_of_scope: string[];
      source_plan_hash: string | null;
      source_graph_hash: string | null;
      proposed_objective_id: string;
      proposed_task_ids: string[];
      proposed_assignment_ids: string[];
      finding_ids: string[];
    };
    created_at: string;
    updated_at: string;
  } | null;
  objective: {
    id: string;
    project_id: string;
    phase_id: string;
    outcome: string;
    success_measures: string[];
    status: "proposed";
    order: 0;
    created_at: string;
    updated_at: string;
  } | null;
  tasks: LegacyImportedTask[];
  task_dependencies: LegacyImportedTaskDependency[];
  agent_profiles: LegacyImportedAgentProfile[];
  agent_assignments: LegacyImportedAssignment[];
  historical_approval: LegacyHistoricalApprovalEvidence | null;
  findings: LegacyProjectReconciliationFinding[];
  reconciliation: LegacyProjectReconciliationReport;
  id_mappings: LegacyImportIdMapping[];
}

export interface BuildLegacyProjectImportPlanOptions extends ReconcileLegacyProjectOptions {
  source_frozen_at: string;
}

function materializedId(
  kind: "objective" | "task" | "task-dependency" | "assignment",
  phaseId: string,
  ...localParts: string[]
): string {
  return [kind, phaseId, ...localParts].map(encodeURIComponent).join(":");
}

function deterministicId(kind: string, identity: unknown): string {
  return `${kind}:${canonicalSha256(identity)}`;
}

function reviewerFor(provider: "anthropic" | "openai"): "anthropic" | "openai" {
  return provider === "anthropic" ? "openai" : "anthropic";
}

function findingsForTask(
  findings: readonly LegacyProjectReconciliationFinding[],
  localId: string,
): string[] {
  return findings
    .filter(
      (entry) =>
        (entry.subject_type === "task" || entry.subject_type === "assignment") &&
        entry.subject_id === localId,
    )
    .map((entry) => entry.id)
    .sort();
}

function acceptanceStatements(
  module: PlanModuleT | null,
  node: LegacyGraphNodeT | null,
): { statements: string[]; exact: AcceptanceCriterionT[] } {
  const exact = module?.acceptance ?? node?.acceptance ?? [];
  if (exact.length > 0) {
    return { statements: exact.map((criterion) => criterion.statement), exact };
  }
  const id = node?.id ?? module?.id ?? "unknown";
  return {
    statements: [`Human supplies acceptance criteria for legacy graph-only node ${id}`],
    exact: [],
  };
}

function taskProfile(node: LegacyGraphNodeT | null): LegacyImportedAgentProfile {
  const identity =
    node?.assignment === null || node === null
      ? {
          provider: "legacy",
          model: "unassigned",
          runtime: "legacy-import",
          role: "implementation",
        }
      : {
          provider: node.assignment.provider,
          model: node.assignment.model,
          runtime: "legacy-import",
          role: "implementation",
        };
  return {
    id: deterministicId("agent-profile", identity),
    provider: identity.provider,
    model: identity.model,
    runtime: "legacy-import",
    roles: ["implementation"],
    status: "disabled",
    context_limit_tokens: 1,
    security_restrictions: ["legacy-import-not-executable"],
    source_hash: canonicalSha256(identity),
  };
}

function reviewerProfile(node: LegacyGraphNodeT | null): LegacyImportedAgentProfile | null {
  if (node?.assignment === null || node === null) return null;
  const identity = {
    provider: "legacy-unknown",
    model: node.assignment.reviewer_model,
    runtime: "legacy-import",
    role: "review",
  };
  return {
    id: deterministicId("agent-profile", identity),
    provider: identity.provider,
    model: identity.model,
    runtime: "legacy-import",
    roles: ["review"],
    status: "disabled",
    context_limit_tokens: 1,
    security_restrictions: ["legacy-import-not-executable"],
    source_hash: canonicalSha256(identity),
  };
}

function deduplicateProfiles(profiles: LegacyImportedAgentProfile[]): LegacyImportedAgentProfile[] {
  const byId = new Map<string, LegacyImportedAgentProfile>();
  for (const profile of profiles) byId.set(profile.id, profile);
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function currentApprovalAtFreeze(
  approval: LegacyAllocationApprovalT,
  findings: readonly LegacyProjectReconciliationFinding[],
): boolean {
  const invalidatingCodes = new Set([
    "assignment_changed_since_approval",
    "approval_graph_version_mismatch",
    "approval_content_hash_mismatch",
  ]);
  return !findings.some(
    (entry) => entry.subject_id === approval.content_hash && invalidatingCodes.has(entry.code),
  );
}

export function buildLegacyProjectImportPlan(
  source: LegacyProjectSnapshotT,
  options: BuildLegacyProjectImportPlanOptions,
): LegacyProjectImportPlan {
  const frozenAt = options.source_frozen_at;
  const analysis = analyzeLegacyProject(source, options);
  const { plan, graph, report } = analysis;
  const hasImportedPhase =
    source.plan !== null || source.graph !== null || plan !== null || graph !== null;
  const phaseId = `phase:legacy:${encodeURIComponent(source.id)}`;
  const strategyId = `strategy:legacy:${encodeURIComponent(source.id)}:${
    report.plan_hash ?? report.graph_hash ?? report.source_hash
  }`;
  const objectiveId = materializedId("objective", phaseId, "legacy-project-objective");
  const planById =
    plan === null
      ? new Map<string, PlanModuleT>()
      : new Map(plan.modules.map((module) => [module.id, module]));
  const graphById =
    graph === null
      ? new Map<string, LegacyGraphNodeT>()
      : new Map(graph.nodes.map((node) => [node.id, node]));
  const localIds = [...new Set([...planById.keys(), ...graphById.keys()])].sort();

  const profiles: LegacyImportedAgentProfile[] = [];
  const assignments: LegacyImportedAssignment[] = [];
  const tasks = localIds.map((localId): LegacyImportedTask => {
    const module = planById.get(localId) ?? null;
    const node = graphById.get(localId) ?? null;
    const graphIsUsable = graph !== null;
    const sourceKind: LegacyImportedTaskSource =
      module !== null && node !== null
        ? "plan_and_graph"
        : node !== null
          ? "graph_only"
          : graphIsUsable
            ? "plan_only_deleted"
            : "plan_unverified";
    const state: LegacyImportedTaskIntent =
      sourceKind === "plan_only_deleted" ? "cancelled" : "pending";
    const profile = taskProfile(node);
    const reviewer = reviewerProfile(node);
    profiles.push(profile);
    if (reviewer !== null) profiles.push(reviewer);

    const taskId = materializedId("task", phaseId, localId);
    const assignmentId = materializedId("assignment", phaseId, `legacy-assignment:${localId}`);
    const legacyAssignment = node?.assignment ?? null;
    assignments.push({
      id: assignmentId,
      project_id: source.id,
      phase_id: phaseId,
      task_id: taskId,
      agent_profile_id: profile.id,
      reviewer_agent_profile_id: reviewer?.id ?? null,
      status: state === "cancelled" ? "cancelled" : "proposed",
      rationale:
        legacyAssignment?.rationale ??
        `Legacy task ${localId} has no executable assignment; human reconciliation is required.`,
      rationale_factors: ["capability", "budget"],
      budget_limit_usd: legacyAssignment?.budget_usd ?? 0,
      allocation_policy_ref: `policy:legacy-allocation:${source.id}`,
      legacy_worker_count: legacyAssignment?.worker_count ?? 0,
      legacy_source: legacyAssignment?.source ?? "unassigned",
      source_hash: canonicalSha256(legacyAssignment),
      non_executable: true,
    });

    const acceptance = acceptanceStatements(module, node);
    const title = node?.title ?? module?.title ?? `Reconcile ${localId}`;
    const description =
      module?.description ??
      `Legacy graph-only node "${localId}" requires human reconciliation before execution.`;
    const deliverables = module?.deliverables ?? [`Reconcile legacy graph-only node ${localId}`];
    const expectedOutputs =
      module !== null && module.outputs.length > 0 ? module.outputs : deliverables;

    return {
      id: taskId,
      local_id: localId,
      project_id: source.id,
      phase_id: phaseId,
      objective_id: objectiveId,
      strategy_version_id: strategyId,
      title,
      description,
      deliverables: [...deliverables],
      acceptance_criteria: acceptance.statements,
      complexity: node?.complexity ?? module?.estimated_complexity ?? "M",
      risk: node?.risk ?? module?.risk ?? "high",
      required_roles: ["implementation"],
      required_capabilities: [],
      required_inputs: [],
      expected_outputs: [...expectedOutputs],
      environment_policy_ref: `policy:legacy-environment:${source.id}`,
      verification_policy_ref: `policy:legacy-verification:${source.id}`,
      state,
      designated_assignment_id: assignmentId,
      source_kind: sourceKind,
      non_executable: true,
      blocked_by_finding_ids: findingsForTask(report.findings, localId),
      legacy_module: module,
      legacy_graph_node: node,
      legacy_acceptance: acceptance.exact,
    };
  });

  const taskIdByLocalId = new Map(tasks.map((task) => [task.local_id, task.id]));
  const dependencies: LegacyImportedTaskDependency[] =
    graph === null
      ? []
      : graph.nodes
          .flatMap((node) =>
            node.dependencies.flatMap((predecessorLocalId) => {
              const predecessorTaskId = taskIdByLocalId.get(predecessorLocalId);
              const successorTaskId = taskIdByLocalId.get(node.id);
              if (predecessorTaskId === undefined || successorTaskId === undefined) return [];
              return [
                {
                  id: materializedId("task-dependency", phaseId, predecessorLocalId, node.id),
                  project_id: source.id,
                  phase_id: phaseId,
                  predecessor_task_id: predecessorTaskId,
                  successor_task_id: successorTaskId,
                  source: "graph" as const,
                },
              ];
            }),
          )
          .sort((left, right) => left.id.localeCompare(right.id));

  const successMeasures =
    plan?.modules.flatMap((module) => module.acceptance.map((criterion) => criterion.statement)) ??
    [];
  const objective = hasImportedPhase
    ? {
        id: objectiveId,
        project_id: source.id,
        phase_id: phaseId,
        outcome: plan?.objective ?? `Reconcile legacy project ${source.name}`,
        success_measures:
          successMeasures.length > 0
            ? successMeasures
            : [`Human reconciles legacy project ${source.name}`],
        status: "proposed" as const,
        order: 0 as const,
        created_at: frozenAt,
        updated_at: frozenAt,
      }
    : null;
  const uniqueProfiles = deduplicateProfiles(profiles);
  const hasStrategy = hasImportedPhase && tasks.length > 0;
  const strategyContent =
    hasImportedPhase && hasStrategy
      ? {
          assumptions: plan?.assumptions ?? [],
          risks: plan?.risks ?? [],
          out_of_scope: plan?.out_of_scope ?? [],
          source_plan_hash: report.plan_hash,
          source_graph_hash: report.graph_hash,
          proposed_objective_id: objectiveId,
          proposed_task_ids: tasks.map((task) => task.id),
          proposed_assignment_ids: assignments.map((assignment) => assignment.id).sort(),
          finding_ids: report.findings.map((entry) => entry.id),
        }
      : null;
  const strategy =
    strategyContent === null
      ? null
      : {
          id: strategyId,
          project_id: source.id,
          phase_id: phaseId,
          version: 1 as const,
          status: "awaiting_approval" as const,
          objective: objective?.outcome ?? `Reconcile legacy project ${source.name}`,
          convergence: "pending" as const,
          review_rounds: 0 as const,
          content_hash: canonicalSha256(strategyContent),
          approval_id: null,
          requires_fresh_v2_approval: true as const,
          content: strategyContent,
          created_at: frozenAt,
          updated_at: frozenAt,
        };
  const hasBlockingFinding = report.findings.some((entry) => entry.severity === "blocking");
  const projectStatus = !hasImportedPhase
    ? "initializing"
    : hasBlockingFinding
      ? "blocked"
      : "paused";

  const historicalApproval =
    analysis.approval === null || !hasImportedPhase
      ? null
      : {
          id: deterministicId("legacy-approval", {
            project_id: source.id,
            approval: analysis.approval,
          }),
          project_id: source.id,
          phase_id: phaseId,
          kind: "legacy_allocation" as const,
          actor_type: "legacy" as const,
          actor_id: null,
          source_actor_text: analysis.approval.actor,
          approved_at: analysis.approval.approved_at,
          content_hash: analysis.approval.content_hash,
          graph_version: analysis.approval.graph_version,
          allocation_fingerprint: analysis.approval.allocation_fingerprint,
          current_at_freeze:
            analysis.graph !== null && currentApprovalAtFreeze(analysis.approval, report.findings),
          eligible_as_v2_strategy_approval: false as const,
          source_hash: canonicalSha256(analysis.approval),
        };

  const mappings: LegacyImportIdMapping[] = [
    {
      legacy_entity_type: "project",
      legacy_id: source.id,
      v2_entity_type: "project",
      v2_id: source.id,
      source_hash: report.source_hash,
    },
  ];
  if (hasImportedPhase) {
    mappings.push(
      {
        legacy_entity_type: "project_initial_phase",
        legacy_id: `${source.id}#initial-phase`,
        v2_entity_type: "phase",
        v2_id: phaseId,
        source_hash: report.source_hash,
      },
      {
        legacy_entity_type: "project_objective",
        legacy_id: `${source.id}#objective`,
        v2_entity_type: "objective",
        v2_id: objectiveId,
        source_hash: report.plan_hash ?? report.source_hash,
      },
    );
  }
  if (strategy !== null) {
    mappings.push({
      legacy_entity_type: "project_strategy",
      legacy_id: `${source.id}#strategy`,
      v2_entity_type: "strategy_version",
      v2_id: strategyId,
      source_hash: report.plan_hash ?? report.graph_hash ?? report.source_hash,
    });
  }
  for (const task of tasks) {
    mappings.push({
      legacy_entity_type: "project_task_identity",
      legacy_id: `${source.id}#${task.local_id}`,
      v2_entity_type: "task",
      v2_id: task.id,
      source_hash: canonicalSha256({
        module: task.legacy_module,
        node: task.legacy_graph_node,
      }),
    });
  }
  for (const assignment of assignments) {
    mappings.push({
      legacy_entity_type: "project_assignment",
      legacy_id: `${source.id}#${assignment.task_id}`,
      v2_entity_type: "agent_assignment",
      v2_id: assignment.id,
      source_hash: assignment.source_hash,
    });
  }
  if (historicalApproval !== null) {
    mappings.push({
      legacy_entity_type: "allocation_approval",
      legacy_id: `${source.id}#${historicalApproval.content_hash}`,
      v2_entity_type: "legacy_approval_evidence",
      v2_id: historicalApproval.id,
      source_hash: historicalApproval.source_hash,
    });
  }

  return {
    source_frozen_at: frozenAt,
    source_hash: report.source_hash,
    legacy_graph_version: analysis.graph?.version ?? null,
    project: {
      id: source.id,
      name: source.name,
      description: source.description,
      status: projectStatus,
      created_at: source.createdAt,
      updated_at: frozenAt,
      pm_provider: source.pmProvider,
      pm_model: source.pmModel ?? null,
      reviewer_provider: reviewerFor(source.pmProvider),
      source_type: source.sourceType ?? null,
      source_location: source.sourceLocation ?? null,
      max_executing_phases: 1,
      max_concurrent_tasks: 1,
      assignment_policy_ref: `policy:legacy-assignment:${source.id}`,
      verification_policy_ref: `policy:legacy-verification:${source.id}`,
      budget_policy_ref: `policy:legacy-budget:${source.id}`,
    },
    phase: hasImportedPhase
      ? {
          id: phaseId,
          project_id: source.id,
          objective_summary: plan?.objective ?? `Reconcile legacy project ${source.name}`,
          priority: 0,
          status: "awaiting_approval",
          approved_strategy_version_id: null,
          approved_budget_usd: 0,
          created_at: frozenAt,
          updated_at: frozenAt,
        }
      : null,
    strategy,
    objective,
    tasks,
    task_dependencies: dependencies,
    agent_profiles: uniqueProfiles,
    agent_assignments: assignments.sort((left, right) => left.id.localeCompare(right.id)),
    historical_approval: historicalApproval,
    findings: report.findings,
    reconciliation: report,
    id_mappings: mappings.sort(
      (left, right) =>
        left.v2_entity_type.localeCompare(right.v2_entity_type) ||
        left.v2_id.localeCompare(right.v2_id),
    ),
  };
}
