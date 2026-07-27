import { z } from "zod";
import { PlanContract, validatePlan } from "../plan.js";
import {
  V2Actor,
  V2EntityId,
  V2IsoDateTime,
  V2NonEmptyString,
  V2PositiveVersion,
  V2Sha256Hex,
} from "./common.js";

const schemaVersion = z.literal(2);
const nullableDate = V2IsoDateTime.nullable();
const nonNegativeInteger = z.number().int().nonnegative();

export const V2WorkItemStatus = z.enum([
  "planning",
  "in_qc",
  "awaiting_approval",
  "executing",
  "blocked",
  "completed",
  "cancelled",
]);
export type V2WorkItemStatusT = z.infer<typeof V2WorkItemStatus>;

export const V2WorkItem = z
  .object({
    schema_version: schemaVersion,
    id: V2EntityId,
    project_id: V2EntityId,
    created_by_user_id: V2EntityId,
    title: V2NonEmptyString,
    objective: V2NonEmptyString,
    status: V2WorkItemStatus,
    planning_run_id: V2EntityId.nullable(),
    phase_id: V2EntityId.nullable(),
    approved_plan_version_id: V2EntityId.nullable(),
    aggregate_version: V2PositiveVersion,
    created_at: V2IsoDateTime,
    updated_at: V2IsoDateTime,
    execution_started_at: nullableDate,
    completed_at: nullableDate,
  })
  .strict()
  .superRefine((item, ctx) => {
    if ((item.status === "completed") !== (item.completed_at !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["completed_at"],
        message: "completed_at must be present exactly when the work item is completed",
      });
    }
    const executionStarted = ["executing", "blocked", "completed"].includes(item.status);
    if (
      (executionStarted && (item.phase_id === null || item.execution_started_at === null)) ||
      (item.execution_started_at !== null && item.phase_id === null)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["execution_started_at"],
        message: "execution states require their materialized phase and start time",
      });
    }
  });
export type V2WorkItemT = z.infer<typeof V2WorkItem>;

export const V2WorkConversationKind = z.enum(["planning", "execution_pm", "task"]);
export type V2WorkConversationKindT = z.infer<typeof V2WorkConversationKind>;

export const V2WorkConversationStatus = z.enum(["active", "archived", "closed"]);
export type V2WorkConversationStatusT = z.infer<typeof V2WorkConversationStatus>;

export const V2WorkConversation = z
  .object({
    schema_version: schemaVersion,
    id: V2EntityId,
    project_id: V2EntityId,
    work_item_id: V2EntityId,
    created_by_user_id: V2EntityId,
    kind: V2WorkConversationKind,
    status: V2WorkConversationStatus,
    provider: V2NonEmptyString,
    model: V2NonEmptyString,
    next_message_sequence: z.number().int().positive(),
    created_at: V2IsoDateTime,
    updated_at: V2IsoDateTime,
    archived_at: nullableDate,
  })
  .strict()
  .superRefine((conversation, ctx) => {
    if ((conversation.status === "archived") !== (conversation.archived_at !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["archived_at"],
        message: "archived_at must be present exactly when the conversation is archived",
      });
    }
  });
export type V2WorkConversationT = z.infer<typeof V2WorkConversation>;

export const V2MessageTextPart = z
  .object({
    type: z.literal("text"),
    format: z.enum(["plain", "markdown"]),
    text: V2NonEmptyString,
  })
  .strict();

export const V2MessageCodePart = z
  .object({
    type: z.literal("code"),
    code: V2NonEmptyString,
    language: V2NonEmptyString.nullable(),
  })
  .strict();

export const V2MessageAttachmentPart = z
  .object({
    type: z.literal("attachment"),
    attachment_id: V2EntityId,
    name: V2NonEmptyString,
    media_type: V2NonEmptyString,
  })
  .strict();

export const V2MessageArtifactPart = z
  .object({
    type: z.literal("artifact"),
    artifact_id: V2EntityId,
    label: V2NonEmptyString,
    media_type: V2NonEmptyString,
  })
  .strict();

