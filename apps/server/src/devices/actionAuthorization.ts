import type { V2SqlExecutor } from "../persistence/v2/database.js";

export type RunnerAuthorizationSubject = "device" | "legacy_runner";

interface DeviceRow {
  lifecycle: string;
  current_generation: number | string;
  owner_active: boolean;
}

interface AllowedRow {
  allowed: boolean;
}

interface DurableBindingAuthorizationShape {
  binding_type: string;
  binding_runner_id: string | null;
  project_device_repository_grant_id: string | null;
  registered_device_id: string | null;
}

export type RunnerAuthorizationIdentity =
  | {
      subject: "device";
      runner_id: string;
      generation: number;
      credential_id: string;
    }
  | {
      subject: "legacy_runner";
      runner_id: string;
      generation: number;
    };

export class DeviceActionAuthorizationError extends Error {
  constructor(
    readonly code:
      | "device_inactive"
      | "device_generation_fenced"
      | "device_credential_inactive"
      | "device_binding_unauthorized"
      | "device_run_unauthorized",
  ) {
    super(code);
    this.name = "DeviceActionAuthorizationError";
  }
}

/**
 * Transaction-local authorization for background paths. The initial device
 * row lock is shared with revocation, so a dispatch, event, upload, or
 * credential issuance either commits before the generation fence or observes
 * it and fails. A binding's durable grant shape decides whether device
 * authorization is mandatory; caller-selected subject fields cannot downgrade a
 * grant-backed binding to legacy compatibility.
 */
export class PostgresDeviceActionAuthorization {
  private async bindingAuthorizationShape(
    sql: V2SqlExecutor,
    input: {
      project_id?: string;
      repository_binding_id?: string;
      run_id?: string;
    },
  ): Promise<DurableBindingAuthorizationShape | null> {
    const result =
      input.run_id !== undefined
        ? await sql.query<DurableBindingAuthorizationShape>(
            `SELECT
               binding.binding_type,
               binding.runner_id AS binding_runner_id,
               binding.project_device_repository_grant_id,
               (
                 SELECT registration.device_id
                   FROM project_device_repository_grants grant_record
                   JOIN device_repository_registrations registration
                     ON registration.id=grant_record.repository_registration_id
                  WHERE grant_record.id=binding.project_device_repository_grant_id
                    AND grant_record.project_id=binding.project_id
               ) AS registered_device_id
               FROM agent_runs run
               JOIN repository_bindings binding
                 ON binding.id=run.repository_binding_id
                AND binding.project_id=run.project_id
              WHERE run.id=$1
                AND ($2::text IS NULL OR run.project_id=$2)
                AND ($3::text IS NULL OR binding.id=$3)`,
            [input.run_id, input.project_id ?? null, input.repository_binding_id ?? null],
          )
        : await sql.query<DurableBindingAuthorizationShape>(
            `SELECT
               binding.binding_type,
               binding.runner_id AS binding_runner_id,
               binding.project_device_repository_grant_id,
               (
                 SELECT registration.device_id
                   FROM project_device_repository_grants grant_record
                   JOIN device_repository_registrations registration
                     ON registration.id=grant_record.repository_registration_id
                  WHERE grant_record.id=binding.project_device_repository_grant_id
                    AND grant_record.project_id=binding.project_id
               ) AS registered_device_id
              FROM repository_bindings binding
              WHERE binding.id=$1
                AND binding.project_id=$2`,
            [input.repository_binding_id, input.project_id],
          );
    return result.rows[0] ?? null;
  }

  private authorizationSubjectForBinding(
    shape: DurableBindingAuthorizationShape | null,
    identity: RunnerAuthorizationIdentity,
    deniedCode: "device_binding_unauthorized" | "device_run_unauthorized",
  ): RunnerAuthorizationSubject {
    if (!shape) throw new DeviceActionAuthorizationError(deniedCode);
    if (shape.project_device_repository_grant_id !== null) {
      if (
        shape.binding_type !== "local_runner" ||
        shape.registered_device_id === null ||
        identity.subject !== "device" ||
        identity.runner_id !== shape.registered_device_id
      ) {
        throw new DeviceActionAuthorizationError(deniedCode);
      }
      return "device";
    }
    if (
      identity.subject !== "legacy_runner" ||
      (shape.binding_type === "local_runner" && shape.binding_runner_id !== identity.runner_id)
    ) {
      throw new DeviceActionAuthorizationError(deniedCode);
    }
    return "legacy_runner";
  }

