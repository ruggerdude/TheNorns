import { z } from "zod";
import { PlanContract, PlanModule, validatePlan } from "../plan.js";
import { FindingResponse, ReviewFinding } from "../review.js";
import {
  V2Actor,
  V2EntityId,
  V2EvidenceRef,
  V2GitCommitSha,
  V2IsoDateTime,
  V2NonEmptyString,
  V2PositiveVersion,
  V2Sha256Hex,
  V2_HUMAN_WAIT_INSTRUCTION_HASH,
} from "./common.js";

const schemaVersion = z.literal(2);
const nullableDate = V2IsoDateTime.nullable();
const nonNegativeInteger = z.number().int().nonnegative();
const visibleContentString = z
  .string()
  .refine(
    (value) => /\S/u.test(value.replace(/(?:\u200B|\u200C|\u200D|\u2060|\uFEFF)/gu, "")),
    "visible content cannot be blank or zero-width-only",
  );

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

export const V2ConversationFolder = z
  .object({
    schema_version: schemaVersion,
    id: V2EntityId,
    project_id: V2EntityId,
    user_id: V2EntityId,
    name: z.string().trim().min(1).max(80),
    sort_order: nonNegativeInteger,
    created_at: V2IsoDateTime,
    updated_at: V2IsoDateTime,
  })
  .strict();
export type V2ConversationFolderT = z.infer<typeof V2ConversationFolder>;

export const V2WorkItemOrganization = z
  .object({
    schema_version: schemaVersion,
    project_id: V2EntityId,
    user_id: V2EntityId,
    work_item_id: V2EntityId,
    folder_id: V2EntityId.nullable(),
    pinned_at: nullableDate,
    created_at: V2IsoDateTime,
    updated_at: V2IsoDateTime,
  })
  .strict();
export type V2WorkItemOrganizationT = z.infer<typeof V2WorkItemOrganization>;

export const V2ConversationNavigationConversation = z
  .object({
    id: V2EntityId,
    kind: V2WorkConversationKind,
    status: V2WorkConversationStatus,
    provider: V2NonEmptyString,
    model: V2NonEmptyString,
  })
  .strict();

export const V2ConversationNavigationItem = z
  .object({
    schema_version: schemaVersion,
    id: V2EntityId,
    project_id: V2EntityId,
    title: V2NonEmptyString,
    status: V2WorkItemStatus,
    folder_id: V2EntityId.nullable(),
    pinned_at: nullableDate,
    latest_activity_at: V2IsoDateTime,
    conversation_count: nonNegativeInteger,
    latest_conversation: V2ConversationNavigationConversation.nullable(),
  })
  .strict();
export type V2ConversationNavigationItemT = z.infer<typeof V2ConversationNavigationItem>;

export const V2ConversationNavigationPage = z
  .object({
    folders: z.array(V2ConversationFolder),
    items: z.array(V2ConversationNavigationItem),
    next_cursor: V2NonEmptyString.nullable(),
  })
  .strict();
export type V2ConversationNavigationPageT = z.infer<typeof V2ConversationNavigationPage>;

export const V2ConversationMessageBranch = z
  .object({
    schema_version: schemaVersion,
    id: V2EntityId,
    project_id: V2EntityId,
    work_item_id: V2EntityId,
    child_conversation_id: V2EntityId,
    parent_conversation_id: V2EntityId,
    source_message_id: V2EntityId,
    created_by_user_id: V2EntityId,
    created_at: V2IsoDateTime,
  })
  .strict();
export type V2ConversationMessageBranchT = z.infer<typeof V2ConversationMessageBranch>;

export const V2MessageTextPart = z
  .object({
    type: z.literal("text"),
    format: z.enum(["plain", "markdown"]),
    text: visibleContentString,
  })
  .strict();

export const V2MessageCodePart = z
  .object({
    type: z.literal("code"),
    code: visibleContentString,
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

export const V2MessageHandoffPart = z
  .object({
    type: z.literal("handoff"),
    handoff_id: V2EntityId,
  })
  .strict();

export const V2MessagePlanningExcerptPart = z
  .object({
    type: z.literal("planning_excerpt"),
    excerpt_receipt_id: V2EntityId,
  })
  .strict();

export const V2MessageHumanWaitPart = z
  .object({
    type: z.literal("human_wait"),
    human_wait_id: V2EntityId,
  })
  .strict();

export const V2MessageHumanWaitUpdatePart = z
  .object({
    type: z.literal("human_wait_update"),
    human_wait_id: V2EntityId,
    status: z.enum(["continuation_queued", "resumed", "expired", "cancelled", "failed"]),
  })
  .strict();

export const V2MessageMockupPart = z
  .object({
    type: z.literal("mockup"),
    mockup_version_id: V2EntityId,
  })
  .strict();

export const V2MessageImplementationVisualEvidencePart = z
  .object({
    type: z.literal("implementation_visual_evidence"),
    visual_evidence_id: V2EntityId,
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
  V2MessageHandoffPart,
  V2MessagePlanningExcerptPart,
  V2MessageHumanWaitPart,
  V2MessageHumanWaitUpdatePart,
  V2MessageMockupPart,
  V2MessageImplementationVisualEvidencePart,
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
      "prompt",
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
      "planning_excerpt",
      "task_package",
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
  "record_human_decision",
  "propose_plan_change",
  "approve_plan_change",
  "answer_human_wait",
  "create_mockup",
  "approve_mockup",
  "revise_mockup",
  "reject_mockup",
]);
export type V2ConversationActionTypeT = z.infer<typeof V2ConversationActionType>;

export const V2ConversationInteractionClass = z.enum([
  "discussion",
  "human_decision",
  "task_direction",
  "plan_change_proposal",
  "approval",
  "pause",
  "resume",
  "mockup_request",
]);
export type V2ConversationInteractionClassT = z.infer<typeof V2ConversationInteractionClass>;

export const V2_CONVERSATION_ACTION_INTERACTION_CLASS = {
  save_plan_candidate: "plan_change_proposal",
  send_plan_to_qc: "approval",
  request_plan_changes: "plan_change_proposal",
  approve_plan: "approval",
  reject_plan: "approval",
  pause_work: "pause",
  resume_work: "resume",
  redirect_agent: "task_direction",
  record_human_decision: "human_decision",
  propose_plan_change: "plan_change_proposal",
  approve_plan_change: "approval",
  answer_human_wait: "human_decision",
  create_mockup: "mockup_request",
  approve_mockup: "approval",
  revise_mockup: "mockup_request",
  reject_mockup: "approval",
} as const satisfies Record<V2ConversationActionTypeT, V2ConversationInteractionClassT>;

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
    interaction_class: V2ConversationInteractionClass.optional(),
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
    const expectedInteractionClass = V2_CONVERSATION_ACTION_INTERACTION_CLASS[action.action_type];
    if (
      action.interaction_class !== undefined &&
      action.interaction_class !== expectedInteractionClass
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["interaction_class"],
        message: "interaction_class must match action_type exactly",
      });
    }
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
  })
  .transform((action) => ({
    ...action,
    interaction_class: V2_CONVERSATION_ACTION_INTERACTION_CLASS[action.action_type],
  }));
export type V2ConversationActionT = z.infer<typeof V2ConversationAction>;

const boundedDirection = z.string().trim().min(1).max(8_000);
const boundedRationale = z.string().trim().min(1).max(4_000);

export const V2RecordHumanDecisionParameters = z
  .object({
    decision_point: z.string().trim().min(1).max(500),
    decision: z.string().trim().min(1).max(4_000),
    rationale: boundedRationale,
    task_id: V2EntityId.nullable().optional(),
  })
  .strict();

export const V2RedirectAgentParameters = z
  .object({
    task_id: V2EntityId,
    run_id: V2EntityId,
    direction: boundedDirection,
    delivery_preference: z.literal("live_or_checkpoint"),
  })
  .strict();

export const V2ProposePlanChangeParameters = z
  .object({
    plan_version_id: V2EntityId,
    plan_hash: V2Sha256Hex,
    direction: boundedDirection,
    rationale: boundedRationale,
  })
  .strict();

export const V2ApprovePlanChangeParameters = z
  .object({
    proposal_action_id: V2EntityId,
    plan_version_id: V2EntityId,
    plan_hash: V2Sha256Hex,
  })
  .strict();

export const V2PauseWorkParameters = z
  .object({
    reason: boundedRationale,
    task_id: V2EntityId.nullable().optional(),
  })
  .strict();

export const V2ResumeWorkParameters = z
  .object({
    reason: z.string().trim().min(1).max(4_000).nullable().optional(),
    task_id: V2EntityId.nullable().optional(),
  })
  .strict();

