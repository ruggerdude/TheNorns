import type { DeviceAccessT, DeviceOperatingSystemFamilyT } from "@norns/contracts";

import { newId } from "../ids.js";
import type { V2SqlExecutor, V2TransactionRunner } from "../persistence/v2/database.js";
import { PostgresDeviceAuthorizationPolicy } from "./policy.js";

export interface DeviceRepositoryRegistration {
  registration_id: string;
  device_id: string;
  workspace_id: string;
  repository_id: string;
  repository_display_name: string;
  default_branch: string;
  observed_head: string | null;
  state: "active" | "revoked";
}

export interface DeviceRepositoryGrant {
  grant_id: string;
  project_id: string;
  repository_registration_id: string;
  state: "active" | "revoked";
}

export interface OwnedDeviceRepositoryAccess {
  device_id: string;
  registrations: Array<{
    registration_id: string;
    repository_id: string;
    repository_display_name: string;
    default_branch: string;
    state: "active" | "revoked";
    grants: Array<{
      grant_id: string;
      project_id: string;
      state: "active" | "revoked";
    }>;
  }>;
  eligible_projects: Array<{ project_id: string; name: string }>;
}

export interface ProjectExecutionTargetOptionRecord {
  project_id: string;
  execution_target_id: string;
  device_id: string;
  name: string;
  location_label: string | null;
  os_family: DeviceOperatingSystemFamilyT;
  last_seen_at: string | null;
  agent_protocol_version: string | null;
  agent_capabilities: string[] | null;
  active_run_count: number;
  access: Extract<DeviceAccessT, "shared" | "pending">;
}

export interface ProjectExecutionTargetsRecord {
  project_id: string;
  viewer_role: "owner" | "member";
  selected_execution_target_id: string | null;
  work_active: boolean;
  legacy_claim_required: boolean;
  execution_targets: ProjectExecutionTargetOptionRecord[];
}

export type SelectProjectTargetOutcome =
  | { outcome: "selected" | "unchanged"; binding_id: string }
  | { outcome: "not_found" }
  | { outcome: "execution_target_changed" }
  | { outcome: "project_work_active" };

interface CurrentDeviceIdentityRow {
  owner_user_id: string;
}

interface RegistrationRow {
  id: string;
  device_id: string;
  workspace_id: string;
  repository_id: string;
  repository_display_name: string;
  default_branch: string | null;
  observed_head: string | null;
  state: "pending" | "active" | "revoked";
  approved_credential_id: string | null;
  approved_generation: number | string | null;
}

interface TargetAccessRow {
  is_owner: boolean;
  selected_grant_id: string | null;
  work_active: boolean;
  legacy_claim_required: boolean;
}

interface TargetRow {
  project_id: string;
  execution_target_id: string;
  device_id: string;
  display_name: string;
  location_label: string | null;
  os_family: DeviceOperatingSystemFamilyT;
  last_seen_at: string | Date | null;
  agent_protocol_version: string | null;
  agent_capabilities: unknown;
  active_run_count: number | string;
}

interface TargetBindingRow {
  project_id: string;
  current_binding_id: string | null;
  current_grant_id: string | null;
  workspace_id: string;
  repository_id: string;
  repository_display_name: string;
  default_branch: string;
  observed_head: string | null;
  verification_policy_ref: string;
}

class ProjectTargetCompareAndSwapConflict extends Error {}

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
  return Array.isArray(decoded) && decoded.every((item) => typeof item === "string")
    ? decoded
    : null;
}

async function lockCurrentDeviceIdentity(
  sql: V2SqlExecutor,
  input: { device_id: string; credential_id: string; generation: number },
): Promise<CurrentDeviceIdentityRow | null> {
  const selected = await sql.query<CurrentDeviceIdentityRow>(
    `SELECT device.owner_user_id
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
      FOR UPDATE OF device,owner,credential`,
    [input.device_id, input.credential_id, input.generation],
  );
  return selected.rows[0] ?? null;
}

