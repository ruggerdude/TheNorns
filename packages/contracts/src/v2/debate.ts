import { z } from "zod";
import {
  V2Actor,
  V2ActorType,
  V2EntityId,
  V2EntityRef,
  V2EvidenceRef,
  V2IsoDateTime,
  V2NonEmptyString,
  V2PositiveVersion,
  V2Sha256Hex,
} from "./common.js";

const schemaVersion = z.literal(2);
const nullableDate = V2IsoDateTime.nullable();
const nonnegativeMoney = z.number().finite().nonnegative();

/** The immutable, reusable debate definition. Running it creates a DebateRun. */
export const V2DebateDefinitionState = z.enum(["draft", "ready", "archived"]);
export type V2DebateDefinitionStateT = z.infer<typeof V2DebateDefinitionState>;
export const V2_DEBATE_DEFINITION_TRANSITIONS: Record<
  V2DebateDefinitionStateT,
  readonly V2DebateDefinitionStateT[]
> = {
  draft: ["ready", "archived"],
  ready: ["archived"],
  archived: [],
};
export function v2CanDebateDefinitionTransition(
  from: V2DebateDefinitionStateT,
  to: V2DebateDefinitionStateT,
): boolean {
  return V2_DEBATE_DEFINITION_TRANSITIONS[from].includes(to);
}

export const V2DebateActorKind = z.enum(["participant", "judge", "synthesizer"]);
export type V2DebateActorKindT = z.infer<typeof V2DebateActorKind>;

/**
 * A selected execution snapshot. Provider, model, and runtime deliberately
 * remain independent strings: a role never implies a model selection.
 */
export const V2DebateActor = z
  .object({
    schema_version: schemaVersion,
    id: V2EntityId,
    debate_id: V2EntityId,
    actor_kind: V2DebateActorKind,
    role_label: V2NonEmptyString.max(200),
    display_name: V2NonEmptyString.max(200),
    instructions: V2NonEmptyString.max(100_000),
    provider: V2NonEmptyString.max(200),
    model: V2NonEmptyString.max(500),
    runtime: V2NonEmptyString.max(200),
    position: z.number().int().nonnegative(),
    max_turns: z.number().int().positive(),
    max_input_tokens: z.number().int().positive(),
    max_output_tokens: z.number().int().positive(),
    budget_limit_usd: nonnegativeMoney,
    created_at: V2IsoDateTime,
  })
  .strict();
export type V2DebateActorT = z.infer<typeof V2DebateActor>;

/**
 * Immutable per-run execution data captured at dispatch authorization.  This
 * deliberately does not reference the provider catalog: catalog values can
 * change, while a running debate's selected model and conservative charge
 * must not.
 */
export const V2DebatePricingSnapshot = z
  .object({
    provider: V2NonEmptyString.max(200),
    model: V2NonEmptyString.max(500),
    input_per_mtok_usd: nonnegativeMoney,
    output_per_mtok_usd: nonnegativeMoney,
    pricing_version: V2NonEmptyString.max(200),
    pricing_is_estimate: z.boolean(),
  })
  .strict();
export type V2DebatePricingSnapshotT = z.infer<typeof V2DebatePricingSnapshot>;

export const V2DebateActorExecutionSnapshot = z
  .object({
    actor_id: V2EntityId,
    provider: V2NonEmptyString.max(200),
    model: V2NonEmptyString.max(500),
    runtime: V2NonEmptyString.max(200),
    max_input_tokens: z.number().int().positive(),
    max_output_tokens: z.number().int().positive(),
    budget_limit_usd: nonnegativeMoney,
    max_turns: z.number().int().positive(),
    pricing: V2DebatePricingSnapshot,
    maximum_turn_charge_usd: nonnegativeMoney,
  })
  .strict()
  .superRefine((snapshot, ctx) => {
    if (
      snapshot.provider !== snapshot.pricing.provider ||
      snapshot.model !== snapshot.pricing.model
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["pricing"],
        message: "pricing provider and model match the immutable actor execution selection",
      });
    }
  });
export type V2DebateActorExecutionSnapshotT = z.infer<typeof V2DebateActorExecutionSnapshot>;