export const V2CreateMockupParameters = z
  .object({
    brief: boundedDirection,
    target: z.enum(["desktop", "mobile", "responsive"]),
    task_id: V2EntityId.nullable().optional(),
    plan_version_id: V2EntityId.nullable().optional(),
    module_id: V2EntityId.nullable().optional(),
    artifact_refs: z.array(V2EntityId).max(32),
  })
  .strict()
  .superRefine((parameters, ctx) => {
    if (new Set(parameters.artifact_refs).size !== parameters.artifact_refs.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["artifact_refs"],
        message: "mockup artifact references must be distinct",
      });
    }
    const hasPlan = parameters.plan_version_id != null || parameters.module_id != null;
    const hasTask = parameters.task_id != null;
    if (hasPlan && (parameters.plan_version_id == null || parameters.module_id == null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["module_id"],
        message: "planning mockup targets require both plan_version_id and module_id",
      });
    }
    if (hasTask && hasPlan) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["task_id"],
        message: "mockup targets either an execution task or a planning module, not both",
      });
    }
  });

export const V2ApproveMockupParameters = z
  .object({
    mockup_version_id: V2EntityId,
    task_id: V2EntityId.nullable().optional(),
    plan_version_id: V2EntityId.nullable().optional(),
    module_id: V2EntityId.nullable().optional(),
    manifest_artifact_id: V2EntityId,
    manifest_artifact_hash: V2Sha256Hex,
  })
  .strict()
  .superRefine((parameters, ctx) => {
    const hasTask = parameters.task_id != null;
    const hasPlan = parameters.plan_version_id != null || parameters.module_id != null;
    if (hasPlan && (parameters.plan_version_id == null || parameters.module_id == null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["module_id"],
        message: "planning mockup approvals require both plan_version_id and module_id",
      });
    }
    if (hasTask === hasPlan) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["task_id"],
        message: "approval must identify exactly one execution task or planning module target",
      });
    }
  });

export const V2ReviseMockupParameters = z
  .object({
    mockup_version_id: V2EntityId,
    manifest_artifact_id: V2EntityId,
    manifest_artifact_hash: V2Sha256Hex,
    direction: boundedDirection,
  })
  .strict();

export const V2RejectMockupParameters = z
  .object({
    mockup_version_id: V2EntityId,
    manifest_artifact_id: V2EntityId,
    manifest_artifact_hash: V2Sha256Hex,
    reason: boundedRationale,
  })
  .strict();

export const V2MockupArtifactUploadInput = z.discriminatedUnion("media_type", [
  z
    .object({
      project_id: V2EntityId,
      work_item_id: V2EntityId,
      conversation_id: V2EntityId,
      media_type: z.literal("image/png"),
      purpose: z.enum([
        "mockup_desktop",
        "mockup_mobile",
        "implementation_desktop",
        "implementation_mobile",
      ]),
      content_hash: V2Sha256Hex,
      byte_size: z
        .number()
        .int()
        .positive()
        .max(10 * 1024 * 1024),
      idempotency_key: V2EntityId,
    })
    .strict(),
  z
    .object({
      project_id: V2EntityId,
      work_item_id: V2EntityId,
      conversation_id: V2EntityId,
      media_type: z.literal("application/json"),
      purpose: z.enum(["mockup_manifest", "visual_comparison", "deployment_evidence"]),
      content_hash: V2Sha256Hex,
      byte_size: z
        .number()
        .int()
        .positive()
        .max(1024 * 1024),
      idempotency_key: V2EntityId,
    })
    .strict(),
]);
export type V2MockupArtifactUploadInputT = z.infer<typeof V2MockupArtifactUploadInput>;

export const V2ProjectArtifactQuotaReceipt = z
  .object({
    project_id: V2EntityId,
    limit_bytes: z.number().int().safe().positive(),
    used_bytes_before: z.number().int().safe().nonnegative(),
    requested_bytes: z.number().int().safe().nonnegative(),
    allowed: z.boolean(),
  })
  .strict()
  .superRefine((receipt, ctx) => {
    if (
      receipt.allowed !==
      receipt.used_bytes_before + receipt.requested_bytes <= receipt.limit_bytes
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["allowed"],
        message: "quota outcome must match the authoritative project byte total",
      });
    }
  });
export type V2ProjectArtifactQuotaReceiptT = z.infer<typeof V2ProjectArtifactQuotaReceipt>;

export const V2MockupViewport = z.enum(["desktop", "mobile"]);
export type V2MockupViewportT = z.infer<typeof V2MockupViewport>;

export const V2MockupRendererProfile = z
  .object({
    renderer: z.literal("norns-deterministic-v1"),
    renderer_revision: V2Sha256Hex,
    font_revision: V2Sha256Hex,
    pixel_ratio: z.literal(1),
    network: z.literal("disabled"),
    scripts: z.literal("disabled"),
    locale: z.literal("en-US"),
    timezone: z.literal("UTC"),
    fixed_clock: V2IsoDateTime,
    seed: V2Sha256Hex,
  })
  .strict();
export type V2MockupRendererProfileT = z.infer<typeof V2MockupRendererProfile>;

export const V2MockupScreenshot = z
  .object({
    viewport: V2MockupViewport,
    artifact: V2EvidenceRef,
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    capture_profile: V2MockupRendererProfile,
  })
  .strict();
export type V2MockupScreenshotT = z.infer<typeof V2MockupScreenshot>;

function refineExactMockupScreenshots(
  screenshots: readonly [
    V2MockupScreenshotT & { viewport: "desktop" },
    V2MockupScreenshotT & { viewport: "mobile" },
  ],
  rendererProfile: V2MockupRendererProfileT,
  ctx: z.RefinementCtx,
): void {
  if (
    screenshots[0].width !== 1440 ||
    screenshots[0].height !== 1024 ||
    screenshots[1].width !== 390 ||
    screenshots[1].height !== 844
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["screenshots"],
      message: "mockup screenshots must use the fixed 1440x1024 and 390x844 viewports",
    });
  }
  if (screenshots[0].artifact.artifact_id === screenshots[1].artifact.artifact_id) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["screenshots"],
      message: "desktop and mobile screenshots require distinct artifacts",
    });
  }
  for (const [index, screenshot] of screenshots.entries()) {
    if (screenshot.artifact.media_type !== "image/png") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["screenshots", index, "artifact", "media_type"],
        message: "mockup screenshots must be PNG images",
      });
    }
    if (JSON.stringify(screenshot.capture_profile) !== JSON.stringify(rendererProfile)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["screenshots", index, "capture_profile"],
        message: "every screenshot must use the exact deterministic renderer profile",
      });
    }
  }
}

export const V2MockupManifest = z
  .object({
    schema_version: schemaVersion,
    kind: z.literal("mockup"),
    mockup_version_id: V2EntityId,
    root_request_id: V2EntityId,
    request_id: V2EntityId,
    task_id: V2EntityId.nullable(),
    plan_version_id: V2EntityId.nullable().default(null),
    module_id: V2EntityId.nullable().default(null),
    version: V2PositiveVersion,
    brief: boundedDirection,
    target: z.enum(["desktop", "mobile", "responsive"]),
    interaction_notes: z.array(V2NonEmptyString).min(1).max(32),
    renderer_profile: V2MockupRendererProfile,
    screenshots: z.tuple([
      V2MockupScreenshot.extend({ viewport: z.literal("desktop") }).strict(),
      V2MockupScreenshot.extend({ viewport: z.literal("mobile") }).strict(),
    ]),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    refineExactMockupScreenshots(manifest.screenshots, manifest.renderer_profile, ctx);
  });
export type V2MockupManifestT = z.infer<typeof V2MockupManifest>;

export const V2ConversationMockupVersionStatus = z.enum([
  "candidate",
  "approved",
  "revision_requested",
  "rejected",
  "superseded",
]);
export type V2ConversationMockupVersionStatusT = z.infer<typeof V2ConversationMockupVersionStatus>;

export const V2ConversationMockupVersion = z
  .object({
    schema_version: schemaVersion,
    id: V2EntityId,
    root_request_id: V2EntityId,
    request_id: V2EntityId,
    project_id: V2EntityId,
    work_item_id: V2EntityId,
    conversation_id: V2EntityId,
    task_id: V2EntityId.nullable(),
    plan_version_id: V2EntityId.nullable().default(null),
    module_id: V2EntityId.nullable().default(null),
    created_by_action_id: V2EntityId,
    version: V2PositiveVersion,
    status: V2ConversationMockupVersionStatus,
    brief: boundedDirection,
    target: z.enum(["desktop", "mobile", "responsive"]),
    interaction_notes: z.array(V2NonEmptyString).min(1).max(32),
    manifest: V2EvidenceRef,
    renderer_profile: V2MockupRendererProfile,
    screenshots: z.tuple([
      V2MockupScreenshot.extend({ viewport: z.literal("desktop") }).strict(),
      V2MockupScreenshot.extend({ viewport: z.literal("mobile") }).strict(),
    ]),
    supersedes_mockup_version_id: V2EntityId.nullable(),
    created_at: V2IsoDateTime,
  })
  .strict()
  .superRefine((version, ctx) => {
    if ((version.version === 1) !== (version.supersedes_mockup_version_id === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["supersedes_mockup_version_id"],
        message: "only the first mockup version can omit its superseded version",
      });
    }
    const artifactIds = new Set([
      version.manifest.artifact_id,
      ...version.screenshots.map((screenshot) => screenshot.artifact.artifact_id),
    ]);
    if (artifactIds.size !== 3) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["screenshots"],
        message: "manifest, desktop, and mobile artifacts must be distinct",
      });
    }
    if (version.manifest.media_type !== "application/json") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["manifest", "media_type"],
        message: "the immutable mockup manifest must be JSON",
      });
    }
    refineExactMockupScreenshots(version.screenshots, version.renderer_profile, ctx);
  });
