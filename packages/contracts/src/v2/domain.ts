import { z } from "zod";
import {
  V2Actor,
  V2ApprovalEvidence,
  V2EntityId,
  V2EntityRef,
  V2EntityRefType,
  V2EvidenceRef,
  V2IsoDateTime,
  V2NonEmptyString,
  V2PositiveVersion,
  V2ProviderModelProvenance,
  V2Sha256Hex,
} from "./common.js";
import { V2AgentRunState, V2TaskState } from "./lifecycle.js";

const schemaVersion = z.literal(2);
const nullableDate = V2IsoDateTime.nullable();

export const V2ProjectStatus = z.enum([
  "initializing",
  "active",
  "paused",
  "blocked",
  "completed",
  "archived",
]);
export type V2ProjectStatusT = z.infer<typeof V2ProjectStatus>;

export const V2Project = z
  .object({
    schema_version: schemaVersion,
    id: V2EntityId,
    name: V2NonEmptyString,
    description: z.string(),
    status: V2ProjectStatus,
    primary_repository_binding_id: V2EntityId.nullable(),
    current_architecture_revision_id: V2EntityId.nullable(),
    coordinator_policy: z
      .object({
        max_executing_phases: z.number().int().positive().default(1),
        max_concurrent_tasks: z.number().int().positive(),
        assignment_policy_ref: V2EntityId,
      })
      .strict(),
    verification_policy_ref: V2EntityId,
    budget_policy_ref: V2EntityId,
    aggregate_version: V2PositiveVersion,
    created_at: V2IsoDateTime,
    updated_at: V2IsoDateTime,
    archived_at: nullableDate,
  })
  .strict();
export type V2ProjectT = z.infer<typeof V2Project>;

export const V2PhaseStatus = z.enum([
  "proposed",
  "awaiting_approval",
  "approved",
  "active",
  "blocked",
  "completed",
  "cancelled",
]);
export type V2PhaseStatusT = z.infer<typeof V2PhaseStatus>;

export const V2Phase = z
  .object({
    schema_version: schemaVersion,
    id: V2EntityId,
    project_id: V2EntityId,
    objective_summary: V2NonEmptyString,
    priority: z.number().int().nonnegative(),
    status: V2PhaseStatus,
    approved_strategy_version_id: V2EntityId.nullable(),
    approved_budget_usd: z.number().nonnegative(),
    aggregate_version: V2PositiveVersion,
    started_at: nullableDate,
    closed_at: nullableDate,
    closure_summary: z.string().nullable(),
    closure_evidence: z.array(V2EvidenceRef),
    created_at: V2IsoDateTime,
    updated_at: V2IsoDateTime,
  })
  .strict()
  .superRefine((phase, ctx) => {
    if (
      ["approved", "active", "blocked", "completed"].includes(phase.status) &&
      phase.approved_strategy_version_id === null
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["approved_strategy_version_id"],
        message: `${phase.status} requires an approved strategy version`,
      });
    }
    if (phase.status === "completed") {
      if (phase.closed_at === null || !phase.closure_summary) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["closed_at"],
          message: "a completed phase requires closure time and summary",
        });
      }
      if (phase.closure_evidence.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["closure_evidence"],
          message: "a completed phase requires closure evidence",
        });
      }
    }
  });
export type V2PhaseT = z.infer<typeof V2Phase>;

export const V2PhaseDependency = z
  .object({
    schema_version: schemaVersion,
    id: V2EntityId,
    project_id: V2EntityId,
    predecessor_phase_id: V2EntityId,
    successor_phase_id: V2EntityId,
    created_at: V2IsoDateTime,
  })
  .strict()
  .refine((dependency) => dependency.predecessor_phase_id !== dependency.successor_phase_id, {
    message: "a phase cannot depend on itself",
    path: ["successor_phase_id"],
  });
export type V2PhaseDependencyT = z.infer<typeof V2PhaseDependency>;

export const V2ObjectiveStatus = z.enum(["proposed", "active", "completed", "cancelled"]);
export type V2ObjectiveStatusT = z.infer<typeof V2ObjectiveStatus>;

export const V2Objective = z
  .object({
    schema_version: schemaVersion,
    id: V2EntityId,
    project_id: V2EntityId,
    phase_id: V2EntityId,
    outcome: V2NonEmptyString,
    success_measures: z.array(V2NonEmptyString).min(1),
    status: V2ObjectiveStatus,
    order: z.number().int().nonnegative(),
    completion_evidence: z.array(V2EvidenceRef),
    aggregate_version: V2PositiveVersion,
    created_at: V2IsoDateTime,
    updated_at: V2IsoDateTime,
  })
  .strict()
  .superRefine((objective, ctx) => {
    if (objective.status === "completed" && objective.completion_evidence.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["completion_evidence"],
        message: "a completed objective requires completion evidence",
      });
    }
  });
export type V2ObjectiveT = z.infer<typeof V2Objective>;

// Preserves the accepted Plan Contract scale so legacy import is lossless.
export const V2TaskComplexity = z.enum(["S", "M", "L", "XL"]);
export const V2TaskRisk = z.enum(["low", "medium", "high", "critical"]);

