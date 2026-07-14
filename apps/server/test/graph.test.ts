// Phase 4 exit: a 10-node graph is editable (acyclicity with offending path,
// re-parent/cascade deletion, post-start edit restrictions, version bumps)
// and auto-allocates under each strategy with persisting human overrides,
// cost preview, and hashed allocation approval.
import type { NodeState } from "@norns/contracts";
import { describe, expect, it } from "vitest";
import {
  AllocationError,
  approveAllocation,
  autoAllocate,
  costPreview,
  overrideAssignment,
} from "../src/graph/allocation.js";
import { GraphEditError } from "../src/graph/graph.js";
import { GraphSession } from "../src/graph/session.js";

function demoGraph() {
  return GraphSession.demo().graph;
}

describe("workflow graph editing", () => {
  it("converts the 10-node demo plan deterministically", () => {
    const graph = demoGraph();
    const snapshot = graph.snapshot();
    expect(snapshot.nodes).toHaveLength(10);
    expect(snapshot.version).toBe(1);
    expect(graph.node("integration-layer")?.dependencies).toEqual(["api-core", "worker-queue"]);
  });

  it("rejects cycle-creating edges atomically and names the offending path", () => {
    const graph = demoGraph();
    const before = graph.version;
    let caught: GraphEditError | null = null;
    try {
      graph.addEdge("release", "contracts"); // release depends on everything
    } catch (error) {
      caught = error as GraphEditError;
    }
    expect(caught?.code).toBe("cycle");
    expect(caught?.cyclePath?.length).toBeGreaterThan(2);
    expect(caught?.message).toContain("->");
    // atomic: the edge was not applied, the version did not change
    expect(graph.node("contracts")?.dependencies).toEqual([]);
    expect(graph.version).toBe(before);
  });

  it("bumps the graph version on every structural edit", () => {
    const graph = demoGraph();
    graph.addNode({ id: "docs", title: "Docs" });
    expect(graph.version).toBe(2);
    graph.addEdge("release", "docs"); // docs depends on release
    expect(graph.version).toBe(3);
    graph.removeEdge("release", "docs");
    expect(graph.version).toBe(4);
    graph.removeNode("docs");
    expect(graph.version).toBe(5);
  });

  it("requires an explicit mode to delete a node with dependents", () => {
    const graph = demoGraph();
    expect(() => graph.removeNode("api-core")).toThrow(GraphEditError);
    try {
      graph.removeNode("api-core");
    } catch (error) {
      expect((error as GraphEditError).code).toBe("has_dependents");
      expect((error as GraphEditError).message).toContain("reparent");
    }
  });

  it("reparent grafts the removed node's dependencies onto its dependents", () => {
    const graph = demoGraph();
    graph.removeNode("api-core", "reparent"); // deps were db-schema + auth
    const integration = graph.node("integration-layer");
    expect(integration?.dependencies.sort()).toEqual(["auth", "db-schema", "worker-queue"]);
    expect(graph.node("web-ui")?.dependencies.sort()).toEqual(["auth", "db-schema"]);
  });

  it("cascade removes dependents transitively", () => {
    const graph = demoGraph();
    const removed = graph.removeNode("api-core", "cascade");
    // api-core -> integration-layer, web-ui -> observability, release
    expect(removed.sort()).toEqual(
      ["api-core", "integration-layer", "observability", "release", "web-ui"].sort(),
    );
    expect(graph.snapshot().nodes).toHaveLength(5);
  });

  it("restricts edits to not-yet-started nodes once execution begins", () => {
    const graph = demoGraph();
    const states: Record<string, NodeState> = { contracts: "running", "db-schema": "ready" };
    graph.attachStateLookup((id) => states[id] ?? "pending");
    graph.markExecutionStarted();

    // started node: no new inputs, no removal
    expect(() => graph.addEdge("auth", "contracts")).toThrow(/not-yet-started/);
    expect(() => graph.removeNode("contracts", "reparent")).toThrow(/not-yet-started/);
    // not-yet-started node: still editable
    graph.addEdge("auth", "db-schema");
    expect(graph.node("db-schema")?.dependencies).toContain("auth");
  });
});