function registrationProjection(row: RegistrationRow): DeviceRepositoryRegistration {
  if (row.default_branch === null || row.state === "pending") {
    throw new Error("repository registration is not active");
  }
  return {
    registration_id: row.id,
    device_id: row.device_id,
    workspace_id: row.workspace_id,
    repository_id: row.repository_id,
    repository_display_name: row.repository_display_name,
    default_branch: row.default_branch,
    observed_head: row.observed_head,
    state: row.state,
  };
}

/**
 * Phase 4's additive repository-authorization store. Every mutation locks and
 * revalidates the exact actor/device authorization in the same transaction.
 */
export class PostgresDeviceRepositoryAccessRepository {
  constructor(private readonly transactions: V2TransactionRunner) {}

  ownedRepositoryAccess(
    actorUserId: string,
    deviceId: string,
  ): Promise<OwnedDeviceRepositoryAccess | null> {
    return this.transactions.transaction(async (sql) => {
      const owned = await new PostgresDeviceAuthorizationPolicy(sql).canViewOwnedDevice({
        actor_user_id: actorUserId,
        device_id: deviceId,
      });
      if (!owned.allowed) return null;
      const registrations = await sql.query<{
        registration_id: string;
        repository_id: string;
        repository_display_name: string;
        default_branch: string;
        state: "active" | "revoked";
        grant_id: string | null;
        project_id: string | null;
        grant_state: "active" | "revoked" | null;
      }>(
        `SELECT
           registration.id AS registration_id,
           registration.repository_id,
           registration.repository_display_name,
           registration.default_branch,
           registration.state,
           grant_record.id AS grant_id,
           grant_record.project_id,
           grant_record.state AS grant_state
         FROM device_repository_registrations registration
         LEFT JOIN project_device_repository_grants grant_record
           ON grant_record.repository_registration_id=registration.id
        WHERE registration.device_id=$1
          AND registration.default_branch IS NOT NULL
        ORDER BY
          lower(registration.repository_display_name),
          registration.id,
          grant_record.project_id,
          grant_record.id`,
        [deviceId],
      );
      const byRegistration = new Map<
        string,
        OwnedDeviceRepositoryAccess["registrations"][number]
      >();
      for (const row of registrations.rows) {
        let registration = byRegistration.get(row.registration_id);
        if (!registration) {
          registration = {
            registration_id: row.registration_id,
            repository_id: row.repository_id,
            repository_display_name: row.repository_display_name,
            default_branch: row.default_branch,
            state: row.state,
            grants: [],
          };
          byRegistration.set(row.registration_id, registration);
        }
        if (row.grant_id && row.project_id && row.grant_state) {
          registration.grants.push({
            grant_id: row.grant_id,
            project_id: row.project_id,
            state: row.grant_state,
          });
        }
      }
      const projects = await sql.query<{ project_id: string; name: string }>(
        `SELECT project.id AS project_id,project.name
           FROM users actor
           JOIN projects project
             ON project.status='active'
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
          WHERE actor.id=$1
            AND actor.status='active'
          ORDER BY lower(project.name),project.id`,
        [actorUserId],
      );
      return {
        device_id: deviceId,
        registrations: [...byRegistration.values()],
        eligible_projects: projects.rows,
      };
    });
  }