export const V2Task = z
  .object({
    schema_version: schemaVersion,
    id: V2EntityId,
    project_id: V2EntityId,
    phase_id: V2EntityId,
    objective_id: V2EntityId,
    strategy_version_id: V2EntityId,
    title: V2NonEmptyString,
    description: V2NonEmptyString,
    deliverables: z.array(V2NonEmptyString).min(1),
    acceptance_criteria: z.array(V2NonEmptyString).min(1),
    complexity: V2TaskComplexity,
    risk: V2TaskRisk,
    required_roles: z.array(V2NonEmptyString).min(1),
    required_capabilities: z.array(V2NonEmptyString),
    required_inputs: z.array(V2EntityRef),
    expected_outputs: z.array(V2NonEmptyString).min(1),
    environment_policy_ref: V2EntityId,
    verification_policy_ref: V2EntityId,
    state: V2TaskState,
    designated_assignment_id: V2EntityId.nullable(),
    designated_run_id: V2EntityId.nullable(),
    review_evidence: z.array(V2EvidenceRef),
    completion_evidence: z.array(V2EvidenceRef),
    lifecycle_version: z.number().int().nonnegative(),
    aggregate_version: V2PositiveVersion,
    created_at: V2IsoDateTime,
    updated_at: V2IsoDateTime,
    completed_at: nullableDate,
  })
  .strict()
  .superRefine((task, ctx) => {
    if (task.lifecycle_version === 0 && task.state !== "pending") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["state"],
        message: "a version-zero task must be at the pending lifecycle origin",
      });
    }
    if (task.state === "assigned" && task.designated_assignment_id === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["designated_assignment_id"],
        message: "an assigned task requires a designated assignment",
      });
    }
    if (
      ["in_progress", "verifying", "in_review"].includes(task.state) &&
      task.designated_run_id === null
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["designated_run_id"],
        message: `${task.state} requires a designated run`,
      });
    }
    if (task.state === "completed") {
      if (task.completed_at === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["completed_at"],
          message: "a completed task requires completion evidence time",
        });
      }
      if (task.review_evidence.length === 0 || task.completion_evidence.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["completion_evidence"],
          message: "completed requires recorded review and integration/completion evidence",
        });
      }
    }
  });
export type V2TaskT = z.infer<typeof V2Task>;

export const V2TaskDependency = z
  .object({
    schema_version: schemaVersion,
    id: V2EntityId,
    project_id: V2EntityId,
    phase_id: V2EntityId,
    predecessor_task_id: V2EntityId,
    predecessor_phase_id: V2EntityId,
    successor_task_id: V2EntityId,
    successor_phase_id: V2EntityId,
    created_at: V2IsoDateTime,
  })
  .strict()
  .superRefine((dependency, ctx) => {
    if (dependency.predecessor_task_id === dependency.successor_task_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["successor_task_id"],
        message: "a task cannot depend on itself",
      });
    }
    if (
      dependency.predecessor_phase_id !== dependency.successor_phase_id ||
      dependency.phase_id !== dependency.predecessor_phase_id
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["successor_phase_id"],
        message: "TaskDependencies are phase-local; use PhaseDependency for cross-phase ordering",
      });
    }
  });
export type V2TaskDependencyT = z.infer<typeof V2TaskDependency>;

export const V2StrategyConvergence = z.enum(["pending", "converged", "cap_reached", "failed"]);
export type V2StrategyConvergenceT = z.infer<typeof V2StrategyConvergence>;

export const V2StrategyFindingSeverity = z.enum(["must_fix", "recommended", "question"]);
export const V2StrategyFindingStatus = z.enum(["open", "resolved", "accepted"]);

export const V2StrategyFinding = z
  .object({
    id: V2EntityId,
    severity: V2StrategyFindingSeverity,
    status: V2StrategyFindingStatus,
    summary: V2NonEmptyString,
    disposition: z.string().nullable(),
  })
  .strict();
export type V2StrategyFindingT = z.infer<typeof V2StrategyFinding>;

export const V2StrategyVersionStatus = z.enum([
  "draft",
  "reviewing",
  "awaiting_approval",
  "approved",
  "rejected",
  "superseded",
]);

export const V2AssignmentRationaleFactor = z.enum([
  "capability",
  "workload",
  "dependency",
  "risk",
  "budget",
  "review",
]);

export const V2StrategyObjectiveProposal = z
  .object({
    local_id: V2EntityId,
    outcome: V2NonEmptyString,
    success_measures: z.array(V2NonEmptyString).min(1),
  })
  .strict();
export type V2StrategyObjectiveProposalT = z.infer<typeof V2StrategyObjectiveProposal>;

export const V2StrategyTaskProposal = z
  .object({
    local_id: V2EntityId,
    objective_local_id: V2EntityId,
    title: V2NonEmptyString,
    description: V2NonEmptyString,
    deliverables: z.array(V2NonEmptyString).min(1),
    acceptance_criteria: z.array(V2NonEmptyString).min(1),
    complexity: V2TaskComplexity,
    risk: V2TaskRisk,
    required_roles: z.array(V2NonEmptyString).min(1),
    required_capabilities: z.array(V2NonEmptyString),
    required_inputs: z.array(V2EntityRef),
    expected_outputs: z.array(V2NonEmptyString).min(1),
    environment_policy_ref: V2EntityId,
    verification_policy_ref: V2EntityId,
    dependency_local_ids: z.array(V2EntityId),
  })
  .strict();
export type V2StrategyTaskProposalT = z.infer<typeof V2StrategyTaskProposal>;

export const V2StrategyAssignmentProposal = z
  .object({
    local_id: V2EntityId,
    task_local_id: V2EntityId,
    agent_profile_id: V2EntityId,
    rationale: V2NonEmptyString,
    rationale_factors: z.array(V2AssignmentRationaleFactor).min(1),
    budget_limit_usd: z.number().nonnegative(),
    reviewer_agent_profile_id: V2EntityId.nullable(),
    allocation_policy_ref: V2EntityId,
  })
  .strict();
export type V2StrategyAssignmentProposalT = z.infer<typeof V2StrategyAssignmentProposal>;

