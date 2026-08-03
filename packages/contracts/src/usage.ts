// Usage telemetry and budget reservations (PRD R4 §Budget Enforcement,
// §Usage Telemetry). Every figure carries its source — aggregates never merge
// API dollar cost and subscription consumption into one unlabeled number.
import { z } from "zod";

const nonEmpty = z.string().min(1);

export const UsageSource = z.enum([
  "provider_api",
  "runtime_report",
  "subscription_credit",
  "estimate",
  "unavailable",
]);
export type UsageSourceT = z.infer<typeof UsageSource>;

export const Provider = z.enum(["anthropic", "openai", "deepseek"]);

export const UsageEvent = z
  .object({
    id: nonEmpty,
    provider: Provider,
    model: nonEmpty,
    project_id: nonEmpty,
    node_id: nonEmpty.nullable(),
    run_id: nonEmpty.nullable(),
    /**
     * Normalized total input tokens, inclusive of the cache categories below.
     * Provider adapters are responsible for converting provider-native usage
     * into this invariant before the event reaches business logic.
     */
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    cache_read_tokens: z.number().int().nonnegative().optional(),
    cache_write_tokens: z.number().int().nonnegative().optional(),
    estimated_cost_usd: z.number().nonnegative(),
    actual_cost_usd: z.number().nonnegative().nullable(),
    usage_source: UsageSource,
    pricing_version: nonEmpty,
    occurred_at: z.string().datetime(),
  })
  .superRefine((usage, context) => {
    const cacheTokens = (usage.cache_read_tokens ?? 0) + (usage.cache_write_tokens ?? 0);
    if (cacheTokens > usage.input_tokens) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cache_read_tokens"],
        message: "cache token categories must be subsets of normalized input_tokens",
      });
    }
  });
export type UsageEventT = z.infer<typeof UsageEvent>;

/**
 * Canonical AI usage telemetry.
 *
 * This contract is intentionally additive to `UsageEvent`: existing metering
 * callers can continue to use the compact legacy event while invocation paths
 * migrate to the request lifecycle ledger.
 */
export const AiUsageEventType = z.enum([
  "request_started",
  "usage_observed",
  "request_completed",
  "request_failed",
  "adjustment",
]);
export type AiUsageEventTypeT = z.infer<typeof AiUsageEventType>;

export const AiUsageEventStatus = z.enum([
  "started",
  "in_progress",
  "succeeded",
  "failed",
  "adjusted",
]);
export type AiUsageEventStatusT = z.infer<typeof AiUsageEventStatus>;

export const AiUsageSource = z.enum([
  "provider_api",
  "runtime_report",
  "subscription_credit",
  "estimate",
  "backfill",
  "manual_adjustment",
  "unavailable",
]);
export type AiUsageSourceT = z.infer<typeof AiUsageSource>;

export const AiCostClassification = z.enum([
  "actual",
  "estimated",
  "subscription_consumption",
  "unavailable",
]);
export type AiCostClassificationT = z.infer<typeof AiCostClassification>;

const isoCurrency = z.string().regex(/^[A-Z]{3}$/, "expected an ISO-4217 currency code");
const nonnegativePrice = z.number().nonnegative().finite();

const AiPricingProfileFields = z.object({
  id: nonEmpty,
  schema_version: z.literal(1),
  provider: nonEmpty,
  model: nonEmpty,
  pricing_version: nonEmpty,
  currency: isoCurrency,
  input_per_million: nonnegativePrice,
  output_per_million: nonnegativePrice,
  cache_read_per_million: nonnegativePrice.nullable(),
  cache_write_per_million: nonnegativePrice.nullable(),
  source: nonEmpty,
  effective_from: z.string().datetime(),
  effective_to: z.string().datetime().nullable(),
  created_at: z.string().datetime(),
});

function validateAiPricingProfile(
  profile: { effective_from: string; effective_to: string | null },
  context: z.RefinementCtx,
): void {
  if (
    profile.effective_to !== null &&
    Date.parse(profile.effective_to) <= Date.parse(profile.effective_from)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["effective_to"],
      message: "effective_to must be later than effective_from",
    });
  }
}

