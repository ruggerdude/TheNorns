import { AdapterError, type ProviderName } from "@norns/adapters";
import {
  V2ConfirmConversationActionInput,
  type V2ConfirmConversationActionInputT,
  type V2ConfirmConversationPlanActionResponseT,
  V2ConversationAction,
  type V2ConversationActionT,
  V2ConversationHandoffPackage,
  type V2ConversationHandoffPackageT,
  V2ConversationPlanActionEffect,
  type V2ConversationPlanActionEffectT,
  V2ConversationPlanReview,
  type V2ConversationPlanReviewDispositionT,
  type V2ConversationPlanReviewFindingT,
  type V2ConversationPlanReviewT,
  type V2PlanHandoffPreferenceT,
  V2ProposeConversationActionInput,
  V2SavePlanCandidateParameters,
  V2SendPlanToQcParameters,
  V2WorkPlanContract,
  type V2WorkPlanContractT,
  V2WorkPlanVersion,
  type V2WorkPlanVersionDiff,
  type V2WorkPlanVersionT,
} from "@norns/contracts";
import { newId } from "../ids.js";
import { canonicalJson, canonicalSha256 } from "../persistence/migration/canonicalJson.js";
import type { V2SqlExecutor, V2TransactionRunner } from "../persistence/v2/database.js";
import type { ReviewOnlyPlanningResult, ReviewOnlyRound } from "../planning/reviewOnlySession.js";
import type {
  ApprovedPlanExecutionKickoff,
  ApprovedStaffingEntryDto,
  PlanningRunExecutionDto,
} from "../planning/runService.js";
import { planContentHash } from "../planning/session.js";

type PlanDiff = typeof V2WorkPlanVersionDiff._type;

export type ConversationPlanWorkflowErrorCode =
  | "forbidden"
  | "identity_not_found"
  | "identity_inactive"
  | "project_not_found"
  | "work_item_not_found"
  | "conversation_not_found"
  | "review_not_found"
  | "conversation_inactive"
  | "action_not_found"
  | "action_already_confirmed"
  | "idempotency_conflict"
  | "request_fingerprint_mismatch"
  | "unsupported_action"
  | "stale_plan_version"
  | "stale_plan_hash"
  | "plan_unchanged"
  | "plan_not_reviewed"
  | "qc_in_progress"
  | "proposal_in_progress"
  | "proposal_failed"
  | "invalid_plan_state";

export class ConversationPlanWorkflowError extends Error {
  constructor(
    readonly code: ConversationPlanWorkflowErrorCode,
    message: string,
    readonly httpStatus = code === "forbidden" ? 403 : code.includes("not_found") ? 404 : 409,
  ) {
    super(message);
    this.name = "ConversationPlanWorkflowError";
  }
}

export interface ConversationPlanReviewModels {
  pm: { provider: ProviderName; model: string };
  reviewer: { provider: ProviderName; model: string };
}

export interface ConversationPlanWorkflowOptions {
  newId?: (prefix: string) => string;
  now?: () => Date;
  resolveReviewModels(
    projectId: string,
    pm: { provider: ProviderName; model: string },
  ): Promise<ConversationPlanReviewModels>;
  runReviewNow(runId: string): Promise<unknown>;
  cancelReviewNow?(runId: string): boolean;
  executionKickoff?: ApprovedPlanExecutionKickoff;
  approvalTransitionCheckpoint?: (
    checkpoint:
      | "plan_frozen"
      | "planning_message_appended"
      | "summary_created"
      | "planning_archived"
      | "execution_conversation_created"
      | "handoff_created"
      | "task_packages_created"
      | "execution_seeded"
      | "kickoff_intent_created"
      | "effect_created",
  ) => void | Promise<void>;
  kickoffDispatchCheckpoint?: () => void | Promise<void>;
  /** Failure-injection/recovery seam after an external kickoff response but
   * before durable outbox settlement. Production leaves it unset. */
  kickoffSettlementCheckpoint?: () => void | Promise<void>;
}

export interface ConversationPlanDetail {
  plan_versions: V2WorkPlanVersionT[];
  actions: V2ConversationActionT[];
  plan_reviews: V2ConversationPlanReviewT[];
  action_effects: V2ConversationPlanActionEffectT[];
}

