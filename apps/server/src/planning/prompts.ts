// Planning-loop prompts. Project Memory is injected verbatim into EVERY
// agent context (PRD R4 §Project Memory) — PM and reviewer alike — with no
// per-prompt engineering. Live prompt-quality iteration happens in Phase 3
// sessions against real models; these are the structural scaffold.
import {
  type PlanContractT,
  type PlanValidationError,
  type ProjectMemoryEntryT,
  type ReviewFindingT,
  renderMemoryBlock,
} from "@norns/contracts";

const PLAN_SHAPE_HINT = `The plan is a JSON object: { objective, assumptions[], modules[], risks[], out_of_scope[] }.
Each module: { id (lowercase-slug), title, description, deliverables[] (min 1),
acceptance[] (min 1, each { id, statement, verification_type: test|command|inspection|human, verification }),
dependencies[] (module ids, acyclic), estimated_complexity: S|M|L|XL, risk: low|medium|high|critical,
execution { likely_paths[], owned_components[], test_commands[] (ADDITIVE to required verification only),
environment_requirements[], migration_required }, parallelization { safe, candidate_work_units[],
shared_files[], integration_owner_required }, inputs[], outputs[], open_decisions[] }.`;

/** Reused verbatim from quickChangePrompt, which never inflated. Revisions
 * re-read the system+prompt every round, so an expansion instruction compounds:
 * a measured QC round doubled module count and 4.5x'd tokens without it. */
export const SCOPE_DISCIPLINE =
  "Scope discipline: address only the findings listed above. Keep each module focused on the requested fix, include proportionate verification, and do not add speculative work or unrelated cleanup. Keep existing module IDs stable and prefer strengthening an existing module over splitting it. Add a new module only when an accepted must_fix or should_fix finding cannot be addressed inside an existing one.";

export function pmSystem(memory: readonly ProjectMemoryEntryT[]): string {
  const memoryBlock = renderMemoryBlock(memory);
  return [
    "You are the PM agent of TheNorns. You produce implementation plans as structured Plan Contract JSON.",
    "State the goal and constraints; decompose into modules with objectively checkable acceptance criteria.",
    memoryBlock,
  ]
    .filter((s) => s.length > 0)
    .join("\n\n");
}

/** Revision-only variant of pmSystem: no "decompose into modules" pressure,
 * which the PM otherwise re-reads on every revision. Drafting still uses
 * pmSystem so the first plan is properly decomposed. */
export function pmRevisionSystem(memory: readonly ProjectMemoryEntryT[]): string {
  const memoryBlock = renderMemoryBlock(memory);
  return [
    "You are the PM agent of TheNorns. You revise an existing implementation plan in place and return structured Plan Contract JSON.",
    "The decomposition already exists. Change only what the reviewer's findings require, keep every other module as-is, and keep acceptance criteria objectively checkable. Added scope is a defect, not thoroughness.",
    memoryBlock,
  ]
    .filter((s) => s.length > 0)
    .join("\n\n");
}

export function reviewerSystem(memory: readonly ProjectMemoryEntryT[]): string {
  const memoryBlock = renderMemoryBlock(memory);
  return [
    "You are an independent plan reviewer from a different provider than the plan's author.",
    "Return structured findings. Severity must_fix is reserved for defects that make the plan unexecutable, unsafe, or unverifiable.",
    memoryBlock,
  ]
    .filter((s) => s.length > 0)
    .join("\n\n");
}

export function draftPlanPrompt(objective: string): string {
  return `Objective:\n${objective}\n\n${PLAN_SHAPE_HINT}\n\nProduce the Plan Contract JSON for this objective.`;
}

export function quickChangePrompt(objective: string): string {
  return `Quick change:\n${objective}\n\n${PLAN_SHAPE_HINT}\n\nReturn the smallest executable Plan Contract for this change. Use exactly one module. Keep the module focused on the requested edit, include proportionate verification, and do not add speculative work or unrelated cleanup.`;
}

export function validationRetryPrompt(errors: readonly PlanValidationError[]): string {
  const list = errors.map((e) => `- [${e.code}] ${e.message}`).join("\n");
  return `Your previous plan failed engine validation:\n${list}\n\nFix every error and return the corrected Plan Contract JSON.`;
}

// PHASE TAB P1: a "modify" decision re-enters the loop with the prior plan
// and the human's direction instead of a from-scratch draft. The revised plan
// then goes through review/revise cycles exactly like a fresh draft.
export function directionRevisionPrompt(plan: PlanContractT, direction: string): string {
  return `The human reviewer has asked for changes to your plan.\n\nHUMAN DIRECTION:\n${direction}\n\nRevise the plan to follow this direction while keeping everything that still applies.\n\nCURRENT PLAN:\n${JSON.stringify(plan)}\n\n${PLAN_SHAPE_HINT}\n\nReturn the revised Plan Contract JSON.`;
}

export function reviewPrompt(plan: PlanContractT): string {
  return `Review this Plan Contract. Return findings as JSON { findings: [{ severity: must_fix|should_fix|suggestion, module_id (or null for plan-level), finding, recommendation }] }.\n\nPLAN:\n${JSON.stringify(plan)}`;
}

export function revisionPrompt(plan: PlanContractT, findings: readonly ReviewFindingT[]): string {
  const list = findings
    .map(
      (f, i) =>
        `${i}. [${f.severity}] (${f.module_id ?? "plan-level"}) ${f.finding} — ${f.recommendation}`,
    )
    .join("\n");
  return `The reviewer returned these findings on your plan:\n${list}\n\nRespond with JSON { responses: [{ finding_index, disposition: accept|rebut, rationale }], plan: <revised Plan Contract> }.\nYou MUST respond to every must_fix finding: accept it and revise the plan, or rebut it with rationale (rebuttals are shown to the human at approval).\n${SCOPE_DISCIPLINE}\n\nCURRENT PLAN:\n${JSON.stringify(plan)}\n\n${PLAN_SHAPE_HINT}`;
}
