import { V2WorkPlanContract } from "@norns/contracts";
import { describe, expect, it } from "vitest";
import { removeFalsePlanDependencies } from "../src/conversations/planProposal.js";
import { classifyFailureRetry } from "../src/coordinator/failureRetryPolicy.js";

function module(id: string, path: string, dependencies: string[] = []) {
  return {
    id,
    title: id,
    description: `Implement ${id}`,
    deliverables: [`${id} deliverable`],
    acceptance: [
      {
        id: `${id}-passes`,
        statement: `${id} passes`,
        verification_type: "test" as const,
        verification: `test ${id}`,
      },
    ],
    dependencies,
    estimated_complexity: "M" as const,
    risk: "medium" as const,
    execution: {
      likely_paths: [path],
      owned_components: [id],
      test_commands: ["pnpm test"],
      environment_requirements: [],
      migration_required: false,
    },
    parallelization: {
      safe: true,
      candidate_work_units: [id],
      shared_files: [],
      integration_owner_required: false,
    },
    inputs: [],
    outputs: [`${id} output`],
    open_decisions: [],
  };
}

describe("execution speed policies", () => {
  it("never recommends looping a deterministic permission failure", () => {
    expect(classifyFailureRetry("runner_permission_denied", "Edit denied", 1)).toMatchObject({
      retryClass: "configuration",
      automaticRetryAllowed: false,
      recommendation: "cancel",
    });
  });

  it("allows one transient retry and then stops recommending retries", () => {
    expect(classifyFailureRetry("runner_runtime_failed", "socket reset", 1)).toMatchObject({
      retryClass: "transient",
      automaticRetryAllowed: true,
      recommendation: "retry",
    });
    expect(classifyFailureRetry("runner_runtime_failed", "socket reset", 2)).toMatchObject({
      automaticRetryAllowed: false,
      recommendation: "cancel",
    });
  });

  it("removes serialization edges contradicted by disjoint parallel-safe scopes", () => {
    const plan = V2WorkPlanContract.parse({
      plan: {
        objective: "Implement independent files",
        assumptions: [],
        modules: [module("server", "apps/server/a.ts"), module("web", "apps/web/b.ts", ["server"])],
        risks: [],
        out_of_scope: [],
      },
      staffing: ["server", "web"].map((moduleId) => ({
        module_id: moduleId,
        agent_role: "implementation",
        provider: "openai",
        model: "gpt-5.6-sol",
      })),
      verification_requirements: ["Tests pass"],
      open_decisions: [],
      estimated_budget: { currency: "USD", amount: 10 },
    });

    expect(removeFalsePlanDependencies(plan).plan.modules[1]?.dependencies).toEqual([]);
  });

  it("preserves a dependency when the successor consumes the predecessor output", () => {
    const server = module("server", "apps/server/a.ts");
    const web = { ...module("web", "apps/web/b.ts", ["server"]), inputs: ["server output"] };
    const plan = V2WorkPlanContract.parse({
      plan: {
        objective: "Implement linked files",
        assumptions: [],
        modules: [server, web],
        risks: [],
        out_of_scope: [],
      },
      staffing: ["server", "web"].map((moduleId) => ({
        module_id: moduleId,
        agent_role: "implementation",
        provider: "openai",
        model: "gpt-5.6-sol",
      })),
      verification_requirements: ["Tests pass"],
      open_decisions: [],
      estimated_budget: { currency: "USD", amount: 10 },
    });

    expect(removeFalsePlanDependencies(plan).plan.modules[1]?.dependencies).toEqual(["server"]);
  });
});
