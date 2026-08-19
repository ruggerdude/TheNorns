import { createHash } from "node:crypto";
import {
  type CancellationConfirmationStateT,
  ConversationExecutionProjection,
  type ConversationExecutionProjectionT,
  ProjectRunCancellationProjection,
  type ProjectRunCancellationProjectionT,
  type V2AgentRunStateT,
} from "@norns/contracts";

import type { V2SqlExecutor, V2TransactionRunner } from "../persistence/v2/database.js";
import { transitionV2AgentRunLifecycle } from "../persistence/v2/lifecycleMutation.js";
import { SqlV2ApplicationTransaction } from "../persistence/v2/sqlRepositories.js";
import { PostgresDeviceAuthorizationPolicy } from "./policy.js";

export type DeviceRunCancellationCause = "project_stop" | "device_revocation" | "emergency_stop";

export interface DeviceRunCancellationRecord {
  run_id: string;
  device_id: string;
  credential_id: string;
  device_generation: number;
  cause: DeviceRunCancellationCause;
  state: CancellationConfirmationStateT;
  requested_by_user_id: string;
  reason: string;
  requested_at: string;
  runner_acknowledged_at: string | null;
  process_exited_at: string | null;
  unconfirmed_offline_at: string | null;
  publication_fenced_at: string | null;
  publication_reauthorized_by_user_id: string | null;
  publication_reauthorized_at: string | null;
  idempotency_key?: string | null;
}

export interface DeviceRunCancellationRequestOutcome {
  record: DeviceRunCancellationRecord;
  replayed: boolean;
}

export interface DeviceRunCancellationServiceOptions {
  /**
   * Best-effort online stop delivery after the request transaction commits.
   * Authorized idempotent replays invoke the hook so lost delivery can be
   * retried; hook failures cannot change the committed cancellation record.
   */
  afterRequested?: (
    outcome: DeviceRunCancellationRequestOutcome,
  ) => boolean | undefined | Promise<boolean | undefined>;
}

interface DeviceRunCancellationRow
  extends Omit<
    DeviceRunCancellationRecord,
    | "device_generation"
    | "requested_at"
    | "runner_acknowledged_at"
    | "process_exited_at"
    | "unconfirmed_offline_at"
    | "publication_fenced_at"
    | "publication_reauthorized_at"
  > {
  device_generation: number | string;
  requested_at: string | Date;
  runner_acknowledged_at: string | Date | null;
  process_exited_at: string | Date | null;
  unconfirmed_offline_at: string | Date | null;
  publication_fenced_at: string | Date | null;
  publication_reauthorized_at: string | Date | null;
}

interface ProjectRunScopeRow {
  phase_id: string;
  task_id: string;
  state: string;
  device_id: string;
  credential_id: string;
  device_generation: number | string;
  never_dispatched: boolean;
}

interface ConversationLinkedRunRow {
  run_id: string;
  run_state: V2AgentRunStateT;
  binding_id: string;
}

interface ConversationTargetRow {
  execution_target_id: string;
  name: string;
  stoppable: boolean;
}

const CANCELLATION_COLUMNS = `
  run_id,device_id,credential_id,device_generation,cause,state,
  requested_by_user_id,reason,requested_at,runner_acknowledged_at,
  process_exited_at,unconfirmed_offline_at,publication_fenced_at,
  publication_reauthorized_by_user_id,publication_reauthorized_at,
  idempotency_key`;