  register(input: {
    device_id: string;
    credential_id: string;
    generation: number;
    workspace_id: string;
    repository_id: string;
    repository_display_name: string;
    default_branch: string;
    observed_head: string | null;
    now: string;
  }): Promise<DeviceRepositoryRegistration | null> {
    return this.transactions.transaction(async (sql) => {
      const identity = await lockCurrentDeviceIdentity(sql, input);
      if (!identity) return null;
      const selected = await sql.query<RegistrationRow>(
        `SELECT
           id,device_id,workspace_id,repository_id,repository_display_name,
           default_branch,observed_head,state,approved_credential_id,approved_generation
         FROM device_repository_registrations
         WHERE device_id=$1
           AND workspace_id=$2
           AND repository_id=$3
         FOR UPDATE`,
        [input.device_id, input.workspace_id, input.repository_id],
      );
      const existing = selected.rows[0];
      if (existing) {
        if (existing.state === "revoked") return null;
        if (
          existing.state === "active" &&
          (existing.approved_credential_id !== input.credential_id ||
            Number(existing.approved_generation) !== input.generation)
        ) {
          return null;
        }
        const updated = await sql.query<RegistrationRow>(
          `UPDATE device_repository_registrations
              SET repository_display_name=$2,
                  default_branch=$3,
                  observed_head=$4,
                  state='active',
                  approved_by_user_id=COALESCE(approved_by_user_id,$5),
                  approved_at=COALESCE(approved_at,$6),
                  approved_credential_id=COALESCE(approved_credential_id,$7),
                  approved_generation=COALESCE(approved_generation,$8),
                  updated_at=$6
            WHERE id=$1
            RETURNING
              id,device_id,workspace_id,repository_id,repository_display_name,
              default_branch,observed_head,state,approved_credential_id,approved_generation`,
          [
            existing.id,
            input.repository_display_name,
            input.default_branch,
            input.observed_head,
            identity.owner_user_id,
            input.now,
            input.credential_id,
            input.generation,
          ],
        );
        return registrationProjection(updated.rows[0] as RegistrationRow);
      }

      const inserted = await sql.query<RegistrationRow>(
        `INSERT INTO device_repository_registrations (
           id,device_id,workspace_id,repository_id,repository_display_name,
           default_branch,observed_head,state,approved_by_user_id,approved_at,
           approved_credential_id,approved_generation,created_at,updated_at
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,'active',$8,$9,$10,$11,$9,$9
         )
         RETURNING
           id,device_id,workspace_id,repository_id,repository_display_name,
           default_branch,observed_head,state,approved_credential_id,approved_generation`,
        [
          newId("repository-registration"),
          input.device_id,
          input.workspace_id,
          input.repository_id,
          input.repository_display_name,
          input.default_branch,
          input.observed_head,
          identity.owner_user_id,
          input.now,
          input.credential_id,
          input.generation,
        ],
      );
      return registrationProjection(inserted.rows[0] as RegistrationRow);
    });
  }

  removeAccess(input: {
    device_id: string;
    credential_id: string;
    generation: number;
    registration_id: string;
    workspace_id: string;
    repository_id: string;
    now: string;
  }): Promise<DeviceRepositoryRegistration | null> {
    return this.transactions.transaction(async (sql) => {
      const identity = await lockCurrentDeviceIdentity(sql, input);
      if (!identity) return null;
      const selected = await sql.query<RegistrationRow>(
        `SELECT
           id,device_id,workspace_id,repository_id,repository_display_name,
           default_branch,observed_head,state,approved_credential_id,approved_generation
         FROM device_repository_registrations
         WHERE id=$1
           AND device_id=$2
           AND workspace_id=$3
           AND repository_id=$4
         FOR UPDATE`,
        [input.registration_id, input.device_id, input.workspace_id, input.repository_id],
      );
      const registration = selected.rows[0];
      if (!registration) return null;
      if (registration.state === "revoked") return registrationProjection(registration);

      await sql.query(
        `UPDATE projects project
            SET primary_repository_binding_id=NULL,
                updated_at=$2
          WHERE primary_repository_binding_id IN (
            SELECT binding.id
              FROM repository_bindings binding
              JOIN project_device_repository_grants grant_record
                ON grant_record.id=binding.project_device_repository_grant_id
             WHERE grant_record.repository_registration_id=$1
          )`,
        [registration.id, input.now],
      );
      await sql.query(
        `UPDATE repository_bindings binding
            SET status='revoked',updated_at=$2
          WHERE status<>'revoked'
            AND project_device_repository_grant_id IN (
              SELECT grant_record.id
                FROM project_device_repository_grants grant_record
               WHERE grant_record.repository_registration_id=$1
            )`,
        [registration.id, input.now],
      );
      await sql.query(
        `UPDATE project_device_repository_grants
            SET state='revoked',
                revoked_by_user_id=$2,
                revoked_at=$3,
                updated_at=$3
          WHERE repository_registration_id=$1
            AND state='active'`,
        [registration.id, identity.owner_user_id, input.now],
      );
      const revoked = await sql.query<RegistrationRow>(
        `UPDATE device_repository_registrations
            SET state='revoked',revoked_at=$2,updated_at=$2
          WHERE id=$1 AND state<>'revoked'
          RETURNING
            id,device_id,workspace_id,repository_id,repository_display_name,
            default_branch,observed_head,state,approved_credential_id,approved_generation`,
        [registration.id, input.now],
      );
      return registrationProjection(revoked.rows[0] ?? { ...registration, state: "revoked" });
    });
  }

