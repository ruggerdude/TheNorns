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
  mergeV2StrategyAmendment,
  v2DecisionPointConditionKey,
} from "../src/v2/index.js";

const NOW = "2026-07-16T12:00:00.000Z";
const LATER = "2026-07-16T13:00:00.000Z";
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

const agentRun = {
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
    expect(V2AgentRun.safeParse(agentRun).success).toBe(true);

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

  it("pins version-zero lifecycle rows to their reproducible origins", () => {
    expect(V2Task.safeParse({ ...task, state: "ready", lifecycle_version: 0 }).success).toBe(false);
    expect(V2Task.safeParse({ ...task, state: "ready", lifecycle_version: 1 }).success).toBe(true);
    expect(
      V2AgentRun.safeParse({ ...agentRun, state: "dispatched", lifecycle_version: 0 }).success,
    ).toBe(false);
    expect(
      V2AgentRun.safeParse({ ...agentRun, state: "dispatched", lifecycle_version: 1 }).success,
    ).toBe(true);
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
        lifecycle_version: 4,
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

  it("merges approved amendments without resetting canonical execution history", () => {
    const dependentTask = {
      ...strategy.proposed_tasks[0],
      local_id: "task-local-2",
      title: "Verify contracts",
      dependency_local_ids: ["task-local-1"],
    } as const;
    const dependentAssignment = {
      ...strategy.proposed_assignments[0],
      local_id: "assignment-local-2",
      task_local_id: "task-local-2",
      agent_profile_id: "reviewer-2",
    } as const;
    const approvedInitialStrategy = V2StrategyVersion.parse({
      ...strategy,
      status: "approved",
      approval,
      proposed_tasks: [...strategy.proposed_tasks, dependentTask],
      proposed_assignments: [...strategy.proposed_assignments, dependentAssignment],
      proposed_concurrency: 2,
      proposed_budget_usd: 50,
    });
    const initial = materializeV2StrategyVersion(approvedInitialStrategy, NOW, () => HASH);

    expect(initial.objectives.map(({ id }) => id)).toEqual(["objective:phase-1:objective-local-1"]);
    expect(initial.tasks.map(({ id }) => id)).toEqual([
      "task:phase-1:task-local-1",
      "task:phase-1:task-local-2",
    ]);
    expect(initial.agent_assignments.map(({ id }) => id)).toEqual([
      "assignment:phase-1:assignment-local-1",
      "assignment:phase-1:assignment-local-2",
    ]);
    expect(initial.task_dependencies.map(({ id }) => id)).toEqual([
      "task-dependency:phase-1:task-local-1:task-local-2",
    ]);

    const existing = {
      objectives: initial.objectives,
      tasks: [
        V2Task.parse({
          ...initial.tasks[0],
          state: "completed",
          review_evidence: [evidence],
          completion_evidence: [evidence],
          lifecycle_version: 4,
          aggregate_version: 5,
          completed_at: NOW,
        }),
        V2Task.parse({
          ...initial.tasks[1],
          state: "ready",
          lifecycle_version: 1,
          aggregate_version: 2,
        }),
      ],
      task_dependencies: initial.task_dependencies,
      agent_assignments: [
        V2AgentAssignment.parse({
          ...initial.agent_assignments[0],
          status: "completed",
          aggregate_version: 3,
        }),
        V2AgentAssignment.parse(initial.agent_assignments[1]),
      ],
    };
    const newObjective = {
      local_id: "objective-local-2",
      outcome: "Amendment is independently verified",
      success_measures: ["Amendment tests pass"],
    } as const;
    const newTask = {
      ...strategy.proposed_tasks[0],
      local_id: "task-local-3",
      objective_local_id: newObjective.local_id,
      title: "Review amendment",
      dependency_local_ids: ["task-local-2"],
    } as const;
    const newAssignment = {
      ...strategy.proposed_assignments[0],
      local_id: "assignment-local-3",
      task_local_id: "task-local-3",
      agent_profile_id: "reviewer-3",
    } as const;
    const amendmentApproval = {
      ...approval,
      approval_id: "approval-2",
      approved_at: LATER,
      content_hash: OTHER_HASH,
    };
    const amendedStrategy = V2StrategyVersion.parse({
      ...approvedInitialStrategy,
      id: "strategy-2",
      version: 2,
      approval: amendmentApproval,
      content_hash: OTHER_HASH,
      supersedes_strategy_version_id: approvedInitialStrategy.id,
      proposed_objectives: [...approvedInitialStrategy.proposed_objectives, newObjective],
      proposed_tasks: [
        approvedInitialStrategy.proposed_tasks[0],
        {
          ...approvedInitialStrategy.proposed_tasks[1],
          title: "Verify amended contracts",
        },
        newTask,
      ],
      proposed_assignments: [
        approvedInitialStrategy.proposed_assignments[0],
        {
          ...approvedInitialStrategy.proposed_assignments[1],
          rationale: "Review the amended contract surface",
          budget_limit_usd: 8,
        },
        newAssignment,
      ],
      proposed_concurrency: 3,
      proposed_budget_usd: 75,
      aggregate_version: 1,
      created_at: LATER,
      updated_at: LATER,
    });
    const amended = mergeV2StrategyAmendment(existing, amendedStrategy, LATER, () => OTHER_HASH);

    expect(mergeV2StrategyAmendment(amended, amendedStrategy, LATER, () => OTHER_HASH)).toEqual(
      amended,
    );
    expect(amended.objectives.slice(0, initial.objectives.length).map(({ id }) => id)).toEqual(
      initial.objectives.map(({ id }) => id),
    );
    expect(amended.tasks.slice(0, initial.tasks.length).map(({ id }) => id)).toEqual(
      initial.tasks.map(({ id }) => id),
    );
    expect(
      amended.agent_assignments.slice(0, initial.agent_assignments.length).map(({ id }) => id),
    ).toEqual(initial.agent_assignments.map(({ id }) => id));
    expect(
      amended.task_dependencies.slice(0, initial.task_dependencies.length).map(({ id }) => id),
    ).toEqual(initial.task_dependencies.map(({ id }) => id));

    expect(amended.objectives.at(-1)?.id).toBe("objective:phase-1:objective-local-2");
    expect(amended.tasks.at(-1)?.id).toBe("task:phase-1:task-local-3");
    expect(amended.agent_assignments.at(-1)?.id).toBe("assignment:phase-1:assignment-local-3");
    expect(amended.task_dependencies.at(-1)?.id).toBe(
      "task-dependency:phase-1:task-local-2:task-local-3",
    );
    expect(
      amended.tasks.every(({ strategy_version_id }) => strategy_version_id === "strategy-2"),
    ).toBe(true);
    expect(amended.tasks[0]).toMatchObject({
      id: existing.tasks[0]?.id,
      strategy_version_id: amendedStrategy.id,
      title: existing.tasks[0]?.title,
      state: "completed",
      designated_assignment_id: existing.tasks[0]?.designated_assignment_id,
      lifecycle_version: 4,
      aggregate_version: 6,
      review_evidence: [evidence],
      completion_evidence: [evidence],
      created_at: NOW,
      updated_at: LATER,
      completed_at: NOW,
    });
    expect(amended.tasks[1]).toMatchObject({
      id: existing.tasks[1]?.id,
      title: "Verify amended contracts",
      state: "ready",
      lifecycle_version: 1,
      aggregate_version: 3,
      created_at: NOW,
      updated_at: LATER,
    });
    expect(amended.agent_assignments[0]).toEqual(existing.agent_assignments[0]);
    expect(amended.agent_assignments[1]).toMatchObject({
      status: "proposed",
      rationale: "Review the amended contract surface",
      budget_limit_usd: 8,
      aggregate_version: 2,
      created_at: NOW,
      updated_at: LATER,
    });
    expect(amended.task_dependencies[0]).toEqual(existing.task_dependencies[0]);
    expect(amended.task_dependencies[1]?.created_at).toBe(LATER);
  });

  it("forbids silent removal or rename of any previously materialized MVP entity", () => {
    const secondObjective = {
      local_id: "objective-local-2",
      outcome: "Review is complete",
      success_measures: ["Findings are dispositioned"],
    } as const;
    const secondTask = {
      ...strategy.proposed_tasks[0],
      local_id: "task-local-2",
      objective_local_id: secondObjective.local_id,
      title: "Review contracts",
      dependency_local_ids: ["task-local-1"],
    } as const;
    const secondAssignment = {
      ...strategy.proposed_assignments[0],
      local_id: "assignment-local-2",
      task_local_id: secondTask.local_id,
      agent_profile_id: "reviewer-2",
    } as const;
    const initialStrategy = V2StrategyVersion.parse({
      ...strategy,
      status: "approved",
      approval,
      proposed_objectives: [...strategy.proposed_objectives, secondObjective],
      proposed_tasks: [...strategy.proposed_tasks, secondTask],
      proposed_assignments: [...strategy.proposed_assignments, secondAssignment],
    });
    const existing = materializeV2StrategyVersion(initialStrategy, NOW, () => HASH);
    const amendmentBase = {
      ...initialStrategy,
      id: "strategy-2",
      version: 2,
      content_hash: OTHER_HASH,
      approval: { ...approval, approval_id: "approval-2", content_hash: OTHER_HASH },
      supersedes_strategy_version_id: initialStrategy.id,
      created_at: LATER,
      updated_at: LATER,
    } as const;

    const removals = [
      {
        expected: "Objective objective:phase-1:objective-local-2",
        amendment: {
          ...amendmentBase,
          proposed_objectives: initialStrategy.proposed_objectives.slice(0, 1),
          proposed_tasks: [
            initialStrategy.proposed_tasks[0],
            { ...initialStrategy.proposed_tasks[1], objective_local_id: "objective-local-1" },
          ],
        },
      },
      {
        expected: "Task task:phase-1:task-local-2",
        amendment: {
          ...amendmentBase,
          proposed_tasks: initialStrategy.proposed_tasks.slice(0, 1),
          proposed_assignments: initialStrategy.proposed_assignments.slice(0, 1),
        },
      },
      {
        expected: "AgentAssignment assignment:phase-1:assignment-local-2",
        amendment: {
          ...amendmentBase,
          proposed_assignments: [
            initialStrategy.proposed_assignments[0],
            { ...initialStrategy.proposed_assignments[1], local_id: "assignment-renamed" },
          ],
        },
      },
      {
        expected: "TaskDependency task-dependency:phase-1:task-local-1:task-local-2",
        amendment: {
          ...amendmentBase,
          proposed_tasks: [
            initialStrategy.proposed_tasks[0],
            { ...initialStrategy.proposed_tasks[1], dependency_local_ids: [] },
          ],
        },
      },
    ];

    for (const { amendment, expected } of removals) {
      expect(() =>
        mergeV2StrategyAmendment(
          existing,
          V2StrategyVersion.parse(amendment),
          LATER,
          () => OTHER_HASH,
        ),
      ).toThrow(expected);
    }
  });

  it("rejects proposal changes once their canonical execution/history is locked", () => {
    const secondTask = {
      ...strategy.proposed_tasks[0],
      local_id: "task-local-2",
      title: "Review contracts",
      dependency_local_ids: [],
    } as const;
    const secondAssignment = {
      ...strategy.proposed_assignments[0],
      local_id: "assignment-local-2",
      task_local_id: secondTask.local_id,
      agent_profile_id: "reviewer-2",
    } as const;
    const initialStrategy = V2StrategyVersion.parse({
      ...strategy,
      status: "approved",
      approval,
      proposed_tasks: [...strategy.proposed_tasks, secondTask],
      proposed_assignments: [...strategy.proposed_assignments, secondAssignment],
    });
    const initial = materializeV2StrategyVersion(initialStrategy, NOW, () => HASH);
    const amendmentBase = {
      ...initialStrategy,
      id: "strategy-2",
      version: 2,
      content_hash: OTHER_HASH,
      approval: { ...approval, approval_id: "approval-2", content_hash: OTHER_HASH },
      supersedes_strategy_version_id: initialStrategy.id,
      created_at: LATER,
      updated_at: LATER,
    } as const;

    const completedTaskState = {
      ...initial,
      tasks: [
        V2Task.parse({
          ...initial.tasks[0],
          state: "completed",
          lifecycle_version: 4,
          review_evidence: [evidence],
          completion_evidence: [evidence],
          completed_at: NOW,
        }),
        V2Task.parse(initial.tasks[1]),
      ],
    };
    expect(() =>
      mergeV2StrategyAmendment(
        completedTaskState,
        V2StrategyVersion.parse({
          ...amendmentBase,
          proposed_tasks: [
            { ...initialStrategy.proposed_tasks[0], title: "Rename completed work" },
            initialStrategy.proposed_tasks[1],
          ],
        }),
        LATER,
        () => OTHER_HASH,
      ),
    ).toThrow("Task task:phase-1:task-local-1 is completed");

    const completedObjectiveState = {
      ...initial,
      objectives: [
        V2Objective.parse({
          ...initial.objectives[0],
          status: "completed",
          completion_evidence: [evidence],
        }),
      ],
    };
    expect(() =>
      mergeV2StrategyAmendment(
        completedObjectiveState,
        V2StrategyVersion.parse({
          ...amendmentBase,
          proposed_objectives: [
            { ...initialStrategy.proposed_objectives[0], outcome: "Changed completed outcome" },
          ],
        }),
        LATER,
        () => OTHER_HASH,
      ),
    ).toThrow("Objective objective:phase-1:objective-local-1 is completed");

    const activeAssignmentState = {
      ...initial,
      agent_assignments: [
        V2AgentAssignment.parse({ ...initial.agent_assignments[0], status: "active" }),
        V2AgentAssignment.parse(initial.agent_assignments[1]),
      ],
    };
    expect(() =>
      mergeV2StrategyAmendment(
        activeAssignmentState,
        V2StrategyVersion.parse({
          ...amendmentBase,
          proposed_assignments: [
            { ...initialStrategy.proposed_assignments[0], budget_limit_usd: 100 },
            initialStrategy.proposed_assignments[1],
          ],
        }),
        LATER,
        () => OTHER_HASH,
      ),
    ).toThrow("AgentAssignment assignment:phase-1:assignment-local-1 is active");

    const completedSuccessorState = {
      ...initial,
      tasks: [
        V2Task.parse(initial.tasks[0]),
        V2Task.parse({
          ...initial.tasks[1],
          state: "completed",
          lifecycle_version: 4,
          review_evidence: [evidence],
          completion_evidence: [evidence],
          completed_at: NOW,
        }),
      ],
    };
    expect(() =>
      mergeV2StrategyAmendment(
        completedSuccessorState,
        V2StrategyVersion.parse({
          ...amendmentBase,
          proposed_tasks: [
            initialStrategy.proposed_tasks[0],
            { ...initialStrategy.proposed_tasks[1], dependency_local_ids: ["task-local-1"] },
          ],
        }),
        LATER,
        () => OTHER_HASH,
      ),
    ).toThrow("Task task:phase-1:task-local-2 is completed");
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