export const V2MessageActionPart = z
  .object({
    type: z.literal("action"),
    action_id: V2EntityId,
  })
  .strict();

export const V2MessagePlanPart = z
  .object({
    type: z.literal("plan"),
    plan_version_id: V2EntityId,
  })
  .strict();

/**
 * Deliberately excludes reasoning/thought parts. Durable conversation history
 * contains only content shown to the user.
 */
export const V2WorkMessagePart = z.discriminatedUnion("type", [
  V2MessageTextPart,
  V2MessageCodePart,
  V2MessageAttachmentPart,
  V2MessageArtifactPart,
  V2MessageActionPart,
  V2MessagePlanPart,
]);
export type V2WorkMessagePartT = z.infer<typeof V2WorkMessagePart>;

export const V2WorkMessageRole = z.enum(["user", "assistant", "system"]);
export type V2WorkMessageRoleT = z.infer<typeof V2WorkMessageRole>;
export const V2WorkMessageVisibilityStatus = z.enum(["streaming", "complete", "interrupted"]);

export const V2WorkMessage = z
  .object({
    schema_version: schemaVersion,
    id: V2EntityId,
    project_id: V2EntityId,
    work_item_id: V2EntityId,
    conversation_id: V2EntityId,
    initiated_by_user_id: V2EntityId,
    actor: V2Actor,
    role: V2WorkMessageRole,
    visibility_status: V2WorkMessageVisibilityStatus,
    sequence: z.number().int().positive(),
    parts: z.array(V2WorkMessagePart).min(1),
    client_message_id: V2EntityId.nullable(),
    request_fingerprint: V2Sha256Hex.nullable(),
    created_at: V2IsoDateTime,
  })
  .strict()
  .superRefine((message, ctx) => {
    const hasSubmissionIdentity =
      message.client_message_id !== null && message.request_fingerprint !== null;
    if (message.role === "user" && !hasSubmissionIdentity) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["client_message_id"],
        message: "user messages require a client message ID and request fingerprint",
      });
    }
    if (message.role !== "user" && hasSubmissionIdentity) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["client_message_id"],
        message: "only user messages carry client submission identity",
      });
    }
    if ((message.client_message_id === null) !== (message.request_fingerprint === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["request_fingerprint"],
        message: "client message ID and request fingerprint must be present together",
      });
    }
    if (message.role === "user") {
      if (
        message.actor.actor_type !== "human" ||
        message.actor.actor_id !== message.initiated_by_user_id
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["actor"],
          message: "user message actor must be the initiating human",
        });
      }
      if (message.visibility_status !== "complete") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["visibility_status"],
          message: "user messages are complete at insertion",
        });
      }
    }
    if (message.role !== "assistant" && message.visibility_status === "streaming") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["visibility_status"],
        message: "only visible assistant output can be in flight",
      });
    }
  });
export type V2WorkMessageT = z.infer<typeof V2WorkMessage>;

export const V2WorkMessageAttachmentRef = z
  .object({
    schema_version: schemaVersion,
    project_id: V2EntityId,
    work_item_id: V2EntityId,
    conversation_id: V2EntityId,
    message_id: V2EntityId,
    attachment_id: V2EntityId,
    created_by_user_id: V2EntityId,
    created_at: V2IsoDateTime,
  })
  .strict();
export type V2WorkMessageAttachmentRefT = z.infer<typeof V2WorkMessageAttachmentRef>;

export const V2ConversationContextEntry = z
  .object({
    kind: z.enum([
      "global_rules",
      "project_rules",
      "project_knowledge",
      "work_objective",
      "conversation_summary",
      "decision",
      "risk",
      "message",
      "artifact",
      "handoff",
    ]),
    ref: V2EntityId,
    content_hash: V2Sha256Hex,
    estimated_tokens: nonNegativeInteger,
  })
  .strict();

export const V2ConversationContextManifest = z
  .object({
    entries: z.array(V2ConversationContextEntry),
    estimated_tokens: nonNegativeInteger,
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const total = manifest.entries.reduce((sum, entry) => sum + entry.estimated_tokens, 0);
    if (total !== manifest.estimated_tokens) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["estimated_tokens"],
        message: "estimated_tokens must equal the sum of manifest entries",
      });
    }
  });
