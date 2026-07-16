import { z } from "zod";
import { V2EntityId, V2IsoDateTime, V2NonEmptyString, V2PositiveVersion } from "./common.js";

export const V2BudgetReservationStatus = z.enum([
  "active",
  "retained_ambiguous",
  "settled",
  "released",
]);
export type V2BudgetReservationStatusT = z.infer<typeof V2BudgetReservationStatus>;

export const V2BudgetReservation = z
  .object({
    schema_version: z.literal(2),
    id: V2EntityId,
    project_id: V2EntityId,
    phase_id: V2EntityId,
    task_id: V2EntityId,
    run_id: V2EntityId,
    amount_usd: z.number().nonnegative(),
    settled_usd: z.number().nonnegative(),
    released_usd: z.number().nonnegative(),
    retained_usd: z.number().nonnegative(),
    status: V2BudgetReservationStatus,
    version: V2PositiveVersion,
    created_at: V2IsoDateTime,
    updated_at: V2IsoDateTime,
    expires_at: V2IsoDateTime,
  })
  .strict()
  .superRefine((reservation, ctx) => {
    const accounted = reservation.settled_usd + reservation.released_usd + reservation.retained_usd;
    if (reservation.status === "active") {
      if (accounted !== 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["status"],
          message: "an active reservation has not settled, released, or retained terminal funds",
        });
      }
      return;
    }
    if (Math.abs(accounted - reservation.amount_usd) > 1e-9) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["amount_usd"],
        message: "settled + released + retained must equal the reserved amount",
      });
    }
    if (
      reservation.status === "retained_ambiguous" &&
      (reservation.settled_usd !== 0 ||
        reservation.released_usd !== 0 ||
        reservation.retained_usd !== reservation.amount_usd)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["status"],
        message: `${reservation.status} must retain the full unsettled reservation`,
      });
    }
    if (reservation.status === "settled" && reservation.retained_usd !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["retained_usd"],
        message: "a settled reservation cannot retain funds",
      });
    }
    if (
      reservation.status === "released" &&
      (reservation.settled_usd !== 0 ||
        reservation.retained_usd !== 0 ||
        reservation.released_usd !== reservation.amount_usd)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["status"],
        message: "a released reservation must release the full amount",
      });
    }
  });
export type V2BudgetReservationT = z.infer<typeof V2BudgetReservation>;

export const V2BudgetTerminalOutcome = z.enum([
  "success",
  "partial_usage",
  "cancelled",
  "expired",
  "rejected",
  "dead_letter",
  "ambiguous_execution",
]);
export type V2BudgetTerminalOutcomeT = z.infer<typeof V2BudgetTerminalOutcome>;

export const V2BudgetResolutionInput = z
  .object({
    outcome: V2BudgetTerminalOutcome,
    attributable_usage_usd: z.number().nonnegative(),
    reason: V2NonEmptyString,
  })
  .strict();
export type V2BudgetResolutionInputT = z.infer<typeof V2BudgetResolutionInput>;

export const V2BudgetResolution = z
  .object({
    status: V2BudgetReservationStatus,
    settled_usd: z.number().nonnegative(),
    released_usd: z.number().nonnegative(),
    retained_usd: z.number().nonnegative(),
  })
  .strict();
export type V2BudgetResolutionT = z.infer<typeof V2BudgetResolution>;

export function resolveV2BudgetReservation(
  reservedAmountUsd: number,
  input: V2BudgetResolutionInputT,
): V2BudgetResolutionT {
  if (!Number.isFinite(reservedAmountUsd) || reservedAmountUsd < 0) {
    throw new Error("reserved amount must be finite and nonnegative");
  }
  if (input.attributable_usage_usd > reservedAmountUsd) {
    throw new Error("attributable usage cannot exceed the reservation");
  }

  switch (input.outcome) {
    case "success":
    case "partial_usage": {
      const settled = input.attributable_usage_usd;
      return {
        status: "settled",
        settled_usd: settled,
        released_usd: reservedAmountUsd - settled,
        retained_usd: 0,
      };
    }
    case "cancelled":
    case "expired":
    case "rejected":
    case "dead_letter":
      if (input.attributable_usage_usd !== 0) {
        throw new Error(`${input.outcome} before execution cannot settle usage`);
      }
      return {
        status: "released",
        settled_usd: 0,
        released_usd: reservedAmountUsd,
        retained_usd: 0,
      };
    case "ambiguous_execution":
      if (input.attributable_usage_usd !== 0) {
        throw new Error("ambiguous execution retains the full reservation until reconciliation");
      }
      return {
        status: "retained_ambiguous",
        settled_usd: 0,
        released_usd: 0,
        retained_usd: reservedAmountUsd,
      };
  }
}
