import type {
  ActiveDeviceCredentialT,
  DeviceLifecycleStateT,
  DeviceOperatingSystemFamilyT,
} from "@norns/contracts";

import type { V2SqlExecutor, V2TransactionRunner } from "../persistence/v2/database.js";
import { PostgresDeviceAuthorizationPolicy } from "./policy.js";

export interface DeviceAgentObservationRecord {
  version: string;
  protocol_version: string;
  capabilities: string[];
}

export interface DeviceRepositoryGrantRecord {
  grant_id: string;
  project_id: string;
  repository_registration_id: string;
  state: "active" | "revoked";
}

export interface OwnedDeviceRecord {
  device_id: string;
  owner_user_id: string;
  name: string;
  location_label: string | null;
  os_family: DeviceOperatingSystemFamilyT;
  os_version: string | null;
  lifecycle: DeviceLifecycleStateT;
  last_seen_at: string | null;
  active_credential: ActiveDeviceCredentialT | null;
  agent: DeviceAgentObservationRecord | null;
  repository_grants: DeviceRepositoryGrantRecord[];
  active_run_count: number;
  queued_command_count: number;
}

export interface ProjectExecutionTargetRecord {
  project_id: string;
  execution_target_id: string;
  device_id: string;
  name: string;
  location_label: string | null;
  os_family: DeviceOperatingSystemFamilyT;
  lifecycle: DeviceLifecycleStateT;
  last_seen_at: string | null;
  agent_protocol_version: string | null;
  agent_capabilities: string[] | null;
  active_run_count: number;
}

interface DeviceRow {
  device_id: string;
  owner_user_id: string;
  display_name: string;
  location_label: string | null;
  os_family: DeviceOperatingSystemFamilyT;
  os_version: string | null;
  lifecycle: DeviceLifecycleStateT;
  last_seen_at: string | Date | null;
  agent_version: string | null;
  agent_protocol_version: string | null;
  agent_capabilities: unknown;
  credential_id: string | null;
  credential_generation: number | string | null;
  public_key_fingerprint: string | null;
  credential_activated_at: string | Date | null;
  active_run_count: number | string;
  queued_command_count: number | string;
}

interface GrantRow {
  grant_id: string;
  project_id: string;
  repository_registration_id: string;
  state: "active" | "revoked";
}

interface TargetRow {
  project_id: string;
  execution_target_id: string;
  device_id: string;
  display_name: string;
  location_label: string | null;
  os_family: DeviceOperatingSystemFamilyT;
  lifecycle: DeviceLifecycleStateT;
  last_seen_at: string | Date | null;
  agent_protocol_version: string | null;
  agent_capabilities: unknown;
  active_run_count: number | string;
}

