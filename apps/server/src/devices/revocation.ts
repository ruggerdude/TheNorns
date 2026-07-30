import type { V2TransactionRunner } from "../persistence/v2/database.js";

export interface DeviceRevocationRecord {
  device_id: string;
  revoked_by_user_id: string;
  previous_generation: number;
  fenced_generation: number;
  reason: string;
  revoked_at: string;
  affected_run_ids: string[];
}

export interface DeviceRevocationOutcome {
  record: DeviceRevocationRecord;
  replayed: boolean;
}

export interface DeviceRevocationServiceOptions {
  /**
   * Best-effort transport cleanup after the revocation transaction commits.
   * Hook failures cannot undo or change the committed authorization fence.
   */
  afterRevoked?: (outcome: DeviceRevocationOutcome) => void | Promise<void>;
}

interface DeviceRow {
  device_id: string;
  owner_user_id: string | null;
  lifecycle: "active" | "revoked";
  current_generation: number | string;
  actor_status: string;
}

interface RevocationRow {
  device_id: string;
  revoked_by_user_id: string;
  previous_generation: number | string;
  fenced_generation: number | string;
  reason: string;
  revoked_at: string | Date;
}

interface ActiveRunRow {
  run_id: string;
  credential_id: string;
  runner_generation: number | string;
}

function timestamp(value: string | Date): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function revocationRecord(row: RevocationRow, affectedRunIds: string[]): DeviceRevocationRecord {
  return {
    device_id: row.device_id,
    revoked_by_user_id: row.revoked_by_user_id,
    previous_generation: Number(row.previous_generation),
    fenced_generation: Number(row.fenced_generation),
    reason: row.reason,
    revoked_at: timestamp(row.revoked_at),
    affected_run_ids: affectedRunIds,
  };
}

export class DeviceRevocationError extends Error {
  constructor(
    readonly code:
      | "revocation_not_authorized"
      | "device_not_found"
      | "active_credential_missing"
      | "revocation_record_missing"
      | "cancellation_scope_conflict",
  ) {
    super(
      code === "revocation_not_authorized"
        ? "Only the active device owner may revoke this device."
        : code === "device_not_found"
          ? "The device does not exist."
          : code === "active_credential_missing"
            ? "The active device credential is unavailable."
            : code === "revocation_record_missing"
              ? "The revoked device is missing its durable revocation record."
              : "An active run is already associated with a different device cancellation scope.",
    );
    this.name = "DeviceRevocationError";
  }
}

/**
 * Atomically withdraws every server-controlled authorization rooted at one
 * device. The returned run ids are the online-control requests the host should
 * attempt after commit; absence of an acknowledgement is not treated as local
 * process exit.
 */
export class DeviceRevocationService {
  constructor(
    private readonly transactions: V2TransactionRunner,
    private readonly options: DeviceRevocationServiceOptions = {},
  ) {}