export type V2ConversationContextManifestT = z.infer<typeof V2ConversationContextManifest>;

export const V2ConversationTurnAttemptStatus = z.enum([
  "pending",
  "streaming",
  "succeeded",
  "failed",
  "cancelled",
]);
export const V2ConversationUsageStatus = z.enum(["pending", "exact", "unavailable"]);

export const V2ConversationTurnAttempt = z
  .object({
    schema_version: schemaVersion,
    id: V2EntityId,
    project_id: V2EntityId,
    work_item_id: V2EntityId,
    conversation_id: V2EntityId,
    initiated_by_user_id: V2EntityId,
    actor: V2Actor,
    triggering_message_id: V2EntityId,
    output_message_id: V2EntityId.nullable(),
    attempt_number: z.number().int().positive(),
    provider: V2NonEmptyString,
    model: V2NonEmptyString,
    provider_request_id: V2NonEmptyString.nullable(),
    usage_request_id: V2EntityId,
    provider_finish_reason: V2NonEmptyString.nullable(),
    status: V2ConversationTurnAttemptStatus,
    context_manifest: V2ConversationContextManifest,
    context_hash: V2Sha256Hex,
    usage_status: V2ConversationUsageStatus,
    input_tokens: nonNegativeInteger.nullable(),
    output_tokens: nonNegativeInteger.nullable(),
    cache_read_tokens: nonNegativeInteger.nullable(),
    cache_write_tokens: nonNegativeInteger.nullable(),
    cost_usd: z.number().nonnegative().nullable(),
    failure_code: V2NonEmptyString.nullable(),
    failure_message_redacted: V2NonEmptyString.nullable(),
    sanitized_failure: z.record(z.unknown()).nullable(),
    started_at: V2IsoDateTime,
    settled_at: nullableDate,
    created_at: V2IsoDateTime,
  })
  .strict()
  .superRefine((attempt, ctx) => {
    const terminal = ["succeeded", "failed", "cancelled"].includes(attempt.status);
    if (terminal !== (attempt.settled_at !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["settled_at"],
        message: "settled_at must be present exactly for terminal attempts",
      });
    }
    const tokenValues = [
      attempt.input_tokens,
      attempt.output_tokens,
      attempt.cache_read_tokens,
      attempt.cache_write_tokens,
    ];
    if (attempt.usage_status === "exact" && tokenValues.some((value) => value === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["usage_status"],
        message: "exact usage requires every token count",
      });
    }
    if (
      attempt.usage_status !== "exact" &&
      (tokenValues.some((value) => value !== null) || attempt.cost_usd !== null)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["usage_status"],
        message: "usage values are stored only when usage_status is exact",
      });
    }
    if (attempt.status === "failed" && attempt.failure_code === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["failure_code"],
        message: "failed attempts require a redacted failure code",
      });
    }
    if (
      attempt.status !== "failed" &&
      (attempt.failure_code !== null ||
        attempt.failure_message_redacted !== null ||
        attempt.sanitized_failure !== null)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["failure_code"],
        message: "failure details are valid only for failed attempts",
      });
    }
    if (attempt.status === "succeeded" && attempt.output_message_id === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["output_message_id"],
        message: "successful attempts require their visible output message",
      });
    }
    if (attempt.status === "succeeded" && attempt.provider_finish_reason === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["provider_finish_reason"],
        message: "successful attempts require the provider finish reason",
      });
    }
  });
export type V2ConversationTurnAttemptT = z.infer<typeof V2ConversationTurnAttempt>;

export const V2ConversationActionType = z.enum([
  "save_plan_candidate",
  "send_plan_to_qc",
  "request_plan_changes",
  "approve_plan",
  "reject_plan",
  "pause_work",
  "resume_work",
  "redirect_agent",
  "create_mockup",
  "approve_mockup",
  "revise_mockup",
  "reject_mockup",
]);
export type V2ConversationActionTypeT = z.infer<typeof V2ConversationActionType>;

