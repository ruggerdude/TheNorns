// Phase 3 exit: the loop runs on three objectives with zero copy/paste, a
// bad plan is caught by validation round-trips, the cap-reached path surfaces
// outstanding findings, and memory directives are visibly honored in every
// agent context. Loop logic runs against scripted adapters; live model
// quality iteration follows with real credentials.
import { FakeAdapter } from "@norns/adapters";
import { ProjectMemoryEntry, type ReviewFindingT } from "@norns/contracts";
import { describe, expect, it } from "vitest";
import {
  PlanningError,
  approvePlan,
  planContentHash,
  runPlanning,
} from "../src/planning/session.js";

function plan(moduleIds: string[], deps: Record<string, string[]> = {}) {
  return {
    objective: "build the demo service",
    modules: moduleIds.map((id) => ({
      id,
      title: `Module ${id}`,
      description: `Implements ${id}`,
      deliverables: [`src/${id}.ts`],
      acceptance: [
        {
          id: "AC-1",
          statement: "tests pass",
          verification_type: "command",
          verification: "pnpm test",
        },
      ],
      dependencies: deps[id] ?? [],
      estimated_complexity: "M",
      risk: "low",
    })),
  };
}

const MEMORY = [
  ProjectMemoryEntry.parse({
    id: "mem-1",
    directive: "Never install dependencies automatically.",
    version: 1,
    created_by: "human",
    approved_by_human: true,
    created_at: "2026-07-14T00:00:00.000Z",
  }),
];

const mustFix: ReviewFindingT = {
  severity: "must_fix",
  module_id: "api",
  finding: "no error handling module",
  recommendation: "add an error handling module",
};

const suggestion: ReviewFindingT = {
  severity: "suggestion",
  module_id: null,
  finding: "consider caching",
  recommendation: "optional cache layer",
};

function makeAgents() {
  return { pm: new FakeAdapter("anthropic"), reviewer: new FakeAdapter("openai") };
}

const base = { projectId: "proj-planning", memory: MEMORY };

describe("planning loop — three objectives", () => {
  it("objective 1: converges in round one; memory + exact plan reach both agents", async () => {
    const { pm, reviewer } = makeAgents();
    pm.enqueue(plan(["api"]));
    reviewer.enqueue({ findings: [suggestion] }); // no must-fix -> converged

    const result = await runPlanning({ pm, reviewer, objective: "objective one", ...base });

    expect(result.status).toBe("converged");
    expect(result.rounds).toBe(1);
    expect(result.versions).toHaveLength(1);
    expect(result.policy.pm_provider).toBe("anthropic");
    expect(result.policy.reviewer_provider).toBe("openai");
    expect(result.usage).toHaveLength(2); // one PM call, one reviewer call — all metered

    // memory directives visibly honored in EVERY agent context
    expect(pm.requests[0]?.system).toContain("Never install dependencies automatically.");
    expect(reviewer.requests[0]?.system).toContain("Never install dependencies automatically.");

    // zero copy/paste: the reviewer received the PM's exact plan JSON
    expect(reviewer.requests[0]?.prompt).toContain(JSON.stringify(result.finalPlan));
  });

  it("objective 2: revises after must-fix findings and converges in round two", async () => {
    const { pm, reviewer } = makeAgents();
    pm.enqueue(plan(["api"]));
    reviewer.enqueue({ findings: [mustFix, suggestion] });
    pm.enqueue({
      responses: [
        { finding_index: 0, disposition: "accept", rationale: "added error handling module" },
        { finding_index: 1, disposition: "rebut", rationale: "caching is out of MVP scope" },
      ],
      plan: plan(["api", "errors"], { errors: ["api"] }),
    });
    reviewer.enqueue({ findings: [] });

    const result = await runPlanning({ pm, reviewer, objective: "objective two", ...base });

    expect(result.status).toBe("converged");
    expect(result.rounds).toBe(2);
    expect(result.versions).toHaveLength(2);
    expect(result.finalPlan.modules.map((m) => m.id)).toEqual(["api", "errors"]);
    // dispositions (incl. the rebuttal shown to the human) are recorded on v1
    expect(result.versions[0]?.responses?.map((r) => r.disposition)).toEqual(["accept", "rebut"]);
  });

  it("objective 3: cap reached after three rounds; outstanding must-fix surfaces", async () => {
    const { pm, reviewer } = makeAgents();
    pm.enqueue(plan(["api"]));
    for (let round = 0; round < 3; round += 1) reviewer.enqueue({ findings: [mustFix] });
    for (let revision = 0; revision < 2; revision += 1) {
      pm.enqueue({
        responses: [{ finding_index: 0, disposition: "accept", rationale: "revised again" }],
        plan: plan(["api"]),
      });
    }

    const result = await runPlanning({ pm, reviewer, objective: "objective three", ...base });

    expect(result.status).toBe("cap_reached");
    expect(result.rounds).toBe(3);
    expect(result.versions).toHaveLength(3); // v1 + two revisions
    expect(result.outstanding).toEqual([mustFix]); // the human decides from here
  });
});

