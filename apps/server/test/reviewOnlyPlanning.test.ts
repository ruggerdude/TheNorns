import { AdapterError, DEFAULT_MODEL_REGISTRY, FakeAdapter, makeUsageEvent } from "@norns/adapters";
import {
  type FindingResponseT,
  type ReviewFindingT,
  type V2QcPlanChangeT,
  V2WorkPlanContract,
} from "@norns/contracts";
import { describe, expect, it, vi } from "vitest";
import { canonicalSha256 } from "../src/persistence/migration/canonicalJson.js";
import { SCOPE_DISCIPLINE } from "../src/planning/prompts.js";
import {
  type ReviewOnlyChatEvent,
  type ReviewOnlyPlanningOptions,
  type ReviewOnlyPlanningPausedResult,
  type ReviewOnlyPlanningResult,
  type ReviewOnlyPlanningTerminalResult,
  type ReviewOnlyProgressEvent,
  applyTargetedQcRevision,
  compactFrozenQcContext,
  runReviewOnlyPlanning as runReviewOnlyPlanningRaw,
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

/** Downstream behavior tests model the required human checkpoint by accepting
 * every reviewer finding before allowing the PM step to run. Tests that
 * exercise the checkpoint itself call runReviewOnlyPlanningRaw directly. */
async function runReviewOnlyPlanning(
  options: ReviewOnlyPlanningOptions,
): Promise<ReviewOnlyPlanningResult> {
  let result = await runReviewOnlyPlanningRaw(options);
  const forcedAcceptModuleIds = options.resume?.forcedAcceptModuleIds ?? [];
  while (result.status === "paused" && result.paused_checkpoint === "after_review") {
    const pausedAtRound = result.paused_at_round;
    const pausedRound = result.rounds.find((round) => round.round === pausedAtRound);
    if (!pausedRound) throw new Error("paused reviewer pass is missing its round evidence");
    result = await runReviewOnlyPlanningRaw({
      ...options,
      resume: {
        kind: "human",
        fromRound: pausedAtRound,
        checkpoint: "after_review",
        plan: result.plan,
        rounds: result.rounds,
        usage: result.usage,
        acceptedFindingIndices: pausedRound.findings.map((_, index) => index),
        forcedAcceptModuleIds,
      },
    });
  }
  return result;
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

function fixtureModule() {
  const module = envelope().plan.modules[0];
  if (!module) throw new Error("fixture requires contracts module");
  return module;
}

function fixtureStaffing() {
  const staffing = envelope().staffing[0];
  if (!staffing) throw new Error("fixture requires contracts staffing");
  return staffing;
}

function twoModuleEnvelope() {
  const seed = envelope();
  const contracts = seed.plan.modules[0];
  const staffing = seed.staffing[0];
  if (!contracts || !staffing) throw new Error("fixture requires contracts module and staffing");
  return V2WorkPlanContract.parse({
    ...seed,
    plan: {
      ...seed.plan,
      modules: [
        contracts,
        {
          ...contracts,
          id: "ui",
          title: "UI",
          description: "Deliver the planning interface.",
          deliverables: ["Planning interface"],
          acceptance: contracts.acceptance.map((criterion) => ({
            ...criterion,
            id: `ui-${criterion.id}`,
          })),
          execution: {
            ...contracts.execution,
            likely_paths: ["apps/web/src/Planning.tsx"],
            owned_components: ["planning interface"],
          },
        },
      ],
    },
    staffing: [staffing, { ...staffing, module_id: "ui" }],
  });
}

describe("review-only conversational planning", () => {
  it("builds a deterministic bounded prompt view without altering essential frozen context", () => {
    const receipt = {
      binding_rules: [{ id: "rule-1", content: "Never weaken the approval boundary." }],
      approved_knowledge: Array.from({ length: 30 }, (_, index) => ({
        id: `knowledge-${String(29 - index).padStart(2, "0")}`,
        category: "constraint",
        content: `${index}:${"x".repeat(2_000)}`,
      })),
      decision_ledger: [
        { id: "decision-1", title: "Use PostgreSQL", rationale: "Durable transactions." },
      ],
      referenced_artifacts: [{ id: "artifact-1", kind: "plan", content_hash: "a".repeat(64) }],
      manual_qc_guidance: [
        { artifact_id: "guidance-1", content: "Check the migration rollback verbatim." },
      ],
      future_large_field: "must-not-enter-the-prompt",
    };
    const before = structuredClone(receipt);

    const first = compactFrozenQcContext(receipt);
    const second = compactFrozenQcContext(structuredClone(receipt));
    const omissions = first.approved_knowledge_omissions as Record<string, unknown>;
    const included = first.approved_knowledge as Array<{ id: string }>;

    expect(first).toEqual(second);
    expect(receipt).toEqual(before);
    expect(first.source_receipt_hash).toBe(canonicalSha256(receipt));
    expect(first.binding_rules).toEqual(receipt.binding_rules);
    expect(first.manual_qc_guidance).toEqual(receipt.manual_qc_guidance);
    expect(first.decision_ledger).toEqual(receipt.decision_ledger);
    expect(first.referenced_artifacts).toEqual(receipt.referenced_artifacts);
    expect(included.length).toBeLessThanOrEqual(24);
    expect(included.map((item) => item.id)).toEqual([...included.map((item) => item.id)].sort());
    expect(omissions.omitted_count).toBe(30 - included.length);
    expect(omissions.included_characters).toEqual(expect.any(Number));
    expect(Number(omissions.included_characters)).toBeLessThanOrEqual(24_000);
    expect(omissions.omitted_content_hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(first)).not.toContain("must-not-enter-the-prompt");
    expect(first.omitted_fields).toEqual([
      { key: "future_large_field", content_hash: canonicalSha256(receipt.future_large_field) },
    ]);
  });

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
    expect(reviewer.requests[0]?.maxTokens).toBe(5_000);
    assertTerminal(result);
    expect(result.seed_plan).toEqual(seed);
    expect(result.final_plan).toEqual(seed);
    expect(result.status).toBe("converged");
  });

  it("streams bounded visible output updates while the reviewer is working", async () => {
    const seed = envelope();
    const pm = new FakeAdapter("anthropic");
    const reviewer = new FakeAdapter("openai");
    reviewer.enqueue({ findings: [] });
    const output: ReviewOnlyProgressEvent[] = [];

    const result = await runReviewOnlyPlanning({
      pm,
      reviewer,
      projectId: "project-review-stream",
      initiatedByUserId: "user-review-stream",
      seedPlan: seed,
      frozenContext: { binding_rules: [] },
      telemetryGroupId: "review-only-stream",
      maxRounds: 1,
      onOutput: (event) => {
        output.push(event);
      },
    });

    assertTerminal(result);
    expect(output.length).toBeGreaterThan(0);
    expect(output.at(-1)).toMatchObject({
      stage: "reviewing",
      round: 1,
      outputCharacters: 15,
      outputPreview: '{"findings":[]}',
    });
    expect(reviewer.requests).toHaveLength(1);
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
    expect(pm.requests[0]?.maxTokens).toBeUndefined();
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
            structured_failure: {
              kind: "schema_validation",
              issues: [
                {
                  path: "plan.plan.modules.0.execution",
                  code: "invalid_type",
                  message: "Required",
                },
              ],
            },
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
      error_code: "schema_validation",
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

  it.each(["automatic", "gated_each_step"] as const)(
    "%s pauses at after_review before the PM ever runs",
    async (qcMode) => {
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

      const result = await runReviewOnlyPlanningRaw({
        pm,
        reviewer,
        projectId: "project-review-only",
        initiatedByUserId: "user-review-only",
        seedPlan: seed,
        frozenContext: {},
        telemetryGroupId: `review-only-human-finding-review-${qcMode}`,
        maxRounds: 3,
        qcMode,
      });

      assertPaused(result);
      expect(result.paused_checkpoint).toBe("after_review");
      expect(result.paused_at_round).toBe(1);
      expect(result.plan).toEqual(seed);
      expect(result.rounds).toHaveLength(1);
      expect(pm.requests).toHaveLength(0);
    },
  );

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

  it("preserves suggestion-only findings without spending a PM revision call", async () => {
    const seed = envelope();
    const pm = new FakeAdapter("anthropic");
    const reviewer = new FakeAdapter("openai");
    const suggestion: ReviewFindingT = {
      severity: "suggestion",
      module_id: "contracts",
      finding: "Consider adding an example.",
      recommendation: "Document one representative workflow when convenient.",
    };
    reviewer.enqueue({ findings: [suggestion] });

    const result = await runReviewOnlyPlanning({
      pm,
      reviewer,
      projectId: "project-suggestion-only",
      initiatedByUserId: "user-review-only",
      seedPlan: seed,
      frozenContext: {},
      telemetryGroupId: "review-only-suggestion-only",
      maxRounds: 3,
      qcMode: "gated_each_step",
    });

    assertTerminal(result);
    expect(result.status).toBe("converged");
    expect(result.final_plan).toEqual(seed);
    expect(result.review_rounds[0]?.findings).toEqual([suggestion]);
    expect(result.review_rounds[0]?.responses).toBeNull();
    expect(reviewer.requests).toHaveLength(1);
    expect(pm.requests).toHaveLength(0);
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

  it("sends only human-accepted findings to the PM and preserves their original indices", async () => {
    const seed = envelope();
    const revised = envelope(
      "Ship the planning conversation",
      "Deliver the strict workflow with a measurable verification tolerance.",
    );
    const pm = new FakeAdapter("anthropic");
    const reviewer = new FakeAdapter("openai");
    pm.enqueue({
      responses: [
        { finding_index: 0, disposition: "accept", rationale: "Added the accepted tolerance." },
      ],
      plan: revised,
    });
    const findings = [
      {
        severity: "must_fix" as const,
        module_id: null,
        finding: "Add a deployment target.",
        recommendation: "Choose a public host.",
      },
      {
        severity: "must_fix" as const,
        module_id: "contracts",
        finding: "Define a verification tolerance.",
        recommendation: "Add a measurable threshold.",
      },
    ];

    const result = await runReviewOnlyPlanning({
      pm,
      reviewer,
      projectId: "project-review-only",
      initiatedByUserId: "user-review-only",
      seedPlan: seed,
      frozenContext: {},
      telemetryGroupId: "review-only-selected-findings",
      maxRounds: 1,
      resume: {
        fromRound: 1,
        checkpoint: "after_review",
        plan: seed,
        rounds: [
          {
            round: 1,
            reviewed_plan: seed,
            findings,
            responses: null,
            revised_plan_content_hash: null,
          },
        ],
        acceptedFindingIndices: [1],
      },
    });

    expect(pm.requests[0]?.prompt).not.toContain("Add a deployment target");
    expect(pm.requests[0]?.prompt).toContain("Define a verification tolerance");
    assertTerminal(result);
    expect(result.review_rounds[0]?.responses).toEqual([
      { finding_index: 1, disposition: "accept", rationale: "Added the accepted tolerance." },
    ]);
  });

  it("materializes a base-hash-pinned targeted revision without mutating its input", () => {
    const seed = envelope();
    const before = structuredClone(seed);
    const finding = {
      severity: "must_fix" as const,
      module_id: "contracts",
      finding: "Clarify the implementation boundary.",
      recommendation: "Update the contracts module.",
    };
    const current = seed.plan.modules[0];
    if (!current) throw new Error("fixture requires contracts module");
    const revision = {
      base_plan_content_hash: canonicalSha256(seed),
      responses: [
        { finding_index: 0, disposition: "accept" as const, rationale: "Updated the module." },
      ],
      changes: [
        {
          op: "patch_module" as const,
          finding_indices: [0],
          module_id: "contracts",
          patch: { description: "Deliver a bounded targeted revision workflow." },
        },
      ],
    };

    const materialized = applyTargetedQcRevision(seed, revision, [finding]);

    expect(seed).toEqual(before);
    expect(materialized.plan.modules[0]?.description).toContain("bounded targeted revision");
    expect(applyTargetedQcRevision(seed, revision, [finding])).toEqual(materialized);
    expect(() =>
      applyTargetedQcRevision(seed, { ...revision, base_plan_content_hash: "f".repeat(64) }, [
        finding,
      ]),
    ).toThrow(/base_plan_content_hash is stale/);
    expect(() =>
      applyTargetedQcRevision(
        seed,
        {
          ...revision,
          changes: [
            {
              op: "set_objective",
              finding_indices: [0],
              value: "An unrelated plan-level edit",
            },
          ],
        },
        [finding],
      ),
    ).toThrow(/cannot address module-scoped finding/);
  });

  it("materializes every top-level setter and explicit module plus staffing lifecycle", () => {
    const seed = envelope();
    const planFinding: ReviewFindingT = {
      severity: "must_fix",
      module_id: null,
      finding: "Update the plan envelope.",
      recommendation: "Apply the reviewed values.",
    };
    const responses: FindingResponseT[] = [
      { finding_index: 0, disposition: "accept", rationale: "Applied." },
    ];
    const topLevelChanges: V2QcPlanChangeT[] = [
      { op: "set_objective", finding_indices: [0], value: "Reviewed objective" },
      { op: "set_assumptions", finding_indices: [0], value: ["Reviewed assumption"] },
      {
        op: "set_risks",
        finding_indices: [0],
        value: [{ description: "Reviewed risk", mitigation: "Reviewed mitigation" }],
      },
      { op: "set_out_of_scope", finding_indices: [0], value: ["Deferred item"] },
      {
        op: "set_verification_requirements",
        finding_indices: [0],
        value: ["Run the reviewed checks."],
      },
      { op: "set_open_decisions", finding_indices: [0], value: ["Choose rollout size."] },
      {
        op: "set_estimated_budget",
        finding_indices: [0],
        value: { currency: "EUR", amount: 20 },
      },
    ];
    const topLevel = applyTargetedQcRevision(
      seed,
      {
        base_plan_content_hash: canonicalSha256(seed),
        responses,
        changes: topLevelChanges,
      },
      [planFinding],
    );
    expect(topLevel).toMatchObject({
      plan: {
        objective: "Reviewed objective",
        assumptions: ["Reviewed assumption"],
        risks: [{ description: "Reviewed risk", mitigation: "Reviewed mitigation" }],
        out_of_scope: ["Deferred item"],
      },
      verification_requirements: ["Run the reviewed checks."],
      open_decisions: ["Choose rollout size."],
      estimated_budget: { currency: "EUR", amount: 20 },
    });

    const contracts = seed.plan.modules[0];
    const staffing = seed.staffing[0];
    if (!contracts || !staffing) throw new Error("fixture requires module and staffing");
    const addedModule = {
      ...contracts,
      id: "persistence",
      title: "Persistence",
      dependencies: ["contracts"],
    };
    const added = applyTargetedQcRevision(
      seed,
      {
        base_plan_content_hash: canonicalSha256(seed),
        responses,
        changes: [
          { op: "add_module", finding_indices: [0], module: addedModule },
          {
            op: "add_staffing",
            finding_indices: [0],
            staffing: { ...staffing, module_id: "persistence" },
          },
        ],
      },
      [planFinding],
    );
    expect(added.plan.modules.map((module) => module.id)).toEqual(["contracts", "persistence"]);
    expect(added.staffing.map((choice) => choice.module_id)).toEqual(["contracts", "persistence"]);

    const moduleFinding = { ...planFinding, module_id: "persistence" };
    const removed = applyTargetedQcRevision(
      added,
      {
        base_plan_content_hash: canonicalSha256(added),
        responses,
        changes: [
          { op: "remove_module", finding_indices: [0], module_id: "persistence" },
          { op: "remove_staffing", finding_indices: [0], module_id: "persistence" },
        ],
      },
      [moduleFinding],
    );
    expect(removed).toEqual(seed);
  });

  it.each<{
    name: string;
    changes: V2QcPlanChangeT[];
    responses?: FindingResponseT[];
    findings?: ReviewFindingT[];
    message: RegExp;
  }>([
    {
      name: "duplicate targets",
      changes: [
        { op: "set_objective", finding_indices: [0], value: "One" },
        { op: "set_objective", finding_indices: [0], value: "Two" },
      ],
      message: /duplicate or conflicting target/,
    },
    {
      name: "adding an existing module",
      changes: [{ op: "add_module", finding_indices: [0], module: fixtureModule() }],
      message: /module contracts already exists/,
    },
    {
      name: "replacing a missing module",
      changes: [
        {
          op: "replace_module",
          finding_indices: [0],
          module_id: "missing",
          module: { ...fixtureModule(), id: "missing" },
        },
      ],
      message: /module missing does not exist/,
    },
    {
      name: "removing missing staffing",
      changes: [{ op: "remove_staffing", finding_indices: [0], module_id: "missing" }],
      message: /staffing for missing does not exist/,
    },
    {
      name: "replacement module id mismatch",
      changes: [
        {
          op: "replace_module",
          finding_indices: [0],
          module_id: "contracts",
          module: { ...fixtureModule(), id: "different" },
        },
      ],
      message: /replacement module id different does not match contracts/,
    },
    {
      name: "replacement staffing id mismatch",
      changes: [
        {
          op: "replace_staffing",
          finding_indices: [0],
          module_id: "contracts",
          staffing: { ...fixtureStaffing(), module_id: "different" },
        },
      ],
      message: /replacement staffing id different does not match contracts/,
    },
    {
      name: "change attributed to a rebuttal",
      changes: [{ op: "set_objective", finding_indices: [0], value: "Changed" }],
      responses: [{ finding_index: 0, disposition: "rebut", rationale: "No change." }],
      message: /only attribute a finding dispositioned accept/,
    },
    {
      name: "unknown finding attribution",
      changes: [{ op: "set_objective", finding_indices: [1], value: "Changed" }],
      message: /references unknown finding 1/,
    },
    {
      name: "dangling dependency",
      changes: [
        {
          op: "replace_module",
          finding_indices: [0],
          module_id: "contracts",
          module: { ...fixtureModule(), dependencies: ["missing"] },
        },
      ],
      message: /depends on unknown module/,
    },
    {
      name: "dependency cycle",
      changes: [
        {
          op: "replace_module",
          finding_indices: [0],
          module_id: "contracts",
          module: { ...fixtureModule(), dependencies: ["persistence"] },
        },
        {
          op: "add_module",
          finding_indices: [0],
          module: {
            ...fixtureModule(),
            id: "persistence",
            dependencies: ["contracts"],
          },
        },
        {
          op: "add_staffing",
          finding_indices: [0],
          staffing: { ...fixtureStaffing(), module_id: "persistence" },
        },
      ],
      message: /dependency cycle/,
    },
    {
      name: "incomplete final staffing",
      changes: [{ op: "remove_staffing", finding_indices: [0], module_id: "contracts" }],
      message: /staffing must pin/,
    },
  ])("rejects $name", ({ changes, responses, findings, message }) => {
    const seed = envelope();
    const activeFindings =
      findings ??
      ([
        {
          severity: "must_fix",
          module_id: null,
          finding: "Apply the change.",
          recommendation: "Use the bounded operation.",
        },
      ] satisfies ReviewFindingT[]);
    expect(() =>
      applyTargetedQcRevision(
        seed,
        {
          base_plan_content_hash: canonicalSha256(seed),
          responses: responses ?? [
            { finding_index: 0, disposition: "accept", rationale: "Applied." },
          ],
          changes,
        },
        activeFindings,
      ),
    ).toThrow(message);
  });

  it("uses targeted changes, emits the complete materialized artifact, and treats staffing as the module region", async () => {
    const seed = envelope();
    const pm = new FakeAdapter("anthropic");
    const reviewer = new FakeAdapter("openai");
    reviewer.enqueue({
      findings: [
        {
          severity: "must_fix",
          module_id: "contracts",
          finding: "Use the required implementation model.",
          recommendation: "Change the pinned staffing model.",
        },
      ],
    });
    pm.enqueue({
      base_plan_content_hash: canonicalSha256(seed),
      responses: [
        { finding_index: 0, disposition: "accept", rationale: "Pinned the required model." },
      ],
      changes: [
        {
          op: "replace_staffing",
          finding_indices: [0],
          module_id: "contracts",
          staffing: {
            ...seed.staffing[0],
            model: "gpt-5.6-terra",
          },
        },
      ],
    });
    const chat: ReviewOnlyChatEvent[] = [];

    const result = await runReviewOnlyPlanning({
      pm,
      reviewer,
      projectId: "project-targeted",
      initiatedByUserId: "user-targeted",
      seedPlan: seed,
      frozenContext: {},
      telemetryGroupId: "review-only-targeted",
      maxRounds: 1,
      revisionFormat: "targeted_v1",
      onChatEvent: (event) => {
        chat.push(event);
      },
    });

    assertTerminal(result);
    expect(result.status).toBe("cap_reached");
    expect(result.final_plan.staffing[0]?.model).toBe("gpt-5.6-terra");
    expect(pm.requests.map((request) => request.schemaName)).toEqual(["targeted_plan_revision"]);
    expect(pm.requests[0]?.maxTokens).toBe(3_500);
    expect(pm.requests[0]?.prompt).toContain("responses:");
    expect(pm.requests[0]?.prompt).toContain("Do not return the complete plan");
    const pmArtifact = [...chat]
      .reverse()
      .find((event) => event.channel === "pm" && event.speaker === "pm" && event.artifact_valid);
    expect(pmArtifact?.artifact_markdown).toContain("Applied bounded changes");
    expect(pmArtifact?.artifact_markdown).toContain("Complete server-materialized revised plan");
    expect(pmArtifact?.artifact_markdown).toContain("gpt-5.6-terra");
  });

  it("applies independent module patch batches in parallel", async () => {
    const seed = twoModuleEnvelope();
    const pm = new FakeAdapter("anthropic");
    const reviewer = new FakeAdapter("openai");
    reviewer.enqueue({
      findings: [
        {
          severity: "must_fix",
          module_id: "contracts",
          finding: "Clarify the contracts boundary.",
          recommendation: "Tighten the contracts description.",
        },
        {
          severity: "should_fix",
          module_id: "ui",
          finding: "Clarify the UI boundary.",
          recommendation: "Tighten the UI description.",
        },
      ],
    });
    pm.enqueue(
      {
        base_plan_content_hash: canonicalSha256(seed),
        responses: [{ finding_index: 0, disposition: "accept", rationale: "Clarified contracts." }],
        changes: [
          {
            op: "patch_module",
            finding_indices: [0],
            module_id: "contracts",
            patch: { description: "Deliver the clarified contracts boundary." },
          },
        ],
      },
      {
        base_plan_content_hash: canonicalSha256(seed),
        responses: [{ finding_index: 1, disposition: "accept", rationale: "Clarified UI." }],
        changes: [
          {
            op: "patch_module",
            finding_indices: [1],
            module_id: "ui",
            patch: { description: "Deliver the clarified UI boundary." },
          },
        ],
      },
    );
    const originalComplete = pm.completeStructured.bind(pm);
    let activePatchCalls = 0;
    let maximumActivePatchCalls = 0;
    let releasePatchCalls: (() => void) | undefined;
    const patchGate = new Promise<void>((resolve) => {
      releasePatchCalls = resolve;
    });
    vi.spyOn(pm, "completeStructured").mockImplementation((async (request, schema, schemaName) => {
      if (schemaName !== "targeted_plan_revision") {
        return originalComplete(request, schema, schemaName);
      }
      activePatchCalls += 1;
      maximumActivePatchCalls = Math.max(maximumActivePatchCalls, activePatchCalls);
      if (activePatchCalls === 2) releasePatchCalls?.();
      await patchGate;
      try {
        return await originalComplete(request, schema, schemaName);
      } finally {
        activePatchCalls -= 1;
      }
    }) as typeof pm.completeStructured);

    const result = await runReviewOnlyPlanning({
      pm,
      reviewer,
      projectId: "project-parallel-targeted",
      initiatedByUserId: "user-targeted",
      seedPlan: seed,
      frozenContext: {},
      telemetryGroupId: "review-only-parallel-targeted",
      maxRounds: 1,
      revisionFormat: "targeted_v1",
    });

    assertTerminal(result);
    expect(maximumActivePatchCalls).toBe(2);
    expect(result.final_plan.plan.modules[0]?.description).toContain("clarified contracts");
    expect(result.final_plan.plan.modules[1]?.description).toContain("clarified UI");
  });

  it("repairs a targeted response without asking the PM to regenerate the full plan", async () => {
    const seed = envelope();
    const module = seed.plan.modules[0];
    if (!module) throw new Error("fixture requires contracts module");
    const pm = new FakeAdapter("anthropic");
    const reviewer = new FakeAdapter("openai");
    reviewer.enqueue({
      findings: [
        {
          severity: "must_fix",
          module_id: "contracts",
          finding: "Clarify the module.",
          recommendation: "Update its description.",
        },
      ],
    });
    pm.enqueue({
      base_plan_content_hash: canonicalSha256(seed),
      responses: [
        { finding_index: 0, disposition: "accept", rationale: "Updated the description." },
      ],
      changes: [
        {
          op: "replace_module",
          finding_indices: [0],
          module_id: "contracts",
          module: { ...module, description: "Clarified after targeted repair." },
        },
      ],
    });
    const originalComplete = pm.completeStructured.bind(pm);
    let rejectedPatch = false;
    vi.spyOn(pm, "completeStructured").mockImplementation((async (request, schema, schemaName) => {
      if (schemaName === "targeted_plan_revision" && !rejectedPatch) {
        rejectedPatch = true;
        throw new AdapterError("invalid_response", "targeted_plan_revision: invalid operation", {
          metadata: { response_text: '{"changes":[]}' },
        });
      }
      return originalComplete(request, schema, schemaName);
    }) as typeof pm.completeStructured);

    const result = await runReviewOnlyPlanning({
      pm,
      reviewer,
      projectId: "project-targeted-repair",
      initiatedByUserId: "user-targeted",
      seedPlan: seed,
      frozenContext: {},
      telemetryGroupId: "review-only-targeted-repair",
      maxRounds: 1,
      revisionFormat: "targeted_v1",
    });

    assertTerminal(result);
    expect(result.final_plan.plan.modules[0]?.description).toContain("targeted repair");
    const repaired = pm.requests.find((request) => request.telemetryRetryAttempt === 1);
    expect(repaired?.maxTokens).toBe(2_500);
    expect(repaired?.prompt).toContain("base_plan_content_hash, responses, and changes only");
    expect(repaired?.prompt).not.toContain("preserve the full plan");
    expect(repaired?.prompt).not.toContain("CURRENT WORK PLAN CONTRACT ENVELOPE");
  });

  it("retries an output-limited module patch compactly without using the legacy envelope", async () => {
    const seed = envelope();
    const pm = new FakeAdapter("anthropic");
    const reviewer = new FakeAdapter("openai");
    reviewer.enqueue({
      findings: [
        {
          severity: "must_fix",
          module_id: "contracts",
          finding: "Clarify the module.",
          recommendation: "Update its description.",
        },
      ],
    });
    pm.enqueue({
      base_plan_content_hash: canonicalSha256(seed),
      responses: [{ finding_index: 0, disposition: "accept", rationale: "Clarified it." }],
      changes: [
        {
          op: "patch_module",
          finding_indices: [0],
          module_id: "contracts",
          patch: { description: "Clarified with a compact retry." },
        },
      ],
    });
    const originalComplete = pm.completeStructured.bind(pm);
    let truncatedPatch = false;
    const completion = vi.spyOn(pm, "completeStructured").mockImplementation((async (
      request,
      schema,
      schemaName,
    ) => {
      if (schemaName === "targeted_plan_revision" && !truncatedPatch) {
        truncatedPatch = true;
        throw new AdapterError("invalid_response", "targeted_plan_revision: response is not JSON", {
          metadata: {
            finish_reason: "max_tokens",
            response_text: '{"base_plan_content_hash":"partial',
            structured_failure: {
              kind: "output_truncated",
              issues: [
                {
                  path: "$",
                  code: "output_truncated",
                  message: "The provider stopped because the configured output limit was reached.",
                },
              ],
            },
          },
        });
      }
      return originalComplete(request, schema, schemaName);
    }) as typeof pm.completeStructured);
    const chat: ReviewOnlyChatEvent[] = [];

    const result = await runReviewOnlyPlanning({
      pm,
      reviewer,
      projectId: "project-targeted-truncated",
      initiatedByUserId: "user-targeted",
      seedPlan: seed,
      frozenContext: {},
      telemetryGroupId: "review-only-targeted-truncated",
      maxRounds: 1,
      revisionFormat: "targeted_v1_with_fallback",
      onChatEvent: (event) => {
        chat.push(event);
      },
    });

    assertTerminal(result);
    expect(result.final_plan.plan.modules[0]?.description).toContain("compact retry");
    expect(completion).toHaveBeenCalledTimes(2);
    expect(completion.mock.calls[0]?.[0].maxTokens).toBe(3_500);
    expect(completion.mock.calls[1]?.[0].maxTokens).toBe(6_000);
    expect(chat.filter((event) => event.kind === "repair_reminder")).toHaveLength(0);
    expect(chat.find((event) => event.error_code === "output_truncated")).toMatchObject({
      error_code: "output_truncated",
      artifact_valid: false,
    });
    expect(chat.find((event) => event.error_code === "targeted_revision_legacy_fallback")).toBe(
      undefined,
    );
  });

  it("falls back exactly once to the legacy envelope after targeted repair failure", async () => {
    const seed = envelope();
    const revised = envelope(
      "Ship the planning conversation",
      "Deliver the reviewed workflow through the one-time legacy fallback.",
    );
    const pm = new FakeAdapter("anthropic");
    const reviewer = new FakeAdapter("openai");
    reviewer.enqueue({
      findings: [
        {
          severity: "must_fix",
          module_id: "contracts",
          finding: "Clarify the fallback behavior.",
          recommendation: "Document the bounded fallback.",
        },
      ],
    });
    pm.enqueue({
      responses: [{ finding_index: 0, disposition: "accept", rationale: "Applied by fallback." }],
      plan: revised,
    });
    const failedUsage = makeUsageEvent(
      pm.model,
      DEFAULT_MODEL_REGISTRY,
      { projectId: "project-targeted-fallback" },
      300,
      200,
      "provider_api",
    );
    const originalComplete = pm.completeStructured.bind(pm);
    const completion = vi
      .spyOn(pm, "completeStructured")
      .mockRejectedValueOnce(
        new AdapterError("invalid_response", "targeted_plan_revision: invalid operation", {
          metadata: { usage: failedUsage, response_text: '{"changes":[]}' },
        }),
      )
      .mockRejectedValueOnce(
        new AdapterError("invalid_response", "targeted_plan_revision: still invalid", {
          metadata: { usage: failedUsage, response_text: '{"changes":[]}' },
        }),
      )
      .mockImplementation(originalComplete);
    const chat: ReviewOnlyChatEvent[] = [];

    const result = await runReviewOnlyPlanning({
      pm,
      reviewer,
      projectId: "project-targeted-fallback",
      initiatedByUserId: "user-targeted",
      seedPlan: seed,
      frozenContext: {},
      telemetryGroupId: "review-only-targeted-fallback",
      maxRounds: 1,
      revisionFormat: "targeted_v1_with_fallback",
      onChatEvent: (event) => {
        chat.push(event);
      },
    });

    assertTerminal(result);
    expect(result.final_plan).toEqual(revised);
    expect(completion).toHaveBeenCalledTimes(3);
    expect(pm.requests).toHaveLength(1);
    expect(pm.requests[0]?.telemetryRequestId).toContain(":legacy-fallback");
    expect(
      chat.find((event) => event.error_code === "targeted_revision_legacy_fallback")?.content,
    ).toContain("Falling back once");
  });

  describe("plan inflation bound", () => {
    const mustFix: ReviewFindingT = {
      severity: "must_fix",
      module_id: "contracts",
      finding: "The plan never persists the reviewed envelope.",
      recommendation: "Add the missing persistence work.",
    };

    function withExtraModule(base: ReturnType<typeof envelope>, ...ids: string[]) {
      const module = fixtureModule();
      const staffing = fixtureStaffing();
      return V2WorkPlanContract.parse({
        ...base,
        plan: {
          ...base.plan,
          modules: [
            ...base.plan.modules,
            ...ids.map((id) => ({ ...module, id, title: id, dependencies: ["contracts"] })),
          ],
        },
        staffing: [...base.staffing, ...ids.map((id) => ({ ...staffing, module_id: id }))],
      });
    }

    it("rejects a legacy revision that adds a module no accepted finding justifies", async () => {
      const seed = envelope();
      const pm = new FakeAdapter("anthropic");
      const reviewer = new FakeAdapter("openai");
      reviewer.enqueue({ findings: [mustFix] });
      pm.enqueue({
        responses: [
          { finding_index: 0, disposition: "rebut", rationale: "The module already covers it." },
        ],
        plan: withExtraModule(seed, "persistence"),
      });

      await expect(
        runReviewOnlyPlanning({
          pm,
          reviewer,
          projectId: "project-review-only",
          initiatedByUserId: "user-review-only",
          seedPlan: seed,
          frozenContext: {},
          telemetryGroupId: "review-only-inflation-rejected",
          maxRounds: 1,
        }),
      ).rejects.toThrow(/QC revision scope: added 1 module\(s\) \(persistence\) but only 0/);
    });

    it("allows a module addition an accepted must_fix justifies, in both revision formats", async () => {
      const seed = envelope();
      const grown = withExtraModule(seed, "persistence");
      const pm = new FakeAdapter("anthropic");
      const reviewer = new FakeAdapter("openai");
      reviewer.enqueue({ findings: [{ ...mustFix, module_id: null }] });
      pm.enqueue({
        responses: [
          { finding_index: 0, disposition: "accept", rationale: "Added the missing module." },
        ],
        plan: grown,
      });

      const result = await runReviewOnlyPlanning({
        pm,
        reviewer,
        projectId: "project-review-only",
        initiatedByUserId: "user-review-only",
        seedPlan: seed,
        frozenContext: {},
        telemetryGroupId: "review-only-inflation-allowed",
        maxRounds: 1,
      });

      assertTerminal(result);
      expect(result.final_plan.plan.modules.map((module) => module.id)).toEqual([
        "contracts",
        "persistence",
      ]);

      const module = fixtureModule();
      const staffing = fixtureStaffing();
      const targetedChanges: V2QcPlanChangeT[] = [
        {
          op: "add_module",
          finding_indices: [0],
          module: {
            ...module,
            id: "persistence",
            title: "persistence",
            dependencies: ["contracts"],
          },
        },
        {
          op: "add_staffing",
          finding_indices: [0],
          staffing: { ...staffing, module_id: "persistence" },
        },
      ];
      const responses: FindingResponseT[] = [
        { finding_index: 0, disposition: "accept", rationale: "Added the missing module." },
      ];
      expect(
        applyTargetedQcRevision(
          seed,
          { base_plan_content_hash: canonicalSha256(seed), responses, changes: targetedChanges },
          [{ ...mustFix, module_id: null }],
        ).plan.modules,
      ).toHaveLength(2);
      expect(() =>
        applyTargetedQcRevision(
          seed,
          {
            base_plan_content_hash: canonicalSha256(seed),
            responses: [
              { finding_index: 0, disposition: "accept", rationale: "Suggestion applied." },
            ],
            changes: targetedChanges,
          },
          [{ ...mustFix, module_id: null, severity: "suggestion" }],
        ),
      ).toThrow(/only 0 accepted must_fix\/should_fix/);
    });

    it("carries the scope constraint in both QC revision prompts and the PM revision system", async () => {
      const seed = envelope();
      const revised = envelope(
        "Ship the planning conversation",
        "Deliver the strict conversation plan workflow with the reviewed boundary.",
      );
      const legacyPm = new FakeAdapter("anthropic");
      const legacyReviewer = new FakeAdapter("openai");
      legacyReviewer.enqueue({ findings: [mustFix] });
      legacyPm.enqueue({
        responses: [{ finding_index: 0, disposition: "accept", rationale: "Strengthened it." }],
        plan: revised,
      });
      await runReviewOnlyPlanning({
        pm: legacyPm,
        reviewer: legacyReviewer,
        projectId: "project-review-only",
        initiatedByUserId: "user-review-only",
        seedPlan: seed,
        frozenContext: {},
        telemetryGroupId: "review-only-scope-prompt-legacy",
        maxRounds: 1,
      });

      const targetedPm = new FakeAdapter("anthropic");
      const targetedReviewer = new FakeAdapter("openai");
      targetedReviewer.enqueue({ findings: [mustFix] });
      targetedPm.enqueue({
        base_plan_content_hash: canonicalSha256(seed),
        responses: [{ finding_index: 0, disposition: "accept", rationale: "Strengthened it." }],
        changes: [
          {
            op: "replace_module",
            finding_indices: [0],
            module_id: "contracts",
            module: { ...fixtureModule(), description: "Reviewed boundary." },
          },
        ],
      });
      await runReviewOnlyPlanning({
        pm: targetedPm,
        reviewer: targetedReviewer,
        projectId: "project-review-only",
        initiatedByUserId: "user-review-only",
        seedPlan: seed,
        frozenContext: {},
        telemetryGroupId: "review-only-scope-prompt-targeted",
        maxRounds: 1,
        revisionFormat: "targeted_v1",
      });

      for (const request of [legacyPm.requests[0], targetedPm.requests[0]]) {
        expect(request?.prompt).toContain(SCOPE_DISCIPLINE);
        expect(request?.prompt).toContain("rejects a revision that adds more modules");
        expect(request?.system).toContain("Added scope is a defect");
        expect(request?.system).not.toContain("decompose into modules");
      }
    });
  });
});
