import { describe, expect, it } from "vitest";
import {
  V2AgentAssignment,
  V2AgentProfile,
  V2AgentRun,
  V2ArchitectureRevision,
  V2DecisionPoint,
  V2DecisionRecord,
  V2Objective,
  V2Phase,
  V2PhaseDependency,
  V2Project,
  V2ProjectMemoryEntry,
  V2StrategyVersion,
  V2Task,
  V2TaskComplexity,
  V2TaskDependency,
  materializeV2StrategyVersion,
  v2DecisionPointConditionKey,
} from "../src/v2/index.js";

const NOW = "2026-07-16T12:00:00.000Z";
const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);
const evidence = {
  artifact_id: "artifact-1",
  content_hash: HASH,
  media_type: "text/markdown",
  label: "Evidence",
};
const approval = {
  approval_id: "approval-1",
  approved_by: "user-1",
  approved_at: NOW,
  content_hash: HASH,
};

const project = {
  schema_version: 2,
  id: "project-1",
  name: "The Norns",
  description: "Persistent project",
  status: "active",
  primary_repository_binding_id: "repo-1",
  current_architecture_revision_id: "architecture-1",
  coordinator_policy: {
    max_executing_phases: 1,
    max_concurrent_tasks: 3,
    assignment_policy_ref: "assignment-policy-1",
  },
  verification_policy_ref: "verification-policy-1",
  budget_policy_ref: "budget-policy-1",
  aggregate_version: 1,
  created_at: NOW,
  updated_at: NOW,
  archived_at: null,
} as const;

const phase = {
  schema_version: 2,
  id: "phase-1",
  project_id: "project-1",
  objective_summary: "Build the domain foundation",
  priority: 1,
  status: "approved",
  approved_strategy_version_id: "strategy-1",
  approved_budget_usd: 100,
  aggregate_version: 1,
  started_at: null,
  closed_at: null,
  closure_summary: null,
  closure_evidence: [],
  created_at: NOW,
  updated_at: NOW,
} as const;

const objective = {
  schema_version: 2,
  id: "objective-1",
  project_id: "project-1",
  phase_id: "phase-1",
  outcome: "V2 contracts are frozen",
  success_measures: ["Every entity validates"],
  status: "active",
  order: 0,
  completion_evidence: [],
  aggregate_version: 1,
  created_at: NOW,
  updated_at: NOW,
} as const;

const task = {
  schema_version: 2,
  id: "task-1",
  project_id: "project-1",
  phase_id: "phase-1",
  objective_id: "objective-1",
  strategy_version_id: "strategy-1",
  title: "Define schemas",
  description: "Create versioned schemas",
  deliverables: ["Contracts package"],
  acceptance_criteria: ["Typecheck passes"],
  complexity: "L",
  risk: "medium",
  required_roles: ["backend"],
  required_capabilities: ["typescript"],
  required_inputs: [],
  expected_outputs: ["Compiled declarations"],
  environment_policy_ref: "environment-1",
  verification_policy_ref: "verification-policy-1",
  state: "pending",
  designated_assignment_id: null,
  designated_run_id: null,
  review_evidence: [],
  completion_evidence: [],
  lifecycle_version: 0,
  aggregate_version: 1,
  created_at: NOW,
  updated_at: NOW,
  completed_at: null,
} as const;

