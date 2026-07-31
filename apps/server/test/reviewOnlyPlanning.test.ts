import { AdapterError, DEFAULT_MODEL_REGISTRY, FakeAdapter, makeUsageEvent } from "@norns/adapters";
import { V2WorkPlanContract } from "@norns/contracts";
import { describe, expect, it, vi } from "vitest";
import { runReviewOnlyPlanning } from "../src/planning/reviewOnlySession.js";

function envelope(objective = "Ship the planning conversation") {
  return V2WorkPlanContract.parse({
    plan: {
      objective,
      assumptions: ["The existing execution bridge remains authoritative."],
      modules: [
        {
          id: "contracts",
          title: "Contracts",
          description: "Deliver the strict conversation plan workflow.",
          deliverables: ["Strict contracts"],
          acceptance: [
            {
              id: "contracts-pass",
              statement: "The workflow is verified.",
              verification_type: "test",
              verification: "Run the focused suite.",
            },
          ],
          dependencies: [],
          estimated_complexity: "M",
          risk: "medium",
          execution: {
            likely_paths: ["packages/contracts/src/v2/conversation.ts"],
            owned_components: ["conversation contracts"],
            test_commands: ["pnpm test"],
            environment_requirements: [],
            migration_required: true,
          },
          parallelization: {
            safe: false,
            candidate_work_units: [],
            shared_files: [],
            integration_owner_required: true,
          },
          inputs: ["Approved product direction"],
          outputs: ["Immutable plan envelope"],
          open_decisions: [],
        },
      ],
      risks: [{ description: "Contract drift", mitigation: "Use strict parsing." }],
      out_of_scope: ["Planning transcript replay"],
    },
    staffing: [
      {
        module_id: "contracts",
        agent_role: "implementation",
        provider: "openai",
        model: "gpt-5.6-sol",
      },
    ],
    verification_requirements: ["Focused and repository-wide tests pass."],
    open_decisions: [],
    estimated_budget: { currency: "USD", amount: 12.5 },
  });
}

