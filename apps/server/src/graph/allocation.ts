// Rule-based allocation engine (PRD R4 §Allocation): complexity × risk ×
// strategy -> model tier, worker count, reviewer, budget, rationale. Human
// overrides persist — Auto Allocate never clobbers them. Allocation approval
// is budget approval and records the content hash of exactly what was shown.
import { createHash } from "node:crypto";
import type { ApprovalT } from "@norns/contracts";
import { z } from "zod";
import { newId } from "../ids.js";
import type { GraphNode, WorkflowGraph } from "./graph.js";

export const AllocationStrategy = z.enum(["quality", "balanced", "cost"]);
export type AllocationStrategyT = z.infer<typeof AllocationStrategy>;

export const NodeAssignment = z.object({
  provider: z.enum(["anthropic", "openai"]),
  model: z.string().min(1),
  role: z.literal("implementation"),
  worker_count: z.number().int().min(1).max(3), // design cap 3; pilot cap 2
  reviewer_model: z.string().min(1),
  budget_usd: z.number().positive(),
  rationale: z.string().min(1),
  source: z.enum(["auto", "pm", "override"]),
});
export type NodeAssignmentT = z.infer<typeof NodeAssignment>;

export type PmAssignmentRecommendation = Omit<NodeAssignmentT, "role" | "source"> & {
  node_id: string;
};

// Base budgets by complexity; risk scales them (independent axes, REVIEW-002)
const BASE_BUDGET_USD: Record<GraphNode["complexity"], number> = {
  S: 20,
  M: 50,
  L: 120,
  XL: 250,
};
const RISK_MULTIPLIER: Record<GraphNode["risk"], number> = {
  low: 1,
  medium: 1.25,
  high: 1.5,
  critical: 2,
};
const STRATEGY_BUDGET_FACTOR: Record<AllocationStrategyT, number> = {
  quality: 1.5,
  balanced: 1,
  cost: 0.6,
};

// Model ids come from the adapter registry; OpenAI reviewer id is the
// config-level placeholder resolved at deploy time.
const REVIEWER_MODEL = "openai-reasoning-default";
const PILOT_WORKER_CAP = 2;

function modelFor(strategy: AllocationStrategyT, complexity: GraphNode["complexity"]): string {
  if (strategy === "quality") return "claude-opus-4-8";
  if (strategy === "cost") return complexity === "S" ? "claude-haiku-4-5" : "claude-sonnet-5";
  // balanced: sonnet for small/medium, opus for the hard tail
  return complexity === "L" || complexity === "XL" ? "claude-opus-4-8" : "claude-sonnet-5";
}

function recommend(node: GraphNode, strategy: AllocationStrategyT): NodeAssignmentT {
  const budget =
    Math.round(
      BASE_BUDGET_USD[node.complexity] *
        RISK_MULTIPLIER[node.risk] *
        STRATEGY_BUDGET_FACTOR[strategy] *
        100,
    ) / 100;
  const workers =
    node.parallel_safe && (node.complexity === "XL" || node.complexity === "L")
      ? PILOT_WORKER_CAP
      : 1;
  const model = modelFor(strategy, node.complexity);
  return NodeAssignment.parse({
    provider: "anthropic",
    model,
    role: "implementation",
    worker_count: workers,
    reviewer_model: REVIEWER_MODEL,
    budget_usd: budget,
    rationale:
      `${strategy} strategy: complexity ${node.complexity} × risk ${node.risk} -> ${model}, ` +
      `${workers} worker(s), $${budget} budget; reviewed by ${REVIEWER_MODEL} (cross-provider).`,
    source: "auto",
  });
}

/**
 * Auto Allocate: fills every node that the human has NOT overridden.
 * Overrides persist across re-allocation — that is the contract.
 */
export function autoAllocate(graph: WorkflowGraph, strategy: AllocationStrategyT): void {
  for (const node of graph.snapshot().nodes) {
    const record = graph.node(node.id);
    if (!record) continue;
    if (record.assignment?.source === "override") continue;
    record.assignment = recommend(record, strategy);
  }
}

