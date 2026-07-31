import {
  AdapterError,
  type CompletionRequest,
  type LlmAdapter,
  type StructuredResult,
} from "@norns/adapters";
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
  final_plan_markdown?: string;
  review_rounds: ReviewOnlyRound[];
  usage: UsageEventT[];
}

export interface ReviewOnlyChatEvent {
  request_id: string;
  channel: "reviewer" | "pm";
  round: number;
  attempt: number;
  speaker: "workflow" | "reviewer" | "pm";
  kind: "instruction" | "response" | "repair_reminder" | "error";
  content: string;
  error_code: string | null;
  artifact_markdown?: string;
  artifact_valid?: boolean;
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
  onChatEvent?: (event: ReviewOnlyChatEvent) => void | Promise<void>;
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
    "Treat this as a durable QC deliverable: be complete, specific, and self-contained. The server preserves your exact response and writes the readable result to a Markdown artifact.",
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
    "Treat this as a durable QC deliverable. The server preserves your exact response and writes the complete reviewed plan to a Markdown artifact.",
    `CURRENT WORK PLAN CONTRACT ENVELOPE:\n${JSON.stringify(plan)}`,
  ].join("\n\n");
}

function fencedJson(value: unknown): string {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function reviewerMarkdown(round: number, findings: readonly ReviewFindingT[]): string {
  const lines = [`# QC reviewer · Round ${round}`, ""];
  if (findings.length === 0) {
    lines.push("No changes were requested.");
  } else {
    lines.push("## Findings", "");
    findings.forEach((finding, index) => {
      lines.push(
        `### ${index + 1}. ${finding.severity.replaceAll("_", " ")}`,
        "",
        finding.finding,
        "",
        `**Scope:** ${finding.module_id ?? "Plan level"}`,
        "",
        `**Recommendation:** ${finding.recommendation}`,
        "",
      );
    });
  }
  return lines.join("\n").trim();
}

export function finalPlanMarkdown(
  plan: V2WorkPlanContractT,
  title = "Final reviewed plan",
): string {
  return [
    `# ${title}`,
    "",
    `**Objective:** ${plan.plan.objective}`,
    "",
    "## Complete immutable plan envelope",
    "",
    fencedJson(plan),
  ].join("\n");
}

function revisionMarkdown(round: number, revision: z.infer<typeof ReviewOnlyRevision>): string {
  const responses = revision.responses.length
    ? revision.responses.flatMap((response) => [
        `### Finding ${response.finding_index + 1} · ${response.disposition}`,
        "",
        response.rationale,
        "",
      ])
    : ["No dispositions were required.", ""];
  return [
    `# Planning manager revision · Round ${round}`,
    "",
    "## Responses to reviewer",
    "",
    ...responses,
    finalPlanMarkdown(revision.plan, "Complete revised plan"),
  ].join("\n");
}

function rejectedResponseMarkdown(
  channel: "reviewer" | "pm",
  round: number,
  error: AdapterError,
  response: string,
): string {
  return [
    `# ${channel === "reviewer" ? "QC reviewer" : "Planning manager"} · Round ${round} · Incomplete response`,
    "",
    `> This response was preserved but could not be applied automatically: ${error.message}`,
    "",
    response,
  ].join("\n");
}

async function completeStructuredWithRepair<T>(
  adapter: LlmAdapter,
  request: CompletionRequest,
  schema: z.ZodType<T>,
  schemaName: string,
  telemetryRequestId: string,
  onFailedUsage: (usage: UsageEventT) => void,
  chat: {
    channel: "reviewer" | "pm";
    round: number;
    onEvent?: (event: ReviewOnlyChatEvent) => void | Promise<void>;
    markdown(value: T): string;
  },
): Promise<StructuredResult<T>> {
  const maxAttempts = 2;
  let prompt = request.prompt;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const requestId =
      attempt === 0 ? telemetryRequestId : `${telemetryRequestId}:repair:${attempt}`;
    await chat.onEvent?.({
      request_id: requestId,
      channel: chat.channel,
      round: chat.round,
      attempt: attempt + 1,
      speaker: "workflow",
      kind: attempt === 0 ? "instruction" : "repair_reminder",
      content: prompt,
      error_code: null,
    });
    try {
      const result = await adapter.completeStructured(
        {
          ...request,
          prompt,
          telemetryRequestId: requestId,
          telemetryRetryGroupId: telemetryRequestId,
          telemetryRetryAttempt: attempt,
        },
        schema,
        schemaName,
      );
      await chat.onEvent?.({
        request_id: requestId,
        channel: chat.channel,
        round: chat.round,
        attempt: attempt + 1,
        speaker: chat.channel,
        kind: "response",
        content: result.text ?? JSON.stringify(result.value, null, 2),
        error_code: null,
        artifact_markdown: chat.markdown(result.value),
        artifact_valid: true,
      });
      return result;
    } catch (error) {
      if (error instanceof AdapterError && error.metadata?.response_text?.trim()) {
        await chat.onEvent?.({
          request_id: requestId,
          channel: chat.channel,
          round: chat.round,
          attempt: attempt + 1,
          speaker: chat.channel,
          kind: "response",
          content: error.metadata.response_text,
          error_code: error.kind,
          artifact_markdown: rejectedResponseMarkdown(
            chat.channel,
            chat.round,
            error,
            error.metadata.response_text,
          ),
          artifact_valid: false,
        });
      } else {
        await chat.onEvent?.({
          request_id: requestId,
          channel: chat.channel,
          round: chat.round,
          attempt: attempt + 1,
          speaker: chat.channel,
          kind: "error",
          content: error instanceof Error ? error.message : String(error),
          error_code: error instanceof AdapterError ? error.kind : "unknown_error",
        });
      }
      if (
        !(error instanceof AdapterError) ||
        error.kind !== "invalid_response" ||
        attempt === maxAttempts - 1
      ) {
        throw error;
      }
      if (error.metadata?.usage) onFailedUsage(error.metadata.usage);
      prompt = [
        request.prompt,
        "Your previous QC response was preserved as a Markdown artifact, but it could not be applied automatically.",
        `Validation failure: ${error.message}`,
        "Try once more. Return a fresh, complete JSON application envelope. Correct the validation failure, include every required field, and preserve the full plan. The server will save the readable result as a Markdown file.",
      ].join("\n\n");
    }
  }
  throw new Error("unreachable: structured completion attempts always return or throw");
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
    const reviewRequestId = `${options.telemetryGroupId}:review:${round}`;
    const review = await completeStructuredWithRepair(
      options.reviewer,
      {
        system: reviewerPrompt,
        prompt: reviewOnlyPrompt(reviewedPlan),
        ...meter,
        ...(options.signal ? { signal: options.signal } : {}),
      },
      ReviewFindings,
      "review_findings",
      reviewRequestId,
      (failedUsage) => usage.push(failedUsage),
      {
        channel: "reviewer",
        round,
        ...(options.onChatEvent ? { onEvent: options.onChatEvent } : {}),
        markdown: (value) => reviewerMarkdown(round, value.findings),
      },
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
        final_plan_markdown: finalPlanMarkdown(plan),
        review_rounds: rounds,
        usage,
      };
    }

    const revisionRequestId = `${options.telemetryGroupId}:revision:${round}`;
    const revision = await completeStructuredWithRepair(
      options.pm,
      {
        system: revisionSystem,
        prompt: revisionPrompt(reviewedPlan, findings),
        ...meter,
        ...(options.signal ? { signal: options.signal } : {}),
      },
      ReviewOnlyRevision,
      "plan_revision",
      revisionRequestId,
      (failedUsage) => usage.push(failedUsage),
      {
        channel: "pm",
        round,
        ...(options.onChatEvent ? { onEvent: options.onChatEvent } : {}),
        markdown: (value) =>
          revisionMarkdown(round, {
            responses: value.responses,
            plan: V2WorkPlanContract.parse(value.plan),
          }),
      },
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
        final_plan_markdown: finalPlanMarkdown(plan),
        review_rounds: rounds,
        usage,
      };
    }
  }

  throw new Error("unreachable: review-only loop always returns");
}