export type V2ConversationMockupVersionT = z.infer<typeof V2ConversationMockupVersion>;

export const V2ConversationMockupDecision = z
  .object({
    schema_version: schemaVersion,
    id: V2EntityId,
    project_id: V2EntityId,
    work_item_id: V2EntityId,
    conversation_id: V2EntityId,
    mockup_version_id: V2EntityId,
    action_id: V2EntityId,
    decided_by_user_id: V2EntityId,
    decision: z.enum(["approved", "revision_requested", "rejected"]),
    manifest_artifact_id: V2EntityId,
    manifest_artifact_hash: V2Sha256Hex,
    rationale: boundedRationale.nullable(),
    direction: boundedDirection.nullable(),
    created_at: V2IsoDateTime,
  })
  .strict()
  .superRefine((decision, ctx) => {
    if ((decision.decision === "revision_requested") !== (decision.direction !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["direction"],
        message: "only revision requests require direction",
      });
    }
    if (decision.decision !== "rejected" && decision.rationale !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rationale"],
        message: "only rejection carries a decision rationale",
      });
    }
    if (decision.decision === "rejected" && decision.rationale === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rationale"],
        message: "rejection requires an attributable rationale",
      });
    }
  });
export type V2ConversationMockupDecisionT = z.infer<typeof V2ConversationMockupDecision>;

export const V2ApprovedMockupTaskSupplementContent = z
  .object({
    schema_version: schemaVersion,
    kind: z.literal("approved_mockup"),
    mockup_version_id: V2EntityId,
    manifest_artifact_id: V2EntityId,
    manifest_artifact_hash: V2Sha256Hex,
    approval: z
      .object({
        decision_id: V2EntityId,
        action_id: V2EntityId,
        decided_by_user_id: V2EntityId,
        decided_at: V2IsoDateTime,
      })
      .strict(),
    brief: boundedDirection,
    target: z.enum(["desktop", "mobile", "responsive"]),
    interaction_notes: z.array(V2NonEmptyString).min(1).max(32),
    renderer_profile: V2MockupRendererProfile,
    screenshots: z.tuple([
      V2MockupScreenshot.extend({ viewport: z.literal("desktop") }).strict(),
      V2MockupScreenshot.extend({ viewport: z.literal("mobile") }).strict(),
    ]),
    implementation_visual_evidence_requirement: z
      .object({
        manifest_path: z.literal(".norns/visual-evidence.json"),
        producer: z.literal("playwright"),
        approved_mockup_version_id: V2EntityId,
        required_captures: z.tuple([
          z
            .object({
              viewport: z.literal("desktop"),
              width: z.literal(1440),
              height: z.literal(1024),
              media_type: z.literal("image/png"),
            })
            .strict(),
          z
            .object({
              viewport: z.literal("mobile"),
              width: z.literal(390),
              height: z.literal(844),
              media_type: z.literal("image/png"),
            })
            .strict(),
        ]),
        capture_profile: z
          .object({
            renderer: z.literal("playwright"),
            pixel_ratio: z.literal(1),
            network: z.literal("application_only"),
            locale: z.literal("en-US"),
            timezone: z.literal("UTC"),
          })
          .strict(),
        manifest_schema: z
          .object({
            root_keys: z.tuple([
              z.literal("schema_version"),
              z.literal("approved_mockup_version_id"),
              z.literal("capture_profile"),
              z.literal("screenshots"),
            ]),
            capture_profile_keys: z.tuple([
              z.literal("renderer"),
              z.literal("browser_name"),
              z.literal("browser_version"),
              z.literal("font_revision"),
              z.literal("pixel_ratio"),
              z.literal("network"),
              z.literal("locale"),
              z.literal("timezone"),
              z.literal("fixed_clock"),
            ]),
            screenshot_keys: z.tuple([
              z.literal("viewport"),
              z.literal("path"),
              z.literal("content_hash"),
            ]),
            manifest_template: z
              .object({
                schema_version: z.literal(2),
                approved_mockup_version_id: V2EntityId,
                capture_profile: z
                  .object({
                    renderer: z.literal("playwright"),
                    browser_name: z.literal("<non-empty Playwright browser name>"),
                    browser_version: z.literal("<non-empty Playwright browser version>"),
                    font_revision: z.literal(
                      "<64 lowercase hex SHA-256 of the exact loaded font profile>",
                    ),
                    pixel_ratio: z.literal(1),
                    network: z.literal("application_only"),
                    locale: z.literal("en-US"),
                    timezone: z.literal("UTC"),
                    fixed_clock: z.literal("<one ISO-8601 UTC instant frozen for both captures>"),
                  })
                  .strict(),
                screenshots: z.tuple([
                  z
                    .object({
                      viewport: z.literal("desktop"),
                      path: z.literal(".norns/visual-evidence/desktop-1440x1024.png"),
                      content_hash: z.literal("<64 lowercase hex SHA-256 of this PNG's bytes>"),
                    })
                    .strict(),
                  z
                    .object({
                      viewport: z.literal("mobile"),
                      path: z.literal(".norns/visual-evidence/mobile-390x844.png"),
                      content_hash: z.literal("<64 lowercase hex SHA-256 of this PNG's bytes>"),
                    })
                    .strict(),
                ]),
              })
              .strict(),
          })
          .strict(),
        production_rules: z.tuple([
          z.literal(
            "Use Playwright to capture the implemented application at exactly 1440x1024 and 390x844 with deviceScaleFactor 1.",
          ),
          z.literal(
            "Replace every angle-bracket placeholder in the template with the observed value; do not add or omit manifest keys.",
          ),
          z.literal(
            "Compute each content_hash from the exact PNG file bytes using lowercase SHA-256.",
          ),
          z.literal(
            "Commit the manifest and both ordinary, non-symlink PNG files in the same implementation commit before verification and deployment.",
          ),
        ]),
        commit_policy: z.literal(
          "manifest_and_pngs_must_be_regular_files_in_the_verified_implementation_commit",
        ),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((content, ctx) => {
    refineExactMockupScreenshots(content.screenshots, content.renderer_profile, ctx);
    const artifactIds = new Set([
      content.manifest_artifact_id,
      ...content.screenshots.map((screenshot) => screenshot.artifact.artifact_id),
    ]);
    if (artifactIds.size !== 3) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["screenshots"],
        message: "manifest, desktop, and mobile supplement artifacts must be distinct",
      });
    }
    if (
      content.implementation_visual_evidence_requirement &&
      content.implementation_visual_evidence_requirement.approved_mockup_version_id !==
        content.mockup_version_id
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["implementation_visual_evidence_requirement", "approved_mockup_version_id"],
        message: "visual evidence production must target this exact approved mockup version",
      });
    }
  });
export type V2ApprovedMockupTaskSupplementContentT = z.infer<
  typeof V2ApprovedMockupTaskSupplementContent
>;

export const V2ConversationTaskPackageSupplement = z
  .object({
    schema_version: schemaVersion,
    id: V2EntityId,
    project_id: V2EntityId,
    work_item_id: V2EntityId,
    conversation_id: V2EntityId,
    task_id: V2EntityId,
    base_package_id: V2EntityId,
    ordinal: V2PositiveVersion,
    source_mockup_version_id: V2EntityId,
    approval_decision_id: V2EntityId,
    manifest_artifact_id: V2EntityId,
    manifest_artifact_hash: V2Sha256Hex,
    supplement: V2ApprovedMockupTaskSupplementContent,
    canonical_supplement: V2NonEmptyString,
    content_hash: V2Sha256Hex,
    context_ref: z
      .object({
        context_document_id: V2EntityId,
        content_hash: V2Sha256Hex,
        byte_size: z.number().int().positive(),
        media_type: z.literal("application/json"),
      })
      .strict(),
    created_at: V2IsoDateTime,
  })
  .strict()
  .superRefine((supplement, ctx) => {
    if (supplement.content_hash !== supplement.context_ref.content_hash) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["context_ref", "content_hash"],
        message: "supplement bytes and context receipt must have the same hash",
      });
    }
    let canonical: unknown;
    try {
      canonical = JSON.parse(supplement.canonical_supplement);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["canonical_supplement"],
        message: "canonical supplement must be valid JSON",
      });
      return;
    }
    const stableJson = (value: unknown): string => {
      if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
      if (value !== null && typeof value === "object") {
        return `{${Object.entries(value as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
          .join(",")}}`;
      }
      return JSON.stringify(value) ?? "null";
    };
    const expectedCanonical = stableJson(supplement.supplement);
    if (
      stableJson(canonical) !== expectedCanonical ||
      supplement.canonical_supplement !== expectedCanonical
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["canonical_supplement"],
        message: "canonical supplement must represent the exact structured supplement",
      });
    }
    if (
      supplement.supplement.mockup_version_id !== supplement.source_mockup_version_id ||
      supplement.supplement.manifest_artifact_id !== supplement.manifest_artifact_id ||
      supplement.supplement.manifest_artifact_hash !== supplement.manifest_artifact_hash ||
      supplement.supplement.approval.decision_id !== supplement.approval_decision_id
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["supplement"],
        message: "supplement must bind its exact approved mockup manifest",
      });
    }
  });
