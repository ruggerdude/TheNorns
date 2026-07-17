import { z } from "zod";
import { V2EntityId, V2EvidenceRef, V2IsoDateTime, V2NonEmptyString } from "./common.js";

export const V2CoordinationRole = z.enum([
  "architecture",
  "implementation",
  "frontend",
  "backend",
  "security",
  "testing",
  "documentation",
  "integration",
  "code_quality",
]);

export const V2AllocationScore = z
  .object({
    agent_profile_id: V2EntityId,
    reviewer_agent_profile_id: V2EntityId.nullable(),
    score: z.number().finite(),
    capability_fit: z.number().min(0).max(1),
    role_fit: z.number().min(0).max(1),
    context_fit: z.number().min(0).max(1),
    workload_fit: z.number().min(0).max(1),
    reliability_fit: z.number().min(0).max(1),
    cost_fit: z.number().min(0).max(1),
    rationale: V2NonEmptyString,
  })
  .strict();
export type V2AllocationScoreT = z.infer<typeof V2AllocationScore>;

export const V2CoordinationAllocation = z
  .object({
    schema_version: z.literal(2),
    decision_id: V2EntityId,
    project_id: V2EntityId,
    phase_id: V2EntityId,
    task_id: V2EntityId,
    assignment_id: V2EntityId,
    selected: V2AllocationScore,
    alternatives: z.array(V2AllocationScore),
    conflict_keys: z.array(V2NonEmptyString),
    policy_ref: V2EntityId,
    decided_at: V2IsoDateTime,
  })
  .strict();
export type V2CoordinationAllocationT = z.infer<typeof V2CoordinationAllocation>;

export const V2AgentReviewDecision = z.enum(["approved", "rework", "escalated"]);

export const V2AgentReview = z
  .object({
    schema_version: z.literal(2),
    id: V2EntityId,
    project_id: V2EntityId,
    phase_id: V2EntityId,
    task_id: V2EntityId,
    run_id: V2EntityId,
    reviewer_agent_profile_id: V2EntityId,
    review_round: z.number().int().positive(),
    decision: V2AgentReviewDecision,
    summary: V2NonEmptyString,
    evidence: z.array(V2EvidenceRef).min(1),
    created_at: V2IsoDateTime,
  })
  .strict();
export type V2AgentReviewT = z.infer<typeof V2AgentReview>;

export const V2CoordinationSnapshot = z
  .object({
    schema_version: z.literal(2),
    project_id: V2EntityId,
    phase_id: V2EntityId,
    ready_tasks: z.number().int().nonnegative(),
    active_tasks: z.number().int().nonnegative(),
    available_agents: z.number().int().nonnegative(),
    active_providers: z.array(V2NonEmptyString),
    blocked_by_capacity: z.array(V2EntityId),
    blocked_by_conflict: z.array(V2EntityId),
    generated_at: V2IsoDateTime,
  })
  .strict();
export type V2CoordinationSnapshotT = z.infer<typeof V2CoordinationSnapshot>;