export const V2DebateContext = z
  .object({
    schema_version: schemaVersion,
    id: V2EntityId,
    debate_id: V2EntityId,
    ordinal: z.number().int().nonnegative(),
    label: V2NonEmptyString.max(500),
    artifact: V2EvidenceRef.nullable(),
    inline_content: z.string().max(100_000).nullable(),
    content_hash: V2Sha256Hex,
    created_at: V2IsoDateTime,
  })
  .strict()
  .superRefine((context, ctx) => {
    if ((context.artifact === null) === (context.inline_content === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["artifact"],
        message: "a context has exactly one artifact or inline_content source",
      });
    }
  });
export type V2DebateContextT = z.infer<typeof V2DebateContext>;

export const V2DebateStoppingPolicy = z
  .object({
    exact_rounds: z.number().int().positive().max(50).nullable(),
    max_rounds: z.number().int().positive().max(50),
    max_duration_seconds: z.number().int().positive(),
    max_total_input_tokens: z.number().int().positive(),
    max_total_output_tokens: z.number().int().positive(),
    max_total_cost_usd: nonnegativeMoney,
    stop_on_consensus: z.boolean(),
    no_material_change_rounds: z.number().int().positive().max(50).nullable(),
    repeated_disagreement_rounds: z.number().int().positive().max(50).nullable(),
    provider_failure_threshold: z.number().int().positive().max(100),
  })
  .strict()
  .superRefine((policy, ctx) => {
    if (policy.exact_rounds !== null && policy.exact_rounds > policy.max_rounds) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["exact_rounds"],
        message: "exact_rounds cannot exceed max_rounds",
      });
    }
  });
export type V2DebateStoppingPolicyT = z.infer<typeof V2DebateStoppingPolicy>;

export const V2Debate = z
  .object({
    schema_version: schemaVersion,
    id: V2EntityId,
    project_id: V2EntityId,
    phase_id: V2EntityId.nullable(),
    source_debate_id: V2EntityId.nullable(),
    state: V2DebateDefinitionState,
    title: V2NonEmptyString.max(500),
    question: V2NonEmptyString.max(100_000),
    stopping_policy: V2DebateStoppingPolicy,
    content_hash: V2Sha256Hex,
    aggregate_version: V2PositiveVersion,
    created_by: V2Actor,
    created_at: V2IsoDateTime,
    archived_at: nullableDate,
  })
  .strict()
  .superRefine((debate, ctx) => {
    if ((debate.state === "archived") !== (debate.archived_at !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["archived_at"],
        message: "archived_at is present exactly for archived definitions",
      });
    }
  });
export type V2DebateT = z.infer<typeof V2Debate>;

export const V2DebateRunState = z.enum([
  "created",
  "queued",
  "running",
  "pausing",
  "paused",
  "finalizing",
  "cancelling",
  "completed",
  "cancelled",
  "failed",
]);
export type V2DebateRunStateT = z.infer<typeof V2DebateRunState>;

export const V2_DEBATE_RUN_TERMINAL_STATES: ReadonlySet<V2DebateRunStateT> = new Set([
  "completed",
  "cancelled",
  "failed",
]);

export const V2_DEBATE_RUN_TRANSITIONS: Record<V2DebateRunStateT, readonly V2DebateRunStateT[]> = {
  created: ["queued", "cancelling", "cancelled", "failed"],
  queued: ["running", "paused", "cancelling", "cancelled", "failed"],
  // A worker may pause directly when an operational failure is discovered at
  // a durable turn boundary. Cancellation may also complete directly when no
  // provider call is leased; otherwise it first enters `cancelling`.
  running: ["pausing", "paused", "finalizing", "cancelling", "cancelled", "failed"],
  // A draining pause does not override a stop condition that becomes decisive
  // when the current turn commits.
  pausing: ["paused", "running", "finalizing", "cancelling", "cancelled", "failed"],
  paused: ["queued", "cancelling", "cancelled", "failed"],
  // Finalization can pause for a recoverable failure and can be cancelled
  // directly while no finalizer call is leased.
  finalizing: ["paused", "completed", "cancelling", "cancelled", "failed"],
  cancelling: ["cancelled", "failed"],
  completed: [],
  cancelled: [],
  failed: [],
};

export function v2CanDebateRunTransition(from: V2DebateRunStateT, to: V2DebateRunStateT): boolean {
  return V2_DEBATE_RUN_TRANSITIONS[from].includes(to);
}