describe("allocation engine — three strategies over the 10-node graph", () => {
  it("auto-allocates every node under each strategy with sane budgets", () => {
    for (const strategy of ["quality", "balanced", "cost"] as const) {
      const graph = demoGraph();
      autoAllocate(graph, strategy);
      const nodes = graph.snapshot().nodes;
      expect(nodes.every((n) => n.assignment !== null)).toBe(true);
      for (const node of nodes) {
        expect(node.assignment?.budget_usd).toBeGreaterThan(0);
        expect(node.assignment?.rationale).toContain(strategy);
        expect(node.assignment?.reviewer_model).toBe("openai-reasoning-default"); // cross-provider
      }
    }
  });

  it("strategies order budgets and pick model tiers as documented", () => {
    const budgets: Record<string, number> = {};
    const models: Record<string, string> = {};
    for (const strategy of ["quality", "balanced", "cost"] as const) {
      const graph = demoGraph();
      autoAllocate(graph, strategy);
      const apiCore = graph.node("api-core"); // complexity L
      const auth = graph.node("auth"); // complexity S
      budgets[strategy] = apiCore?.assignment?.budget_usd ?? 0;
      models[`${strategy}-L`] = apiCore?.assignment?.model ?? "";
      models[`${strategy}-S`] = auth?.assignment?.model ?? "";
    }
    expect(budgets.quality).toBeGreaterThan(budgets.balanced ?? 0);
    expect(budgets.balanced).toBeGreaterThan(budgets.cost ?? 0);
    expect(models["quality-L"]).toBe("claude-opus-4-8");
    expect(models["balanced-L"]).toBe("claude-opus-4-8");
    expect(models["balanced-S"]).toBe("claude-sonnet-5");
    expect(models["cost-S"]).toBe("claude-haiku-4-5");
  });

  it("caps parallel-safe hard nodes at the pilot worker limit", () => {
    const graph = demoGraph();
    autoAllocate(graph, "balanced");
    expect(graph.node("integration-layer")?.assignment?.worker_count).toBe(2); // XL, parallel-safe
    expect(graph.node("web-ui")?.assignment?.worker_count).toBe(2); // L, parallel-safe
    expect(graph.node("api-core")?.assignment?.worker_count).toBe(1); // L, not parallel-safe
  });

  it("human overrides persist across re-allocation", () => {
    const graph = demoGraph();
    autoAllocate(graph, "balanced");
    overrideAssignment(graph, "auth", { model: "claude-opus-4-8", budget_usd: 99 });

    autoAllocate(graph, "cost"); // re-run under a different strategy
    const auth = graph.node("auth");
    expect(auth?.assignment?.source).toBe("override");
    expect(auth?.assignment?.model).toBe("claude-opus-4-8");
    expect(auth?.assignment?.budget_usd).toBe(99);
    // non-overridden nodes did move to the new strategy
    expect(graph.node("db-schema")?.assignment?.rationale).toContain("cost");
  });

  it("cost preview totals per-node budgets and lists unallocated nodes", () => {
    const graph = demoGraph();
    let preview = costPreview(graph);
    expect(preview.unallocated).toHaveLength(10);
    expect(preview.total_usd).toBe(0);

    autoAllocate(graph, "balanced");
    preview = costPreview(graph);
    expect(preview.unallocated).toHaveLength(0);
    const sum =
      Math.round(
        preview.per_node.reduce((total, entry) => total + (entry.budget_usd ?? 0), 0) * 100,
      ) / 100;
    expect(preview.total_usd).toBe(sum);
  });

  it("refuses to approve a partial allocation; approves a full one with a hash", () => {
    const graph = demoGraph();
    expect(() => approveAllocation(graph, "dhatwell")).toThrow(AllocationError);

    autoAllocate(graph, "balanced");
    const approval = approveAllocation(graph, "dhatwell");
    expect(approval.kind).toBe("allocation");
    expect(approval.content_hash).toMatch(/^[a-f0-9]{64}$/);

    // the hash binds to what was shown: changing an assignment changes it
    overrideAssignment(graph, "auth", { budget_usd: 123 });
    const approval2 = approveAllocation(graph, "dhatwell");
    expect(approval2.content_hash).not.toBe(approval.content_hash);
  });
});