/** Immutable, effective-dated price schedule for one provider/model pair. */
export const AiPricingProfile = AiPricingProfileFields.superRefine(validateAiPricingProfile);
export type AiPricingProfileT = z.infer<typeof AiPricingProfile>;

export const AiPricingProfileInput = AiPricingProfileFields.omit({
  id: true,
  schema_version: true,
  created_at: true,
}).superRefine(validateAiPricingProfile);
export type AiPricingProfileInputT = z.infer<typeof AiPricingProfileInput>;

const nullableTokenCount = z.number().int().nullable();
const nullableNonnegativeInteger = z.number().int().nonnegative().nullable();

const AiUsageLifecycleEventFields = z.object({
  id: nonEmpty,
  schema_version: z.literal(1),
  request_id: nonEmpty,
  sequence: z.number().int().positive(),
  event_type: AiUsageEventType,
  status: AiUsageEventStatus,
  occurred_at: z.string().datetime(),
  recorded_at: z.string().datetime(),
  provider: nonEmpty,
  model: nonEmpty,
  provider_request_id: nonEmpty.nullable(),
  endpoint: nonEmpty,
  request_type: nonEmpty,
  retry_group_id: nonEmpty.nullable(),
  retry_attempt: z.number().int().nonnegative(),
  initiated_by_user_id: nonEmpty.nullable(),
  project_id: nonEmpty.nullable(),
  phase_id: nonEmpty.nullable(),
  task_id: nonEmpty.nullable(),
  run_id: nonEmpty.nullable(),
  usage_source: AiUsageSource,
  confidence: z.number().min(0).max(1).finite(),
  pricing_profile_id: nonEmpty.nullable(),
  input_tokens: nullableTokenCount,
  output_tokens: nullableTokenCount,
  cache_read_tokens: nullableTokenCount,
  cache_write_tokens: nullableTokenCount,
  cost_usd: z.number().finite().nullable(),
  cost_classification: AiCostClassification,
  latency_ms: nullableNonnegativeInteger,
  http_status: z.number().int().min(100).max(599).nullable(),
  error_code: nonEmpty.nullable(),
  error_category: nonEmpty.nullable(),
  error_message_redacted: nonEmpty.nullable(),
  sanitized_error: z.record(z.unknown()).nullable(),
  adjusts_event_id: nonEmpty.nullable(),
});
const AiUsageLifecycleEventInputFields = AiUsageLifecycleEventFields.omit({
  id: true,
  schema_version: true,
  sequence: true,
  recorded_at: true,
});

const statusForEvent: Record<AiUsageEventTypeT, AiUsageEventStatusT> = {
  request_started: "started",
  usage_observed: "in_progress",
  request_completed: "succeeded",
  request_failed: "failed",
  adjustment: "adjusted",
};