/**
 * The shared runtime guard for every persisted DebateRun lifecycle mutation.
 * Callers may treat a same-state request as an idempotent no-op; every actual
 * state change must pass this function before it reaches storage.
 */
export function v2AssertDebateRunTransition(from: V2DebateRunStateT, to: V2DebateRunStateT): void {
  if (from !== to && !v2CanDebateRunTransition(from, to)) {
    throw new Error(`illegal debate run transition ${from}->${to}`);
  }
}

export const V2DebateRun = z
  .object({
    schema_version: schemaVersion,
    id: V2EntityId,
    project_id: V2EntityId,
    debate_id: V2EntityId,
    attempt: z.number().int().positive(),
    state: V2DebateRunState,
    lifecycle_version: z.number().int().nonnegative(),
    event_version: z.number().int().nonnegative(),
    cursor_round_number: z.number().int().nonnegative(),
    cursor_turn_number: z.number().int().nonnegative(),
    stop_after: z.enum(["none", "turn", "round"]).default("none"),
    stop_reason: z.string().nullable(),
    actor_execution_snapshots: z.array(V2DebateActorExecutionSnapshot).min(1).max(100),
    started_at: nullableDate,
    finished_at: nullableDate,
    aggregate_version: V2PositiveVersion,
    created_at: V2IsoDateTime,
    updated_at: V2IsoDateTime,
  })
  .strict()
  .superRefine((run, ctx) => {
    if (run.lifecycle_version === 0 && run.state !== "created") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["state"],
        message: "a version-zero run must be at the created lifecycle origin",
      });
    }
    if (V2_DEBATE_RUN_TERMINAL_STATES.has(run.state) !== (run.finished_at !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["finished_at"],
        message: "finished_at is present exactly for terminal runs",
      });
    }
  });
export type V2DebateRunT = z.infer<typeof V2DebateRun>;

export const V2DebateRoundState = z.enum(["pending", "active", "completed", "cancelled", "failed"]);
export type V2DebateRoundStateT = z.infer<typeof V2DebateRoundState>;
export const V2DebateTurnState = z.enum([
  "pending",
  "queued",
  "leased",
  "running",
  "completed",
  "failed",
  "cancelled",
  "expired",
]);
export type V2DebateTurnStateT = z.infer<typeof V2DebateTurnState>;

export const V2_DEBATE_ROUND_TRANSITIONS: Record<
  V2DebateRoundStateT,
  readonly V2DebateRoundStateT[]
> = {
  pending: ["active", "cancelled", "failed"],
  active: ["completed", "cancelled", "failed"],
  completed: [],
  cancelled: [],
  failed: [],
};
export const V2_DEBATE_TURN_TRANSITIONS: Record<V2DebateTurnStateT, readonly V2DebateTurnStateT[]> =
  {
    pending: ["queued", "cancelled"],
    queued: ["leased", "cancelled", "expired", "failed"],
    leased: ["running", "queued", "cancelled", "expired", "failed"],
    running: ["completed", "failed", "cancelled", "expired"],
    completed: [],
    failed: [],
    cancelled: [],
    expired: [],
  };
export function v2CanDebateRoundTransition(
  from: V2DebateRoundStateT,
  to: V2DebateRoundStateT,
): boolean {
  return V2_DEBATE_ROUND_TRANSITIONS[from].includes(to);
}
export function v2CanDebateTurnTransition(
  from: V2DebateTurnStateT,
  to: V2DebateTurnStateT,
): boolean {
  return V2_DEBATE_TURN_TRANSITIONS[from].includes(to);
}

export const V2DebateRound = z
  .object({
    schema_version: schemaVersion,
    id: V2EntityId,
    debate_run_id: V2EntityId,
    round_number: z.number().int().positive(),
    state: V2DebateRoundState,
    consensus_reported: z.boolean(),
    material_change: z.boolean().nullable(),
    unresolved_disagreement_fingerprint: V2Sha256Hex.nullable(),
    started_at: nullableDate,
    finished_at: nullableDate,
    created_at: V2IsoDateTime,
    updated_at: V2IsoDateTime,
  })
  .strict();
export type V2DebateRoundT = z.infer<typeof V2DebateRound>;

