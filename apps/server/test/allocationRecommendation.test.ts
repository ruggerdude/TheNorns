import { FakeAdapter, buildSelectableModelCatalog } from "@norns/adapters";
import { PlanContract } from "@norns/contracts";
import { describe, expect, it } from "vitest";
import { WorkflowGraph } from "../src/graph/graph.js";
import { recommendProjectAllocation } from "../src/planning/allocationRecommendation.js";

const plan = PlanContract.parse({
  objective: "Ship a secure application",
  modules: [
    {
      id: "api",
      title: "API",
      description: "Implement the API",
      deliverables: ["src/api.ts"],
      acceptance: [
        {
          id: "api-tests",
          statement: "API tests pass",
          verification_type: "test",
          verification: "pnpm test",
        },
      ],
      dependencies: [],
      estimated_complexity: "L" as const,
      risk: "high" as const,
      parallelization: { safe: true },
    },
    {
      id: "release",
      title: "Release",
      description: "Release the application",
      deliverables: ["release.md"],
      acceptance: [
        {
          id: "release-check",
          statement: "Release is verified",
          verification_type: "inspection",
          verification: "Inspect release evidence",
        },
      ],
      dependencies: ["api"],
      estimated_complexity: "S" as const,
      risk: "critical" as const,
      parallelization: { safe: false },
    },
  ],
});

const models = buildSelectableModelCatalog([
  { provider: "anthropic", model: "claude-sonnet-5", available: true },
  { provider: "openai", model: "gpt-5.6-terra", available: true },
]);

describe("project-manager allocation recommendation", () => {
  it("selects a validated cross-provider mix and retains the PM rationale", async () => {
    const pm = new FakeAdapter("anthropic", "claude-sonnet-5");
    pm.enqueue({
      summary: "Use parallel Claude workers for the API and one OpenAI worker for release safety.",
      recommendations: [
        {
          node_id: "api",
          provider: "anthropic",
          model: "claude-sonnet-5",
          worker_count: 2,
          reviewer_model: "gpt-5.6-terra",
          budget_usd: 90,
          rationale: "The API is large and safely divisible; Terra provides independent review.",
        },
        {
          node_id: "release",
          provider: "openai",
          model: "gpt-5.6-terra",
          worker_count: 1,
          reviewer_model: "claude-sonnet-5",
          budget_usd: 40,
          rationale: "One accountable release worker with cross-provider verification.",
        },
      ],
    });

    const result = await recommendProjectAllocation({
      pm,
      projectId: "project-1",
      projectName: "Secure app",
      objective: plan.objective,
      graph: WorkflowGraph.fromPlan(plan).snapshot(),
      models,
    });

    expect(
      result.recommendations.map(({ provider, worker_count }) => ({ provider, worker_count })),
    ).toEqual([
      { provider: "anthropic", worker_count: 2 },
      { provider: "openai", worker_count: 1 },
    ]);
    expect(pm.requests[0]?.prompt).toContain("input_usd_per_million_tokens");
    expect(pm.requests[0]?.prompt).toContain('"parallel_safe":true');
    expect(result.usage.model).toBe("claude-sonnet-5");
  });

  it("rejects multiple workers for a node that is not parallel-safe", async () => {
    const pm = new FakeAdapter("anthropic", "claude-sonnet-5");
    pm.enqueue({
      summary: "Invalid recommendation",
      recommendations: [
        {
          node_id: "api",
          provider: "anthropic",
          model: "claude-sonnet-5",
          worker_count: 1,
          reviewer_model: "gpt-5.6-terra",
          budget_usd: 90,
          rationale: "One worker.",
        },
        {
          node_id: "release",
          provider: "openai",
          model: "gpt-5.6-terra",
          worker_count: 2,
          reviewer_model: "claude-sonnet-5",
          budget_usd: 40,
          rationale: "Unsafe split.",
        },
      ],
    });

    await expect(
      recommendProjectAllocation({
        pm,
        projectId: "project-1",
        projectName: "Secure app",
        objective: plan.objective,
        graph: WorkflowGraph.fromPlan(plan).snapshot(),
        models,
      }),
    ).rejects.toMatchObject({ code: "parallelism" });
  });
});