  /**
   * Resolves a server-selected dispatch target. Unlike authenticated HTTP this
   * is not allowed to trust caller-supplied identity fields: a durable device
   * row selects the exact active credential, while absence of any device row
   * is the only legacy compatibility case.
   */
  async resolveDispatchTargetIdentity(
    sql: V2SqlExecutor,
    input: { runner_id: string; generation: number },
  ): Promise<RunnerAuthorizationIdentity> {
    const selected = await sql.query<{
      lifecycle: string;
      current_generation: number | string;
      owner_active: boolean;
      credential_id: string | null;
    }>(
      `SELECT
         device.lifecycle,
         device.current_generation,
         EXISTS (
           SELECT 1
             FROM users owner
            WHERE owner.id=device.owner_user_id
              AND owner.status='active'
         ) AS owner_active,
         (
           SELECT credential.id
             FROM device_credentials credential
            WHERE credential.device_id=device.id
              AND credential.generation=$2
              AND credential.state='active'
         ) AS credential_id
       FROM devices device
       WHERE device.id=$1
       FOR UPDATE OF device`,
      [input.runner_id, input.generation],
    );
    const device = selected.rows[0];
    if (!device) {
      return {
        subject: "legacy_runner",
        runner_id: input.runner_id,
        generation: input.generation,
      };
    }
    if (device.lifecycle !== "active" || !device.owner_active) {
      throw new DeviceActionAuthorizationError("device_inactive");
    }
    if (Number(device.current_generation) !== input.generation) {
      throw new DeviceActionAuthorizationError("device_generation_fenced");
    }
    if (!device.credential_id) {
      throw new DeviceActionAuthorizationError("device_credential_inactive");
    }
    return {
      subject: "device",
      runner_id: input.runner_id,
      generation: input.generation,
      credential_id: device.credential_id,
    };
  }

  async lockTransportIdentity(
    sql: V2SqlExecutor,
    input: RunnerAuthorizationIdentity,
  ): Promise<RunnerAuthorizationSubject> {
    if (input.subject === "legacy_runner") return "legacy_runner";
    const selected = await sql.query<DeviceRow>(
      `SELECT
         device.lifecycle,
         device.current_generation,
         EXISTS (
           SELECT 1
             FROM users owner
            WHERE owner.id=device.owner_user_id
              AND owner.status='active'
         ) AS owner_active
         FROM devices device
        WHERE device.id=$1
        FOR UPDATE OF device`,
      [input.runner_id],
    );
    const device = selected.rows[0];
    if (!device || device.lifecycle !== "active" || !device.owner_active) {
      throw new DeviceActionAuthorizationError("device_inactive");
    }
    if (Number(device.current_generation) !== input.generation) {
      throw new DeviceActionAuthorizationError("device_generation_fenced");
    }
    const credential = await sql.query<{ id: string }>(
      `SELECT credential.id
         FROM device_credentials credential
        WHERE credential.device_id=$1
          AND credential.id=$2
          AND credential.generation=$3
          AND credential.state='active'
        FOR UPDATE OF credential`,
      [input.runner_id, input.credential_id, input.generation],
    );
    if (!credential.rows[0]) {
      throw new DeviceActionAuthorizationError("device_credential_inactive");
    }
    return "device";
  }

  async assertDispatchBinding(
    sql: V2SqlExecutor,
    input: {
      actor_user_id: string;
      project_id: string;
      repository_binding_id: string;
    } & RunnerAuthorizationIdentity,
  ): Promise<RunnerAuthorizationSubject> {
    const shape = await this.bindingAuthorizationShape(sql, {
      project_id: input.project_id,
      repository_binding_id: input.repository_binding_id,
    });
    const subject = this.authorizationSubjectForBinding(
      shape,
      input,
      "device_binding_unauthorized",
    );
    if (subject === "legacy_runner") {
      const legacy = await sql.query<AllowedRow>(
        `SELECT true AS allowed
           FROM users actor
           JOIN projects project
             ON project.id=$2
            AND project.status='active'
           JOIN repository_bindings binding
            ON binding.id=$3
            AND binding.project_id=project.id
            AND binding.project_device_repository_grant_id IS NULL
            AND binding.status='connected'
            AND (
              binding.binding_type<>'local_runner'
              OR binding.runner_id=$4
            )
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
          LIMIT 1
          FOR UPDATE OF actor,project,binding`,
        [input.actor_user_id, input.project_id, input.repository_binding_id, input.runner_id],
      );
      if (legacy.rows[0]?.allowed !== true) {
        throw new DeviceActionAuthorizationError("device_binding_unauthorized");
      }
      return subject;
    }
    await this.lockTransportIdentity(sql, input);
    const result = await sql.query<AllowedRow>(
      `SELECT true AS allowed
         FROM users actor
         JOIN projects project
           ON project.id=$2
          AND project.status='active'
         JOIN repository_bindings binding
           ON binding.id=$3
          AND binding.project_id=project.id
          AND binding.binding_type='local_runner'
          AND binding.status='connected'
         JOIN project_device_repository_grants grant_record
           ON grant_record.id=binding.project_device_repository_grant_id
          AND grant_record.project_id=project.id
          AND grant_record.state='active'
         JOIN device_repository_registrations registration
           ON registration.id=grant_record.repository_registration_id
          AND registration.device_id=$4
          AND registration.state='active'
          AND registration.workspace_id=binding.workspace_id
          AND registration.repository_id=binding.repository_id
         JOIN devices device
           ON device.id=registration.device_id
          AND device.lifecycle='active'
          AND device.current_generation=$5
         JOIN device_credentials credential
           ON credential.device_id=device.id
          AND credential.generation=device.current_generation
          AND credential.state='active'
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
        LIMIT 1
        FOR UPDATE OF actor,project,binding,grant_record,registration,device,credential`,
      [
        input.actor_user_id,
        input.project_id,
        input.repository_binding_id,
        input.runner_id,
        input.generation,
      ],
    );
    if (result.rows[0]?.allowed !== true) {
      throw new DeviceActionAuthorizationError("device_binding_unauthorized");
    }
    return subject;
  }