export const V2DebateTurn = z
  .object({
    schema_version: schemaVersion,
    id: V2EntityId,
    debate_run_id: V2EntityId,
    round_id: V2EntityId,
    turn_number: z.number().int().positive(),
    actor_id: V2EntityId,
    state: V2DebateTurnState,
    designated_attempt_id: V2EntityId.nullable(),
    prompt_hash: V2Sha256Hex,
    output_message_id: V2EntityId.nullable(),
    created_at: V2IsoDateTime,
    updated_at: V2IsoDateTime,
    completed_at: nullableDate,
  })
  .strict();
export type V2DebateTurnT = z.infer<typeof V2DebateTurn>;

export const V2DebateTurnAttempt = z
  .object({
    schema_version: schemaVersion,
    id: V2EntityId,
    turn_id: V2EntityId,
    attempt_number: z.number().int().positive(),
    state: V2DebateTurnState,
    provider_execution_id: V2NonEmptyString.max(1_000).nullable(),
    lease_token: V2NonEmptyString.nullable(),
    leased_until: nullableDate,
    started_at: nullableDate,
    finished_at: nullableDate,
    failure_code: z.string().nullable(),
    failure_detail: z.string().nullable(),
    created_at: V2IsoDateTime,
    updated_at: V2IsoDateTime,
  })
  .strict()
  .superRefine((attempt, ctx) => {
    if ((attempt.lease_token === null) !== (attempt.leased_until === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lease_token"],
        message: "lease_token and leased_until are present together",
      });
    }
  });
export type V2DebateTurnAttemptT = z.infer<typeof V2DebateTurnAttempt>;

export const V2DebateMessage = z
  .object({
    schema_version: schemaVersion,
    id: V2EntityId,
    debate_run_id: V2EntityId,
    sequence: z.number().int().positive(),
    message_kind: z.enum(["system", "participant", "judge", "synthesizer", "human"]),
    actor_snapshot: V2DebateActor.nullable(),
    turn_id: V2EntityId.nullable(),
    turn_attempt_id: V2EntityId.nullable(),
    supersedes_message_id: V2EntityId.nullable().default(null),
    structured_output: z.record(z.unknown()).nullable().default(null),
    structured_output_hash: V2Sha256Hex.nullable().default(null),
    intervention_kind: z.enum(["direction", "statement"]).nullable().default(null),
    intervention_target_actor_id: V2EntityId.nullable().default(null),
    intervention_apply_at: z.enum(["next_turn", "next_round"]).nullable().default(null),
    intervention_applies_after_round: z.number().int().nonnegative().nullable().default(null),
    intervention_applies_after_turn: z.number().int().nonnegative().nullable().default(null),
    content: V2NonEmptyString,
    content_hash: V2Sha256Hex,
    created_at: V2IsoDateTime,
  })
  .strict()
  .superRefine((message, ctx) => {
    const isHumanIntervention = message.message_kind === "human";
    const hasMetadata = message.intervention_kind !== null;
    if (isHumanIntervention !== hasMetadata) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["intervention_kind"],
        message: "human messages carry intervention metadata and generated messages do not",
      });
    }
    if ((message.structured_output === null) !== (message.structured_output_hash === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["structured_output_hash"],
        message: "structured output and its hash are present together",
      });
    }
    if (
      hasMetadata &&
      (message.intervention_apply_at === null ||
        message.intervention_applies_after_round === null ||
        message.intervention_applies_after_turn === null)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["intervention_apply_at"],
        message: "interventions identify both their boundary and cursor",
      });
    }
  });
export type V2DebateMessageT = z.infer<typeof V2DebateMessage>;

export const V2DebateFinding = z
  .object({
    schema_version: schemaVersion,
    id: V2EntityId,
    debate_run_id: V2EntityId,
    message_id: V2EntityId,
    key: V2NonEmptyString,
    severity: z.enum(["must_fix", "should_fix", "suggestion"]),
    finding: V2NonEmptyString,
    recommendation: V2NonEmptyString,
    disposition: z.enum(["open", "accepted", "rejected", "deferred", "resolved"]),
    created_at: V2IsoDateTime,
  })
  .strict();
export type V2DebateFindingT = z.infer<typeof V2DebateFinding>;