export const V2StrategyVersion = z
  .object({
    schema_version: schemaVersion,
    id: V2EntityId,
    project_id: V2EntityId,
    phase_id: V2EntityId,
    version: V2PositiveVersion,
    status: V2StrategyVersionStatus,
    objective: V2NonEmptyString,
    assumptions: z.array(V2NonEmptyString),
    risks: z.array(V2NonEmptyString),
    scope_in: z.array(V2NonEmptyString),
    scope_out: z.array(V2NonEmptyString),
    architecture_impact: V2NonEmptyString,
    proposed_objectives: z.array(V2StrategyObjectiveProposal).min(1),
    proposed_tasks: z.array(V2StrategyTaskProposal).min(1),
    proposed_assignments: z.array(V2StrategyAssignmentProposal).min(1),
    proposed_concurrency: z.number().int().positive(),
    proposed_budget_usd: z.number().nonnegative(),
    provenance: z.array(V2ProviderModelProvenance).min(1),
    convergence: V2StrategyConvergence,
    review_rounds: z.number().int().nonnegative(),
    findings: z.array(V2StrategyFinding),
    content_hash: V2Sha256Hex,
    approval: V2ApprovalEvidence.nullable(),
    supersedes_strategy_version_id: V2EntityId.nullable(),
    aggregate_version: V2PositiveVersion,
    created_at: V2IsoDateTime,
    updated_at: V2IsoDateTime,
  })
  .strict()
  .superRefine((strategy, ctx) => {
    const allLocalIds = [
      ...strategy.proposed_objectives.map((objective) => objective.local_id),
      ...strategy.proposed_tasks.map((task) => task.local_id),
      ...strategy.proposed_assignments.map((assignment) => assignment.local_id),
    ];
    const duplicateLocalIds = allLocalIds.filter(
      (localId, index) => allLocalIds.indexOf(localId) !== index,
    );
    if (duplicateLocalIds.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["proposed_tasks"],
        message: `strategy local IDs must be globally unique: ${[...new Set(duplicateLocalIds)].join(", ")}`,
      });
    }

    const objectiveIds = new Set(
      strategy.proposed_objectives.map((objective) => objective.local_id),
    );
    const taskIds = new Set(strategy.proposed_tasks.map((task) => task.local_id));
    const assignmentCountByTask = new Map<string, number>();

    for (const task of strategy.proposed_tasks) {
      if (!objectiveIds.has(task.objective_local_id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["proposed_tasks"],
          message: `task ${task.local_id} references unknown objective ${task.objective_local_id}`,
        });
      }
      if (task.dependency_local_ids.includes(task.local_id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["proposed_tasks"],
          message: `task ${task.local_id} cannot depend on itself`,
        });
      }
      if (new Set(task.dependency_local_ids).size !== task.dependency_local_ids.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["proposed_tasks"],
          message: `task ${task.local_id} contains duplicate dependencies`,
        });
      }
      for (const dependencyId of task.dependency_local_ids) {
        if (!taskIds.has(dependencyId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["proposed_tasks"],
            message: `task ${task.local_id} references unknown dependency ${dependencyId}`,
          });
        }
      }
    }

    for (const assignment of strategy.proposed_assignments) {
      if (!taskIds.has(assignment.task_local_id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["proposed_assignments"],
          message: `assignment ${assignment.local_id} references unknown task ${assignment.task_local_id}`,
        });
      }
      assignmentCountByTask.set(
        assignment.task_local_id,
        (assignmentCountByTask.get(assignment.task_local_id) ?? 0) + 1,
      );
    }
    for (const taskId of taskIds) {
      if (assignmentCountByTask.get(taskId) !== 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["proposed_assignments"],
          message: `task ${taskId} requires exactly one proposed assignment`,
        });
      }
    }

    const dependenciesByTask = new Map(
      strategy.proposed_tasks.map((task) => [task.local_id, task.dependency_local_ids] as const),
    );
    const visiting = new Set<string>();
    const visited = new Set<string>();
    let cycleFound = false;
    const visit = (taskId: string): void => {
      if (cycleFound || visited.has(taskId)) return;
      if (visiting.has(taskId)) {
        cycleFound = true;
        return;
      }
      visiting.add(taskId);
      for (const dependencyId of dependenciesByTask.get(taskId) ?? []) {
        if (taskIds.has(dependencyId)) visit(dependencyId);
      }
      visiting.delete(taskId);
      visited.add(taskId);
    };
    for (const taskId of taskIds) visit(taskId);
    if (cycleFound) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["proposed_tasks"],
        message: "proposed TaskDependency graph must be acyclic",
      });
    }

    if (strategy.status === "approved") {
      if (strategy.approval === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["approval"],
          message: "an approved strategy requires approval evidence",
        });
      }
      if (strategy.convergence !== "converged") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["convergence"],
          message: "an approved strategy must be converged",
        });
      }
      if (
        strategy.findings.some(
          (finding) => finding.severity === "must_fix" && finding.status !== "resolved",
        )
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["findings"],
          message: "an approved strategy cannot retain unresolved must-fix findings",
        });
      }
    }
    if (strategy.approval !== null && strategy.approval.content_hash !== strategy.content_hash) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["approval", "content_hash"],
        message: "approval evidence must bind the stored immutable strategy content hash",
      });
    }
  });
export type V2StrategyVersionT = z.infer<typeof V2StrategyVersion>;

export const V2StrategyContentProjection = z
  .object({
    schema_version: schemaVersion,
    id: V2EntityId,
    project_id: V2EntityId,
    phase_id: V2EntityId,
    version: V2PositiveVersion,
    objective: V2NonEmptyString,
    assumptions: z.array(V2NonEmptyString),
    risks: z.array(V2NonEmptyString),
    scope_in: z.array(V2NonEmptyString),
    scope_out: z.array(V2NonEmptyString),
    architecture_impact: V2NonEmptyString,
    proposed_objectives: z.array(V2StrategyObjectiveProposal).min(1),
    proposed_tasks: z.array(V2StrategyTaskProposal).min(1),
    proposed_assignments: z.array(V2StrategyAssignmentProposal).min(1),
    proposed_concurrency: z.number().int().positive(),
    proposed_budget_usd: z.number().nonnegative(),
    provenance: z.array(V2ProviderModelProvenance).min(1),
    convergence: V2StrategyConvergence,
    review_rounds: z.number().int().nonnegative(),
    findings: z.array(V2StrategyFinding),
    supersedes_strategy_version_id: V2EntityId.nullable(),
  })
  .strict();
export type V2StrategyContentProjectionT = z.infer<typeof V2StrategyContentProjection>;

export function projectV2StrategyImmutableContent(
  strategy: V2StrategyVersionT,
): V2StrategyContentProjectionT {
  return V2StrategyContentProjection.parse({
    schema_version: strategy.schema_version,
    id: strategy.id,
    project_id: strategy.project_id,
    phase_id: strategy.phase_id,
    version: strategy.version,
    objective: strategy.objective,
    assumptions: strategy.assumptions,
    risks: strategy.risks,
    scope_in: strategy.scope_in,
    scope_out: strategy.scope_out,
    architecture_impact: strategy.architecture_impact,
    proposed_objectives: strategy.proposed_objectives,
    proposed_tasks: strategy.proposed_tasks,
    proposed_assignments: strategy.proposed_assignments,
    proposed_concurrency: strategy.proposed_concurrency,
    proposed_budget_usd: strategy.proposed_budget_usd,
    provenance: strategy.provenance,
    convergence: strategy.convergence,
    review_rounds: strategy.review_rounds,
    findings: strategy.findings,
    supersedes_strategy_version_id: strategy.supersedes_strategy_version_id,
  });
}