  async assertRun(
    sql: V2SqlExecutor,
    input: {
      run_id: string;
      project_id?: string;
      repository_binding_id?: string;
    } & RunnerAuthorizationIdentity,
  ): Promise<RunnerAuthorizationSubject> {
    const shape = await this.bindingAuthorizationShape(sql, {
      run_id: input.run_id,
      ...(input.project_id !== undefined ? { project_id: input.project_id } : {}),
      ...(input.repository_binding_id !== undefined
        ? { repository_binding_id: input.repository_binding_id }
        : {}),
    });
    const subject = this.authorizationSubjectForBinding(shape, input, "device_run_unauthorized");
    if (subject === "legacy_runner") {
      const legacy = await sql.query<AllowedRow>(
        `SELECT true AS allowed
           FROM agent_runs run
           JOIN projects project
             ON project.id=run.project_id
            AND project.status='active'
           JOIN repository_bindings binding
             ON binding.id=run.repository_binding_id
            AND binding.project_id=project.id
            AND binding.project_device_repository_grant_id IS NULL
            AND binding.status IN ('connected','degraded','disconnected')
            AND (
              binding.binding_type<>'local_runner'
              OR binding.runner_id=$2
            )
           JOIN commands command
             ON command.command_id=(
               SELECT latest.command_id
                 FROM commands latest
                WHERE latest.run_id=run.id
                ORDER BY latest.created_at DESC,latest.command_id DESC
                LIMIT 1
             )
            AND command.runner_id=$2
            AND command.runner_generation=$3
          WHERE run.id=$1
            AND ($4::text IS NULL OR project.id=$4)
            AND ($5::text IS NULL OR binding.id=$5)
            AND NOT EXISTS (
              SELECT 1
                FROM runner_revocations revocation
               WHERE revocation.runner_id=$2
                 AND revocation.revoked_through_generation >= $3
            )
          LIMIT 1
          FOR UPDATE OF run,project,binding,command`,
        [
          input.run_id,
          input.runner_id,
          input.generation,
          input.project_id ?? null,
          input.repository_binding_id ?? null,
        ],
      );
      if (legacy.rows[0]?.allowed !== true) {
        throw new DeviceActionAuthorizationError("device_run_unauthorized");
      }
      return subject;
    }
    await this.lockTransportIdentity(sql, input);
    const result = await sql.query<AllowedRow>(
      `SELECT true AS allowed
         FROM agent_runs run
         JOIN projects project
           ON project.id=run.project_id
          AND project.status='active'
         JOIN repository_bindings binding
           ON binding.id=run.repository_binding_id
          AND binding.project_id=project.id
          AND binding.binding_type='local_runner'
          AND binding.status IN ('connected','degraded','disconnected')
         JOIN project_device_repository_grants grant_record
           ON grant_record.id=binding.project_device_repository_grant_id
          AND grant_record.project_id=project.id
          AND grant_record.state='active'
         JOIN device_repository_registrations registration
           ON registration.id=grant_record.repository_registration_id
          AND registration.device_id=$2
          AND registration.state='active'
          AND registration.workspace_id=binding.workspace_id
          AND registration.repository_id=binding.repository_id
         JOIN devices device
           ON device.id=registration.device_id
          AND device.lifecycle='active'
          AND device.current_generation=$3
         JOIN users owner
           ON owner.id=device.owner_user_id
          AND owner.status='active'
         JOIN users actor
           ON actor.id=run.initiated_by_user_id
          AND actor.status='active'
         JOIN device_credentials credential
           ON credential.device_id=device.id
          AND credential.id=$6
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
          AND ($4::text IS NULL OR project.id=$4)
          AND ($5::text IS NULL OR binding.id=$5)
          AND NOT EXISTS (
            SELECT 1
              FROM device_run_cancellations cancellation
             WHERE cancellation.run_id=run.id
               AND cancellation.device_id=device.id
          )
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
        LIMIT 1
        FOR UPDATE OF run,project,binding,grant_record,registration,
                      device,owner,actor,credential,command`,
      [
        input.run_id,
        input.runner_id,
        input.generation,
        input.project_id ?? null,
        input.repository_binding_id ?? null,
        input.subject === "device" ? input.credential_id : null,
      ],
    );
    if (result.rows[0]?.allowed !== true) {
      throw new DeviceActionAuthorizationError("device_run_unauthorized");
    }
    return subject;
  }
}
