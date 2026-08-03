import { describe, expect, it } from "vitest";
import {
  V2ConversationHandoff,
  V2ConversationPlanActionEffectValue,
  V2ConversationPlanReview,
  V2ConversationTaskPackage,
  V2ConversationTurnAttempt,
  V2ConversationUsage,
  V2CreateConversationPlanningExcerptInput,
  V2PlanHandoffPreference,
  V2QcRevisionFormat,
  V2QcTargetedRevision,
  V2SendPlanToQcParameters,
  V2WorkMessage,
  V2WorkPlanContract,
  V2WorkPlanVersion,
} from "../src/v2/conversation.js";

const at = "2026-07-26T12:00:00.000Z";
const hash = "a".repeat(64);

const plan = {
  plan: {
    objective: "Ship conversation-first work.",
    assumptions: ["The existing execution bridge remains authoritative."],
    modules: [
      {
        id: "contracts",
        title: "Contracts",
        description: "Define the conversation domain.",
        deliverables: ["Strict contracts"],
        acceptance: [
          {
            id: "contracts-pass",
            statement: "Contracts reject invalid state.",
            verification_type: "test",
            verification: "Run the contract suite.",
          },
        ],
        dependencies: [],
        estimated_complexity: "M",
        risk: "medium",
        execution: {
          likely_paths: ["packages/contracts/src/v2/conversation.ts"],
          owned_components: ["conversation contracts"],
          test_commands: ["pnpm --filter @norns/contracts test"],
          environment_requirements: [],
          migration_required: true,
        },
        parallelization: {
          safe: false,
          candidate_work_units: [],
          shared_files: [],
          integration_owner_required: true,
        },
        inputs: ["Product plan"],
        outputs: ["Versioned envelope"],
        open_decisions: [],
      },
    ],
    risks: [{ description: "Contract drift", mitigation: "Reuse PlanContract." }],
    out_of_scope: ["Streaming UI"],
  },
  staffing: [
    {
      module_id: "contracts",
      agent_role: "implementation",
      provider: "openai",
      model: "gpt-5.6-sol",
    },
  ],
  verification_requirements: ["Contract and migration tests pass."],
  open_decisions: [],
  estimated_budget: { currency: "USD", amount: 12.5 },
};

