import {
  type V2ActorTypeT,
  type V2BudgetReservationStatusT,
  type V2BudgetResolutionInputT,
  type V2BudgetResolutionT,
  type V2BudgetTerminalOutcomeT,
  resolveV2BudgetReservation,
} from "@norns/contracts";
import type { V2SqlExecutor, V2TransactionRunner } from "./database.js";

export interface V2BudgetReservationRow {
  id: string;
  project_id: string;
  phase_id: string;
  task_id: string;
  run_id: string;
  amount_usd: number;
  settled_usd: number;
  released_usd: number;
  retained_usd: number;
  status: V2BudgetReservationStatusT;
  resolution_outcome: V2BudgetTerminalOutcomeT | null;
  version: number;
  expires_at: string;
}

export interface V2BudgetResolutionRequest {
  reservation_id: string;
  expected_version: number;
  outcome: V2BudgetTerminalOutcomeT;
  attributable_usage_usd: number;
  reason: string;
  actor_type: V2ActorTypeT;
  actor_id: string;
  correlation_id: string;
  causation_id: string | null;
  occurred_at: string;
}

export interface V2BudgetTransaction {
  lockReservation(reservationId: string): Promise<V2BudgetReservationRow | null>;
  applyResolution(
    reservation: V2BudgetReservationRow,
    request: V2BudgetResolutionRequest,
    resolution: V2BudgetResolutionT,
  ): Promise<V2BudgetReservationRow>;
}

export interface V2BudgetTransactionFactory<TTx extends V2BudgetTransaction> {
  bind(tx: V2SqlExecutor): TTx;
}

export class V2BudgetNotFoundError extends Error {
  constructor(readonly reservationId: string) {
    super(`unknown budget reservation ${reservationId}`);
    this.name = "V2BudgetNotFoundError";
  }
}

export class V2BudgetVersionConflictError extends Error {
  constructor(
    readonly reservationId: string,
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {
    super(
      `budget reservation ${reservationId} version conflict: expected ${expectedVersion}, actual ${actualVersion}`,
    );
    this.name = "V2BudgetVersionConflictError";
  }
}

export class V2BudgetOutcomeConflictError extends Error {
  constructor(
    readonly reservationId: string,
    readonly existingOutcome: V2BudgetTerminalOutcomeT,
    readonly requestedOutcome: V2BudgetTerminalOutcomeT,
  ) {
    super(
      `budget reservation ${reservationId} already resolved as ${existingOutcome}, not ${requestedOutcome}`,
    );
    this.name = "V2BudgetOutcomeConflictError";
  }
}

/**
 * Resolve one reservation with its usage/event/audit writes in one database
 * transaction. Repeating the same terminal outcome is an idempotent read.
 */
export async function resolveV2BudgetReservationTransaction<
  TTx extends V2BudgetTransaction,
>(options: {
  transactionRunner: V2TransactionRunner;
  transactionFactory: V2BudgetTransactionFactory<TTx>;
  request: V2BudgetResolutionRequest;
}): Promise<V2BudgetReservationRow> {
  return options.transactionRunner.transaction(async (executor) => {
    const tx = options.transactionFactory.bind(executor);
    const reservation = await tx.lockReservation(options.request.reservation_id);
    if (!reservation) throw new V2BudgetNotFoundError(options.request.reservation_id);

    if (reservation.resolution_outcome !== null) {
      if (reservation.resolution_outcome !== options.request.outcome) {
        throw new V2BudgetOutcomeConflictError(
          reservation.id,
          reservation.resolution_outcome,
          options.request.outcome,
        );
      }
      return reservation;
    }
    if (reservation.version !== options.request.expected_version) {
      throw new V2BudgetVersionConflictError(
        reservation.id,
        options.request.expected_version,
        reservation.version,
      );
    }

    const input: V2BudgetResolutionInputT = {
      outcome: options.request.outcome,
      attributable_usage_usd: options.request.attributable_usage_usd,
      reason: options.request.reason,
    };
    const resolution = resolveV2BudgetReservation(reservation.amount_usd, input);
    return tx.applyResolution(reservation, options.request, resolution);
  });
}

export interface V2OrphanReservationCandidate {
  reservation_id: string;
  expected_version: number;
  safe_outcome: Extract<
    V2BudgetTerminalOutcomeT,
    "cancelled" | "expired" | "rejected" | "dead_letter"
  >;
  reason: string;
  project_id: string;
}

export interface V2BudgetSweepRepository {
  findOrphanCandidates(now: string, limit: number): Promise<V2OrphanReservationCandidate[]>;
}

export interface V2BudgetSweepRepositoryFactory<TRepo extends V2BudgetSweepRepository> {
  bind(executor: V2SqlExecutor): TRepo;
}

/**
 * Each repair uses its own transaction. One raced or malformed reservation
 * cannot roll back unrelated repairs, and version checks prevent the sweep
 * from overriding a concurrent terminal usage report.
 */
export async function sweepV2OrphanReservations<
  TTx extends V2BudgetTransaction,
  TSweep extends V2BudgetSweepRepository,
>(options: {
  transactionRunner: V2TransactionRunner;
  transactionFactory: V2BudgetTransactionFactory<TTx>;
  sweepRepositoryFactory: V2BudgetSweepRepositoryFactory<TSweep>;
  now?: () => Date;
  limit?: number;
  actorType?: V2ActorTypeT;
  actorId?: string;
}): Promise<{ repaired: string[]; raced: string[] }> {
  const now = options.now ?? (() => new Date());
  const at = now().toISOString();
  const candidates = await options.transactionRunner.transaction((executor) =>
    options.sweepRepositoryFactory.bind(executor).findOrphanCandidates(at, options.limit ?? 100),
  );
  const repaired: string[] = [];
  const raced: string[] = [];

  for (const candidate of candidates) {
    try {
      await resolveV2BudgetReservationTransaction({
        transactionRunner: options.transactionRunner,
        transactionFactory: options.transactionFactory,
        request: {
          reservation_id: candidate.reservation_id,
          expected_version: candidate.expected_version,
          outcome: candidate.safe_outcome,
          attributable_usage_usd: 0,
          reason: candidate.reason,
          actor_type: options.actorType ?? "system",
          actor_id: options.actorId ?? "system:budget-sweep",
          correlation_id: `budget-sweep:${candidate.project_id}`,
          causation_id: null,
          occurred_at: at,
        },
      });
      repaired.push(candidate.reservation_id);
    } catch (error) {
      if (error instanceof V2BudgetVersionConflictError) {
        raced.push(candidate.reservation_id);
        continue;
      }
      throw error;
    }
  }
  return { repaired, raced };
}
