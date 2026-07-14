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

export const Provider = z.enum(["anthropic", "openai"]);

export const UsageEvent = z.object({
  id: nonEmpty,
  provider: Provider,
  model: nonEmpty,
  project_id: nonEmpty,
  node_id: nonEmpty.nullable(),
  run_id: nonEmpty.nullable(),
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  estimated_cost_usd: z.number().nonnegative(),
  actual_cost_usd: z.number().nonnegative().nullable(),
  usage_source: UsageSource,
  pricing_version: nonEmpty,
  occurred_at: z.string().datetime(),
});
export type UsageEventT = z.infer<typeof UsageEvent>;

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
