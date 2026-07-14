// Workflow graph editing (PRD R4 §Workflow Graph): deterministic plan->graph
// conversion, acyclicity enforced with the offending path shown, deletion
// with explicit re-parent/cascade confirmation, edit restrictions once
// execution starts, and a graph version bumped on every structural edit
// (execution references a specific version).
import type { NodeState, PlanContractT } from "@norns/contracts";
import type { NodeAssignmentT } from "./allocation.js";

export interface GraphNode {
  id: string;
  title: string;
  complexity: "S" | "M" | "L" | "XL";
  risk: "low" | "medium" | "high" | "critical";
  parallel_safe: boolean;
  dependencies: string[];
  assignment: NodeAssignmentT | null;
}

export interface GraphSnapshot {
  version: number;
  nodes: GraphNode[];
}

export class GraphEditError extends Error {
  constructor(
    readonly code:
      | "cycle"
      | "unknown_node"
      | "duplicate_node"
      | "has_dependents"
      | "node_started"
      | "duplicate_edge",
    message: string,
    readonly cyclePath?: string[],
  ) {
    super(message);
    this.name = "GraphEditError";
  }
}

/** States at or before which a node is still freely editable. */
const NOT_STARTED: ReadonlySet<NodeState> = new Set(["pending", "ready"]);

export type NodeStateLookup = (nodeId: string) => NodeState;

export class WorkflowGraph {
  private readonly nodes = new Map<string, GraphNode>();
  private graphVersion = 1;
  private executionStarted = false;
  private stateOf: NodeStateLookup = () => "pending";

  static fromPlan(plan: PlanContractT): WorkflowGraph {
    const graph = new WorkflowGraph();
    for (const mod of plan.modules) {
      graph.nodes.set(mod.id, {
        id: mod.id,
        title: mod.title,
        complexity: mod.estimated_complexity,
        risk: mod.risk,
        parallel_safe: mod.parallelization.safe,
        dependencies: [...mod.dependencies],
        assignment: null,
      });
    }
    return graph;
  }

  get version(): number {
    return this.graphVersion;
  }

  /** Wire the engine's live node states in; edits then respect them. */
  attachStateLookup(lookup: NodeStateLookup): void {
    this.stateOf = lookup;
  }

  markExecutionStarted(): void {
    this.executionStarted = true;
  }

  node(id: string): GraphNode | undefined {
    return this.nodes.get(id);
  }

  snapshot(): GraphSnapshot {
    return {
      version: this.graphVersion,
      nodes: [...this.nodes.values()].map((n) => ({ ...n, dependencies: [...n.dependencies] })),
    };
  }

  dependentsOf(id: string): string[] {
    return [...this.nodes.values()].filter((n) => n.dependencies.includes(id)).map((n) => n.id);
  }

  // -- structural edits (each bumps the version) -------------------------------

  addNode(input: {
    id: string;
    title: string;
    complexity?: GraphNode["complexity"] | undefined;
    risk?: GraphNode["risk"] | undefined;
    dependencies?: string[] | undefined;
  }): void {
    if (this.nodes.has(input.id)) {
      throw new GraphEditError("duplicate_node", `node "${input.id}" already exists`);
    }
    for (const dep of input.dependencies ?? []) this.requireNode(dep);
    this.nodes.set(input.id, {
      id: input.id,
      title: input.title,
      complexity: input.complexity ?? "M",
      risk: input.risk ?? "low",
      parallel_safe: false,
      dependencies: [...(input.dependencies ?? [])],
      assignment: null,
    });
    this.bump();
  }

  addEdge(from: string, to: string): void {
    this.requireNode(from);
    const target = this.requireNode(to);
    this.guardEditable(to); // changing a started node's inputs is forbidden
    if (target.dependencies.includes(from)) {
      throw new GraphEditError("duplicate_edge", `edge ${from} -> ${to} already exists`);
    }
    target.dependencies.push(from);
    const cycle = this.findCycle();
    if (cycle) {
      target.dependencies.pop(); // reject atomically
      throw new GraphEditError(
        "cycle",
        `edge ${from} -> ${to} creates a cycle: ${cycle.join(" -> ")}`,
        cycle,
      );
    }
    this.bump();
  }

  removeEdge(from: string, to: string): void {
    const target = this.requireNode(to);
    this.guardEditable(to);
    target.dependencies = target.dependencies.filter((dep) => dep !== from);
    this.bump();
  }

  /**
   * Deleting a node with dependents requires an explicit mode (the UI's
   * confirmation): "reparent" grafts the removed node's dependencies onto its
   * dependents; "cascade" removes dependents transitively.
   */
  removeNode(id: string, mode?: "reparent" | "cascade"): string[] {
    const node = this.requireNode(id);
    this.guardEditable(id);
    const dependents = this.dependentsOf(id);
    if (dependents.length > 0 && mode === undefined) {
      throw new GraphEditError(
        "has_dependents",
        `node "${id}" has dependents [${dependents.join(", ")}]: confirm mode "reparent" or "cascade"`,
      );
    }
    const removed: string[] = [];
    if (mode === "cascade" && dependents.length > 0) {
      for (const dependent of dependents) {
        removed.push(...this.removeNode(dependent, "cascade"));
      }
    } else {
      for (const dependent of dependents) {
        const record = this.requireNode(dependent);
        this.guardEditable(dependent);
        record.dependencies = [
          ...new Set([
            ...record.dependencies.filter((dep) => dep !== id),
            ...node.dependencies, // inherit the removed node's deps
          ]),
        ];
      }
    }
    this.nodes.delete(id);
    removed.push(id);
    this.bump();
    return removed;
  }

  // -- internals ----------------------------------------------------------------

  private bump(): void {
    this.graphVersion += 1;
  }

  private requireNode(id: string): GraphNode {
    const node = this.nodes.get(id);
    if (!node) throw new GraphEditError("unknown_node", `unknown node "${id}"`);
    return node;
  }

  /** After execution starts, only not-yet-started nodes are editable. */
  private guardEditable(id: string): void {
    if (!this.executionStarted) return;
    const state = this.stateOf(id);
    if (!NOT_STARTED.has(state)) {
      throw new GraphEditError(
        "node_started",
        `node "${id}" is ${state}: after execution starts, edits are limited to not-yet-started nodes`,
      );
    }
  }

  private findCycle(): string[] | null {
    const state = new Map<string, "visiting" | "done">();
    const stack: string[] = [];
    const visit = (id: string): string[] | null => {
      const mark = state.get(id);
      if (mark === "done") return null;
      if (mark === "visiting") {
        const start = stack.indexOf(id);
        return [...stack.slice(start), id];
      }
      state.set(id, "visiting");
      stack.push(id);
      for (const dep of this.nodes.get(id)?.dependencies ?? []) {
        const found = visit(dep);
        if (found) return found;
      }
      stack.pop();
      state.set(id, "done");
      return null;
    };
    for (const id of this.nodes.keys()) {
      const found = visit(id);
      if (found) return found;
    }
    return null;
  }
}
