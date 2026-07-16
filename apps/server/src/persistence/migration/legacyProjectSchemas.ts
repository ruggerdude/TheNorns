import {
  AcceptanceCriterion,
  Complexity,
  type PlanContractT,
  RiskLevel,
  validatePlan,
} from "@norns/contracts";
import { z } from "zod";
import { NodeAssignment } from "../../graph/allocation.js";

const LegacyProvider = z.enum(["anthropic", "openai"]);
const LegacyProjectSourceType = z.enum(["local", "github"]);
const Sha256Hex = z.string().regex(/^[a-f0-9]{64}$/);

/**
 * The project snapshot envelope is deliberately tolerant of older optional
 * fields. Plan, graph, and approval payloads remain unknown at this boundary
 * so reconciliation can emit machine-readable findings instead of rejecting
 * the entire project before it is accounted for.
 */
export const LegacyProjectSnapshot = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string(),
    pmProvider: LegacyProvider,
    pmModel: z.string().min(1).nullable().optional(),
    sourceType: LegacyProjectSourceType.nullable().optional(),
    sourceLocation: z.string().nullable().optional(),
    createdAt: z.string().datetime(),
    plan: z.unknown().nullable(),
    graph: z.unknown().nullable(),
    approval: z.unknown().nullable(),
  })
  .passthrough();
export type LegacyProjectSnapshotT = z.infer<typeof LegacyProjectSnapshot>;

export const LegacyProjectStoreSnapshot = z
  .object({
    projects: z.array(LegacyProjectSnapshot),
  })
  .passthrough();
export type LegacyProjectStoreSnapshotT = z.infer<typeof LegacyProjectStoreSnapshot>;

/**
 * Acceptance was never part of the current GraphNode shape. The optional
 * field is accepted only for tolerant parsing of historical/experimental
 * snapshots so a genuine second value can be compared when one exists.
 */
export const LegacyGraphNode = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    complexity: Complexity,
    risk: RiskLevel,
    parallel_safe: z.boolean(),
    dependencies: z.array(z.string().min(1)),
    assignment: NodeAssignment.nullable(),
    acceptance: z.array(AcceptanceCriterion).optional(),
  })
  .passthrough();
export type LegacyGraphNodeT = z.infer<typeof LegacyGraphNode>;

export const LegacyGraphSnapshot = z
  .object({
    version: z.number().int().positive(),
    nodes: z.array(LegacyGraphNode),
  })
  .strict();
export type LegacyGraphSnapshotT = z.infer<typeof LegacyGraphSnapshot>;

export const LegacyAllocationApproval = z
  .object({
    content_hash: Sha256Hex,
    graph_version: z.number().int().positive(),
    allocation_fingerprint: Sha256Hex,
    actor: z.string().min(1),
    approved_at: z.string().datetime(),
  })
  .strict();
export type LegacyAllocationApprovalT = z.infer<typeof LegacyAllocationApproval>;

export type ParsedLegacyProjectPayloads = {
  plan: PlanContractT | null;
  graph: LegacyGraphSnapshotT | null;
  approval: LegacyAllocationApprovalT | null;
  plan_valid: boolean;
  graph_valid: boolean;
  approval_valid: boolean;
};

export function parseLegacyProjectPayloads(
  source: LegacyProjectSnapshotT,
): ParsedLegacyProjectPayloads {
  const planResult = source.plan === null ? null : validatePlan(source.plan);
  const graphResult = source.graph === null ? null : LegacyGraphSnapshot.safeParse(source.graph);
  const approvalResult =
    source.approval === null ? null : LegacyAllocationApproval.safeParse(source.approval);

  return {
    plan: planResult?.ok === true ? planResult.plan : null,
    graph: graphResult?.success === true ? graphResult.data : null,
    approval: approvalResult?.success === true ? approvalResult.data : null,
    plan_valid: source.plan === null || planResult?.ok === true,
    graph_valid: source.graph === null || graphResult?.success === true,
    approval_valid: source.approval === null || approvalResult?.success === true,
  };
}
