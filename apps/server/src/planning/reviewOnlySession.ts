import type { LlmAdapter } from "@norns/adapters";
import {
  FindingResponse,
  type FindingResponseT,
  type ReviewFindingT,
  ReviewFindings,
  type UsageEventT,
  V2WorkPlanContract,
  type V2WorkPlanContractT,
  mustFixCount,
} from "@norns/contracts";
import { z } from "zod";
import { canonicalSha256 } from "../persistence/migration/canonicalJson.js";
import { pmSystem, reviewerSystem } from "./prompts.js";
import { PlanningError } from "./session.js";

const ReviewOnlyRevision = z
  .object({
    responses: z.array(FindingResponse),
    plan: V2WorkPlanContract,
  })
  .strict();

export interface ReviewOnlyRound {
  round: number;
  reviewed_plan: V2WorkPlanContractT;
  findings: ReviewFindingT[];
  responses: FindingResponseT[] | null;
  revised_plan_content_hash?: string | null;
}

export interface ReviewOnlyPlanningResult {
  status: "converged" | "cap_reached";
  rounds: number;
  seed_plan: V2WorkPlanContractT;
  final_plan: V2WorkPlanContractT;
  result_plan_content_hash: string;
  review_rounds: ReviewOnlyRound[];
  usage: UsageEventT[];
}

export interface ReviewOnlyPlanningOptions {
  pm: LlmAdapter;
  reviewer: LlmAdapter;
  projectId: string;
  initiatedByUserId: string;
  seedPlan: V2WorkPlanContractT;
  frozenContext: unknown;
  telemetryGroupId: string;
  maxRounds: number;
  signal?: AbortSignal;
  onProgress?: (rounds: readonly ReviewOnlyRound[]) => void | Promise<void>;
}

function reviewOnlySystem(base: string, frozenContext: unknown): string {
  return [
    base,
    "This is a review-only seeded planning run. The frozen package below is the complete binding context. It deliberately contains no brainstorming transcript.",
    `FROZEN QC CONTEXT:\n${JSON.stringify(frozenContext)}`,
  ].join("\n\n");
}

function reviewOnlyPrompt(plan: V2WorkPlanContractT): string {
  return [
    "Review the exact immutable Work Plan Contract envelope below.",
    "Return JSON { findings: [{ severity: must_fix|should_fix|suggestion, module_id (or null), finding, recommendation }] }.",
    `WORK PLAN CONTRACT ENVELOPE:\n${JSON.stringify(plan)}`,
  ].join("\n\n");
}

function revisionPrompt(plan: V2WorkPlanContractT, findings: readonly ReviewFindingT[]): string {
  const list = findings
    .map(
      (finding, index) =>
        `${index}. [${finding.severity}] (${finding.module_id ?? "plan-level"}) ${finding.finding} — ${finding.recommendation}`,
    )
    .join("\n");
  return [
    "The independent reviewer returned the findings below.",
    list,
    "Return JSON { responses: [{ finding_index, disposition: accept|rebut, rationale }], plan: <complete revised Work Plan Contract envelope> }.",
    "Every must_fix requires an attributable accept or rebut disposition. Preserve the complete strict envelope, including staffing, verification requirements, open decisions, and budget.",
    `CURRENT WORK PLAN CONTRACT ENVELOPE:\n${JSON.stringify(plan)}`,
  ].join("\n\n");
}

/**
 * The additive review-only mode for durable planning runs. It never calls the
 * draft prompt: the reviewer is the first provider to receive the exact saved
 * envelope and its frozen, transcript-free context receipt.
 */
export async function runReviewOnlyPlanning(
  options: ReviewOnlyPlanningOptions,
): Promise<ReviewOnlyPlanningResult> {
  if (options.pm.provider === options.reviewer.provider) {
    throw new PlanningError(
      "same_provider",
      "review-only planning requires an opposite-provider reviewer",
    );
  }
  const seedPlan = V2WorkPlanContract.parse(options.seedPlan);
  let plan = seedPlan;
  const usage: UsageEventT[] = [];
  const rounds: ReviewOnlyRound[] = [];
  const meter = {
    projectId: options.projectId,
    initiatedByUserId: options.initiatedByUserId,
  };
  const reviewerPrompt = reviewOnlySystem(reviewerSystem([]), options.frozenContext);
  const revisionSystem = reviewOnlySystem(pmSystem([]), options.frozenContext);

  for (let round = 1; round <= options.maxRounds; round += 1) {
    const reviewedPlan = plan;
    const review = await options.reviewer.completeStructured(
      {
        system: reviewerPrompt,
        prompt: reviewOnlyPrompt(reviewedPlan),
        ...meter,
        telemetryRequestId: `${options.telemetryGroupId}:review:${round}`,
        telemetryRetryGroupId: `${options.telemetryGroupId}:review:${round}`,
        telemetryRetryAttempt: 0,
        ...(options.signal ? { signal: options.signal } : {}),
      },
      ReviewFindings,
      "review_findings",
    );
    usage.push(review.usage);
    const findings = [...review.value.findings];
    const record: ReviewOnlyRound = {
      round,
      reviewed_plan: reviewedPlan,
      findings,
      responses: null,
      revised_plan_content_hash: null,
    };
    rounds.push(record);
    await options.onProgress?.(rounds);
    if (mustFixCount(findings) === 0) {
      return {
        status: "converged",
        rounds: round,
        seed_plan: seedPlan,
        final_plan: plan,
        result_plan_content_hash: canonicalSha256(plan),
        review_rounds: rounds,
        usage,
      };
    }

    const revision = await options.pm.completeStructured(
      {
        system: revisionSystem,
        prompt: revisionPrompt(reviewedPlan, findings),
        ...meter,
        telemetryRequestId: `${options.telemetryGroupId}:revision:${round}`,
        telemetryRetryGroupId: `${options.telemetryGroupId}:revision:${round}`,
        telemetryRetryAttempt: 0,
        ...(options.signal ? { signal: options.signal } : {}),
      },
      ReviewOnlyRevision,
      "plan_revision",
    );
    usage.push(revision.usage);
    const answered = new Set<number>();
    for (const response of revision.value.responses) {
      if (response.finding_index >= findings.length) {
        throw new PlanningError(
          "missing_dispositions",
          `PM disposition references unknown finding index ${response.finding_index}`,
        );
      }
      if (answered.has(response.finding_index)) {
        throw new PlanningError(
          "missing_dispositions",
          `PM returned duplicate dispositions for finding index ${response.finding_index}`,
        );
      }
      answered.add(response.finding_index);
    }
    const missing = findings
      .map((finding, index) => ({ finding, index }))
      .filter(({ finding, index }) => finding.severity === "must_fix" && !answered.has(index));
    if (missing.length > 0) {
      throw new PlanningError(
        "missing_dispositions",
        `PM left must-fix findings without a disposition: ${missing.map(({ index }) => index).join(", ")}`,
      );
    }
    record.responses = [...revision.value.responses];
    plan = V2WorkPlanContract.parse(revision.value.plan);
    record.revised_plan_content_hash = canonicalSha256(plan);
    await options.onProgress?.(rounds);
    if (round === options.maxRounds) {
      return {
        status: "cap_reached",
        rounds: round,
        seed_plan: seedPlan,
        final_plan: plan,
        result_plan_content_hash: canonicalSha256(plan),
        review_rounds: rounds,
        usage,
      };
    }
  }

  throw new Error("unreachable: review-only loop always returns");
}
