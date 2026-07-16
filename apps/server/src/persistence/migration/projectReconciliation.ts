import { createHash } from "node:crypto";
import type { PlanContractT, PlanModuleT, V2MigrationFindingCodeT } from "@norns/contracts";
import { canonicalJson, canonicalSha256 } from "./canonicalJson.js";
import {
  type LegacyAllocationApprovalT,
  type LegacyGraphNodeT,
  type LegacyGraphSnapshotT,
  type LegacyProjectSnapshotT,
  parseLegacyProjectPayloads,
} from "./legacyProjectSchemas.js";

export const LEGACY_PROJECT_RECONCILIATION_CODES = [
  "invalid_plan_payload",
  "invalid_graph_payload",
  "invalid_approval_payload",
  "plan_without_graph",
  "graph_without_plan",
  "graph_node_without_plan_module",
  "plan_module_without_graph_node",
  "shared_task_field_mismatch",
  "acceptance_criteria_unavailable",
  "acceptance_criteria_projection_mismatch",
  "dependency_edge_added_in_graph",
  "dependency_edge_removed_from_graph",
  "orphan_dependency_reference",
  "assignment_missing",
  "assignment_worker_count_requires_reconciliation",
  "assignment_changed_since_approval",
  "approval_graph_version_mismatch",
  "approval_content_hash_mismatch",
  "approval_actor_unattributable",
] as const satisfies readonly V2MigrationFindingCodeT[];

export type LegacyProjectReconciliationCode = (typeof LEGACY_PROJECT_RECONCILIATION_CODES)[number];
export type LegacyProjectFindingSeverity = "blocking" | "warning";
export type LegacyProjectFindingSubject =
  | "project"
  | "plan"
  | "graph"
  | "task"
  | "dependency"
  | "assignment"
  | "approval";

export interface LegacyProjectReconciliationFinding {
  id: string;
  code: LegacyProjectReconciliationCode;
  severity: LegacyProjectFindingSeverity;
  status: "open";
  project_id: string;
  subject_type: LegacyProjectFindingSubject;
  subject_id: string;
  summary: string;
  details: Record<string, unknown>;
}

export interface LegacyProjectReconciliationReport {
  project_id: string;
  source_hash: string;
  plan_hash: string | null;
  graph_hash: string | null;
  approval_hash: string | null;
  counts: {
    plan_modules: number;
    graph_nodes: number;
    graph_edges: number;
    graph_assignments: number;
  };
  findings: LegacyProjectReconciliationFinding[];
  clean: boolean;
  requires_fresh_v2_approval: boolean;
}

export interface LegacyProjectAnalysis {
  source: LegacyProjectSnapshotT;
  plan: PlanContractT | null;
  graph: LegacyGraphSnapshotT | null;
  approval: LegacyAllocationApprovalT | null;
  duplicate_graph_node_ids: string[];
  report: LegacyProjectReconciliationReport;
}

export interface ReconcileLegacyProjectOptions {
  attributable_user_ids?: ReadonlySet<string>;
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function duplicateIds(nodes: readonly LegacyGraphNodeT[]): string[] {
  const counts = new Map<string, number>();
  for (const node of nodes) counts.set(node.id, (counts.get(node.id) ?? 0) + 1);
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([id]) => id)
    .sort();
}

function edgeKey(predecessorId: string, successorId: string): string {
  return `${predecessorId}\u0000${successorId}`;
}

function edgeSubjectId(key: string): string {
  const [predecessorId = "", successorId = ""] = key.split("\u0000");
  return `${predecessorId}->${successorId}`;
}

function planEdges(plan: PlanContractT): Set<string> {
  return new Set(
    plan.modules.flatMap((module) =>
      module.dependencies.map((dependencyId) => edgeKey(dependencyId, module.id)),
    ),
  );
}

function graphEdges(graph: LegacyGraphSnapshotT): Set<string> {
  return new Set(
    graph.nodes.flatMap((node) =>
      node.dependencies.map((dependencyId) => edgeKey(dependencyId, node.id)),
    ),
  );
}

function legacyAllocationFingerprint(graph: LegacyGraphSnapshotT): string {
  const canonical = JSON.stringify(
    [...graph.nodes]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((node) => ({ id: node.id, assignment: node.assignment })),
  );
  return sha256Text(canonical);
}

