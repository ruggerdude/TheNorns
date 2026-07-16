import {
  type V2AgentRunTransitionEventT,
  type V2IdempotencyAttemptT,
  V2IdempotencyRecord,
  type V2IdempotencyRecordT,
  type V2TaskTransitionEventT,
} from "@norns/contracts";
import { newId } from "../../ids.js";
import type {
  V2ApplicationTransaction,
  V2DecisionPointTransaction,
  V2DecisionPointWriteInput,
  V2IdempotencyAuditInput,
  V2KnownDecisionPoint,
  V2OpenDecisionPoint,
} from "./application.js";
import {
  type V2BudgetReservationRow,
  type V2BudgetResolutionRequest,
  type V2BudgetSweepRepository,
  type V2BudgetTransaction,
  V2BudgetVersionConflictError,
  type V2OrphanReservationCandidate,
} from "./budget.js";
import type { V2SqlExecutor } from "./database.js";
import type {
  V2AgentRunLifecycleCommitInput,
  V2LifecycleMutationTransaction,
  V2LockedAgentRunLifecycle,
  V2LockedTaskLifecycle,
  V2TaskLifecycleCommitInput,
} from "./lifecycleMutation.js";
import type {
  V2AgentRunLifecycleRow,
  V2LifecycleFinding,
  V2LifecycleIntegrityGuard,
  V2LifecycleReconciliationRepository,
  V2LifecycleRow,
  V2TaskLifecycleRow,
} from "./reconciliation.js";

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function number(value: number | string): number {
  return typeof value === "number" ? value : Number(value);
}

function idempotencyLockKey(scope: V2IdempotencyAttemptT): string {
  return `idempotency:${scope.actor_id}:${scope.command_family}:${scope.idempotency_key}`;
}

interface SqlIdempotencyRow {
  schema_version: number;
  actor_id: string;
  command_family: V2IdempotencyRecordT["command_family"];
  idempotency_key: string;
  request_fingerprint: string;
  command_id: string;
  status: V2IdempotencyRecordT["status"];
  response: V2IdempotencyRecordT["response"];
  created_at: string | Date;
  updated_at: string | Date;
  retain_until: string | Date;
  asynchronous_work_until: string | Date | null;
  rollback_window_until: string | Date | null;
}