function validateAiUsageLifecycleEvent(
  event: z.infer<typeof AiUsageLifecycleEventInputFields>,
  context: z.RefinementCtx,
): void {
  if (event.status !== statusForEvent[event.event_type]) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["status"],
      message: `status must be ${statusForEvent[event.event_type]} for ${event.event_type}`,
    });
  }

  if (event.phase_id !== null && event.project_id === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["phase_id"],
      message: "phase attribution requires project attribution",
    });
  }
  if (event.task_id !== null && event.phase_id === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["task_id"],
      message: "task attribution requires phase attribution",
    });
  }
  if (event.run_id !== null && event.task_id === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["run_id"],
      message: "run attribution requires task attribution",
    });
  }
  if (event.retry_attempt > 0 && event.retry_group_id === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["retry_group_id"],
      message: "retried requests require a retry group",
    });
  }

  const tokenFields = [
    event.input_tokens,
    event.output_tokens,
    event.cache_read_tokens,
    event.cache_write_tokens,
  ];
  if (event.event_type === "usage_observed") {
    if (tokenFields.some((value) => value === null || value < 0)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["input_tokens"],
        message: "usage observations require nonnegative values for every token category",
      });
    }
    if (
      event.input_tokens !== null &&
      event.cache_read_tokens !== null &&
      event.cache_write_tokens !== null &&
      event.cache_read_tokens + event.cache_write_tokens > event.input_tokens
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cache_read_tokens"],
        message: "cache token categories must be subsets of normalized input_tokens",
      });
    }
    if (event.adjusts_event_id !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["adjusts_event_id"],
        message: "usage observations cannot adjust another event",
      });
    }
  } else if (event.event_type === "adjustment") {
    if (event.adjusts_event_id === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["adjusts_event_id"],
        message: "adjustments must identify the usage observation they correct",
      });
    }
    if ([...tokenFields, event.cost_usd].every((value) => value === null || Object.is(value, 0))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["input_tokens"],
        message: "an adjustment must contain at least one non-zero token or cost delta",
      });
    }
  } else if (tokenFields.some((value) => value !== null) || event.cost_usd !== null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["input_tokens"],
      message: "usage and cost belong on usage_observed or adjustment events",
    });
  }

  if (event.cost_usd !== null && event.event_type !== "adjustment" && event.cost_usd < 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["cost_usd"],
      message: "only adjustments may contain a negative cost",
    });
  }
  if (
    (event.cost_classification === "actual" || event.cost_classification === "estimated") &&
    event.event_type === "usage_observed" &&
    event.cost_usd === null
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["cost_usd"],
      message: "actual and estimated usage observations require a cost",
    });
  }
  if (
    (event.cost_classification === "subscription_consumption" ||
      event.cost_classification === "unavailable") &&
    event.cost_usd !== null
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["cost_usd"],
      message: `${event.cost_classification} events cannot claim a dollar cost`,
    });
  }
  if (
    event.event_type !== "usage_observed" &&
    event.event_type !== "adjustment" &&
    event.cost_classification !== "unavailable"
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["cost_classification"],
      message: "non-usage lifecycle events must classify cost as unavailable",
    });
  }

  const hasError =
    event.error_code !== null ||
    event.error_category !== null ||
    event.error_message_redacted !== null ||
    event.sanitized_error !== null;
  if (event.event_type === "request_failed" && !hasError) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["error_code"],
      message: "failed requests require sanitized error information",
    });
  } else if (event.event_type !== "request_failed" && hasError) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["error_code"],
      message: "error information belongs only on request_failed events",
    });
  }
}

/**
 * A canonical event as stored. `usage_observed` values are cumulative request
 * snapshots; `adjustment` values are signed deltas. Terminal rows deliberately
 * do not repeat token or cost values.
 */
export const AiUsageLifecycleEvent = AiUsageLifecycleEventFields.superRefine(
  validateAiUsageLifecycleEvent,
);
export type AiUsageLifecycleEventT = z.infer<typeof AiUsageLifecycleEvent>;

export const AiUsageLifecycleEventInput = AiUsageLifecycleEventInputFields.superRefine(
  validateAiUsageLifecycleEvent,
);
export type AiUsageLifecycleEventInputT = z.infer<typeof AiUsageLifecycleEventInput>;

export const ReservationState = z.enum(["active", "settled", "released"]);

export const Reservation = z.object({
  id: nonEmpty,
  node_id: nonEmpty,
  run_id: nonEmpty.nullable(),
  max_charge_usd: z.number().nonnegative(),
  state: ReservationState,
  created_at: z.string().datetime(),
});
export type ReservationT = z.infer<typeof Reservation>;

/** available = approved − settled actual usage − active reservations */
export function availableBudgetUsd(
  approvedUsd: number,
  settledUsd: number,
  activeReservationsUsd: number,
): number {
  return approvedUsd - settledUsd - activeReservationsUsd;
}

/** The 80% notification threshold uses settled usage PLUS active reservations. */
export function budgetThresholdReached(
  approvedUsd: number,
  settledUsd: number,
  activeReservationsUsd: number,
  threshold = 0.8,
): boolean {
  if (approvedUsd <= 0) return true;
  return (settledUsd + activeReservationsUsd) / approvedUsd >= threshold;
}
