import { z } from "zod";
import {
  V2Actor,
  V2EntityId,
  V2IsoDateTime,
  V2NonEmptyString,
  V2PositiveVersion,
  V2Sha256Hex,
} from "./common.js";
import { V2DebateStoppingPolicy } from "./debate.js";
import { type V2StrategyVersionT, fingerprintV2StrategyImmutableContent } from "./domain.js";

const schemaVersion = z.literal(2);

export const V2CommandFamily = z.enum([
  "project",
  "phase",
  "strategy_approval",
  "task_execution",
  "decision_resolution",
  "human_direction",
  "budget",
  "integration",
  "debate",
]);
export type V2CommandFamilyT = z.infer<typeof V2CommandFamily>;

export const V2ApplicationCommandBase = z.object({
  schema_version: schemaVersion,
  command_id: V2EntityId,
  command_family: V2CommandFamily,
  actor: V2Actor,
  idempotency_key: V2NonEmptyString,
  correlation_id: V2EntityId,
  causation_id: V2EntityId.nullable(),
  issued_at: V2IsoDateTime,
});

export const V2ApproveStrategyVersionCommand = V2ApplicationCommandBase.extend({
  kind: z.literal("approve_strategy_version"),
  command_family: z.literal("strategy_approval"),
  actor: z
    .object({
      actor_type: z.literal("human"),
      actor_id: V2EntityId,
    })
    .strict(),
  project_id: V2EntityId,
  phase_id: V2EntityId,
  strategy_version_id: V2EntityId,
  expected_phase_version: V2PositiveVersion,
  expected_strategy_version: V2PositiveVersion,
  expected_strategy_aggregate_version: V2PositiveVersion,
  expected_content_hash: V2Sha256Hex,
}).strict();
export type V2ApproveStrategyVersionCommandT = z.infer<typeof V2ApproveStrategyVersionCommand>;

export const V2CreatePhaseCommand = V2ApplicationCommandBase.extend({
  kind: z.literal("create_phase"),
  command_family: z.literal("phase"),
  project_id: V2EntityId,
  objective_summary: V2NonEmptyString,
  priority: z.number().int().nonnegative(),
  predecessor_phase_ids: z.array(V2EntityId),
  expected_project_version: V2PositiveVersion,
}).strict();
export type V2CreatePhaseCommandT = z.infer<typeof V2CreatePhaseCommand>;

export const V2StartPhaseCommand = V2ApplicationCommandBase.extend({
  kind: z.literal("start_phase"),
  command_family: z.literal("phase"),
  project_id: V2EntityId,
  phase_id: V2EntityId,
  expected_project_version: V2PositiveVersion,
  expected_phase_version: V2PositiveVersion,
}).strict();
export type V2StartPhaseCommandT = z.infer<typeof V2StartPhaseCommand>;

export const V2RetryTaskCommand = V2ApplicationCommandBase.extend({
  kind: z.literal("retry_task"),
  command_family: z.literal("task_execution"),
  project_id: V2EntityId,
  phase_id: V2EntityId,
  task_id: V2EntityId,
  failed_run_id: V2EntityId,
  expected_task_version: V2PositiveVersion,
  retry_policy_ref: V2EntityId,
}).strict();
export type V2RetryTaskCommandT = z.infer<typeof V2RetryTaskCommand>;

/**
 * Actor-scoped application intent that atomically transitions a Task, reserves
 * budget, and creates the dispatch job/runner command. Its idempotency key is
 * independent of the runner envelope's command_id deduplication scope.
 */
export const V2ScheduleAgentRunCommand = V2ApplicationCommandBase.extend({
  kind: z.literal("schedule_agent_run"),
  command_family: z.literal("task_execution"),
  project_id: V2EntityId,
  phase_id: V2EntityId,
  task_id: V2EntityId,
  assignment_id: V2EntityId,
  run_id: V2EntityId,
  expected_task_version: V2PositiveVersion,
  expected_assignment_version: V2PositiveVersion,
  runner_id: V2EntityId,
  runner_generation: z.number().int().nonnegative(),
  repository_binding_id: V2EntityId,
  expected_revision: V2NonEmptyString,
  budget_reservation_id: V2EntityId,
  max_charge_usd: z.number().nonnegative(),
}).strict();
export type V2ScheduleAgentRunCommandT = z.infer<typeof V2ScheduleAgentRunCommand>;

