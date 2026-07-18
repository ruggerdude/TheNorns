import { describe, expect, it } from "vitest";
import {
  V2ApplicationCommand,
  V2ApproveStrategyVersionCommand,
  V2CreateDebateCommand,
  V2DispatchCommand,
  V2IdempotencyRecord,
  V2ScheduleAgentRunCommand,
  canonicalizeV2ApplicationCommandIntent,
  canonicalizeV2StrategyImmutableContent,
  evaluateV2Idempotency,
  fingerprintV2ApplicationCommand,
  fingerprintV2StrategyImmutableContent,
  v2CommandIdForDispatchJob,
  v2IsIdempotencyRecordEligibleForCleanup,
  validateV2StrategyApproval,
} from "../src/v2/index.js";
import type {
  V2ApplicationCommandT,
  V2IdempotencyRecordT,
  V2StrategyVersionT,
} from "../src/v2/index.js";

const NOW = "2026-07-16T12:00:00.000Z";
const LATER = "2026-07-16T12:05:00.000Z";
const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);
const strategySha = (canonicalContent: string) =>
  canonicalContent.includes('"objective":"Build contracts"') ? HASH : OTHER_HASH;

const actor = { actor_type: "human", actor_id: "user-1" } as const;
const approvalCommand = {
  schema_version: 2,
  kind: "approve_strategy_version",
  command_id: "application-command-1",
  command_family: "strategy_approval",
  actor,
  idempotency_key: "approve-strategy-1",
  correlation_id: "correlation-1",
  causation_id: null,
  issued_at: NOW,
  project_id: "project-1",
  phase_id: "phase-1",
  strategy_version_id: "strategy-1",
  expected_phase_version: 1,
  expected_strategy_version: 1,
  expected_strategy_aggregate_version: 1,
  expected_content_hash: HASH,
} as const;

const strategy: V2StrategyVersionT = {
  schema_version: 2,
  id: "strategy-1",
  project_id: "project-1",
  phase_id: "phase-1",
  version: 1,
  status: "awaiting_approval",
  objective: "Build contracts",
  assumptions: [],
  risks: [],
  scope_in: ["contracts"],
  scope_out: ["server"],
  architecture_impact: "Adds V2",
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
      title: "Implement contracts",
      description: "Create the V2 package",
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
      rationale: "Strong TypeScript capability",
      rationale_factors: ["capability", "workload"],
      budget_limit_usd: 10,
      reviewer_agent_profile_id: "reviewer-1",
      allocation_policy_ref: "allocation-policy-1",
    },
  ],
  proposed_concurrency: 1,
  proposed_budget_usd: 10,
  provenance: [
    {
      provider: "openai",
      model: "gpt-5",
      runtime: "codex",
      generated_at: NOW,
      invocation_id: null,
    },
  ],
  convergence: "converged",
  review_rounds: 1,
  findings: [],
  content_hash: HASH,
  approval: null,
  supersedes_strategy_version_id: null,
  aggregate_version: 1,
  created_at: NOW,
  updated_at: NOW,
};