  grant(input: {
    actor_user_id: string;
    project_id: string;
    repository_registration_id: string;
    now: string;
  }): Promise<DeviceRepositoryGrant | null> {
    return this.transactions.transaction(async (sql) => {
      const decision = await new PostgresDeviceAuthorizationPolicy(sql).canGrantRepository(input);
      if (!decision.allowed) return null;
      const registration = await sql.query<{ id: string }>(
        `SELECT registration.id
           FROM device_repository_registrations registration
           JOIN devices device
             ON device.id=registration.device_id
            AND device.lifecycle='active'
           JOIN device_credentials credential
             ON credential.device_id=device.id
            AND credential.id=registration.approved_credential_id
            AND credential.generation=registration.approved_generation
            AND credential.generation=device.current_generation
            AND credential.state='active'
          WHERE registration.id=$1
            AND registration.state='active'
            AND registration.default_branch IS NOT NULL
          FOR UPDATE OF registration,device,credential`,
        [input.repository_registration_id],
      );
      if (!registration.rows[0]) return null;
      const existing = await sql.query<{
        id: string;
        project_id: string;
        repository_registration_id: string;
        state: "active" | "revoked";
      }>(
        `SELECT
           id,project_id,repository_registration_id,state
         FROM project_device_repository_grants
         WHERE project_id=$1
           AND repository_registration_id=$2
         FOR UPDATE`,
        [input.project_id, input.repository_registration_id],
      );
      if (existing.rows[0]?.state === "revoked") return null;
      const row =
        existing.rows[0] ??
        (
          await sql.query<{
            id: string;
            project_id: string;
            repository_registration_id: string;
            state: "active";
          }>(
            `INSERT INTO project_device_repository_grants (
               id,project_id,repository_registration_id,state,
               granted_by_user_id,granted_at,created_at,updated_at
             ) VALUES ($1,$2,$3,'active',$4,$5,$5,$5)
             RETURNING id,project_id,repository_registration_id,state`,
            [
              newId("repository-grant"),
              input.project_id,
              input.repository_registration_id,
              input.actor_user_id,
              input.now,
            ],
          )
        ).rows[0];
      return row
        ? {
            grant_id: row.id,
            project_id: row.project_id,
            repository_registration_id: row.repository_registration_id,
            state: row.state,
          }
        : null;
    });
  }