describe("planning loop — guardrails", () => {
  it("catches an invalid plan and round-trips validation errors to the PM", async () => {
    const { pm, reviewer } = makeAgents();
    pm.enqueue(plan(["a", "b"], { a: ["b"], b: ["a"] })); // dependency cycle
    pm.enqueue(plan(["a", "b"], { b: ["a"] })); // corrected
    reviewer.enqueue({ findings: [] });

    const result = await runPlanning({ pm, reviewer, objective: "cyclic first", ...base });

    expect(result.status).toBe("converged");
    // the retry prompt carried the engine's validation errors back to the PM
    expect(pm.requests[1]?.prompt).toContain("dependency_cycle");
    expect(pm.requests[1]?.prompt).toContain("failed engine validation");
  });

  it("gives up after validation retries are exhausted", async () => {
    const { pm, reviewer } = makeAgents();
    const cyclic = plan(["a", "b"], { a: ["b"], b: ["a"] });
    pm.enqueue(cyclic, cyclic, cyclic); // initial + 2 retries, all invalid
    await expect(
      runPlanning({ pm, reviewer, objective: "hopeless", ...base }),
    ).rejects.toMatchObject({ code: "plan_invalid" });
  });

  it("refuses same-provider review without a documented exception, allows it with one", async () => {
    const pm = new FakeAdapter("anthropic");
    const reviewer = new FakeAdapter("anthropic");
    await expect(
      runPlanning({ pm, reviewer, objective: "same provider", ...base }),
    ).rejects.toMatchObject({ code: "same_provider" });

    pm.enqueue(plan(["api"]));
    reviewer.enqueue({ findings: [] });
    const result = await runPlanning({
      pm,
      reviewer,
      objective: "same provider, approved exception",
      ...base,
      reviewException: { reason: "openai outage", approvedBy: "dhatwell" },
    });
    expect(result.policy.exception_reason).toBe("openai outage");
    expect(result.policy.exception_approved_by).toBe("dhatwell");
  });

  it("rejects a revision that ignores a must-fix finding", async () => {
    const { pm, reviewer } = makeAgents();
    pm.enqueue(plan(["api"]));
    reviewer.enqueue({ findings: [mustFix] });
    pm.enqueue({ responses: [], plan: plan(["api"]) }); // no disposition
    await expect(
      runPlanning({ pm, reviewer, objective: "ignored finding", ...base }),
    ).rejects.toMatchObject({ code: "missing_dispositions" });
  });
});

describe("plan approval", () => {
  it("records a deterministic, key-order-independent content hash", async () => {
    const { pm, reviewer } = makeAgents();
    pm.enqueue(plan(["api"]));
    reviewer.enqueue({ findings: [] });
    const result = await runPlanning({ pm, reviewer, objective: "approve me", ...base });

    const approval = approvePlan(result.finalPlan, "dhatwell");
    expect(approval.kind).toBe("plan");
    expect(approval.content_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(approval.content_hash).toBe(planContentHash(result.finalPlan));

    // key order does not change what the human approved
    const reordered = JSON.parse(JSON.stringify(result.finalPlan));
    expect(planContentHash(reordered)).toBe(approval.content_hash);
  });
});