function canonicalizeStrategyContent(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeStrategyContent);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entryValue]) => [key, canonicalizeStrategyContent(entryValue)]),
    );
  }
  return value;
}

export function canonicalizeV2StrategyImmutableContent(strategy: V2StrategyVersionT): string {
  return JSON.stringify(canonicalizeStrategyContent(projectV2StrategyImmutableContent(strategy)));
}

export function fingerprintV2StrategyImmutableContent(
  strategy: V2StrategyVersionT,
  serverSha256: (canonicalContent: string) => string,
): string {
  return V2Sha256Hex.parse(serverSha256(canonicalizeV2StrategyImmutableContent(strategy)));
}

export const V2AgentProfileStatus = z.enum(["available", "busy", "offline", "disabled"]);

export const V2AgentProfile = z
  .object({
    schema_version: schemaVersion,
    id: V2EntityId,
    provider: V2NonEmptyString,
    runtime: V2NonEmptyString,
    model: V2NonEmptyString,
    roles: z.array(V2NonEmptyString).min(1),
    capabilities: z.array(V2NonEmptyString),
    context_limit_tokens: z.number().int().positive(),
    security_restrictions: z.array(V2NonEmptyString),
    status: V2AgentProfileStatus,
    active_workload: z.number().int().nonnegative(),
    cost_metadata: z
      .object({
        billing_mode: z.enum(["subscription", "api", "local", "unknown"]),
        input_usd_per_million: z.number().nonnegative().nullable(),
        output_usd_per_million: z.number().nonnegative().nullable(),
      })
      .strict(),
    aggregate_version: V2PositiveVersion,
    created_at: V2IsoDateTime,
    updated_at: V2IsoDateTime,
  })
  .strict();
export type V2AgentProfileT = z.infer<typeof V2AgentProfile>;

export const V2AssignmentStatus = z.enum([
  "proposed",
  "active",
  "completed",
  "cancelled",
  "superseded",
]);

export const V2AgentAssignment = z
  .object({
    schema_version: schemaVersion,
    id: V2EntityId,
    project_id: V2EntityId,
    phase_id: V2EntityId,
    task_id: V2EntityId,
    agent_profile_id: V2EntityId,
    status: V2AssignmentStatus,
    rationale: V2NonEmptyString,
    rationale_factors: z.array(V2AssignmentRationaleFactor).min(1),
    budget_limit_usd: z.number().nonnegative(),
    reviewer_agent_profile_id: V2EntityId.nullable(),
    allocation_policy_ref: V2EntityId,
    aggregate_version: V2PositiveVersion,
    created_at: V2IsoDateTime,
    updated_at: V2IsoDateTime,
  })
  .strict();
export type V2AgentAssignmentT = z.infer<typeof V2AgentAssignment>;

export const V2VerificationEvidenceStatus = z.enum(["pending", "passed", "failed"]);

export const V2AgentRun = z
  .object({
    schema_version: schemaVersion,
    id: V2EntityId,
    project_id: V2EntityId,
    phase_id: V2EntityId,
    task_id: V2EntityId,
    assignment_id: V2EntityId,
    attempt: z.number().int().positive(),
    state: V2AgentRunState,
    is_designated: z.boolean(),
    runner_id: V2EntityId.nullable(),
    runtime_session_id: V2EntityId.nullable(),
    repository_binding_id: V2EntityId,
    expected_revision: V2NonEmptyString,
    worktree_ref: z.string().nullable(),
    commit_sha: z.string().nullable(),
    usage_input_tokens: z.number().int().nonnegative(),
    usage_output_tokens: z.number().int().nonnegative(),
    usage_cost_usd: z.number().nonnegative(),
    artifacts: z.array(V2EvidenceRef),
    verification_status: V2VerificationEvidenceStatus,
    result_summary: z.string().nullable(),
    failure_code: z.string().nullable(),
    failure_detail: z.string().nullable(),
    superseded_at: nullableDate,
    superseded_by_run_id: V2EntityId.nullable(),
    lifecycle_version: z.number().int().nonnegative(),
    aggregate_version: V2PositiveVersion,
    created_at: V2IsoDateTime,
    updated_at: V2IsoDateTime,
    started_at: nullableDate,
    finished_at: nullableDate,
  })
  .strict()
  .superRefine((run, ctx) => {
    if (run.lifecycle_version === 0 && run.state !== "created") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["state"],
        message: "a version-zero agent run must be at the created lifecycle origin",
      });
    }
    const hasSupersededAt = run.superseded_at !== null;
    const hasSupersededBy = run.superseded_by_run_id !== null;
    if (hasSupersededAt !== hasSupersededBy) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["superseded_by_run_id"],
        message: "superseded_at and superseded_by_run_id must be set together",
      });
    }
    if (run.is_designated && hasSupersededAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["is_designated"],
        message: "a superseded run cannot remain designated",
      });
    }
    if (run.superseded_by_run_id === run.id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["superseded_by_run_id"],
        message: "a run cannot supersede itself",
      });
    }
    if (run.state === "succeeded" && run.verification_status !== "passed") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["verification_status"],
        message: "a succeeded run requires green infrastructure verification evidence",
      });
    }
    if (run.state === "failed" && !run.failure_code) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["failure_code"],
        message: "a failed run requires an attributable failure code",
      });
    }
    if (
      ["succeeded", "failed", "cancelled", "expired"].includes(run.state) &&
      run.finished_at === null
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["finished_at"],
        message: `terminal run state ${run.state} requires finished_at`,
      });
    }
  });
export type V2AgentRunT = z.infer<typeof V2AgentRun>;

export const V2DecisionPointStatus = z.enum(["open", "resolved", "dismissed", "superseded"]);
export const V2DecisionUrgency = z.enum(["low", "normal", "high", "critical"]);