  revokeGrant(input: {
    actor_user_id: string;
    device_id: string;
    grant_id: string;
    now: string;
  }): Promise<DeviceRepositoryGrant | null> {
    return this.transactions.transaction(async (sql) => {
      const selected = await sql.query<{
        id: string;
        project_id: string;
        repository_registration_id: string;
        state: "active" | "revoked";
      }>(
        `SELECT
           grant_record.id,grant_record.project_id,
           grant_record.repository_registration_id,grant_record.state
         FROM users actor
         JOIN devices device
           ON device.owner_user_id=actor.id
          AND device.id=$2
          AND device.lifecycle='active'
         JOIN device_repository_registrations registration
           ON registration.device_id=device.id
         JOIN project_device_repository_grants grant_record
           ON grant_record.repository_registration_id=registration.id
          AND grant_record.id=$3
        WHERE actor.id=$1
          AND actor.status='active'
        FOR UPDATE OF actor,device,registration,grant_record`,
        [input.actor_user_id, input.device_id, input.grant_id],
      );
      const grant = selected.rows[0];
      if (!grant) return null;
      if (grant.state === "active") {
        await sql.query(
          `UPDATE projects project
              SET primary_repository_binding_id=NULL,updated_at=$2
            WHERE project.id=$1
              AND primary_repository_binding_id IN (
                SELECT id
                  FROM repository_bindings
                 WHERE project_device_repository_grant_id=$3
              )`,
          [grant.project_id, input.now, grant.id],
        );
        await sql.query(
          `UPDATE repository_bindings
              SET status='revoked',updated_at=$2
            WHERE project_device_repository_grant_id=$1
              AND status<>'revoked'`,
          [grant.id, input.now],
        );
        await sql.query(
          `UPDATE project_device_repository_grants
              SET state='revoked',
                  revoked_by_user_id=$2,
                  revoked_at=$3,
                  updated_at=$3
            WHERE id=$1 AND state='active'`,
          [grant.id, input.actor_user_id, input.now],
        );
      }
      return {
        grant_id: grant.id,
        project_id: grant.project_id,
        repository_registration_id: grant.repository_registration_id,
        state: "revoked",
      };
    });
  }