describe("V2 strategy approval command", () => {
  it("allows only a converged, current, must-fix-free strategy", () => {
    const command = V2ApproveStrategyVersionCommand.parse(approvalCommand);
    expect(validateV2StrategyApproval(strategy, command, strategySha, 1)).toEqual({
      allowed: true,
      reasons: [],
    });
  });

  it("rejects cap-reached strategies and every unresolved must-fix", () => {
    const command = V2ApproveStrategyVersionCommand.parse(approvalCommand);
    const decision = validateV2StrategyApproval(
      {
        ...strategy,
        convergence: "cap_reached",
        findings: [
          {
            id: "finding-1",
            severity: "must_fix",
            status: "accepted",
            summary: "Unsafe dispatch",
            disposition: "accepted without repair",
          },
        ],
      },
      command,
      strategySha,
      1,
    );
    expect(decision).toEqual({
      allowed: false,
      reasons: ["strategy_not_converged", "unresolved_must_fix_finding"],
    });
  });

  it("has no override field or unknown-field escape hatch", () => {
    expect(
      V2ApproveStrategyVersionCommand.safeParse({
        ...approvalCommand,
        override_non_convergence: true,
      }).success,
    ).toBe(false);
  });

  it("requires an attributable human actor", () => {
    expect(
      V2ApproveStrategyVersionCommand.safeParse({
        ...approvalCommand,
        actor: { actor_type: "coordinator", actor_id: "coordinator-1" },
      }).success,
    ).toBe(false);
  });

  it("hashes only immutable strategy content, not mutable approval metadata", () => {
    expect(canonicalizeV2StrategyImmutableContent(strategy)).toBe(
      canonicalizeV2StrategyImmutableContent({
        ...strategy,
        status: "approved",
        aggregate_version: 99,
        updated_at: LATER,
        approval: {
          approval_id: "approval-1",
          approved_by: "user-1",
          approved_at: LATER,
          content_hash: HASH,
        },
      }),
    );
    expect(fingerprintV2StrategyImmutableContent(strategy, strategySha)).toBe(HASH);
  });

  it("rejects content mutation and a stale command hash", () => {
    const command = V2ApproveStrategyVersionCommand.parse(approvalCommand);
    const mutated = {
      ...strategy,
      objective: "Mutated after review",
    };
    expect(validateV2StrategyApproval(mutated, command, strategySha, 1).reasons).toEqual(
      expect.arrayContaining(["stored_content_hash_mismatch", "expected_content_hash_mismatch"]),
    );
    const staleCommand = V2ApproveStrategyVersionCommand.parse({
      ...approvalCommand,
      expected_content_hash: OTHER_HASH,
    });
    expect(validateV2StrategyApproval(strategy, staleCommand, strategySha, 1).reasons).toContain(
      "expected_content_hash_mismatch",
    );
  });

  it("detects approval evidence bound to a different content hash", () => {
    const command = V2ApproveStrategyVersionCommand.parse(approvalCommand);
    const mismatchedEvidence: V2StrategyVersionT = {
      ...strategy,
      status: "approved",
      approval: {
        approval_id: "approval-1",
        approved_by: "user-1",
        approved_at: NOW,
        content_hash: OTHER_HASH,
      },
    };
    expect(
      validateV2StrategyApproval(mismatchedEvidence, command, strategySha, 1).reasons,
    ).toContain("approval_evidence_hash_mismatch");
  });

  it("rejects a stale Phase aggregate version from the locked approval transaction", () => {
    const command = V2ApproveStrategyVersionCommand.parse(approvalCommand);
    expect(validateV2StrategyApproval(strategy, command, strategySha, 2).reasons).toContain(
      "phase_version_mismatch",
    );
  });
});

describe("V2 immutable dispatch identity", () => {
  const dispatchJobId = "job-1";
  const commandId = v2CommandIdForDispatchJob(dispatchJobId);
  const dispatch = {
    schema_version: 2,
    protocol_version: 2,
    kind: "launch_run",
    dispatch_job_id: dispatchJobId,
    command_id: commandId,
    delivery_attempt: 1,
    idempotency_key: commandId,
    correlation_id: "correlation-1",
    causation_id: "application-command-1",
    project_id: "project-1",
    phase_id: "phase-1",
    task_id: "task-1",
    assignment_id: "assignment-1",
    run_id: "run-1",
    runner_id: "runner-1",
    runner_generation: 3,
    repository_binding_id: "repo-1",
    expected_revision: "abc123",
    target_branch: "norns/task-1",
    worktree_policy_ref: "worktree-policy-1",
    runtime: "codex",
    provider: "openai",
    model: "gpt-5",
    context_refs: [
      {
        artifact_id: "context-1",
        content_hash: HASH,
        byte_size: 42,
        storage_ref: "object/context-1",
      },
    ],
    budget_reservation_id: "reservation-1",
    max_charge_usd: 10,
    max_input_tokens: 10_000,
    max_output_tokens: 5_000,
    max_duration_seconds: 1800,
    verification_policy_ref: "verification-policy-1",
    sandbox_policy_ref: "sandbox-policy-1",
    authorized_by: actor,
    authorized_by_session_id: "session-1",
    issued_at: NOW,
    expires_at: LATER,
  } as const;

  it("re-presents the same command identity across delivery attempts", () => {
    const first = V2DispatchCommand.parse(dispatch);
    const redelivery = V2DispatchCommand.parse({ ...dispatch, delivery_attempt: 2 });
    expect(redelivery.command_id).toBe(first.command_id);
    expect(redelivery.idempotency_key).toBe(first.command_id);
  });

  it("rejects a freshly minted command id or a different runner dedup key", () => {
    expect(V2DispatchCommand.safeParse({ ...dispatch, command_id: "fresh-command" }).success).toBe(
      false,
    );
    expect(
      V2DispatchCommand.safeParse({ ...dispatch, idempotency_key: "application-key" }).success,
    ).toBe(false);
  });

  it("keeps application intent idempotency separate from runner dedup", () => {
    const schedule = V2ScheduleAgentRunCommand.parse({
      schema_version: 2,
      kind: "schedule_agent_run",
      command_id: "application-command-1",
      command_family: "task_execution",
      actor: { actor_type: "coordinator", actor_id: "coordinator-1" },
      idempotency_key: "evaluation-44:task-1",
      correlation_id: "correlation-1",
      causation_id: null,
      issued_at: NOW,
      project_id: "project-1",
      phase_id: "phase-1",
      task_id: "task-1",
      assignment_id: "assignment-1",
      run_id: "run-1",
      expected_task_version: 3,
      expected_assignment_version: 1,
      runner_id: "runner-1",
      runner_generation: 3,
      repository_binding_id: "repo-1",
      expected_revision: "abc123",
      budget_reservation_id: "reservation-1",
      max_charge_usd: 10,
    });
    expect(schedule.idempotency_key).not.toBe(dispatch.idempotency_key);
    expect(schedule.command_id).not.toBe(dispatch.command_id);
  });
});