export const V2CancelTaskCommand = V2ApplicationCommandBase.extend({
  kind: z.literal("cancel_task"),
  command_family: z.literal("task_execution"),
  project_id: V2EntityId,
  phase_id: V2EntityId,
  task_id: V2EntityId,
  expected_task_version: V2PositiveVersion,
  reason: V2NonEmptyString,
}).strict();
export type V2CancelTaskCommandT = z.infer<typeof V2CancelTaskCommand>;

export const V2ResolveDecisionPointCommand = V2ApplicationCommandBase.extend({
  kind: z.literal("resolve_decision_point"),
  command_family: z.literal("decision_resolution"),
  actor: z
    .object({
      actor_type: z.literal("human"),
      actor_id: V2EntityId,
    })
    .strict(),
  project_id: V2EntityId,
  decision_point_id: V2EntityId,
  expected_condition_fingerprint: V2Sha256Hex,
  selected_option_id: V2EntityId,
  rationale: V2NonEmptyString,
  direction_target: z.enum(["project_manager", "implementation_agent", "reviewer", "all_agents"]),
  direction_text: z.string().trim().max(10_000),
}).strict();
export type V2ResolveDecisionPointCommandT = z.infer<typeof V2ResolveDecisionPointCommand>;

export const V2RecordHumanDirectionCommand = V2ApplicationCommandBase.extend({
  kind: z.literal("record_human_direction"),
  command_family: z.literal("human_direction"),
  actor: z
    .object({
      actor_type: z.literal("human"),
      actor_id: V2EntityId,
    })
    .strict(),
  project_id: V2EntityId,
  phase_id: V2EntityId.nullable(),
  task_id: V2EntityId.nullable(),
  direction_target: z.enum(["project_manager", "implementation_agent", "reviewer", "all_agents"]),
  direction_text: V2NonEmptyString.max(10_000),
}).strict();
export type V2RecordHumanDirectionCommandT = z.infer<typeof V2RecordHumanDirectionCommand>;

export const V2DebateActorInput = z
  .object({
    actor_kind: z.enum(["participant", "judge", "synthesizer"]),
    role_label: V2NonEmptyString.max(200),
    display_name: V2NonEmptyString.max(200),
    instructions: V2NonEmptyString.max(100_000),
    provider: V2NonEmptyString.max(200),
    model: V2NonEmptyString.max(500),
    runtime: V2NonEmptyString.max(200),
    position: z.number().int().nonnegative(),
    max_turns: z.number().int().positive().max(200),
    max_input_tokens: z.number().int().positive(),
    max_output_tokens: z.number().int().positive(),
    budget_limit_usd: z.number().finite().nonnegative(),
  })
  .strict();
export type V2DebateActorInputT = z.infer<typeof V2DebateActorInput>;

export const V2DebateContextInput = z
  .object({
    label: V2NonEmptyString.max(500),
    artifact_id: V2EntityId.nullable(),
    artifact_content_hash: V2Sha256Hex.nullable(),
    artifact_media_type: V2NonEmptyString.nullable(),
    inline_content: z.string().max(100_000).nullable(),
  })
  .strict()
  .superRefine((context, ctx) => {
    const hasArtifact = context.artifact_id !== null;
    const completeArtifact =
      hasArtifact && context.artifact_content_hash !== null && context.artifact_media_type !== null;
    if (
      hasArtifact !== completeArtifact ||
      completeArtifact === (context.inline_content !== null)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["artifact_id"],
        message: "provide exactly one complete artifact reference or inline_content",
      });
    }
  });
export type V2DebateContextInputT = z.infer<typeof V2DebateContextInput>;

