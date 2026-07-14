import { z } from "zod";

export const moduleSlug = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "must be a lowercase slug (a-z, 0-9, hyphens)");

export const VerificationType = z.enum(["test", "command", "inspection", "human"]);
export const Complexity = z.enum(["S", "M", "L", "XL"]);
export const RiskLevel = z.enum(["low", "medium", "high", "critical"]);

export const AcceptanceCriterion = z.object({
  id: z.string().min(1),
  statement: z.string().min(1),
  verification_type: VerificationType,
  verification: z.string().min(1),
});

// PRD R4: test_commands are ADDITIVE ONLY — they may extend, never replace or
// reduce, the project's Required Verification Commands. The runner always runs
// the required set; enforcement lives server-side, not in this schema.
export const ModuleExecution = z.object({
  likely_paths: z.array(z.string()).default([]),
  owned_components: z.array(z.string()).default([]),
  test_commands: z.array(z.string()).default([]),
  environment_requirements: z.array(z.string()).default([]),
  migration_required: z.boolean().default(false),
});

export const ModuleParallelization = z.object({
  safe: z.boolean(),
  candidate_work_units: z.array(z.string()).default([]),
  shared_files: z.array(z.string()).default([]),
  integration_owner_required: z.boolean().default(true),
});

export const PlanModule = z.object({
  id: moduleSlug,
  title: z.string().min(1),
  description: z.string().min(1),
  deliverables: z.array(z.string().min(1)).min(1),
  acceptance: z.array(AcceptanceCriterion).min(1),
  dependencies: z.array(moduleSlug).default([]),
  estimated_complexity: Complexity,
  risk: RiskLevel,
  execution: ModuleExecution.default({}),
  parallelization: ModuleParallelization.default({ safe: false }),
  inputs: z.array(z.string()).default([]),
  outputs: z.array(z.string()).default([]),
  open_decisions: z.array(z.string()).default([]),
});

export const PlanRisk = z.object({
  description: z.string().min(1),
  mitigation: z.string().default(""),
});

export const PlanContract = z.object({
  objective: z.string().min(1),
  assumptions: z.array(z.string()).default([]),
  modules: z.array(PlanModule).min(1),
  risks: z.array(PlanRisk).default([]),
  out_of_scope: z.array(z.string()).default([]),
});

export type PlanContractT = z.infer<typeof PlanContract>;
export type PlanModuleT = z.infer<typeof PlanModule>;
export type AcceptanceCriterionT = z.infer<typeof AcceptanceCriterion>;

export type PlanValidationErrorCode =
  | "schema"
  | "duplicate_module_id"
  | "unknown_dependency"
  | "dependency_cycle";

export interface PlanValidationError {
  code: PlanValidationErrorCode;
  message: string;
  module_id?: string;
}

export type PlanValidationResult =
  | { ok: true; plan: PlanContractT }
  | { ok: false; errors: PlanValidationError[] };

/**
 * Engine-side plan validation (PRD R4 §Plan Contract): schema, unique ids,
 * resolvable dependencies, acyclic graph. A plan that fails here returns to
 * the PM with errors and never reaches the human as "ready for approval".
 */
export function validatePlan(input: unknown): PlanValidationResult {
  const parsed = PlanContract.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => ({
        code: "schema" as const,
        message: `${issue.path.join(".")}: ${issue.message}`,
      })),
    };
  }
  const plan = parsed.data;
  const errors: PlanValidationError[] = [];

  const ids = new Set<string>();
  for (const mod of plan.modules) {
    if (ids.has(mod.id)) {
      errors.push({
        code: "duplicate_module_id",
        message: `module id "${mod.id}" appears more than once`,
        module_id: mod.id,
      });
    }
    ids.add(mod.id);
  }

  for (const mod of plan.modules) {
    for (const dep of mod.dependencies) {
      if (!ids.has(dep)) {
        errors.push({
          code: "unknown_dependency",
          message: `module "${mod.id}" depends on unknown module "${dep}"`,
          module_id: mod.id,
        });
      }
    }
  }

  if (errors.length === 0) {
    const cycle = findCycle(plan.modules);
    if (cycle) {
      errors.push({
        code: "dependency_cycle",
        message: `dependency cycle: ${cycle.join(" -> ")}`,
      });
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, plan };
}

/** Returns the offending path when the dependency graph has a cycle. */
function findCycle(modules: readonly PlanModuleT[]): string[] | null {
  const deps = new Map<string, readonly string[]>();
  for (const mod of modules) deps.set(mod.id, mod.dependencies);

  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];

  const visit = (id: string): string[] | null => {
    const mark = state.get(id);
    if (mark === "done") return null;
    if (mark === "visiting") {
      const start = stack.indexOf(id);
      return [...stack.slice(start), id];
    }
    state.set(id, "visiting");
    stack.push(id);
    for (const dep of deps.get(id) ?? []) {
      const found = visit(dep);
      if (found) return found;
    }
    stack.pop();
    state.set(id, "done");
    return null;
  };

  for (const mod of modules) {
    const found = visit(mod.id);
    if (found) return found;
  }
  return null;
}
