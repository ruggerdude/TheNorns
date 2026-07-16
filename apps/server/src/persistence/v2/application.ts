import { createHash } from "node:crypto";
import {
  type V2ActorTypeT,
  V2ApplicationCommand,
  type V2ApplicationCommandT,
  V2CommandResponseEnvelope,
  type V2CommandResponseEnvelopeT,
  V2DecisionPoint,
  type V2DecisionPointT,
  type V2IdempotencyAttemptT,
  V2IdempotencyRecord,
  type V2IdempotencyRecordT,
  V2_IDEMPOTENCY_MIN_RETENTION_DAYS,
  evaluateV2Idempotency,
  fingerprintV2ApplicationCommand,
} from "@norns/contracts";
import type { V2SqlExecutor, V2TransactionRunner } from "./database.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface V2IdempotencyAuditInput {
  actor_type: V2ActorTypeT;
  actor_id: string;
  project_id: string;
  phase_id: string | null;
  task_id: string | null;
  command_id: string;
  command_family: string;
  idempotency_key: string;
  request_fingerprint: string;
  existing_command_id: string | null;
  reason: "fingerprint_mismatch" | "scope_mismatch";
  correlation_id: string;
  causation_id: string | null;
  occurred_at: string;
}

export interface V2ApplicationTransaction {
  tryAcquireIdempotencyLock(scope: V2IdempotencyAttemptT): Promise<boolean>;
  findIdempotency(scope: V2IdempotencyAttemptT): Promise<V2IdempotencyRecordT | null>;
  insertIdempotency(record: V2IdempotencyRecordT): Promise<void>;
  commitIdempotency(
    scope: V2IdempotencyAttemptT,
    status: "committed_succeeded" | "committed_failed",
    response: V2CommandResponseEnvelopeT,
    updatedAt: string,
  ): Promise<void>;
  appendIdempotencyAudit(input: V2IdempotencyAuditInput): Promise<void>;
}

export interface V2ApplicationTransactionFactory<TTx extends V2ApplicationTransaction> {
  bind(tx: V2SqlExecutor): TTx;
}

export interface V2CommandMutationResult {
  outcome: "succeeded" | "failed";
  http_status: number;
  body: unknown;
}

export function v2ExpectedVersionConflict(input: {
  entity_type: string;
  entity_id: string;
  expected_version: number;
  actual_version: number;
}): V2CommandMutationResult {
  return {
    outcome: "failed",
    http_status: 409,
    body: {
      error: "optimistic_concurrency_conflict",
      ...input,
    },
  };
}

export type V2CommandExecutionResult =
  | {
      kind: "executed";
      command_id: string;
      response: V2CommandResponseEnvelopeT;
    }
  | {
      kind: "replayed";
      command_id: string;
      response: V2CommandResponseEnvelopeT;
    }
  | {
      kind: "command_in_progress";
      command_id: string | null;
    }
  | {
      kind: "idempotency_conflict";
      command_id: string;
      reason: "fingerprint_mismatch" | "scope_mismatch";
    };