function legacyAllocationContentHash(graph: LegacyGraphSnapshotT): string | null {
  if (graph.nodes.some((node) => node.assignment === null)) return null;
  const totalUsd =
    Math.round(
      graph.nodes.reduce((total, node) => total + (node.assignment?.budget_usd ?? 0), 0) * 100,
    ) / 100;
  const canonical = JSON.stringify({
    graph_version: graph.version,
    nodes: [...graph.nodes]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((node) => ({
        id: node.id,
        dependencies: [...node.dependencies].sort(),
        assignment: node.assignment,
      })),
    total_usd: totalUsd,
  });
  return sha256Text(canonical);
}

function finding(input: {
  projectId: string;
  code: LegacyProjectReconciliationCode;
  severity?: LegacyProjectFindingSeverity;
  subjectType: LegacyProjectFindingSubject;
  subjectId: string;
  summary: string;
  details?: Record<string, unknown>;
}): LegacyProjectReconciliationFinding {
  const details = input.details ?? {};
  const identity = {
    project_id: input.projectId,
    code: input.code,
    subject_type: input.subjectType,
    subject_id: input.subjectId,
    details,
  };
  return {
    id: `migration-finding:${canonicalSha256(identity)}`,
    code: input.code,
    severity: input.severity ?? "blocking",
    status: "open",
    project_id: input.projectId,
    subject_type: input.subjectType,
    subject_id: input.subjectId,
    summary: input.summary,
    details,
  };
}

function compareSharedFields(
  projectId: string,
  module: PlanModuleT,
  node: LegacyGraphNodeT,
): LegacyProjectReconciliationFinding[] {
  const differences: Record<string, { plan: unknown; graph: unknown }> = {};
  if (module.title !== node.title) {
    differences.title = { plan: module.title, graph: node.title };
  }
  if (module.estimated_complexity !== node.complexity) {
    differences.complexity = {
      plan: module.estimated_complexity,
      graph: node.complexity,
    };
  }
  if (module.risk !== node.risk) {
    differences.risk = { plan: module.risk, graph: node.risk };
  }
  if (module.parallelization.safe !== node.parallel_safe) {
    differences.parallel_safe = {
      plan: module.parallelization.safe,
      graph: node.parallel_safe,
    };
  }

  const results: LegacyProjectReconciliationFinding[] = [];
  if (Object.keys(differences).length > 0) {
    results.push(
      finding({
        projectId,
        code: "shared_task_field_mismatch",
        subjectType: "task",
        subjectId: module.id,
        summary: `Plan module and graph node ${module.id} disagree on shared task fields`,
        details: { differences, selected_source: "graph" },
      }),
    );
  }
  if (
    node.acceptance !== undefined &&
    canonicalJson(node.acceptance) !== canonicalJson(module.acceptance)
  ) {
    results.push(
      finding({
        projectId,
        code: "acceptance_criteria_projection_mismatch",
        subjectType: "task",
        subjectId: module.id,
        summary: `Plan and historical graph acceptance criteria differ for ${module.id}`,
        details: {
          plan_acceptance_hash: canonicalSha256(module.acceptance),
          graph_acceptance_hash: canonicalSha256(node.acceptance),
          selected_source: "plan",
        },
      }),
    );
  }
  return results;
}

function sortFindings(
  findings: LegacyProjectReconciliationFinding[],
): LegacyProjectReconciliationFinding[] {
  return findings.sort(
    (left, right) =>
      left.code.localeCompare(right.code) ||
      left.subject_type.localeCompare(right.subject_type) ||
      left.subject_id.localeCompare(right.subject_id) ||
      left.id.localeCompare(right.id),
  );
}