/**
 * Apply a validated project-manager recommendation without overwriting an
 * explicit human override. Recommendation generation is intentionally kept
 * outside the graph engine; this boundary still parses every assignment so
 * malformed model output can never enter durable graph state.
 */
export function applyPmAllocation(
  graph: WorkflowGraph,
  recommendations: readonly PmAssignmentRecommendation[],
): void {
  const byNode = new Map(
    recommendations.map((recommendation) => [recommendation.node_id, recommendation]),
  );
  for (const node of graph.snapshot().nodes) {
    const record = graph.node(node.id);
    if (!record || record.assignment?.source === "override") continue;
    const recommendation = byNode.get(node.id);
    if (!recommendation) {
      throw new AllocationError(
        `project manager did not recommend an assignment for node "${node.id}"`,
      );
    }
    const { node_id: _nodeId, ...assignment } = recommendation;
    record.assignment = NodeAssignment.parse({
      ...assignment,
      role: "implementation",
      source: "pm",
    });
  }
}

type AssignmentPatch = {
  [K in keyof Omit<NodeAssignmentT, "source" | "role">]?:
    | Omit<NodeAssignmentT, "source" | "role">[K]
    | undefined;
};

/** Human override of any field; marks the node so auto-allocate skips it. */
export function overrideAssignment(
  graph: WorkflowGraph,
  nodeId: string,
  patch: AssignmentPatch,
): NodeAssignmentT {
  const record = graph.node(nodeId);
  if (!record) throw new Error(`unknown node "${nodeId}"`);
  const base = record.assignment ?? recommend(record, "balanced");
  const cleaned = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  );
  const next = NodeAssignment.parse({
    ...base,
    ...cleaned,
    role: "implementation",
    source: "override",
  });
  record.assignment = next;
  return next;
}

export interface CostPreview {
  total_usd: number;
  per_node: { node_id: string; budget_usd: number | null }[];
  unallocated: string[];
}

/** Shown before allocation approval; approval of allocation IS budget approval. */
export function costPreview(graph: WorkflowGraph): CostPreview {
  const perNode = graph.snapshot().nodes.map((node) => ({
    node_id: node.id,
    budget_usd: node.assignment?.budget_usd ?? null,
  }));
  return {
    total_usd:
      Math.round(perNode.reduce((sum, entry) => sum + (entry.budget_usd ?? 0), 0) * 100) / 100,
    per_node: perNode,
    unallocated: perNode.filter((entry) => entry.budget_usd === null).map((entry) => entry.node_id),
  };
}

export class AllocationError extends Error {}

/**
 * Server-authoritative record of the last allocation approval (ADR-1). Binds
 * to both graph.version (structural edits) and allocation_fingerprint
 * (allocation edits), so we can decide server-side whether an approval is
 * still current. Persisted on the GraphSession (see graph/session.ts) and
 * round-tripped through ProjectStore snapshots.
 */
export interface AllocationApprovalRecord {
  content_hash: string;
  graph_version: number;
  allocation_fingerprint: string;
  actor: string;
  approved_at: string;
}

/** What the graph API returns to the client for the approval banner. `current`
 *  is computed server-side; the hash is evidence, never the source of truth. */
export interface AllocationApprovalStatus {
  content_hash: string;
  approved_at: string;
  actor: string;
  current: boolean;
}

/** Human approval — refuses partial allocations, hashes exactly what was shown. */
export function approveAllocation(graph: WorkflowGraph, actor: string): ApprovalT {
  const preview = costPreview(graph);
  if (preview.unallocated.length > 0) {
    throw new AllocationError(
      `cannot approve: unallocated nodes [${preview.unallocated.join(", ")}]`,
    );
  }
  const canonical = JSON.stringify({
    graph_version: graph.version,
    nodes: graph
      .snapshot()
      .nodes.sort((a, b) => a.id.localeCompare(b.id))
      .map((n) => ({
        id: n.id,
        dependencies: [...n.dependencies].sort(),
        assignment: n.assignment,
      })),
    total_usd: preview.total_usd,
  });
  return {
    id: newId("appr"),
    kind: "allocation",
    actor,
    approved_at: new Date().toISOString(),
    content_hash: createHash("sha256").update(canonical).digest("hex"),
  };
}