export type V2ConversationTaskPackageSupplementT = z.infer<
  typeof V2ConversationTaskPackageSupplement
>;

export const V2ConversationTaskPackageSupplementDispatchReceipt = z
  .object({
    schema_version: schemaVersion,
    command_id: V2EntityId,
    run_id: V2EntityId,
    project_id: V2EntityId,
    phase_id: V2EntityId,
    task_id: V2EntityId,
    base_package_id: V2EntityId,
    supplement_id: V2EntityId,
    ordinal: V2PositiveVersion,
    content_hash: V2Sha256Hex,
    context_document_id: V2EntityId,
    context_ref: z
      .object({
        artifact_id: V2EntityId,
        content_hash: V2Sha256Hex,
        byte_size: z.number().int().nonnegative(),
        storage_ref: V2NonEmptyString,
      })
      .strict(),
    created_at: V2IsoDateTime,
  })
  .strict()
  .superRefine((receipt, ctx) => {
    if (
      receipt.content_hash !== receipt.context_ref.content_hash ||
      receipt.context_document_id !== receipt.context_ref.artifact_id
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["context_ref", "content_hash"],
        message: "dispatch receipt must identify the exact supplement bytes",
      });
    }
  });
export type V2ConversationTaskPackageSupplementDispatchReceiptT = z.infer<
  typeof V2ConversationTaskPackageSupplementDispatchReceipt
>;

export const V2ImplementationCaptureProfile = z
  .object({
    renderer: z.literal("playwright"),
    browser_name: V2NonEmptyString,
    browser_version: V2NonEmptyString,
    font_revision: V2Sha256Hex,
    pixel_ratio: z.literal(1),
    network: z.literal("application_only"),
    locale: z.literal("en-US"),
    timezone: z.literal("UTC"),
    fixed_clock: V2IsoDateTime,
  })
  .strict();
export type V2ImplementationCaptureProfileT = z.infer<typeof V2ImplementationCaptureProfile>;

export const V2ImplementationScreenshot = z
  .object({
    viewport: V2MockupViewport,
    artifact: V2EvidenceRef,
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    capture_profile: V2ImplementationCaptureProfile,
  })
  .strict();

const visualComparisonPairFields = {
  mockup_artifact_id: V2EntityId,
  mockup_artifact_hash: V2Sha256Hex,
  implementation_artifact_id: V2EntityId,
  implementation_artifact_hash: V2Sha256Hex,
} as const;

export const V2VisualComparisonReceipt = z
  .object({
    schema_version: schemaVersion,
    kind: z.literal("visual_comparison"),
    implementation_visual_evidence_id: V2EntityId,
    approved_mockup_version_id: V2EntityId,
    commit_sha: V2GitCommitSha,
    comparisons: z.tuple([
      z.object({ viewport: z.literal("desktop"), ...visualComparisonPairFields }).strict(),
      z.object({ viewport: z.literal("mobile"), ...visualComparisonPairFields }).strict(),
    ]),
  })
  .strict()
  .superRefine((receipt, ctx) => {
    for (const [index, pair] of receipt.comparisons.entries()) {
      if (pair.mockup_artifact_id === pair.implementation_artifact_id) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["comparisons", index, "implementation_artifact_id"],
          message: "comparison sides must identify distinct immutable artifacts",
        });
      }
    }
  });
export type V2VisualComparisonReceiptT = z.infer<typeof V2VisualComparisonReceipt>;

export const V2ImplementationVisualEvidence = z
  .object({
    schema_version: schemaVersion,
    id: V2EntityId,
    project_id: V2EntityId,
    work_item_id: V2EntityId,
    conversation_id: V2EntityId,
    phase_id: V2EntityId,
    task_id: V2EntityId,
    run_id: V2EntityId,
    approved_mockup_version_id: V2EntityId,
    repository_binding_id: V2EntityId,
    verification_result_id: V2EntityId,
    deployment_record_id: V2EntityId,
    deployment_observation_id: V2EntityId,
    commit_sha: V2GitCommitSha,
    capture_profile: V2ImplementationCaptureProfile,
    screenshots: z.tuple([
      V2ImplementationScreenshot.extend({ viewport: z.literal("desktop") }).strict(),
      V2ImplementationScreenshot.extend({ viewport: z.literal("mobile") }).strict(),
    ]),
    comparison_artifact: V2EvidenceRef.nullable(),
    verified_at: V2IsoDateTime,
    created_at: V2IsoDateTime,
  })
  .strict()
  .superRefine((evidence, ctx) => {
    if (
      evidence.screenshots[0].artifact.artifact_id === evidence.screenshots[1].artifact.artifact_id
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["screenshots"],
        message: "desktop and mobile evidence require distinct artifacts",
      });
    }
    for (const [index, screenshot] of evidence.screenshots.entries()) {
      if (screenshot.artifact.media_type !== "image/png") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["screenshots", index, "artifact", "media_type"],
          message: "delivered visual evidence must be PNG",
        });
      }
      if (JSON.stringify(screenshot.capture_profile) !== JSON.stringify(evidence.capture_profile)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["screenshots", index, "capture_profile"],
          message: "delivered screenshots must use the evidence capture profile",
        });
      }
    }
    if (
      evidence.comparison_artifact !== null &&
      evidence.comparison_artifact.media_type !== "application/json"
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["comparison_artifact", "media_type"],
        message: "visual comparison receipts must be JSON",
      });
    }
    if (
      evidence.screenshots[0].width !== 1440 ||
      evidence.screenshots[0].height !== 1024 ||
      evidence.screenshots[1].width !== 390 ||
      evidence.screenshots[1].height !== 844
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["screenshots"],
        message: "delivered evidence uses the fixed desktop and mobile viewports",
      });
    }
  });
export type V2ImplementationVisualEvidenceT = z.infer<typeof V2ImplementationVisualEvidence>;

export const V2AnswerHumanWaitParameters = z
  .object({
    wait_id: V2EntityId,
    expected_version: V2PositiveVersion,
    question_hash: V2Sha256Hex,
    answer: boundedDirection,
    rationale: z.string().trim().min(1).max(4_000).nullable().optional(),
  })
  .strict();

export const V2ConversationDeliveryMode = z.enum(["live", "checkpoint", "continuation"]);
export const V2ConversationDeliveryReceipt = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("confirmation"), fingerprint: V2Sha256Hex }).strict(),
  z.object({ kind: z.literal("recorded"), record_id: V2EntityId }).strict(),
  z.object({ kind: z.literal("sent"), outbox_id: V2EntityId }).strict(),
  z.object({ kind: z.literal("agent_ack"), ack_event_id: V2EntityId }).strict(),
  z.object({ kind: z.literal("applied"), context_receipt_hash: V2Sha256Hex }).strict(),
  z.object({ kind: z.literal("failed"), failure_code: V2NonEmptyString }).strict(),
  z.object({ kind: z.literal("fallback_queued"), reason: V2NonEmptyString }).strict(),
]);
export const V2ConversationDeliveryEventStatus = z.union([
  V2ConversationActionStatus,
  z.literal("fallback_queued"),
]);
export const V2ConversationActionDeliveryEvent = z
  .object({
    schema_version: schemaVersion,
    id: V2EntityId,
    project_id: V2EntityId,
    work_item_id: V2EntityId,
    conversation_id: V2EntityId,
    action_id: V2EntityId,
    sequence: V2PositiveVersion,
    status: V2ConversationDeliveryEventStatus,
    delivery_mode: V2ConversationDeliveryMode,
    target_run_id: V2EntityId.nullable(),
    target_command_id: V2EntityId.nullable(),
    receipt: V2ConversationDeliveryReceipt,
    occurred_at: V2IsoDateTime,
  })
  .strict()
  .superRefine((event, ctx) => {
    const receiptStatus = {
      confirmation: "confirmed",
      recorded: "recorded",
      sent: "sent",
      agent_ack: "agent_acknowledged",
      applied: "applied",
      failed: "failed",
      fallback_queued: "fallback_queued",
    } as const;
    if (receiptStatus[event.receipt.kind] !== event.status) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["receipt"],
        message: "delivery receipt kind must truthfully match the recorded action status",
      });
    }
  });