export const V2DecisionConditionKeyParts = z
  .object({
    project_id: V2EntityId,
    scope_entity_type: V2EntityRefType,
    scope_entity_id: V2EntityId,
    reason_class: V2NonEmptyString,
    source_instance_id: V2EntityId,
  })
  .strict();
export type V2DecisionConditionKeyPartsT = z.infer<typeof V2DecisionConditionKeyParts>;

export function v2DecisionPointConditionKey(parts: V2DecisionConditionKeyPartsT): string {
  return [
    "decision",
    parts.project_id,
    parts.scope_entity_type,
    parts.scope_entity_id,
    parts.reason_class,
    parts.source_instance_id,
  ]
    .map(encodeURIComponent)
    .join(":");
}

export const V2DecisionPoint = z
  .object({
    schema_version: schemaVersion,
    id: V2EntityId,
    project_id: V2EntityId,
    phase_id: V2EntityId.nullable(),
    task_id: V2EntityId.nullable(),
    scope_entity_type: V2EntityRefType,
    scope_entity_id: V2EntityId,
    reason_class: V2NonEmptyString,
    source_instance_id: V2EntityId,
    condition_key: V2NonEmptyString,
    condition_fingerprint: V2Sha256Hex,
    condition_revision: V2PositiveVersion,
    question: V2NonEmptyString,
    context: V2NonEmptyString,
    options: z
      .array(
        z
          .object({
            id: V2EntityId,
            label: V2NonEmptyString,
            impact: V2NonEmptyString,
            risk: V2NonEmptyString,
          })
          .strict(),
      )
      .min(1),
    recommendation_option_id: V2EntityId,
    urgency: V2DecisionUrgency,
    blocking_scope: V2EntityRef.nullable(),
    status: V2DecisionPointStatus,
    supersedes_decision_point_id: V2EntityId.nullable(),
    superseded_by_decision_point_id: V2EntityId.nullable(),
    created_at: V2IsoDateTime,
    updated_at: V2IsoDateTime,
    resolved_at: nullableDate,
  })
  .strict()
  .superRefine((point, ctx) => {
    const expectedConditionKey = v2DecisionPointConditionKey({
      project_id: point.project_id,
      scope_entity_type: point.scope_entity_type,
      scope_entity_id: point.scope_entity_id,
      reason_class: point.reason_class,
      source_instance_id: point.source_instance_id,
    });
    if (point.condition_key !== expectedConditionKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["condition_key"],
        message: "condition_key must be the stable identity of scope, reason, and source",
      });
    }
    if (!point.options.some((option) => option.id === point.recommendation_option_id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["recommendation_option_id"],
        message: "recommendation_option_id must reference one of the options",
      });
    }
    if (new Set(point.options.map((option) => option.id)).size !== point.options.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["options"],
        message: "decision option ids must be unique",
      });
    }
  });
export type V2DecisionPointT = z.infer<typeof V2DecisionPoint>;

export const V2DecisionRecordStatus = z.enum(["active", "obsolete"]);

export const V2DecisionRecord = z
  .object({
    schema_version: schemaVersion,
    id: V2EntityId,
    project_id: V2EntityId,
    phase_id: V2EntityId.nullable(),
    decision_point_id: V2EntityId.nullable(),
    title: V2NonEmptyString,
    rationale: V2NonEmptyString,
    selected_option_id: V2EntityId.nullable(),
    direction_target: z
      .enum(["project_manager", "implementation_agent", "reviewer", "all_agents"])
      .nullable(),
    direction_text: V2NonEmptyString.max(10_000).nullable(),
    status: V2DecisionRecordStatus,
    decided_by: V2EntityId,
    approval_evidence: V2ApprovalEvidence,
    affected_entities: z.array(V2EntityRef),
    supersedes_decision_record_id: V2EntityId.nullable(),
    superseded_by_decision_record_id: V2EntityId.nullable(),
    created_at: V2IsoDateTime,
  })
  .strict()
  .superRefine((record, ctx) => {
    if ((record.direction_target === null) !== (record.direction_text === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["direction_text"],
        message: "direction_target and direction_text must be present together",
      });
    }
  });
export type V2DecisionRecordT = z.infer<typeof V2DecisionRecord>;

export const V2MemoryCategory = z.enum([
  "directive",
  "constraint",
  "decision",
  "lesson",
  "architecture",
  "phase_completion",
  "repository_fact",
]);
export const V2MemoryStatus = z.enum(["active", "obsolete"]);

export const V2ProjectMemoryEntry = z
  .object({
    schema_version: schemaVersion,
    id: V2EntityId,
    project_id: V2EntityId,
    phase_id: V2EntityId.nullable(),
    task_id: V2EntityId.nullable(),
    category: V2MemoryCategory,
    content: V2NonEmptyString.max(10_000),
    provenance: V2NonEmptyString,
    source_ref: V2EntityRef.nullable(),
    confidence: z.number().min(0).max(1),
    version: V2PositiveVersion,
    status: V2MemoryStatus,
    approved_by_human: z.boolean(),
    approved_by: V2EntityId.nullable(),
    approved_at: nullableDate,
    supersedes_memory_entry_id: V2EntityId.nullable(),
    superseded_by_memory_entry_id: V2EntityId.nullable(),
    created_at: V2IsoDateTime,
  })
  .strict()
  .superRefine((entry, ctx) => {
    if (
      ["directive", "decision"].includes(entry.category) &&
      (!entry.approved_by_human || entry.approved_by === null || entry.approved_at === null)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["approved_by_human"],
        message: "directives and strategic decisions require attributable human approval",
      });
    }
  });
export type V2ProjectMemoryEntryT = z.infer<typeof V2ProjectMemoryEntry>;

export const V2ArchitectureRevision = z
  .object({
    schema_version: schemaVersion,
    id: V2EntityId,
    project_id: V2EntityId,
    phase_id: V2EntityId.nullable(),
    revision: V2PositiveVersion,
    title: V2NonEmptyString,
    summary: V2NonEmptyString,
    architecture_document_ref: V2EvidenceRef,
    repository_revision: V2NonEmptyString,
    provenance: V2Actor,
    approval: V2ApprovalEvidence.nullable(),
    supersedes_architecture_revision_id: V2EntityId.nullable(),
    created_at: V2IsoDateTime,
  })
  .strict();