export const V2DebateRevision = z
  .object({
    schema_version: schemaVersion,
    id: V2EntityId,
    debate_run_id: V2EntityId,
    revision_number: z.number().int().positive(),
    revision_kind: z.enum(["finding_disposition", "judgment", "final_output", "correction"]),
    supersedes_revision_id: V2EntityId.nullable(),
    rationale: V2NonEmptyString,
    payload: z.record(z.unknown()),
    created_by: V2Actor,
    created_at: V2IsoDateTime,
  })
  .strict();
export type V2DebateRevisionT = z.infer<typeof V2DebateRevision>;

export const V2DebateJudgment = z
  .object({
    schema_version: schemaVersion,
    id: V2EntityId,
    debate_run_id: V2EntityId,
    revision_id: V2EntityId.nullable(),
    judge_actor_id: V2EntityId.nullable(),
    conclusion: V2NonEmptyString,
    rationale: V2NonEmptyString,
    evidence: z.array(V2EvidenceRef),
    content_hash: V2Sha256Hex,
    created_at: V2IsoDateTime,
  })
  .strict();
export type V2DebateJudgmentT = z.infer<typeof V2DebateJudgment>;

export const V2DebateFinalOutput = z
  .object({
    schema_version: schemaVersion,
    id: V2EntityId,
    debate_run_id: V2EntityId,
    revision_id: V2EntityId.nullable(),
    judgment_id: V2EntityId.nullable(),
    content: V2NonEmptyString,
    content_hash: V2Sha256Hex,
    created_at: V2IsoDateTime,
  })
  .strict();
export type V2DebateFinalOutputT = z.infer<typeof V2DebateFinalOutput>;

export const V2DebateUsage = z
  .object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    cost_usd: nonnegativeMoney,
    latency_ms: z.number().int().nonnegative(),
  })
  .strict();
export type V2DebateUsageT = z.infer<typeof V2DebateUsage>;

export const V2DebateStoppingReason = z.enum([
  "exact_rounds",
  "max_rounds",
  "max_duration",
  "max_input_tokens",
  "max_output_tokens",
  "max_cost",
  "consensus",
  "no_material_change",
  "repeated_disagreement",
  "provider_failures",
  "requested_stop",
]);
export type V2DebateStoppingReasonT = z.infer<typeof V2DebateStoppingReason>;

export const V2DebateStoppingObservation = z
  .object({
    completed_rounds: z.number().int().nonnegative(),
    elapsed_seconds: z.number().finite().nonnegative(),
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    cost_usd: nonnegativeMoney,
    consensus_reported: z.boolean(),
    consecutive_no_material_change_rounds: z.number().int().nonnegative(),
    consecutive_repeated_disagreement_rounds: z.number().int().nonnegative(),
    consecutive_provider_failures: z.number().int().nonnegative(),
    requested_stop: z.boolean(),
  })
  .strict();
export type V2DebateStoppingObservationT = z.infer<typeof V2DebateStoppingObservation>;

/** Deterministic evaluator; semantic signals are supplied only from stored validated output. */
export function evaluateV2DebateStopping(
  policy: V2DebateStoppingPolicyT,
  observation: V2DebateStoppingObservationT,
): V2DebateStoppingReasonT | null {
  if (observation.requested_stop) return "requested_stop";
  if (policy.exact_rounds !== null && observation.completed_rounds >= policy.exact_rounds) {
    return "exact_rounds";
  }
  if (observation.completed_rounds >= policy.max_rounds) return "max_rounds";
  if (observation.elapsed_seconds >= policy.max_duration_seconds) return "max_duration";
  if (observation.input_tokens >= policy.max_total_input_tokens) return "max_input_tokens";
  if (observation.output_tokens >= policy.max_total_output_tokens) return "max_output_tokens";
  if (observation.cost_usd >= policy.max_total_cost_usd) return "max_cost";
  if (observation.consecutive_provider_failures >= policy.provider_failure_threshold) {
    return "provider_failures";
  }
  // Exact-round mode suppresses semantic early exits. Safety/resource caps and
  // explicit user stop above still win, but consensus cannot silently turn an
  // exact three-round run into a one-round run.
  if (policy.exact_rounds !== null) return null;
  if (policy.stop_on_consensus && observation.consensus_reported) return "consensus";
  if (
    policy.no_material_change_rounds !== null &&
    observation.consecutive_no_material_change_rounds >= policy.no_material_change_rounds
  ) {
    return "no_material_change";
  }
  if (
    policy.repeated_disagreement_rounds !== null &&
    observation.consecutive_repeated_disagreement_rounds >= policy.repeated_disagreement_rounds
  ) {
    return "repeated_disagreement";
  }
  return null;
}