export const V2ConversationActionStatus = z.enum([
  "proposed",
  "confirmed",
  "recorded",
  "sent",
  "agent_acknowledged",
  "applied",
  "rejected",
  "failed",
]);
export type V2ConversationActionStatusT = z.infer<typeof V2ConversationActionStatus>;

export const V2ConversationActionPayload = z
  .object({
    parameters: z.record(z.unknown()),
  })
  .strict();
export type V2ConversationActionPayloadT = z.infer<typeof V2ConversationActionPayload>;

export const V2ConversationAction = z
  .object({
    schema_version: schemaVersion,
    id: V2EntityId,
    project_id: V2EntityId,
    work_item_id: V2EntityId,
    conversation_id: V2EntityId,
    initiated_by_user_id: V2EntityId,
    actor: V2Actor,
    source_message_id: V2EntityId,
    action_type: V2ConversationActionType,
    payload: V2ConversationActionPayload,
    payload_hash: V2Sha256Hex,
    status: V2ConversationActionStatus,
    confirmed_by_user_id: V2EntityId.nullable(),
    confirmation_idempotency_key: V2EntityId.nullable(),
    confirmation_request_fingerprint: V2Sha256Hex.nullable(),
    confirmed_at: nullableDate,
    recorded_at: nullableDate,
    sent_at: nullableDate,
    acknowledged_at: nullableDate,
    applied_at: nullableDate,
    failure_code: V2NonEmptyString.nullable(),
    created_at: V2IsoDateTime,
    updated_at: V2IsoDateTime,
  })
  .strict()
  .superRefine((action, ctx) => {
    const confirmationValues = [
      action.confirmed_by_user_id,
      action.confirmation_idempotency_key,
      action.confirmation_request_fingerprint,
      action.confirmed_at,
    ];
    const hasConfirmation = confirmationValues.every((value) => value !== null);
    const afterProposal = !["proposed", "rejected"].includes(action.status);
    if (afterProposal !== hasConfirmation) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["confirmed_at"],
        message: "confirmed and delivery states require complete confirmation attribution",
      });
    }
    if (action.status === "failed" && action.failure_code === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["failure_code"],
        message: "failed actions require a failure code",
      });
    }
    if (action.status !== "failed" && action.failure_code !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["failure_code"],
        message: "failure_code is valid only for failed actions",
      });
    }
  });
export type V2ConversationActionT = z.infer<typeof V2ConversationAction>;

export const V2WorkPlanContract = z
  .object({
    plan: PlanContract.strict(),
    staffing: z
      .array(
        z
          .object({
            module_id: V2EntityId,
            agent_role: V2NonEmptyString,
            provider: V2NonEmptyString,
            model: V2NonEmptyString,
          })
          .strict(),
      )
      .min(1),
    verification_requirements: z.array(V2NonEmptyString).min(1),
    open_decisions: z.array(V2NonEmptyString),
    estimated_budget: z
      .object({
        currency: z.string().regex(/^[A-Z]{3}$/),
        amount: z.number().nonnegative(),
      })
      .strict(),
  })
  .strict()
  .superRefine((envelope, ctx) => {
    const validated = validatePlan(envelope.plan);
    if (!validated.ok) {
      for (const error of validated.errors) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["plan", ...(error.module_id ? ["modules", error.module_id] : [])],
          message: error.message,
        });
      }
    }
    const moduleIds = new Set(envelope.plan.modules.map((module) => module.id));
    const staffedIds = new Set(envelope.staffing.map((choice) => choice.module_id));
    if (staffedIds.size !== envelope.staffing.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["staffing"],
        message: "each module can have only one staffing/model choice",
      });
    }
    if (
      staffedIds.size !== moduleIds.size ||
      [...staffedIds].some((moduleId) => !moduleIds.has(moduleId))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["staffing"],
        message: "staffing must pin a role, provider, and model for every plan module",
      });
    }
  });
export type V2WorkPlanContractT = z.infer<typeof V2WorkPlanContract>;