function timestamp(value: string | Date | null): string | null {
  if (value === null) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function cancellationRecord(row: DeviceRunCancellationRow): DeviceRunCancellationRecord {
  return {
    ...row,
    device_generation: Number(row.device_generation),
    requested_at: timestamp(row.requested_at) ?? "",
    runner_acknowledged_at: timestamp(row.runner_acknowledged_at),
    process_exited_at: timestamp(row.process_exited_at),
    unconfirmed_offline_at: timestamp(row.unconfirmed_offline_at),
    publication_fenced_at: timestamp(row.publication_fenced_at),
    publication_reauthorized_at: timestamp(row.publication_reauthorized_at),
  };
}

export class DeviceRunCancellationError extends Error {
  constructor(
    readonly code:
      | "cancellation_conflict"
      | "cancellation_not_found"
      | "device_evidence_mismatch"
      | "process_tree_not_reaped"
      | "publication_not_fenced"
      | "publication_reauthorization_not_authorized"
      | "publication_already_reauthorized",
  ) {
    super(
      code === "cancellation_conflict"
        ? "A different cancellation request already exists for this run."
        : code === "cancellation_not_found"
          ? "No device cancellation request exists for this run."
          : code === "device_evidence_mismatch"
            ? "Cancellation evidence did not come from the requested device credential generation."
            : code === "process_tree_not_reaped"
              ? "Process exit cannot be confirmed until the complete managed process tree is reaped."
              : code === "publication_not_fenced"
                ? "This run has no device-revocation publication fence."
                : code === "publication_reauthorization_not_authorized"
                  ? "Publication reauthorization requires current project and device-grant authority."
                  : "Publication was already explicitly reauthorized.",
    );
    this.name = "DeviceRunCancellationError";
  }
}

export class ProjectRunCancellationError extends Error {
  constructor(
    readonly code:
      | "project_run_not_found"
      | "project_run_not_stoppable"
      | "idempotency_conflict"
      | "conversation_not_found"
      | "conversation_execution_unavailable",
  ) {
    super(
      code === "project_run_not_found"
        ? "The project run was not found."
        : code === "project_run_not_stoppable"
          ? "The selected run cannot be stopped through a device cancellation."
          : code === "idempotency_conflict"
            ? "The idempotency key was already used for a different cancellation request."
            : code === "conversation_not_found"
              ? "The conversation was not found."
              : "The conversation run has no truthful device execution target.",
    );
    this.name = "ProjectRunCancellationError";
  }
}

async function selectedCancellation(
  sql: V2SqlExecutor,
  runId: string,
): Promise<DeviceRunCancellationRow | null> {
  const selected = await sql.query<DeviceRunCancellationRow>(
    `SELECT ${CANCELLATION_COLUMNS}
       FROM device_run_cancellations
      WHERE run_id=$1`,
    [runId],
  );
  return selected.rows[0] ?? null;
}

function projectCancellationProjection(
  projectId: string,
  record: DeviceRunCancellationRecord,
): ProjectRunCancellationProjectionT {
  return ProjectRunCancellationProjection.parse({
    project_id: projectId,
    run_id: record.run_id,
    state: record.state,
    cancellation_requested_at: record.requested_at,
    runner_acknowledged_at: record.runner_acknowledged_at,
    process_exited_at: record.process_exited_at,
    unconfirmed_offline_at: record.unconfirmed_offline_at,
  });
}

function auditIdentity(actorUserId: string, idempotencyKey: string): string {
  return createHash("sha256")
    .update(`project-run-cancellation\u0000${actorUserId}\u0000${idempotencyKey}`)
    .digest("hex");
}

function sameRequest(
  row: DeviceRunCancellationRow,
  input: {
    device_id: string;
    credential_id: string;
    device_generation: number;
    cause: DeviceRunCancellationCause;
    requested_by_user_id: string;
    reason: string;
    requested_at: string;
  },
): boolean {
  return (
    row.device_id === input.device_id &&
    row.credential_id === input.credential_id &&
    Number(row.device_generation) === input.device_generation &&
    row.cause === input.cause &&
    row.requested_by_user_id === input.requested_by_user_id &&
    row.reason === input.reason &&
    timestamp(row.requested_at) === new Date(input.requested_at).toISOString()
  );
}

/**
 * Persists only server facts and authenticated device evidence. The caller
 * must obtain the relevant typed authorization decision before invoking a
 * mutation; this service deliberately does not collapse those decisions into
 * one generic "device access" boolean.
 */
export class DeviceRunCancellationService {
  constructor(
    private readonly transactions: V2TransactionRunner,
    private readonly options: DeviceRunCancellationServiceOptions = {},
  ) {}

  async request(input: {
    run_id: string;
    device_id: string;
    credential_id: string;
    device_generation: number;
    cause: DeviceRunCancellationCause;
    requested_by_user_id: string;
    reason: string;
    requested_at: string;
  }): Promise<DeviceRunCancellationRequestOutcome> {
    const outcome = await this.transactions.transaction(async (sql) => {
      const currentIdentity = await sql.query<{ device_id: string }>(
        `SELECT device.id AS device_id
           FROM devices device
           JOIN users owner
             ON owner.id=device.owner_user_id
            AND owner.status='active'
           JOIN device_credentials credential
             ON credential.device_id=device.id
            AND credential.id=$2
            AND credential.generation=$3
            AND credential.state='active'
          WHERE device.id=$1
            AND device.lifecycle='active'
            AND device.current_generation=$3
            AND EXISTS (
              SELECT 1
                FROM commands command
               WHERE command.command_id=(
                 SELECT latest.command_id
                   FROM commands latest
                  WHERE latest.run_id=$4
                  ORDER BY latest.created_at DESC,latest.command_id DESC
                  LIMIT 1
               )
                 AND command.runner_id=device.id
                 AND command.runner_generation=$3
            )
          FOR UPDATE OF device,credential`,
        [input.device_id, input.credential_id, input.device_generation, input.run_id],
      );
      if (!currentIdentity.rows[0]) {
        throw new DeviceRunCancellationError("device_evidence_mismatch");
      }
      const inserted = await sql.query<DeviceRunCancellationRow>(
        `INSERT INTO device_run_cancellations (
           run_id,device_id,credential_id,device_generation,cause,state,
           requested_by_user_id,reason,requested_at,publication_fenced_at,updated_at
         ) VALUES (
           $1,$2,$3,$4,$5,'cancellation_requested',$6,$7,$8,
           CASE WHEN $5='device_revocation' THEN $8::timestamptz ELSE NULL END,
           $8
         )
         ON CONFLICT (run_id) DO NOTHING
         RETURNING ${CANCELLATION_COLUMNS}`,
        [
          input.run_id,
          input.device_id,
          input.credential_id,
          input.device_generation,
          input.cause,
          input.requested_by_user_id,
          input.reason,
          input.requested_at,
        ],
      );
      const created = inserted.rows[0];
      if (created) return { record: cancellationRecord(created), replayed: false };

      const existing = await selectedCancellation(sql, input.run_id);
      if (!existing || !sameRequest(existing, input)) {
        throw new DeviceRunCancellationError("cancellation_conflict");
      }
      return { record: cancellationRecord(existing), replayed: true };
    });
    try {
      const delivered = await this.options.afterRequested?.(outcome);
      if (delivered === false) {
        return {
          ...outcome,
          record: await this.markUnconfirmedOffline({
            run_id: outcome.record.run_id,
            recorded_at: outcome.record.requested_at,
          }),
        };
      }
    } catch {
      // The request or authorized replay is already committed. Online stop
      // delivery is best-effort and cannot rewrite that durable result.
    }
    return outcome;
  }

  async requestProjectStop(input: {
    actor_user_id: string;
    project_id: string;
    run_id: string;
    reason: string;
    idempotency_key: string;
    requested_at: string;
  }): Promise<ProjectRunCancellationProjectionT> {
    const outcome = await this.transactions.transaction(async (sql) => {
      const ownerScope = await sql.query<{
        phase_id: string;
        task_id: string;
      }>(
        `SELECT run.phase_id,run.task_id
           FROM users actor
           JOIN projects project
             ON project.owner_user_id=actor.id
            AND project.id=$2
            AND project.status='active'
           JOIN agent_runs run
             ON run.id=$3
            AND run.project_id=project.id
          WHERE actor.id=$1
            AND actor.status='active'
          FOR UPDATE OF actor,project,run`,
        [input.actor_user_id, input.project_id, input.run_id],
      );
      const owner = ownerScope.rows[0];
      if (!owner) throw new ProjectRunCancellationError("project_run_not_found");

      const keyed = await sql.query<DeviceRunCancellationRow>(
        `SELECT ${CANCELLATION_COLUMNS}
           FROM device_run_cancellations
          WHERE requested_by_user_id=$1
            AND idempotency_key=$2
          FOR UPDATE`,
        [input.actor_user_id, input.idempotency_key],
      );
      const prior = keyed.rows[0];
      if (prior) {
        if (
          prior.run_id !== input.run_id ||
          prior.cause !== "project_stop" ||
          prior.reason !== input.reason
        ) {
          throw new ProjectRunCancellationError("idempotency_conflict");
        }
        return {
          outcome: {
            record: cancellationRecord(prior),
            replayed: true,
          },
          phase_id: owner.phase_id,
          task_id: owner.task_id,
        };
      }

      const decision = await new PostgresDeviceAuthorizationPolicy(sql).canStopProjectRun(input);
      if (!decision.allowed) throw new ProjectRunCancellationError("project_run_not_stoppable");

      const scope = await sql.query<ProjectRunScopeRow>(
        `SELECT
           run.phase_id,
           run.task_id,
           run.state,
           device.id AS device_id,
           credential.id AS credential_id,
           credential.generation AS device_generation,
           (
             NOT EXISTS (
               SELECT 1
                 FROM dispatch_jobs prior_job
                WHERE prior_job.run_id=run.id
                  AND prior_job.status IN ('delivered','completed')
             )
             AND NOT EXISTS (
               SELECT 1
                 FROM commands prior_command
                WHERE prior_command.run_id=run.id
                  AND prior_command.status NOT IN ('created','queued')
             )
           ) AS never_dispatched
         FROM agent_runs run
         JOIN repository_bindings binding
           ON binding.id=run.repository_binding_id
          AND binding.project_id=run.project_id
          AND binding.binding_type='local_runner'
          AND binding.status IN ('connected','degraded','disconnected')
         JOIN project_device_repository_grants grant_record
           ON grant_record.id=binding.project_device_repository_grant_id
          AND grant_record.project_id=binding.project_id
          AND grant_record.state='active'
         JOIN device_repository_registrations registration
           ON registration.id=grant_record.repository_registration_id
          AND registration.state='active'
          AND registration.workspace_id=binding.workspace_id
          AND registration.repository_id=binding.repository_id
         JOIN devices device
           ON device.id=registration.device_id
          AND device.lifecycle='active'
         JOIN users device_owner
           ON device_owner.id=device.owner_user_id
          AND device_owner.status='active'
         JOIN device_credentials credential
           ON credential.device_id=device.id
          AND credential.id=registration.approved_credential_id
          AND credential.generation=registration.approved_generation
          AND credential.generation=device.current_generation
          AND credential.state='active'
         JOIN commands command
           ON command.command_id=(
             SELECT latest.command_id
               FROM commands latest
              WHERE latest.run_id=run.id
              ORDER BY latest.created_at DESC,latest.command_id DESC
              LIMIT 1
           )
          AND command.runner_id=device.id
          AND command.runner_generation=device.current_generation
        WHERE run.id=$1
          AND run.project_id=$2
        FOR UPDATE OF run,binding,grant_record,registration,
                      device,device_owner,credential,command`,
        [input.run_id, input.project_id],
      );
      const run = scope.rows[0];
      if (!run) throw new ProjectRunCancellationError("project_run_not_stoppable");

      const inserted = await sql.query<DeviceRunCancellationRow>(
        `INSERT INTO device_run_cancellations (
           run_id,device_id,credential_id,device_generation,cause,state,
           requested_by_user_id,reason,requested_at,publication_fenced_at,
           updated_at,idempotency_key
         ) VALUES (
           $1,$2,$3,$4,'project_stop','cancellation_requested',
           $5,$6,$7,$7,$7,$8
         )
         ON CONFLICT DO NOTHING
         RETURNING ${CANCELLATION_COLUMNS}`,
        [
          input.run_id,
          run.device_id,
          run.credential_id,
          Number(run.device_generation),
          input.actor_user_id,
          input.reason,
          input.requested_at,
          input.idempotency_key,
        ],
      );
      const created = inserted.rows[0];
      if (!created) {
        const collision = await selectedCancellation(sql, input.run_id);
        if (
          collision?.requested_by_user_id === input.actor_user_id &&
          collision.idempotency_key === input.idempotency_key &&
          collision.cause === "project_stop" &&
          collision.reason === input.reason
        ) {
          return {
            outcome: {
              record: cancellationRecord(collision),
              replayed: true,
            },
            phase_id: owner.phase_id,
            task_id: owner.task_id,
          };
        }
        throw new ProjectRunCancellationError("idempotency_conflict");
      }

      await sql.query(
        `UPDATE commands
            SET status='cancelled',updated_at=$2
          WHERE run_id=$1
            AND status IN ('created','queued')`,
        [input.run_id, input.requested_at],
      );
      await sql.query(
        `UPDATE dispatch_jobs
            SET status='cancelled',
                completed_at=$2,
                updated_at=$2,
                lease_owner=NULL,
                lease_expires_at=NULL
          WHERE run_id=$1
            AND status IN ('queued','leased')`,
        [input.run_id, input.requested_at],
      );
      await sql.query(
        `UPDATE gateway_credentials
            SET revoked_at=COALESCE(revoked_at,$2)
          WHERE run_id=$1
            AND revoked_at IS NULL`,
        [input.run_id, input.requested_at],
      );
      await sql.query(
        `UPDATE dispatch_context_documents
            SET revoked_at=COALESCE(revoked_at,$2)
          WHERE run_id=$1
            AND revoked_at IS NULL`,
        [input.run_id, input.requested_at],
      );

      const auditKey = auditIdentity(input.actor_user_id, input.idempotency_key);
      if (run.never_dispatched) {
        const lifecycle = new SqlV2ApplicationTransaction(sql);
        const lockedRun = await lifecycle.lockAgentRunLifecycle(input.run_id);
        if (lockedRun && ["created", "dispatched"].includes(lockedRun.state)) {
          await transitionV2AgentRunLifecycle(lifecycle, {
            project_id: input.project_id,
            phase_id: run.phase_id,
            task_id: run.task_id,
            run_id: input.run_id,
            expected_aggregate_version: lockedRun.aggregate_version,
            to: "cancelled",
            reason: "project owner cancelled the run before runner dispatch",
            actor_type: "human",
            actor_id: input.actor_user_id,
            correlation_id: `project-run-cancellation:${auditKey}`,
            causation_id: input.run_id,
            occurred_at: input.requested_at,
          });
        }
      }
      await sql.query(
        `INSERT INTO audit_events (
           audit_id,audit_type,project_id,phase_id,task_id,
           actor_type,actor_id,outcome,severity,correlation_id,
           causation_id,occurred_at,targets,summary,details,redaction_applied
         ) VALUES (
           $1,'device.project_run_cancellation_requested',$2,$3,$4,
           'human',$5,'succeeded','warning',$6,$7,$8,$9::jsonb,
           'Project run cancellation requested',$10::jsonb,true
         )
         ON CONFLICT (audit_id) DO NOTHING`,
        [
          `audit:project-run-cancellation:${auditKey}`,
          input.project_id,
          run.phase_id,
          run.task_id,
          input.actor_user_id,
          `project-run-cancellation:${auditKey}`,
          input.run_id,
          input.requested_at,
          JSON.stringify([{ entity_type: "agent_run", entity_id: input.run_id }]),
          JSON.stringify({
            cause: "project_stop",
            reason: input.reason,
            publication_fenced: true,
          }),
        ],
      );
      return {
        outcome: {
          record: cancellationRecord(created),
          replayed: false,
        },
        phase_id: owner.phase_id,
        task_id: owner.task_id,
      };
    });

    let record = outcome.outcome.record;
    try {
      const delivered = await this.options.afterRequested?.(outcome.outcome);
      if (delivered === false) {
        record = await this.markUnconfirmedOffline({
          run_id: record.run_id,
          recorded_at: record.requested_at,
        });
      }
    } catch {
      // Durable cancellation and every authorization fence already committed.
    }
    return projectCancellationProjection(input.project_id, record);
  }

  async requestAllProjectStops(input: {
    actor_user_id: string;
    project_id: string;
    reason: string;
    idempotency_key: string;
    requested_at: string;
  }): Promise<{
    cancellations: ProjectRunCancellationProjectionT[];
    failed_run_ids: string[];
  }> {
    const runIds = await this.transactions.transaction(async (sql) => {
      const access = await sql.query<{ id: string }>(
        `SELECT actor.id
           FROM users actor
           JOIN projects project
             ON project.owner_user_id=actor.id
            AND project.id=$2
            AND project.status='active'
          WHERE actor.id=$1 AND actor.status='active'`,
        [input.actor_user_id, input.project_id],
      );
      if (!access.rows[0]) throw new ProjectRunCancellationError("project_run_not_found");
      const runs = await sql.query<{ id: string }>(
        `SELECT run.id
           FROM agent_runs run
          WHERE run.project_id=$1
            AND run.state IN ('created','dispatched','running','waiting_for_human','verifying')
            AND NOT EXISTS (
              SELECT 1 FROM device_run_cancellations cancellation
               WHERE cancellation.run_id=run.id
            )
          ORDER BY run.created_at ASC, run.id ASC`,
        [input.project_id],
      );
      return runs.rows.map((run) => run.id);
    });

    const cancellations: ProjectRunCancellationProjectionT[] = [];
    const failedRunIds: string[] = [];
    for (const runId of runIds) {
      const runKey = createHash("sha256").update(`${input.idempotency_key}:${runId}`).digest("hex");
      try {
        cancellations.push(
          await this.requestProjectStop({
            actor_user_id: input.actor_user_id,
            project_id: input.project_id,
            run_id: runId,
            reason: input.reason,
            idempotency_key: `stop-all-${runKey}`,
            requested_at: input.requested_at,
          }),
        );
      } catch {
        failedRunIds.push(runId);
      }
    }
    return { cancellations, failed_run_ids: failedRunIds };
  }

  getProjectCancellation(
    actorUserId: string,
    projectId: string,
    runId: string,
  ): Promise<ProjectRunCancellationProjectionT | null> {
    return this.transactions.transaction(async (sql) => {
      const selected = await sql.query<DeviceRunCancellationRow>(
        `SELECT ${CANCELLATION_COLUMNS}
           FROM device_run_cancellations
          WHERE run_id=$3
            AND EXISTS (
              SELECT 1
                FROM users actor
                JOIN projects project
                  ON project.id=$2
                 AND project.status='active'
                JOIN agent_runs run
                  ON run.project_id=project.id
                 AND run.id=device_run_cancellations.run_id
               WHERE actor.id=$1
                 AND actor.status='active'
                 AND (
                   project.owner_user_id=actor.id
                   OR EXISTS (
                     SELECT 1
                       FROM project_members membership
                      WHERE membership.project_id=project.id
                        AND membership.user_id=actor.id
                        AND membership.status='active'
                   )
                 )
            )`,
        [actorUserId, projectId, runId],
      );
      const row = selected.rows[0];
      return row ? projectCancellationProjection(projectId, cancellationRecord(row)) : null;
    });
  }

  getConversationExecution(
    actorUserId: string,
    projectId: string,
    conversationId: string,
  ): Promise<ConversationExecutionProjectionT> {
    return this.transactions.transaction(async (sql) => {
      const access = await sql.query<{ is_owner: boolean }>(
        `SELECT project.owner_user_id=actor.id AS is_owner
           FROM users actor
           JOIN projects project
             ON project.id=$2
            AND project.status='active'
           JOIN work_conversations conversation
             ON conversation.id=$3
            AND conversation.project_id=project.id
          WHERE actor.id=$1
            AND actor.status='active'
            AND (
              project.owner_user_id=actor.id
              OR EXISTS (
                SELECT 1
                  FROM project_members membership
                 WHERE membership.project_id=project.id
                   AND membership.user_id=actor.id
                   AND membership.status='active'
              )
            )`,
        [actorUserId, projectId, conversationId],
      );
      const conversation = access.rows[0];
      if (!conversation) throw new ProjectRunCancellationError("conversation_not_found");

      const linked = await sql.query<ConversationLinkedRunRow>(
        `SELECT
           run.id AS run_id,
           run.state AS run_state,
           run.repository_binding_id AS binding_id
         FROM conversation_task_package_bindings package_binding
         JOIN conversation_task_package_runs package_run
           ON package_run.package_id=package_binding.package_id
          AND package_run.project_id=package_binding.project_id
          AND package_run.task_id=package_binding.task_id
         JOIN agent_runs run
           ON run.id=package_run.run_id
          AND run.project_id=package_binding.project_id
          AND run.task_id=package_binding.task_id
        WHERE package_binding.project_id=$1
          AND package_binding.conversation_id=$2
        ORDER BY run.created_at DESC,run.id DESC
        LIMIT 1`,
        [projectId, conversationId],
      );
      const run = linked.rows[0];
      if (!run) {
        const idleTarget = await this.selectedProjectTarget(sql, projectId);
        return ConversationExecutionProjection.parse({
          project_id: projectId,
          conversation_id: conversationId,
          presentation: "idle",
          target: idleTarget,
          run: null,
        });
      }

      const target = await this.bindingTarget(sql, run.binding_id, run.run_id);
      if (!target) {
        throw new ProjectRunCancellationError("conversation_execution_unavailable");
      }
      const cancellation = await selectedCancellation(sql, run.run_id);
      const live = new Set<V2AgentRunStateT>([
        "created",
        "dispatched",
        "running",
        "waiting_for_human",
        "verifying",
      ]).has(run.run_state);
      return ConversationExecutionProjection.parse({
        project_id: projectId,
        conversation_id: conversationId,
        presentation: live ? "active" : "historical",
        target: {
          execution_target_id: target.execution_target_id,
          name: target.name,
        },
        run: {
          run_id: run.run_id,
          state: run.run_state,
          can_stop: conversation.is_owner && live && target.stoppable && cancellation === null,
          cancellation: cancellation
            ? projectCancellationProjection(projectId, cancellationRecord(cancellation))
            : null,
        },
      });
    });
  }

  markUnconfirmedOffline(input: {
    run_id: string;
    recorded_at: string;
  }): Promise<DeviceRunCancellationRecord> {
    return this.transactions.transaction(async (sql) => {
      const updated = await sql.query<DeviceRunCancellationRow>(
        `UPDATE device_run_cancellations
            SET state='unconfirmed_offline',
                unconfirmed_offline_at=$2,
                updated_at=$2
          WHERE run_id=$1
            AND state='cancellation_requested'
          RETURNING ${CANCELLATION_COLUMNS}`,
        [input.run_id, input.recorded_at],
      );
      if (updated.rows[0]) return cancellationRecord(updated.rows[0]);

      const existing = await selectedCancellation(sql, input.run_id);
      if (!existing) throw new DeviceRunCancellationError("cancellation_not_found");
      return cancellationRecord(existing);
    });
  }

  acknowledge(input: {
    run_id: string;
    device_id: string;
    credential_id: string;
    device_generation: number;
    acknowledged_at: string;
  }): Promise<DeviceRunCancellationRecord> {
    return this.recordDeviceEvidence(input, "runner_acknowledged");
  }

  confirmProcessExited(input: {
    run_id: string;
    device_id: string;
    credential_id: string;
    device_generation: number;
    acknowledged_at: string;
    process_exited_at: string;
    process_tree_reaped: true;
  }): Promise<DeviceRunCancellationRecord> {
    if (input.process_tree_reaped !== true) {
      throw new DeviceRunCancellationError("process_tree_not_reaped");
    }
    return this.recordDeviceEvidence(input, "process_exited");
  }

  get(runId: string): Promise<DeviceRunCancellationRecord | null> {
    return this.transactions.transaction(async (sql) => {
      const row = await selectedCancellation(sql, runId);
      return row ? cancellationRecord(row) : null;
    });
  }

  publicationAllowed(runId: string): Promise<boolean> {
    return this.transactions.transaction(async (sql) => {
      const result = await sql.query<{ allowed: boolean }>(
        `SELECT EXISTS (
           SELECT 1
             FROM agent_runs run
             JOIN projects project
               ON project.id=run.project_id
              AND project.status='active'
             JOIN users actor
               ON actor.id=run.initiated_by_user_id
              AND actor.status='active'
             JOIN repository_bindings binding
               ON binding.id=run.repository_binding_id
              AND binding.project_id=run.project_id
              AND binding.binding_type='local_runner'
              AND binding.status='connected'
             JOIN project_device_repository_grants grant_record
               ON grant_record.id=binding.project_device_repository_grant_id
              AND grant_record.project_id=binding.project_id
              AND grant_record.state='active'
             JOIN device_repository_registrations registration
               ON registration.id=grant_record.repository_registration_id
              AND registration.state='active'
              AND registration.workspace_id=binding.workspace_id
              AND registration.repository_id=binding.repository_id
             JOIN devices device
               ON device.id=registration.device_id
              AND device.lifecycle='active'
             JOIN users owner
               ON owner.id=device.owner_user_id
              AND owner.status='active'
             JOIN device_credentials credential
               ON credential.device_id=device.id
              AND credential.generation=device.current_generation
              AND credential.state='active'
             JOIN commands command
               ON command.command_id=(
                 SELECT latest.command_id
                   FROM commands latest
                  WHERE latest.run_id=run.id
                  ORDER BY latest.created_at DESC,latest.command_id DESC
                  LIMIT 1
               )
              AND command.runner_id=device.id
              AND command.runner_generation=device.current_generation
            WHERE run.id=$1
              AND (
                project.owner_user_id=actor.id
                OR EXISTS (
                  SELECT 1
                    FROM project_members membership
                   WHERE membership.project_id=project.id
                     AND membership.user_id=actor.id
                     AND membership.status='active'
                )
              )
              AND NOT EXISTS (
                SELECT 1
                  FROM device_run_cancellations cancellation
                 WHERE cancellation.run_id=run.id
                   AND cancellation.publication_fenced_at IS NOT NULL
                   AND cancellation.publication_reauthorized_at IS NULL
              )
         ) AS allowed`,
        [runId],
      );
      return result.rows[0]?.allowed ?? false;
    });
  }

  reauthorizePublication(input: {
    run_id: string;
    reauthorized_by_user_id: string;
    reauthorized_at: string;
  }): Promise<DeviceRunCancellationRecord> {
    return this.transactions.transaction(async (sql) => {
      const updated = await sql.query<DeviceRunCancellationRow>(
        `UPDATE device_run_cancellations
            SET publication_reauthorized_by_user_id=$2,
                publication_reauthorized_at=$3,
                updated_at=$3
          WHERE run_id=$1
            AND publication_fenced_at IS NOT NULL
            AND publication_reauthorized_at IS NULL
            AND EXISTS (
              SELECT 1
                FROM agent_runs run
                JOIN projects project
                  ON project.id=run.project_id
                 AND project.status='active'
                JOIN users actor
                  ON actor.id=$2
                 AND actor.status='active'
                JOIN repository_bindings binding
                  ON binding.id=run.repository_binding_id
                 AND binding.project_id=run.project_id
                 AND binding.binding_type='local_runner'
                 AND binding.status='connected'
                JOIN project_device_repository_grants grant_record
                  ON grant_record.id=binding.project_device_repository_grant_id
                 AND grant_record.project_id=binding.project_id
                 AND grant_record.state='active'
                JOIN device_repository_registrations registration
                  ON registration.id=grant_record.repository_registration_id
                 AND registration.state='active'
                 AND registration.workspace_id=binding.workspace_id
                 AND registration.repository_id=binding.repository_id
                JOIN devices device
                  ON device.id=registration.device_id
                 AND device.lifecycle='active'
                JOIN users owner
                  ON owner.id=device.owner_user_id
                 AND owner.status='active'
                JOIN device_credentials credential
                  ON credential.device_id=device.id
                 AND credential.generation=device.current_generation
                 AND credential.state='active'
                JOIN commands command
                  ON command.command_id=(
                    SELECT latest.command_id
                      FROM commands latest
                     WHERE latest.run_id=run.id
                     ORDER BY latest.created_at DESC,latest.command_id DESC
                     LIMIT 1
                  )
                 AND command.runner_id=device.id
                 AND command.runner_generation=device.current_generation
               WHERE run.id=device_run_cancellations.run_id
                 AND (
                   project.owner_user_id=actor.id
                   OR EXISTS (
                     SELECT 1
                       FROM project_members membership
                      WHERE membership.project_id=project.id
                        AND membership.user_id=actor.id
                        AND membership.status='active'
                   )
                 )
            )
          RETURNING ${CANCELLATION_COLUMNS}`,
        [input.run_id, input.reauthorized_by_user_id, input.reauthorized_at],
      );
      if (updated.rows[0]) return cancellationRecord(updated.rows[0]);

      const existing = await selectedCancellation(sql, input.run_id);
      if (!existing) throw new DeviceRunCancellationError("cancellation_not_found");
      if (existing.publication_fenced_at === null) {
        throw new DeviceRunCancellationError("publication_not_fenced");
      }
      if (existing.publication_reauthorized_at === null) {
        throw new DeviceRunCancellationError("publication_reauthorization_not_authorized");
      }
      throw new DeviceRunCancellationError("publication_already_reauthorized");
    });
  }

  private async selectedProjectTarget(
    sql: V2SqlExecutor,
    projectId: string,
  ): Promise<{ execution_target_id: string; name: string } | null> {
    const selected = await sql.query<{ execution_target_id: string; name: string }>(
      `SELECT grant_record.id AS execution_target_id,device.display_name AS name
         FROM projects project
         JOIN repository_bindings binding
           ON binding.id=project.primary_repository_binding_id
          AND binding.project_id=project.id
          AND binding.binding_type='local_runner'
          AND binding.status IN ('connected','degraded','disconnected')
         JOIN project_device_repository_grants grant_record
           ON grant_record.id=binding.project_device_repository_grant_id
          AND grant_record.project_id=project.id
          AND grant_record.state='active'
         JOIN device_repository_registrations registration
           ON registration.id=grant_record.repository_registration_id
          AND registration.state='active'
          AND registration.workspace_id=binding.workspace_id
          AND registration.repository_id=binding.repository_id
         JOIN devices device
           ON device.id=registration.device_id
          AND device.lifecycle='active'
         JOIN users owner
           ON owner.id=device.owner_user_id
          AND owner.status='active'
         JOIN device_credentials credential
           ON credential.device_id=device.id
          AND credential.id=registration.approved_credential_id
          AND credential.generation=registration.approved_generation
          AND credential.generation=device.current_generation
          AND credential.state='active'
        WHERE project.id=$1`,
      [projectId],
    );
    return selected.rows[0] ?? null;
  }

  private async bindingTarget(
    sql: V2SqlExecutor,
    bindingId: string,
    runId: string,
  ): Promise<ConversationTargetRow | null> {
    const selected = await sql.query<ConversationTargetRow>(
      `SELECT
         grant_record.id AS execution_target_id,
         device.display_name AS name,
         (
           binding.status IN ('connected','degraded','disconnected')
           AND grant_record.state='active'
           AND registration.state='active'
           AND device.lifecycle='active'
           AND owner.status='active'
           AND credential.id IS NOT NULL
           AND EXISTS (
             SELECT 1
               FROM commands command
              WHERE command.command_id=(
                SELECT latest.command_id
                  FROM commands latest
                 WHERE latest.run_id=$2
                 ORDER BY latest.created_at DESC,latest.command_id DESC
                 LIMIT 1
              )
                AND command.runner_id=device.id
                AND command.runner_generation=device.current_generation
           )
         ) AS stoppable
       FROM repository_bindings binding
       JOIN project_device_repository_grants grant_record
         ON grant_record.id=binding.project_device_repository_grant_id
        AND grant_record.project_id=binding.project_id
       JOIN device_repository_registrations registration
         ON registration.id=grant_record.repository_registration_id
        AND registration.workspace_id=binding.workspace_id
        AND registration.repository_id=binding.repository_id
       JOIN devices device
         ON device.id=registration.device_id
       LEFT JOIN users owner
         ON owner.id=device.owner_user_id
       LEFT JOIN device_credentials credential
         ON credential.device_id=device.id
        AND credential.id=registration.approved_credential_id
        AND credential.generation=registration.approved_generation
        AND credential.generation=device.current_generation
        AND credential.state='active'
      WHERE binding.id=$1`,
      [bindingId, runId],
    );
    return selected.rows[0] ?? null;
  }

  private recordDeviceEvidence(
    input: {
      run_id: string;
      device_id: string;
      credential_id: string;
      device_generation: number;
      acknowledged_at: string;
      process_exited_at?: string;
    },
    state: "runner_acknowledged" | "process_exited",
  ): Promise<DeviceRunCancellationRecord> {
    return this.transactions.transaction(async (sql) => {
      const updated = await sql.query<DeviceRunCancellationRow>(
        `UPDATE device_run_cancellations
            SET state=$5,
                runner_acknowledged_at=COALESCE(runner_acknowledged_at,$6),
                process_exited_at=CASE
                  WHEN $5='process_exited' THEN COALESCE(process_exited_at,$7)
                  ELSE process_exited_at
                END,
                updated_at=CASE
                  WHEN $5='process_exited' THEN $7::timestamptz
                  ELSE $6::timestamptz
                END
          WHERE run_id=$1
            AND device_id=$2
            AND credential_id=$3
            AND device_generation=$4
            AND (
              state IN ('cancellation_requested','unconfirmed_offline')
              OR (state='runner_acknowledged' AND $5='process_exited')
            )
          RETURNING ${CANCELLATION_COLUMNS}`,
        [
          input.run_id,
          input.device_id,
          input.credential_id,
          input.device_generation,
          state,
          input.acknowledged_at,
          input.process_exited_at ?? input.acknowledged_at,
        ],
      );
      let evidence: DeviceRunCancellationRow | null = updated.rows[0] ?? null;
      if (!evidence) {
        evidence = await selectedCancellation(sql, input.run_id);
        if (!evidence) throw new DeviceRunCancellationError("cancellation_not_found");
        if (
          evidence.device_id !== input.device_id ||
          evidence.credential_id !== input.credential_id ||
          Number(evidence.device_generation) !== input.device_generation
        ) {
          throw new DeviceRunCancellationError("device_evidence_mismatch");
        }
      }

      // A run that never reached `running` never emitted run_status started,
      // so no managed process tree can exist for it; the runner's
      // acknowledgement is the strongest evidence it will ever be able to
      // send. Requiring process_exited for those runs deadlocked them forever
      // when the runner (correctly) refused to fabricate exit proof for a run
      // it was not executing.
      const finalizableStates =
        state === "process_exited"
          ? ["created", "dispatched", "running", "waiting_for_human", "verifying"]
          : ["created", "dispatched"];
      {
        const lifecycle = new SqlV2ApplicationTransaction(sql);
        const run = await lifecycle.lockAgentRunLifecycle(input.run_id);
        if (run && finalizableStates.includes(run.state)) {
          await transitionV2AgentRunLifecycle(lifecycle, {
            project_id: run.project_id,
            phase_id: run.phase_id,
            task_id: run.task_id,
            run_id: input.run_id,
            expected_aggregate_version: run.aggregate_version,
            to: "cancelled",
            reason:
              state === "process_exited"
                ? "authenticated runner evidence confirmed the managed process tree exited"
                : "the runner acknowledged the cancellation before the run ever started, so no managed process existed",
            actor_type: "runner",
            actor_id: input.device_id,
            correlation_id:
              state === "process_exited"
                ? `device-process-exit:${input.run_id}:${input.device_generation}`
                : `device-cancel-ack:${input.run_id}:${input.device_generation}`,
            causation_id: input.run_id,
            occurred_at: input.process_exited_at ?? input.acknowledged_at,
          });
        }
      }
      return cancellationRecord(evidence);
    });
  }
}