  async revoke(input: {
    device_id: string;
    revoked_by_user_id: string;
    reason: string;
    revoked_at: string;
  }): Promise<DeviceRevocationOutcome> {
    const outcome = await this.transactions.transaction(async (sql) => {
      const selected = await sql.query<DeviceRow>(
        `SELECT
           device.id AS device_id,
           device.owner_user_id,
           device.lifecycle,
           device.current_generation,
           actor.status AS actor_status
         FROM devices device
         JOIN users actor ON actor.id=$2
        WHERE device.id=$1
        FOR UPDATE OF device`,
        [input.device_id, input.revoked_by_user_id],
      );
      const device = selected.rows[0];
      if (!device) throw new DeviceRevocationError("device_not_found");
      if (device.actor_status !== "active" || device.owner_user_id !== input.revoked_by_user_id) {
        throw new DeviceRevocationError("revocation_not_authorized");
      }

      if (device.lifecycle === "revoked") {
        const prior = await sql.query<RevocationRow>(
          `SELECT
             device_id,revoked_by_user_id,previous_generation,
             fenced_generation,reason,revoked_at
           FROM device_revocations
          WHERE device_id=$1`,
          [input.device_id],
        );
        if (!prior.rows[0]) {
          throw new DeviceRevocationError("revocation_record_missing");
        }
        const affected = await sql.query<{ run_id: string }>(
          `SELECT run_id
             FROM device_run_cancellations
            WHERE device_id=$1 AND publication_fenced_at IS NOT NULL
            ORDER BY run_id`,
          [input.device_id],
        );
        return {
          record: revocationRecord(
            prior.rows[0],
            affected.rows.map((row) => row.run_id),
          ),
          replayed: true,
        };
      }

      const previousGeneration = Number(device.current_generation);
      const credential = await sql.query<{
        credential_id: string;
        generation: number | string;
      }>(
        `SELECT id AS credential_id,generation
           FROM device_credentials
          WHERE device_id=$1
            AND generation=$2
            AND state='active'
          FOR UPDATE`,
        [input.device_id, previousGeneration],
      );
      const activeCredential = credential.rows[0];
      if (!activeCredential) {
        throw new DeviceRevocationError("active_credential_missing");
      }
      const fencedGeneration = previousGeneration + 1;

      const activeRuns = await sql.query<ActiveRunRow>(
        `SELECT DISTINCT
           run.id AS run_id,
           credential.id AS credential_id,
           command.runner_generation
         FROM agent_runs run
         JOIN commands command
           ON command.command_id=(
             SELECT latest.command_id
               FROM commands latest
              WHERE latest.run_id=run.id
              ORDER BY latest.created_at DESC,latest.command_id DESC
              LIMIT 1
           )
          AND command.runner_id=$1
          AND command.runner_generation=$2
         JOIN device_credentials credential
           ON credential.device_id=$1
          AND credential.generation=command.runner_generation
        WHERE run.state IN ('created','dispatched','running','waiting_for_human','verifying')
        ORDER BY run.id`,
        [input.device_id, previousGeneration],
      );

      const inserted = await sql.query<RevocationRow>(
        `INSERT INTO device_revocations (
           device_id,revoked_by_user_id,previous_generation,
           fenced_generation,reason,revoked_at
         ) VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING
           device_id,revoked_by_user_id,previous_generation,
           fenced_generation,reason,revoked_at`,
        [
          input.device_id,
          input.revoked_by_user_id,
          previousGeneration,
          fencedGeneration,
          input.reason,
          input.revoked_at,
        ],
      );

      for (const run of activeRuns.rows) {
        const fenced = await sql.query<{ run_id: string }>(
          `INSERT INTO device_run_cancellations (
             run_id,device_id,credential_id,device_generation,cause,state,
             requested_by_user_id,reason,requested_at,
             publication_fenced_at,updated_at
           ) VALUES (
             $1,$2,$3,$4,'device_revocation','cancellation_requested',
             $5,$6,$7,$7,$7
           )
           ON CONFLICT (run_id) DO UPDATE
             SET publication_fenced_at=COALESCE(
                   device_run_cancellations.publication_fenced_at,
                   EXCLUDED.publication_fenced_at
                 ),
                 updated_at=EXCLUDED.updated_at
           WHERE device_run_cancellations.device_id=EXCLUDED.device_id
             AND device_run_cancellations.credential_id=EXCLUDED.credential_id
             AND device_run_cancellations.device_generation=EXCLUDED.device_generation
           RETURNING run_id`,
          [
            run.run_id,
            input.device_id,
            run.credential_id,
            Number(run.runner_generation),
            input.revoked_by_user_id,
            input.reason,
            input.revoked_at,
          ],
        );
        if (fenced.rows[0]?.run_id !== run.run_id) {
          throw new DeviceRevocationError("cancellation_scope_conflict");
        }
      }

      await sql.query(
        `UPDATE project_device_repository_grants grant_record
            SET state='revoked',
                revoked_by_user_id=$2,
                revoked_at=$3,
                updated_at=$3
          WHERE grant_record.state='active'
            AND EXISTS (
              SELECT 1
                FROM device_repository_registrations registration
               WHERE registration.id=grant_record.repository_registration_id
                 AND registration.device_id=$1
            )`,
        [input.device_id, input.revoked_by_user_id, input.revoked_at],
      );
      await sql.query(
        `UPDATE repository_bindings binding
            SET status='revoked',updated_at=$2
          WHERE binding.status<>'revoked'
            AND EXISTS (
              SELECT 1
                FROM project_device_repository_grants grant_record
                JOIN device_repository_registrations registration
                  ON registration.id=grant_record.repository_registration_id
               WHERE grant_record.id=binding.project_device_repository_grant_id
                 AND registration.device_id=$1
            )`,
        [input.device_id, input.revoked_at],
      );
      await sql.query(
        `UPDATE device_repository_registrations
            SET state='revoked',revoked_at=$2,updated_at=$2
          WHERE device_id=$1 AND state IN ('pending','active')`,
        [input.device_id, input.revoked_at],
      );
      await sql.query(
        `UPDATE gateway_credentials
            SET revoked_at=COALESCE(revoked_at,$2)
          WHERE authentication_subject='device'
            AND runner_id=$1
            AND revoked_at IS NULL`,
        [input.device_id, input.revoked_at],
      );
      await sql.query(
        `UPDATE commands
            SET status='cancelled',updated_at=$3
          WHERE runner_id=$1
            AND runner_generation <= $2
            AND status IN ('created','queued')`,
        [input.device_id, previousGeneration, input.revoked_at],
      );
      await sql.query(
        `UPDATE dispatch_jobs
            SET status='cancelled',completed_at=$2,updated_at=$2,
                lease_owner=NULL,lease_expires_at=NULL
          WHERE runner_id=$1 AND status IN ('queued','leased')`,
        [input.device_id, input.revoked_at],
      );
      await sql.query(
        `INSERT INTO runner_revocations (
           runner_id,revoked_through_generation,reason,revoked_by,revoked_at
         ) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (runner_id) DO UPDATE
           SET revoked_through_generation=GREATEST(
                 runner_revocations.revoked_through_generation,
                 EXCLUDED.revoked_through_generation
               ),
               reason=EXCLUDED.reason,
               revoked_by=EXCLUDED.revoked_by,
               revoked_at=EXCLUDED.revoked_at`,
        [
          input.device_id,
          fencedGeneration,
          input.reason,
          input.revoked_by_user_id,
          input.revoked_at,
        ],
      );
      await sql.query(
        `UPDATE device_credentials
            SET state='revoked',revoked_at=$2
          WHERE device_id=$1 AND state='active'`,
        [input.device_id, input.revoked_at],
      );
      await sql.query(
        `UPDATE devices
            SET lifecycle='revoked',
                current_generation=$2,
                revoked_at=$3,
                updated_at=$3
          WHERE id=$1 AND lifecycle='active'`,
        [input.device_id, fencedGeneration, input.revoked_at],
      );

      return {
        record: revocationRecord(
          inserted.rows[0] as RevocationRow,
          activeRuns.rows.map((run) => run.run_id),
        ),
        replayed: false,
      };
    });
    try {
      await this.options.afterRevoked?.(outcome);
    } catch {
      // Authorization withdrawal is already committed. Transport cleanup is
      // deliberately best-effort and must never rewrite that durable result.
    }
    return outcome;
  }
}
