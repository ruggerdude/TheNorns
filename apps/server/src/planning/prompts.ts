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

export function validationRetryPrompt(errors: readonly PlanValidationError[]): string {
  const list = errors.map((e) => `- [${e.code}] ${e.message}`).join("\n");
  return `Your previous plan failed engine validation:\n${list}\n\nFix every error and return the corrected Plan Contract JSON.`;
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
  return `The reviewer returned these findings on your plan:\n${list}\n\nRespond with JSON { responses: [{ finding_index, disposition: accept|rebut, rationale }], plan: <revised Plan Contract> }.\nYou MUST respond to every must_fix finding: accept it and revise the plan, or rebut it with rationale (rebuttals are shown to the human at approval).\n\nCURRENT PLAN:\n${JSON.stringify(plan)}\n\n${PLAN_SHAPE_HINT}`;
}