export const V2WorkPlanVersionStatus = z.enum([
  "candidate",
  "in_qc",
  "changes_requested",
  "approved",
  "rejected",
  "superseded",
]);

export const V2WorkPlanVersionDiff = z
  .object({
    added: z.array(V2NonEmptyString),
    removed: z.array(V2NonEmptyString),
    changed: z.array(V2NonEmptyString),
  })
  .strict();

export const V2WorkPlanVersion = z
  .object({
    schema_version: schemaVersion,
    id: V2EntityId,
    project_id: V2EntityId,
    work_item_id: V2EntityId,
    conversation_id: V2EntityId,
    created_by_user_id: V2EntityId,
    version: z.number().int().positive(),
    status: V2WorkPlanVersionStatus,
    plan: V2WorkPlanContract,
    content_hash: V2Sha256Hex,
    supersedes_plan_version_id: V2EntityId.nullable(),
    diff_from_previous: V2WorkPlanVersionDiff.nullable(),
    approved_by_user_id: V2EntityId.nullable(),
    approved_at: nullableDate,
    created_at: V2IsoDateTime,
    updated_at: V2IsoDateTime,
  })
  .strict()
  .superRefine((version, ctx) => {
    const hasPrior = version.supersedes_plan_version_id !== null;
    if (hasPrior !== (version.diff_from_previous !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["diff_from_previous"],
        message: "a superseding plan version requires its immutable diff",
      });
    }
    if (version.version === 1 && hasPrior) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["supersedes_plan_version_id"],
        message: "the first plan version cannot supersede another version",
      });
    }
    if (version.version > 1 && !hasPrior) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["supersedes_plan_version_id"],
        message: "later plan versions must identify their predecessor",
      });
    }
    const approved = version.status === "approved";
    if (approved !== (version.approved_by_user_id !== null && version.approved_at !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["approved_at"],
        message: "approved plan status requires attributable approval metadata",
      });
    }
  });
export type V2WorkPlanVersionT = z.infer<typeof V2WorkPlanVersion>;

const attributedNarrative = z
  .object({
    id: V2EntityId,
    summary: V2NonEmptyString,
    rationale: V2NonEmptyString,
  })
  .strict();

export const V2ConversationHandoffPackage = z
  .object({
    approved_plan_version_id: V2EntityId,
    approved_plan_content_hash: V2Sha256Hex,
    approved_plan: V2WorkPlanContract,
    objective: V2NonEmptyString,
    binding_rules: z.array(V2NonEmptyString),
    human_decisions: z.array(attributedNarrative),
    qc_findings_and_dispositions: z.array(attributedNarrative),
    unresolved_risks_and_questions: z.array(V2NonEmptyString),
    task_sequence: z.array(V2EntityId).min(1),
    staffing: z.array(
      z
        .object({
          module_id: V2EntityId,
          agent_role: V2NonEmptyString,
          provider: V2NonEmptyString,
          model: V2NonEmptyString,
        })
        .strict(),
    ),
    budget: z
      .object({
        currency: z.string().regex(/^[A-Z]{3}$/),
        amount: z.number().nonnegative(),
      })
      .strict(),
    required_mockup_artifact_ids: z.array(V2EntityId),
    acceptance_evidence: z.array(V2NonEmptyString),
    artifact_ids: z.array(V2EntityId),
    phase_ids: z.array(V2EntityId),
    task_ids: z.array(V2EntityId),
    repository_binding_ids: z.array(V2EntityId),
  })
  .strict()
  .superRefine((handoff, ctx) => {
    if (handoff.objective !== handoff.approved_plan.plan.objective) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["objective"],
        message: "handoff objective must exactly project the approved plan objective",
      });
    }
    if (JSON.stringify(handoff.staffing) !== JSON.stringify(handoff.approved_plan.staffing)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["staffing"],
        message: "handoff staffing must exactly project the approved plan staffing",
      });
    }
    if (JSON.stringify(handoff.budget) !== JSON.stringify(handoff.approved_plan.estimated_budget)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["budget"],
        message: "handoff budget must exactly project the approved plan budget",
      });
    }
    const plannedTaskSequence = handoff.approved_plan.plan.modules.map((module) => module.id);
    if (JSON.stringify(handoff.task_sequence) !== JSON.stringify(plannedTaskSequence)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["task_sequence"],
        message: "handoff task sequence must follow the approved plan module order",
      });
    }
  });