const V2DebateDefinitionFields = {
  title: V2NonEmptyString.max(500),
  question: V2NonEmptyString.max(100_000),
  phase_id: V2EntityId.nullable(),
  stopping_policy: V2DebateStoppingPolicy,
  actors: z.array(V2DebateActorInput).min(2).max(32),
  contexts: z.array(V2DebateContextInput).max(100),
};

function validateDebateActors(actors: V2DebateActorInputT[], ctx: z.RefinementCtx): void {
  const participants = actors.filter((actor) => actor.actor_kind === "participant");
  if (participants.length < 2) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["actors"],
      message: "a debate requires at least two participants",
    });
  }
  for (const optionalKind of ["judge", "synthesizer"] as const) {
    if (actors.filter((actor) => actor.actor_kind === optionalKind).length > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["actors"],
        message: `a debate allows at most one ${optionalKind}`,
      });
    }
  }
  const positions = actors.map((actor) => actor.position);
  if (new Set(positions).size !== positions.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["actors"],
      message: "debate actor positions must be unique",
    });
  }
}

const V2CreateDebateCommandObject = V2ApplicationCommandBase.extend({
  kind: z.literal("create_debate"),
  command_family: z.literal("debate"),
  project_id: V2EntityId,
  expected_project_version: V2PositiveVersion,
  ...V2DebateDefinitionFields,
}).strict();
export const V2CreateDebateCommand = V2CreateDebateCommandObject.superRefine((command, ctx) =>
  validateDebateActors(command.actors, ctx),
);
export type V2CreateDebateCommandT = z.infer<typeof V2CreateDebateCommand>;

export const V2StartDebateRunCommand = V2ApplicationCommandBase.extend({
  kind: z.literal("start_debate_run"),
  command_family: z.literal("debate"),
  project_id: V2EntityId,
  debate_id: V2EntityId,
  expected_debate_version: V2PositiveVersion,
}).strict();
export type V2StartDebateRunCommandT = z.infer<typeof V2StartDebateRunCommand>;

export const V2ControlDebateRunCommand = V2ApplicationCommandBase.extend({
  kind: z.literal("control_debate_run"),
  command_family: z.literal("debate"),
  project_id: V2EntityId,
  debate_id: V2EntityId,
  debate_run_id: V2EntityId,
  expected_run_version: V2PositiveVersion,
  action: z.enum(["pause", "resume", "cancel", "stop_after_turn", "stop_after_round"]),
  reason: V2NonEmptyString.max(10_000),
  ambiguity_disposition: z.enum(["assume_full_charge"]).nullable().optional(),
}).strict();
export type V2ControlDebateRunCommandT = z.infer<typeof V2ControlDebateRunCommand>;

export const V2InterveneDebateRunCommand = V2ApplicationCommandBase.extend({
  kind: z.literal("intervene_debate_run"),
  command_family: z.literal("debate"),
  actor: z
    .object({
      actor_type: z.literal("human"),
      actor_id: V2EntityId,
    })
    .strict(),
  project_id: V2EntityId,
  debate_id: V2EntityId,
  debate_run_id: V2EntityId,
  expected_run_version: V2PositiveVersion,
  intervention_kind: z.enum(["direction", "statement"]),
  target_actor_id: V2EntityId.nullable(),
  apply_at: z.enum(["next_turn", "next_round"]),
  text: V2NonEmptyString.max(100_000),
}).strict();
export type V2InterveneDebateRunCommandT = z.infer<typeof V2InterveneDebateRunCommand>;

export const V2ApplicationCommand = z
  .discriminatedUnion("kind", [
    V2CreatePhaseCommand,
    V2ApproveStrategyVersionCommand,
    V2StartPhaseCommand,
    V2RetryTaskCommand,
    V2ScheduleAgentRunCommand,
    V2CancelTaskCommand,
    V2ResolveDecisionPointCommand,
    V2RecordHumanDirectionCommand,
    V2CreateDebateCommandObject,
    V2StartDebateRunCommand,
    V2ControlDebateRunCommand,
    V2InterveneDebateRunCommand,
  ])
  .superRefine((command, ctx) => {
    if (command.kind === "create_debate") {
      validateDebateActors(command.actors, ctx);
    }
  });