const strategy = {
  schema_version: 2,
  id: "strategy-1",
  project_id: "project-1",
  phase_id: "phase-1",
  version: 1,
  status: "awaiting_approval",
  objective: "Build persistent project contracts",
  assumptions: [],
  risks: ["Contract churn"],
  scope_in: ["V2 contracts"],
  scope_out: ["Server implementation"],
  architecture_impact: "Adds a parallel V2 namespace",
  proposed_objectives: [
    {
      local_id: "objective-local-1",
      outcome: "Contracts compile",
      success_measures: ["Tests pass"],
    },
  ],
  proposed_tasks: [
    {
      local_id: "task-local-1",
      objective_local_id: "objective-local-1",
      title: "Implement",
      description: "Implement schemas",
      deliverables: ["V2 contract package"],
      acceptance_criteria: ["Tests pass"],
      complexity: "L",
      risk: "medium",
      required_roles: ["backend"],
      required_capabilities: ["typescript"],
      required_inputs: [],
      expected_outputs: ["Compiled contracts"],
      environment_policy_ref: "environment-policy-1",
      verification_policy_ref: "verification-policy-1",
      dependency_local_ids: [],
    },
  ],
  proposed_assignments: [
    {
      local_id: "assignment-local-1",
      task_local_id: "task-local-1",
      agent_profile_id: "agent-1",
      rationale: "Best TypeScript capability",
      rationale_factors: ["capability", "workload"],
      budget_limit_usd: 25,
      reviewer_agent_profile_id: "reviewer-1",
      allocation_policy_ref: "allocation-policy-1",
    },
  ],
  proposed_concurrency: 1,
  proposed_budget_usd: 25,
  provenance: [
    {
      provider: "openai",
      model: "gpt-5",
      runtime: "codex",
      generated_at: NOW,
      invocation_id: "invocation-1",
    },
  ],
  convergence: "converged",
  review_rounds: 2,
  findings: [],
  content_hash: HASH,
  approval: null,
  supersedes_strategy_version_id: null,
  aggregate_version: 1,
  created_at: NOW,
  updated_at: NOW,
} as const;

