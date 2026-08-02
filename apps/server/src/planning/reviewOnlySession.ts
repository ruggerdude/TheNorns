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
  type V2QcModeT,
  V2WorkPlanContract,
  type V2WorkPlanContractT,
  mustFixCount,
} from "@norns/contracts";
import { z } from "zod";
import { canonicalSha256 } from "../persistence/migration/canonicalJson.js";
import { pmSystem, reviewerSystem } from "./prompts.js";
import { type GateCFinding, detectGateC } from "./qcGates.js";
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

export type QcMode = V2QcModeT;

export type ReviewOnlyCheckpoint = "after_review" | "after_revision" | "adjudication";

export interface ReviewOnlyResumeState {
  fromRound: number;
  checkpoint: ReviewOnlyCheckpoint;
  plan: V2WorkPlanContractT;
  rounds: ReviewOnlyRound[];
  // ponytail: note is accepted but not threaded into the next pass's prompt
  // yet — wiring it to the right channel/round needs the steering machinery
  // this phase intentionally does not build.
  note?: { channel: "reviewer" | "pm"; message: string };
  // QCP-3A: module_ids a human has ruled "for the reviewer" on at Gate C
  // adjudication. The finding stands and cannot be rebutted again — enforced
  // below by excluding these modules from Gate C entirely (detectGateC), not
  // by rewriting whatever the PM says about them. The standing ruling itself
  // (who decided, and why) lives in the review's `adjudications` column and
  // is re-attached to every later disposition on the module by
  // planWorkflow.ts's flattenReviewEvidence — this array only needs the ids.
  // Accumulates for the life of the review, across every future resume.
  forcedAcceptModuleIds?: string[];
}

export interface ReviewOnlyPlanningTerminalResult {
  status: "converged" | "cap_reached";
  rounds: number;
  seed_plan: V2WorkPlanContractT;
  final_plan: V2WorkPlanContractT;
  result_plan_content_hash: string;
  final_plan_markdown?: string;
  review_rounds: ReviewOnlyRound[];
  usage: UsageEventT[];
}

export interface ReviewOnlyPlanningPausedResult {
  status: "paused";
  paused_checkpoint: ReviewOnlyCheckpoint;
  paused_at_round: number;
  plan: V2WorkPlanContractT;
  rounds: ReviewOnlyRound[];
  gate_c_findings?: GateCFinding[];
  usage: UsageEventT[];
}

export type ReviewOnlyPlanningResult =
  | ReviewOnlyPlanningTerminalResult
  | ReviewOnlyPlanningPausedResult;

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

