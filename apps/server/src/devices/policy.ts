import type {
  CanAcceptProjectTargetDecisionT,
  CanDispatchDecisionT,
  CanEmergencyStopDeviceDecisionT,
  CanGrantRepositoryDecisionT,
  CanManageDeviceDecisionT,
  CanStopProjectRunDecisionT,
  CanViewOwnedDeviceDecisionT,
} from "@norns/contracts";

import type { V2SqlExecutor } from "../persistence/v2/database.js";

const DENIED_REASON = "authorization_denied";

interface AllowedRow {
  allowed: boolean;
}

async function allowed(sql: V2SqlExecutor, statement: string, params: unknown[]): Promise<boolean> {
  const result = await sql.query<AllowedRow>(statement, params);
  return result.rows[0]?.allowed === true;
}

function decisionResult(isAllowed: boolean): {
  allowed: boolean;
  reason_code: string | null;
} {
  return {
    allowed: isAllowed,
    reason_code: isAllowed ? null : DENIED_REASON,
  };
}

function validIds(...ids: string[]): boolean {
  return ids.every((id) => id.trim().length > 0);
}

/**
 * Action-specific, deny-by-default device authorization over the 0053 chain.
 * Administrator role is deliberately absent from every allow predicate.
 */
export class PostgresDeviceAuthorizationPolicy {
  constructor(private readonly sql: V2SqlExecutor) {}

  async canViewOwnedDevice(input: {
    actor_user_id: string;
    device_id: string;
  }): Promise<CanViewOwnedDeviceDecisionT> {
    const isAllowed =
      validIds(input.actor_user_id, input.device_id) &&
      (await this.actorOwnsDevice(input.actor_user_id, input.device_id));
    return {
      action: "canViewOwnedDevice",
      device_id: input.device_id,
      ...decisionResult(isAllowed),
    };
  }

  async canManageDevice(input: {
    actor_user_id: string;
    device_id: string;
  }): Promise<CanManageDeviceDecisionT> {
    const isAllowed =
      validIds(input.actor_user_id, input.device_id) &&
      (await this.actorOwnsDevice(input.actor_user_id, input.device_id));
    return {
      action: "canManageDevice",
      device_id: input.device_id,
      ...decisionResult(isAllowed),
    };
  }

  async canGrantRepository(input: {
    actor_user_id: string;
    project_id: string;
    repository_registration_id: string;
  }): Promise<CanGrantRepositoryDecisionT> {
    const isAllowed =
      validIds(input.actor_user_id, input.project_id, input.repository_registration_id) &&
      (await allowed(
        this.sql,
        `SELECT EXISTS (
           SELECT 1
             FROM users actor
             JOIN devices device
               ON device.owner_user_id = actor.id
              AND device.lifecycle = 'active'
             JOIN device_repository_registrations registration
               ON registration.device_id = device.id
              AND registration.id = $3
              AND registration.state = 'active'
             JOIN projects project
               ON project.id = $2
              AND project.status = 'active'
            WHERE actor.id = $1
              AND actor.status = 'active'
              AND (
                project.owner_user_id = actor.id
                OR EXISTS (
                  SELECT 1
                    FROM project_members membership
                   WHERE membership.project_id = project.id
                     AND membership.user_id = actor.id
                     AND membership.status = 'active'
                )
              )
         ) AS allowed`,
        [input.actor_user_id, input.project_id, input.repository_registration_id],
      ));
    return {
      action: "canGrantRepository",
      project_id: input.project_id,
      repository_registration_id: input.repository_registration_id,
      ...decisionResult(isAllowed),
    };
  }

  async canAcceptProjectTarget(input: {
    actor_user_id: string;
    project_id: string;
    execution_target_id: string;
  }): Promise<CanAcceptProjectTargetDecisionT> {
    const isAllowed =
      validIds(input.actor_user_id, input.project_id, input.execution_target_id) &&
      (await allowed(
        this.sql,
        `SELECT EXISTS (
           SELECT 1
             FROM users actor
             JOIN projects project
               ON project.owner_user_id = actor.id
              AND project.id = $2
              AND project.status = 'active'
             JOIN repository_bindings binding
               ON binding.id = $3
              AND binding.project_id = project.id
              AND binding.binding_type = 'local_runner'
              AND binding.status IN ('connected', 'degraded', 'disconnected')
             JOIN project_device_repository_grants grant_record
               ON grant_record.project_id = project.id
              AND grant_record.id = binding.project_device_repository_grant_id
              AND grant_record.state = 'active'
             JOIN device_repository_registrations registration
               ON registration.id = grant_record.repository_registration_id
              AND registration.state = 'active'
              AND registration.workspace_id = binding.workspace_id
              AND registration.repository_id = binding.repository_id
             JOIN devices device
               ON device.id = registration.device_id
              AND device.lifecycle = 'active'
             JOIN users device_owner
               ON device_owner.id = device.owner_user_id
              AND device_owner.status = 'active'
             JOIN device_credentials credential
               ON credential.device_id = device.id
              AND credential.state = 'active'
              AND credential.generation = device.current_generation
            WHERE actor.id = $1
              AND actor.status = 'active'
         ) AS allowed`,
        [input.actor_user_id, input.project_id, input.execution_target_id],
      ));
    return {
      action: "canAcceptProjectTarget",
      project_id: input.project_id,
      execution_target_id: input.execution_target_id,
      ...decisionResult(isAllowed),
    };
  }