  listTargets(
    actorUserId: string,
    projectId: string,
  ): Promise<ProjectExecutionTargetsRecord | null> {
    return this.transactions.transaction(async (sql) => {
      const access = await sql.query<TargetAccessRow>(
        `SELECT
           project.owner_user_id=$1 AS is_owner,
           CASE
             WHEN selected_credential.id IS NOT NULL
             THEN selected_grant.id
             ELSE NULL
           END AS selected_grant_id,
           EXISTS (
             SELECT 1
               FROM agent_runs run
              WHERE run.project_id=project.id
                AND run.state IN (
                  'created','dispatched','running','waiting_for_human','verifying'
                )
           ) AS work_active,
           EXISTS (
             SELECT 1
               FROM repository_bindings legacy_binding
              WHERE legacy_binding.id=project.primary_repository_binding_id
                AND legacy_binding.project_id=project.id
                AND legacy_binding.status='legacy_claim_required'
           ) AS legacy_claim_required
         FROM users actor
         JOIN projects project
           ON project.id=$2
          AND project.status='active'
         LEFT JOIN repository_bindings selected_binding
           ON selected_binding.id=project.primary_repository_binding_id
          AND selected_binding.project_id=project.id
          AND selected_binding.binding_type='local_runner'
          AND selected_binding.status IN ('connected','degraded','disconnected')
         LEFT JOIN project_device_repository_grants selected_grant
           ON selected_grant.id=selected_binding.project_device_repository_grant_id
          AND selected_grant.project_id=project.id
          AND selected_grant.state='active'
         LEFT JOIN device_repository_registrations selected_registration
           ON selected_registration.id=selected_grant.repository_registration_id
          AND selected_registration.state='active'
          AND selected_registration.workspace_id=selected_binding.workspace_id
          AND selected_registration.repository_id=selected_binding.repository_id
         LEFT JOIN devices selected_device
           ON selected_device.id=selected_registration.device_id
          AND selected_device.lifecycle='active'
         LEFT JOIN users selected_owner
           ON selected_owner.id=selected_device.owner_user_id
          AND selected_owner.status='active'
         LEFT JOIN device_credentials selected_credential
           ON selected_credential.device_id=selected_device.id
          AND selected_credential.id=selected_registration.approved_credential_id
          AND selected_credential.generation=selected_registration.approved_generation
          AND selected_credential.generation=selected_device.current_generation
          AND selected_credential.state='active'
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
        [actorUserId, projectId],
      );
      const context = access.rows[0];
      if (!context) return null;
      const selected = await sql.query<TargetRow>(
        `SELECT
           project.id AS project_id,
           grant_record.id AS execution_target_id,
           device.id AS device_id,
           device.display_name,
           device.location_label,
           device.os_family,
           device.last_seen_at,
           device.agent_protocol_version,
           device.agent_capabilities,
           (
             SELECT count(DISTINCT run.id)::int
               FROM agent_runs run
              WHERE run.project_id=project.id
                AND run.state IN (
                  'created','dispatched','running','waiting_for_human','verifying'
                )
                AND run.repository_binding_id IN (
                  SELECT binding.id
                    FROM repository_bindings binding
                   WHERE binding.project_device_repository_grant_id=grant_record.id
                )
           ) AS active_run_count
         FROM projects project
         JOIN project_device_repository_grants grant_record
           ON grant_record.project_id=project.id
          AND grant_record.state='active'
         JOIN device_repository_registrations registration
           ON registration.id=grant_record.repository_registration_id
          AND registration.state='active'
          AND registration.default_branch IS NOT NULL
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
        WHERE project.id=$1
          AND ($2::boolean OR grant_record.id=$3)
        ORDER BY lower(device.display_name),device.id,grant_record.id`,
        [projectId, context.is_owner, context.selected_grant_id],
      );
      return {
        project_id: projectId,
        viewer_role: context.is_owner ? "owner" : "member",
        selected_execution_target_id: context.selected_grant_id,
        work_active: context.work_active,
        legacy_claim_required: context.legacy_claim_required,
        execution_targets: selected.rows.map((row) => ({
          project_id: row.project_id,
          execution_target_id: row.execution_target_id,
          device_id: row.device_id,
          name: row.display_name,
          location_label: row.location_label,
          os_family: row.os_family,
          last_seen_at: timestamp(row.last_seen_at),
          agent_protocol_version: row.agent_protocol_version,
          agent_capabilities: capabilities(row.agent_capabilities),
          active_run_count: Number(row.active_run_count),
          access: row.execution_target_id === context.selected_grant_id ? "shared" : "pending",
        })),
      };
    });
  }

  async selectTarget(input: {
    actor_user_id: string;
    project_id: string;
    execution_target_id: string;
    expected_current_execution_target_id: string | null;
    now: string;
  }): Promise<SelectProjectTargetOutcome> {
    try {
      return await this.transactions.transaction(async (sql) => {
        const targetDecision = await new PostgresDeviceAuthorizationPolicy(
          sql,
        ).canAcceptProjectTarget(input);
        if (!targetDecision.allowed) return { outcome: "not_found" };
        const selected = await sql.query<TargetBindingRow>(
          `SELECT
           project.id AS project_id,
           project.primary_repository_binding_id AS current_binding_id,
           CASE
             WHEN current_credential.id IS NOT NULL
             THEN current_grant.id
             ELSE NULL
           END AS current_grant_id,
           registration.workspace_id,
           registration.repository_id,
           registration.repository_display_name,
           registration.default_branch,
           registration.observed_head,
           project.verification_policy_ref
         FROM users actor
         JOIN projects project
           ON project.owner_user_id=actor.id
          AND project.id=$2
          AND project.status='active'
         LEFT JOIN repository_bindings current_binding
           ON current_binding.id=project.primary_repository_binding_id
          AND current_binding.project_id=project.id
          AND current_binding.binding_type='local_runner'
          AND current_binding.status IN ('connected','degraded','disconnected')
         LEFT JOIN project_device_repository_grants current_grant
           ON current_grant.id=current_binding.project_device_repository_grant_id
          AND current_grant.project_id=project.id
          AND current_grant.state='active'
         LEFT JOIN device_repository_registrations current_registration
           ON current_registration.id=current_grant.repository_registration_id
          AND current_registration.state='active'
          AND current_registration.workspace_id=current_binding.workspace_id
          AND current_registration.repository_id=current_binding.repository_id
         LEFT JOIN devices current_device
           ON current_device.id=current_registration.device_id
          AND current_device.lifecycle='active'
         LEFT JOIN users current_owner
           ON current_owner.id=current_device.owner_user_id
          AND current_owner.status='active'
         LEFT JOIN device_credentials current_credential
           ON current_credential.device_id=current_device.id
          AND current_credential.id=current_registration.approved_credential_id
          AND current_credential.generation=current_registration.approved_generation
          AND current_credential.generation=current_device.current_generation
          AND current_credential.state='active'
         JOIN project_device_repository_grants grant_record
           ON grant_record.id=$3
          AND grant_record.project_id=project.id
          AND grant_record.state='active'
         JOIN device_repository_registrations registration
           ON registration.id=grant_record.repository_registration_id
          AND registration.state='active'
          AND registration.default_branch IS NOT NULL
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
        WHERE actor.id=$1
          AND actor.status='active'
        FOR UPDATE OF actor,project,grant_record,registration,device,device_owner,credential`,
          [input.actor_user_id, input.project_id, input.execution_target_id],
        );
        const target = selected.rows[0];
        if (!target) return { outcome: "not_found" };
        if (target.current_grant_id === input.execution_target_id && target.current_binding_id) {
          return { outcome: "unchanged", binding_id: target.current_binding_id };
        }
        if (target.current_grant_id !== input.expected_current_execution_target_id) {
          return { outcome: "execution_target_changed" };
        }
        const active = await sql.query<{ work_active: boolean }>(
          `SELECT EXISTS (
           SELECT 1
             FROM agent_runs run
            WHERE run.project_id=$1
              AND run.state IN (
                'created','dispatched','running','waiting_for_human','verifying'
              )
         ) AS work_active`,
          [input.project_id],
        );
        if (active.rows[0]?.work_active) return { outcome: "project_work_active" };

        const bindingId = newId("repository-binding");
        await sql.query(
          `INSERT INTO repository_bindings (
           id,project_id,binding_type,status,runner_id,workspace_id,repository_id,
           repository_display_name,granted_permissions,default_branch,observed_head,
           verification_policy_ref,repository_health,created_by_actor_type,
           created_by_actor_id,project_device_repository_grant_id,role,created_at,updated_at
         ) VALUES (
           $1,$2,'local_runner','disconnected',NULL,$3,$4,$5,'{}'::jsonb,$6,$7,
           $8,'unknown','human',$9,$10,'workspace',$11,$11
         )`,
          [
            bindingId,
            input.project_id,
            target.workspace_id,
            target.repository_id,
            target.repository_display_name,
            target.default_branch,
            target.observed_head,
            target.verification_policy_ref,
            input.actor_user_id,
            input.execution_target_id,
            input.now,
          ],
        );
        const updated = await sql.query<{ id: string }>(
          `UPDATE projects
            SET primary_repository_binding_id=$2,updated_at=$3
          WHERE id=$1
            AND primary_repository_binding_id IS NOT DISTINCT FROM $4
          RETURNING id`,
          [input.project_id, bindingId, input.now, target.current_binding_id],
        );
        if (!updated.rows[0]) throw new ProjectTargetCompareAndSwapConflict();
        return { outcome: "selected", binding_id: bindingId };
      });
    } catch (error) {
      if (error instanceof ProjectTargetCompareAndSwapConflict) {
        return { outcome: "execution_target_changed" };
      }
      throw error;
    }
  }
}
