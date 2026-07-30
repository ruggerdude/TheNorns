import type { CancellationConfirmationStateT } from "@norns/contracts";

import type { V2SqlExecutor, V2TransactionRunner } from "../persistence/v2/database.js";

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
  afterRequested?: (outcome: DeviceRunCancellationRequestOutcome) => void | Promise<void>;
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

const CANCELLATION_COLUMNS = `
  run_id,device_id,credential_id,device_generation,cause,state,
  requested_by_user_id,reason,requested_at,runner_acknowledged_at,
  process_exited_at,unconfirmed_offline_at,publication_fenced_at,
  publication_reauthorized_by_user_id,publication_reauthorized_at`;

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
      await this.options.afterRequested?.(outcome);
    } catch {
      // The request or authorized replay is already committed. Online stop
      // delivery is best-effort and cannot rewrite that durable result.
    }
    return outcome;
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
      if (updated.rows[0]) return cancellationRecord(updated.rows[0]);

      const existing = await selectedCancellation(sql, input.run_id);
      if (!existing) throw new DeviceRunCancellationError("cancellation_not_found");
      if (
        existing.device_id !== input.device_id ||
        existing.credential_id !== input.credential_id ||
        Number(existing.device_generation) !== input.device_generation
      ) {
        throw new DeviceRunCancellationError("device_evidence_mismatch");
      }
      return cancellationRecord(existing);
    });
  }
}