  async canDispatch(input: {
    actor_user_id: string;
    project_id: string;
    execution_target_id: string;
    run_id: string;
  }): Promise<CanDispatchDecisionT> {
    const isAllowed =
      validIds(input.actor_user_id, input.project_id, input.execution_target_id, input.run_id) &&
      (await allowed(
        this.sql,
        `SELECT EXISTS (
           SELECT 1
             FROM users actor
             JOIN projects project
               ON project.id = $2
              AND project.status = 'active'
             JOIN agent_runs run
               ON run.id = $4
              AND run.project_id = project.id
              AND run.repository_binding_id = $3
             JOIN users run_actor
               ON run_actor.id = run.initiated_by_user_id
              AND run_actor.status = 'active'
             JOIN repository_bindings binding
               ON binding.id = run.repository_binding_id
              AND binding.project_id = project.id
              AND binding.binding_type = 'local_runner'
              AND binding.status = 'connected'
             JOIN project_device_repository_grants grant_record
               ON grant_record.id = binding.project_device_repository_grant_id
              AND grant_record.project_id = project.id
              AND grant_record.state = 'active'
             JOIN device_repository_registrations registration
               ON registration.id = grant_record.repository_registration_id
              AND registration.state = 'active'
              AND registration.workspace_id = binding.workspace_id
              AND registration.repository_id = binding.repository_id
             JOIN devices device
               ON device.id = registration.device_id
              AND device.lifecycle = 'active'
             JOIN users device_owner
               ON device_owner.id = device.owner_user_id
              AND device_owner.status = 'active'
             JOIN device_credentials credential
               ON credential.device_id = device.id
              AND credential.state = 'active'
              AND credential.generation = device.current_generation
             JOIN commands command
               ON command.command_id = (
                 SELECT latest.command_id
                   FROM commands latest
                  WHERE latest.run_id = run.id
                  ORDER BY latest.created_at DESC, latest.command_id DESC
                  LIMIT 1
               )
              AND command.runner_id = device.id
              AND command.runner_generation = credential.generation
            WHERE actor.id = $1
              AND actor.status = 'active'
              AND (
                project.owner_user_id = actor.id
                OR EXISTS (
                  SELECT 1
                    FROM project_members membership
                   WHERE membership.project_id = project.id
                     AND membership.user_id = actor.id
                   AND membership.status = 'active'
                )
              )
              AND (
                project.owner_user_id = run_actor.id
                OR EXISTS (
                  SELECT 1
                    FROM project_members run_membership
                   WHERE run_membership.project_id = project.id
                     AND run_membership.user_id = run_actor.id
                     AND run_membership.status = 'active'
                )
              )
         ) AS allowed`,
        [input.actor_user_id, input.project_id, input.execution_target_id, input.run_id],
      ));
    return {
      action: "canDispatch",
      project_id: input.project_id,
      execution_target_id: input.execution_target_id,
      run_id: input.run_id,
      ...decisionResult(isAllowed),
    };
  }

  async canStopProjectRun(input: {
    actor_user_id: string;
    project_id: string;
    run_id: string;
  }): Promise<CanStopProjectRunDecisionT> {
    const isAllowed =
      validIds(input.actor_user_id, input.project_id, input.run_id) &&
      (await allowed(
        this.sql,
        `SELECT EXISTS (
           SELECT 1
             FROM users actor
             JOIN projects project ON project.id = $2
             JOIN agent_runs run
               ON run.id = $3
              AND run.project_id = project.id
            WHERE actor.id = $1
              AND actor.status = 'active'
              AND (
                project.owner_user_id = actor.id
                OR EXISTS (
                  SELECT 1
                    FROM project_members membership
                   WHERE membership.project_id = project.id
                     AND membership.user_id = actor.id
                     AND membership.status = 'active'
                )
              )
         ) AS allowed`,
        [input.actor_user_id, input.project_id, input.run_id],
      ));
    return {
      action: "canStopProjectRun",
      project_id: input.project_id,
      run_id: input.run_id,
      ...decisionResult(isAllowed),
    };
  }

  async canEmergencyStopDevice(input: {
    actor_user_id: string;
    device_id: string;
  }): Promise<CanEmergencyStopDeviceDecisionT> {
    const isAllowed =
      validIds(input.actor_user_id, input.device_id) &&
      (await this.actorOwnsDevice(input.actor_user_id, input.device_id));
    return {
      action: "canEmergencyStopDevice",
      device_id: input.device_id,
      ...decisionResult(isAllowed),
    };
  }

  private actorOwnsDevice(actorUserId: string, deviceId: string): Promise<boolean> {
    return allowed(
      this.sql,
      `SELECT EXISTS (
         SELECT 1
           FROM users actor
           JOIN devices device ON device.owner_user_id = actor.id
          WHERE actor.id = $1
            AND actor.status = 'active'
            AND device.id = $2
       ) AS allowed`,
      [actorUserId, deviceId],
    );
  }
}