export interface V2ExecuteCommandOptions<TTx extends V2ApplicationTransaction> {
  command: V2ApplicationCommandT;
  transactionRunner: V2TransactionRunner;
  transactionFactory: V2ApplicationTransactionFactory<TTx>;
  mutate: (tx: TTx, command: V2ApplicationCommandT) => Promise<V2CommandMutationResult>;
  now?: () => Date;
  asynchronousWorkUntil?: Date | null;
  rollbackWindowUntil?: Date | null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function latestDate(...dates: (Date | null | undefined)[]): Date {
  const present = dates.filter((date): date is Date => date !== null && date !== undefined);
  return new Date(Math.max(...present.map((date) => date.getTime())));
}

/**
 * One actor-scoped application-command boundary.
 *
 * Business failures are returned by mutate() and committed with their audit
 * and idempotency response. Unexpected exceptions escape the callback and
 * therefore roll back the idempotency claim and every domain write.
 */
export async function executeV2ApplicationCommand<TTx extends V2ApplicationTransaction>(
  options: V2ExecuteCommandOptions<TTx>,
): Promise<V2CommandExecutionResult> {
  const command = V2ApplicationCommand.parse(options.command);
  if (command.actor.actor_id === null) {
    throw new Error("application commands require an attributable actor_id");
  }

  const now = options.now ?? (() => new Date());
  const requestFingerprint = fingerprintV2ApplicationCommand(command, sha256);
  const scope: V2IdempotencyAttemptT = {
    actor_id: command.actor.actor_id,
    command_family: command.command_family,
    idempotency_key: command.idempotency_key,
    request_fingerprint: requestFingerprint,
  };

  return options.transactionRunner.transaction(async (executor) => {
    const tx = options.transactionFactory.bind(executor);
    const acquired = await tx.tryAcquireIdempotencyLock(scope);
    if (!acquired) {
      return { kind: "command_in_progress", command_id: null };
    }

    const existing = await tx.findIdempotency(scope);
    const disposition = evaluateV2Idempotency(existing, scope);
    if (disposition.kind === "replay") {
      return {
        kind: "replayed",
        command_id: disposition.command_id,
        response: disposition.response,
      };
    }
    if (disposition.kind === "command_in_progress") {
      return disposition;
    }
    if (
      disposition.kind === "reject_fingerprint_mismatch" ||
      disposition.kind === "reject_scope_mismatch"
    ) {
      const reason =
        disposition.kind === "reject_fingerprint_mismatch"
          ? "fingerprint_mismatch"
          : "scope_mismatch";
      await tx.appendIdempotencyAudit({
        actor_type: command.actor.actor_type,
        actor_id: scope.actor_id,
        project_id: command.project_id,
        phase_id: "phase_id" in command ? command.phase_id : null,
        task_id: "task_id" in command ? command.task_id : null,
        command_id: command.command_id,
        command_family: command.command_family,
        idempotency_key: command.idempotency_key,
        request_fingerprint: requestFingerprint,
        existing_command_id: disposition.command_id,
        reason,
        correlation_id: command.correlation_id,
        causation_id: command.causation_id,
        occurred_at: now().toISOString(),
      });
      return {
        kind: "idempotency_conflict",
        command_id: disposition.command_id,
        reason,
      };
    }

    const startedAt = now();
    const minimumRetainUntil = new Date(
      startedAt.getTime() + V2_IDEMPOTENCY_MIN_RETENTION_DAYS * DAY_MS,
    );
    const retainUntil = latestDate(
      minimumRetainUntil,
      options.asynchronousWorkUntil,
      options.rollbackWindowUntil,
    );
    const inProgress = V2IdempotencyRecord.parse({
      schema_version: 2,
      actor_id: scope.actor_id,
      command_family: scope.command_family,
      idempotency_key: scope.idempotency_key,
      request_fingerprint: scope.request_fingerprint,
      command_id: command.command_id,
      status: "in_progress",
      response: null,
      created_at: startedAt.toISOString(),
      updated_at: startedAt.toISOString(),
      retain_until: retainUntil.toISOString(),
      asynchronous_work_until: options.asynchronousWorkUntil?.toISOString() ?? null,
      rollback_window_until: options.rollbackWindowUntil?.toISOString() ?? null,
    });
    await tx.insertIdempotency(inProgress);

    const mutation = await options.mutate(tx, command);
    const committedAt = now().toISOString();
    const response = V2CommandResponseEnvelope.parse({
      outcome: mutation.outcome,
      http_status: mutation.http_status,
      body: mutation.body,
      committed_at: committedAt,
    });
    await tx.commitIdempotency(
      scope,
      mutation.outcome === "succeeded" ? "committed_succeeded" : "committed_failed",
      response,
      committedAt,
    );
    return { kind: "executed", command_id: command.command_id, response };
  });
}

export interface V2KnownDecisionPoint {
  id: string;
  project_id: string;
  condition_key: string;
  condition_fingerprint: string;
  condition_revision: number;
  status: "open" | "resolved" | "dismissed" | "superseded";
  supersedes_decision_point_id: string | null;
}

export interface V2OpenDecisionPoint extends V2KnownDecisionPoint {
  status: "open";
}

type V2DecisionPointCreateFields = Pick<
  V2DecisionPointT,
  | "id"
  | "project_id"
  | "phase_id"
  | "task_id"
  | "scope_entity_type"
  | "scope_entity_id"
  | "reason_class"
  | "source_instance_id"
  | "condition_key"
  | "condition_fingerprint"
  | "question"
  | "context"
  | "options"
  | "recommendation_option_id"
  | "urgency"
  | "blocking_scope"
>;

export interface V2DecisionPointInput extends V2DecisionPointCreateFields {
  occurred_at: string;
  actor_id: string;
  correlation_id: string;
  causation_id: string | null;
}

export interface V2DecisionPointWriteInput extends V2DecisionPointInput {
  status: "open";
  condition_revision: number;
  supersedes_decision_point_id: string | null;
}

export interface V2DecisionPointTransaction {
  lockLatestDecisionPoint(conditionKey: string): Promise<V2KnownDecisionPoint | null>;
  insertDecisionPoint(input: V2DecisionPointWriteInput): Promise<V2OpenDecisionPoint>;
  supersedeAndInsertDecisionPoint(
    existing: V2KnownDecisionPoint,
    input: V2DecisionPointWriteInput,
  ): Promise<V2OpenDecisionPoint>;
}

export interface V2DecisionPointTransactionFactory<TTx extends V2DecisionPointTransaction> {
  bind(tx: V2SqlExecutor): TTx;
}

export type V2DecisionPointUpsertResult =
  | { kind: "created"; decision_point: V2OpenDecisionPoint }
  | { kind: "existing"; decision_point: V2OpenDecisionPoint }
  | {
      kind: "closed_unchanged";
      decision_point: V2KnownDecisionPoint;
    }
  | {
      kind: "superseded";
      decision_point: V2OpenDecisionPoint;
      superseded_decision_point_id: string;
    };

/**
 * Idempotent coordinator interruption boundary. One open point exists per
 * condition key; the same fingerprint reuses it, while changed material state
 * atomically supersedes the old revision.
 */
export async function upsertV2DecisionPoint<TTx extends V2DecisionPointTransaction>(options: {
  transactionRunner: V2TransactionRunner;
  transactionFactory: V2DecisionPointTransactionFactory<TTx>;
  input: V2DecisionPointInput;
}): Promise<V2DecisionPointUpsertResult> {
  const {
    occurred_at: occurredAt,
    actor_id: _actorId,
    correlation_id: _correlationId,
    causation_id: _causationId,
    ...pointInput
  } = options.input;
  const basePoint = V2DecisionPoint.parse({
    schema_version: 2,
    ...pointInput,
    condition_revision: 1,
    status: "open",
    supersedes_decision_point_id: null,
    superseded_by_decision_point_id: null,
    created_at: occurredAt,
    updated_at: occurredAt,
    resolved_at: null,
  });
  const writeInput: V2DecisionPointWriteInput = {
    ...options.input,
    status: "open",
    condition_revision: basePoint.condition_revision,
    supersedes_decision_point_id: null,
  };

  return options.transactionRunner.transaction(async (executor) => {
    const tx = options.transactionFactory.bind(executor);
    const existing = await tx.lockLatestDecisionPoint(writeInput.condition_key);
    if (!existing) {
      return {
        kind: "created",
        decision_point: await tx.insertDecisionPoint(writeInput),
      };
    }
    if (existing.condition_fingerprint === writeInput.condition_fingerprint) {
      if (existing.status === "open") {
        return {
          kind: "existing",
          decision_point: { ...existing, status: "open" },
        };
      }
      return { kind: "closed_unchanged", decision_point: existing };
    }
    const replacement = await tx.supersedeAndInsertDecisionPoint(existing, {
      ...writeInput,
      condition_revision: existing.condition_revision + 1,
      supersedes_decision_point_id: existing.id,
    });
    return {
      kind: "superseded",
      decision_point: replacement,
      superseded_decision_point_id: existing.id,
    };
  });
}