describe("V2 conversation contracts", () => {
  it("stores only visible message parts and makes user submission identity explicit", () => {
    const base = {
      schema_version: 2,
      id: "message-1",
      project_id: "project-1",
      work_item_id: "work-1",
      conversation_id: "conversation-1",
      initiated_by_user_id: "user-1",
      actor: { actor_type: "human" as const, actor_id: "user-1" },
      role: "user" as const,
      visibility_status: "complete" as const,
      sequence: 1,
      parts: [{ type: "text" as const, format: "markdown" as const, text: "Visible" }],
      client_message_id: "client-message-1",
      request_fingerprint: hash,
      created_at: at,
    };
    expect(V2WorkMessage.parse(base).parts[0]?.type).toBe("text");
    expect(
      V2WorkMessage.safeParse({
        ...base,
        parts: [{ type: "reasoning", text: "hidden chain of thought" }],
      }).success,
    ).toBe(false);
    expect(
      V2WorkMessage.safeParse({
        ...base,
        visibility_status: "streaming",
      }).success,
    ).toBe(false);
    for (const invisible of ["   \n\t", "\u200b\u200d\u2060\ufeff"]) {
      expect(
        V2WorkMessage.safeParse({
          ...base,
          parts: [{ type: "text", format: "markdown", text: invisible }],
        }).success,
      ).toBe(false);
      expect(
        V2WorkMessage.safeParse({
          ...base,
          parts: [{ type: "code", language: null, code: invisible }],
        }).success,
      ).toBe(false);
    }
    expect(
      V2WorkMessage.parse({
        ...base,
        parts: [{ type: "text", format: "markdown", text: "  Visible" }],
      }).parts,
    ).toEqual([{ type: "text", format: "markdown", text: "  Visible" }]);
  });

  it("allows only visible assistant output to be mutable in flight", () => {
    expect(
      V2WorkMessage.safeParse({
        schema_version: 2,
        id: "message-2",
        project_id: "project-1",
        work_item_id: "work-1",
        conversation_id: "conversation-1",
        initiated_by_user_id: "user-1",
        actor: { actor_type: "agent", actor_id: "pm-1" },
        role: "assistant",
        visibility_status: "streaming",
        sequence: 2,
        parts: [{ type: "text", format: "markdown", text: "Visible so far" }],
        client_message_id: null,
        request_fingerprint: null,
        created_at: at,
      }).success,
    ).toBe(true);
  });

  it("reuses the complete existing PlanContract and rejects dependency cycles", () => {
    const parsed = V2WorkPlanContract.parse(plan);
    expect(parsed.plan.modules[0]?.execution.migration_required).toBe(true);
    expect(parsed.plan.out_of_scope).toEqual(["Streaming UI"]);

    const firstModule = plan.plan.modules[0];
    if (!firstModule) throw new Error("plan fixture requires one module");
    const cyclic = {
      ...plan,
      plan: {
        ...plan.plan,
        modules: [
          { ...firstModule, dependencies: ["persistence"] },
          {
            ...firstModule,
            id: "persistence",
            title: "Persistence",
            dependencies: ["contracts"],
          },
        ],
      },
      staffing: [
        ...plan.staffing,
        {
          module_id: "persistence",
          agent_role: "implementation",
          provider: "anthropic",
          model: "claude-sonnet-5",
        },
      ],
    };
    expect(V2WorkPlanContract.safeParse(cyclic).success).toBe(false);
  });

  it("accepts only closed targeted QC operations and keeps legacy revisions the default", () => {
    expect(V2QcRevisionFormat.parse("legacy_full")).toBe("legacy_full");
    expect(
      V2QcTargetedRevision.safeParse({
        base_plan_content_hash: hash,
        responses: [
          { finding_index: 0, disposition: "accept", rationale: "Update the objective." },
        ],
        changes: [{ op: "set_objective", finding_indices: [0], value: "Reviewed objective" }],
      }).success,
    ).toBe(true);
    expect(
      V2QcTargetedRevision.safeParse({
        base_plan_content_hash: hash,
        responses: [{ finding_index: 0, disposition: "accept", rationale: "Clarified it." }],
        changes: [
          {
            op: "patch_module",
            finding_indices: [0],
            module_id: "contracts",
            patch: { description: "Clarified contract boundaries." },
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      V2QcTargetedRevision.safeParse({
        base_plan_content_hash: hash,
        responses: [],
        changes: [{ op: "replace_path", finding_indices: [0], path: "/plan/objective" }],
      }).success,
    ).toBe(false);
    expect(
      V2QcTargetedRevision.safeParse({
        base_plan_content_hash: hash,
        responses: [],
        changes: [
          {
            op: "remove_module",
            finding_indices: [0],
            module_id: "contracts",
            unexpected: true,
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("separates immutable plan content from attributable approval lifecycle", () => {
    expect(
      V2WorkPlanVersion.safeParse({
        schema_version: 2,
        id: "plan-1",
        project_id: "project-1",
        work_item_id: "work-1",
        conversation_id: "conversation-1",
        created_by_user_id: "user-1",
        version: 1,
        status: "approved",
        plan,
        content_hash: hash,
        created_by_action_id: null,
        supersedes_plan_version_id: null,
        diff_from_previous: null,
        approved_by_user_id: "user-1",
        approved_at: at,
        created_at: at,
        updated_at: at,
      }).success,
    ).toBe(true);
    expect(
      V2WorkPlanVersion.safeParse({
        schema_version: 2,
        id: "plan-2",
        project_id: "project-1",
        work_item_id: "work-1",
        conversation_id: "conversation-1",
        created_by_user_id: "user-1",
        version: 2,
        status: "candidate",
        plan,
        content_hash: hash,
        created_by_action_id: null,
        supersedes_plan_version_id: null,
        diff_from_previous: null,
        approved_by_user_id: null,
        approved_at: null,
        created_at: at,
        updated_at: at,
      }).success,
    ).toBe(false);
  });

  it("binds either an exact QC configuration or an explicit QC waiver", () => {
    const qc = {
      execution_agent: { provider: "anthropic", model: "claude-sonnet-5" },
      review: {
        mode: "qc",
        reviewer: { provider: "openai", model: "gpt-5.6-terra" },
        rounds: 3,
      },
    };
    const waiver = {
      execution_agent: { provider: "openai", model: "gpt-5.6-sol" },
      review: { mode: "skip_qc" },
    };

    expect(V2PlanHandoffPreference.safeParse(qc).success).toBe(true);
    expect(V2PlanHandoffPreference.safeParse(waiver).success).toBe(true);
    expect(
      V2SendPlanToQcParameters.safeParse({
        plan_version_id: "plan-1",
        content_hash: hash,
        review: qc.review,
      }).success,
    ).toBe(true);
    expect(
      V2PlanHandoffPreference.safeParse({
        ...qc,
        review: { ...qc.review, rounds: 6 },
      }).success,
    ).toBe(false);
  });

  it("requires exact usage or an explicit unavailable disposition", () => {
    const base = {
      schema_version: 2,
      id: "attempt-1",
      project_id: "project-1",
      work_item_id: "work-1",
      conversation_id: "conversation-1",
      initiated_by_user_id: "user-1",
      actor: { actor_type: "agent" as const, actor_id: "pm-1" },
      triggering_message_id: "message-1",
      output_message_id: "message-2",
      attempt_number: 1,
      provider: "openai",
      model: "gpt-5.6-sol",
      provider_request_id: "provider-request-1",
      usage_request_id: "usage-request-1",
      provider_finish_reason: "stop",
      status: "succeeded" as const,
      context_manifest: { entries: [], estimated_tokens: 0 },
      context_hash: hash,
      usage_status: "exact" as const,
      input_tokens: 10,
      output_tokens: 4,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cost_usd: 0.01,
      failure_code: null,
      failure_message_redacted: null,
      sanitized_failure: null,
      started_at: at,
      settled_at: at,
      created_at: at,
    };
    expect(V2ConversationTurnAttempt.safeParse(base).success).toBe(true);
    expect(
      V2ConversationTurnAttempt.safeParse({
        ...base,
        usage_status: "unavailable",
      }).success,
    ).toBe(false);
    expect(
      V2ConversationTurnAttempt.safeParse({
        ...base,
        provider_finish_reason: null,
      }).success,
    ).toBe(false);
  });

  it("requires a handoff to carry the full approved plan snapshot", () => {
    const handoff = {
      schema_version: 2,
      id: "handoff-1",
      project_id: "project-1",
      work_item_id: "work-1",
      source_conversation_id: "conversation-1",
      target_conversation_id: "conversation-2",
      approved_plan_version_id: "plan-1",
      created_by_user_id: "user-1",
      kind: "planning_to_execution",
      package: {
        approved_plan_version_id: "plan-1",
        approved_plan_content_hash: hash,
        approved_plan: plan,
        objective: "Ship conversation-first work.",
        binding_rules: [],
        human_decisions: [],
        qc_findings_and_dispositions: [],
        unresolved_risks_and_questions: [],
        task_sequence: ["contracts"],
        staffing: plan.staffing,
        budget: { currency: "USD", amount: 12.5 },
        required_mockup_artifact_ids: [],
        acceptance_evidence: ["Contract suite"],
        artifact_ids: [],
        phase_ids: [],
        task_ids: [],
        repository_binding_ids: [],
        context_manifest: [
          {
            kind: "approved_plan",
            ref: "plan-1",
            content_hash: hash,
          },
        ],
      },
      content_hash: hash,
      created_at: at,
    };
    expect(V2ConversationHandoff.safeParse(handoff).success).toBe(true);
    const withoutPlan = structuredClone(handoff);
    Reflect.deleteProperty(withoutPlan.package, "approved_plan");
    expect(V2ConversationHandoff.safeParse(withoutPlan).success).toBe(false);
    expect(
      V2ConversationHandoff.safeParse({
        ...handoff,
        package: {
          ...handoff.package,
          objective: "A different objective.",
        },
      }).success,
    ).toBe(false);
    expect(
      V2ConversationHandoff.safeParse({
        ...handoff,
        package: {
          ...handoff.package,
          staffing: [
            {
              ...handoff.package.staffing[0],
              model: "different-model",
            },
          ],
        },
      }).success,
    ).toBe(false);
    expect(
      V2ConversationHandoff.safeParse({
        ...handoff,
        package: {
          ...handoff.package,
          task_sequence: ["not-the-approved-module-order"],
        },
      }).success,
    ).toBe(false);
    expect(
      V2ConversationHandoff.safeParse({
        ...handoff,
        package: {
          ...handoff.package,
          context_manifest: [
            ...handoff.package.context_manifest,
            {
              kind: "approved_plan",
              ref: "plan-other",
              content_hash: hash,
            },
          ],
        },
      }).success,
    ).toBe(false);
  });

  it("strictly validates transition, task package, excerpt, and aggregate usage shapes", () => {
    const planVersion = {
      schema_version: 2,
      id: "plan-1",
      project_id: "project-1",
      work_item_id: "work-1",
      conversation_id: "conversation-1",
      created_by_user_id: "user-1",
      version: 1,
      status: "approved",
      plan,
      content_hash: hash,
      created_by_action_id: "action-1",
      supersedes_plan_version_id: null,
      diff_from_previous: null,
      approved_by_user_id: "user-1",
      approved_at: at,
      created_at: at,
      updated_at: at,
    };
    const execution = { status: "pending", started: null, detail: null };
    expect(
      V2ConversationPlanActionEffectValue.safeParse({
        kind: "plan_approved",
        plan_version: planVersion,
        plan_review_id: "review-1",
        planning_run_id: "run-1",
        transition_status: "created",
        execution_conversation_id: "conversation-2",
        handoff_id: "handoff-1",
        kickoff_intent_id: "intent-1",
        execution,
      }).success,
    ).toBe(true);
    expect(
      V2ConversationPlanActionEffectValue.safeParse({
        kind: "plan_approved",
        plan_version: planVersion,
        plan_review_id: "review-1",
        planning_run_id: "run-1",
        transition_status: "legacy_unavailable",
        execution_conversation_id: null,
        handoff_id: null,
        kickoff_intent_id: null,
        execution,
      }).success,
    ).toBe(true);
    expect(
      V2ConversationPlanActionEffectValue.safeParse({
        kind: "plan_approved",
        plan_version: planVersion,
        plan_review_id: "review-1",
        planning_run_id: "run-1",
        transition_status: "created",
        execution_conversation_id: null,
        handoff_id: "handoff-1",
        kickoff_intent_id: "intent-1",
        execution,
      }).success,
    ).toBe(false);

    const taskPackage = {
      schema_version: 2,
      id: "task-package-1",
      project_id: "project-1",
      work_item_id: "work-1",
      conversation_id: "conversation-2",
      handoff_id: "handoff-1",
      approved_plan_version_id: "plan-1",
      module_id: "contracts",
      package: {
        approved_plan_version_id: "plan-1",
        approved_plan_content_hash: hash,
        objective: plan.plan.objective,
        module: plan.plan.modules[0],
        staffing: plan.staffing[0],
        budget: plan.estimated_budget,
        binding_rules: [],
        human_decisions: [],
        artifact_ids: [],
        repository_binding_ids: [],
        context_manifest: [
          {
            kind: "approved_plan",
            ref: "plan-1",
            content_hash: hash,
          },
        ],
      },
      content_hash: hash,
      created_at: at,
    };
    expect(V2ConversationTaskPackage.safeParse(taskPackage).success).toBe(true);
    expect(
      V2ConversationTaskPackage.safeParse({
        ...taskPackage,
        package: {
          ...taskPackage.package,
          staffing: { ...taskPackage.package.staffing, module_id: "other" },
        },
      }).success,
    ).toBe(false);

    const excerpt = {
      idempotency_key: "excerpt-key",
      source_conversation_id: "conversation-1",
      message_ids: ["message-1"],
    };
    expect(V2CreateConversationPlanningExcerptInput.safeParse(excerpt).success).toBe(true);
    expect(
      V2CreateConversationPlanningExcerptInput.safeParse({
        ...excerpt,
        message_ids: ["message-1", "message-1"],
      }).success,
    ).toBe(false);
    expect(
      V2CreateConversationPlanningExcerptInput.safeParse({
        ...excerpt,
        message_ids: Array.from({ length: 21 }, (_, index) => `message-${index}`),
      }).success,
    ).toBe(false);

    expect(
      V2ConversationUsage.safeParse({
        input_tokens: 10,
        output_tokens: 4,
        cost_usd: 0.01,
        exact_cost: true,
        usage_status: "exact",
        attempt_count: 1,
      }).success,
    ).toBe(true);
    for (const usage_status of ["pending", "unavailable"] as const) {
      expect(
        V2ConversationUsage.safeParse({
          input_tokens: 0,
          output_tokens: 0,
          cost_usd: null,
          exact_cost: false,
          usage_status,
          attempt_count: 1,
        }).success,
      ).toBe(true);
    }
    expect(
      V2ConversationUsage.safeParse({
        input_tokens: 0,
        output_tokens: 0,
        cost_usd: 0,
        exact_cost: false,
        usage_status: "unavailable",
        attempt_count: 1,
      }).success,
    ).toBe(false);
  });

  it("parks findings visible only while awaiting_human, coupled to its checkpoint", () => {
    const pausedReview = {
      schema_version: 2,
      id: "review-1",
      project_id: "project-1",
      work_item_id: "work-1",
      conversation_id: "conversation-1",
      action_id: "action-1",
      plan_version_id: "plan-1",
      planning_run_id: "run-1",
      initiated_by_user_id: "user-1",
      attempt_number: 1,
      pm_provider: "anthropic",
      pm_model: "claude-sonnet-5",
      reviewer_provider: "openai",
      reviewer_model: "gpt-5.6-terra",
      usage_request_group_id: "usage-group-1",
      status: "awaiting_human",
      qc_mode: "gated_when_contested",
      qc_mode_source: "project_default",
      allow_unadjudicated_rebuttals: false,
      human_steered_rounds: [],
      rounds_completed: 0,
      max_rounds: 3,
      round_exchanges: [],
      chat_messages: [],
      markdown_artifacts: [],
      plan_content_hash: hash,
      result_plan_content_hash: hash,
      context_manifest: { entries: [], context_hash: hash },
      findings: [
        {
          id: "finding-1",
          index: 0,
          severity: "must_fix",
          module_id: null,
          finding: "The migration drops a constraint it never recreates.",
          recommendation: "Recreate the constraint after the column swap.",
        },
      ],
      dispositions: [],
      revised_plan_version_id: null,
      paused_checkpoint: "after_review",
      paused_at_round: 1,
      started_at: at,
      completed_at: null,
      failure_code: null,
      cancelled_by_user_id: null,
      cancellation_reason: null,
      created_at: at,
      updated_at: at,
    };
    expect(V2ConversationPlanReview.safeParse(pausedReview).success).toBe(true);
    expect(
      V2ConversationPlanReview.safeParse({
        ...pausedReview,
        status: "running",
      }).success,
    ).toBe(false);
  });
});
