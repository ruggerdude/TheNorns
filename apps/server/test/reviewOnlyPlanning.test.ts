import { AdapterError, DEFAULT_MODEL_REGISTRY, FakeAdapter, makeUsageEvent } from "@norns/adapters";
import { V2WorkPlanContract } from "@norns/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  type ReviewOnlyChatEvent,
  type ReviewOnlyPlanningPausedResult,
  type ReviewOnlyPlanningResult,
  type ReviewOnlyPlanningTerminalResult,
  type ReviewOnlyProgressEvent,
  runReviewOnlyPlanning,
} from "../src/planning/reviewOnlySession.js";

function assertTerminal(
  result: ReviewOnlyPlanningResult,
): asserts result is ReviewOnlyPlanningTerminalResult {
  if (result.status === "paused") {
    throw new Error(`expected a terminal result, got paused at ${result.paused_checkpoint}`);
  }
}

function assertPaused(
  result: ReviewOnlyPlanningResult,
): asserts result is ReviewOnlyPlanningPausedResult {
  if (result.status !== "paused") {
    throw new Error(`expected a paused result, got ${result.status}`);
  }
}

function envelope(
  objective = "Ship the planning conversation",
  moduleDescription = "Deliver the strict conversation plan workflow.",
) {
  return V2WorkPlanContract.parse({
    plan: {
      objective,
      assumptions: ["The existing execution bridge remains authoritative."],
      modules: [
        {
          id: "contracts",
          title: "Contracts",
          description: moduleDescription,
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
    assertTerminal(result);
    expect(result.seed_plan).toEqual(seed);
    expect(result.final_plan).toEqual(seed);
    expect(result.status).toBe("converged");
  });

  it("records exact dispositions and returns the complete revised envelope at the cap", async () => {
    const seed = envelope();
    // The module content itself changes (not just the plan-level objective)
    // so this accepted must-fix does not trip the Gate C hollow-acceptance
    // check — this test is about disposition recording, not Gate C.
    const revised = envelope(
      "Ship the reviewed planning conversation",
      "Deliver the strict conversation plan workflow, now with the reviewed objective wired through.",
    );
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

    assertTerminal(result);
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
    // As above: change the module content, not just the objective, so the
    // accepted must-fix doesn't trip Gate C in this disposition-repair test.
    const revised = envelope(
      "Ship the repaired reviewed planning conversation",
      "Deliver the strict conversation plan workflow, now with the repaired objective wired through.",
    );
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
            response_text: '{"responses":[],"plan":{"plan":{"objective":"partial"}}}',
            request_dispatched: true,
          },
        },
      ),
    );
    const progress: number[] = [];
    const chat: ReviewOnlyChatEvent[] = [];
    const stages: ReviewOnlyProgressEvent[] = [];

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
      onChatEvent: (event) => {
        chat.push(event);
      },
      onStage: (event) => {
        stages.push(event);
      },
    });

    expect(completion).toHaveBeenCalledTimes(2);
    expect(pm.requests[0]?.telemetryRequestId).toBe("review-only-repair:revision:1:repair:1");
    expect(pm.requests[0]?.telemetryRetryGroupId).toBe("review-only-repair:revision:1");
    expect(pm.requests[0]?.telemetryRetryAttempt).toBe(1);
    expect(pm.requests[0]?.prompt).toContain("previous QC response was preserved");
    expect(pm.requests[0]?.prompt).toContain("modules.0.execution");
    expect(progress).toEqual([1, 1]);
    assertTerminal(result);
    expect(result.final_plan).toEqual(revised);
    expect(result.review_rounds[0]?.responses).toHaveLength(1);
    expect(result.usage).toHaveLength(3);
    expect(result.usage[1]).toEqual(failedUsage);
    expect(chat.map((event) => `${event.channel}:${event.kind}:${event.attempt}`)).toEqual([
      "reviewer:instruction:1",
      "reviewer:response:1",
      "pm:instruction:1",
      "pm:response:1",
      "pm:repair_reminder:2",
      "pm:response:2",
    ]);
    expect(chat[3]).toMatchObject({
      error_code: "invalid_response",
      artifact_valid: false,
    });
    expect(chat[5]?.artifact_markdown).toContain("# Planning manager revision · Round 1");
    expect(stages.map((event) => `${event.stage}:${event.attempt}`)).toEqual([
      "reviewing:1",
      "validating:1",
      "saving:1",
      "revising:1",
      "repairing:2",
      "validating:2",
      "saving:2",
    ]);
    expect(result.final_plan_markdown).toContain("# Final reviewed plan");
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

  it("Gate C: a rebutted must-fix pauses at adjudication even in automatic mode", async () => {
    const seed = envelope();
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
      responses: [{ finding_index: 0, disposition: "rebut", rationale: "The finding is wrong." }],
      plan: seed,
    });

    const result = await runReviewOnlyPlanning({
      pm,
      reviewer,
      projectId: "project-review-only",
      initiatedByUserId: "user-review-only",
      seedPlan: seed,
      frozenContext: {},
      telemetryGroupId: "review-only-gatec-rebut",
      maxRounds: 3,
    });

    assertPaused(result);
    expect(result.paused_checkpoint).toBe("adjudication");
    expect(result.paused_at_round).toBe(1);
    expect(result.plan).toEqual(seed);
    expect(result.rounds).toHaveLength(1);
    expect(result.gate_c_findings).toEqual([
      { finding_id: "0", finding_index: 0, module_id: "contracts", reason: "declared_rebuttal" },
    ]);
    expect(reviewer.requests).toHaveLength(1);
  });

  it("Gate C: an accepted must-fix whose target module is unchanged pauses at adjudication as a hollow acceptance", async () => {
    const seed = envelope();
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
      responses: [{ finding_index: 0, disposition: "accept", rationale: "Will be addressed." }],
      plan: seed,
    });

    const result = await runReviewOnlyPlanning({
      pm,
      reviewer,
      projectId: "project-review-only",
      initiatedByUserId: "user-review-only",
      seedPlan: seed,
      frozenContext: {},
      telemetryGroupId: "review-only-gatec-hollow",
      maxRounds: 3,
    });

    assertPaused(result);
    expect(result.paused_checkpoint).toBe("adjudication");
    expect(result.gate_c_findings).toEqual([
      { finding_id: "0", finding_index: 0, module_id: "contracts", reason: "hollow_acceptance" },
    ]);
  });

  it("Gate C: an accepted must-fix whose target module actually changed does not pause", async () => {
    const seed = envelope();
    const revised = envelope(
      "Ship the planning conversation",
      "Deliver the strict conversation plan workflow, now with the reviewed objective wired through.",
    );
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
        { finding_index: 0, disposition: "accept", rationale: "Addressed in this revision." },
      ],
      plan: revised,
    });

    const result = await runReviewOnlyPlanning({
      pm,
      reviewer,
      projectId: "project-review-only",
      initiatedByUserId: "user-review-only",
      seedPlan: seed,
      frozenContext: {},
      telemetryGroupId: "review-only-gatec-real-change",
      maxRounds: 1,
    });

    assertTerminal(result);
    expect(result.status).toBe("cap_reached");
    expect(result.final_plan).toEqual(revised);
  });

  it("allowUnadjudicatedRebuttals suppresses a declared rebuttal but not a hollow acceptance", async () => {
    const seed = envelope();
    const pmRebut = new FakeAdapter("anthropic");
    const reviewerRebut = new FakeAdapter("openai");
    reviewerRebut.enqueue({
      findings: [
        {
          severity: "must_fix",
          module_id: "contracts",
          finding: "Clarify the objective.",
          recommendation: "Use the reviewed objective.",
        },
      ],
    });
    pmRebut.enqueue({
      responses: [{ finding_index: 0, disposition: "rebut", rationale: "The finding is wrong." }],
      plan: seed,
    });
    reviewerRebut.enqueue({ findings: [] });

    const rebutResult = await runReviewOnlyPlanning({
      pm: pmRebut,
      reviewer: reviewerRebut,
      projectId: "project-review-only",
      initiatedByUserId: "user-review-only",
      seedPlan: seed,
      frozenContext: {},
      telemetryGroupId: "review-only-allow-rebut",
      maxRounds: 3,
      allowUnadjudicatedRebuttals: true,
    });

    assertTerminal(rebutResult);
    expect(rebutResult.status).toBe("converged");

    const pmHollow = new FakeAdapter("anthropic");
    const reviewerHollow = new FakeAdapter("openai");
    reviewerHollow.enqueue({
      findings: [
        {
          severity: "must_fix",
          module_id: "contracts",
          finding: "Clarify the objective.",
          recommendation: "Use the reviewed objective.",
        },
      ],
    });
    pmHollow.enqueue({
      responses: [{ finding_index: 0, disposition: "accept", rationale: "Will be addressed." }],
      plan: seed,
    });

    const hollowResult = await runReviewOnlyPlanning({
      pm: pmHollow,
      reviewer: reviewerHollow,
      projectId: "project-review-only",
      initiatedByUserId: "user-review-only",
      seedPlan: seed,
      frozenContext: {},
      telemetryGroupId: "review-only-allow-hollow",
      maxRounds: 3,
      allowUnadjudicatedRebuttals: true,
    });

    assertPaused(hollowResult);
    expect(hollowResult.paused_checkpoint).toBe("adjudication");
    expect(hollowResult.gate_c_findings?.[0]?.reason).toBe("hollow_acceptance");
  });

  it("Gate C: a rebutted should_fix escalates on same-module recurrence in a later round", async () => {
    const seed = envelope();
    const pm = new FakeAdapter("anthropic");
    const reviewer = new FakeAdapter("openai");
    // Round 1: a plan-level must_fix (forces the PM to run at all) alongside
    // a should_fix on "contracts" that the PM rebuts. First occurrence, so it
    // does not escalate on its own (should_fix never triggers Gate C alone).
    reviewer.enqueue({
      findings: [
        {
          severity: "must_fix",
          module_id: null,
          finding: "Clarify the objective.",
          recommendation: "State the objective precisely.",
        },
        {
          severity: "should_fix",
          module_id: "contracts",
          finding: "Add more acceptance detail.",
          recommendation: "Expand the acceptance criteria.",
        },
      ],
    });
    pm.enqueue({
      responses: [
        { finding_index: 0, disposition: "accept", rationale: "Objective clarified." },
        { finding_index: 1, disposition: "rebut", rationale: "Not needed yet." },
      ],
      plan: envelope(
        "Ship the planning conversation, objective now clarified",
        "Deliver the strict conversation plan workflow.",
      ),
    });
    // Round 2: another should_fix against the same module_id ("contracts"),
    // dumb-matched against round 1's rebuttal regardless of wording.
    reviewer.enqueue({
      findings: [
        {
          severity: "must_fix",
          module_id: null,
          finding: "Another required fix.",
          recommendation: "Fix it.",
        },
        {
          severity: "should_fix",
          module_id: "contracts",
          finding: "Add more acceptance detail, again.",
          recommendation: "Expand it further.",
        },
      ],
    });
    pm.enqueue({
      responses: [
        { finding_index: 0, disposition: "accept", rationale: "Fixed." },
        { finding_index: 1, disposition: "rebut", rationale: "Still not needed." },
      ],
      plan: envelope(
        "Ship the planning conversation, objective now clarified further",
        "Deliver the strict conversation plan workflow.",
      ),
    });

    const result = await runReviewOnlyPlanning({
      pm,
      reviewer,
      projectId: "project-review-only",
      initiatedByUserId: "user-review-only",
      seedPlan: seed,
      frozenContext: {},
      telemetryGroupId: "review-only-should-fix-recurrence",
      maxRounds: 3,
    });

    assertPaused(result);
    expect(result.paused_checkpoint).toBe("adjudication");
    expect(result.paused_at_round).toBe(2);
    expect(result.gate_c_findings).toEqual([
      {
        finding_id: "1",
        finding_index: 1,
        module_id: "contracts",
        reason: "should_fix_recurrence",
      },
    ]);
  });

  it("resuming with forcedAcceptModuleIds blocks re-adjudication without rewriting the PM's response", async () => {
    const seed = envelope();
    const pm = new FakeAdapter("anthropic");
    const reviewer = new FakeAdapter("openai");
    reviewer.enqueue({
      findings: [
        {
          severity: "must_fix",
          module_id: "contracts",
          finding: "Clarify the objective, again.",
          recommendation: "Use the reviewed objective.",
        },
      ],
    });
    pm.enqueue({
      responses: [{ finding_index: 0, disposition: "rebut", rationale: "Still disagree." }],
      // Plan comes back byte-identical to what a human already ruled "for the
      // reviewer" on module "contracts" — this would ordinarily be a fresh
      // hollow acceptance/rebuttal pair, but forcedAcceptModuleIds means it
      // must never re-adjudicate that module.
      plan: seed,
    });

    const result = await runReviewOnlyPlanning({
      pm,
      reviewer,
      projectId: "project-review-only",
      initiatedByUserId: "user-review-only",
      seedPlan: seed,
      frozenContext: {},
      telemetryGroupId: "review-only-forced-accept",
      maxRounds: 2,
      resume: {
        fromRound: 1,
        checkpoint: "after_revision",
        plan: seed,
        rounds: [
          {
            round: 1,
            reviewed_plan: seed,
            findings: [
              {
                severity: "must_fix",
                module_id: "contracts",
                finding: "Clarify the objective.",
                recommendation: "Use the reviewed objective.",
              },
            ],
            responses: [{ finding_index: 0, disposition: "accept", rationale: "Human ruling." }],
            revised_plan_content_hash: "a".repeat(64),
          },
        ],
        forcedAcceptModuleIds: ["contracts"],
      },
    });

    assertTerminal(result);
    expect(result.status).toBe("cap_reached");
    // Honest recording (QC-PAUSE-POINTS.md "Outcomes"): the PM's own rebuttal
    // is preserved verbatim rather than rewritten to look like an acceptance.
    // Enforcement — the module can never re-trigger Gate C — is proven by
    // reaching "cap_reached" at all instead of pausing at "adjudication".
    expect(result.review_rounds[1]?.responses).toEqual([
      { finding_index: 0, disposition: "rebut", rationale: "Still disagree." },
    ]);
  });

  it("gated_each_step pauses at after_review before the PM ever runs", async () => {
    const seed = envelope();
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

    const result = await runReviewOnlyPlanning({
      pm,
      reviewer,
      projectId: "project-review-only",
      initiatedByUserId: "user-review-only",
      seedPlan: seed,
      frozenContext: {},
      telemetryGroupId: "review-only-gated-step",
      maxRounds: 3,
      qcMode: "gated_each_step",
    });

    assertPaused(result);
    expect(result.paused_checkpoint).toBe("after_review");
    expect(result.paused_at_round).toBe(1);
    expect(result.plan).toEqual(seed);
    expect(result.rounds).toHaveLength(1);
    expect(pm.requests).toHaveLength(0);
  });

  it("zero must-fix findings converge without pausing even in gated_each_step", async () => {
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
      frozenContext: {},
      telemetryGroupId: "review-only-gated-step-converged",
      maxRounds: 3,
      qcMode: "gated_each_step",
    });

    assertTerminal(result);
    expect(result.status).toBe("converged");
  });

  it("resuming from after_review does not re-run the reviewer pass", async () => {
    const seed = envelope();
    const revised = envelope(
      "Ship the planning conversation",
      "Deliver the strict conversation plan workflow, now with the reviewed objective wired through.",
    );
    const pm = new FakeAdapter("anthropic");
    const reviewer = new FakeAdapter("openai");
    pm.enqueue({
      responses: [
        { finding_index: 0, disposition: "accept", rationale: "Addressed in this revision." },
      ],
      plan: revised,
    });
    const pendingFinding = {
      severity: "must_fix" as const,
      module_id: "contracts",
      finding: "Clarify the objective.",
      recommendation: "Use the reviewed objective.",
    };

    const result = await runReviewOnlyPlanning({
      pm,
      reviewer,
      projectId: "project-review-only",
      initiatedByUserId: "user-review-only",
      seedPlan: seed,
      frozenContext: {},
      telemetryGroupId: "review-only-resume-after-review",
      maxRounds: 1,
      resume: {
        fromRound: 1,
        checkpoint: "after_review",
        plan: seed,
        rounds: [
          {
            round: 1,
            reviewed_plan: seed,
            findings: [pendingFinding],
            responses: null,
            revised_plan_content_hash: null,
          },
        ],
      },
    });

    expect(reviewer.requests).toHaveLength(0);
    expect(pm.requests).toHaveLength(1);
    assertTerminal(result);
    expect(result.status).toBe("cap_reached");
    expect(result.final_plan).toEqual(revised);
    expect(result.review_rounds[0]?.responses).toEqual([
      { finding_index: 0, disposition: "accept", rationale: "Addressed in this revision." },
    ]);
  });
});