describe("V2 canonical domain schemas", () => {
  it("represents every Phase 1 canonical entity at schema version 2", () => {
    expect(V2Project.safeParse(project).success).toBe(true);
    expect(V2Phase.safeParse(phase).success).toBe(true);
    expect(
      V2PhaseDependency.safeParse({
        schema_version: 2,
        id: "phase-dependency-1",
        project_id: "project-1",
        predecessor_phase_id: "phase-0",
        successor_phase_id: "phase-1",
        created_at: NOW,
      }).success,
    ).toBe(true);
    expect(V2Objective.safeParse(objective).success).toBe(true);
    expect(V2Task.safeParse(task).success).toBe(true);
    expect(
      V2TaskDependency.safeParse({
        schema_version: 2,
        id: "task-dependency-1",
        project_id: "project-1",
        phase_id: "phase-1",
        predecessor_task_id: "task-0",
        predecessor_phase_id: "phase-1",
        successor_task_id: "task-1",
        successor_phase_id: "phase-1",
        created_at: NOW,
      }).success,
    ).toBe(true);
    expect(V2StrategyVersion.safeParse(strategy).success).toBe(true);
    expect(
      V2AgentProfile.safeParse({
        schema_version: 2,
        id: "agent-1",
        provider: "openai",
        runtime: "codex",
        model: "gpt-5",
        roles: ["backend"],
        capabilities: ["typescript"],
        context_limit_tokens: 200_000,
        security_restrictions: ["no production secrets"],
        status: "available",
        active_workload: 0,
        cost_metadata: {
          billing_mode: "subscription",
          input_usd_per_million: null,
          output_usd_per_million: null,
        },
        aggregate_version: 1,
        created_at: NOW,
        updated_at: NOW,
      }).success,
    ).toBe(true);
    expect(
      V2AgentAssignment.safeParse({
        schema_version: 2,
        id: "assignment-1",
        project_id: "project-1",
        phase_id: "phase-1",
        task_id: "task-1",
        agent_profile_id: "agent-1",
        status: "active",
        rationale: "Strong capability and low workload",
        rationale_factors: ["capability", "workload", "risk", "budget", "review"],
        budget_limit_usd: 25,
        reviewer_agent_profile_id: "reviewer-1",
        allocation_policy_ref: "allocation-policy-1",
        aggregate_version: 1,
        created_at: NOW,
        updated_at: NOW,
      }).success,
    ).toBe(true);
    expect(
      V2AgentRun.safeParse({
        schema_version: 2,
        id: "run-1",
        project_id: "project-1",
        phase_id: "phase-1",
        task_id: "task-1",
        assignment_id: "assignment-1",
        attempt: 1,
        state: "created",
        is_designated: true,
        runner_id: null,
        runtime_session_id: null,
        repository_binding_id: "repo-1",
        expected_revision: "abc123",
        worktree_ref: null,
        commit_sha: null,
        usage_input_tokens: 0,
        usage_output_tokens: 0,
        usage_cost_usd: 0,
        artifacts: [],
        verification_status: "pending",
        result_summary: null,
        failure_code: null,
        failure_detail: null,
        superseded_at: null,
        superseded_by_run_id: null,
        lifecycle_version: 0,
        aggregate_version: 1,
        created_at: NOW,
        updated_at: NOW,
        started_at: null,
        finished_at: null,
      }).success,
    ).toBe(true);

    const conditionParts = {
      project_id: "project-1",
      scope_entity_type: "task",
      scope_entity_id: "task-1",
      reason_class: "merge_conflict",
      source_instance_id: "conflict-1",
    } as const;
    expect(
      V2DecisionPoint.safeParse({
        schema_version: 2,
        id: "decision-point-1",
        phase_id: "phase-1",
        task_id: "task-1",
        ...conditionParts,
        condition_key: v2DecisionPointConditionKey(conditionParts),
        condition_fingerprint: HASH,
        condition_revision: 1,
        question: "Which conflict resolution should be used?",
        context: "Both changes are valid.",
        options: [{ id: "option-1", label: "Keep A", impact: "Preserves A", risk: "Drops B" }],
        recommendation_option_id: "option-1",
        urgency: "high",
        blocking_scope: { entity_type: "task", entity_id: "task-1" },
        status: "open",
        supersedes_decision_point_id: null,
        superseded_by_decision_point_id: null,
        created_at: NOW,
        updated_at: NOW,
        resolved_at: null,
      }).success,
    ).toBe(true);
    expect(
      V2DecisionRecord.safeParse({
        schema_version: 2,
        id: "decision-record-1",
        project_id: "project-1",
        phase_id: "phase-1",
        decision_point_id: "decision-point-1",
        title: "Keep A",
        rationale: "A preserves the architecture boundary.",
        selected_option_id: "option-1",
        status: "active",
        decided_by: "user-1",
        approval_evidence: approval,
        affected_entities: [{ entity_type: "task", entity_id: "task-1" }],
        supersedes_decision_record_id: null,
        superseded_by_decision_record_id: null,
        created_at: NOW,
      }).success,
    ).toBe(true);
    expect(
      V2ProjectMemoryEntry.safeParse({
        schema_version: 2,
        id: "memory-1",
        project_id: "project-1",
        phase_id: null,
        task_id: null,
        category: "repository_fact",
        content: "The repository uses pnpm.",
        provenance: "package.json",
        source_ref: null,
        confidence: 1,
        version: 1,
        status: "active",
        approved_by_human: false,
        approved_by: null,
        approved_at: null,
        supersedes_memory_entry_id: null,
        superseded_by_memory_entry_id: null,
        created_at: NOW,
      }).success,
    ).toBe(true);
    expect(
      V2ArchitectureRevision.safeParse({
        schema_version: 2,
        id: "architecture-1",
        project_id: "project-1",
        phase_id: "phase-1",
        revision: 1,
        title: "Persistent project architecture",
        summary: "Task is canonical execution truth.",
        architecture_document_ref: evidence,
        repository_revision: "abc123",
        provenance: { actor_type: "human", actor_id: "user-1" },
        approval,
        supersedes_architecture_revision_id: null,
        created_at: NOW,
      }).success,
    ).toBe(true);
  });

  it("rejects cross-phase TaskDependencies while allowing PhaseDependencies", () => {
    const crossPhaseTaskDependency = {
      schema_version: 2,
      id: "task-dependency-1",
      project_id: "project-1",
      phase_id: "phase-1",
      predecessor_task_id: "task-1",
      predecessor_phase_id: "phase-1",
      successor_task_id: "task-2",
      successor_phase_id: "phase-2",
      created_at: NOW,
    };
    expect(V2TaskDependency.safeParse(crossPhaseTaskDependency).success).toBe(false);
    expect(
      V2PhaseDependency.safeParse({
        schema_version: 2,
        id: "phase-dependency-1",
        project_id: "project-1",
        predecessor_phase_id: "phase-1",
        successor_phase_id: "phase-2",
        created_at: NOW,
      }).success,
    ).toBe(true);
  });

  it("separates lifecycle and aggregate versions", () => {
    expect(V2Task.parse(task)).toMatchObject({ lifecycle_version: 0, aggregate_version: 1 });
    expect(V2Task.safeParse({ ...task, aggregate_version: 9, lifecycle_version: 0 }).success).toBe(
      true,
    );
  });

  it("preserves the legacy S/M/L/XL complexity scale for lossless import", () => {
    for (const complexity of ["S", "M", "L", "XL"]) {
      expect(V2TaskComplexity.safeParse(complexity).success).toBe(true);
    }
    expect(V2TaskComplexity.safeParse("high").success).toBe(false);
  });

  it("requires human approval for directives and strategic decisions", () => {
    expect(
      V2ProjectMemoryEntry.safeParse({
        schema_version: 2,
        id: "memory-1",
        project_id: "project-1",
        phase_id: null,
        task_id: null,
        category: "directive",
        content: "Never weaken required verification.",
        provenance: "program charter",
        source_ref: null,
        confidence: 1,
        version: 1,
        status: "active",
        approved_by_human: false,
        approved_by: null,
        approved_at: null,
        supersedes_memory_entry_id: null,
        superseded_by_memory_entry_id: null,
        created_at: NOW,
      }).success,
    ).toBe(false);
  });

  it("does not permit completion without review and completion evidence", () => {
    expect(
      V2Task.safeParse({
        ...task,
        state: "completed",
        completed_at: NOW,
      }).success,
    ).toBe(false);
    expect(
      V2Task.safeParse({
        ...task,
        state: "completed",
        completed_at: NOW,
        review_evidence: [evidence],
        completion_evidence: [evidence],
      }).success,
    ).toBe(true);
  });

  it("cannot represent an approved non-converged strategy", () => {
    expect(
      V2StrategyVersion.safeParse({
        ...strategy,
        status: "approved",
        convergence: "cap_reached",
        approval,
      }).success,
    ).toBe(false);
  });

  it("materializes every proposed Task and Assignment field exactly", () => {
    const secondTask = {
      ...strategy.proposed_tasks[0],
      local_id: "task-local-2",
      title: "Verify contracts",
      deliverables: ["Independent review packet"],
      acceptance_criteria: ["Review disposition recorded"],
      complexity: "M",
      risk: "low",
      required_roles: ["review"],
      required_capabilities: ["architecture-review"],
      expected_outputs: ["Review findings"],
      dependency_local_ids: ["task-local-1"],
    } as const;
    const secondAssignment = {
      ...strategy.proposed_assignments[0],
      local_id: "assignment-local-2",
      task_local_id: "task-local-2",
      agent_profile_id: "reviewer-2",
      rationale: "Independent review capability",
      rationale_factors: ["capability", "review"],
      budget_limit_usd: 5,
      reviewer_agent_profile_id: null,
    } as const;
    const completeStrategy = V2StrategyVersion.parse({
      ...strategy,
      status: "approved",
      approval,
      proposed_tasks: [...strategy.proposed_tasks, secondTask],
      proposed_assignments: [...strategy.proposed_assignments, secondAssignment],
    });
    const materialized = materializeV2StrategyVersion(completeStrategy, NOW, () => HASH);

    expect(materialized.objectives).toHaveLength(1);
    expect(materialized.tasks).toHaveLength(2);
    expect(materialized.agent_assignments).toHaveLength(2);
    expect(materialized.task_dependencies).toHaveLength(1);

    const taskTwo = materialized.tasks.find((candidate) => candidate.title === secondTask.title);
    expect(taskTwo).toMatchObject({
      project_id: completeStrategy.project_id,
      phase_id: completeStrategy.phase_id,
      strategy_version_id: completeStrategy.id,
      title: secondTask.title,
      description: secondTask.description,
      deliverables: secondTask.deliverables,
      acceptance_criteria: secondTask.acceptance_criteria,
      complexity: secondTask.complexity,
      risk: secondTask.risk,
      required_roles: secondTask.required_roles,
      required_capabilities: secondTask.required_capabilities,
      required_inputs: secondTask.required_inputs,
      expected_outputs: secondTask.expected_outputs,
      environment_policy_ref: secondTask.environment_policy_ref,
      verification_policy_ref: secondTask.verification_policy_ref,
      state: "pending",
      lifecycle_version: 0,
      aggregate_version: 1,
    });
    const assignmentTwo = materialized.agent_assignments.find(
      (candidate) => candidate.agent_profile_id === secondAssignment.agent_profile_id,
    );
    expect(assignmentTwo).toMatchObject({
      task_id: taskTwo?.id,
      rationale: secondAssignment.rationale,
      rationale_factors: secondAssignment.rationale_factors,
      budget_limit_usd: secondAssignment.budget_limit_usd,
      reviewer_agent_profile_id: secondAssignment.reviewer_agent_profile_id,
      allocation_policy_ref: secondAssignment.allocation_policy_ref,
      status: "proposed",
      aggregate_version: 1,
    });
    expect(materialized.task_dependencies[0]).toMatchObject({
      predecessor_task_id: materialized.tasks[0]?.id,
      successor_task_id: taskTwo?.id,
      predecessor_phase_id: completeStrategy.phase_id,
      successor_phase_id: completeStrategy.phase_id,
    });
    expect(taskTwo?.designated_assignment_id).toBe(assignmentTwo?.id);
    expect(() => materializeV2StrategyVersion(completeStrategy, NOW, () => OTHER_HASH)).toThrow(
      "hash is stale",
    );
  });

  it("refuses materialization before approval is committed", () => {
    expect(() =>
      materializeV2StrategyVersion(V2StrategyVersion.parse(strategy), NOW, () => HASH),
    ).toThrow("only an approved StrategyVersion");
  });

  it("rejects ambiguous or invalid strategy materialization graphs", () => {
    const taskTwo = {
      ...strategy.proposed_tasks[0],
      local_id: "task-local-2",
      dependency_local_ids: ["task-local-1"],
    };
    const assignmentTwo = {
      ...strategy.proposed_assignments[0],
      local_id: "assignment-local-2",
      task_local_id: "task-local-2",
    };

    const invalidStrategies = [
      {
        ...strategy,
        proposed_assignments: [{ ...strategy.proposed_assignments[0], local_id: "task-local-1" }],
      },
      {
        ...strategy,
        proposed_tasks: [
          { ...strategy.proposed_tasks[0], objective_local_id: "missing-objective" },
        ],
      },
      {
        ...strategy,
        proposed_tasks: [{ ...strategy.proposed_tasks[0], dependency_local_ids: ["task-local-1"] }],
      },
      {
        ...strategy,
        proposed_tasks: [{ ...strategy.proposed_tasks[0], dependency_local_ids: ["missing-task"] }],
      },
      {
        ...strategy,
        proposed_tasks: [
          { ...strategy.proposed_tasks[0], dependency_local_ids: ["task-local-2"] },
          taskTwo,
        ],
        proposed_assignments: [...strategy.proposed_assignments, assignmentTwo],
      },
      {
        ...strategy,
        proposed_assignments: [
          ...strategy.proposed_assignments,
          { ...strategy.proposed_assignments[0], local_id: "assignment-local-2" },
        ],
      },
      {
        ...strategy,
        proposed_assignments: [
          { ...strategy.proposed_assignments[0], task_local_id: "missing-task" },
        ],
      },
    ];
    for (const invalid of invalidStrategies) {
      expect(V2StrategyVersion.safeParse(invalid).success).toBe(false);
    }
  });

  it("keeps DecisionPoint stable identity separate from material fingerprint", () => {
    const parts = {
      project_id: "project-1",
      scope_entity_type: "task",
      scope_entity_id: "task-1",
      reason_class: "merge_conflict",
      source_instance_id: "conflict-1",
    } as const;
    const key = v2DecisionPointConditionKey(parts);
    expect(key).toBe(v2DecisionPointConditionKey(parts));
    expect(key).not.toContain(HASH);
    expect(HASH).not.toEqual(OTHER_HASH);
  });

  it("rejects a run that is both designated and superseded", () => {
    const parsed = V2AgentRun.safeParse({
      schema_version: 2,
      id: "run-1",
      project_id: "project-1",
      phase_id: "phase-1",
      task_id: "task-1",
      assignment_id: "assignment-1",
      attempt: 1,
      state: "failed",
      is_designated: true,
      runner_id: "runner-1",
      runtime_session_id: null,
      repository_binding_id: "repo-1",
      expected_revision: "abc123",
      worktree_ref: null,
      commit_sha: null,
      usage_input_tokens: 0,
      usage_output_tokens: 0,
      usage_cost_usd: 0,
      artifacts: [],
      verification_status: "failed",
      result_summary: null,
      failure_code: "tests_failed",
      failure_detail: "one test failed",
      superseded_at: NOW,
      superseded_by_run_id: "run-2",
      lifecycle_version: 3,
      aggregate_version: 4,
      created_at: NOW,
      updated_at: NOW,
      started_at: NOW,
      finished_at: NOW,
    });
    expect(parsed.success).toBe(false);
  });
});