export type V2ConversationActionDeliveryEventT = z.infer<typeof V2ConversationActionDeliveryEvent>;

export const V2HumanWaitStatus = z.enum([
  "awaiting_human",
  "answered",
  "continuation_queued",
  "resumed",
  "expired",
  "cancelled",
  "failed",
]);
export const V2HumanWait = z
  .object({
    schema_version: schemaVersion,
    id: V2EntityId,
    project_id: V2EntityId,
    work_item_id: V2EntityId,
    conversation_id: V2EntityId,
    phase_id: V2EntityId,
    task_id: V2EntityId,
    source_run_id: V2EntityId,
    source_event_id: V2EntityId,
    decision_point: z.string().trim().min(1).max(500),
    question: boundedDirection,
    question_hash: V2Sha256Hex,
    published: z
      .object({
        branch: V2NonEmptyString,
        commit_sha: V2GitCommitSha,
        remote: V2NonEmptyString,
      })
      .strict(),
    runtime: z
      .object({
        runtime_id: V2NonEmptyString,
        session_id: V2NonEmptyString.nullable(),
        session_portability: z.enum(["transcript_only", "same_runner", "cross_runner_verified"]),
        session_portability_evidence: V2NonEmptyString.nullable(),
      })
      .strict(),
    context: z
      .object({
        root_command_id: V2EntityId,
        ask_channel_version: z.literal(1),
        ask_instruction_hash: z.literal(V2_HUMAN_WAIT_INSTRUCTION_HASH),
        root_context_refs: z
          .array(
            z
              .object({
                artifact_id: V2EntityId,
                content_hash: V2Sha256Hex,
                byte_size: nonNegativeInteger,
                storage_ref: V2NonEmptyString,
              })
              .strict(),
          )
          .min(1),
        context_hash: V2Sha256Hex,
        task_package_hash: V2Sha256Hex.nullable(),
        compact_summary: z.string().trim().min(1).max(16_000),
        compact_summary_hash: V2Sha256Hex,
      })
      .strict(),
    budget: z
      .object({
        reservation_id: V2EntityId,
        root_run_id: V2EntityId,
      })
      .strict(),
    status: V2HumanWaitStatus,
    version: V2PositiveVersion,
    expires_at: V2IsoDateTime,
    answered_at: nullableDate,
    resumed_at: nullableDate,
    created_at: V2IsoDateTime,
    updated_at: V2IsoDateTime,
  })
  .strict()
  .superRefine((wait, ctx) => {
    const answered = ["answered", "continuation_queued", "resumed"].includes(wait.status);
    if (
      !["failed", "cancelled"].includes(wait.status) &&
      answered !== (wait.answered_at !== null)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["answered_at"],
        message: "answered and continuation states require answered_at",
      });
    }
    if ((wait.status === "resumed") !== (wait.resumed_at !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["resumed_at"],
        message: "resumed_at is present exactly for resumed waits",
      });
    }
    const resumable = wait.runtime.session_portability !== "transcript_only";
    if (resumable !== (wait.runtime.session_portability_evidence !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["runtime", "session_portability_evidence"],
        message: "resumable sessions require explicit portability evidence",
      });
    }
    if (resumable && wait.runtime.session_id === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["runtime", "session_id"],
        message: "resumable session classification requires a captured session ID",
      });
    }
  });
export type V2HumanWaitT = z.infer<typeof V2HumanWait>;

export const V2HumanWaitAnswer = z
  .object({
    schema_version: schemaVersion,
    id: V2EntityId,
    wait_id: V2EntityId,
    project_id: V2EntityId,
    answered_by_user_id: V2EntityId,
    action_id: V2EntityId,
    idempotency_key: V2EntityId,
    request_fingerprint: V2Sha256Hex,
    answer: boundedDirection,
    rationale: z.string().trim().min(1).max(4_000).nullable(),
    answer_receipt_hash: V2Sha256Hex,
    created_at: V2IsoDateTime,
  })
  .strict();
export type V2HumanWaitAnswerT = z.infer<typeof V2HumanWaitAnswer>;

export const V2HumanWaitContinuationStatus = z.enum([
  "queued",
  "leased",
  "provisioned",
  "dispatched",
  "acknowledged",
  "applied",
  "failed",
]);
export const V2HumanWaitContinuation = z
  .object({
    schema_version: schemaVersion,
    id: V2EntityId,
    wait_id: V2EntityId,
    answer_id: V2EntityId,
    root_run_id: V2EntityId,
    resume_command_id: V2EntityId,
    resume_job_id: V2EntityId,
    budget_reservation_id: V2EntityId,
    saved_commit_sha: V2GitCommitSha,
    context_hash: V2Sha256Hex,
    answer_receipt_hash: V2Sha256Hex,
    replay_context_ref: z
      .object({
        artifact_id: V2EntityId,
        content_hash: V2Sha256Hex,
        byte_size: nonNegativeInteger,
        storage_ref: V2NonEmptyString,
      })
      .strict(),
    runner_id: V2EntityId.nullable(),
    runner_generation: nonNegativeInteger.nullable(),
    delivery_receipt_hash: V2Sha256Hex.nullable(),
    status: V2HumanWaitContinuationStatus,
    created_at: V2IsoDateTime,
    updated_at: V2IsoDateTime,
  })
  .strict();
export type V2HumanWaitContinuationT = z.infer<typeof V2HumanWaitContinuation>;

export const V2ConversationPmContentLevel = z.enum(["concise", "standard", "detailed"]);
export const V2ConversationPmUpdateSettings = z
  .object({
    project_id: V2EntityId,
    update_interval_seconds: z.number().int().min(60).max(86_400),
    content_level: V2ConversationPmContentLevel,
    interval_inherited: z.boolean(),
    content_level_inherited: z.boolean(),
    updated_at: V2IsoDateTime.nullable(),
  })
  .strict();
export type V2ConversationPmUpdateSettingsT = z.infer<typeof V2ConversationPmUpdateSettings>;

export const V2ConversationPmUpdate = z
  .object({
    schema_version: schemaVersion,
    id: V2EntityId,
    project_id: V2EntityId,
    work_item_id: V2EntityId,
    conversation_id: V2EntityId,
    transition_sequence: z.number().int().positive(),
    state_hash: V2Sha256Hex,
    status: z.enum(["working", "waiting_for_human", "blocked", "completed"]),
    content: V2NonEmptyString,
    created_at: V2IsoDateTime,
  })
  .strict();
export type V2ConversationPmUpdateT = z.infer<typeof V2ConversationPmUpdate>;

export const V2WorkPlanStaffingChoice = z
  .object({
    module_id: V2EntityId,
    agent_role: V2NonEmptyString,
    provider: z.enum(["anthropic", "openai"]),
    model: V2NonEmptyString,
  })
  .strict();

export const V2PlanExecutionAgent = z
  .object({
    provider: z.enum(["anthropic", "openai"]),
    model: V2NonEmptyString,
  })
  .strict();
export type V2PlanExecutionAgentT = z.infer<typeof V2PlanExecutionAgent>;

export const V2PlanReviewPreference = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("qc"),
      reviewer: z
        .object({
          provider: z.enum(["anthropic", "openai"]),
          model: V2NonEmptyString,
        })
        .strict(),
      rounds: z.number().int().min(1).max(5),
    })
    .strict(),
  z.object({ mode: z.literal("skip_qc") }).strict(),
]);
export type V2PlanReviewPreferenceT = z.infer<typeof V2PlanReviewPreference>;

export const V2PlanHandoffPreference = z
  .object({
    execution_agent: V2PlanExecutionAgent,
    review: V2PlanReviewPreference,
  })
  .strict();
export type V2PlanHandoffPreferenceT = z.infer<typeof V2PlanHandoffPreference>;