describe("review-only conversational planning", () => {
  it("calls the opposite-provider reviewer first with the exact full envelope and no transcript", async () => {
    const seed = envelope();
    const pm = new FakeAdapter("anthropic");
    const reviewer = new FakeAdapter("openai");
    reviewer.enqueue({ findings: [] });

    const result = await runReviewOnlyPlanning({
      pm,
      reviewer,
      projectId: "project-review-only",
      initiatedByUserId: "user-review-only",
      seedPlan: seed,
      frozenContext: {
        binding_rules: [{ id: "rule-1", content: "Preserve the exact plan." }],
        referenced_artifacts: [],
      },
      telemetryGroupId: "review-only-first",
      maxRounds: 3,
    });

    expect(pm.requests).toHaveLength(0);
    expect(reviewer.requests).toHaveLength(1);
    expect(reviewer.requests[0]?.prompt).toContain(JSON.stringify(seed));
    expect(reviewer.requests[0]?.system).toContain("Preserve the exact plan.");
    expect(reviewer.requests[0]?.system).not.toContain("brainstorm filler");
    expect(reviewer.requests[0]?.telemetryRequestId).toBe("review-only-first:review:1");
    expect(reviewer.requests[0]?.telemetryRetryGroupId).toBe("review-only-first:review:1");
    expect(result.seed_plan).toEqual(seed);
    expect(result.final_plan).toEqual(seed);
    expect(result.status).toBe("converged");
  });

  it("records exact dispositions and returns the complete revised envelope at the cap", async () => {
    const seed = envelope();
    const revised = envelope("Ship the reviewed planning conversation");
    const pm = new FakeAdapter("anthropic");
    const reviewer = new FakeAdapter("openai");
    reviewer.enqueue({
      findings: [
        {
          severity: "must_fix",
          module_id: "contracts",
          finding: "Clarify the objective.",
          recommendation: "Use the reviewed objective.",
        },
      ],
    });
    pm.enqueue({
      responses: [
        {
          finding_index: 0,
          disposition: "accept",
          rationale: "The revised objective is now explicit.",
        },
      ],
      plan: revised,
    });

    const result = await runReviewOnlyPlanning({
      pm,
      reviewer,
      projectId: "project-review-only",
      initiatedByUserId: "user-review-only",
      seedPlan: seed,
      frozenContext: { binding_rules: [] },
      telemetryGroupId: "review-only-cap",
      maxRounds: 1,
    });

    expect(result.status).toBe("cap_reached");
    expect(result.final_plan).toEqual(revised);
    expect(result.review_rounds[0]?.responses).toEqual([
      {
        finding_index: 0,
        disposition: "accept",
        rationale: "The revised objective is now explicit.",
      },
    ]);
    expect(pm.requests[0]?.prompt).toContain(JSON.stringify(seed));
    expect(pm.requests[0]?.telemetryRequestId).toBe("review-only-cap:revision:1");
  });

  it("repairs one invalid structured PM revision without discarding reviewer progress", async () => {
    const seed = envelope();
    const revised = envelope("Ship the repaired reviewed planning conversation");
    const pm = new FakeAdapter("anthropic");
    const reviewer = new FakeAdapter("openai");
    reviewer.enqueue({
      findings: [
        {
          severity: "must_fix",
          module_id: "contracts",
          finding: "Clarify the objective.",
          recommendation: "Use the reviewed objective.",
        },
      ],
    });
    pm.enqueue({
      responses: [
        {
          finding_index: 0,
          disposition: "accept",
          rationale: "The repaired response now satisfies the strict plan contract.",
        },
      ],
      plan: revised,
    });
    const completion = vi.spyOn(pm, "completeStructured");
    const failedUsage = makeUsageEvent(
      pm.model,
      DEFAULT_MODEL_REGISTRY,
      { projectId: "project-review-only" },
      500,
      250,
      "provider_api",
    );
    completion.mockRejectedValueOnce(
      new AdapterError(
        "invalid_response",
        "plan_revision: plan.plan.modules.0.execution: Required",
        {
          metadata: {
            usage: failedUsage,
            request_dispatched: true,
          },
        },
      ),
    );
    const progress: number[] = [];

    const result = await runReviewOnlyPlanning({
      pm,
      reviewer,
      projectId: "project-review-only",
      initiatedByUserId: "user-review-only",
      seedPlan: seed,
      frozenContext: { binding_rules: [] },
      telemetryGroupId: "review-only-repair",
      maxRounds: 1,
      onProgress: (rounds) => {
        progress.push(rounds.length);
      },
    });

    expect(completion).toHaveBeenCalledTimes(2);
    expect(pm.requests[0]?.telemetryRequestId).toBe("review-only-repair:revision:1:repair:1");
    expect(pm.requests[0]?.telemetryRetryGroupId).toBe("review-only-repair:revision:1");
    expect(pm.requests[0]?.telemetryRetryAttempt).toBe(1);
    expect(pm.requests[0]?.prompt).toContain("previous response could not be accepted");
    expect(pm.requests[0]?.prompt).toContain("modules.0.execution");
    expect(progress).toEqual([1, 1]);
    expect(result.final_plan).toEqual(revised);
    expect(result.review_rounds[0]?.responses).toHaveLength(1);
    expect(result.usage).toHaveLength(3);
    expect(result.usage[1]).toEqual(failedUsage);
  });

  it("rejects a revision that omits a must-fix disposition", async () => {
    const seed = envelope();
    const pm = new FakeAdapter("anthropic");
    const reviewer = new FakeAdapter("openai");
    reviewer.enqueue({
      findings: [
        {
          severity: "must_fix",
          module_id: null,
          finding: "Acceptance is incomplete.",
          recommendation: "Complete it.",
        },
      ],
    });
    pm.enqueue({ responses: [], plan: seed });

    await expect(
      runReviewOnlyPlanning({
        pm,
        reviewer,
        projectId: "project-review-only",
        initiatedByUserId: "user-review-only",
        seedPlan: seed,
        frozenContext: {},
        telemetryGroupId: "review-only-missing",
        maxRounds: 1,
      }),
    ).rejects.toMatchObject({ code: "missing_dispositions" });
  });
});