describe("V2 actor-scoped idempotency", () => {
  const response = {
    outcome: "succeeded",
    retriable: false,
    http_status: 200,
    body: { phase_id: "phase-1" },
    committed_at: NOW,
  } as const;
  const baseRecord: V2IdempotencyRecordT = {
    schema_version: 2,
    actor_id: "user-1",
    command_family: "strategy_approval",
    idempotency_key: "approve-strategy-1",
    request_fingerprint: HASH,
    command_id: "application-command-1",
    status: "committed_succeeded",
    response,
    created_at: NOW,
    updated_at: NOW,
    retain_until: "2026-08-16T12:00:00.000Z",
    asynchronous_work_until: null,
    rollback_window_until: null,
  };
  const attempt = {
    actor_id: "user-1",
    command_family: "strategy_approval",
    idempotency_key: "approve-strategy-1",
    request_fingerprint: HASH,
  } as const;

  it("replays committed success and committed failure responses", () => {
    expect(evaluateV2Idempotency(baseRecord, attempt)).toEqual({
      kind: "replay",
      command_id: "application-command-1",
      response,
    });
    const failed = V2IdempotencyRecord.parse({
      ...baseRecord,
      status: "committed_failed",
      response: { ...response, outcome: "failed", http_status: 422 },
    });
    expect(evaluateV2Idempotency(failed, attempt)).toMatchObject({
      kind: "replay",
      response: { outcome: "failed", retriable: false, http_status: 422 },
    });

    expect(() =>
      V2IdempotencyRecord.parse({
        ...baseRecord,
        status: "committed_failed",
        response: {
          ...response,
          outcome: "failed",
          retriable: true,
          http_status: 409,
        },
      }),
    ).toThrow(/retriable failures must release/);
  });

  it("returns an in-progress conflict and rejects mismatched fingerprints", () => {
    const inProgress = V2IdempotencyRecord.parse({
      ...baseRecord,
      status: "in_progress",
      response: null,
    });
    expect(evaluateV2Idempotency(inProgress, attempt)).toEqual({
      kind: "command_in_progress",
      command_id: "application-command-1",
    });
    expect(
      evaluateV2Idempotency(baseRecord, { ...attempt, request_fingerprint: OTHER_HASH }),
    ).toEqual({
      kind: "reject_fingerprint_mismatch",
      command_id: "application-command-1",
    });
  });

  it("scopes keys by actor and command family", () => {
    expect(evaluateV2Idempotency(baseRecord, { ...attempt, actor_id: "user-2" })).toEqual({
      kind: "reject_scope_mismatch",
      command_id: "application-command-1",
    });
    expect(evaluateV2Idempotency(baseRecord, { ...attempt, command_family: "phase" })).toEqual({
      kind: "reject_scope_mismatch",
      command_id: "application-command-1",
    });
  });

  it("retains records for 30 days and through asynchronous or rollback horizons", () => {
    expect(
      V2IdempotencyRecord.safeParse({
        ...baseRecord,
        retain_until: "2026-07-30T12:00:00.000Z",
      }).success,
    ).toBe(false);
    const retained = V2IdempotencyRecord.parse({
      ...baseRecord,
      retain_until: "2026-08-20T12:00:00.000Z",
      rollback_window_until: "2026-08-20T12:00:00.000Z",
    });
    expect(v2IsIdempotencyRecordEligibleForCleanup(retained, new Date("2026-08-19"))).toBe(false);
    expect(v2IsIdempotencyRecordEligibleForCleanup(retained, new Date("2026-08-21"))).toBe(true);
  });

  it("computes fingerprints from authenticated canonical intent, not client metadata", () => {
    const command = V2ApplicationCommand.parse(approvalCommand);
    const sameIntent: V2ApplicationCommandT = {
      ...command,
      command_id: "retry-command-id",
      idempotency_key: "same-key",
      correlation_id: "different-correlation",
      issued_at: LATER,
    };
    const fakeSha = (canonical: string) =>
      canonical.includes('"expected_phase_version":2') ? OTHER_HASH : HASH;
    expect(canonicalizeV2ApplicationCommandIntent(command)).toBe(
      canonicalizeV2ApplicationCommandIntent(sameIntent),
    );
    expect(fingerprintV2ApplicationCommand(command, fakeSha)).toBe(HASH);
    const changedIntent = V2ApproveStrategyVersionCommand.parse({
      ...command,
      expected_phase_version: 2,
    });
    expect(fingerprintV2ApplicationCommand(changedIntent, fakeSha)).toBe(OTHER_HASH);
  });

  it("accepts runtime-selected debate actors and rejects invalid role cardinality", () => {
    const base = {
      schema_version: 2,
      kind: "create_debate",
      command_id: "command-debate-1",
      command_family: "debate",
      actor,
      idempotency_key: "create-debate-1",
      correlation_id: "correlation-debate-1",
      causation_id: null,
      issued_at: NOW,
      project_id: "project-1",
      expected_project_version: 1,
      phase_id: null,
      title: "Architecture debate",
      question: "Which persistence boundary should we adopt?",
      stopping_policy: {
        exact_rounds: 2,
        max_rounds: 4,
        max_duration_seconds: 3600,
        max_total_input_tokens: 100_000,
        max_total_output_tokens: 25_000,
        max_total_cost_usd: 25,
        stop_on_consensus: true,
        no_material_change_rounds: 2,
        repeated_disagreement_rounds: 2,
        provider_failure_threshold: 3,
      },
      actors: [
        {
          actor_kind: "participant",
          role_label: "designer",
          display_name: "Design participant",
          instructions: "Propose a design.",
          provider: "anthropic",
          model: "user-selected-anthropic-model",
          runtime: "provider_api",
          position: 0,
          max_turns: 4,
          max_input_tokens: 20_000,
          max_output_tokens: 4_000,
          budget_limit_usd: 10,
        },
        {
          actor_kind: "participant",
          role_label: "reviewer",
          display_name: "Review participant",
          instructions: "Challenge the proposal.",
          provider: "openai",
          model: "user-selected-openai-model",
          runtime: "provider_api",
          position: 1,
          max_turns: 4,
          max_input_tokens: 20_000,
          max_output_tokens: 4_000,
          budget_limit_usd: 10,
        },
      ],
      contexts: [],
    } as const;

    expect(V2CreateDebateCommand.parse(base).actors.map((entry) => entry.model)).toEqual([
      "user-selected-anthropic-model",
      "user-selected-openai-model",
    ]);
    expect(
      V2CreateDebateCommand.safeParse({
        ...base,
        actors: [base.actors[0], { ...base.actors[1], actor_kind: "judge" }],
      }).success,
    ).toBe(false);
  });

  it("preserves explicit ambiguity disposition and structured human direction intent", () => {
    const common = {
      schema_version: 2,
      command_family: "debate",
      actor,
      correlation_id: "correlation-debate-control",
      causation_id: null,
      issued_at: NOW,
      project_id: "project-1",
      debate_id: "debate-1",
      debate_run_id: "run-1",
      expected_run_version: 3,
    } as const;
    const resume = V2ApplicationCommand.parse({
      ...common,
      kind: "control_debate_run",
      command_id: "command-resume-debate",
      idempotency_key: "resume-debate",
      action: "resume",
      reason: "Human accepted the conservative charge.",
      ambiguity_disposition: "assume_full_charge",
    });
    expect(resume).toMatchObject({ ambiguity_disposition: "assume_full_charge" });

    const direction = V2ApplicationCommand.parse({
      ...common,
      kind: "intervene_debate_run",
      command_id: "command-direct-debate",
      idempotency_key: "direct-debate",
      intervention_kind: "direction",
      target_actor_id: "actor-2",
      apply_at: "next_round",
      text: "Address the recovery evidence before reaching consensus.",
    });
    expect(direction).toMatchObject({
      intervention_kind: "direction",
      target_actor_id: "actor-2",
      apply_at: "next_round",
      text: "Address the recovery evidence before reaching consensus.",
    });
  });
});