export const V2WorkPlanContract = z
  .object({
    plan: PlanContract.strict(),
    staffing: z.array(V2WorkPlanStaffingChoice).min(1),
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
    created_by_action_id: V2EntityId.nullable(),
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

export const V2SavePlanCandidateParameters = z
  .object({
    plan: V2WorkPlanContract,
    handoff: V2PlanHandoffPreference.optional(),
    predecessor_plan_version_id: V2EntityId.nullable(),
    predecessor_content_hash: V2Sha256Hex.nullable(),
    referenced_artifacts: z
      .array(
        z
          .object({
            id: V2EntityId,
            content_hash: V2Sha256Hex,
          })
          .strict(),
      )
      .default([]),
  })
  .strict()
  .refine(
    (input) =>
      (input.predecessor_plan_version_id === null) === (input.predecessor_content_hash === null),
    {
      path: ["predecessor_content_hash"],
      message: "predecessor id and content hash must be present together",
    },
  );
export type V2SavePlanCandidateParametersT = z.infer<typeof V2SavePlanCandidateParameters>;

const planVersionReferenceParameters = {
  plan_version_id: V2EntityId,
  content_hash: V2Sha256Hex,
};

export const V2SendPlanToQcParameters = z
  .object({
    ...planVersionReferenceParameters,
    review: V2PlanReviewPreference.optional(),
  })
  .strict();
export type V2SendPlanToQcParametersT = z.infer<typeof V2SendPlanToQcParameters>;

export const V2RequestPlanChangesParameters = z
  .object({
    ...planVersionReferenceParameters,
    direction: z.string().trim().min(1).max(2_000),
  })
  .strict();
export type V2RequestPlanChangesParametersT = z.infer<typeof V2RequestPlanChangesParameters>;

export const V2ApprovePlanParameters = z
  .object({
    ...planVersionReferenceParameters,
    plan_review_id: V2EntityId,
  })
  .strict();
export type V2ApprovePlanParametersT = z.infer<typeof V2ApprovePlanParameters>;

export const V2RejectPlanParameters = z
  .object({
    ...planVersionReferenceParameters,
    reason: V2NonEmptyString.nullable(),
  })
  .strict();
export type V2RejectPlanParametersT = z.infer<typeof V2RejectPlanParameters>;

export const V2ConversationPlanReviewStatus = z.enum([
  "queued",
  "running",
  "converged",
  "cap_reached",
  "failed",
  "cancelled",
]);
export type V2ConversationPlanReviewStatusT = z.infer<typeof V2ConversationPlanReviewStatus>;

export const V2ConversationPlanReviewContextEntry = z
  .object({
    kind: z.enum(["global_rules", "project_rules", "project_knowledge", "decision", "artifact"]),
    ref: V2EntityId,
    content_hash: V2Sha256Hex,
  })
  .strict();

export const V2ConversationPlanReviewContextManifest = z
  .object({
    entries: z.array(V2ConversationPlanReviewContextEntry),
    context_hash: V2Sha256Hex,
  })
  .strict();

export const V2ConversationPlanReviewFinding = z
  .object({
    id: V2EntityId,
    index: nonNegativeInteger,
    severity: z.enum(["must_fix", "should_fix", "suggestion"]),
    module_id: V2EntityId.nullable(),
    finding: V2NonEmptyString,
    recommendation: V2NonEmptyString,
  })
  .strict();
export type V2ConversationPlanReviewFindingT = z.infer<typeof V2ConversationPlanReviewFinding>;

export const V2ConversationPlanReviewDisposition = z
  .object({
    finding_id: V2EntityId,
    finding_index: nonNegativeInteger,
    disposition: z.enum(["accept", "rebut"]),
    rationale: V2NonEmptyString,
  })
  .strict();
export type V2ConversationPlanReviewDispositionT = z.infer<
  typeof V2ConversationPlanReviewDisposition
>;

export const V2ConversationPlanReviewRound = z
  .object({
    round: z.number().int().positive(),
    reviewed_plan_content_hash: V2Sha256Hex,
    reviewer: z
      .object({
        provider: z.enum(["anthropic", "openai"]),
        model: V2NonEmptyString,
        findings: z.array(ReviewFinding),
      })
      .strict(),
    pm: z
      .object({
        provider: z.enum(["anthropic", "openai"]),
        model: V2NonEmptyString,
        dispositions: z.array(FindingResponse),
        revised_plan_content_hash: V2Sha256Hex,
      })
      .strict()
      .nullable(),
  })
  .strict();
export type V2ConversationPlanReviewRoundT = z.infer<typeof V2ConversationPlanReviewRound>;

export const V2ConversationPlanReview = z
  .object({
    schema_version: schemaVersion,
    id: V2EntityId,
    project_id: V2EntityId,
    work_item_id: V2EntityId,
    conversation_id: V2EntityId,
    action_id: V2EntityId,
    plan_version_id: V2EntityId,
    planning_run_id: V2EntityId,
    initiated_by_user_id: V2EntityId,
    attempt_number: z.number().int().positive(),
    pm_provider: z.enum(["anthropic", "openai"]),
    pm_model: V2NonEmptyString,
    reviewer_provider: z.enum(["anthropic", "openai"]),
    reviewer_model: V2NonEmptyString,
    review_mode: z.enum(["qc", "waived"]).optional(),
    usage_request_group_id: V2EntityId,
    status: V2ConversationPlanReviewStatus,
    rounds_completed: nonNegativeInteger,
    max_rounds: z.number().int().min(1).max(5),
    round_exchanges: z.array(V2ConversationPlanReviewRound),
    plan_content_hash: V2Sha256Hex,
    result_plan_content_hash: V2Sha256Hex,
    context_manifest: V2ConversationPlanReviewContextManifest,
    findings: z.array(V2ConversationPlanReviewFinding),
    dispositions: z.array(V2ConversationPlanReviewDisposition),
    revised_plan_version_id: V2EntityId.nullable(),
    started_at: nullableDate,
    completed_at: nullableDate,
    failure_code: V2NonEmptyString.nullable(),
    cancelled_by_user_id: V2EntityId.nullable(),
    cancellation_reason: V2NonEmptyString.nullable(),
    created_at: V2IsoDateTime,
    updated_at: V2IsoDateTime,
  })
  .strict()
  .superRefine((review, ctx) => {
    const terminal = ["converged", "cap_reached", "failed", "cancelled"].includes(review.status);
    if (terminal !== (review.completed_at !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["completed_at"],
        message: "terminal plan reviews require completed_at",
      });
    }
    const validTiming =
      (review.status === "queued" && review.started_at === null && review.completed_at === null) ||
      (review.status === "running" && review.started_at !== null && review.completed_at === null) ||
      (review.status === "failed" && review.completed_at !== null) ||
      (review.status === "cancelled" && review.completed_at !== null) ||
      (["converged", "cap_reached"].includes(review.status) &&
        review.started_at !== null &&
        review.completed_at !== null);
    if (!validTiming) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["started_at"],
        message: "plan review timing must match its lifecycle state",
      });
    }
    if ((review.status === "failed") !== (review.failure_code !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["failure_code"],
        message: "only failed plan reviews carry a failure code",
      });
    }
    const cancelled = review.status === "cancelled";
    if (
      cancelled !== (review.cancelled_by_user_id !== null && review.cancellation_reason !== null)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cancelled_by_user_id"],
        message: "cancelled reviews require an attributable human and reason",
      });
    }
    if (review.rounds_completed > review.max_rounds) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rounds_completed"],
        message: "completed rounds cannot exceed the configured QC round cap",
      });
    }
    if (review.round_exchanges.length > review.rounds_completed + 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["round_exchanges"],
        message: "QC transcript cannot run ahead of durable round progress",
      });
    }
    for (const [index, exchange] of review.round_exchanges.entries()) {
      if (exchange.round !== index + 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["round_exchanges", index, "round"],
          message: "QC transcript rounds must be contiguous and ordered",
        });
      }
      if (
        exchange.reviewer.provider !== review.reviewer_provider ||
        exchange.reviewer.model !== review.reviewer_model
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["round_exchanges", index, "reviewer"],
          message: "QC transcript reviewer must match the pinned reviewer",
        });
      }
      if (
        exchange.pm !== null &&
        (exchange.pm.provider !== review.pm_provider || exchange.pm.model !== review.pm_model)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["round_exchanges", index, "pm"],
          message: "QC transcript PM must match the pinned planning agent",
        });
      }
    }
    if (review.pm_provider === review.reviewer_provider) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reviewer_provider"],
        message: "plan QC requires an opposite-provider reviewer",
      });
    }
    const findingIds = new Set<string>();
    const findingIndices = new Set<number>();
    const findingById = new Map<string, z.infer<typeof V2ConversationPlanReviewFinding>>();
    for (const finding of review.findings) {
      if (findingIds.has(finding.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["findings"],
          message: "plan review finding ids must be unique",
        });
      }
      if (findingIndices.has(finding.index)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["findings"],
          message: "plan review finding indices must be unique",
        });
      }
      findingIds.add(finding.id);
      findingIndices.add(finding.index);
      findingById.set(finding.id, finding);
    }
    const dispositionIds = new Set<string>();
    const dispositionIndices = new Set<number>();
    for (const disposition of review.dispositions) {
      if (
        dispositionIds.has(disposition.finding_id) ||
        dispositionIndices.has(disposition.finding_index)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["dispositions"],
          message: "each finding can have only one disposition",
        });
      }
      dispositionIds.add(disposition.finding_id);
      dispositionIndices.add(disposition.finding_index);
      const finding = findingById.get(disposition.finding_id);
      if (!finding || finding.index !== disposition.finding_index) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["dispositions"],
          message: "dispositions must reference the exact finding id and index",
        });
      }
    }
    if (["converged", "cap_reached"].includes(review.status)) {
      const undisposedMustFix = review.findings.filter(
        (finding) => finding.severity === "must_fix" && !dispositionIds.has(finding.id),
      );
      if (undisposedMustFix.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["dispositions"],
          message: "every must-fix finding requires an attributable disposition",
        });
      }
      if (
        review.status === "cap_reached" &&
        !review.findings.some((finding) => finding.severity === "must_fix")
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["findings"],
          message: "cap-reached reviews must retain their must-fix finding evidence",
        });
      }
    }
    const hasRevision = review.revised_plan_version_id !== null;
    if (hasRevision !== (review.result_plan_content_hash !== review.plan_content_hash)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["revised_plan_version_id"],
        message: "a changed QC result must identify its materialized revision version",
      });
    }
    if (
      ["queued", "running", "failed", "cancelled"].includes(review.status) &&
      (hasRevision || review.result_plan_content_hash !== review.plan_content_hash)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["revised_plan_version_id"],
        message: "non-terminal-success reviews cannot expose revision evidence",
      });
    }
    if (
      ["queued", "running", "failed", "cancelled"].includes(review.status) &&
      (review.findings.length > 0 || review.dispositions.length > 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["findings"],
        message: "queued, running, and failed reviews cannot expose QC result evidence",
      });
    }
  });