export type V2ArchitectureRevisionT = z.infer<typeof V2ArchitectureRevision>;

export interface V2StrategyMaterialization {
  objectives: V2ObjectiveT[];
  tasks: V2TaskT[];
  task_dependencies: V2TaskDependencyT[];
  agent_assignments: V2AgentAssignmentT[];
}

function v2MaterializedId(
  kind: "objective" | "task" | "task-dependency" | "assignment",
  phaseId: string,
  ...localIdentityParts: string[]
): string {
  return [kind, phaseId, ...localIdentityParts].map(encodeURIComponent).join(":");
}

/**
 * Exact, deterministic projection used by the approval transaction. Every
 * proposal field is copied into its canonical entity; only database-owned
 * lifecycle, version, evidence, and timestamp defaults are introduced.
 *
 * Materialized identity is scoped to the Phase and proposal-local identity,
 * rather than the StrategyVersion. An amendment therefore addresses the same
 * canonical rows for unchanged local identities while `strategy_version_id`
 * records the newly approved provenance. This function creates proposal-shaped
 * defaults only; callers applying an amendment to canonical state MUST use
 * mergeV2StrategyAmendment so lifecycle, evidence, and historical fields are
 * not reset.
 */
export function materializeV2StrategyVersion(
  strategyInput: V2StrategyVersionT,
  createdAt: string,
  serverSha256: (canonicalContent: string) => string,
): V2StrategyMaterialization {
  const strategy = V2StrategyVersion.parse(strategyInput);
  if (strategy.status !== "approved" || strategy.approval === null) {
    throw new Error(
      "only an approved StrategyVersion with matching approval evidence may materialize",
    );
  }
  const computedContentHash = fingerprintV2StrategyImmutableContent(strategy, serverSha256);
  if (
    strategy.content_hash !== computedContentHash ||
    strategy.approval.content_hash !== computedContentHash
  ) {
    throw new Error("approved StrategyVersion content or approval evidence hash is stale");
  }
  const timestamp = V2IsoDateTime.parse(createdAt);
  const objectiveIdByLocalId = new Map(
    strategy.proposed_objectives.map((objective) => [
      objective.local_id,
      v2MaterializedId("objective", strategy.phase_id, objective.local_id),
    ]),
  );
  const taskIdByLocalId = new Map(
    strategy.proposed_tasks.map((task) => [
      task.local_id,
      v2MaterializedId("task", strategy.phase_id, task.local_id),
    ]),
  );
  const assignmentByTaskLocalId = new Map(
    strategy.proposed_assignments.map((assignment) => [assignment.task_local_id, assignment]),
  );

  const objectives = strategy.proposed_objectives.map((proposal, order) =>
    V2Objective.parse({
      schema_version: 2,
      id: objectiveIdByLocalId.get(proposal.local_id),
      project_id: strategy.project_id,
      phase_id: strategy.phase_id,
      outcome: proposal.outcome,
      success_measures: proposal.success_measures,
      status: "active",
      order,
      completion_evidence: [],
      aggregate_version: 1,
      created_at: timestamp,
      updated_at: timestamp,
    }),
  );

  const tasks = strategy.proposed_tasks.map((proposal) => {
    const assignment = assignmentByTaskLocalId.get(proposal.local_id);
    return V2Task.parse({
      schema_version: 2,
      id: taskIdByLocalId.get(proposal.local_id),
      project_id: strategy.project_id,
      phase_id: strategy.phase_id,
      objective_id: objectiveIdByLocalId.get(proposal.objective_local_id),
      strategy_version_id: strategy.id,
      title: proposal.title,
      description: proposal.description,
      deliverables: proposal.deliverables,
      acceptance_criteria: proposal.acceptance_criteria,
      complexity: proposal.complexity,
      risk: proposal.risk,
      required_roles: proposal.required_roles,
      required_capabilities: proposal.required_capabilities,
      required_inputs: proposal.required_inputs,
      expected_outputs: proposal.expected_outputs,
      environment_policy_ref: proposal.environment_policy_ref,
      verification_policy_ref: proposal.verification_policy_ref,
      state: "pending",
      designated_assignment_id:
        assignment === undefined
          ? null
          : v2MaterializedId("assignment", strategy.phase_id, assignment.local_id),
      designated_run_id: null,
      review_evidence: [],
      completion_evidence: [],
      lifecycle_version: 0,
      aggregate_version: 1,
      created_at: timestamp,
      updated_at: timestamp,
      completed_at: null,
    });
  });

  const taskDependencies = strategy.proposed_tasks.flatMap((successor) =>
    successor.dependency_local_ids.map((predecessorLocalId) =>
      V2TaskDependency.parse({
        schema_version: 2,
        id: v2MaterializedId(
          "task-dependency",
          strategy.phase_id,
          predecessorLocalId,
          successor.local_id,
        ),
        project_id: strategy.project_id,
        phase_id: strategy.phase_id,
        predecessor_task_id: taskIdByLocalId.get(predecessorLocalId),
        predecessor_phase_id: strategy.phase_id,
        successor_task_id: taskIdByLocalId.get(successor.local_id),
        successor_phase_id: strategy.phase_id,
        created_at: timestamp,
      }),
    ),
  );

  const agentAssignments = strategy.proposed_assignments.map((proposal) =>
    V2AgentAssignment.parse({
      schema_version: 2,
      id: v2MaterializedId("assignment", strategy.phase_id, proposal.local_id),
      project_id: strategy.project_id,
      phase_id: strategy.phase_id,
      task_id: taskIdByLocalId.get(proposal.task_local_id),
      agent_profile_id: proposal.agent_profile_id,
      status: "proposed",
      rationale: proposal.rationale,
      rationale_factors: proposal.rationale_factors,
      budget_limit_usd: proposal.budget_limit_usd,
      reviewer_agent_profile_id: proposal.reviewer_agent_profile_id,
      allocation_policy_ref: proposal.allocation_policy_ref,
      aggregate_version: 1,
      created_at: timestamp,
      updated_at: timestamp,
    }),
  );

  return {
    objectives,
    tasks,
    task_dependencies: taskDependencies,
    agent_assignments: agentAssignments,
  };
}