export const V2ConversationHandoff = z
  .object({
    schema_version: schemaVersion,
    id: V2EntityId,
    project_id: V2EntityId,
    work_item_id: V2EntityId,
    source_conversation_id: V2EntityId,
    target_conversation_id: V2EntityId,
    approved_plan_version_id: V2EntityId,
    created_by_user_id: V2EntityId,
    kind: z.literal("planning_to_execution"),
    package: V2ConversationHandoffPackage,
    content_hash: V2Sha256Hex,
    created_at: V2IsoDateTime,
  })
  .strict()
  .refine((handoff) => handoff.source_conversation_id !== handoff.target_conversation_id, {
    path: ["target_conversation_id"],
    message: "handoff source and target conversations must differ",
  });
export type V2ConversationHandoffT = z.infer<typeof V2ConversationHandoff>;

export const V2ConversationSummaryContent = z
  .object({
    objective: V2NonEmptyString,
    constraints: z.array(V2NonEmptyString),
    decisions: z.array(attributedNarrative),
    risks: z.array(V2NonEmptyString),
    open_questions: z.array(V2NonEmptyString),
    artifact_ids: z.array(V2EntityId),
  })
  .strict();

export const V2ConversationSummary = z
  .object({
    schema_version: schemaVersion,
    id: V2EntityId,
    project_id: V2EntityId,
    work_item_id: V2EntityId,
    conversation_id: V2EntityId,
    created_by_user_id: V2EntityId,
    version: z.number().int().positive(),
    from_message_sequence: z.number().int().positive(),
    through_message_sequence: z.number().int().positive(),
    summary: V2ConversationSummaryContent,
    content_hash: V2Sha256Hex,
    created_at: V2IsoDateTime,
  })
  .strict()
  .refine((summary) => summary.through_message_sequence >= summary.from_message_sequence, {
    path: ["through_message_sequence"],
    message: "summary sequence range must be ordered",
  });
export type V2ConversationSummaryT = z.infer<typeof V2ConversationSummary>;

export const V2CreateWorkItemInput = z
  .object({
    project_id: V2EntityId,
    title: V2NonEmptyString,
    objective: V2NonEmptyString,
  })
  .strict();
export type V2CreateWorkItemInputT = z.infer<typeof V2CreateWorkItemInput>;

export const V2CreateWorkConversationInput = z
  .object({
    project_id: V2EntityId,
    work_item_id: V2EntityId,
    kind: V2WorkConversationKind,
    provider: V2NonEmptyString,
    model: V2NonEmptyString,
  })
  .strict();
export type V2CreateWorkConversationInputT = z.infer<typeof V2CreateWorkConversationInput>;

export const V2SubmitWorkMessageInput = z
  .object({
    project_id: V2EntityId,
    work_item_id: V2EntityId,
    conversation_id: V2EntityId,
    client_message_id: V2EntityId,
    parts: z.array(V2WorkMessagePart).min(1),
  })
  .strict();
export type V2SubmitWorkMessageInputT = z.infer<typeof V2SubmitWorkMessageInput>;

export const V2ProposeConversationActionInput = z
  .object({
    project_id: V2EntityId,
    work_item_id: V2EntityId,
    conversation_id: V2EntityId,
    source_message_id: V2EntityId,
    action_type: V2ConversationActionType,
    payload: V2ConversationActionPayload,
  })
  .strict();
export type V2ProposeConversationActionInputT = z.infer<typeof V2ProposeConversationActionInput>;

export const V2ConfirmConversationActionInput = z
  .object({
    project_id: V2EntityId,
    work_item_id: V2EntityId,
    conversation_id: V2EntityId,
    action_id: V2EntityId,
    idempotency_key: V2EntityId,
  })
  .strict();
export type V2ConfirmConversationActionInputT = z.infer<typeof V2ConfirmConversationActionInput>;
