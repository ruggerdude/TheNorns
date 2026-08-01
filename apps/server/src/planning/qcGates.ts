import type {
  V2ConversationPlanReviewDispositionT,
  V2ConversationPlanReviewFindingT,
  V2WorkPlanContractT,
} from "@norns/contracts";
import { canonicalSha256 } from "../persistence/migration/canonicalJson.js";

export interface GateCFinding {
  finding_id: string;
  finding_index: number;
  module_id: string | null;
  reason: "declared_rebuttal" | "hollow_acceptance" | "should_fix_recurrence";
}

function moduleSubtree(plan: V2WorkPlanContractT, moduleId: string) {
  return plan.plan.modules.find((module) => module.id === moduleId) ?? null;
}

/**
 * True when the finding's target region is byte-identical before and after
 * the PM's revision. Scoped to the finding's module_id so an unrelated edit
 * elsewhere in the plan can't mask a hollow acceptance. A null module_id, or
 * a module_id absent from either plan, falls back to a whole-plan comparison
 * rather than throwing.
 */
function regionUnchanged(
  moduleId: string | null,
  planBefore: V2WorkPlanContractT,
  planAfter: V2WorkPlanContractT,
): boolean {
  if (moduleId !== null) {
    const before = moduleSubtree(planBefore, moduleId);
    const after = moduleSubtree(planAfter, moduleId);
    if (before !== null && after !== null) {
      return canonicalSha256(before) === canonicalSha256(after);
    }
  }
  return canonicalSha256(planBefore) === canonicalSha256(planAfter);
}

/**
 * Gate C — the mandatory adjudication stop (see QC-PAUSE-POINTS.md
 * "Adjudication: unresolved must-fix rebuttals"). Fires per must_fix finding
 * when the PM's disposition is a declared rebuttal (suppressed by
 * `allowUnadjudicatedRebuttals`), or an acceptance that left the finding's
 * target plan region unchanged (never suppressed).
 *
 * `should_fix` findings don't trigger Gate C on their own, but a rebutted
 * `should_fix` escalates when a *later* round rebuts another `should_fix`
 * against the same `module_id` — see "Repeat disputes" in the plan.
 * Matching is deliberately dumb: same `module_id`, nothing else. Findings
 * with a null `module_id` are never matched.
 */
export function detectGateC(args: {
  findings: V2ConversationPlanReviewFindingT[];
  // Only finding_index/disposition are read here; narrowed to that subset so
  // callers building a disposition ahead of the full record (e.g. before an
  // adjudication ruling exists) don't need to fabricate the rest of the shape.
  dispositions: Pick<V2ConversationPlanReviewDispositionT, "finding_index" | "disposition">[];
  planBefore: V2WorkPlanContractT;
  planAfter: V2WorkPlanContractT;
  allowUnadjudicatedRebuttals: boolean;
  /** module_ids that already had a `should_fix` finding rebutted in an
   * earlier round of this same review (same-module dumb match). */
  priorRebuttedShouldFixModuleIds?: readonly string[];
  /** module_ids a human has already ruled "for the reviewer" on: that
   * ruling can never be re-rebutted, so these are excluded from Gate C
   * entirely rather than being re-adjudicated every round. */
  forcedAcceptModuleIds?: readonly string[];
}): GateCFinding[] {
  const priorShouldFix = new Set(args.priorRebuttedShouldFixModuleIds ?? []);
  const forcedAccept = new Set(args.forcedAcceptModuleIds ?? []);
  const results: GateCFinding[] = [];
  for (const finding of args.findings) {
    if (finding.module_id !== null && forcedAccept.has(finding.module_id)) continue;
    const disposition = args.dispositions.find((d) => d.finding_index === finding.index);
    if (!disposition) continue;
    if (finding.severity === "should_fix") {
      if (
        disposition.disposition === "rebut" &&
        finding.module_id !== null &&
        priorShouldFix.has(finding.module_id)
      ) {
        results.push({
          finding_id: finding.id,
          finding_index: finding.index,
          module_id: finding.module_id,
          reason: "should_fix_recurrence",
        });
      }
      continue;
    }
    if (finding.severity !== "must_fix") continue;
    if (disposition.disposition === "rebut") {
      if (!args.allowUnadjudicatedRebuttals) {
        results.push({
          finding_id: finding.id,
          finding_index: finding.index,
          module_id: finding.module_id,
          reason: "declared_rebuttal",
        });
      }
      continue;
    }
    if (regionUnchanged(finding.module_id, args.planBefore, args.planAfter)) {
      results.push({
        finding_id: finding.id,
        finding_index: finding.index,
        module_id: finding.module_id,
        reason: "hollow_acceptance",
      });
    }
  }
  return results;
}

/**
 * Recurrence data for the review read model (QC-PAUSE-POINTS.md "Repeat
 * disputes across attempts"): for every must_fix/should_fix finding, which
 * earlier findings shared its `module_id`. Same dumb same-module match as
 * Gate C escalation — no semantic comparison, no confidence threshold.
 * Findings with a null `module_id`, and `suggestion`-severity findings, are
 * never matched. Ordering matters: pass findings oldest-first (across
 * rounds, and across attempts if the caller has them) so each entry only
 * ever points backward.
 *
 * ponytail: within-review only at the call site today (reviewOnlySession has
 * no visibility into other attempts of the same work item); cross-attempt
 * recurrence needs the caller to concatenate prior attempts' findings first.
 */
export function findRecurringFindingIds(
  findings: readonly Pick<V2ConversationPlanReviewFindingT, "id" | "module_id" | "severity">[],
): Map<string, string[]> {
  const byModule = new Map<string, string[]>();
  const recurrences = new Map<string, string[]>();
  for (const finding of findings) {
    if (finding.module_id === null || finding.severity === "suggestion") continue;
    const prior = byModule.get(finding.module_id) ?? [];
    if (prior.length > 0) recurrences.set(finding.id, prior);
    byModule.set(finding.module_id, [...prior, finding.id]);
  }
  return recurrences;
}