function timestamp(value: string | Date | null): string | null {
  if (value === null) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function capabilities(value: unknown): string[] | null {
  let decoded = value;
  if (typeof decoded === "string") {
    try {
      decoded = JSON.parse(decoded);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(decoded) || !decoded.every((item) => typeof item === "string")) {
    return null;
  }
  return decoded;
}

function activeCredential(row: DeviceRow): ActiveDeviceCredentialT | null {
  if (
    row.credential_id === null ||
    row.credential_generation === null ||
    row.public_key_fingerprint === null ||
    row.credential_activated_at === null
  ) {
    return null;
  }
  return {
    device_id: row.device_id,
    credential_id: row.credential_id,
    generation: Number(row.credential_generation),
    public_key_fingerprint: row.public_key_fingerprint,
    state: "active",
    activated_at: timestamp(row.credential_activated_at) as string,
  };
}

function agentObservation(row: DeviceRow): DeviceAgentObservationRecord | null {
  const observedCapabilities = capabilities(row.agent_capabilities);
  if (
    row.agent_version === null ||
    row.agent_protocol_version === null ||
    observedCapabilities === null
  ) {
    return null;
  }
  return {
    version: row.agent_version,
    protocol_version: row.agent_protocol_version,
    capabilities: observedCapabilities,
  };
}

function deviceRecord(row: DeviceRow, grants: GrantRow[]): OwnedDeviceRecord {
  return {
    device_id: row.device_id,
    owner_user_id: row.owner_user_id,
    name: row.display_name,
    location_label: row.location_label,
    os_family: row.os_family,
    os_version: row.os_version,
    lifecycle: row.lifecycle,
    last_seen_at: timestamp(row.last_seen_at),
    active_credential: activeCredential(row),
    agent: agentObservation(row),
    repository_grants: grants.map((grant) => ({ ...grant })),
    active_run_count: Number(row.active_run_count),
    queued_command_count: Number(row.queued_command_count),
  };
}

const DEVICE_COLUMNS = `
  device.id AS device_id,
  device.owner_user_id,
  device.display_name,
  device.location_label,
  device.os_family,
  device.os_version,
  device.lifecycle,
  device.last_seen_at,
  device.agent_version,
  device.agent_protocol_version,
  device.agent_capabilities,
  credential.id AS credential_id,
  credential.generation AS credential_generation,
  credential.public_key_fingerprint,
  credential.activated_at AS credential_activated_at,
  (
    SELECT count(DISTINCT run.id)::int
      FROM agent_runs run
     WHERE run.state IN (
       'created','dispatched','running','waiting_for_human','verifying'
     )
       AND EXISTS (
         SELECT 1
           FROM commands command
          WHERE command.command_id = (
            SELECT latest.command_id
              FROM commands latest
             WHERE latest.run_id = run.id
             ORDER BY latest.created_at DESC, latest.command_id DESC
             LIMIT 1
            )
            AND command.runner_id = device.id
            AND command.runner_generation = device.current_generation
       )
  ) AS active_run_count,
  (
    SELECT count(*)::int
     FROM commands command
     WHERE command.runner_id = device.id
       AND command.runner_generation = device.current_generation
       AND command.status IN ('created','queued')
  ) AS queued_command_count`;

async function selectGrants(
  sql: V2SqlExecutor,
  deviceId: string,
  actorUserId: string,
): Promise<GrantRow[]> {
  const selected = await sql.query<GrantRow>(
    `SELECT
       grant_record.id AS grant_id,
       grant_record.project_id,
       grant_record.repository_registration_id,
       grant_record.state
     FROM project_device_repository_grants grant_record
     JOIN device_repository_registrations registration
       ON registration.id=grant_record.repository_registration_id
      AND registration.device_id=$1
     JOIN devices device
       ON device.id=registration.device_id
      AND device.owner_user_id=$2
     JOIN users actor
       ON actor.id=device.owner_user_id
      AND actor.status='active'
     ORDER BY grant_record.project_id,grant_record.id`,
    [deviceId, actorUserId],
  );
  return selected.rows;
}

/**
 * Owner and project projections over the additive device tables. Every
 * single-device action invokes the typed authorization policy inside the same
 * transaction as its read or write. Administrator role is never consulted.
 */
export class PostgresDeviceManagementRepository {
  constructor(private readonly transactions: V2TransactionRunner) {}

  listOwned(actorUserId: string): Promise<OwnedDeviceRecord[]> {
    return this.transactions.transaction(async (sql) => {
      const selected = await sql.query<DeviceRow>(
        `SELECT ${DEVICE_COLUMNS}
         FROM users actor
         JOIN devices device
           ON device.owner_user_id=actor.id
         LEFT JOIN device_credentials credential
           ON credential.device_id=device.id
          AND credential.state='active'
          AND credential.generation=device.current_generation
        WHERE actor.id=$1
          AND actor.status='active'
        ORDER BY lower(device.display_name),device.id`,
        [actorUserId],
      );
      const records: OwnedDeviceRecord[] = [];
      for (const row of selected.rows) {
        records.push(deviceRecord(row, await selectGrants(sql, row.device_id, actorUserId)));
      }
      return records;
    });
  }

  getOwned(actorUserId: string, deviceId: string): Promise<OwnedDeviceRecord | null> {
    return this.transactions.transaction(async (sql) => {
      const decision = await new PostgresDeviceAuthorizationPolicy(sql).canViewOwnedDevice({
        actor_user_id: actorUserId,
        device_id: deviceId,
      });
      if (!decision.allowed) return null;
      return this.selectOwned(sql, actorUserId, deviceId);
    });
  }

  canManage(actorUserId: string, deviceId: string): Promise<boolean> {
    return this.transactions.transaction(async (sql) => {
      const decision = await new PostgresDeviceAuthorizationPolicy(sql).canManageDevice({
        actor_user_id: actorUserId,
        device_id: deviceId,
      });
      return decision.allowed;
    });
  }

  renameOwned(input: {
    actor_user_id: string;
    device_id: string;
    name: string;
    location_label: string | null;
    updated_at: string;
  }): Promise<"updated" | "not_found" | "revoked"> {
    return this.transactions.transaction(async (sql) => {
      const decision = await new PostgresDeviceAuthorizationPolicy(sql).canManageDevice({
        actor_user_id: input.actor_user_id,
        device_id: input.device_id,
      });
      if (!decision.allowed) return "not_found";
      const selected = await sql.query<{ lifecycle: DeviceLifecycleStateT }>(
        `SELECT device.lifecycle
           FROM devices device
           JOIN users actor
             ON actor.id=device.owner_user_id
            AND actor.id=$2
            AND actor.status='active'
          WHERE device.id=$1
          FOR UPDATE OF device,actor`,
        [input.device_id, input.actor_user_id],
      );
      if (!selected.rows[0]) return "not_found";
      if (selected.rows[0].lifecycle === "revoked") return "revoked";
      const updated = await sql.query<{ id: string }>(
        `UPDATE devices
            SET display_name=$2,location_label=$3,updated_at=$4
          WHERE id=$1 AND lifecycle='active'
          RETURNING id`,
        [input.device_id, input.name, input.location_label, input.updated_at],
      );
      return updated.rows[0] ? "updated" : "revoked";
    });
  }

  projectTargets(
    actorUserId: string,
    projectId: string,
  ): Promise<ProjectExecutionTargetRecord[] | null> {
    return this.transactions.transaction(async (sql) => {
      const access = await sql.query<{ allowed: boolean }>(
        `SELECT EXISTS (
           SELECT 1
             FROM users actor
             JOIN projects project
               ON project.id=$2
              AND project.status='active'
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
         ) AS allowed`,
        [actorUserId, projectId],
      );
      if (access.rows[0]?.allowed !== true) return null;

      const selected = await sql.query<TargetRow>(
        `SELECT
           project.id AS project_id,
           binding.id AS execution_target_id,
           device.id AS device_id,
           device.display_name,
           device.location_label,
           device.os_family,
           device.lifecycle,
           device.last_seen_at,
           device.agent_protocol_version,
           device.agent_capabilities,
           (
             SELECT count(DISTINCT run.id)::int
               FROM agent_runs run
              WHERE run.state IN (
                'created','dispatched','running','waiting_for_human','verifying'
              )
                AND run.project_id=project.id
                AND EXISTS (
                  SELECT 1
                    FROM commands command
                   WHERE command.command_id = (
                     SELECT latest.command_id
                       FROM commands latest
                      WHERE latest.run_id = run.id
                      ORDER BY latest.created_at DESC,latest.command_id DESC
                      LIMIT 1
                   )
                     AND command.runner_id=device.id
                     AND command.runner_generation=device.current_generation
                )
           ) AS active_run_count
         FROM users actor
         JOIN projects project
           ON project.id=$1
          AND project.status='active'
         JOIN repository_bindings binding
           ON binding.project_id=project.id
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
         JOIN users device_owner
           ON device_owner.id=device.owner_user_id
          AND device_owner.status='active'
         JOIN device_credentials credential
           ON credential.device_id=device.id
          AND credential.state='active'
          AND credential.generation=device.current_generation
        WHERE actor.id=$2
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
        ORDER BY lower(device.display_name),device.id,binding.id`,
        [projectId, actorUserId],
      );
      return selected.rows.map((row) => ({
        project_id: row.project_id,
        execution_target_id: row.execution_target_id,
        device_id: row.device_id,
        name: row.display_name,
        location_label: row.location_label,
        os_family: row.os_family,
        lifecycle: row.lifecycle,
        last_seen_at: timestamp(row.last_seen_at),
        agent_protocol_version: row.agent_protocol_version,
        agent_capabilities: capabilities(row.agent_capabilities),
        active_run_count: Number(row.active_run_count),
      }));
    });
  }

  private async selectOwned(
    sql: V2SqlExecutor,
    actorUserId: string,
    deviceId: string,
  ): Promise<OwnedDeviceRecord | null> {
    const selected = await sql.query<DeviceRow>(
      `SELECT ${DEVICE_COLUMNS}
       FROM users actor
       JOIN devices device
         ON device.owner_user_id=actor.id
       LEFT JOIN device_credentials credential
         ON credential.device_id=device.id
        AND credential.state='active'
        AND credential.generation=device.current_generation
      WHERE actor.id=$1
        AND actor.status='active'
        AND device.id=$2`,
      [actorUserId, deviceId],
    );
    const row = selected.rows[0];
    return row ? deviceRecord(row, await selectGrants(sql, deviceId, actorUserId)) : null;
  }
}
