import { describe, expect, it } from "vitest";
import { validatePlan } from "../src/plan.js";

function makeModule(id: string, dependencies: string[] = []) {
  return {
    id,
    title: `Module ${id}`,
    description: `Does ${id}`,
    deliverables: [`src/${id}.ts`],
    acceptance: [
      {
        id: "AC-1",
        statement: `${id} behaves`,
        verification_type: "command",
        verification: "pnpm test",
      },
    ],
    dependencies,
    estimated_complexity: "M",
    risk: "low",
  };
}

function makePlan(modules: unknown[]) {
  return { objective: "Ship the thing", modules };
}

describe("validatePlan", () => {
  it("accepts a valid plan and fills defaults", () => {
    const result = validatePlan(
      makePlan([makeModule("a"), makeModule("b", ["a"]), makeModule("c", ["a", "b"])]),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.modules).toHaveLength(3);
      expect(result.plan.modules[0]?.execution.test_commands).toEqual([]);
      expect(result.plan.modules[0]?.parallelization.safe).toBe(false);
    }
  });

  it("rejects duplicate module ids", () => {
    const result = validatePlan(makePlan([makeModule("a"), makeModule("a")]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "duplicate_module_id")).toBe(true);
    }
  });

  it("rejects unknown dependencies", () => {
    const result = validatePlan(makePlan([makeModule("a", ["ghost"])]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "unknown_dependency")).toBe(true);
    }
  });

  it("rejects dependency cycles and names the path", () => {
    const result = validatePlan(
      makePlan([makeModule("a", ["c"]), makeModule("b", ["a"]), makeModule("c", ["b"])]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const cycle = result.errors.find((e) => e.code === "dependency_cycle");
      expect(cycle).toBeDefined();
      expect(cycle?.message).toContain("->");
    }
  });

  it("rejects a module with no acceptance criteria (schema)", () => {
    const bad = makeModule("a");
    (bad as { acceptance: unknown[] }).acceptance = [];
    const result = validatePlan(makePlan([bad]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "schema")).toBe(true);
    }
  });

  it("rejects non-slug module ids (schema)", () => {
    const result = validatePlan(makePlan([makeModule("Not A Slug!")]));
    expect(result.ok).toBe(false);
  });
});