export class SqlV2ApplicationTransaction
  implements V2ApplicationTransaction, V2LifecycleMutationTransaction
{
  constructor(private readonly sql: V2SqlExecutor) {}

  async tryAcquireIdempotencyLock(scope: V2IdempotencyAttemptT): Promise<boolean> {
    const result = await this.sql.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired",
      [idempotencyLockKey(scope)],
    );
    return result.rows[0]?.acquired ?? false;
  }

  async findIdempotency(scope: V2IdempotencyAttemptT): Promise<V2IdempotencyRecordT | null> {
    const result = await this.sql.query<SqlIdempotencyRow>(
      `SELECT schema_version, actor_id, command_family, idempotency_key,
              request_fingerprint, command_id, status, response, created_at,
              updated_at, retain_until, asynchronous_work_until, rollback_window_until
       FROM idempotency_records
       WHERE actor_id = $1 AND command_family = $2 AND idempotency_key = $3`,
      [scope.actor_id, scope.command_family, scope.idempotency_key],
    );
    const row = result.rows[0];
    if (!row) return null;
    return V2IdempotencyRecord.parse({
      ...row,
      created_at: iso(row.created_at),
      updated_at: iso(row.updated_at),
      retain_until: iso(row.retain_until),
      asynchronous_work_until:
        row.asynchronous_work_until === null ? null : iso(row.asynchronous_work_until),
      rollback_window_until:
        row.rollback_window_until === null ? null : iso(row.rollback_window_until),
    });
  }

  async insertIdempotency(record: V2IdempotencyRecordT): Promise<void> {
    await this.sql.query(
      `INSERT INTO idempotency_records (
         actor_id, command_family, idempotency_key, schema_version,
         request_fingerprint, command_id, status, response, created_at,
         updated_at, retain_until, asynchronous_work_until, rollback_window_until
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13)`,
      [
        record.actor_id,
        record.command_family,
        record.idempotency_key,
        record.schema_version,
        record.request_fingerprint,
        record.command_id,
        record.status,
        record.response === null ? null : JSON.stringify(record.response),
        record.created_at,
        record.updated_at,
        record.retain_until,
        record.asynchronous_work_until,
        record.rollback_window_until,
      ],
    );
  }

  async commitIdempotency(
    scope: V2IdempotencyAttemptT,
    status: "committed_succeeded" | "committed_failed",
    response: NonNullable<V2IdempotencyRecordT["response"]>,
    updatedAt: string,
  ): Promise<void> {
    const result = await this.sql.query<{ command_id: string }>(
      `UPDATE idempotency_records
       SET status = $4, response = $5::jsonb, updated_at = $6
       WHERE actor_id = $1 AND command_family = $2 AND idempotency_key = $3
       RETURNING command_id`,
      [
        scope.actor_id,
        scope.command_family,
        scope.idempotency_key,
        status,
        JSON.stringify(response),
        updatedAt,
      ],
    );
    if (!result.rows[0]) throw new Error("idempotency claim disappeared before commit");
  }

  async appendIdempotencyAudit(input: V2IdempotencyAuditInput): Promise<void> {
    await this.sql.query(
      `INSERT INTO audit_events (
         audit_id, audit_type, project_id, phase_id, task_id, actor_type,
         actor_id, outcome, severity, correlation_id, causation_id, occurred_at,
         targets, summary, details, redaction_applied
       ) VALUES (
         $1, 'idempotency.rejected', $2, $3, $4, $5, $6, 'denied', 'warning',
         $7, $8, $9, $10::jsonb, $11, $12::jsonb, true
       )`,
      [
        newId("audit"),
        input.project_id,
        input.phase_id,
        input.task_id,
        input.actor_type,
        input.actor_id,
        input.correlation_id,
        input.causation_id,
        input.occurred_at,
        JSON.stringify([{ entity_type: "command", entity_id: input.command_id }]),
        `Idempotency key reuse rejected: ${input.reason}`,
        JSON.stringify({
          command_family: input.command_family,
          idempotency_key: input.idempotency_key,
          request_fingerprint: input.request_fingerprint,
          existing_command_id: input.existing_command_id,
        }),
      ],
    );
  }

  async hasOpenFinding(aggregateKind: "task" | "agent_run", aggregateId: string): Promise<boolean> {
    const result = await this.sql.query<{ present: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM lifecycle_integrity_findings
         WHERE aggregate_kind = $1 AND aggregate_id = $2 AND status = 'open'
       ) AS present`,
      [aggregateKind, aggregateId],
    );
    return result.rows[0]?.present ?? false;
  }

  async lockTaskLifecycle(taskId: string): Promise<V2LockedTaskLifecycle | null> {
    const result = await this.sql.query<V2LockedTaskLifecycle>(
      `SELECT id, project_id, phase_id, state, lifecycle_version, aggregate_version
       FROM tasks
       WHERE id = $1
       FOR UPDATE`,
      [taskId],
    );
    return result.rows[0] ?? null;
  }

  async lockAgentRunLifecycle(runId: string): Promise<V2LockedAgentRunLifecycle | null> {
    const result = await this.sql.query<V2LockedAgentRunLifecycle>(
      `SELECT id, project_id, phase_id, task_id, state,
              lifecycle_version, aggregate_version
       FROM agent_runs
       WHERE id = $1
       FOR UPDATE`,
      [runId],
    );
    return result.rows[0] ?? null;
  }

  async commitTaskLifecycleTransition(
    input: V2TaskLifecycleCommitInput,
  ): Promise<V2LockedTaskLifecycle> {
    const result = await this.sql.query<V2LockedTaskLifecycle>(
      `UPDATE tasks
       SET state = $2,
           lifecycle_version = $3,
           aggregate_version = aggregate_version + 1,
           updated_at = $4,
           completed_at = CASE
             WHEN $2::text = 'completed' THEN $4::timestamptz
             ELSE completed_at
           END
       WHERE id = $1
         AND state = $5
         AND lifecycle_version = $6
         AND aggregate_version = $7
       RETURNING id, project_id, phase_id, state, lifecycle_version, aggregate_version`,
      [
        input.row.id,
        input.event.to,
        input.event.lifecycle_version,
        input.event.occurred_at,
        input.event.from,
        input.row.lifecycle_version,
        input.row.aggregate_version,
      ],
    );
    const updated = result.rows[0];
    if (!updated) throw new Error("Task lifecycle row changed after it was locked");

    await this.sql.query(
      `INSERT INTO domain_events (
         event_id, stream_type, stream_id, stream_version, event_type,
         project_id, phase_id, task_id, actor_type, actor_id, correlation_id,
         causation_id, occurred_at, payload
       ) VALUES (
         $1, 'task', $2, $3, 'task_state_transitioned',
         $4, $5, $2, $6, $7, $8, $9, $10, $11::jsonb
       )`,
      [
        input.event.event_id,
        input.row.id,
        input.event.lifecycle_version,
        input.row.project_id,
        input.row.phase_id,
        input.actor.actor_type,
        input.actor.actor_id,
        input.actor.correlation_id,
        input.actor.causation_id,
        input.event.occurred_at,
        JSON.stringify({
          kind: "task_state_transitioned",
          task_id: input.row.id,
          lifecycle_version: input.event.lifecycle_version,
          from: input.event.from,
          to: input.event.to,
          reason: input.event.reason,
        }),
      ],
    );
    await this.sql.query(
      `INSERT INTO audit_events (
         audit_id, audit_type, project_id, phase_id, task_id, actor_type,
         actor_id, outcome, severity, correlation_id, causation_id, occurred_at,
         targets, summary, details, redaction_applied
       ) VALUES (
         $1, 'task.lifecycle_transitioned', $2, $3, $4, $5, $6,
         'succeeded', 'info', $7, $8, $9, $10::jsonb, $11, $12::jsonb, true
       )`,
      [
        newId("audit"),
        input.row.project_id,
        input.row.phase_id,
        input.row.id,
        input.actor.actor_type,
        input.actor.actor_id,
        input.actor.correlation_id,
        input.actor.causation_id,
        input.event.occurred_at,
        JSON.stringify([{ entity_type: "task", entity_id: input.row.id }]),
        `Task transitioned ${input.event.from} -> ${input.event.to}`,
        JSON.stringify({
          lifecycle_version: input.event.lifecycle_version,
          reason: input.event.reason,
        }),
      ],
    );
    return updated;
  }

  async commitAgentRunLifecycleTransition(
    input: V2AgentRunLifecycleCommitInput,
  ): Promise<V2LockedAgentRunLifecycle> {
    const result = await this.sql.query<V2LockedAgentRunLifecycle>(
      `UPDATE agent_runs
       SET state = $2,
           lifecycle_version = $3,
           aggregate_version = aggregate_version + 1,
           updated_at = $4,
           started_at = CASE
             WHEN $2::text = 'running' AND started_at IS NULL THEN $4::timestamptz
             ELSE started_at
           END,
           finished_at = CASE
             WHEN $2::text IN ('succeeded', 'failed', 'cancelled', 'expired')
               THEN $4::timestamptz
             ELSE finished_at
           END
       WHERE id = $1
         AND state = $5
         AND lifecycle_version = $6
         AND aggregate_version = $7
       RETURNING id, project_id, phase_id, task_id, state,
                 lifecycle_version, aggregate_version`,
      [
        input.row.id,
        input.event.to,
        input.event.lifecycle_version,
        input.event.occurred_at,
        input.event.from,
        input.row.lifecycle_version,
        input.row.aggregate_version,
      ],
    );
    const updated = result.rows[0];
    if (!updated) throw new Error("AgentRun lifecycle row changed after it was locked");

    await this.sql.query(
      `INSERT INTO domain_events (
         event_id, stream_type, stream_id, stream_version, event_type,
         project_id, phase_id, task_id, actor_type, actor_id, correlation_id,
         causation_id, occurred_at, payload
       ) VALUES (
         $1, 'agent_run', $2, $3, 'agent_run_state_transitioned',
         $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb
       )`,
      [
        input.event.event_id,
        input.row.id,
        input.event.lifecycle_version,
        input.row.project_id,
        input.row.phase_id,
        input.row.task_id,
        input.actor.actor_type,
        input.actor.actor_id,
        input.actor.correlation_id,
        input.actor.causation_id,
        input.event.occurred_at,
        JSON.stringify({
          kind: "agent_run_state_transitioned",
          run_id: input.row.id,
          task_id: input.row.task_id,
          lifecycle_version: input.event.lifecycle_version,
          from: input.event.from,
          to: input.event.to,
          reason: input.event.reason,
        }),
      ],
    );
    await this.sql.query(
      `INSERT INTO audit_events (
         audit_id, audit_type, project_id, phase_id, task_id, actor_type,
         actor_id, outcome, severity, correlation_id, causation_id, occurred_at,
         targets, summary, details, redaction_applied
       ) VALUES (
         $1, 'agent_run.lifecycle_transitioned', $2, $3, $4, $5, $6,
         'succeeded', 'info', $7, $8, $9, $10::jsonb, $11, $12::jsonb, true
       )`,
      [
        newId("audit"),
        input.row.project_id,
        input.row.phase_id,
        input.row.task_id,
        input.actor.actor_type,
        input.actor.actor_id,
        input.actor.correlation_id,
        input.actor.causation_id,
        input.event.occurred_at,
        JSON.stringify([{ entity_type: "agent_run", entity_id: input.row.id }]),
        `AgentRun transitioned ${input.event.from} -> ${input.event.to}`,
        JSON.stringify({
          lifecycle_version: input.event.lifecycle_version,
          reason: input.event.reason,
        }),
      ],
    );
    return updated;
  }
}

interface SqlDecisionPointRow extends V2KnownDecisionPoint {}

export class SqlV2DecisionPointTransaction implements V2DecisionPointTransaction {
  constructor(private readonly sql: V2SqlExecutor) {}

  async lockLatestDecisionPoint(conditionKey: string): Promise<V2KnownDecisionPoint | null> {
    await this.sql.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `decision-point:${conditionKey}`,
    ]);
    const result = await this.sql.query<SqlDecisionPointRow>(
      `SELECT id, project_id, condition_key, condition_fingerprint,
              condition_revision, status, supersedes_decision_point_id
       FROM decision_points
       WHERE condition_key = $1
       ORDER BY condition_revision DESC, created_at DESC
       LIMIT 1
       FOR UPDATE`,
      [conditionKey],
    );
    return result.rows[0] ?? null;
  }

  async insertDecisionPoint(input: V2DecisionPointWriteInput): Promise<V2OpenDecisionPoint> {
    const result = await this.sql.query<SqlDecisionPointRow>(
      `INSERT INTO decision_points (
         id, project_id, phase_id, task_id, scope_entity_type, scope_entity_id,
         reason_class, source_instance_id, condition_key, condition_fingerprint,
         condition_revision, question, context, options, recommendation_option_id,
         urgency, blocking_scope, status, supersedes_decision_point_id,
         created_at, updated_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,
         $17::jsonb,'open',$18,$19,$19
       )
       RETURNING id, project_id, condition_key, condition_fingerprint,
                 condition_revision, status, supersedes_decision_point_id`,
      [
        input.id,
        input.project_id,
        input.phase_id,
        input.task_id,
        input.scope_entity_type,
        input.scope_entity_id,
        input.reason_class,
        input.source_instance_id,
        input.condition_key,
        input.condition_fingerprint,
        input.condition_revision,
        input.question,
        input.context,
        JSON.stringify(input.options),
        input.recommendation_option_id,
        input.urgency,
        JSON.stringify(input.blocking_scope),
        input.supersedes_decision_point_id,
        input.occurred_at,
      ],
    );
    const point = result.rows[0];
    if (!point) throw new Error("decision point insert returned no row");
    if (point.status !== "open") throw new Error("inserted decision point was not open");

    await this.sql.query(
      `INSERT INTO domain_events (
         event_id, stream_type, stream_id, stream_version, event_type,
         project_id, phase_id, task_id, actor_type, actor_id, correlation_id,
         causation_id, occurred_at, payload
       ) VALUES (
         $1, 'decision_point', $2, $3, 'decision_point_opened',
         $4, $5, $6, 'coordinator', $7, $8, $9, $10, $11::jsonb
       )`,
      [
        newId("event"),
        input.id,
        input.condition_revision,
        input.project_id,
        input.phase_id,
        input.task_id,
        input.actor_id,
        input.correlation_id,
        input.causation_id,
        input.occurred_at,
        JSON.stringify({
          kind: "decision_point_opened",
          decision_point_id: input.id,
          condition_key: input.condition_key,
          condition_fingerprint: input.condition_fingerprint,
        }),
      ],
    );
    await this.sql.query(
      `INSERT INTO audit_events (
         audit_id, audit_type, project_id, phase_id, task_id, actor_type,
         actor_id, outcome, severity, correlation_id, causation_id, occurred_at,
         targets, summary, details, redaction_applied
       ) VALUES (
         $1, 'decision_point.opened', $2, $3, $4, 'coordinator', $5,
         'succeeded', 'warning', $6, $7, $8, $9::jsonb, $10, $11::jsonb, true
       )`,
      [
        newId("audit"),
        input.project_id,
        input.phase_id,
        input.task_id,
        input.actor_id,
        input.correlation_id,
        input.causation_id,
        input.occurred_at,
        JSON.stringify([{ entity_type: "decision_point", entity_id: input.id }]),
        input.question,
        JSON.stringify({
          condition_key: input.condition_key,
          condition_fingerprint: input.condition_fingerprint,
          condition_revision: input.condition_revision,
        }),
      ],
    );
    return { ...point, status: "open" };
  }

  async supersedeAndInsertDecisionPoint(
    existing: V2KnownDecisionPoint,
    input: V2DecisionPointWriteInput,
  ): Promise<V2OpenDecisionPoint> {
    const result = await this.sql.query<{ id: string }>(
      `UPDATE decision_points
       SET status = 'superseded', updated_at = $2
       WHERE id = $1
       RETURNING id`,
      [existing.id, input.occurred_at],
    );
    if (!result.rows[0]) throw new Error("decision point disappeared before supersession");
    const replacement = await this.insertDecisionPoint(input);
    await this.sql.query(
      `UPDATE decision_points
       SET superseded_by_decision_point_id = $2
       WHERE id = $1`,
      [existing.id, replacement.id],
    );
    return replacement;
  }
}

interface SqlBudgetReservationRow {
  id: string;
  project_id: string;
  phase_id: string;
  task_id: string;
  run_id: string;
  amount_usd: number | string;
  settled_usd: number | string;
  released_usd: number | string;
  retained_usd: number | string;
  status: V2BudgetReservationRow["status"];
  resolution_outcome: V2BudgetReservationRow["resolution_outcome"];
  version: number;
  expires_at: string | Date;
}

function mapBudgetReservation(row: SqlBudgetReservationRow): V2BudgetReservationRow {
  return {
    ...row,
    amount_usd: number(row.amount_usd),
    settled_usd: number(row.settled_usd),
    released_usd: number(row.released_usd),
    retained_usd: number(row.retained_usd),
    expires_at: iso(row.expires_at),
  };
}

export class SqlV2BudgetTransaction implements V2BudgetTransaction {
  constructor(private readonly sql: V2SqlExecutor) {}

  async lockReservation(reservationId: string): Promise<V2BudgetReservationRow | null> {
    const result = await this.sql.query<SqlBudgetReservationRow>(
      `SELECT id, project_id, phase_id, task_id, run_id, amount_usd,
              settled_usd, released_usd, retained_usd, status,
              resolution_outcome, version, expires_at
       FROM budget_reservations
       WHERE id = $1
       FOR UPDATE`,
      [reservationId],
    );
    const row = result.rows[0];
    return row ? mapBudgetReservation(row) : null;
  }

  async applyResolution(
    reservation: V2BudgetReservationRow,
    request: V2BudgetResolutionRequest,
    resolution: {
      status: V2BudgetReservationRow["status"];
      settled_usd: number;
      released_usd: number;
      retained_usd: number;
    },
  ): Promise<V2BudgetReservationRow> {
    const result = await this.sql.query<SqlBudgetReservationRow>(
      `UPDATE budget_reservations
       SET status = $2, settled_usd = $3, released_usd = $4, retained_usd = $5,
           resolution_outcome = $6, version = version + 1, updated_at = $7
       WHERE id = $1 AND version = $8 AND resolution_outcome IS NULL
       RETURNING id, project_id, phase_id, task_id, run_id, amount_usd,
                 settled_usd, released_usd, retained_usd, status,
                 resolution_outcome, version, expires_at`,
      [
        reservation.id,
        resolution.status,
        resolution.settled_usd,
        resolution.released_usd,
        resolution.retained_usd,
        request.outcome,
        request.occurred_at,
        request.expected_version,
      ],
    );
    const updated = result.rows[0];
    if (!updated) {
      throw new V2BudgetVersionConflictError(
        reservation.id,
        request.expected_version,
        reservation.version + 1,
      );
    }

    await this.sql.query(
      `INSERT INTO domain_events (
         event_id, stream_type, stream_id, stream_version, event_type,
         project_id, phase_id, task_id, actor_type, actor_id, correlation_id,
         causation_id, occurred_at, payload
       ) VALUES (
         $1, 'budget_reservation', $2, $3, 'budget_reservation_resolved',
         $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb
       )`,
      [
        newId("event"),
        reservation.id,
        updated.version,
        reservation.project_id,
        reservation.phase_id,
        reservation.task_id,
        request.actor_type,
        request.actor_id,
        request.correlation_id,
        request.causation_id,
        request.occurred_at,
        JSON.stringify({
          kind: "budget_reservation_resolved",
          reservation_id: reservation.id,
          task_id: reservation.task_id,
          run_id: reservation.run_id,
          outcome: request.outcome,
          settled_usd: resolution.settled_usd,
          released_usd: resolution.released_usd,
          retained_usd: resolution.retained_usd,
        }),
      ],
    );
    await this.sql.query(
      `INSERT INTO audit_events (
         audit_id, audit_type, project_id, phase_id, task_id, actor_type,
         actor_id, outcome, severity, correlation_id, causation_id, occurred_at,
         targets, summary, details, redaction_applied
       ) VALUES (
         $1, 'budget.resolved', $2, $3, $4, $5, $6,
         'succeeded', 'info', $7, $8, $9, $10::jsonb, $11, $12::jsonb, true
       )`,
      [
        newId("audit"),
        reservation.project_id,
        reservation.phase_id,
        reservation.task_id,
        request.actor_type,
        request.actor_id,
        request.correlation_id,
        request.causation_id,
        request.occurred_at,
        JSON.stringify([{ entity_type: "budget_reservation", entity_id: reservation.id }]),
        request.reason,
        JSON.stringify({ outcome: request.outcome, ...resolution }),
      ],
    );
    return mapBudgetReservation(updated);
  }
}

export class SqlV2BudgetSweepRepository implements V2BudgetSweepRepository {
  constructor(private readonly sql: V2SqlExecutor) {}

  async findOrphanCandidates(at: string, limit: number): Promise<V2OrphanReservationCandidate[]> {
    const result = await this.sql.query<V2OrphanReservationCandidate>(
      `SELECT id AS reservation_id, version AS expected_version,
              'expired'::text AS safe_outcome,
              'expired orphan reservation'::text AS reason,
              project_id
       FROM budget_reservations
       WHERE status = 'active' AND expires_at <= $1
       ORDER BY expires_at, id
       LIMIT $2`,
      [at, limit],
    );
    return result.rows;
  }
}

interface SqlTaskLifecycleEventRow {
  event_id: string;
  task_id: string;
  lifecycle_version: number;
  occurred_at: string | Date;
  from_state: V2TaskTransitionEventT["from"];
  to_state: V2TaskTransitionEventT["to"];
  reason: string | null;
}

interface SqlAgentRunLifecycleEventRow {
  event_id: string;
  run_id: string;
  task_id: string;
  lifecycle_version: number;
  occurred_at: string | Date;
  from_state: V2AgentRunTransitionEventT["from"];
  to_state: V2AgentRunTransitionEventT["to"];
  reason: string | null;
}

export class SqlV2LifecycleRepository
  implements V2LifecycleReconciliationRepository, V2LifecycleIntegrityGuard
{
  constructor(private readonly sql: V2SqlExecutor) {}

  async listLifecycleRows(): Promise<V2LifecycleRow[]> {
    const taskRows = await this.sql.query<Omit<V2TaskLifecycleRow, "kind">>(
      "SELECT id, project_id, state, lifecycle_version FROM tasks",
    );
    const runRows = await this.sql.query<Omit<V2AgentRunLifecycleRow, "kind">>(
      "SELECT id, project_id, task_id, state, lifecycle_version FROM agent_runs",
    );
    return [
      ...taskRows.rows.map((row) => ({ kind: "task" as const, ...row })),
      ...runRows.rows.map((row) => ({ kind: "agent_run" as const, ...row })),
    ];
  }

  async taskEvents(taskId: string): Promise<V2TaskTransitionEventT[]> {
    const result = await this.sql.query<SqlTaskLifecycleEventRow>(
      `SELECT event_id, task_id, (payload->>'lifecycle_version')::int AS lifecycle_version,
              occurred_at, payload->>'from' AS from_state, payload->>'to' AS to_state,
              payload->>'reason' AS reason
       FROM domain_events
       WHERE stream_type = 'task' AND stream_id = $1
         AND event_type = 'task_state_transitioned'
       ORDER BY stream_version`,
      [taskId],
    );
    return result.rows.map((row) => ({
      schema_version: 2,
      event_id: row.event_id,
      task_id: row.task_id,
      lifecycle_version: row.lifecycle_version,
      occurred_at: iso(row.occurred_at),
      from: row.from_state,
      to: row.to_state,
      reason: row.reason,
    }));
  }

  async agentRunEvents(runId: string): Promise<V2AgentRunTransitionEventT[]> {
    const result = await this.sql.query<SqlAgentRunLifecycleEventRow>(
      `SELECT event_id, payload->>'run_id' AS run_id, task_id,
              (payload->>'lifecycle_version')::int AS lifecycle_version,
              occurred_at, payload->>'from' AS from_state, payload->>'to' AS to_state,
              payload->>'reason' AS reason
       FROM domain_events
       WHERE stream_type = 'agent_run' AND stream_id = $1
         AND event_type = 'agent_run_state_transitioned'
       ORDER BY stream_version`,
      [runId],
    );
    return result.rows.map((row) => ({
      schema_version: 2,
      event_id: row.event_id,
      run_id: row.run_id,
      task_id: row.task_id,
      lifecycle_version: row.lifecycle_version,
      occurred_at: iso(row.occurred_at),
      from: row.from_state,
      to: row.to_state,
      reason: row.reason,
    }));
  }

  async recordFindingAndAudit(finding: V2LifecycleFinding): Promise<void> {
    await this.sql.query(
      `WITH recorded AS (
         INSERT INTO lifecycle_integrity_findings (
           id, aggregate_kind, aggregate_id, project_id, code, details,
           status, detected_at
         ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,'open',$7)
         ON CONFLICT (aggregate_kind, aggregate_id) WHERE status = 'open'
         DO UPDATE SET code = EXCLUDED.code, details = EXCLUDED.details,
                       detected_at = EXCLUDED.detected_at
         RETURNING id
       )
       INSERT INTO audit_events (
         audit_id, audit_type, project_id, actor_type, actor_id, outcome,
         severity, correlation_id, occurred_at, targets, summary, details,
         redaction_applied
       )
       SELECT $8, 'lifecycle.integrity_mismatch', $4, 'system', 'reconciliation',
              'observed', 'critical', $9, $7, $10::jsonb, $11, $6::jsonb, true
       FROM recorded`,
      [
        newId("integrity"),
        finding.aggregate_kind,
        finding.aggregate_id,
        finding.project_id,
        finding.code,
        JSON.stringify(finding),
        finding.detected_at,
        newId("audit"),
        `reconciliation:${finding.aggregate_kind}:${finding.aggregate_id}`,
        JSON.stringify([
          {
            entity_type: finding.aggregate_kind === "task" ? "task" : "agent_run",
            entity_id: finding.aggregate_id,
          },
        ]),
        `Lifecycle mismatch detected: ${finding.code}`,
      ],
    );
  }

  async hasOpenFinding(aggregateKind: "task" | "agent_run", aggregateId: string): Promise<boolean> {
    const result = await this.sql.query<{ present: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM lifecycle_integrity_findings
         WHERE aggregate_kind = $1 AND aggregate_id = $2 AND status = 'open'
       ) AS present`,
      [aggregateKind, aggregateId],
    );
    return result.rows[0]?.present ?? false;
  }
}

export const sqlV2ApplicationTransactionFactory = {
  bind: (sql: V2SqlExecutor): SqlV2ApplicationTransaction => new SqlV2ApplicationTransaction(sql),
};

export const sqlV2LifecycleMutationTransactionFactory = {
  bind: (sql: V2SqlExecutor): V2LifecycleMutationTransaction =>
    new SqlV2ApplicationTransaction(sql),
};

export const sqlV2DecisionPointTransactionFactory = {
  bind: (sql: V2SqlExecutor): V2DecisionPointTransaction => new SqlV2DecisionPointTransaction(sql),
};

export const sqlV2BudgetTransactionFactory = {
  bind: (sql: V2SqlExecutor): V2BudgetTransaction => new SqlV2BudgetTransaction(sql),
};

export const sqlV2BudgetSweepRepositoryFactory = {
  bind: (sql: V2SqlExecutor): V2BudgetSweepRepository => new SqlV2BudgetSweepRepository(sql),
};
