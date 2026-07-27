import { describe, expect, it } from "vitest";
import {
  V2ConversationHandoff,
  V2ConversationTurnAttempt,
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
  });
});