export type V2ApplicationCommandT = z.infer<typeof V2ApplicationCommand>;

export const V2StrategyApprovalRejection = z.enum([
  "identity_mismatch",
  "phase_version_mismatch",
  "strategy_not_awaiting_approval",
  "strategy_not_converged",
  "unresolved_must_fix_finding",
  "stored_content_hash_mismatch",
  "expected_content_hash_mismatch",
  "approval_evidence_hash_mismatch",
  "already_approved",
]);
export type V2StrategyApprovalRejectionT = z.infer<typeof V2StrategyApprovalRejection>;

export type V2StrategyApprovalDecision =
  | { allowed: true; reasons: [] }
  | { allowed: false; reasons: V2StrategyApprovalRejectionT[] };

/**
 * Server-side approval invariant. There is intentionally no override input:
 * callers must produce a new converged StrategyVersion with every must-fix
 * finding resolved.
 */
export function validateV2StrategyApproval(
  strategy: V2StrategyVersionT,
  command: V2ApproveStrategyVersionCommandT,
  serverSha256: (canonicalContent: string) => string,
  actualPhaseAggregateVersion: number,
): V2StrategyApprovalDecision {
  const reasons: V2StrategyApprovalRejectionT[] = [];
  const computedContentHash = fingerprintV2StrategyImmutableContent(strategy, serverSha256);
  if (
    strategy.project_id !== command.project_id ||
    strategy.phase_id !== command.phase_id ||
    strategy.id !== command.strategy_version_id ||
    strategy.version !== command.expected_strategy_version ||
    strategy.aggregate_version !== command.expected_strategy_aggregate_version
  ) {
    reasons.push("identity_mismatch");
  }
  if (actualPhaseAggregateVersion !== command.expected_phase_version) {
    reasons.push("phase_version_mismatch");
  }
  if (strategy.status !== "awaiting_approval") {
    reasons.push("strategy_not_awaiting_approval");
  }
  if (strategy.convergence !== "converged") {
    reasons.push("strategy_not_converged");
  }
  if (
    strategy.findings.some(
      (finding) => finding.severity === "must_fix" && finding.status !== "resolved",
    )
  ) {
    reasons.push("unresolved_must_fix_finding");
  }
  if (strategy.content_hash !== computedContentHash) {
    reasons.push("stored_content_hash_mismatch");
  }
  if (command.expected_content_hash !== computedContentHash) {
    reasons.push("expected_content_hash_mismatch");
  }
  if (strategy.approval !== null && strategy.approval.content_hash !== computedContentHash) {
    reasons.push("approval_evidence_hash_mismatch");
  }
  if (strategy.approval !== null) {
    reasons.push("already_approved");
  }
  return reasons.length === 0 ? { allowed: true, reasons: [] } : { allowed: false, reasons };
}

export const V2ContentAddressedReference = z
  .object({
    artifact_id: V2EntityId,
    content_hash: V2Sha256Hex,
    byte_size: z.number().int().nonnegative(),
    storage_ref: V2NonEmptyString,
  })
  .strict();
export type V2ContentAddressedReferenceT = z.infer<typeof V2ContentAddressedReference>;

export function v2CommandIdForDispatchJob(dispatchJobId: string): string {
  return `dispatch:${dispatchJobId}`;
}