export interface ReviewOnlyProgressEvent {
  stage: "preparing" | "reviewing" | "revising" | "repairing" | "validating" | "saving";
  round: number;
  attempt: number;
  provider: "anthropic" | "openai";
  model: string;
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
  /** Which checkpoints stop the loop. Gate C (adjudication) always stops
   * regardless of this setting. Defaults to "automatic" (no cadence gates). */
  qcMode?: QcMode;
  /** Suppresses Gate C stops for declared rebuttals only. Hollow-acceptance
   * stops always fire. Defaults to false. */
  allowUnadjudicatedRebuttals?: boolean;
  /** Resume a previously paused run from persisted state instead of starting
   * at round 1. */
  resume?: ReviewOnlyResumeState;
  onProgress?: (rounds: readonly ReviewOnlyRound[]) => void | Promise<void>;
  onChatEvent?: (event: ReviewOnlyChatEvent) => void | Promise<void>;
  onStage?: (event: ReviewOnlyProgressEvent) => void | Promise<void>;
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
    onStage?: (event: ReviewOnlyProgressEvent) => void | Promise<void>;
    markdown(value: T): string;
  },
): Promise<StructuredResult<T> & { progress_attempt: number }> {
  const maxAttempts = 2;
  let prompt = request.prompt;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const requestId =
      attempt === 0 ? telemetryRequestId : `${telemetryRequestId}:repair:${attempt}`;
    await chat.onStage?.({
      stage: attempt === 0 ? (chat.channel === "reviewer" ? "reviewing" : "revising") : "repairing",
      round: chat.round,
      attempt: attempt + 1,
      provider: adapter.provider,
      model: adapter.model,
    });
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
      await chat.onStage?.({
        stage: "validating",
        round: chat.round,
        attempt: attempt + 1,
        provider: adapter.provider,
        model: adapter.model,
      });
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
      return { ...result, progress_attempt: attempt + 1 };
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
  const qcMode: QcMode = options.qcMode ?? "automatic";
  const allowUnadjudicatedRebuttals = options.allowUnadjudicatedRebuttals ?? false;
  const resume = options.resume;
  let plan = resume ? V2WorkPlanContract.parse(resume.plan) : seedPlan;
  // QCP-3A: module_ids ruled "for the reviewer" at Gate C. A ruling doesn't
  // need to redo the disputed round in place — it rides the review's next
  // ordinary reviewer+PM pass, which either doesn't re-raise the module (the
  // dispute is moot) or does, in which case the same-module dumb match below
  // forces the PM's disposition and the finding is never re-adjudicated.
  const forcedAcceptModuleIds = new Set(resume?.forcedAcceptModuleIds ?? []);
  const usage: UsageEventT[] = [];
  const rounds: ReviewOnlyRound[] = resume ? [...resume.rounds] : [];
  const meter = {
    projectId: options.projectId,
    initiatedByUserId: options.initiatedByUserId,
  };
  const reviewerPrompt = reviewOnlySystem(reviewerSystem([]), options.frozenContext);
  const revisionSystem = reviewOnlySystem(pmSystem([]), options.frozenContext);

  // Resuming at "after_review" re-enters the same round the reviewer already
  // produced findings for; "after_revision" and "adjudication" both advance
  // to the next round with the persisted plan. A "rule for reviewer" ruling
  // doesn't special-case this: it rides the same plain advance, and
  // forcedAcceptModuleIds (above) is what actually carries the ruling out.
  const startRound = resume
    ? resume.checkpoint === "after_review"
      ? resume.fromRound
      : resume.fromRound + 1
    : 1;
  const skipReviewerAtStart = resume?.checkpoint === "after_review";

  for (let round = startRound; round <= options.maxRounds; round += 1) {
    let reviewedPlan: V2WorkPlanContractT;
    let findings: ReviewFindingT[];
    let record: ReviewOnlyRound;

    if (round === startRound && skipReviewerAtStart) {
      const resumedRecord = rounds.find((candidate) => candidate.round === round);
      if (!resumedRecord) {
        throw new Error(
          `resume checkpoint "after_review" expects a round ${round} entry in resume.rounds`,
        );
      }
      record = resumedRecord;
      reviewedPlan = record.reviewed_plan;
      findings = record.findings;
    } else {
      reviewedPlan = plan;
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
          ...(options.onStage ? { onStage: options.onStage } : {}),
          markdown: (value) => reviewerMarkdown(round, value.findings),
        },
      );
      usage.push(review.usage);
      findings = [...review.value.findings];
      record = {
        round,
        reviewed_plan: reviewedPlan,
        findings,
        responses: null,
        revised_plan_content_hash: null,
      };
      rounds.push(record);
      await options.onStage?.({
        stage: "saving",
        round,
        attempt: review.progress_attempt,
        provider: options.reviewer.provider,
        model: options.reviewer.model,
      });
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
      if (qcMode === "gated_each_step" || qcMode === "gated_when_contested") {
        return {
          status: "paused",
          paused_checkpoint: "after_review",
          paused_at_round: round,
          plan: reviewedPlan,
          rounds: [...rounds],
          usage,
        };
      }
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
        ...(options.onStage ? { onStage: options.onStage } : {}),
        markdown: (value) =>
          revisionMarkdown(round, {
            responses: value.responses,
            plan: V2WorkPlanContract.parse(value.plan),
          }),
      },
    );
    usage.push(revision.usage);
    // QCP-3A "cannot be rebutted again": a finding whose module was already
    // ruled for the reviewer can't be re-argued by the PM. Enforcement is
    // `forcedAcceptModuleIds` excluding the module from Gate C below (and from
    // future adjudication) — the PM's own response is left untouched here on
    // purpose. A human ruling "must be recorded as one rather than attributed
    // to an agent" (QC-PAUSE-POINTS.md "Outcomes"); rewriting `disposition`/
    // `rationale` to look like the PM's own accept would commit that error in
    // reverse. The honest record — verbatim PM response plus the standing
    // ruling attached by module_id — is assembled downstream in
    // planWorkflow.ts's flattenReviewEvidence.
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
    await options.onStage?.({
      stage: "saving",
      round,
      attempt: revision.progress_attempt,
      provider: options.pm.provider,
      model: options.pm.model,
    });
    await options.onProgress?.(rounds);

    // Same-module dumb match against every earlier round's rebutted
    // should_fix findings (never the current round, already excluded by
    // slice(0, -1) since `record` is always the last entry by this point).
    const priorRebuttedShouldFixModuleIds = rounds.slice(0, -1).flatMap((prior) =>
      (prior.responses ?? []).flatMap((response) => {
        if (response.disposition !== "rebut") return [];
        const finding = prior.findings[response.finding_index];
        return finding && finding.severity === "should_fix" && finding.module_id !== null
          ? [finding.module_id]
          : [];
      }),
    );
    const gateCFindings = detectGateC({
      findings: findings.map((finding, index) => ({
        id: String(index),
        index,
        severity: finding.severity,
        module_id: finding.module_id,
        finding: finding.finding,
        recommendation: finding.recommendation,
      })),
      dispositions: revision.value.responses.map((response) => ({
        finding_id: String(response.finding_index),
        finding_index: response.finding_index,
        disposition: response.disposition,
        rationale: response.rationale,
      })),
      planBefore: reviewedPlan,
      planAfter: plan,
      allowUnadjudicatedRebuttals,
      priorRebuttedShouldFixModuleIds,
      forcedAcceptModuleIds: [...forcedAcceptModuleIds],
    });
    if (gateCFindings.length > 0) {
      return {
        status: "paused",
        paused_checkpoint: "adjudication",
        paused_at_round: round,
        plan: reviewedPlan,
        rounds: [...rounds],
        gate_c_findings: gateCFindings,
        usage,
      };
    }

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

    if (qcMode === "gated_each_round" || qcMode === "gated_each_step") {
      return {
        status: "paused",
        paused_checkpoint: "after_revision",
        paused_at_round: round,
        plan,
        rounds: [...rounds],
        usage,
      };
    }
  }

  throw new Error("unreachable: review-only loop always returns");
}