export type V2ConversationPlanReviewT = z.infer<typeof V2ConversationPlanReview>;

export const V2ConversationPlanExecution = z
  .object({
    status: z.enum(["pending", "started", "refused", "failed"]),
    started: z.boolean().nullable(),
    detail: V2NonEmptyString.nullable(),
  })
  .strict()
  .superRefine((execution, ctx) => {
    if (
      execution.status === "pending" &&
      (execution.started !== null || execution.detail !== null)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["started"],
        message: "pending execution has no outcome",
      });
    }
    if (
      execution.status !== "pending" &&
      (execution.started === null || execution.detail === null)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["started"],
        message: "settled execution requires its outcome",
      });
    }
    if (
      (execution.status === "started" && execution.started !== true) ||
      (["refused", "failed"].includes(execution.status) && execution.started !== false)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["started"],
        message: "execution status and started outcome must agree",
      });
    }
  });
export type V2ConversationPlanExecutionT = z.infer<typeof V2ConversationPlanExecution>;

export const V2ConversationPlanActionEffectValue = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("plan_saved"),
        plan_version: V2WorkPlanVersion,
      })
      .strict(),
    z
      .object({
        kind: z.literal("qc_started"),
        plan_review: V2ConversationPlanReview,
        planning_run_id: V2EntityId,
      })
      .strict(),
    z
      .object({
        kind: z.literal("changes_requested"),
        plan_version: V2WorkPlanVersion,
      })
      .strict(),
    z
      .object({
        kind: z.literal("plan_approved"),
        plan_version: V2WorkPlanVersion,
        plan_review_id: V2EntityId,
        planning_run_id: V2EntityId,
        transition_status: z.enum(["created", "legacy_unavailable"]),
        execution_conversation_id: V2EntityId.nullable(),
        handoff_id: V2EntityId.nullable(),
        kickoff_intent_id: V2EntityId.nullable(),
        execution: V2ConversationPlanExecution,
      })
      .strict(),
    z
      .object({
        kind: z.literal("plan_rejected"),
        plan_version: V2WorkPlanVersion,
      })
      .strict(),
  ])
  .superRefine((effect, ctx) => {
    if (effect.kind !== "plan_approved") return;
    const transitionIds = [
      effect.execution_conversation_id,
      effect.handoff_id,
      effect.kickoff_intent_id,
    ];
    const hasTransition = transitionIds.every((id) => id !== null);
    if (
      transitionIds.some((id) => id !== null) !== hasTransition ||
      (effect.transition_status === "created") !== hasTransition
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["transition_status"],
        message: "approval transition status must agree with all transition IDs",
      });
    }
  });
export type V2ConversationPlanActionEffectValueT = z.infer<
  typeof V2ConversationPlanActionEffectValue
>;

export const V2ConversationPlanActionEffect = z
  .object({
    schema_version: schemaVersion,
    id: V2EntityId,
    project_id: V2EntityId,
    work_item_id: V2EntityId,
    conversation_id: V2EntityId,
    action_id: V2EntityId,
    effect: V2ConversationPlanActionEffectValue,
    created_at: V2IsoDateTime,
    updated_at: V2IsoDateTime,
  })
  .strict();
export type V2ConversationPlanActionEffectT = z.infer<typeof V2ConversationPlanActionEffect>;

const attributedNarrative = z
  .object({
    id: V2EntityId,
    summary: V2NonEmptyString,
    rationale: V2NonEmptyString,
  })
  .strict();

export const V2ConversationHandoffContextReference = z
  .object({
    kind: z.enum([
      "approved_plan",
      "global_rules",
      "project_rules",
      "decision",
      "qc_review",
      "artifact",
      "phase",
      "task",
      "repository",
    ]),
    ref: V2EntityId,
    content_hash: V2Sha256Hex,
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
    context_manifest: z.array(V2ConversationHandoffContextReference),
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
    const manifestKeys = handoff.context_manifest.map(
      (reference) => `${reference.kind}:${reference.ref}`,
    );
    if (new Set(manifestKeys).size !== manifestKeys.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["context_manifest"],
        message: "handoff context references must be unique by kind and ref",
      });
    }
    const approvedPlanReferences = handoff.context_manifest.filter(
      (reference) => reference.kind === "approved_plan",
    );
    if (
      approvedPlanReferences.length !== 1 ||
      approvedPlanReferences[0]?.ref !== handoff.approved_plan_version_id ||
      approvedPlanReferences[0]?.content_hash !== handoff.approved_plan_content_hash
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["context_manifest"],
        message: "handoff manifest must bind the exact approved plan once",
      });
    }
  });
export type V2ConversationHandoffPackageT = z.infer<typeof V2ConversationHandoffPackage>;

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

export const V2ConversationTaskPackage = z
  .object({
    schema_version: schemaVersion,
    id: V2EntityId,
    project_id: V2EntityId,
    work_item_id: V2EntityId,
    conversation_id: V2EntityId,
    handoff_id: V2EntityId,
    approved_plan_version_id: V2EntityId,
    module_id: V2EntityId,
    package: z
      .object({
        approved_plan_version_id: V2EntityId,
        approved_plan_content_hash: V2Sha256Hex,
        objective: V2NonEmptyString,
        module: PlanModule.strict(),
        staffing: V2WorkPlanStaffingChoice,
        budget: z
          .object({
            currency: z.string().regex(/^[A-Z]{3}$/),
            amount: z.number().nonnegative(),
          })
          .strict(),
        binding_rules: z.array(V2NonEmptyString),
        human_decisions: z.array(attributedNarrative),
        artifact_ids: z.array(V2EntityId),
        repository_binding_ids: z.array(V2EntityId),
        context_manifest: z.array(V2ConversationHandoffContextReference),
      })
      .strict(),
    content_hash: V2Sha256Hex,
    created_at: V2IsoDateTime,
  })
  .strict()
  .superRefine((taskPackage, ctx) => {
    if (
      taskPackage.package.module.id !== taskPackage.module_id ||
      taskPackage.package.staffing.module_id !== taskPackage.module_id ||
      taskPackage.package.approved_plan_version_id !== taskPackage.approved_plan_version_id
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["package", "module"],
        message: "task package plan, module, and staffing must match its immutable scope",
      });
    }
    const approvedPlanReferences = taskPackage.package.context_manifest.filter(
      (reference) => reference.kind === "approved_plan",
    );
    if (
      approvedPlanReferences.length !== 1 ||
      approvedPlanReferences[0]?.ref !== taskPackage.approved_plan_version_id ||
      approvedPlanReferences[0]?.content_hash !== taskPackage.package.approved_plan_content_hash
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["package", "context_manifest"],
        message: "task package manifest must bind the exact approved plan once",
      });
    }
  });
export type V2ConversationTaskPackageT = z.infer<typeof V2ConversationTaskPackage>;

export const V2ConversationPlanningExcerptReceipt = z
  .object({
    schema_version: schemaVersion,
    id: V2EntityId,
    project_id: V2EntityId,
    work_item_id: V2EntityId,
    source_conversation_id: V2EntityId,
    target_conversation_id: V2EntityId,
    handoff_id: V2EntityId,
    requested_by_user_id: V2EntityId,
    idempotency_key: V2EntityId,
    request_fingerprint: V2Sha256Hex,
    source_message_ids: z.array(V2EntityId).min(1).max(20),
    source_message_hashes: z.array(V2Sha256Hex).min(1).max(20),
    result_message_id: V2EntityId,
    created_at: V2IsoDateTime,
  })
  .strict()
  .refine((receipt) => receipt.source_message_ids.length === receipt.source_message_hashes.length, {
    path: ["source_message_hashes"],
    message: "planning excerpt message IDs and hashes must align",
  });
export type V2ConversationPlanningExcerptReceiptT = z.infer<
  typeof V2ConversationPlanningExcerptReceipt
>;

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