export const V2DispatchCommand = z
  .object({
    schema_version: schemaVersion,
    protocol_version: z.literal(2),
    kind: z.literal("launch_run"),
    dispatch_job_id: V2EntityId,
    command_id: V2EntityId,
    delivery_attempt: z.number().int().positive(),
    idempotency_key: V2NonEmptyString,
    correlation_id: V2EntityId,
    causation_id: V2EntityId.nullable(),
    project_id: V2EntityId,
    phase_id: V2EntityId,
    task_id: V2EntityId,
    assignment_id: V2EntityId,
    run_id: V2EntityId,
    runner_id: V2EntityId,
    runner_generation: z.number().int().nonnegative(),
    repository_binding_id: V2EntityId,
    // Runner-local repository identity, issued only by a paired runner during
    // folder validation.  Optional so legacy static binding deployments keep
    // their existing wire compatibility.
    runner_repository_id: V2EntityId.optional(),
    expected_revision: V2NonEmptyString,
    target_branch: V2NonEmptyString,
    worktree_policy_ref: V2EntityId,
    runtime: V2NonEmptyString,
    provider: V2NonEmptyString,
    model: V2NonEmptyString,
    context_refs: z.array(V2ContentAddressedReference).min(1),
    budget_reservation_id: V2EntityId,
    max_charge_usd: z.number().nonnegative(),
    max_input_tokens: z.number().int().nonnegative(),
    max_output_tokens: z.number().int().nonnegative(),
    max_duration_seconds: z.number().int().positive(),
    verification_policy_ref: V2EntityId,
    sandbox_policy_ref: V2EntityId,
    authorized_by: V2Actor,
    authorized_by_session_id: V2EntityId,
    issued_at: V2IsoDateTime,
    expires_at: V2IsoDateTime,
  })
  .strict()
  .superRefine((command, ctx) => {
    const stableCommandId = v2CommandIdForDispatchJob(command.dispatch_job_id);
    if (command.command_id !== stableCommandId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["command_id"],
        message: `command_id must be stable for its dispatch job (${stableCommandId})`,
      });
    }
    if (command.idempotency_key !== command.command_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["idempotency_key"],
        message: "runner idempotency_key must equal immutable command_id",
      });
    }
    if (Date.parse(command.expires_at) <= Date.parse(command.issued_at)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expires_at"],
        message: "expires_at must be after issued_at",
      });
    }
  });
export type V2DispatchCommandT = z.infer<typeof V2DispatchCommand>;

export const V2IdempotencyStatus = z.enum([
  "in_progress",
  "committed_succeeded",
  "committed_failed",
]);
export type V2IdempotencyStatusT = z.infer<typeof V2IdempotencyStatus>;
export const V2_IDEMPOTENCY_MIN_RETENTION_DAYS = 30;
const V2_IDEMPOTENCY_MIN_RETENTION_MS = V2_IDEMPOTENCY_MIN_RETENTION_DAYS * 24 * 60 * 60 * 1000;

export const V2CommandResponseEnvelope = z
  .object({
    outcome: z.enum(["succeeded", "failed"]),
    retriable: z.boolean(),
    http_status: z.number().int().min(100).max(599),
    body: z.unknown(),
    committed_at: V2IsoDateTime,
  })
  .strict()
  .superRefine((response, ctx) => {
    if (response.outcome === "succeeded" && response.retriable) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["retriable"],
        message: "a succeeded command response cannot be retriable",
      });
    }
  });
export type V2CommandResponseEnvelopeT = z.infer<typeof V2CommandResponseEnvelope>;

export const V2IdempotencyRecord = z
  .object({
    schema_version: schemaVersion,
    actor_id: V2EntityId,
    command_family: V2CommandFamily,
    idempotency_key: V2NonEmptyString,
    request_fingerprint: V2Sha256Hex,
    command_id: V2EntityId,
    status: V2IdempotencyStatus,
    response: V2CommandResponseEnvelope.nullable(),
    created_at: V2IsoDateTime,
    updated_at: V2IsoDateTime,
    retain_until: V2IsoDateTime,
    asynchronous_work_until: V2IsoDateTime.nullable(),
    rollback_window_until: V2IsoDateTime.nullable(),
  })
  .strict()
  .superRefine((record, ctx) => {
    if (
      Date.parse(record.retain_until) <
      Date.parse(record.created_at) + V2_IDEMPOTENCY_MIN_RETENTION_MS
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["retain_until"],
        message: `idempotency records require at least ${V2_IDEMPOTENCY_MIN_RETENTION_DAYS} days retention`,
      });
    }
    for (const [field, horizon] of [
      ["asynchronous_work_until", record.asynchronous_work_until],
      ["rollback_window_until", record.rollback_window_until],
    ] as const) {
      if (horizon !== null && Date.parse(record.retain_until) < Date.parse(horizon)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["retain_until"],
          message: `retain_until cannot precede ${field}`,
        });
      }
    }
    if (record.status === "in_progress" && record.response !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["response"],
        message: "an in-progress command cannot have a committed response",
      });
    }
    if (record.status !== "in_progress" && record.response === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["response"],
        message: "a committed command must retain its response envelope",
      });
    }
    if (
      record.status === "committed_succeeded" &&
      record.response !== null &&
      record.response.outcome !== "succeeded"
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["response", "outcome"],
        message: "committed_succeeded requires a succeeded response",
      });
    }
    if (
      record.status === "committed_failed" &&
      record.response !== null &&
      record.response.outcome !== "failed"
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["response", "outcome"],
        message: "committed_failed requires a failed response",
      });
    }
    if (
      record.status === "committed_failed" &&
      record.response !== null &&
      record.response.retriable
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["response", "retriable"],
        message: "retriable failures must release the idempotency key instead of being committed",
      });
    }
  });
