import {
  AdapterError,
  type CompletionRequest,
  type LlmAdapter,
  type StructuredFailureDiagnostic,
  type StructuredResult,
} from "@norns/adapters";
import {
  FindingResponse,
  type FindingResponseT,
  type ReviewFindingT,
  ReviewFindings,
  type UsageEventT,
  type V2QcModeT,
  type V2QcPlanChangeT,
  type V2QcRevisionFormatT,
  V2QcTargetedRevision,
  type V2QcTargetedRevisionT,
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

const REVIEWER_MAX_OUTPUT_TOKENS = 5_000;
const TARGETED_REVISION_MAX_OUTPUT_TOKENS = 4_000;
const TARGETED_REVISION_REPAIR_MAX_OUTPUT_TOKENS = 3_000;

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
  /** Human resumes preserve the existing gate semantics. Operational resumes
   * replay the deterministic decision immediately after the provider step
   * named by checkpoint without calling that provider again. */
  kind?: "human" | "operational";
  fromRound: number;
  checkpoint: ReviewOnlyCheckpoint;
  plan: V2WorkPlanContractT;
  rounds: ReviewOnlyRound[];
  operationalReviewedPlan?: V2WorkPlanContractT;
  /** Provider usage already captured by an operational checkpoint. */
  usage?: UsageEventT[];
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

export interface ReviewOnlyDurableCheckpoint {
  completed_step: "review" | "revision";
  round: number;
  reviewed_plan: V2WorkPlanContractT;
  current_plan: V2WorkPlanContractT;
  completed_request_id: string;
  rounds: readonly ReviewOnlyRound[];
  usage: readonly UsageEventT[];
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
  /** Revision response format pinned when the durable review is created. */
  revisionFormat?: V2QcRevisionFormatT;
  /** Resume a previously paused run from persisted state instead of starting
   * at round 1. */
  resume?: ReviewOnlyResumeState;
  onProgress?: (rounds: readonly ReviewOnlyRound[]) => void | Promise<void>;
  onCheckpoint?: (checkpoint: ReviewOnlyDurableCheckpoint) => void | Promise<void>;
  onChatEvent?: (event: ReviewOnlyChatEvent) => void | Promise<void>;
  onStage?: (event: ReviewOnlyProgressEvent) => void | Promise<void>;
  /** Durable claim number used only to keep repeated post-restart provider
   * requests distinct in telemetry and transcript evidence. */
  executionAttempt?: number;
}

function gateCForRound(input: {
  rounds: readonly ReviewOnlyRound[];
  record: ReviewOnlyRound;
  reviewedPlan: V2WorkPlanContractT;
  revisedPlan: V2WorkPlanContractT;
  allowUnadjudicatedRebuttals: boolean;
  forcedAcceptModuleIds: readonly string[];
}): GateCFinding[] {
  const priorRebuttedShouldFixModuleIds = input.rounds.slice(0, -1).flatMap((prior) =>
    (prior.responses ?? []).flatMap((response) => {
      if (response.disposition !== "rebut") return [];
      const finding = prior.findings[response.finding_index];
      return finding && finding.severity === "should_fix" && finding.module_id !== null
        ? [finding.module_id]
        : [];
    }),
  );
  return detectGateC({
    findings: input.record.findings.map((finding, index) => ({
      id: String(index),
      index,
      severity: finding.severity,
      module_id: finding.module_id,
      finding: finding.finding,
      recommendation: finding.recommendation,
    })),
    dispositions: (input.record.responses ?? []).map((response) => ({
      finding_id: String(response.finding_index),
      finding_index: response.finding_index,
      disposition: response.disposition,
      rationale: response.rationale,
    })),
    planBefore: input.reviewedPlan,
    planAfter: input.revisedPlan,
    allowUnadjudicatedRebuttals: input.allowUnadjudicatedRebuttals,
    priorRebuttedShouldFixModuleIds,
    forcedAcceptModuleIds: [...input.forcedAcceptModuleIds],
  });
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
    "A module_id scopes a finding to both that module and its pinned staffing. Use null for plan-wide verification, budget, or open-decision findings.",
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

function targetedRevisionPrompt(
  plan: V2WorkPlanContractT,
  findings: readonly ReviewFindingT[],
): string {
  const list = findings
    .map(
      (finding, index) =>
        `${index}. [${finding.severity}] (${finding.module_id ?? "plan-level"}) ${finding.finding} — ${finding.recommendation}`,
    )
    .join("\n");
  return [
    "The independent reviewer returned the findings below.",
    list,
    `Return JSON { base_plan_content_hash: "${canonicalSha256(plan)}", responses: [{ finding_index, disposition: accept|rebut, rationale }], changes: [...] }.`,
    "Do not return the complete plan. Use only these operations: set_objective, set_assumptions, set_risks, set_out_of_scope, add_module, replace_module, remove_module, add_staffing, replace_staffing, remove_staffing, set_verification_requirements, set_open_decisions, set_estimated_budget.",
    "Every change requires finding_indices and may reference only findings you disposition as accept. Every must_fix requires an accept or rebut disposition. Rebutted findings must not have attributed changes.",
    "Use exact current module IDs. Module add/remove and staffing add/remove are separate explicit operations. replace_module requires module.id === module_id; replace_staffing requires staffing.module_id === module_id.",
    "The server applies these bounded operations, validates the complete strict Work Plan Contract, and writes the materialized plan to the durable Markdown artifact.",
    `CURRENT WORK PLAN CONTRACT ENVELOPE:\n${JSON.stringify(plan)}`,
  ].join("\n\n");
}

function targetedChangeTarget(change: V2QcPlanChangeT): string {
  switch (change.op) {
    case "set_objective":
    case "set_assumptions":
    case "set_risks":
    case "set_out_of_scope":
    case "set_verification_requirements":
    case "set_open_decisions":
    case "set_estimated_budget":
      return `field:${change.op}`;
    case "add_module":
      return `module:${change.module.id}`;
    case "replace_module":
    case "remove_module":
      return `module:${change.module_id}`;
    case "add_staffing":
      return `staffing:${change.staffing.module_id}`;
    case "replace_staffing":
    case "remove_staffing":
      return `staffing:${change.module_id}`;
  }
  throw new Error("unreachable targeted QC operation");
}

function targetedChangeModuleId(change: V2QcPlanChangeT): string | null {
  switch (change.op) {
    case "add_module":
      return change.module.id;
    case "replace_module":
    case "remove_module":
    case "replace_staffing":
    case "remove_staffing":
      return change.module_id;
    case "add_staffing":
      return change.staffing.module_id;
    default:
      return null;
  }
}

function targetedRevisionError(message: string): never {
  throw new PlanningError("plan_invalid", `targeted QC revision: ${message}`);
}

/** Pure materializer for the targeted QC response. The returned plan is a
 * fresh strict parse; the supplied base envelope is never mutated. */
export function applyTargetedQcRevision(
  baseCandidate: V2WorkPlanContractT,
  revisionCandidate: V2QcTargetedRevisionT,
  findings: readonly ReviewFindingT[],
): V2WorkPlanContractT {
  const base = V2WorkPlanContract.parse(baseCandidate);
  const revision = V2QcTargetedRevision.parse(revisionCandidate);
  const baseHash = canonicalSha256(base);
  if (revision.base_plan_content_hash !== baseHash) {
    targetedRevisionError(
      `base_plan_content_hash is stale (expected ${baseHash}, received ${revision.base_plan_content_hash})`,
    );
  }

  const responses = new Map<number, FindingResponseT>();
  for (const response of revision.responses) {
    if (response.finding_index >= findings.length) {
      targetedRevisionError(`response references unknown finding ${response.finding_index}`);
    }
    if (responses.has(response.finding_index)) {
      targetedRevisionError(`duplicate response for finding ${response.finding_index}`);
    }
    responses.set(response.finding_index, response);
  }
  const missingMustFix = findings.flatMap((finding, index) =>
    finding.severity === "must_fix" && !responses.has(index) ? [index] : [],
  );
  if (missingMustFix.length > 0) {
    targetedRevisionError(`missing must-fix responses for findings ${missingMustFix.join(", ")}`);
  }

  const targets = new Set<string>();
  for (const change of revision.changes) {
    const target = targetedChangeTarget(change);
    if (targets.has(target)) targetedRevisionError(`duplicate or conflicting target ${target}`);
    targets.add(target);
    const attributed = new Set<number>();
    for (const index of change.finding_indices) {
      if (attributed.has(index)) {
        targetedRevisionError(`${target} attributes finding ${index} more than once`);
      }
      attributed.add(index);
      const finding = findings[index];
      if (!finding) targetedRevisionError(`${target} references unknown finding ${index}`);
      if (responses.get(index)?.disposition !== "accept") {
        targetedRevisionError(`${target} may only attribute a finding dispositioned accept`);
      }
      const moduleId = targetedChangeModuleId(change);
      if (finding.module_id !== null && finding.module_id !== moduleId) {
        targetedRevisionError(
          `${target} cannot address module-scoped finding ${index} (${finding.module_id})`,
        );
      }
    }
  }

  const plan = V2WorkPlanContract.parse(base);
  const baseModuleIds = new Set(base.plan.modules.map((module) => module.id));
  const baseStaffingIds = new Set(base.staffing.map((staffing) => staffing.module_id));
  for (const change of revision.changes) {
    switch (change.op) {
      case "set_objective":
        plan.plan.objective = change.value;
        break;
      case "set_assumptions":
        plan.plan.assumptions = [...change.value];
        break;
      case "set_risks":
        plan.plan.risks = change.value.map((risk) => ({ ...risk }));
        break;
      case "set_out_of_scope":
        plan.plan.out_of_scope = [...change.value];
        break;
      case "add_module":
        if (baseModuleIds.has(change.module.id)) {
          targetedRevisionError(`module ${change.module.id} already exists`);
        }
        plan.plan.modules.push(change.module);
        break;
      case "replace_module": {
        if (change.module.id !== change.module_id) {
          targetedRevisionError(
            `replacement module id ${change.module.id} does not match ${change.module_id}`,
          );
        }
        const index = plan.plan.modules.findIndex((module) => module.id === change.module_id);
        if (!baseModuleIds.has(change.module_id) || index < 0) {
          targetedRevisionError(`module ${change.module_id} does not exist`);
        }
        plan.plan.modules[index] = change.module;
        break;
      }
      case "remove_module": {
        if (!baseModuleIds.has(change.module_id)) {
          targetedRevisionError(`module ${change.module_id} does not exist`);
        }
        plan.plan.modules = plan.plan.modules.filter((module) => module.id !== change.module_id);
        break;
      }
      case "add_staffing":
        if (baseStaffingIds.has(change.staffing.module_id)) {
          targetedRevisionError(`staffing for ${change.staffing.module_id} already exists`);
        }
        plan.staffing.push(change.staffing);
        break;
      case "replace_staffing": {
        if (change.staffing.module_id !== change.module_id) {
          targetedRevisionError(
            `replacement staffing id ${change.staffing.module_id} does not match ${change.module_id}`,
          );
        }
        const index = plan.staffing.findIndex(
          (staffing) => staffing.module_id === change.module_id,
        );
        if (!baseStaffingIds.has(change.module_id) || index < 0) {
          targetedRevisionError(`staffing for ${change.module_id} does not exist`);
        }
        plan.staffing[index] = change.staffing;
        break;
      }
      case "remove_staffing":
        if (!baseStaffingIds.has(change.module_id)) {
          targetedRevisionError(`staffing for ${change.module_id} does not exist`);
        }
        plan.staffing = plan.staffing.filter((staffing) => staffing.module_id !== change.module_id);
        break;
      case "set_verification_requirements":
        plan.verification_requirements = [...change.value];
        break;
      case "set_open_decisions":
        plan.open_decisions = [...change.value];
        break;
      case "set_estimated_budget":
        plan.estimated_budget = { ...change.value };
        break;
    }
  }
  const parsed = V2WorkPlanContract.safeParse(plan);
  if (!parsed.success) {
    targetedRevisionError(
      parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
    );
  }
  return parsed.data;
}

function targetedRevisionSchemaFor(
  base: V2WorkPlanContractT,
  findings: readonly ReviewFindingT[],
): z.ZodType<V2QcTargetedRevisionT> {
  return V2QcTargetedRevision.superRefine((revision, ctx) => {
    try {
      applyTargetedQcRevision(base, revision, findings);
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }) as z.ZodType<V2QcTargetedRevisionT>;
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

function targetedRevisionMarkdown(
  round: number,
  revision: V2QcTargetedRevisionT,
  materializedPlan: V2WorkPlanContractT,
): string {
  const responses = revision.responses.length
    ? revision.responses.flatMap((response) => [
        `### Finding ${response.finding_index + 1} · ${response.disposition}`,
        "",
        response.rationale,
        "",
      ])
    : ["No dispositions were required.", ""];
  return [
    `# Planning manager targeted revision · Round ${round}`,
    "",
    `**Base plan hash:** ${revision.base_plan_content_hash}`,
    "",
    `**Materialized plan hash:** ${canonicalSha256(materializedPlan)}`,
    "",
    "## Responses to reviewer",
    "",
    ...responses,
    "## Applied bounded changes",
    "",
    fencedJson(revision.changes),
    "",
    finalPlanMarkdown(materializedPlan, "Complete server-materialized revised plan"),
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
    `> This response was preserved but could not be applied automatically: ${structuredFailureSummary(error)}`,
    "",
    response,
  ].join("\n");
}

function structuredFailure(error: AdapterError): StructuredFailureDiagnostic | null {
  return error.metadata?.structured_failure ?? null;
}

function structuredFailureSummary(error: AdapterError): string {
  const diagnostic = structuredFailure(error);
  if (!diagnostic) {
    return error.kind === "invalid_response"
      ? "The response did not match the required structured-output contract."
      : `The provider request failed (${error.kind}).`;
  }
  const details = diagnostic.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
  return `${diagnostic.kind}${details ? ` — ${details}` : ""}`;
}

function safeChatError(error: unknown): string {
  if (error instanceof AdapterError) return structuredFailureSummary(error);
  return "The QC request failed unexpectedly. Inspect the server error record for details.";
}

function repairPrompt(
  error: AdapterError,
  instruction: string,
  originalPrompt: string | null,
): string {
  const previous = error.metadata?.response_text?.trim();
  if (!previous) throw new Error("repair prompt requires a preserved provider response");
  return [
    ...(originalPrompt ? [originalPrompt] : []),
    "Your previous QC response was preserved as a Markdown artifact, but it could not be applied automatically.",
    `Validation details: ${structuredFailureSummary(error)}`,
    "Correct the response below. Do not add prose or Markdown fences.",
    `PREVIOUS RESPONSE:\n${previous}`,
    instruction,
  ].join("\n\n");
}

function outputWasTruncated(error: AdapterError): boolean {
  if (structuredFailure(error)?.kind === "output_truncated") return true;
  return ["length", "max_output_tokens", "max_tokens"].includes(
    error.metadata?.finish_reason ?? "",
  );
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
    maxAttempts?: number;
    repairInstruction?: string;
    repairMaxTokens?: number;
    /** Targeted change envelopes can be repaired from their prior response;
     * legacy full envelopes still need the complete original plan prompt. */
    previousResponseOnlyRepair?: boolean;
  },
): Promise<StructuredResult<T> & { progress_attempt: number; progress_request_id: string }> {
  const maxAttempts = Math.min(chat.maxAttempts ?? 2, 2);
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
          ...(attempt > 0 && chat.repairMaxTokens !== undefined
            ? { maxTokens: chat.repairMaxTokens }
            : {}),
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
      return { ...result, progress_attempt: attempt + 1, progress_request_id: requestId };
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
          error_code: structuredFailure(error)?.kind ?? error.kind,
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
          content: safeChatError(error),
          error_code:
            error instanceof AdapterError
              ? (structuredFailure(error)?.kind ?? error.kind)
              : "unknown_error",
        });
      }
      if (
        !(error instanceof AdapterError) ||
        error.kind !== "invalid_response" ||
        attempt === maxAttempts - 1 ||
        outputWasTruncated(error) ||
        !error.metadata?.response_text?.trim()
      ) {
        throw error;
      }
      if (error.metadata?.usage) onFailedUsage(error.metadata.usage);
      prompt = repairPrompt(
        error,
        chat.repairInstruction ??
          "Return a fresh, complete JSON application envelope. Correct the validation failure, include every required field, and preserve the full plan. The server will save the readable result as a Markdown file.",
        chat.previousResponseOnlyRepair ? null : request.prompt,
      );
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
  const usage: UsageEventT[] = resume?.usage ? [...resume.usage] : [];
  const rounds: ReviewOnlyRound[] = resume ? [...resume.rounds] : [];
  const meter = {
    projectId: options.projectId,
    initiatedByUserId: options.initiatedByUserId,
  };
  const reviewerPrompt = reviewOnlySystem(reviewerSystem([]), options.frozenContext);
  const revisionSystem = reviewOnlySystem(pmSystem([]), options.frozenContext);
  const operationalResume = resume?.kind === "operational";

  // A revision checkpoint is written before deterministic Gate C/cap/cadence
  // evaluation. Re-run that pure decision logic after a restart, then either
  // stop or advance to the next reviewer without repeating the completed PM
  // call. Human resumes deliberately retain their pre-existing semantics.
  if (operationalResume && resume.checkpoint === "after_revision") {
    const record = rounds.find((candidate) => candidate.round === resume.fromRound);
    if (!record || record.responses === null) {
      throw new Error(
        `operational revision checkpoint expects a completed round ${resume.fromRound}`,
      );
    }
    const reviewedPlan = V2WorkPlanContract.parse(
      resume.operationalReviewedPlan ?? record.reviewed_plan,
    );
    const gateCFindings = gateCForRound({
      rounds,
      record,
      reviewedPlan,
      revisedPlan: plan,
      allowUnadjudicatedRebuttals,
      forcedAcceptModuleIds: [...forcedAcceptModuleIds],
    });
    if (gateCFindings.length > 0) {
      return {
        status: "paused",
        paused_checkpoint: "adjudication",
        paused_at_round: resume.fromRound,
        plan: reviewedPlan,
        rounds: [...rounds],
        gate_c_findings: gateCFindings,
        usage,
      };
    }
    if (resume.fromRound === options.maxRounds) {
      return {
        status: "cap_reached",
        rounds: resume.fromRound,
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
        paused_at_round: resume.fromRound,
        plan,
        rounds: [...rounds],
        usage,
      };
    }
  }

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
      if (operationalResume) {
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
    } else {
      reviewedPlan = plan;
      const reviewRequestId = `${options.telemetryGroupId}:review:${round}${
        options.executionAttempt === undefined ? "" : `:exec:${options.executionAttempt}`
      }`;
      const review = await completeStructuredWithRepair(
        options.reviewer,
        {
          system: reviewerPrompt,
          prompt: reviewOnlyPrompt(reviewedPlan),
          maxTokens: REVIEWER_MAX_OUTPUT_TOKENS,
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
      await options.onCheckpoint?.({
        completed_step: "review",
        round,
        reviewed_plan: reviewedPlan,
        current_plan: reviewedPlan,
        completed_request_id: review.progress_request_id,
        rounds,
        usage,
      });
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

    const revisionRequestId = `${options.telemetryGroupId}:revision:${round}${
      options.executionAttempt === undefined ? "" : `:exec:${options.executionAttempt}`
    }`;
    const revisionFormat = options.revisionFormat ?? "legacy_full";
    const runLegacyRevision = (requestId: string, maxAttempts = 2) =>
      completeStructuredWithRepair(
        options.pm,
        {
          system: revisionSystem,
          prompt: revisionPrompt(reviewedPlan, findings),
          ...meter,
          ...(options.signal ? { signal: options.signal } : {}),
        },
        ReviewOnlyRevision,
        "plan_revision",
        requestId,
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
          maxAttempts,
        },
      );

    let revisionResponses: FindingResponseT[];
    let revisedPlan: V2WorkPlanContractT;
    let revisionProgressAttempt: number;
    let revisionProgressRequestId: string;
    if (revisionFormat === "legacy_full") {
      const legacy = await runLegacyRevision(revisionRequestId);
      usage.push(legacy.usage);
      revisionResponses = [...legacy.value.responses];
      revisedPlan = V2WorkPlanContract.parse(legacy.value.plan);
      revisionProgressAttempt = legacy.progress_attempt;
      revisionProgressRequestId = legacy.progress_request_id;
    } else {
      try {
        const targeted = await completeStructuredWithRepair(
          options.pm,
          {
            system: revisionSystem,
            prompt: targetedRevisionPrompt(reviewedPlan, findings),
            maxTokens: TARGETED_REVISION_MAX_OUTPUT_TOKENS,
            ...meter,
            ...(options.signal ? { signal: options.signal } : {}),
          },
          targetedRevisionSchemaFor(reviewedPlan, findings),
          "targeted_plan_revision",
          revisionRequestId,
          (failedUsage) => usage.push(failedUsage),
          {
            channel: "pm",
            round,
            ...(options.onChatEvent ? { onEvent: options.onChatEvent } : {}),
            ...(options.onStage ? { onStage: options.onStage } : {}),
            markdown: (value) => {
              const materialized = applyTargetedQcRevision(reviewedPlan, value, findings);
              return targetedRevisionMarkdown(round, value, materialized);
            },
            repairInstruction:
              "Try once more. Return a fresh targeted JSON envelope with base_plan_content_hash, responses, and bounded changes only. Correct the validation failure and include every required field. Do not return the complete plan; the server materializes and validates it.",
            repairMaxTokens: TARGETED_REVISION_REPAIR_MAX_OUTPUT_TOKENS,
            previousResponseOnlyRepair: true,
          },
        );
        usage.push(targeted.usage);
        revisionResponses = [...targeted.value.responses];
        revisedPlan = applyTargetedQcRevision(reviewedPlan, targeted.value, findings);
        revisionProgressAttempt = targeted.progress_attempt;
        revisionProgressRequestId = targeted.progress_request_id;
      } catch (error) {
        if (
          revisionFormat !== "targeted_v1_with_fallback" ||
          !(error instanceof AdapterError) ||
          error.kind !== "invalid_response" ||
          outputWasTruncated(error)
        ) {
          throw error;
        }
        if (error.metadata?.usage) usage.push(error.metadata.usage);
        await options.onChatEvent?.({
          request_id: `${revisionRequestId}:legacy-fallback:transition`,
          channel: "pm",
          round,
          attempt: 3,
          speaker: "workflow",
          kind: "error",
          content: `The targeted QC revision failed validation after its repair attempt. Falling back once to the pinned legacy full-envelope format. ${structuredFailureSummary(error)}`,
          error_code: "targeted_revision_legacy_fallback",
        });
        const legacy = await runLegacyRevision(`${revisionRequestId}:legacy-fallback`, 1);
        usage.push(legacy.usage);
        revisionResponses = [...legacy.value.responses];
        revisedPlan = V2WorkPlanContract.parse(legacy.value.plan);
        revisionProgressAttempt = legacy.progress_attempt;
        revisionProgressRequestId = legacy.progress_request_id;
      }
    }
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
    for (const response of revisionResponses) {
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
    record.responses = [...revisionResponses];
    plan = revisedPlan;
    record.revised_plan_content_hash = canonicalSha256(plan);
    await options.onCheckpoint?.({
      completed_step: "revision",
      round,
      reviewed_plan: reviewedPlan,
      current_plan: plan,
      completed_request_id: revisionProgressRequestId,
      rounds,
      usage,
    });
    await options.onStage?.({
      stage: "saving",
      round,
      attempt: revisionProgressAttempt,
      provider: options.pm.provider,
      model: options.pm.model,
    });
    await options.onProgress?.(rounds);

    // Same-module dumb match against every earlier round's rebutted
    // should_fix findings (never the current round, already excluded by
    // slice(0, -1) since `record` is always the last entry by this point).
    const gateCFindings = gateCForRound({
      rounds,
      record,
      reviewedPlan,
      revisedPlan: plan,
      allowUnadjudicatedRebuttals,
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