export const V2ConversationUsage = z
  .object({
    input_tokens: nonNegativeInteger,
    output_tokens: nonNegativeInteger,
    cost_usd: z.number().nonnegative().nullable(),
    exact_cost: z.boolean(),
    usage_status: V2ConversationUsageStatus,
    attempt_count: nonNegativeInteger,
  })
  .strict()
  .superRefine((usage, ctx) => {
    if (usage.exact_cost !== (usage.usage_status === "exact")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["exact_cost"],
        message: "exact_cost must agree with usage_status",
      });
    }
    if ((usage.usage_status === "exact") !== (usage.cost_usd !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cost_usd"],
        message: "only exact aggregate usage exposes a cost",
      });
    }
  });
export type V2ConversationUsageT = z.infer<typeof V2ConversationUsage>;

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

export const V2CreateConversationFolderInput = z
  .object({
    name: z.string().trim().min(1).max(80),
  })
  .strict();
export type V2CreateConversationFolderInputT = z.infer<typeof V2CreateConversationFolderInput>;

export const V2UpdateConversationFolderInput = V2CreateConversationFolderInput;
export type V2UpdateConversationFolderInputT = z.infer<typeof V2UpdateConversationFolderInput>;

export const V2ReorderConversationFoldersInput = z
  .object({
    folder_ids: z
      .array(V2EntityId)
      .max(500)
      .refine((ids) => new Set(ids).size === ids.length, "folder_ids must be distinct"),
  })
  .strict();
export type V2ReorderConversationFoldersInputT = z.infer<typeof V2ReorderConversationFoldersInput>;

export const V2UpdateWorkItemOrganizationInput = z
  .object({
    folder_id: V2EntityId.nullable().optional(),
    pinned: z.boolean().optional(),
  })
  .strict()
  .refine(
    (input) => input.folder_id !== undefined || input.pinned !== undefined,
    "at least one organization field is required",
  );
export type V2UpdateWorkItemOrganizationInputT = z.infer<typeof V2UpdateWorkItemOrganizationInput>;

export const V2CreateConversationMessageBranchInput = z
  .object({
    source_message_id: V2EntityId,
  })
  .strict();
export type V2CreateConversationMessageBranchInputT = z.infer<
  typeof V2CreateConversationMessageBranchInput
>;

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
  .strict()
  .superRefine((input, ctx) => {
    const actionSchemas = {
      save_plan_candidate: V2SavePlanCandidateParameters,
      send_plan_to_qc: V2SendPlanToQcParameters,
      request_plan_changes: V2RequestPlanChangesParameters,
      approve_plan: V2ApprovePlanParameters,
      reject_plan: V2RejectPlanParameters,
      record_human_decision: V2RecordHumanDecisionParameters,
      redirect_agent: V2RedirectAgentParameters,
      propose_plan_change: V2ProposePlanChangeParameters,
      approve_plan_change: V2ApprovePlanChangeParameters,
      pause_work: V2PauseWorkParameters,
      resume_work: V2ResumeWorkParameters,
      create_mockup: V2CreateMockupParameters,
      approve_mockup: V2ApproveMockupParameters,
      revise_mockup: V2ReviseMockupParameters,
      reject_mockup: V2RejectMockupParameters,
      answer_human_wait: V2AnswerHumanWaitParameters,
    } as const;
    if (!(input.action_type in actionSchemas)) return;
    const schema = actionSchemas[input.action_type as keyof typeof actionSchemas] as z.ZodType;
    const parsed = schema.safeParse(input.payload.parameters);
    if (parsed.success) return;
    for (const issue of parsed.error.issues) {
      ctx.addIssue({
        ...issue,
        path: ["payload", "parameters", ...issue.path],
      });
    }
  });
export type V2ProposeConversationActionInputT = z.infer<typeof V2ProposeConversationActionInput>;

export const V2CreateExecutionActionProposalInput = z
  .object({
    idempotency_key: V2EntityId,
    message: boundedDirection,
    action_type: z.enum([
      "record_human_decision",
      "redirect_agent",
      "propose_plan_change",
      "approve_plan_change",
      "pause_work",
      "resume_work",
      "create_mockup",
      "approve_mockup",
      "revise_mockup",
      "reject_mockup",
    ]),
    payload: V2ConversationActionPayload,
  })
  .strict()
  .superRefine((input, ctx) => {
    const parsed = V2ProposeConversationActionInput.safeParse({
      project_id: "project",
      work_item_id: "work-item",
      conversation_id: "conversation",
      source_message_id: "server-generated-visible-message",
      action_type: input.action_type,
      payload: input.payload,
    });
    if (parsed.success) return;
    for (const issue of parsed.error.issues) {
      if (issue.path[0] !== "payload") continue;
      ctx.addIssue({ ...issue, path: issue.path });
    }
  });
export type V2CreateExecutionActionProposalInputT = z.infer<
  typeof V2CreateExecutionActionProposalInput
>;
export const V2CreateExecutionActionProposalResponse = z
  .object({ message: V2WorkMessage, action: V2ConversationAction })
  .strict();

export const V2CreateHumanWaitAnswerProposalInput = z
  .object({
    idempotency_key: V2EntityId,
    expected_version: V2PositiveVersion,
    question_hash: V2Sha256Hex,
    answer: boundedDirection,
    rationale: z.string().trim().min(1).max(4_000).nullable().optional(),
  })
  .strict();
export type V2CreateHumanWaitAnswerProposalInputT = z.infer<
  typeof V2CreateHumanWaitAnswerProposalInput
>;
export const V2CreateHumanWaitAnswerProposalResponse = z
  .object({ message: V2WorkMessage, action: V2ConversationAction })
  .strict();

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

export const V2ConversationExecutionActionEffectValue = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("delivery_queued"),
      delivery_mode: V2ConversationDeliveryMode,
      delivery_event: V2ConversationActionDeliveryEvent,
      target_run_id: V2EntityId.nullable(),
      target_command_id: V2EntityId.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("human_wait_answered"),
      wait: V2HumanWait,
      answer: V2HumanWaitAnswer,
      continuation: V2HumanWaitContinuation,
    })
    .strict(),
  z
    .object({
      kind: z.literal("state_mutation_recorded"),
      resource_type: z.enum(["project", "task", "plan_change", "mockup"]),
      resource_id: V2EntityId,
      state: V2NonEmptyString,
    })
    .strict(),
]);
export type V2ConversationExecutionActionEffectValueT = z.infer<
  typeof V2ConversationExecutionActionEffectValue
>;

export const V2ConfirmConversationActionResponse = z
  .object({
    action: V2ConversationAction,
    effect: z.union([
      V2ConversationPlanActionEffectValue,
      V2ConversationExecutionActionEffectValue,
    ]),
  })
  .strict();
export type V2ConfirmConversationActionResponseT = z.infer<
  typeof V2ConfirmConversationActionResponse
>;

export const V2ConfirmConversationPlanActionResponse = z
  .object({
    action: V2ConversationAction,
    effect: V2ConversationPlanActionEffectValue,
  })
  .strict();
export type V2ConfirmConversationPlanActionResponseT = z.infer<
  typeof V2ConfirmConversationPlanActionResponse
>;

export const V2CreateConversationPlanningExcerptInput = z
  .object({
    idempotency_key: V2EntityId,
    source_conversation_id: V2EntityId,
    message_ids: z.array(V2EntityId).min(1).max(20),
  })
  .strict()
  .refine((input) => new Set(input.message_ids).size === input.message_ids.length, {
    path: ["message_ids"],
    message: "planning excerpt message IDs must be unique",
  });
export type V2CreateConversationPlanningExcerptInputT = z.infer<
  typeof V2CreateConversationPlanningExcerptInput
>;

export const V2CreateConversationPlanProposalInput = z
  .object({
    idempotency_key: V2EntityId,
    intent_message: z.string().trim().min(1).max(200).optional(),
    handoff: V2PlanHandoffPreference.optional(),
  })
  .strict();
export type V2CreateConversationPlanProposalInputT = z.infer<
  typeof V2CreateConversationPlanProposalInput
>;

export const V2CreateConversationPlanProposalResponse = z
  .object({
    message: V2WorkMessage,
    action: V2ConversationAction,
  })
  .strict();
export type V2CreateConversationPlanProposalResponseT = z.infer<
  typeof V2CreateConversationPlanProposalResponse
>;

export const V2CreateConversationPlanChangeProposalInput = z
  .object({
    idempotency_key: V2EntityId,
    plan_version_id: V2EntityId,
    plan_hash: V2Sha256Hex,
    direction: z.string().trim().min(1).max(2_000),
  })
  .strict();
export type V2CreateConversationPlanChangeProposalInputT = z.infer<
  typeof V2CreateConversationPlanChangeProposalInput
>;

export const V2CreateConversationPlanChangeProposalResponse = z
  .object({
    message: V2WorkMessage,
    action: V2ConversationAction,
  })
  .strict();
export type V2CreateConversationPlanChangeProposalResponseT = z.infer<
  typeof V2CreateConversationPlanChangeProposalResponse
>;
