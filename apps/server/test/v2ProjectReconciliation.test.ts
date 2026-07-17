import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  LegacyProjectSnapshot,
  type LegacyProjectSnapshotT,
} from "../src/persistence/migration/legacyProjectSchemas.js";
import {
  analyzeLegacyProject,
  reconcileLegacyProject,
} from "../src/persistence/migration/projectReconciliation.js";

function fixture(name: string): LegacyProjectSnapshotT {
  return LegacyProjectSnapshot.parse(
    JSON.parse(
      readFileSync(new URL(`./fixtures/phase2/projects/${name}.json`, import.meta.url), "utf8"),
    ),
  );
}

function codes(name: string): string[] {
  return reconcileLegacyProject(fixture(name)).findings.map((entry) => entry.code);
}

describe("Phase 2 legacy project reconciliation", () => {
  it("accounts for a clean draft without fabricating a finding or planned phase", () => {
    const source = fixture("clean-draft");
    const report = reconcileLegacyProject(source);
    expect(report).toMatchObject({
      project_id: "proj-clean-draft",
      clean: true,
      requires_fresh_v2_approval: false,
      findings: [],
      counts: { plan_modules: 0, graph_nodes: 0, graph_edges: 0, graph_assignments: 0 },
    });
  });

  it.each([
    ["changed-shared-fields", "shared_task_field_mismatch"],
    ["edge-added", "dependency_edge_added_in_graph"],
    ["orphan-dependency", "orphan_dependency_reference"],
    ["unattributable-actor", "approval_actor_unattributable"],
    ["multi-worker-assignment", "assignment_worker_count_requires_reconciliation"],
    ["invalid-plan", "invalid_plan_payload"],
    ["duplicate-graph-node", "invalid_graph_payload"],
  ] as const)("fixture %s emits its distinct %s finding", (name, expectedCode) => {
    expect(codes(name)).toContain(expectedCode);
  });

  it("uses a dedicated fixture to detect a tampered approval content hash", () => {
    const report = reconcileLegacyProject(fixture("tampered-approval-hash"), {
      attributable_user_ids: new Set(["user-known"]),
    });
    const resultCodes = report.findings.map((entry) => entry.code);
    expect(resultCodes).toContain("approval_content_hash_mismatch");
    expect(resultCodes).not.toContain("approval_actor_unattributable");
    expect(resultCodes).not.toContain("approval_graph_version_mismatch");
    expect(resultCodes).not.toContain("assignment_changed_since_approval");
  });

  it("emits distinct graph-only and missing-acceptance findings", () => {
    expect(codes("graph-only-node")).toEqual(
      expect.arrayContaining([
        "graph_node_without_plan_module",
        "acceptance_criteria_unavailable",
        "dependency_edge_added_in_graph",
      ]),
    );
  });

  it("distinguishes a deleted plan module from a changed dependency edge", () => {
    expect(codes("deleted-module")).toContain("plan_module_without_graph_node");
    expect(codes("changed-edge")).toContain("dependency_edge_removed_from_graph");
    expect(codes("changed-edge")).not.toContain("plan_module_without_graph_node");
  });

  it("classifies assignment changes separately from structural approval staleness", () => {
    const assignmentCodes = codes("changed-assignment");
    expect(assignmentCodes).toContain("assignment_changed_since_approval");
    expect(assignmentCodes).not.toContain("approval_graph_version_mismatch");

    const staleCodes = codes("stale-approval");
    expect(staleCodes).toContain("approval_graph_version_mismatch");
    expect(staleCodes).not.toContain("assignment_changed_since_approval");
  });

  it("uses legacy actor provenance unless a historical user ID is independently proven", () => {
    const source = fixture("stale-approval");
    expect(codes("stale-approval")).toContain("approval_actor_unattributable");
    const proven = reconcileLegacyProject(source, {
      attributable_user_ids: new Set(["operator"]),
    });
    expect(proven.findings.map((entry) => entry.code)).not.toContain(
      "approval_actor_unattributable",
    );
  });

  it("treats semantic PlanContract failures as invalid plan payloads", () => {
    const source = fixture("clean-planned");
    const module = (source.plan as { modules: { dependencies: string[] }[] }).modules[0];
    if (module === undefined) throw new Error("fixture requires a module");
    module.dependencies = ["ghost"];
    expect(
      reconcileLegacyProject(source).findings.some(
        (entry) => entry.code === "invalid_plan_payload",
      ),
    ).toBe(true);
  });

  it("detects duplicate graph IDs before building identity maps", () => {
    const source = fixture("clean-planned");
    const graph = source.graph as { nodes: unknown[] };
    const first = graph.nodes[0];
    if (first === undefined) throw new Error("fixture requires a graph node");
    graph.nodes.push(structuredClone(first));

    const analysis = analyzeLegacyProject(source);
    expect(analysis.duplicate_graph_node_ids).toEqual(["a"]);
    expect(analysis.graph).toBeNull();
    expect(analysis.report.findings).toMatchObject([
      expect.objectContaining({
        code: "invalid_graph_payload",
        details: { duplicate_node_ids: ["a"] },
      }),
    ]);
  });

  it("detects a real historical acceptance value and an unsupported worker count", () => {
    const source = fixture("changed-assignment");
    const graph = source.graph as {
      nodes: {
        acceptance?: unknown[];
        assignment: { worker_count: number } | null;
      }[];
    };
    const node = graph.nodes[0];
    if (node === undefined || node.assignment === null) {
      throw new Error("fixture requires an assigned graph node");
    }
    node.acceptance = [
      {
        id: "AC-A",
        statement: "A different historical criterion",
        verification_type: "inspection",
        verification: "Inspect it",
      },
    ];
    node.assignment.worker_count = 2;

    const resultCodes = reconcileLegacyProject(source).findings.map((entry) => entry.code);
    expect(resultCodes).toContain("acceptance_criteria_projection_mismatch");
    expect(resultCodes).toContain("assignment_worker_count_requires_reconciliation");
  });

  it("is byte-for-byte deterministic for the same frozen source", () => {
    const source = fixture("graph-only-node");
    expect(reconcileLegacyProject(source)).toEqual(reconcileLegacyProject(source));

    const report = reconcileLegacyProject(source);
    const sorted = [...report.findings].sort(
      (left, right) =>
        left.code.localeCompare(right.code) ||
        left.subject_type.localeCompare(right.subject_type) ||
        left.subject_id.localeCompare(right.subject_id),
    );
    expect(report.findings).toEqual(sorted);
  });
});