export function analyzeLegacyProject(
  source: LegacyProjectSnapshotT,
  options: ReconcileLegacyProjectOptions = {},
): LegacyProjectAnalysis {
  const parsed = parseLegacyProjectPayloads(source);
  const duplicates = parsed.graph === null ? [] : duplicateIds(parsed.graph.nodes);
  const usableGraph =
    parsed.graph !== null && parsed.graph_valid && duplicates.length === 0 ? parsed.graph : null;
  const findings: LegacyProjectReconciliationFinding[] = [];

  if (!parsed.plan_valid) {
    findings.push(
      finding({
        projectId: source.id,
        code: "invalid_plan_payload",
        subjectType: "plan",
        subjectId: source.id,
        summary: "Legacy plan payload failed PlanContract validation",
      }),
    );
  }
  if (!parsed.graph_valid || duplicates.length > 0) {
    findings.push(
      finding({
        projectId: source.id,
        code: "invalid_graph_payload",
        subjectType: "graph",
        subjectId: source.id,
        summary: "Legacy graph payload is invalid or contains duplicate node IDs",
        details: { duplicate_node_ids: duplicates },
      }),
    );
  }
  if (!parsed.approval_valid) {
    findings.push(
      finding({
        projectId: source.id,
        code: "invalid_approval_payload",
        subjectType: "approval",
        subjectId: source.id,
        summary: "Legacy allocation approval payload is invalid",
      }),
    );
  }
  if (parsed.plan !== null && source.graph === null) {
    findings.push(
      finding({
        projectId: source.id,
        code: "plan_without_graph",
        subjectType: "project",
        subjectId: source.id,
        summary: "Planned legacy project has no persisted graph",
      }),
    );
  }
  if (parsed.plan === null && source.plan === null && source.graph !== null) {
    findings.push(
      finding({
        projectId: source.id,
        code: "graph_without_plan",
        subjectType: "project",
        subjectId: source.id,
        summary: "Legacy project has a graph but no plan",
      }),
    );
  }

  if (parsed.plan !== null && usableGraph !== null) {
    const planIds = new Set(parsed.plan.modules.map((module) => module.id));
    const graphIds = new Set(usableGraph.nodes.map((node) => node.id));
    const planById = new Map(parsed.plan.modules.map((module) => [module.id, module]));
    const graphById = new Map(usableGraph.nodes.map((node) => [node.id, node]));

    for (const nodeId of [...graphIds].filter((id) => !planIds.has(id)).sort()) {
      const node = graphById.get(nodeId);
      findings.push(
        finding({
          projectId: source.id,
          code: "graph_node_without_plan_module",
          subjectType: "task",
          subjectId: nodeId,
          summary: `Graph node ${nodeId} has no matching plan module`,
        }),
      );
      if (node?.acceptance === undefined || node.acceptance.length === 0) {
        findings.push(
          finding({
            projectId: source.id,
            code: "acceptance_criteria_unavailable",
            subjectType: "task",
            subjectId: nodeId,
            summary: `Graph-only node ${nodeId} has no acceptance criteria`,
          }),
        );
      }
    }
    for (const moduleId of [...planIds].filter((id) => !graphIds.has(id)).sort()) {
      findings.push(
        finding({
          projectId: source.id,
          code: "plan_module_without_graph_node",
          subjectType: "task",
          subjectId: moduleId,
          summary: `Plan module ${moduleId} is absent from the current graph`,
          details: { imported_task_intent: "cancelled" },
        }),
      );
    }
    for (const id of [...planIds].filter((candidate) => graphIds.has(candidate)).sort()) {
      const module = planById.get(id);
      const node = graphById.get(id);
      if (module !== undefined && node !== undefined) {
        findings.push(...compareSharedFields(source.id, module, node));
      }
    }

    const planEdgeSet = planEdges(parsed.plan);
    const graphEdgeSet = graphEdges(usableGraph);
    for (const key of [...graphEdgeSet].filter((edge) => !planEdgeSet.has(edge)).sort()) {
      findings.push(
        finding({
          projectId: source.id,
          code: "dependency_edge_added_in_graph",
          subjectType: "dependency",
          subjectId: edgeSubjectId(key),
          summary: `Current graph contains dependency ${edgeSubjectId(key)} absent from the plan`,
          details: { selected_source: "graph" },
        }),
      );
    }
    for (const key of [...planEdgeSet].filter((edge) => !graphEdgeSet.has(edge)).sort()) {
      findings.push(
        finding({
          projectId: source.id,
          code: "dependency_edge_removed_from_graph",
          subjectType: "dependency",
          subjectId: edgeSubjectId(key),
          summary: `Plan dependency ${edgeSubjectId(key)} is absent from the current graph`,
          details: { selected_source: "graph" },
        }),
      );
    }
  }

  if (usableGraph !== null) {
    const graphIds = new Set(usableGraph.nodes.map((node) => node.id));
    for (const node of [...usableGraph.nodes].sort((a, b) => a.id.localeCompare(b.id))) {
      for (const dependencyId of [...node.dependencies].sort()) {
        if (!graphIds.has(dependencyId)) {
          findings.push(
            finding({
              projectId: source.id,
              code: "orphan_dependency_reference",
              subjectType: "dependency",
              subjectId: `${dependencyId}->${node.id}`,
              summary: `Graph dependency ${dependencyId}->${node.id} references a missing node`,
            }),
          );
        }
      }
      if (node.assignment === null) {
        findings.push(
          finding({
            projectId: source.id,
            code: "assignment_missing",
            severity: "warning",
            subjectType: "assignment",
            subjectId: node.id,
            summary: `Graph node ${node.id} has no allocation`,
          }),
        );
      } else if (node.assignment.worker_count > 1) {
        findings.push(
          finding({
            projectId: source.id,
            code: "assignment_worker_count_requires_reconciliation",
            subjectType: "assignment",
            subjectId: node.id,
            summary: `Legacy worker count for ${node.id} cannot map to one V2 assignment`,
            details: { legacy_worker_count: node.assignment.worker_count },
          }),
        );
      }
    }
  }

  if (parsed.approval !== null && usableGraph !== null) {
    const currentFingerprint = legacyAllocationFingerprint(usableGraph);
    if (parsed.approval.graph_version !== usableGraph.version) {
      findings.push(
        finding({
          projectId: source.id,
          code: "approval_graph_version_mismatch",
          subjectType: "approval",
          subjectId: parsed.approval.content_hash,
          summary: "Legacy allocation approval references a stale graph version",
          details: {
            approved_graph_version: parsed.approval.graph_version,
            current_graph_version: usableGraph.version,
          },
        }),
      );
    }
    if (parsed.approval.allocation_fingerprint !== currentFingerprint) {
      findings.push(
        finding({
          projectId: source.id,
          code: "assignment_changed_since_approval",
          subjectType: "approval",
          subjectId: parsed.approval.content_hash,
          summary: "Current assignments differ from the approved allocation fingerprint",
          details: {
            approved_allocation_fingerprint: parsed.approval.allocation_fingerprint,
            current_allocation_fingerprint: currentFingerprint,
          },
        }),
      );
    }
    const currentContentHash = legacyAllocationContentHash(usableGraph);
    if (currentContentHash === null || parsed.approval.content_hash !== currentContentHash) {
      findings.push(
        finding({
          projectId: source.id,
          code: "approval_content_hash_mismatch",
          subjectType: "approval",
          subjectId: parsed.approval.content_hash,
          summary: "Legacy allocation approval content hash is not current",
          details: {
            approved_content_hash: parsed.approval.content_hash,
            current_content_hash: currentContentHash,
          },
        }),
      );
    }
    if (!options.attributable_user_ids?.has(parsed.approval.actor)) {
      findings.push(
        finding({
          projectId: source.id,
          code: "approval_actor_unattributable",
          subjectType: "approval",
          subjectId: parsed.approval.content_hash,
          summary: "Legacy approval actor is not a proven authenticated user ID",
          details: { source_actor_text: parsed.approval.actor },
        }),
      );
    }
  }

  const sortedFindings = sortFindings(findings);
  const graphEdgeCount =
    parsed.graph?.nodes.reduce((total, node) => total + node.dependencies.length, 0) ?? 0;
  const report: LegacyProjectReconciliationReport = {
    project_id: source.id,
    source_hash: canonicalSha256(source),
    plan_hash: source.plan === null ? null : canonicalSha256(source.plan),
    graph_hash: source.graph === null ? null : canonicalSha256(source.graph),
    approval_hash: source.approval === null ? null : canonicalSha256(source.approval),
    counts: {
      plan_modules: parsed.plan?.modules.length ?? 0,
      graph_nodes: parsed.graph?.nodes.length ?? 0,
      graph_edges: graphEdgeCount,
      graph_assignments: parsed.graph?.nodes.filter((node) => node.assignment !== null).length ?? 0,
    },
    findings: sortedFindings,
    clean: sortedFindings.length === 0,
    requires_fresh_v2_approval: parsed.plan !== null,
  };

  return {
    source,
    plan: parsed.plan,
    graph: usableGraph,
    approval: parsed.approval,
    duplicate_graph_node_ids: duplicates,
    report,
  };
}

export function reconcileLegacyProject(
  source: LegacyProjectSnapshotT,
  options: ReconcileLegacyProjectOptions = {},
): LegacyProjectReconciliationReport {
  return analyzeLegacyProject(source, options).report;
}