export type V2IdempotencyRecordT = z.infer<typeof V2IdempotencyRecord>;

export const V2IdempotencyAttempt = z
  .object({
    actor_id: V2EntityId,
    command_family: V2CommandFamily,
    idempotency_key: V2NonEmptyString,
    request_fingerprint: V2Sha256Hex,
  })
  .strict();
export type V2IdempotencyAttemptT = z.infer<typeof V2IdempotencyAttempt>;

export type V2IdempotencyDisposition =
  | { kind: "proceed" }
  | { kind: "command_in_progress"; command_id: string }
  | { kind: "replay"; command_id: string; response: V2CommandResponseEnvelopeT }
  | { kind: "reject_fingerprint_mismatch"; command_id: string }
  | { kind: "reject_scope_mismatch"; command_id: string };

export function evaluateV2Idempotency(
  existing: V2IdempotencyRecordT | null,
  attempt: V2IdempotencyAttemptT,
): V2IdempotencyDisposition {
  if (existing === null) return { kind: "proceed" };
  if (
    existing.actor_id !== attempt.actor_id ||
    existing.command_family !== attempt.command_family ||
    existing.idempotency_key !== attempt.idempotency_key
  ) {
    return { kind: "reject_scope_mismatch", command_id: existing.command_id };
  }
  if (existing.request_fingerprint !== attempt.request_fingerprint) {
    return {
      kind: "reject_fingerprint_mismatch",
      command_id: existing.command_id,
    };
  }
  if (existing.status === "in_progress") {
    return { kind: "command_in_progress", command_id: existing.command_id };
  }
  if (existing.response === null) {
    throw new Error("invalid committed idempotency record without response");
  }
  return { kind: "replay", command_id: existing.command_id, response: existing.response };
}

export function v2IsIdempotencyRecordEligibleForCleanup(
  record: V2IdempotencyRecordT,
  now: Date,
): boolean {
  if (record.status === "in_progress") return false;
  const horizons = [
    record.retain_until,
    record.asynchronous_work_until,
    record.rollback_window_until,
  ].filter((value): value is string => value !== null);
  return horizons.every((horizon) => Date.parse(horizon) <= now.getTime());
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return Object.fromEntries(entries.map(([key, entryValue]) => [key, canonicalize(entryValue)]));
  }
  return value;
}

/**
 * Canonical server-side intent projection. Client-supplied fingerprints are
 * deliberately absent from V2ApplicationCommand; the server hashes this
 * projection after authentication and schema validation.
 */
export function canonicalizeV2ApplicationCommandIntent(command: V2ApplicationCommandT): string {
  const {
    command_id: _commandId,
    idempotency_key: _idempotencyKey,
    correlation_id: _correlationId,
    causation_id: _causationId,
    issued_at: _issuedAt,
    ...intent
  } = command;
  return JSON.stringify(canonicalize(intent));
}

export function fingerprintV2ApplicationCommand(
  command: V2ApplicationCommandT,
  serverSha256: (canonicalIntent: string) => string,
): string {
  return V2Sha256Hex.parse(serverSha256(canonicalizeV2ApplicationCommandIntent(command)));
}