export const V2DebateJob = z
  .object({
    schema_version: schemaVersion,
    id: V2EntityId,
    debate_run_id: V2EntityId,
    turn_attempt_id: V2EntityId,
    job_kind: z.literal("execute_turn"),
    state: z.enum(["queued", "leased", "succeeded", "failed", "cancelled", "dead_letter"]),
    delivery_attempt: z.number().int().positive(),
    idempotency_key: V2NonEmptyString,
    lease_token: V2NonEmptyString.nullable(),
    leased_until: nullableDate,
    created_at: V2IsoDateTime,
    updated_at: V2IsoDateTime,
  })
  .strict();
export type V2DebateJobT = z.infer<typeof V2DebateJob>;

export const V2DebateReservation = z
  .object({
    schema_version: schemaVersion,
    id: V2EntityId,
    debate_run_id: V2EntityId,
    turn_attempt_id: V2EntityId,
    amount_usd: nonnegativeMoney,
    settled_usd: nonnegativeMoney,
    released_usd: nonnegativeMoney,
    retained_usd: nonnegativeMoney,
    status: z.enum(["active", "retained_ambiguous", "settled", "released"]),
    version: V2PositiveVersion,
    expires_at: V2IsoDateTime,
  })
  .strict();
export type V2DebateReservationT = z.infer<typeof V2DebateReservation>;

export const V2DebateUsageEvent = z
  .object({
    schema_version: schemaVersion,
    id: V2EntityId,
    debate_run_id: V2EntityId,
    turn_attempt_id: V2EntityId,
    provider: V2NonEmptyString,
    model: V2NonEmptyString,
    runtime: V2NonEmptyString,
    pricing_snapshot: V2DebatePricingSnapshot,
    usage: V2DebateUsage,
    occurred_at: V2IsoDateTime,
  })
  .strict();
export type V2DebateUsageEventT = z.infer<typeof V2DebateUsageEvent>;

/**
 * The exact immutable preimage addressed by a replay event's `content_hash`.
 * Usage is intentionally absent: it is mutable query-time enrichment joined
 * from settlement records and therefore cannot participate in event identity.
 */
export const V2DebateEventContentHashEnvelope = z
  .object({
    schema_version: schemaVersion,
    id: V2EntityId,
    project_id: V2EntityId,
    debate_id: V2EntityId,
    debate_run_id: V2EntityId,
    sequence: z.number().int().positive(),
    type: V2NonEmptyString,
    round_number: z.number().int().nonnegative().nullable(),
    turn_number: z.number().int().nonnegative().nullable(),
    lifecycle_version: z.number().int().nonnegative().nullable(),
    actor_type: V2ActorType,
    actor_id: V2EntityId.nullable(),
    correlation_id: V2EntityId,
    causation_id: V2EntityId.nullable(),
    actor_snapshot: z.record(z.unknown()).nullable(),
    payload: z.record(z.unknown()),
    artifact_ids: z.array(V2EntityId),
    occurred_at: V2IsoDateTime,
  })
  .strict();
export type V2DebateEventContentHashEnvelopeT = z.infer<typeof V2DebateEventContentHashEnvelope>;

/**
 * Frozen event-replay DTO. `content_hash` addresses only
 * `V2DebateEventContentHashEnvelope`; `usage` is separate mutable enrichment.
 * Thus replaying the same event before and after usage settlement preserves
 * both its `id` and `content_hash` while its `usage` view may become populated.
 */
export const V2DebateEvent = V2DebateEventContentHashEnvelope.extend({
  usage: V2DebateUsage.nullable(),
  content_hash: V2Sha256Hex,
}).strict();
export type V2DebateEventT = z.infer<typeof V2DebateEvent>;

/** Select the exact canonical preimage used for DebateEvent content hashes. */
export function v2DebateEventContentHashEnvelope(
  event: V2DebateEventT,
): V2DebateEventContentHashEnvelopeT {
  const { usage: _usage, content_hash: _contentHash, ...envelope } = event;
  return V2DebateEventContentHashEnvelope.parse(envelope);
}

/** Generic references accepted by debate-facing DTOs and evidence. */
export const V2DebateEntityRef = V2EntityRef;