interface ActionRow {
  schema_version: 2;
  id: string;
  project_id: string;
  work_item_id: string;
  conversation_id: string;
  initiated_by_user_id: string;
  actor_type: V2ConversationActionT["actor"]["actor_type"];
  actor_id: string | null;
  source_message_id: string;
  action_type: V2ConversationActionT["action_type"];
  payload: unknown;
  payload_hash: string;
  status: V2ConversationActionT["status"];
  confirmed_by_user_id: string | null;
  confirmation_idempotency_key: string | null;
  confirmation_request_fingerprint: string | null;
  confirmed_at: Date | string | null;
  recorded_at: Date | string | null;
  sent_at: Date | string | null;
  acknowledged_at: Date | string | null;
  applied_at: Date | string | null;
  failure_code: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface PlanRow {
  schema_version: 2;
  id: string;
  project_id: string;
  work_item_id: string;
  conversation_id: string;
  created_by_user_id: string;
  version: number | string;
  status: V2WorkPlanVersionT["status"];
  plan: unknown;
  content_hash: string;
  created_by_action_id: string | null;
  supersedes_plan_version_id: string | null;
  diff_from_previous: unknown;
  approved_by_user_id: string | null;
  approved_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface ReviewRow {
  schema_version: 2;
  id: string;
  project_id: string;
  work_item_id: string;
  conversation_id: string;
  action_id: string;
  plan_version_id: string;
  planning_run_id: string;
  initiated_by_user_id: string;
  attempt_number: number | string;
  pm_provider: ProviderName;
  pm_model: string;
  reviewer_provider: ProviderName;
  reviewer_model: string;
  review_mode: "qc" | "waived";
  usage_request_group_id: string;
  status: V2ConversationPlanReviewT["status"];
  rounds_completed: number | string;
  max_rounds: number | string;
  round_exchanges: unknown;
  seed_plan: unknown;
  plan_content_hash: string;
  result_plan_content_hash: string;
  context_receipt: unknown;
  context_manifest: unknown;
  context_hash: string;
  findings: unknown;
  dispositions: unknown;
  revised_plan: unknown | null;
  revised_plan_content_hash: string | null;
  revised_plan_version_id: string | null;
  started_at: Date | string | null;
  completed_at: Date | string | null;
  failure_code: string | null;
  cancelled_by_user_id: string | null;
  cancellation_reason: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface EffectRow {
  schema_version: 2;
  id: string;
  project_id: string;
  work_item_id: string;
  conversation_id: string;
  action_id: string;
  effect_kind:
    | "plan_saved"
    | "qc_started"
    | "changes_requested"
    | "plan_approved"
    | "plan_rejected";
  plan_version_id: string;
  plan_review_id: string | null;
  planning_run_id: string | null;
  execution_status: "pending" | "started" | "refused" | "failed" | null;
  execution_started: boolean | null;
  execution_detail: string | null;
  execution_conversation_id: string | null;
  handoff_id: string | null;
  kickoff_intent_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface FollowUpActionProposal {
  action_type: "send_plan_to_qc" | "request_plan_changes" | "approve_plan" | "reject_plan";
  parameters: Record<string, unknown>;
}

const actionColumns = `schema_version, id, project_id, work_item_id, conversation_id,
  initiated_by_user_id, actor_type, actor_id, source_message_id, action_type,
  payload, payload_hash, status, confirmed_by_user_id, confirmation_idempotency_key,
  confirmation_request_fingerprint, confirmed_at, recorded_at, sent_at,
  acknowledged_at, applied_at, failure_code, created_at, updated_at`;
const planColumns = `schema_version, id, project_id, work_item_id, conversation_id,
  created_by_user_id, version, status, plan, content_hash, created_by_action_id,
  supersedes_plan_version_id, diff_from_previous, approved_by_user_id, approved_at,
  created_at, updated_at`;
const reviewColumns = `schema_version, id, project_id, work_item_id, conversation_id,
  action_id, plan_version_id, planning_run_id, initiated_by_user_id, attempt_number,
  pm_provider, pm_model, reviewer_provider, reviewer_model, review_mode, status, seed_plan,
  usage_request_group_id,
  plan_content_hash, result_plan_content_hash, context_receipt, context_manifest,
  context_hash, findings, dispositions, revised_plan, revised_plan_content_hash,
  revised_plan_version_id,
  (SELECT round FROM planning_runs WHERE id=planning_run_id) AS rounds_completed,
  (SELECT max_rounds FROM planning_runs WHERE id=planning_run_id) AS max_rounds,
  round_exchanges, started_at, completed_at,
  CASE
    WHEN failure_code='adaptererror' THEN coalesce((
      SELECT usage.error_code
        FROM ai_usage_events usage
       WHERE left(usage.request_id, length(usage_request_group_id) + 1)
             = usage_request_group_id || ':'
         AND usage.event_type='request_failed'
         AND usage.error_code IS NOT NULL
       ORDER BY usage.occurred_at DESC, usage.sequence DESC
       LIMIT 1
    ), failure_code)
    ELSE failure_code
  END AS failure_code,
  cancelled_by_user_id, cancellation_reason, created_at, updated_at`;
const effectColumns = `schema_version, id, project_id, work_item_id, conversation_id,
  action_id, effect_kind, plan_version_id, plan_review_id, planning_run_id,
  execution_status, execution_started, execution_detail,
  to_jsonb(conversation_plan_action_effects)->>'execution_conversation_id'
    AS execution_conversation_id,
  to_jsonb(conversation_plan_action_effects)->>'handoff_id' AS handoff_id,
  to_jsonb(conversation_plan_action_effects)->>'kickoff_intent_id' AS kickoff_intent_id,
  created_at, updated_at`;

function json<T>(value: unknown): T {
  return typeof value === "string" ? (JSON.parse(value) as T) : (value as T);
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function nullableIso(value: Date | string | null): string | null {
  return value === null ? null : iso(value);
}

function toAction(row: ActionRow): V2ConversationActionT {
  return V2ConversationAction.parse({
    schema_version: row.schema_version,
    id: row.id,
    project_id: row.project_id,
    work_item_id: row.work_item_id,
    conversation_id: row.conversation_id,
    initiated_by_user_id: row.initiated_by_user_id,
    actor: { actor_type: row.actor_type, actor_id: row.actor_id },
    source_message_id: row.source_message_id,
    action_type: row.action_type,
    payload: json(row.payload),
    payload_hash: row.payload_hash,
    status: row.status,
    confirmed_by_user_id: row.confirmed_by_user_id,
    confirmation_idempotency_key: row.confirmation_idempotency_key,
    confirmation_request_fingerprint: row.confirmation_request_fingerprint,
    confirmed_at: nullableIso(row.confirmed_at),
    recorded_at: nullableIso(row.recorded_at),
    sent_at: nullableIso(row.sent_at),
    acknowledged_at: nullableIso(row.acknowledged_at),
    applied_at: nullableIso(row.applied_at),
    failure_code: row.failure_code,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  });
}

function toPlan(row: PlanRow): V2WorkPlanVersionT {
  return V2WorkPlanVersion.parse({
    ...row,
    version: Number(row.version),
    plan: json(row.plan),
    diff_from_previous: row.diff_from_previous === null ? null : json(row.diff_from_previous),
    approved_at: nullableIso(row.approved_at),
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  });
}

function toReview(row: ReviewRow): V2ConversationPlanReviewT {
  const manifest = json<{ entries: unknown[] }>(row.context_manifest);
  return V2ConversationPlanReview.parse({
    schema_version: row.schema_version,
    id: row.id,
    project_id: row.project_id,
    work_item_id: row.work_item_id,
    conversation_id: row.conversation_id,
    action_id: row.action_id,
    plan_version_id: row.plan_version_id,
    planning_run_id: row.planning_run_id,
    initiated_by_user_id: row.initiated_by_user_id,
    attempt_number: Number(row.attempt_number),
    pm_provider: row.pm_provider,
    pm_model: row.pm_model,
    reviewer_provider: row.reviewer_provider,
    reviewer_model: row.reviewer_model,
    review_mode: row.review_mode,
    usage_request_group_id: row.usage_request_group_id,
    status: row.status,
    rounds_completed: Number(row.rounds_completed),
    max_rounds: Number(row.max_rounds),
    round_exchanges: json(row.round_exchanges),
    plan_content_hash: row.plan_content_hash,
    result_plan_content_hash: row.result_plan_content_hash,
    context_manifest: { entries: manifest.entries, context_hash: row.context_hash },
    findings: json(row.findings),
    dispositions: json(row.dispositions),
    revised_plan_version_id: row.revised_plan_version_id,
    started_at: nullableIso(row.started_at),
    completed_at: nullableIso(row.completed_at),
    failure_code: row.failure_code,
    cancelled_by_user_id: row.cancelled_by_user_id,
    cancellation_reason: row.cancellation_reason,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  });
}

function confirmationFingerprint(action: V2ConversationActionT): string {
  return canonicalSha256({
    action_id: action.id,
    action_type: action.action_type,
    payload_hash: action.payload_hash,
  });
}

function diffValues(previous: unknown, next: unknown, path = ""): PlanDiff {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  const walk = (left: unknown, right: unknown, at: string): void => {
    if (canonicalSha256(left) === canonicalSha256(right)) return;
    if (
      left !== null &&
      right !== null &&
      typeof left === "object" &&
      typeof right === "object" &&
      !Array.isArray(left) &&
      !Array.isArray(right)
    ) {
      const leftObject = left as Record<string, unknown>;
      const rightObject = right as Record<string, unknown>;
      const keys = [...new Set([...Object.keys(leftObject), ...Object.keys(rightObject)])].sort();
      for (const key of keys) {
        const child = at ? `${at}.${key}` : key;
        if (!(key in leftObject)) added.push(child);
        else if (!(key in rightObject)) removed.push(child);
        else walk(leftObject[key], rightObject[key], child);
      }
      return;
    }
    changed.push(at || "$");
  };
  walk(previous, next, path);
  return { added, removed, changed };
}

function errorCode(error: unknown): string {
  if (error instanceof AdapterError) return error.kind;
  const explicit =
    error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : null;
  const candidate =
    explicit ??
    (error instanceof Error
      ? error.name === "Error"
        ? error.message
        : error.name
      : String(error));
  return (
    candidate
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 120) || "review_failed"
  );
}

export class ConversationPlanWorkflowService {
  private readonly makeId: (prefix: string) => string;
  private readonly now: () => Date;

  constructor(
    private readonly transactions: V2TransactionRunner,
    private readonly options: ConversationPlanWorkflowOptions,
  ) {
    this.makeId = options.newId ?? newId;
    this.now = options.now ?? (() => new Date());
  }

  async detail(
    userId: string,
    projectId: string,
    workItemId: string,
    conversationId: string,
  ): Promise<ConversationPlanDetail> {
    return this.transactions.transaction(async (tx) => {
      await this.assertAccess(tx, projectId, userId);
      await this.assertConversation(tx, projectId, workItemId, conversationId, false, false, false);
      const plans = await tx.query<PlanRow>(
        `SELECT ${planColumns} FROM work_plan_versions
          WHERE project_id=$1 AND work_item_id=$2 AND conversation_id=$3
          ORDER BY version, id`,
        [projectId, workItemId, conversationId],
      );
      const actions = await tx.query<ActionRow>(
        `SELECT ${actionColumns} FROM conversation_actions
          WHERE project_id=$1 AND work_item_id=$2 AND conversation_id=$3
          ORDER BY created_at, id`,
        [projectId, workItemId, conversationId],
      );
      const reviews = await tx.query<ReviewRow>(
        `SELECT ${reviewColumns} FROM conversation_plan_reviews
          WHERE project_id=$1 AND work_item_id=$2 AND conversation_id=$3
          ORDER BY created_at, id`,
        [projectId, workItemId, conversationId],
      );
      const effects = await tx.query<EffectRow>(
        `SELECT ${effectColumns} FROM conversation_plan_action_effects
          WHERE project_id=$1 AND work_item_id=$2 AND conversation_id=$3
          ORDER BY created_at, id`,
        [projectId, workItemId, conversationId],
      );
      const planVersions = plans.rows.map(toPlan);
      const planById = new Map(planVersions.map((plan) => [plan.id, plan]));
      const planReviews = reviews.rows.map(toReview);
      const reviewById = new Map(planReviews.map((review) => [review.id, review]));
      return {
        plan_versions: planVersions,
        actions: actions.rows.map(toAction),
        plan_reviews: planReviews,
        action_effects: effects.rows.map((row) => this.toEffect(row, planById, reviewById)),
      };
    });
  }

  async confirm(
    userId: string,
    candidate: V2ConfirmConversationActionInputT,
  ): Promise<V2ConfirmConversationPlanActionResponseT> {
    const input = V2ConfirmConversationActionInput.parse(candidate);
    const preview = await this.transactions.transaction(async (tx) => {
      await this.assertAccess(tx, input.project_id, userId);
      return this.lockAction(tx, input, false);
    });
    let models: ConversationPlanReviewModels | null = null;
    if (preview.action_type === "send_plan_to_qc") {
      const parameters = V2SendPlanToQcParameters.parse(preview.payload.parameters);
      const conversation = await this.transactions.transaction((tx) =>
        this.assertConversation(
          tx,
          input.project_id,
          input.work_item_id,
          input.conversation_id,
          false,
        ),
      );
      if (parameters.review?.mode !== "skip_qc") {
        const pm = {
          provider: this.provider(conversation.provider),
          model: conversation.model,
        };
        models =
          parameters.review?.mode === "qc"
            ? { pm, reviewer: parameters.review.reviewer }
            : await this.options.resolveReviewModels(input.project_id, pm);
      }
    }

    const applied = await this.transactions.transaction((tx) =>
      this.confirmInTransaction(tx, userId, input, models),
    );
    if (applied.dispatchRunId) {
      void this.options.runReviewNow(applied.dispatchRunId).catch(() => undefined);
    }
    if (applied.kickoffIntentId) {
      await this.dispatchKickoffIntent(applied.kickoffIntentId);
    }
    return this.loadConfirmResponse(
      userId,
      input.project_id,
      input.work_item_id,
      input.conversation_id,
      input.action_id,
    );
  }

  async loadReviewOnlySeed(planningRunId: string): Promise<{
    reviewId: string;
    usageRequestGroupId: string;
    initiatedByUserId: string;
    seedPlan: V2WorkPlanContractT;
    frozenContext: unknown;
  }> {
    return this.transactions.transaction(async (tx) => {
      const row = (
        await tx.query<ReviewRow>(
          `SELECT ${reviewColumns} FROM conversation_plan_reviews
            WHERE planning_run_id=$1`,
          [planningRunId],
        )
      ).rows[0];
      if (!row) throw new Error(`review-only run "${planningRunId}" has no frozen seed`);
      return {
        reviewId: row.id,
        usageRequestGroupId: row.usage_request_group_id,
        initiatedByUserId: row.initiated_by_user_id,
        seedPlan: V2WorkPlanContract.parse(json(row.seed_plan)),
        frozenContext: json(row.context_receipt),
      };
    });
  }

  async markReviewOnlyStarted(reviewId: string): Promise<void> {
    await this.transactions.transaction(async (tx) => {
      const review = (
        await tx.query<ReviewRow>(
          `SELECT ${reviewColumns} FROM conversation_plan_reviews WHERE id=$1 FOR UPDATE`,
          [reviewId],
        )
      ).rows[0];
      if (!review) throw new Error(`unknown conversation plan review "${reviewId}"`);
      if (review.status === "running") return;
      if (review.status !== "queued") {
        throw new Error(`plan review "${reviewId}" cannot start from ${review.status}`);
      }
      await tx.query(
        `UPDATE conversation_plan_reviews
            SET status='running', started_at=$2, updated_at=$2
          WHERE id=$1 AND status='queued'`,
        [reviewId, this.now().toISOString()],
      );
      const action = await this.actionById(tx, review.action_id, true);
      if (action.status === "sent") await this.advanceAction(tx, action.id, "agent_acknowledged");
    });
  }

  async recordReviewOnlyProgress(input: {
    reviewId: string;
    planningRunId: string;
    rounds: readonly ReviewOnlyRound[];
  }): Promise<void> {
    await this.transactions.transaction(async (tx) => {
      const review = (
        await tx.query<ReviewRow>(
          `SELECT ${reviewColumns} FROM conversation_plan_reviews
            WHERE id=$1 AND planning_run_id=$2 FOR UPDATE`,
          [input.reviewId, input.planningRunId],
        )
      ).rows[0];
      if (!review || review.status !== "running") return;
      const exchanges = this.reviewRoundExchanges(review, input.rounds);
      const latest = input.rounds.at(-1);
      const round = latest?.round ?? 0;
      const transcript = exchanges.flatMap((exchange) => [
        {
          round: exchange.round,
          role: "reviewer",
          provider: exchange.reviewer.provider,
          model: exchange.reviewer.model,
          summary: `${exchange.reviewer.findings.length} finding(s) recorded.`,
          finding_counts: {
            must_fix: exchange.reviewer.findings.filter(
              (finding) => finding.severity === "must_fix",
            ).length,
            should_fix: exchange.reviewer.findings.filter(
              (finding) => finding.severity === "should_fix",
            ).length,
            suggestion: exchange.reviewer.findings.filter(
              (finding) => finding.severity === "suggestion",
            ).length,
          },
        },
        ...(exchange.pm
          ? [
              {
                round: exchange.round,
                role: "pm",
                provider: exchange.pm.provider,
                model: exchange.pm.model,
                summary: `${exchange.pm.dispositions.length} disposition(s) recorded and the plan revised.`,
                finding_counts: null,
              },
            ]
          : []),
      ]);
      const now = this.now().toISOString();
      await tx.query(
        `UPDATE planning_runs
            SET status=$2, round=$3, transcript=$4::jsonb, updated_at=$5
          WHERE id=$1 AND mode='review_only'
            AND status IN ('reviewing','revising')`,
        [
          input.planningRunId,
          latest?.responses ? "reviewing" : "revising",
          round,
          JSON.stringify(transcript),
          now,
        ],
      );
      await tx.query(
        `UPDATE conversation_plan_reviews
            SET round_exchanges=$2::jsonb, updated_at=$3
          WHERE id=$1 AND status='running'`,
        [input.reviewId, JSON.stringify(exchanges), now],
      );
    });
  }

  async cancelReview(
    userId: string,
    scope: { projectId: string; workItemId: string; conversationId: string },
    reviewId: string,
    reason: string,
  ): Promise<V2ConversationPlanReviewT> {
    const cancelled = await this.transactions.transaction(async (tx) => {
      await this.assertAccess(tx, scope.projectId, userId);
      await this.assertConversation(
        tx,
        scope.projectId,
        scope.workItemId,
        scope.conversationId,
        false,
      );
      const review = (
        await tx.query<ReviewRow>(
          `SELECT ${reviewColumns} FROM conversation_plan_reviews
            WHERE id=$1 AND project_id=$2 AND work_item_id=$3 AND conversation_id=$4
            FOR UPDATE`,
          [reviewId, scope.projectId, scope.workItemId, scope.conversationId],
        )
      ).rows[0];
      if (!review) {
        throw new ConversationPlanWorkflowError(
          "review_not_found",
          `plan review "${reviewId}" was not found`,
          404,
        );
      }
      if (review.status === "cancelled") return { review, changed: false };
      if (!["queued", "running"].includes(review.status)) {
        throw new ConversationPlanWorkflowError(
          "invalid_plan_state",
          `QC cannot be stopped after it is ${review.status}`,
        );
      }
      const now = this.now().toISOString();
      await tx.query(
        `UPDATE planning_runs
            SET status='cancelled', error=NULL, lease_token=NULL, leased_until=NULL, updated_at=$2
          WHERE id=$1 AND mode='review_only'
            AND status IN ('queued','drafting','reviewing','revising')`,
        [review.planning_run_id, now],
      );
      await tx.query(
        `UPDATE conversation_plan_reviews
            SET status='cancelled', completed_at=$2, cancelled_by_user_id=$3,
                cancellation_reason=$4, updated_at=$2
          WHERE id=$1 AND status IN ('queued','running')`,
        [review.id, now, userId, reason],
      );
      const action = await this.actionById(tx, review.action_id, true);
      if (["sent", "agent_acknowledged"].includes(action.status)) {
        await tx.query(
          `UPDATE conversation_actions
              SET status='failed', failure_code='qc_cancelled_by_human', updated_at=$2
            WHERE id=$1`,
          [action.id, now],
        );
      }
      await tx.query(
        `UPDATE work_plan_versions SET status='candidate', updated_at=$2
          WHERE id=$1 AND status='in_qc'`,
        [review.plan_version_id, now],
      );
      await tx.query(
        `UPDATE work_items
            SET status='planning', aggregate_version=aggregate_version+1, updated_at=$3
          WHERE project_id=$1 AND id=$2 AND status='in_qc'`,
        [review.project_id, review.work_item_id, now],
      );
      const plan = await this.planById(tx, review.plan_version_id, false);
      await this.appendVisibleMessage(
        tx,
        review,
        userId,
        `QC was stopped by the human operator: ${reason}`,
        plan.id,
        review.action_id,
        this.candidateFollowUps(plan),
      );
      const updated = (
        await tx.query<ReviewRow>(
          `SELECT ${reviewColumns} FROM conversation_plan_reviews WHERE id=$1`,
          [review.id],
        )
      ).rows[0];
      if (!updated) throw new Error("cancelled review could not be reloaded");
      return { review: updated, changed: true };
    });
    if (cancelled.changed) this.options.cancelReviewNow?.(cancelled.review.planning_run_id);
    return toReview(cancelled.review);
  }

  async completeReviewOnly(input: {
    reviewId: string;
    planningRunId: string;
    result: ReviewOnlyPlanningResult;
    totalCostUsd: number;
  }): Promise<void> {
    await this.transactions.transaction(async (tx) => {
      const review = (
        await tx.query<ReviewRow>(
          `SELECT ${reviewColumns} FROM conversation_plan_reviews
            WHERE id=$1 AND planning_run_id=$2 FOR UPDATE`,
          [input.reviewId, input.planningRunId],
        )
      ).rows[0];
      if (!review) throw new Error("review-only completion scope mismatch");
      if (["converged", "cap_reached", "cancelled"].includes(review.status)) return;
      if (review.status !== "running") {
        throw new Error(`review-only completion requires running, got ${review.status}`);
      }
      const seedVersion = await this.planById(tx, review.plan_version_id, true);
      const work = await this.lockWork(tx, review.project_id, review.work_item_id);
      await this.assertConversation(
        tx,
        review.project_id,
        review.work_item_id,
        review.conversation_id,
        true,
      );
      const flattened = this.flattenReviewEvidence(review.id, input.result);
      const finalPlan = V2WorkPlanContract.parse(input.result.final_plan);
      const finalHash = canonicalSha256(finalPlan);
      const changed = finalHash !== seedVersion.content_hash;
      const action = await this.actionById(tx, review.action_id, true);
      let revisedPlan: V2WorkPlanVersionT | null = null;
      if (changed) {
        await tx.query(
          `UPDATE work_plan_versions SET status='changes_requested', updated_at=$2
            WHERE id=$1 AND status='in_qc'`,
          [seedVersion.id, this.now().toISOString()],
        );
        revisedPlan = await this.insertPlanVersion(
          tx,
          review.project_id,
          review.work_item_id,
          review.conversation_id,
          review.initiated_by_user_id,
          review.action_id,
          finalPlan,
          seedVersion,
        );
        await tx.query(
          `UPDATE work_plan_versions SET status='superseded', updated_at=$2
            WHERE id=$1 AND status='changes_requested'`,
          [seedVersion.id, this.now().toISOString()],
        );
        await this.rejectSiblingProposals(tx, action, seedVersion.id);
      }
      const now = this.now().toISOString();
      const resultDto = {
        plan: finalPlan.plan,
        content_hash: planContentHash(finalPlan.plan),
        total_cost_usd: input.totalCostUsd,
        staffing_proposal: this.staffingProposal(finalPlan),
      };
      await tx.query(
        `UPDATE planning_runs
            SET status=$2, round=$3, result=$4::jsonb,
                total_cost_usd=total_cost_usd+$5, error=NULL,
                lease_token=NULL, leased_until=NULL, updated_at=$6
          WHERE id=$1 AND mode='review_only'`,
        [
          input.planningRunId,
          input.result.status,
          input.result.rounds,
          JSON.stringify(resultDto),
          input.totalCostUsd,
          now,
        ],
      );
      await tx.query(
        `UPDATE conversation_plan_reviews
            SET status=$2, findings=$3::jsonb, dispositions=$4::jsonb,
                result_plan_content_hash=$5,
                revised_plan=$6::jsonb,
                revised_plan_content_hash=$7,
                revised_plan_version_id=$8,
                round_exchanges=$9::jsonb,
                completed_at=$10, updated_at=$10
          WHERE id=$1 AND status='running'`,
        [
          review.id,
          input.result.status,
          JSON.stringify(flattened.findings),
          JSON.stringify(flattened.dispositions),
          finalHash,
          revisedPlan ? JSON.stringify(finalPlan) : null,
          revisedPlan?.content_hash ?? null,
          revisedPlan?.id ?? null,
          JSON.stringify(
            this.reviewRoundExchanges(review, input.result.review_rounds, input.result.final_plan),
          ),
          now,
        ],
      );
      if (action.status === "sent") await this.advanceAction(tx, action.id, "agent_acknowledged");
      const acknowledged = await this.actionById(tx, review.action_id, false);
      if (acknowledged.status === "agent_acknowledged") {
        await this.advanceAction(tx, action.id, "applied");
      }
      await tx.query(
        `UPDATE work_items
            SET status=$3, aggregate_version=aggregate_version+1, updated_at=$4
          WHERE project_id=$1 AND id=$2`,
        [work.project_id, work.id, "awaiting_approval", now],
      );
      await this.appendVisibleMessage(
        tx,
        review,
        review.initiated_by_user_id,
        revisedPlan
          ? `QC completed with a reviewed revision. Plan v${revisedPlan.version} is the exact immutable QC result and is ready for approval review.`
          : `QC ${input.result.status === "converged" ? "converged" : "reached its round cap"} on Plan v${seedVersion.version}. Findings and PM dispositions are available for approval review.`,
        revisedPlan?.id ?? seedVersion.id,
        review.action_id,
        this.reviewFollowUps(revisedPlan ?? seedVersion, review),
      );
    });
  }

  async failReviewOnly(planningRunId: string, error: unknown): Promise<void> {
    await this.transactions.transaction(async (tx) => {
      const review = (
        await tx.query<ReviewRow>(
          `SELECT ${reviewColumns} FROM conversation_plan_reviews
            WHERE planning_run_id=$1 FOR UPDATE`,
          [planningRunId],
        )
      ).rows[0];
      if (!review || ["converged", "cap_reached", "failed", "cancelled"].includes(review.status))
        return;
      const code = errorCode(error);
      const now = this.now().toISOString();
      await tx.query(
        `UPDATE planning_runs
            SET status='failed', error=$2, lease_token=NULL, leased_until=NULL, updated_at=$3
          WHERE id=$1 AND mode='review_only'
            AND status IN ('queued','drafting','reviewing','revising')`,
        [planningRunId, code, now],
      );
      await tx.query(
        `UPDATE conversation_plan_reviews
            SET status='failed', failure_code=$2, completed_at=$3, updated_at=$3
          WHERE id=$1 AND status IN ('queued','running')`,
        [review.id, code, now],
      );
      const action = await this.actionById(tx, review.action_id, true);
      if (["sent", "agent_acknowledged"].includes(action.status)) {
        await tx.query(
          `UPDATE conversation_actions
              SET status='failed', failure_code=$2, updated_at=$3
            WHERE id=$1`,
          [action.id, code, now],
        );
      }
      await tx.query(
        `UPDATE work_plan_versions SET status='candidate', updated_at=$2
          WHERE id=$1 AND status='in_qc'`,
        [review.plan_version_id, now],
      );
      await tx.query(
        `UPDATE work_items
            SET status='planning', aggregate_version=aggregate_version+1, updated_at=$3
          WHERE project_id=$1 AND id=$2 AND status='in_qc'`,
        [review.project_id, review.work_item_id, now],
      );
      await this.appendVisibleMessage(
        tx,
        review,
        review.initiated_by_user_id,
        "QC could not complete. The immutable plan candidate is unchanged and can be sent to QC again.",
        review.plan_version_id,
        review.action_id,
        [
          {
            action_type: "send_plan_to_qc",
            parameters: {
              plan_version_id: review.plan_version_id,
              content_hash: review.plan_content_hash,
            },
          },
          {
            action_type: "reject_plan",
            parameters: {
              plan_version_id: review.plan_version_id,
              content_hash: review.plan_content_hash,
              reason: null,
            },
          },
        ],
      );
    });
  }

  private async confirmInTransaction(
    tx: V2SqlExecutor,
    userId: string,
    input: V2ConfirmConversationActionInputT,
    models: ConversationPlanReviewModels | null,
  ): Promise<{
    dispatchRunId: string | null;
    kickoffIntentId: string | null;
  }> {
    await this.assertAccess(tx, input.project_id, userId);
    const action = await this.lockAction(tx, input, true);
    const expectedFingerprint = confirmationFingerprint(action);
    const keyOwner = (
      await tx.query<{ id: string }>(
        `SELECT id FROM conversation_actions
          WHERE conversation_id=$1 AND confirmed_by_user_id=$2
            AND confirmation_idempotency_key=$3`,
        [input.conversation_id, userId, input.idempotency_key],
      )
    ).rows[0];
    if (keyOwner && keyOwner.id !== action.id) {
      throw new ConversationPlanWorkflowError(
        "idempotency_conflict",
        `confirmation key "${input.idempotency_key}" was reused for a different action`,
      );
    }
    if (action.status === "proposed") {
      await tx.query(
        `UPDATE conversation_actions
            SET status='confirmed', confirmed_by_user_id=$2,
                confirmation_idempotency_key=$3,
                confirmation_request_fingerprint=$4,
                confirmed_at=$5, updated_at=$5
          WHERE id=$1 AND status='proposed'`,
        [action.id, userId, input.idempotency_key, expectedFingerprint, this.now().toISOString()],
      );
    } else {
      if (
        action.confirmed_by_user_id !== userId ||
        action.confirmation_idempotency_key !== input.idempotency_key
      ) {
        throw new ConversationPlanWorkflowError(
          "action_already_confirmed",
          `action "${action.id}" was confirmed by a different request`,
        );
      }
      if (action.confirmation_request_fingerprint !== expectedFingerprint) {
        throw new ConversationPlanWorkflowError(
          "request_fingerprint_mismatch",
          "stored confirmation fingerprint does not match the immutable proposal",
        );
      }
      const effect = await this.effectByAction(tx, action.id);
      if (effect) {
        return {
          dispatchRunId: null,
          kickoffIntentId:
            effect.effect_kind === "plan_approved" && effect.execution_status === "pending"
              ? effect.kickoff_intent_id
              : null,
        };
      }
    }

    await this.lockWork(tx, input.project_id, input.work_item_id);
    const conversation = await this.assertConversation(
      tx,
      input.project_id,
      input.work_item_id,
      input.conversation_id,
      true,
    );
    if (
      (
        await tx.query<{ id: string }>(
          `SELECT id FROM conversation_plan_proposal_attempts
            WHERE conversation_id=$1 AND status='pending' LIMIT 1`,
          [input.conversation_id],
        )
      ).rows[0]
    ) {
      throw new ConversationPlanWorkflowError(
        "proposal_in_progress",
        "wait for the active plan proposal before confirming an action",
      );
    }

    const confirmed = await this.actionById(tx, action.id, true);
    if (confirmed.status !== "confirmed") {
      throw new ConversationPlanWorkflowError(
        "action_already_confirmed",
        `action "${action.id}" cannot be resumed from ${confirmed.status} without its effect`,
      );
    }
    await this.advanceAction(tx, action.id, "recorded");
    const parsedProposal = V2ProposeConversationActionInput.parse({
      project_id: action.project_id,
      work_item_id: action.work_item_id,
      conversation_id: action.conversation_id,
      source_message_id: action.source_message_id,
      action_type: action.action_type,
      payload: action.payload,
    });
    const parameters = parsedProposal.payload.parameters as Record<string, unknown>;
    switch (action.action_type) {
      case "save_plan_candidate": {
        const saveParameters = V2SavePlanCandidateParameters.parse(parameters);
        const plan = saveParameters.plan;
        const prior = await this.latestPlan(tx, action.project_id, action.work_item_id, true);
        const priorId = saveParameters.predecessor_plan_version_id;
        const priorHash = saveParameters.predecessor_content_hash;
        if ((prior?.id ?? null) !== priorId) {
          throw new ConversationPlanWorkflowError(
            "stale_plan_version",
            "the plan candidate predecessor is no longer current",
          );
        }
        if ((prior?.content_hash ?? null) !== priorHash) {
          throw new ConversationPlanWorkflowError(
            "stale_plan_hash",
            "the plan candidate predecessor hash is stale",
          );
        }
        if (prior && prior.content_hash === canonicalSha256(plan)) {
          throw new ConversationPlanWorkflowError(
            "plan_unchanged",
            "the proposed Plan Contract is identical to the current version",
          );
        }
        if (prior && !["candidate", "changes_requested", "rejected"].includes(prior.status)) {
          throw new ConversationPlanWorkflowError(
            "invalid_plan_state",
            `current plan is ${prior.status} and cannot be superseded`,
          );
        }
        const version = await this.insertPlanVersion(
          tx,
          action.project_id,
          action.work_item_id,
          action.conversation_id,
          userId,
          action.id,
          plan,
          prior,
        );
        if (prior) {
          await tx.query(
            `UPDATE work_plan_versions SET status='superseded', updated_at=$2
              WHERE id=$1`,
            [prior.id, this.now().toISOString()],
          );
        }
        await this.rejectSiblingProposals(tx, action, prior?.id ?? null);
        await this.insertEffect(tx, action, "plan_saved", version.id, null, null, null);
        await this.finishLocalAction(tx, action.id);
        await this.appendVisibleMessage(
          tx,
          action,
          userId,
          `Saved immutable Plan v${version.version} (${version.content_hash.slice(0, 12)}…).`,
          version.id,
          action.id,
          this.candidateFollowUps(version, saveParameters.handoff),
        );
        break;
      }
      case "send_plan_to_qc": {
        const sendParameters = V2SendPlanToQcParameters.parse(parameters);
        const reviewPreference = sendParameters.review;
        const skipQc = reviewPreference?.mode === "skip_qc";
        if (
          !skipQc &&
          (!models ||
            models.pm.provider !== this.provider(conversation.provider) ||
            models.pm.model !== conversation.model ||
            models.pm.provider === models.reviewer.provider)
        ) {
          throw new ConversationPlanWorkflowError(
            "invalid_plan_state",
            "QC model pins do not match the immutable conversation PM and opposite-provider policy",
          );
        }
        const version = await this.boundLatestPlan(tx, action, sendParameters, "candidate");
        const active = (
          await tx.query<{ id: string }>(
            `SELECT id FROM conversation_plan_reviews
              WHERE plan_version_id=$1 AND status IN ('queued','running')`,
            [version.id],
          )
        ).rows[0];
        if (active) {
          throw new ConversationPlanWorkflowError(
            "qc_in_progress",
            "this exact plan version already has an active QC attempt",
          );
        }
        const runId = this.makeId("planning_run");
        const reviewId = this.makeId("plan_review");
        const attempt = Number(
          (
            await tx.query<{ attempt: number | string }>(
              `SELECT coalesce(max(attempt_number),0)+1 AS attempt
                FROM conversation_plan_reviews WHERE plan_version_id=$1`,
              [version.id],
            )
          ).rows[0]?.attempt ?? 1,
        );
        const context = await this.freezeQcContext(tx, action);
        const now = this.now().toISOString();
        if (skipQc) {
          const pm = {
            provider: this.provider(conversation.provider),
            model: conversation.model,
          };
          const reviewerProvider: ProviderName =
            pm.provider === "anthropic" ? "openai" : "anthropic";
          const waivedReviewerModel = "qc-waived-by-human";
          const result = {
            plan: version.plan.plan,
            content_hash: planContentHash(version.plan.plan),
            total_cost_usd: 0,
            staffing_proposal: this.staffingProposal(version.plan),
            qc_waived: true,
          };
          await tx.query(
            `INSERT INTO planning_runs (
               id, project_id, status, round, max_rounds, objective, transcript,
               result, total_cost_usd, error, created_at, updated_at, attachment_ids,
               worker_providers, mode, requested_by, initiated_by_user_id,
               pm_provider, pm_model, agent_provider, agent_model
             ) VALUES (
               $1,$2,'converged',0,1,$3,'[]'::jsonb,$4::jsonb,0,NULL,$5,$5,'[]'::jsonb,
               'both','review_only',$6,$6,$7,$8,$9,$10
             )`,
            [
              runId,
              action.project_id,
              version.plan.plan.objective,
              JSON.stringify(result),
              now,
              userId,
              pm.provider,
              pm.model,
              reviewerProvider,
              waivedReviewerModel,
            ],
          );
          await tx.query(
            `INSERT INTO conversation_plan_reviews (
               id, project_id, work_item_id, conversation_id, action_id,
               plan_version_id, planning_run_id, initiated_by_user_id, attempt_number,
               pm_provider, pm_model, reviewer_provider, reviewer_model, review_mode,
               usage_request_group_id, seed_plan, status,
               plan_content_hash, result_plan_content_hash, context_receipt,
               context_manifest, context_hash, started_at, completed_at
             ) VALUES (
               $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'waived',
               $14,$15::jsonb,'converged',$16,$16,$17::jsonb,$18::jsonb,$19,$20,$20
             )`,
            [
              reviewId,
              action.project_id,
              action.work_item_id,
              action.conversation_id,
              action.id,
              version.id,
              runId,
              userId,
              attempt,
              pm.provider,
              pm.model,
              reviewerProvider,
              waivedReviewerModel,
              reviewId,
              JSON.stringify(version.plan),
              version.content_hash,
              JSON.stringify(context.receipt),
              JSON.stringify(context.manifest),
              context.hash,
              now,
            ],
          );
          await tx.query(
            `UPDATE work_items
                SET status='awaiting_approval', planning_run_id=$3,
                    aggregate_version=aggregate_version+1, updated_at=$4
              WHERE project_id=$1 AND id=$2`,
            [action.project_id, action.work_item_id, runId, now],
          );
          await this.insertEffect(tx, action, "qc_started", version.id, reviewId, runId, null);
          await this.finishLocalAction(tx, action.id);
          await this.appendVisibleMessage(
            tx,
            action,
            userId,
            `QC was explicitly skipped for Plan v${version.version}. The selected execution staffing is preserved and the exact plan is ready to start.`,
            version.id,
            action.id,
            this.reviewFollowUps(version, reviewId),
          );
          return { dispatchRunId: null, kickoffIntentId: null };
        }
        if (!models) throw new Error("QC model pins were not resolved");
        const maxRounds =
          reviewPreference?.mode === "qc"
            ? reviewPreference.rounds
            : Number(
                (
                  await tx.query<{ default_max_rounds: number | string }>(
                    `SELECT default_max_rounds FROM planning_reviewer_settings
                      WHERE project_id=$1`,
                    [action.project_id],
                  )
                ).rows[0]?.default_max_rounds ?? 3,
              );
        await tx.query(
          `INSERT INTO planning_runs (
             id, project_id, status, round, max_rounds, objective, transcript,
             result, total_cost_usd, error, created_at, updated_at, attachment_ids,
             worker_providers, mode, requested_by, initiated_by_user_id,
             pm_provider, pm_model, agent_provider, agent_model
           ) VALUES (
             $1,$2,'queued',0,$3,$4,'[]'::jsonb,NULL,0,NULL,$5,$5,'[]'::jsonb,
             'both','review_only',$6,$6,$7,$8,$9,$10
           )`,
          [
            runId,
            action.project_id,
            maxRounds,
            version.plan.plan.objective,
            now,
            userId,
            models.pm.provider,
            models.pm.model,
            models.reviewer.provider,
            models.reviewer.model,
          ],
        );
        await tx.query(
          `INSERT INTO conversation_plan_reviews (
             id, project_id, work_item_id, conversation_id, action_id,
             plan_version_id, planning_run_id, initiated_by_user_id, attempt_number,
             pm_provider, pm_model, reviewer_provider, reviewer_model, review_mode,
             usage_request_group_id, seed_plan,
             plan_content_hash, result_plan_content_hash, context_receipt,
             context_manifest, context_hash
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'qc',$14,$15::jsonb,
             $16,$16,$17::jsonb,$18::jsonb,$19
           )`,
          [
            reviewId,
            action.project_id,
            action.work_item_id,
            action.conversation_id,
            action.id,
            version.id,
            runId,
            userId,
            attempt,
            models.pm.provider,
            models.pm.model,
            models.reviewer.provider,
            models.reviewer.model,
            reviewId,
            JSON.stringify(version.plan),
            version.content_hash,
            JSON.stringify(context.receipt),
            JSON.stringify(context.manifest),
            context.hash,
          ],
        );
        await tx.query(
          `UPDATE work_plan_versions SET status='in_qc', updated_at=$2
            WHERE id=$1 AND status='candidate'`,
          [version.id, now],
        );
        await tx.query(
          `UPDATE work_items
              SET status='in_qc', planning_run_id=$3,
                  aggregate_version=aggregate_version+1, updated_at=$4
            WHERE project_id=$1 AND id=$2`,
          [action.project_id, action.work_item_id, runId, now],
        );
        await this.insertEffect(tx, action, "qc_started", version.id, reviewId, runId, null);
        await this.advanceAction(tx, action.id, "sent");
        await this.appendVisibleMessage(
          tx,
          action,
          userId,
          `Sent Plan v${version.version} to ${models.reviewer.provider}:${models.reviewer.model} for isolated cross-provider QC.`,
          version.id,
          action.id,
        );
        return { dispatchRunId: runId, kickoffIntentId: null };
      }
      case "request_plan_changes": {
        const version = await this.boundLatestPlan(tx, action, parameters);
        if (!["candidate", "in_qc"].includes(version.status)) {
          throw new ConversationPlanWorkflowError(
            "invalid_plan_state",
            `plan ${version.id} cannot enter changes requested from ${version.status}`,
          );
        }
        const active = await this.activeReview(tx, version.id);
        if (active) {
          throw new ConversationPlanWorkflowError(
            "qc_in_progress",
            "wait for the active QC attempt before requesting changes",
          );
        }
        const changed = await tx.query<{ id: string }>(
          `UPDATE work_plan_versions SET status='changes_requested', updated_at=$2
            WHERE id=$1 AND status IN ('candidate','in_qc') RETURNING id`,
          [version.id, this.now().toISOString()],
        );
        if (changed.rows.length !== 1) {
          throw new ConversationPlanWorkflowError(
            "invalid_plan_state",
            "plan state changed before the request could be recorded",
          );
        }
        await this.rejectSiblingProposals(tx, action, version.id);
        await tx.query(
          `UPDATE work_items SET status='planning',
             aggregate_version=aggregate_version+1, updated_at=$3
            WHERE project_id=$1 AND id=$2`,
          [action.project_id, action.work_item_id, this.now().toISOString()],
        );
        await this.insertEffect(tx, action, "changes_requested", version.id, null, null, null);
        await this.finishLocalAction(tx, action.id);
        await this.appendVisibleMessage(
          tx,
          action,
          userId,
          `Changes requested for Plan v${version.version}: ${String(parameters.direction)}`,
          version.id,
          action.id,
        );
        break;
      }
      case "approve_plan": {
        const version = await this.boundLatestPlan(tx, action, parameters);
        const reviewId = String(parameters.plan_review_id);
        const review = await this.reviewById(tx, reviewId, true);
        const reviewedResultVersionId = review.revised_plan_version_id ?? review.plan_version_id;
        if (
          !["converged", "cap_reached"].includes(review.status) ||
          reviewedResultVersionId !== version.id ||
          review.result_plan_content_hash !== version.content_hash ||
          !["candidate", "in_qc"].includes(version.status)
        ) {
          throw new ConversationPlanWorkflowError(
            "plan_not_reviewed",
            "approval requires the exact successful QC result version and content hash",
          );
        }
        toReview(review);
        await this.rejectSiblingProposals(tx, action, version.id);
        const now = this.now().toISOString();
        await tx.query(
          `UPDATE work_plan_versions
              SET status='approved', approved_by_user_id=$2, approved_at=$3, updated_at=$3
            WHERE id=$1 AND status IN ('candidate','in_qc')`,
          [version.id, userId, now],
        );
        const staffing = this.approvedStaffing(version.plan);
        await tx.query(
          `UPDATE planning_runs
              SET status='approved',
                  decision=$3::jsonb, updated_at=$4
            WHERE id=$1 AND project_id=$2
              AND status IN ('converged','cap_reached')`,
          [
            review.planning_run_id,
            action.project_id,
            JSON.stringify({
              decision: "approve",
              direction: null,
              staffing,
              decided_at: now,
            }),
            now,
          ],
        );
        await tx.query(
          `UPDATE work_items
              SET status='awaiting_approval', approved_plan_version_id=$3,
                  planning_run_id=$4, aggregate_version=aggregate_version+1, updated_at=$5
            WHERE project_id=$1 AND id=$2`,
          [action.project_id, action.work_item_id, version.id, review.planning_run_id, now],
        );
        await this.checkpoint("plan_frozen");
        await this.appendVisibleMessage(
          tx,
          action,
          userId,
          `Approved Plan v${version.version}. Execution kickoff is pending.`,
          version.id,
          action.id,
        );
        await this.checkpoint("planning_message_appended");
        const transition = await this.createExecutionTransition(
          tx,
          action,
          version,
          review,
          conversation,
          userId,
          now,
        );
        await this.insertEffect(
          tx,
          action,
          "plan_approved",
          version.id,
          review.id,
          review.planning_run_id,
          "pending",
          transition,
        );
        await this.checkpoint("effect_created");
        await this.finishLocalAction(tx, action.id);
        return {
          dispatchRunId: null,
          kickoffIntentId: transition.kickoffIntentId,
        };
      }
      case "reject_plan": {
        const version = await this.boundLatestPlan(tx, action, parameters);
        if (!["candidate", "in_qc", "changes_requested"].includes(version.status)) {
          throw new ConversationPlanWorkflowError(
            "invalid_plan_state",
            `plan ${version.id} cannot be rejected from ${version.status}`,
          );
        }
        if (await this.activeReview(tx, version.id)) {
          throw new ConversationPlanWorkflowError(
            "qc_in_progress",
            "wait for the active QC attempt before rejecting this plan",
          );
        }
        await this.rejectSiblingProposals(tx, action, version.id);
        await tx.query(
          `UPDATE work_plan_versions SET status='rejected', updated_at=$2 WHERE id=$1`,
          [version.id, this.now().toISOString()],
        );
        await tx.query(
          `UPDATE work_items SET status='planning',
             aggregate_version=aggregate_version+1, updated_at=$3
            WHERE project_id=$1 AND id=$2`,
          [action.project_id, action.work_item_id, this.now().toISOString()],
        );
        await this.insertEffect(tx, action, "plan_rejected", version.id, null, null, null);
        await this.finishLocalAction(tx, action.id);
        await this.appendVisibleMessage(
          tx,
          action,
          userId,
          `Rejected Plan v${version.version}${parameters.reason ? `: ${String(parameters.reason)}` : "."}`,
          version.id,
          action.id,
        );
        break;
      }
      default:
        throw new ConversationPlanWorkflowError(
          "unsupported_action",
          `action type "${action.action_type}" is not a Phase 3 plan action`,
        );
    }
    return { dispatchRunId: null, kickoffIntentId: null };
  }

  private async loadConfirmResponse(
    userId: string,
    projectId: string,
    workItemId: string,
    conversationId: string,
    actionId: string,
  ): Promise<V2ConfirmConversationPlanActionResponseT> {
    const detail = await this.detail(userId, projectId, workItemId, conversationId);
    const action = detail.actions.find((candidate) => candidate.id === actionId);
    const effect = detail.action_effects.find((candidate) => candidate.action_id === actionId);
    if (!action || !effect) throw new Error("confirmed plan action has no durable effect");
    return { action, effect: effect.effect };
  }

  private checkpoint(
    checkpoint: Parameters<
      NonNullable<ConversationPlanWorkflowOptions["approvalTransitionCheckpoint"]>
    >[0],
  ): Promise<void> {
    return Promise.resolve(this.options.approvalTransitionCheckpoint?.(checkpoint));
  }

  private async createExecutionTransition(
    tx: V2SqlExecutor,
    action: V2ConversationActionT,
    version: V2WorkPlanVersionT,
    review: ReviewRow,
    pin: { provider: string; model: string },
    userId: string,
    now: string,
  ): Promise<{
    executionConversationId: string;
    handoffId: string;
    kickoffIntentId: string;
  }> {
    const executionConversationId = this.makeId("conversation");
    const handoffId = this.makeId("handoff");
    const kickoffIntentId = this.makeId("kickoff_intent");
    const summaryId = this.makeId("conversation_summary");
    const receiptId = this.makeId("compaction_receipt");

    const globalRule = (
      await tx.query<{ content: string; version: number }>(
        "SELECT content, version FROM global_rule_settings WHERE id='global'",
      )
    ).rows[0];
    const projectRules = await tx.query<{
      id: string;
      content: string;
    }>(
      `SELECT id, content
         FROM project_memory_entries
        WHERE project_id=$1 AND phase_id IS NULL AND task_id IS NULL
          AND category='directive' AND status='active'
          AND source_ref->>'kind'='project_rules_file'
        ORDER BY version DESC, created_at DESC, id DESC LIMIT 1`,
      [action.project_id],
    );
    const decisions = await tx.query<{
      id: string;
      title: string;
      rationale: string;
    }>(
      `SELECT id, title, rationale
         FROM decision_records
        WHERE project_id=$1 AND status='active'
        ORDER BY created_at, id`,
      [action.project_id],
    );
    const openDecisionPoints = await tx.query<{
      id: string;
      question: string;
      context: string;
    }>(
      `SELECT id, question, context
         FROM decision_points
        WHERE project_id=$1 AND status='open'
        ORDER BY created_at, id`,
      [action.project_id],
    );
    const repositories = await tx.query<{
      id: string;
      binding_type: string;
      repository_id: string;
      observed_head: string | null;
    }>(
      `SELECT id, binding_type, repository_id, observed_head
         FROM repository_bindings
        WHERE project_id=$1 AND status IN ('connected','degraded')
        ORDER BY id`,
      [action.project_id],
    );
    const reviewContract = toReview(review);
    const reviewEntries = reviewContract.context_manifest.entries;
    const candidateArtifactReferences = reviewEntries
      .filter((reference) => reference.kind === "artifact")
      .map((reference) => ({ id: reference.ref, content_hash: reference.content_hash }));
    const candidateArtifactIds = candidateArtifactReferences.map((reference) => reference.id);
    const persistedArtifacts =
      candidateArtifactIds.length === 0
        ? { rows: [] }
        : await tx.query<{
            id: string;
            kind: string;
            content_hash: string;
            phase_id: string | null;
            task_id: string | null;
          }>(
            `SELECT id, kind, content_hash, phase_id, task_id
               FROM artifacts
              WHERE project_id=$1 AND id=ANY($2::text[])
              ORDER BY id`,
            [action.project_id, candidateArtifactIds],
          );
    const persistedAttachments =
      candidateArtifactIds.length === 0
        ? { rows: [] }
        : await tx.query<{
            id: string;
            kind: string;
            content_hash: string;
            phase_id: null;
            task_id: null;
          }>(
            `SELECT id, 'image_attachment' AS kind, sha256 AS content_hash,
                    NULL AS phase_id, NULL AS task_id
               FROM attachments
              WHERE project_id=$1 AND id=ANY($2::text[]) AND deleted_at IS NULL
              ORDER BY id`,
            [action.project_id, candidateArtifactIds],
          );
    const exactArtifactById = new Map(
      [...persistedArtifacts.rows, ...persistedAttachments.rows].map((artifact) => [
        artifact.id,
        artifact,
      ]),
    );
    const artifactRows = {
      rows: candidateArtifactReferences.map((reference) => {
        const artifact = exactArtifactById.get(reference.id);
        if (!artifact || artifact.content_hash !== reference.content_hash) {
          throw new ConversationPlanWorkflowError(
            "plan_not_reviewed",
            `reviewed artifact ${reference.id} is unavailable or its content hash changed`,
          );
        }
        return artifact;
      }),
    };
    const approvedPlanningMockupArtifacts = await tx.query<{
      id: string;
      content_hash: string;
      kind: string;
    }>(
      `SELECT artifact.id,artifact.content_hash,artifact.kind
         FROM conversation_mockup_versions mockup
         JOIN conversation_mockup_requests root_request
           ON root_request.id=mockup.root_request_id
         JOIN conversation_actions root_action ON root_action.id=root_request.action_id
         JOIN conversation_mockup_decisions decision
           ON decision.mockup_version_id=mockup.id AND decision.decision='approved'
         JOIN LATERAL (
           SELECT mockup.manifest_artifact_id AS artifact_id
           UNION ALL
           SELECT screenshot.artifact_id
             FROM conversation_mockup_version_artifacts screenshot
            WHERE screenshot.mockup_version_id=mockup.id
         ) exact_artifact ON true
         JOIN artifacts artifact ON artifact.id=exact_artifact.artifact_id
        WHERE mockup.project_id=$1 AND mockup.work_item_id=$2
          AND mockup.conversation_id=$3
          AND root_action.payload->'parameters'->>'plan_version_id'=$4
          AND EXISTS (
            SELECT 1
              FROM jsonb_array_elements($5::jsonb->'plan'->'modules') module
             WHERE module->>'id'=root_action.payload->'parameters'->>'module_id'
          )
        ORDER BY mockup.id,artifact.id`,
      [
        action.project_id,
        action.work_item_id,
        action.conversation_id,
        version.id,
        JSON.stringify(version.plan),
      ],
    );
    const handoffArtifacts = [...artifactRows.rows, ...approvedPlanningMockupArtifacts.rows].filter(
      (artifact, index, all) =>
        all.findIndex((candidate) => candidate.id === artifact.id) === index,
    );
    const bindingRules = [
      ...(globalRule?.content.trim() ? [globalRule.content] : []),
      ...projectRules.rows.map((rule) => rule.content).filter((content) => content.trim()),
    ];
    const dispositionByFinding = new Map(
      reviewContract.dispositions.map((disposition) => [disposition.finding_id, disposition]),
    );
    const qcEvidence = reviewContract.findings.map((finding) => {
      const disposition = dispositionByFinding.get(finding.id);
      return {
        id: finding.id,
        summary: `${finding.finding} Recommendation: ${finding.recommendation}`,
        rationale: disposition
          ? `${disposition.disposition}: ${disposition.rationale}`
          : "No explicit disposition was recorded.",
      };
    });
    const unresolved = [
      ...version.plan.plan.risks.map((risk) =>
        risk.mitigation ? `${risk.description} Mitigation: ${risk.mitigation}` : risk.description,
      ),
      ...version.plan.open_decisions,
      ...version.plan.plan.modules.flatMap((module) => module.open_decisions),
      ...openDecisionPoints.rows.map((decision) => `${decision.question} — ${decision.context}`),
    ];
    const contextManifest: V2ConversationHandoffPackageT["context_manifest"] = [
      {
        kind: "approved_plan",
        ref: version.id,
        content_hash: version.content_hash,
      },
      ...(globalRule?.content.trim()
        ? [
            {
              kind: "global_rules" as const,
              ref: `global-rules-v${globalRule.version}`,
              content_hash: canonicalSha256(globalRule.content),
            },
          ]
        : []),
      ...projectRules.rows.map((rule) => ({
        kind: "project_rules" as const,
        ref: rule.id,
        content_hash: canonicalSha256(rule.content),
      })),
      ...decisions.rows.map((decision) => ({
        kind: "decision" as const,
        ref: decision.id,
        content_hash: canonicalSha256(decision),
      })),
      {
        kind: "qc_review",
        ref: review.id,
        content_hash: canonicalSha256({
          plan_content_hash: review.result_plan_content_hash,
          findings: reviewContract.findings,
          dispositions: reviewContract.dispositions,
        }),
      },
      ...handoffArtifacts.map((artifact) => ({
        kind: "artifact" as const,
        ref: artifact.id,
        content_hash: artifact.content_hash,
      })),
      ...repositories.rows.map((repository) => ({
        kind: "repository" as const,
        ref: repository.id,
        content_hash: canonicalSha256(repository),
      })),
    ];
    const handoffPackage = V2ConversationHandoffPackage.parse({
      approved_plan_version_id: version.id,
      approved_plan_content_hash: version.content_hash,
      approved_plan: version.plan,
      objective: version.plan.plan.objective,
      binding_rules: bindingRules,
      human_decisions: decisions.rows.map((decision) => ({
        id: decision.id,
        summary: decision.title,
        rationale: decision.rationale,
      })),
      qc_findings_and_dispositions: qcEvidence,
      unresolved_risks_and_questions: [...new Set(unresolved)],
      task_sequence: version.plan.plan.modules.map((module) => module.id),
      staffing: version.plan.staffing,
      budget: version.plan.estimated_budget,
      required_mockup_artifact_ids: handoffArtifacts
        .filter((artifact) => artifact.kind === "mockup")
        .map((artifact) => artifact.id),
      acceptance_evidence: [
        ...version.plan.verification_requirements,
        ...version.plan.plan.modules.flatMap((module) =>
          module.acceptance.map(
            (criterion) =>
              `${module.id}/${criterion.id}: ${criterion.statement} (${criterion.verification_type}: ${criterion.verification})`,
          ),
        ),
      ],
      artifact_ids: handoffArtifacts.map((artifact) => artifact.id),
      phase_ids: [
        ...new Set(
          artifactRows.rows.flatMap((artifact) =>
            artifact.phase_id === null ? [] : [artifact.phase_id],
          ),
        ),
      ],
      task_ids: [
        ...new Set(
          artifactRows.rows.flatMap((artifact) =>
            artifact.task_id === null ? [] : [artifact.task_id],
          ),
        ),
      ],
      repository_binding_ids: repositories.rows.map((repository) => repository.id),
      context_manifest: contextManifest,
    });

    const sourceMessages = await tx.query<{
      id: string;
      sequence: number | string;
      role: string;
      parts: unknown;
    }>(
      `SELECT id, sequence, role, parts
         FROM work_messages
        WHERE project_id=$1 AND work_item_id=$2 AND conversation_id=$3
          AND visibility_status='complete'
        ORDER BY sequence, id`,
      [action.project_id, action.work_item_id, action.conversation_id],
    );
    if (sourceMessages.rows.length > 0) {
      const firstSourceMessage = sourceMessages.rows[0];
      const lastSourceMessage = sourceMessages.rows.at(-1);
      if (!firstSourceMessage || !lastSourceMessage) {
        throw new Error("conversation summary source range disappeared");
      }
      const sourceMessageIds = sourceMessages.rows.map((message) => message.id);
      const canonicalSourceMessages = sourceMessages.rows.map((message) =>
        canonicalJson({
          sequence: Number(message.sequence),
          role: message.role,
          parts: json(message.parts),
        }),
      );
      const sourceMessageHashes = canonicalSourceMessages.map((message) =>
        canonicalSha256(JSON.parse(message)),
      );
      const summary = {
        objective: version.plan.plan.objective,
        constraints: bindingRules,
        decisions: decisions.rows.map((decision) => ({
          id: decision.id,
          summary: decision.title,
          rationale: decision.rationale,
        })),
        risks: version.plan.plan.risks.map((risk) => risk.description),
        open_questions: [...version.plan.open_decisions],
        artifact_ids: handoffArtifacts.map((artifact) => artifact.id),
      };
      const nextSummaryVersion = Number(
        (
          await tx.query<{ version: number | string }>(
            `SELECT coalesce(max(version),0)+1 AS version
                 FROM conversation_summaries
                WHERE conversation_id=$1`,
            [action.conversation_id],
          )
        ).rows[0]?.version ?? 1,
      );
      await tx.query(
        `INSERT INTO conversation_summaries (
           id, project_id, work_item_id, conversation_id, created_by_user_id,
           version, from_message_sequence, through_message_sequence,
           summary, content_hash, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)`,
        [
          summaryId,
          action.project_id,
          action.work_item_id,
          action.conversation_id,
          userId,
          nextSummaryVersion,
          Number(firstSourceMessage.sequence),
          Number(lastSourceMessage.sequence),
          JSON.stringify(summary),
          canonicalSha256(summary),
          now,
        ],
      );
      await tx.query(
        `INSERT INTO conversation_compaction_receipts (
           id, project_id, work_item_id, conversation_id, summary_id, milestone,
           source_message_ids, source_message_hashes, canonical_source_messages,
           canonical_summary, created_at
         ) VALUES ($1,$2,$3,$4,$5,'plan_approved',$6::jsonb,$7::jsonb,$8::jsonb,$9,$10)`,
        [
          receiptId,
          action.project_id,
          action.work_item_id,
          action.conversation_id,
          summaryId,
          JSON.stringify(sourceMessageIds),
          JSON.stringify(sourceMessageHashes),
          JSON.stringify(canonicalSourceMessages),
          canonicalJson(summary),
          now,
        ],
      );
    }
    await this.checkpoint("summary_created");
    await tx.query(
      `UPDATE work_conversations
          SET status='archived', archived_at=$2, updated_at=$2
        WHERE id=$1 AND status='active' AND kind='planning'`,
      [action.conversation_id, now],
    );
    await this.checkpoint("planning_archived");
    await tx.query(
      `INSERT INTO work_conversations (
         id, project_id, work_item_id, created_by_user_id, kind, status,
         provider, model, next_message_sequence, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,'execution_pm','active',$5,$6,1,$7,$7)`,
      [
        executionConversationId,
        action.project_id,
        action.work_item_id,
        userId,
        pin.provider,
        pin.model,
        now,
      ],
    );
    await this.checkpoint("execution_conversation_created");
    const canonicalPackage = canonicalJson(handoffPackage);
    await tx.query(
      `INSERT INTO conversation_handoffs (
         id, project_id, work_item_id, source_conversation_id,
         target_conversation_id, approved_plan_version_id, created_by_user_id,
         kind, package, canonical_package, content_hash, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,'planning_to_execution',$8::jsonb,$9,$10,$11)`,
      [
        handoffId,
        action.project_id,
        action.work_item_id,
        action.conversation_id,
        executionConversationId,
        version.id,
        userId,
        canonicalPackage,
        canonicalPackage,
        canonicalSha256(handoffPackage),
        now,
      ],
    );
    await this.checkpoint("handoff_created");
    for (const module of version.plan.plan.modules) {
      const staffing = version.plan.staffing.find((entry) => entry.module_id === module.id);
      if (!staffing) throw new Error(`approved module "${module.id}" has no staffing`);
      const taskPackage = {
        approved_plan_version_id: version.id,
        approved_plan_content_hash: version.content_hash,
        objective: version.plan.plan.objective,
        module,
        staffing,
        budget: version.plan.estimated_budget,
        binding_rules: bindingRules,
        human_decisions: handoffPackage.human_decisions,
        artifact_ids: handoffArtifacts.map((artifact) => artifact.id),
        repository_binding_ids: repositories.rows.map((repository) => repository.id),
        context_manifest: handoffPackage.context_manifest,
      };
      const canonicalTaskPackage = canonicalJson(taskPackage);
      await tx.query(
        `INSERT INTO conversation_task_packages (
           id, project_id, work_item_id, conversation_id, handoff_id,
           approved_plan_version_id, module_id, package, canonical_package,
           content_hash, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11)`,
        [
          this.makeId("task_package"),
          action.project_id,
          action.work_item_id,
          executionConversationId,
          handoffId,
          version.id,
          module.id,
          canonicalTaskPackage,
          canonicalTaskPackage,
          canonicalSha256(taskPackage),
          now,
        ],
      );
    }
    await this.checkpoint("task_packages_created");
    const seedMessageId = this.makeId("message");
    await tx.query(
      `INSERT INTO work_messages (
         id, project_id, work_item_id, conversation_id, initiated_by_user_id,
         actor_type, actor_id, role, visibility_status, sequence, parts, created_at
       ) VALUES ($1,$2,$3,$4,$5,'system',NULL,'system','complete',1,$6::jsonb,$7)`,
      [
        seedMessageId,
        action.project_id,
        action.work_item_id,
        executionConversationId,
        userId,
        JSON.stringify([
          {
            type: "text",
            format: "markdown",
            text: "Execution is ready from the approved compact handoff. The planning transcript has not been replayed.",
          },
          { type: "handoff", handoff_id: handoffId },
        ]),
        now,
      ],
    );
    await tx.query("UPDATE work_conversations SET next_message_sequence=2 WHERE id=$1", [
      executionConversationId,
    ]);
    await this.checkpoint("execution_seeded");
    await tx.query(
      `INSERT INTO conversation_kickoff_intents (
         id, project_id, work_item_id, source_conversation_id,
         execution_conversation_id, action_id, approved_plan_version_id,
         plan_review_id, planning_run_id, handoff_id, decided_by_user_id,
         status, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending',$12,$12)`,
      [
        kickoffIntentId,
        action.project_id,
        action.work_item_id,
        action.conversation_id,
        executionConversationId,
        action.id,
        version.id,
        review.id,
        review.planning_run_id,
        handoffId,
        userId,
        now,
      ],
    );
    await this.checkpoint("kickoff_intent_created");
    return { executionConversationId, handoffId, kickoffIntentId };
  }

  async reconcileKickoffIntents(): Promise<number> {
    const ids = await this.transactions.transaction(async (tx) => {
      await tx.query(
        `UPDATE conversation_kickoff_intents
            SET status='pending', lease_token=NULL, lease_expires_at=NULL, updated_at=now()
          WHERE status='leased' AND lease_expires_at<=now()`,
      );
      return (
        await tx.query<{ id: string }>(
          `SELECT id FROM conversation_kickoff_intents
            WHERE status='pending' ORDER BY created_at, id LIMIT 100`,
        )
      ).rows.map((row) => row.id);
    });
    for (const id of ids) await this.dispatchKickoffIntent(id);
    return ids.length;
  }

  private async dispatchKickoffIntent(intentId: string): Promise<void> {
    await this.options.kickoffDispatchCheckpoint?.();
    const claimed = await this.transactions.transaction(async (tx) => {
      const leaseToken = this.makeId("kickoff_lease");
      const row = (
        await tx.query<{
          id: string;
          project_id: string;
          planning_run_id: string;
          action_id: string;
          handoff_id: string;
          decided_by_user_id: string;
          approved_plan_version_id: string;
        }>(
          `UPDATE conversation_kickoff_intents
              SET status='leased', lease_token=$2,
                  lease_expires_at=now()+interval '5 minutes',
                  attempt_count=attempt_count+1, updated_at=now()
            WHERE id=$1 AND status='pending'
            RETURNING id, project_id, planning_run_id, action_id,
                      handoff_id, decided_by_user_id, approved_plan_version_id`,
          [intentId, leaseToken],
        )
      ).rows[0];
      if (!row) return null;
      const plan = await this.planById(tx, row.approved_plan_version_id, false);
      return { ...row, leaseToken, staffing: this.approvedStaffing(plan.plan) };
    });
    if (!claimed) return;
    if (!this.options.executionKickoff) {
      await this.settleKickoffIntent(claimed.id, claimed.leaseToken, {
        started: false,
        detail: "Execution kickoff is not configured.",
      });
      return;
    }
    let report: PlanningRunExecutionDto;
    try {
      report = await this.options.executionKickoff.kickoff({
        projectId: claimed.project_id,
        planningRunId: claimed.planning_run_id,
        handoffId: claimed.handoff_id,
        staffing: claimed.staffing,
        decidedBy: claimed.decided_by_user_id,
      });
    } catch (error) {
      await this.settleKickoffIntent(
        claimed.id,
        claimed.leaseToken,
        { started: false, detail: error instanceof Error ? error.message : String(error) },
        true,
      );
      return;
    }
    await this.options.kickoffSettlementCheckpoint?.();
    await this.settleKickoffIntent(claimed.id, claimed.leaseToken, report);
  }

  private async settleKickoffIntent(
    intentId: string,
    leaseToken: string,
    report: PlanningRunExecutionDto,
    failed = false,
  ): Promise<void> {
    await this.transactions.transaction(async (tx) => {
      const intent = (
        await tx.query<{
          action_id: string;
          project_id: string;
          work_item_id: string;
          planning_run_id: string;
        }>(
          `SELECT action_id, project_id, work_item_id, planning_run_id
             FROM conversation_kickoff_intents
            WHERE id=$1 AND status='leased' AND lease_token=$2
            FOR UPDATE`,
          [intentId, leaseToken],
        )
      ).rows[0];
      if (!intent) return;
      const effect = await this.effectByAction(tx, intent.action_id, true);
      if (!effect || effect.execution_status !== "pending") return;
      const now = this.now().toISOString();
      let phaseId: string | null = null;
      if (report.started) {
        phaseId =
          (
            await tx.query<{ id: string }>(
              `SELECT id FROM phases
                WHERE project_id=$1 AND planning_run_id=$2
                ORDER BY created_at DESC, id DESC LIMIT 1`,
              [intent.project_id, intent.planning_run_id],
            )
          ).rows[0]?.id ?? null;
      }
      const missingPhase = report.started && phaseId === null;
      const status = failed || missingPhase ? "failed" : report.started ? "started" : "refused";
      const detail = missingPhase
        ? "Execution kickoff reported started but created no execution phase."
        : report.detail;
      await tx.query(
        `UPDATE conversation_kickoff_intents
            SET status=$3, lease_token=NULL, lease_expires_at=NULL,
                execution_started=$4, execution_detail=$5, phase_id=$6,
                settled_at=$7, updated_at=$7
          WHERE id=$1 AND lease_token=$2 AND status='leased'`,
        [
          intentId,
          leaseToken,
          status === "started" ? "succeeded" : status,
          report.started && !missingPhase,
          detail,
          phaseId,
          now,
        ],
      );
      await tx.query(
        `UPDATE conversation_plan_action_effects
            SET execution_status=$2, execution_started=$3,
                execution_detail=$4, updated_at=$5
          WHERE action_id=$1 AND execution_status='pending'`,
        [intent.action_id, status, report.started && !missingPhase, detail, now],
      );
      if (report.started && phaseId) {
        await tx.query(
          `UPDATE work_items
              SET status='executing', phase_id=$3,
                  execution_started_at=coalesce(execution_started_at,$4),
                  aggregate_version=aggregate_version+1, updated_at=$4
            WHERE project_id=$1 AND id=$2`,
          [intent.project_id, intent.work_item_id, phaseId, now],
        );
      }
    });
  }

  private async insertPlanVersion(
    tx: V2SqlExecutor,
    projectId: string,
    workItemId: string,
    conversationId: string,
    userId: string,
    actionId: string,
    envelope: V2WorkPlanContractT,
    prior: V2WorkPlanVersionT | null,
  ): Promise<V2WorkPlanVersionT> {
    const plan = V2WorkPlanContract.parse(envelope);
    const hash = canonicalSha256(plan);
    const id = this.makeId("plan_version");
    const row = (
      await tx.query<PlanRow>(
        `INSERT INTO work_plan_versions (
           id, project_id, work_item_id, conversation_id, created_by_user_id,
           version, status, plan, content_hash, created_by_action_id,
           supersedes_plan_version_id, diff_from_previous
         ) VALUES (
           $1,$2,$3,$4,$5,$6,'candidate',$7::jsonb,$8,$9,$10,$11::jsonb
         ) RETURNING ${planColumns}`,
        [
          id,
          projectId,
          workItemId,
          conversationId,
          userId,
          (prior?.version ?? 0) + 1,
          JSON.stringify(plan),
          hash,
          actionId,
          prior?.id ?? null,
          prior ? JSON.stringify(diffValues(prior.plan, plan)) : null,
        ],
      )
    ).rows[0];
    if (!row) throw new Error("plan version insert returned no row");
    return toPlan(row);
  }

  private async insertEffect(
    tx: V2SqlExecutor,
    action: V2ConversationActionT,
    kind: EffectRow["effect_kind"],
    planVersionId: string,
    planReviewId: string | null,
    planningRunId: string | null,
    executionStatus: EffectRow["execution_status"],
    transition: {
      executionConversationId: string;
      handoffId: string;
      kickoffIntentId: string;
    } | null = null,
  ): Promise<void> {
    if (!transition) {
      await tx.query(
        `INSERT INTO conversation_plan_action_effects (
           id, project_id, work_item_id, conversation_id, action_id, effect_kind,
           plan_version_id, plan_review_id, planning_run_id, execution_status
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          this.makeId("plan_effect"),
          action.project_id,
          action.work_item_id,
          action.conversation_id,
          action.id,
          kind,
          planVersionId,
          planReviewId,
          planningRunId,
          executionStatus,
        ],
      );
      return;
    }
    await tx.query(
      `INSERT INTO conversation_plan_action_effects (
         id, project_id, work_item_id, conversation_id, action_id, effect_kind,
         plan_version_id, plan_review_id, planning_run_id, execution_status,
         execution_conversation_id, handoff_id, kickoff_intent_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        this.makeId("plan_effect"),
        action.project_id,
        action.work_item_id,
        action.conversation_id,
        action.id,
        kind,
        planVersionId,
        planReviewId,
        planningRunId,
        executionStatus,
        transition.executionConversationId,
        transition.handoffId,
        transition.kickoffIntentId,
      ],
    );
  }

  private toEffect(
    row: EffectRow,
    plans: Map<string, V2WorkPlanVersionT>,
    reviews: Map<string, V2ConversationPlanReviewT>,
  ): V2ConversationPlanActionEffectT {
    const plan = plans.get(row.plan_version_id);
    if (!plan) throw new Error(`effect "${row.id}" has no plan projection`);
    let effect: V2ConversationPlanActionEffectT["effect"];
    switch (row.effect_kind) {
      case "plan_saved":
        effect = { kind: row.effect_kind, plan_version: plan };
        break;
      case "qc_started": {
        const review = row.plan_review_id ? reviews.get(row.plan_review_id) : null;
        if (!review || !row.planning_run_id) throw new Error("QC effect projection is incomplete");
        effect = {
          kind: row.effect_kind,
          plan_review: review,
          planning_run_id: row.planning_run_id,
        };
        break;
      }
      case "changes_requested":
        effect = { kind: row.effect_kind, plan_version: plan };
        break;
      case "plan_approved":
        if (!row.plan_review_id || !row.planning_run_id || !row.execution_status) {
          throw new Error("approval effect projection is incomplete");
        }
        effect = {
          kind: row.effect_kind,
          plan_version: plan,
          plan_review_id: row.plan_review_id,
          planning_run_id: row.planning_run_id,
          transition_status:
            row.execution_conversation_id && row.handoff_id && row.kickoff_intent_id
              ? "created"
              : "legacy_unavailable",
          execution_conversation_id: row.execution_conversation_id,
          handoff_id: row.handoff_id,
          kickoff_intent_id: row.kickoff_intent_id,
          execution: {
            status: row.execution_status,
            started: row.execution_started,
            detail: row.execution_detail,
          },
        };
        break;
      case "plan_rejected":
        effect = { kind: row.effect_kind, plan_version: plan };
        break;
    }
    return V2ConversationPlanActionEffect.parse({
      schema_version: row.schema_version,
      id: row.id,
      project_id: row.project_id,
      work_item_id: row.work_item_id,
      conversation_id: row.conversation_id,
      action_id: row.action_id,
      effect,
      created_at: iso(row.created_at),
      updated_at: iso(row.updated_at),
    });
  }

  private flattenReviewEvidence(
    reviewId: string,
    result: ReviewOnlyPlanningResult,
  ): {
    findings: V2ConversationPlanReviewFindingT[];
    dispositions: V2ConversationPlanReviewDispositionT[];
  } {
    const findings: V2ConversationPlanReviewFindingT[] = [];
    const dispositions: V2ConversationPlanReviewDispositionT[] = [];
    for (const round of result.review_rounds) {
      const roundIndices = new Map<number, V2ConversationPlanReviewFindingT>();
      round.findings.forEach((finding, localIndex) => {
        const index = findings.length;
        const projected = {
          id: `${reviewId}:finding:${index}`,
          index,
          ...finding,
        };
        findings.push(projected);
        roundIndices.set(localIndex, projected);
      });
      for (const response of round.responses ?? []) {
        const finding = roundIndices.get(response.finding_index);
        if (!finding) throw new Error("review disposition references an unknown finding");
        dispositions.push({
          finding_id: finding.id,
          finding_index: finding.index,
          disposition: response.disposition,
          rationale: response.rationale,
        });
      }
    }
    return { findings, dispositions };
  }

  private reviewRoundExchanges(
    review: ReviewRow,
    rounds: readonly ReviewOnlyRound[],
    finalPlan?: V2WorkPlanContractT,
  ) {
    return rounds.map((round, index) => ({
      round: round.round,
      reviewed_plan_content_hash: canonicalSha256(round.reviewed_plan),
      reviewer: {
        provider: review.reviewer_provider,
        model: review.reviewer_model,
        findings: round.findings,
      },
      pm:
        round.responses === null
          ? null
          : {
              provider: review.pm_provider,
              model: review.pm_model,
              dispositions: round.responses,
              revised_plan_content_hash:
                round.revised_plan_content_hash ??
                canonicalSha256(
                  rounds[index + 1]?.reviewed_plan ?? finalPlan ?? round.reviewed_plan,
                ),
            },
    }));
  }

  private staffingProposal(plan: V2WorkPlanContractT) {
    return {
      summary: "Staffing pinned by the approved conversational Plan Contract.",
      recommendations: plan.staffing.map((entry) => ({
        node_id: entry.module_id,
        provider: entry.provider,
        model: entry.model,
        reasoning_effort: null,
        worker_count: 1,
        budget_usd: plan.estimated_budget.amount / Math.max(1, plan.staffing.length),
        rationale: `Pinned ${entry.agent_role} staffing from the immutable plan envelope.`,
      })),
    };
  }

  private approvedStaffing(plan: V2WorkPlanContractT): ApprovedStaffingEntryDto[] {
    return plan.staffing.map((entry) => ({
      node_id: entry.module_id,
      provider: this.provider(entry.provider),
      model: entry.model,
      reasoning_effort: null,
    }));
  }

  private provider(value: string): ProviderName {
    if (value === "anthropic" || value === "openai") return value;
    throw new ConversationPlanWorkflowError(
      "invalid_plan_state",
      `unsupported provider "${value}" in plan workflow`,
    );
  }

  private async freezeQcContext(tx: V2SqlExecutor, action: V2ConversationActionT) {
    const entries: Array<{
      kind: "global_rules" | "project_rules" | "project_knowledge" | "decision" | "artifact";
      ref: string;
      content_hash: string;
    }> = [];
    const receipt: Record<string, unknown[]> = {
      binding_rules: [],
      approved_knowledge: [],
      decision_ledger: [],
      referenced_artifacts: [],
    };
    const global = (
      await tx.query<{ content: string; version: number }>(
        "SELECT content, version FROM global_rule_settings WHERE id='global'",
      )
    ).rows[0];
    if (global?.content.trim()) {
      const item = { id: `global-rules-v${global.version}`, content: global.content };
      receipt.binding_rules?.push(item);
      entries.push({
        kind: "global_rules",
        ref: item.id,
        content_hash: canonicalSha256(item),
      });
    }
    const memory = await tx.query<{
      id: string;
      category: string;
      content: string;
      source_ref: unknown;
    }>(
      `SELECT id, category, content, source_ref
         FROM project_memory_entries
        WHERE project_id=$1 AND status='active' AND approved_by_human=TRUE
        ORDER BY created_at, id`,
      [action.project_id],
    );
    for (const row of memory.rows) {
      const source = json<Record<string, unknown>>(row.source_ref);
      const isRules = row.category === "directive" && source.kind === "project_rules_file";
      const item = { id: row.id, category: row.category, content: row.content };
      (isRules ? receipt.binding_rules : receipt.approved_knowledge)?.push(item);
      entries.push({
        kind: isRules ? "project_rules" : "project_knowledge",
        ref: row.id,
        content_hash: canonicalSha256(item),
      });
    }
    const decisions = await tx.query<{
      id: string;
      title: string;
      rationale: string;
      selected_option_id: string | null;
      decided_by: string;
    }>(
      `SELECT id, title, rationale, selected_option_id, decided_by
         FROM decision_records
        WHERE project_id=$1 AND status='active'
        ORDER BY created_at, id`,
      [action.project_id],
    );
    for (const decision of decisions.rows) {
      receipt.decision_ledger?.push(decision);
      entries.push({
        kind: "decision",
        ref: decision.id,
        content_hash: canonicalSha256(decision),
      });
    }
    const planVersionId = String(
      (action.payload.parameters as Record<string, unknown>).plan_version_id,
    );
    const provenance = (
      await tx.query<{ payload: unknown }>(
        `SELECT creator.payload
           FROM work_plan_versions version
           JOIN conversation_actions creator ON creator.id=version.created_by_action_id
          WHERE version.project_id=$1 AND version.work_item_id=$2
            AND version.conversation_id=$3 AND version.id=$4`,
        [action.project_id, action.work_item_id, action.conversation_id, planVersionId],
      )
    ).rows[0];
    const references = provenance
      ? (json<{ parameters?: { referenced_artifacts?: unknown[] } }>(provenance.payload).parameters
          ?.referenced_artifacts ?? [])
      : [];
    for (const candidate of references) {
      if (!candidate || typeof candidate !== "object") continue;
      const id = (candidate as { id?: unknown }).id;
      const expectedHash = (candidate as { content_hash?: unknown }).content_hash;
      if (typeof id !== "string" || typeof expectedHash !== "string") continue;
      const artifact = (
        await tx.query<{
          id: string;
          kind: string;
          content_hash: string;
          media_type: string;
          storage_ref: string;
        }>(
          `SELECT id, kind, content_hash, media_type, storage_ref
             FROM artifacts
            WHERE project_id=$1 AND id=$2 AND content_hash=$3`,
          [action.project_id, id, expectedHash],
        )
      ).rows[0];
      if (artifact) {
        receipt.referenced_artifacts?.push(artifact);
        entries.push({
          kind: "artifact",
          ref: artifact.id,
          content_hash: artifact.content_hash,
        });
        continue;
      }
      const attachment = (
        await tx.query<{
          id: string;
          sha256: string;
          mime: string;
          bytes: number;
        }>(
          `SELECT id, sha256, mime, bytes
             FROM attachments
            WHERE project_id=$1 AND id=$2 AND sha256=$3 AND deleted_at IS NULL`,
          [action.project_id, id, expectedHash],
        )
      ).rows[0];
      if (attachment) {
        receipt.referenced_artifacts?.push(attachment);
        entries.push({
          kind: "artifact",
          ref: attachment.id,
          content_hash: attachment.sha256,
        });
      }
    }
    const hash = canonicalSha256({ receipt, entries });
    const manifest = { entries, context_hash: hash };
    return { receipt, manifest, hash };
  }

  private async assertAccess(tx: V2SqlExecutor, projectId: string, userId: string): Promise<void> {
    const row = (
      await tx.query<{
        identity_status: string;
        identity_role: string;
        project_id: string | null;
        owner_user_id: string | null;
        active_member: boolean;
      }>(
        `SELECT identity.status AS identity_status, identity.role AS identity_role,
                project.id AS project_id, project.owner_user_id,
                EXISTS (
                  SELECT 1 FROM project_members membership
                   WHERE membership.project_id=project.id
                     AND membership.user_id=identity.id
                     AND membership.status='active'
                ) AS active_member
           FROM users identity
           LEFT JOIN projects project ON project.id=$2
          WHERE identity.id=$1`,
        [userId, projectId],
      )
    ).rows[0];
    if (!row) throw new ConversationPlanWorkflowError("identity_not_found", "unknown user");
    if (row.identity_status !== "active") {
      throw new ConversationPlanWorkflowError("identity_inactive", "user is inactive");
    }
    if (!row.project_id) {
      throw new ConversationPlanWorkflowError("project_not_found", "unknown project");
    }
    if (row.identity_role !== "admin" && row.owner_user_id !== userId && !row.active_member) {
      throw new ConversationPlanWorkflowError("forbidden", "project access is forbidden");
    }
  }

  private async assertConversation(
    tx: V2SqlExecutor,
    projectId: string,
    workItemId: string,
    conversationId: string,
    lock: boolean,
    requireActive = true,
    requirePlanning = true,
  ): Promise<{ status: string; kind: string; provider: string; model: string }> {
    const row = (
      await tx.query<{ status: string; kind: string; provider: string; model: string }>(
        `SELECT status, kind, provider, model FROM work_conversations
          WHERE project_id=$1 AND work_item_id=$2 AND id=$3
          ${lock ? "FOR UPDATE" : ""}`,
        [projectId, workItemId, conversationId],
      )
    ).rows[0];
    if (!row) {
      throw new ConversationPlanWorkflowError(
        "conversation_not_found",
        "conversation not found in the requested scope",
      );
    }
    if (
      (requireActive && row.status !== "active") ||
      (requirePlanning && row.kind !== "planning")
    ) {
      throw new ConversationPlanWorkflowError(
        "conversation_inactive",
        "plan actions require an active planning conversation",
      );
    }
    return row;
  }

  private async lockAction(
    tx: V2SqlExecutor,
    input: V2ConfirmConversationActionInputT,
    lock: boolean,
  ): Promise<V2ConversationActionT> {
    const row = (
      await tx.query<ActionRow>(
        `SELECT ${actionColumns} FROM conversation_actions
          WHERE project_id=$1 AND work_item_id=$2 AND conversation_id=$3 AND id=$4
          ${lock ? "FOR UPDATE" : ""}`,
        [input.project_id, input.work_item_id, input.conversation_id, input.action_id],
      )
    ).rows[0];
    if (!row) throw new ConversationPlanWorkflowError("action_not_found", "unknown plan action");
    return toAction(row);
  }

  private async actionById(
    tx: V2SqlExecutor,
    actionId: string,
    lock: boolean,
  ): Promise<V2ConversationActionT> {
    const row = (
      await tx.query<ActionRow>(
        `SELECT ${actionColumns} FROM conversation_actions WHERE id=$1
          ${lock ? "FOR UPDATE" : ""}`,
        [actionId],
      )
    ).rows[0];
    if (!row) throw new Error(`unknown action "${actionId}"`);
    return toAction(row);
  }

  private async advanceAction(
    tx: V2SqlExecutor,
    actionId: string,
    next: "recorded" | "sent" | "agent_acknowledged" | "applied",
  ): Promise<void> {
    const previous = {
      recorded: "confirmed",
      sent: "recorded",
      agent_acknowledged: "sent",
      applied: "agent_acknowledged",
    }[next];
    const timestamp = {
      recorded: "recorded_at",
      sent: "sent_at",
      agent_acknowledged: "acknowledged_at",
      applied: "applied_at",
    }[next];
    const result = await tx.query<{ id: string }>(
      `UPDATE conversation_actions SET status=$2, ${timestamp}=now(), updated_at=now()
        WHERE id=$1 AND status=$3 RETURNING id`,
      [actionId, next, previous],
    );
    if (result.rows.length !== 1) {
      throw new Error(`action "${actionId}" cannot advance ${previous} -> ${next}`);
    }
  }

  private async finishLocalAction(tx: V2SqlExecutor, actionId: string): Promise<void> {
    await this.advanceAction(tx, actionId, "sent");
    await this.advanceAction(tx, actionId, "agent_acknowledged");
    await this.advanceAction(tx, actionId, "applied");
  }

  private async latestPlan(
    tx: V2SqlExecutor,
    projectId: string,
    workItemId: string,
    lock: boolean,
  ): Promise<V2WorkPlanVersionT | null> {
    const row = (
      await tx.query<PlanRow>(
        `SELECT ${planColumns} FROM work_plan_versions
          WHERE project_id=$1 AND work_item_id=$2
          ORDER BY version DESC LIMIT 1 ${lock ? "FOR UPDATE" : ""}`,
        [projectId, workItemId],
      )
    ).rows[0];
    return row ? toPlan(row) : null;
  }

  private async planById(
    tx: V2SqlExecutor,
    planId: string,
    lock: boolean,
  ): Promise<V2WorkPlanVersionT> {
    const row = (
      await tx.query<PlanRow>(
        `SELECT ${planColumns} FROM work_plan_versions WHERE id=$1
          ${lock ? "FOR UPDATE" : ""}`,
        [planId],
      )
    ).rows[0];
    if (!row) throw new ConversationPlanWorkflowError("stale_plan_version", "unknown plan version");
    return toPlan(row);
  }

  private async boundLatestPlan(
    tx: V2SqlExecutor,
    action: V2ConversationActionT,
    parameters: Record<string, unknown>,
    expectedStatus?: V2WorkPlanVersionT["status"],
  ): Promise<V2WorkPlanVersionT> {
    const latest = await this.latestPlan(tx, action.project_id, action.work_item_id, true);
    if (!latest || latest.id !== parameters.plan_version_id) {
      throw new ConversationPlanWorkflowError(
        "stale_plan_version",
        "the referenced plan version is no longer current",
      );
    }
    if (latest.content_hash !== parameters.content_hash) {
      throw new ConversationPlanWorkflowError(
        "stale_plan_hash",
        "the referenced plan content hash is stale",
      );
    }
    if (latest.conversation_id !== action.conversation_id) {
      throw new ConversationPlanWorkflowError(
        "stale_plan_version",
        "the referenced plan belongs to a different planning conversation",
      );
    }
    if (expectedStatus && latest.status !== expectedStatus) {
      throw new ConversationPlanWorkflowError(
        expectedStatus === "in_qc" ? "plan_not_reviewed" : "invalid_plan_state",
        `plan ${latest.id} is ${latest.status}, expected ${expectedStatus}`,
      );
    }
    return latest;
  }

  private async reviewById(tx: V2SqlExecutor, reviewId: string, lock: boolean): Promise<ReviewRow> {
    const row = (
      await tx.query<ReviewRow>(
        `SELECT ${reviewColumns} FROM conversation_plan_reviews WHERE id=$1
          ${lock ? "FOR UPDATE" : ""}`,
        [reviewId],
      )
    ).rows[0];
    if (!row) throw new ConversationPlanWorkflowError("plan_not_reviewed", "unknown QC review");
    return row;
  }

  private async activeReview(tx: V2SqlExecutor, planId: string): Promise<boolean> {
    return Boolean(
      (
        await tx.query<{ id: string }>(
          `SELECT id FROM conversation_plan_reviews
            WHERE plan_version_id=$1 AND status IN ('queued','running') LIMIT 1`,
          [planId],
        )
      ).rows[0],
    );
  }

  private async effectByAction(
    tx: V2SqlExecutor,
    actionId: string,
    lock = false,
  ): Promise<EffectRow | null> {
    return (
      (
        await tx.query<EffectRow>(
          `SELECT ${effectColumns} FROM conversation_plan_action_effects
          WHERE action_id=$1 ${lock ? "FOR UPDATE" : ""}`,
          [actionId],
        )
      ).rows[0] ?? null
    );
  }

  private async lockWork(tx: V2SqlExecutor, projectId: string, workItemId: string) {
    const row = (
      await tx.query<{ id: string; project_id: string; status: string }>(
        "SELECT id, project_id, status FROM work_items WHERE project_id=$1 AND id=$2 FOR UPDATE",
        [projectId, workItemId],
      )
    ).rows[0];
    if (!row) throw new ConversationPlanWorkflowError("work_item_not_found", "unknown work item");
    return row;
  }

  private async appendVisibleMessage(
    tx: V2SqlExecutor,
    scope:
      | Pick<
          V2ConversationActionT,
          "project_id" | "work_item_id" | "conversation_id" | "initiated_by_user_id"
        >
      | Pick<ReviewRow, "project_id" | "work_item_id" | "conversation_id" | "initiated_by_user_id">,
    userId: string,
    text: string,
    planVersionId: string,
    actionId: string,
    followUps: readonly FollowUpActionProposal[] = [],
  ): Promise<void> {
    const sequence = (
      await tx.query<{ sequence: number | string }>(
        `UPDATE work_conversations
            SET next_message_sequence=next_message_sequence+1, updated_at=now()
          WHERE id=$1 RETURNING next_message_sequence-1 AS sequence`,
        [scope.conversation_id],
      )
    ).rows[0]?.sequence;
    if (sequence === undefined) throw new Error("could not allocate action message sequence");
    const proposed: Array<
      FollowUpActionProposal & {
        id: string;
        payload: { parameters: Record<string, unknown> };
        payloadHash: string;
        existing: boolean;
      }
    > = [];
    for (const proposal of followUps) {
      const payload = { parameters: proposal.parameters };
      const payloadHash = canonicalSha256(payload);
      const existing = (
        await tx.query<{ id: string }>(
          `SELECT id FROM conversation_actions
            WHERE conversation_id=$1 AND initiated_by_user_id=$2
              AND action_type=$3 AND payload_hash=$4
              AND status='proposed'
            FOR UPDATE`,
          [scope.conversation_id, userId, proposal.action_type, payloadHash],
        )
      ).rows[0];
      proposed.push({
        ...proposal,
        id: existing?.id ?? this.makeId("conversation_action"),
        payload,
        payloadHash,
        existing: Boolean(existing),
      });
    }
    const messageId = this.makeId("message");
    await tx.query(
      `INSERT INTO work_messages (
         id, project_id, work_item_id, conversation_id, initiated_by_user_id,
         actor_type, actor_id, role, visibility_status, sequence, parts
       ) VALUES (
         $1,$2,$3,$4,$5,'system','conversation-plan-workflow','system','complete',
         $6,$7::jsonb
       )`,
      [
        messageId,
        scope.project_id,
        scope.work_item_id,
        scope.conversation_id,
        userId,
        sequence,
        JSON.stringify([
          { type: "text", format: "markdown", text },
          { type: "plan", plan_version_id: planVersionId },
          { type: "action", action_id: actionId },
          ...proposed.map((proposal) => ({ type: "action", action_id: proposal.id })),
        ]),
      ],
    );
    for (const proposal of proposed) {
      if (proposal.existing) continue;
      await tx.query(
        `INSERT INTO conversation_actions (
           id, project_id, work_item_id, conversation_id, initiated_by_user_id,
           actor_type, actor_id, source_message_id, action_type, payload, payload_hash
         ) VALUES (
           $1,$2,$3,$4,$5,'system','conversation-plan-workflow',$6,$7,$8::jsonb,$9
         )`,
        [
          proposal.id,
          scope.project_id,
          scope.work_item_id,
          scope.conversation_id,
          userId,
          messageId,
          proposal.action_type,
          JSON.stringify(proposal.payload),
          proposal.payloadHash,
        ],
      );
    }
  }

  private candidateFollowUps(
    plan: V2WorkPlanVersionT,
    handoff?: V2PlanHandoffPreferenceT,
  ): FollowUpActionProposal[] {
    return [
      {
        action_type: "send_plan_to_qc",
        parameters: {
          plan_version_id: plan.id,
          content_hash: plan.content_hash,
          ...(handoff ? { review: handoff.review } : {}),
        },
      },
      {
        action_type: "reject_plan",
        parameters: {
          plan_version_id: plan.id,
          content_hash: plan.content_hash,
          reason: null,
        },
      },
    ];
  }

  private reviewFollowUps(
    plan: V2WorkPlanVersionT,
    review: ReviewRow | string,
  ): FollowUpActionProposal[] {
    const reviewId = typeof review === "string" ? review : review.id;
    const repeatReview =
      typeof review === "string" || review.review_mode === "waived"
        ? undefined
        : {
            mode: "qc" as const,
            reviewer: {
              provider: review.reviewer_provider,
              model: review.reviewer_model,
            },
            rounds: Number(review.max_rounds),
          };
    return [
      {
        action_type: "approve_plan",
        parameters: {
          plan_version_id: plan.id,
          content_hash: plan.content_hash,
          plan_review_id: reviewId,
        },
      },
      {
        action_type: "send_plan_to_qc",
        parameters: {
          plan_version_id: plan.id,
          content_hash: plan.content_hash,
          ...(repeatReview ? { review: repeatReview } : {}),
        },
      },
      ...this.candidateFollowUps(plan).filter(
        (proposal) => !["send_plan_to_qc"].includes(proposal.action_type),
      ),
    ];
  }

  private async rejectSiblingProposals(
    tx: V2SqlExecutor,
    action: V2ConversationActionT,
    planVersionId: string | null,
  ): Promise<void> {
    await tx.query(
      `UPDATE conversation_actions
          SET status='rejected', updated_at=now()
        WHERE conversation_id=$1
          AND id<>$2
          AND status='proposed'
          AND action_type IN (
            'save_plan_candidate','send_plan_to_qc','request_plan_changes',
            'approve_plan','reject_plan'
          )
          AND (
            $3::text IS NULL
            OR payload->'parameters'->>'plan_version_id'=$3
            OR payload->'parameters'->>'predecessor_plan_version_id'=$3
          )`,
      [action.conversation_id, action.id, planVersionId],
    );
  }
}