export const V2StrategyAmendmentConflictCode = z.enum([
  "invalid_supersession",
  "scope_mismatch",
  "entity_removal_or_rename_forbidden",
  "locked_entity_change",
  "identity_relationship_change_forbidden",
]);
export type V2StrategyAmendmentConflictCodeT = z.infer<typeof V2StrategyAmendmentConflictCode>;

export class V2StrategyAmendmentConflict extends Error {
  readonly code: V2StrategyAmendmentConflictCodeT;
  readonly entity_kind: string | null;
  readonly entity_id: string | null;

  constructor(
    code: V2StrategyAmendmentConflictCodeT,
    message: string,
    entityKind: string | null = null,
    entityId: string | null = null,
  ) {
    super(message);
    this.name = "V2StrategyAmendmentConflict";
    this.code = code;
    this.entity_kind = entityKind;
    this.entity_id = entityId;
  }
}

type V2MaterializedEntity = {
  id: string;
  project_id: string;
  phase_id: string;
};

function v2MaterializedEntityMap<T extends { id: string }>(
  entityKind: string,
  entities: readonly T[],
): Map<string, T> {
  const result = new Map<string, T>();
  for (const entity of entities) {
    if (result.has(entity.id)) {
      throw new V2StrategyAmendmentConflict(
        "identity_relationship_change_forbidden",
        `existing materialization contains duplicate ${entityKind} ID ${entity.id}`,
        entityKind,
        entity.id,
      );
    }
    result.set(entity.id, entity);
  }
  return result;
}

function v2AssertAmendmentScope(
  strategy: V2StrategyVersionT,
  entityKind: string,
  entities: readonly V2MaterializedEntity[],
): void {
  for (const entity of entities) {
    if (entity.project_id !== strategy.project_id || entity.phase_id !== strategy.phase_id) {
      throw new V2StrategyAmendmentConflict(
        "scope_mismatch",
        `${entityKind} ${entity.id} is outside amendment project/phase scope`,
        entityKind,
        entity.id,
      );
    }
  }
}

function v2AssertNoRemovedMaterializedIds<T extends { id: string }>(
  entityKind: string,
  existing: ReadonlyMap<string, T>,
  proposed: ReadonlyMap<string, T>,
): void {
  for (const id of existing.keys()) {
    if (!proposed.has(id)) {
      throw new V2StrategyAmendmentConflict(
        "entity_removal_or_rename_forbidden",
        `MVP amendments cannot remove or rename existing ${entityKind} ${id}`,
        entityKind,
        id,
      );
    }
  }
}

function v2SameAmendmentMaterial(left: unknown, right: unknown): boolean {
  return (
    JSON.stringify(canonicalizeStrategyContent(left)) ===
    JSON.stringify(canonicalizeStrategyContent(right))
  );
}

function v2ObjectiveProposalMaterial(objective: V2ObjectiveT): unknown {
  return {
    outcome: objective.outcome,
    success_measures: objective.success_measures,
    order: objective.order,
  };
}

function v2TaskProposalMaterial(task: V2TaskT): unknown {
  return {
    objective_id: task.objective_id,
    title: task.title,
    description: task.description,
    deliverables: task.deliverables,
    acceptance_criteria: task.acceptance_criteria,
    complexity: task.complexity,
    risk: task.risk,
    required_roles: task.required_roles,
    required_capabilities: task.required_capabilities,
    required_inputs: task.required_inputs,
    expected_outputs: task.expected_outputs,
    environment_policy_ref: task.environment_policy_ref,
    verification_policy_ref: task.verification_policy_ref,
  };
}

function v2AssignmentProposalMaterial(assignment: V2AgentAssignmentT): unknown {
  return {
    agent_profile_id: assignment.agent_profile_id,
    rationale: assignment.rationale,
    rationale_factors: assignment.rationale_factors,
    budget_limit_usd: assignment.budget_limit_usd,
    reviewer_agent_profile_id: assignment.reviewer_agent_profile_id,
    allocation_policy_ref: assignment.allocation_policy_ref,
  };
}

function v2DependencyIdentity(dependency: V2TaskDependencyT): unknown {
  return {
    project_id: dependency.project_id,
    phase_id: dependency.phase_id,
    predecessor_task_id: dependency.predecessor_task_id,
    predecessor_phase_id: dependency.predecessor_phase_id,
    successor_task_id: dependency.successor_task_id,
    successor_phase_id: dependency.successor_phase_id,
  };
}

function v2LockedAmendmentChange(
  entityKind: string,
  entityId: string,
  currentStatus: string,
): never {
  throw new V2StrategyAmendmentConflict(
    "locked_entity_change",
    `${entityKind} ${entityId} is ${currentStatus}; its approved proposal fields are execution/history-locked`,
    entityKind,
    entityId,
  );
}

/**
 * Applies an approved StrategyVersion amendment to already materialized
 * canonical rows.
 *
 * MVP amendment rules are deliberately conservative:
 * - existing phase-scoped IDs may not disappear or be renamed;
 * - Objective proposal fields may change only while proposed/active;
 * - Task proposal fields (including new incoming dependencies) may change only
 *   while pending/ready;
 * - Assignment proposal fields may change only while proposed;
 * - relationship identity and existing dependency edges are immutable.
 *
 * Existing lifecycle state, evidence, designations, and historical timestamps
 * are preserved. A changed canonical row advances aggregate_version and
 * updated_at; created/completed timestamps are never reset. Every existing
 * Task records the new StrategyVersion provenance even when its proposal fields
 * are unchanged.
 */
