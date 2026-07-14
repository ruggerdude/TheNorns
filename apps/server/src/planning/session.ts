// The planning workflow (PRD R4 §Planning Workflow):
//   PM -> Plan V1 -> Reviewer -> Findings -> PM revision -> ... ->
//   convergence (zero must-fix) or round cap -> human approval.
// Everything is orchestrated programmatically — zero copy/paste. Plans that
// fail engine validation round-trip back to the PM and never reach the human.
import { createHash } from "node:crypto";
import type { LlmAdapter } from "@norns/adapters";
import {
  type ApprovalT,
  FindingResponse,
  type FindingResponseT,
  PlanContract,
  type PlanContractT,
  type ProjectMemoryEntryT,
  type ReviewFindingT,
  ReviewFindings,
  type ReviewPolicyRecordT,
  type UsageEventT,
  mustFixCount,
  validatePlan,
} from "@norns/contracts";
import { z } from "zod";
import { newId } from "../ids.js";
import {
  draftPlanPrompt,
  pmSystem,
  reviewPrompt,
  reviewerSystem,
  revisionPrompt,
  validationRetryPrompt,
} from "./prompts.js";

export class PlanningError extends Error {
  constructor(
    readonly code: "same_provider" | "plan_invalid" | "missing_dispositions",
    message: string,
  ) {
    super(message);
    this.name = "PlanningError";
  }
}

const RevisionResponse = z.object({
  responses: z.array(FindingResponse),
  plan: PlanContract,
});

export interface PlanVersionRecord {
  version: number;
  plan: PlanContractT;
  findings: ReviewFindingT[] | null; // review of THIS version
  responses: FindingResponseT[] | null; // PM dispositions that produced the NEXT version
}

export interface PlanningResult {
  status: "converged" | "cap_reached";
  rounds: number;
  versions: PlanVersionRecord[];
  finalPlan: PlanContractT;
  /** must-fix findings still open at the cap — shown to the human */
  outstanding: ReviewFindingT[];
  policy: ReviewPolicyRecordT;
  usage: UsageEventT[];
}

export interface PlanningOptions {
  pm: LlmAdapter;
  reviewer: LlmAdapter;
  objective: string;
  projectId: string;
  memory?: readonly ProjectMemoryEntryT[];
  maxRounds?: number; // default 3 (PRD)
  maxValidationRetries?: number; // default 2
  /** documented, human-approved exception to cross-provider review */
  reviewException?: { reason: string; approvedBy: string };
}

export async function runPlanning(options: PlanningOptions): Promise<PlanningResult> {
  const memory = options.memory ?? [];
  const maxRounds = options.maxRounds ?? 3;
  const maxValidationRetries = options.maxValidationRetries ?? 2;
  const usage: UsageEventT[] = [];

  // Review Policy: cross-provider by default; exceptions are recorded
  if (options.pm.provider === options.reviewer.provider && !options.reviewException) {
    throw new PlanningError(
      "same_provider",
      "cross-provider review is the default policy; a documented human-approved exception is required to use the same provider",
    );
  }
  const policy: ReviewPolicyRecordT = {
    requested_policy: "cross_provider",
    pm_provider: options.pm.provider,
    reviewer_provider: options.reviewer.provider,
    exception_reason: options.reviewException?.reason ?? null,
    exception_approved_by: options.reviewException?.approvedBy ?? null,
  };

  const meter = { projectId: options.projectId };
  const system = pmSystem(memory);

  // engine-validated structured plan generation with error round-trips
  const generateValidPlan = async (initialPrompt: string): Promise<PlanContractT> => {
    let prompt = initialPrompt;
    for (let attempt = 0; attempt <= maxValidationRetries; attempt += 1) {
      const draft = await options.pm.completeStructured(
        { system, prompt, ...meter },
        PlanContract,
        "plan_contract",
      );
      usage.push(draft.usage);
      const validation = validatePlan(draft.value);
      if (validation.ok) return validation.plan;
      prompt = validationRetryPrompt(validation.errors);
    }
    throw new PlanningError("plan_invalid", "plan failed engine validation after retries");
  };

  const versions: PlanVersionRecord[] = [];
  let plan = await generateValidPlan(draftPlanPrompt(options.objective));
  versions.push({ version: 1, plan, findings: null, responses: null });

  for (let round = 1; round <= maxRounds; round += 1) {
    const review = await options.reviewer.completeStructured(
      { system: reviewerSystem(memory), prompt: reviewPrompt(plan), ...meter },
      ReviewFindings,
      "review_findings",
    );
    usage.push(review.usage);
    const findings = review.value.findings;
    const current = versions[versions.length - 1];
    if (current) current.findings = [...findings];

    if (mustFixCount(findings) === 0) {
      return {
        status: "converged",
        rounds: round,
        versions,
        finalPlan: plan,
        outstanding: [],
        policy,
        usage,
      };
    }

    if (round === maxRounds) {
      // cap reached: the human sees the plan with outstanding findings
      return {
        status: "cap_reached",
        rounds: round,
        versions,
        finalPlan: plan,
        outstanding: findings.filter((f) => f.severity === "must_fix"),
        policy,
        usage,
      };
    }

    // PM revision: disposition every must-fix, produce the next version
    const revision = await options.pm.completeStructured(
      { system, prompt: revisionPrompt(plan, findings), ...meter },
      RevisionResponse,
      "plan_revision",
    );
    usage.push(revision.usage);

    const answered = new Set(revision.value.responses.map((r) => r.finding_index));
    const unanswered = findings
      .map((finding, index) => ({ finding, index }))
      .filter(({ finding, index }) => finding.severity === "must_fix" && !answered.has(index));
    if (unanswered.length > 0) {
      throw new PlanningError(
        "missing_dispositions",
        `PM left must-fix findings without a disposition: ${unanswered.map((u) => u.index).join(", ")}`,
      );
    }

    const validation = validatePlan(revision.value.plan);
    if (!validation.ok) {
      // revised plan must also survive engine validation
      plan = await generateValidPlan(validationRetryPrompt(validation.errors));
    } else {
      plan = validation.plan;
    }
    if (current) current.responses = [...revision.value.responses];
    versions.push({ version: versions.length + 1, plan, findings: null, responses: null });
  }

  throw new Error("unreachable: round loop always returns");
}

/** Canonical, key-order-independent hash of what the human approves. */
export function planContentHash(plan: PlanContractT): string {
  return createHash("sha256").update(stableStringify(plan)).digest("hex");
}

/** Human approval of the final plan — records the exact content hash. */
export function approvePlan(plan: PlanContractT, actor: string): ApprovalT {
  return {
    id: newId("appr"),
    kind: "plan",
    actor,
    approved_at: new Date().toISOString(),
    content_hash: planContentHash(plan),
  };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}