export function mergeV2StrategyAmendment(
  existingInput: V2StrategyMaterialization,
  amendmentInput: V2StrategyVersionT,
  amendedAt: string,
  serverSha256: (canonicalContent: string) => string,
): V2StrategyMaterialization {
  const amendment = V2StrategyVersion.parse(amendmentInput);
  if (amendment.supersedes_strategy_version_id === null) {
    throw new V2StrategyAmendmentConflict(
      "invalid_supersession",
      "a StrategyVersion amendment must name the StrategyVersion it supersedes",
    );
  }

  const existing: V2StrategyMaterialization = {
    objectives: existingInput.objectives.map((objective) => V2Objective.parse(objective)),
    tasks: existingInput.tasks.map((task) => V2Task.parse(task)),
    task_dependencies: existingInput.task_dependencies.map((dependency) =>
      V2TaskDependency.parse(dependency),
    ),
    agent_assignments: existingInput.agent_assignments.map((assignment) =>
      V2AgentAssignment.parse(assignment),
    ),
  };
  const proposed = materializeV2StrategyVersion(amendment, amendedAt, serverSha256);
  const timestamp = V2IsoDateTime.parse(amendedAt);

  v2AssertAmendmentScope(amendment, "Objective", existing.objectives);
  v2AssertAmendmentScope(amendment, "Task", existing.tasks);
  v2AssertAmendmentScope(amendment, "TaskDependency", existing.task_dependencies);
  v2AssertAmendmentScope(amendment, "AgentAssignment", existing.agent_assignments);

  for (const task of existing.tasks) {
    if (
      task.strategy_version_id !== amendment.supersedes_strategy_version_id &&
      task.strategy_version_id !== amendment.id
    ) {
      throw new V2StrategyAmendmentConflict(
        "invalid_supersession",
        `Task ${task.id} provenance ${task.strategy_version_id} is not the superseded or current StrategyVersion`,
        "Task",
        task.id,
      );
    }
  }

  const existingObjectives = v2MaterializedEntityMap("Objective", existing.objectives);
  const proposedObjectives = v2MaterializedEntityMap("Objective", proposed.objectives);
  const existingTasks = v2MaterializedEntityMap("Task", existing.tasks);
  const proposedTasks = v2MaterializedEntityMap("Task", proposed.tasks);
  const existingDependencies = v2MaterializedEntityMap(
    "TaskDependency",
    existing.task_dependencies,
  );
  const proposedDependencies = v2MaterializedEntityMap(
    "TaskDependency",
    proposed.task_dependencies,
  );
  const existingAssignments = v2MaterializedEntityMap(
    "AgentAssignment",
    existing.agent_assignments,
  );
  const proposedAssignments = v2MaterializedEntityMap(
    "AgentAssignment",
    proposed.agent_assignments,
  );

  v2AssertNoRemovedMaterializedIds("Objective", existingObjectives, proposedObjectives);
  v2AssertNoRemovedMaterializedIds("Task", existingTasks, proposedTasks);
  v2AssertNoRemovedMaterializedIds("AgentAssignment", existingAssignments, proposedAssignments);
  v2AssertNoRemovedMaterializedIds("TaskDependency", existingDependencies, proposedDependencies);

  const objectives = proposed.objectives.map((proposal) => {
    const current = existingObjectives.get(proposal.id);
    if (current === undefined) return proposal;
    const changed = !v2SameAmendmentMaterial(
      v2ObjectiveProposalMaterial(current),
      v2ObjectiveProposalMaterial(proposal),
    );
    if (changed && current.status !== "proposed" && current.status !== "active") {
      return v2LockedAmendmentChange("Objective", current.id, current.status);
    }
    return V2Objective.parse({
      ...proposal,
      status: current.status,
      completion_evidence: current.completion_evidence,
      aggregate_version: current.aggregate_version + (changed ? 1 : 0),
      created_at: current.created_at,
      updated_at: changed ? timestamp : current.updated_at,
    });
  });

  const tasks = proposed.tasks.map((proposal) => {
    const current = existingTasks.get(proposal.id);
    if (current === undefined) return proposal;
    const changed = !v2SameAmendmentMaterial(
      v2TaskProposalMaterial(current),
      v2TaskProposalMaterial(proposal),
    );
    if (changed && current.state !== "pending" && current.state !== "ready") {
      return v2LockedAmendmentChange("Task", current.id, current.state);
    }
    const provenanceChanged = current.strategy_version_id !== amendment.id;
    return V2Task.parse({
      ...proposal,
      strategy_version_id: amendment.id,
      state: current.state,
      designated_assignment_id: current.designated_assignment_id,
      designated_run_id: current.designated_run_id,
      review_evidence: current.review_evidence,
      completion_evidence: current.completion_evidence,
      lifecycle_version: current.lifecycle_version,
      aggregate_version: current.aggregate_version + (changed || provenanceChanged ? 1 : 0),
      created_at: current.created_at,
      updated_at: changed || provenanceChanged ? timestamp : current.updated_at,
      completed_at: current.completed_at,
    });
  });

  const taskDependencies = proposed.task_dependencies.map((proposal) => {
    const current = existingDependencies.get(proposal.id);
    if (current !== undefined) {
      if (!v2SameAmendmentMaterial(v2DependencyIdentity(current), v2DependencyIdentity(proposal))) {
        throw new V2StrategyAmendmentConflict(
          "identity_relationship_change_forbidden",
          `TaskDependency ${current.id} cannot change endpoints or scope`,
          "TaskDependency",
          current.id,
        );
      }
      return current;
    }

    const successor = existingTasks.get(proposal.successor_task_id);
    if (successor !== undefined && successor.state !== "pending" && successor.state !== "ready") {
      return v2LockedAmendmentChange("Task", successor.id, successor.state);
    }
    return proposal;
  });

  const agentAssignments = proposed.agent_assignments.map((proposal) => {
    const current = existingAssignments.get(proposal.id);
    if (current === undefined) return proposal;
    if (current.task_id !== proposal.task_id) {
      throw new V2StrategyAmendmentConflict(
        "identity_relationship_change_forbidden",
        `AgentAssignment ${current.id} cannot move to a different Task`,
        "AgentAssignment",
        current.id,
      );
    }
    const changed = !v2SameAmendmentMaterial(
      v2AssignmentProposalMaterial(current),
      v2AssignmentProposalMaterial(proposal),
    );
    if (changed && current.status !== "proposed") {
      return v2LockedAmendmentChange("AgentAssignment", current.id, current.status);
    }
    return V2AgentAssignment.parse({
      ...proposal,
      status: current.status,
      aggregate_version: current.aggregate_version + (changed ? 1 : 0),
      created_at: current.created_at,
      updated_at: changed ? timestamp : current.updated_at,
    });
  });

  return {
    objectives,
    tasks,
    task_dependencies: taskDependencies,
    agent_assignments: agentAssignments,
  };
}
