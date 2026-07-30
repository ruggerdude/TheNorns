import {
  DeviceAvailability,
  ProjectExecutionTargetProjection,
  type ProjectExecutionTargetProjectionT,
} from "@norns/contracts";
import { z } from "zod";

import type { V2SqlExecutor } from "../persistence/v2/database.js";

export interface DeviceBrowserSessionDelivery {
  user_id: string;
  /**
   * The host must revalidate the live session before writing. This seam
   * determines audience; it does not replace session authentication.
   */
  send(frame: DeviceBrowserDeliveryFrame): void | Promise<void>;
}

export interface DeviceBrowserAudienceRepository {
  ownerUserId(deviceId: string): Promise<string | null>;
  acceptedProjectUserIds(input: {
    device_id: string;
    project_id: string;
    execution_target_id: string;
  }): Promise<readonly string[]>;
  isAcceptedProjectUser(input: {
    device_id: string;
    project_id: string;
    execution_target_id: string;
    user_id: string;
  }): Promise<boolean>;
}

const DeviceOwnerAvailabilityEvent = z
  .object({
    device_id: z.string().trim().min(1),
    availability: DeviceAvailability,
    observed_at: z.string().datetime(),
  })
  .strict();

export interface DeviceOwnerAvailabilityFrame {
  type: "device_status";
  audience: "owner";
  device_id: string;
  availability: z.infer<typeof DeviceAvailability>;
  observed_at: string;
}

export interface ProjectExecutionTargetStatusFrame {
  type: "project_execution_target_status";
  audience: "project";
  project_id: string;
  target: ProjectExecutionTargetProjectionT;
}

export type DeviceBrowserDeliveryFrame =
  | DeviceOwnerAvailabilityFrame
  | ProjectExecutionTargetStatusFrame;

export interface DeviceBrowserDeliveryResult {
  audience_users: number;
  delivered_sessions: number;
  failed_sessions: number;
}

interface UserIdRow {
  user_id: string;
}

/**
 * Resolves only current, explicit audiences. Administrator role is not an
 * audience predicate. Project delivery requires an accepted binding whose
 * grant, registration, device, and repository identity still agree.
 */
export class PostgresDeviceBrowserAudienceRepository implements DeviceBrowserAudienceRepository {
  constructor(private readonly sql: V2SqlExecutor) {}

  async ownerUserId(deviceId: string): Promise<string | null> {
    if (!deviceId.trim()) return null;
    const selected = await this.sql.query<UserIdRow>(
      `SELECT owner.id AS user_id
         FROM devices device
         JOIN users owner
           ON owner.id = device.owner_user_id
          AND owner.status = 'active'
        WHERE device.id = $1`,
      [deviceId],
    );
    return selected.rows[0]?.user_id ?? null;
  }

  async acceptedProjectUserIds(input: {
    device_id: string;
    project_id: string;
    execution_target_id: string;
  }): Promise<readonly string[]> {
    if (!input.device_id.trim() || !input.project_id.trim() || !input.execution_target_id.trim()) {
      return [];
    }
    const selected = await this.sql.query<UserIdRow>(
      `SELECT identity.id AS user_id
         FROM users identity
         JOIN projects project
           ON project.id = $2
          AND project.status = 'active'
        WHERE identity.status = 'active'
          AND (
            identity.id = project.owner_user_id
            OR EXISTS (
              SELECT 1
                FROM project_members membership
               WHERE membership.project_id = project.id
                 AND membership.user_id = identity.id
                 AND membership.status = 'active'
            )
          )
          AND EXISTS (
            SELECT 1
              FROM repository_bindings binding
              JOIN project_device_repository_grants grant_record
                ON grant_record.id = binding.project_device_repository_grant_id
               AND grant_record.project_id = binding.project_id
               AND grant_record.id = $3
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
               AND credential.id = registration.approved_credential_id
               AND credential.state = 'active'
               AND credential.generation = device.current_generation
               AND credential.generation = registration.approved_generation
             WHERE binding.id = project.primary_repository_binding_id
               AND binding.project_id = project.id
               AND binding.binding_type = 'local_runner'
               AND binding.status IN ('connected', 'degraded', 'disconnected')
               AND device.id = $1
          )
        ORDER BY identity.id`,
      [input.device_id, input.project_id, input.execution_target_id],
    );
    return selected.rows.map((row) => row.user_id);
  }

  async isAcceptedProjectUser(input: {
    device_id: string;
    project_id: string;
    execution_target_id: string;
    user_id: string;
  }): Promise<boolean> {
    if (!input.user_id.trim()) return false;
    const accepted = await this.acceptedProjectUserIds(input);
    return accepted.includes(input.user_id);
  }
}

/**
 * Device frames can only enter one of two explicit scopes. There is
 * intentionally no "all authenticated sessions" method.
 */
export class ScopedDeviceBrowserDelivery {
  constructor(private readonly audience: DeviceBrowserAudienceRepository) {}

  async deliverOwnerAvailability(
    event: z.input<typeof DeviceOwnerAvailabilityEvent>,
    sessions: readonly DeviceBrowserSessionDelivery[],
  ): Promise<DeviceBrowserDeliveryResult> {
    const parsed = DeviceOwnerAvailabilityEvent.parse(event);
    const ownerUserId = await this.audience.ownerUserId(parsed.device_id);
    const frame: DeviceOwnerAvailabilityFrame = {
      type: "device_status",
      audience: "owner",
      ...parsed,
    };
    return this.deliver(ownerUserId === null ? [] : [ownerUserId], frame, sessions);
  }

  async deliverProjectTargetStatus(
    input: {
      device_id: string;
      project_id: string;
      execution_target_id: string;
      target: ProjectExecutionTargetProjectionT;
    },
    sessions: readonly DeviceBrowserSessionDelivery[],
  ): Promise<DeviceBrowserDeliveryResult> {
    const target = ProjectExecutionTargetProjection.parse(input.target);
    if (
      !input.device_id.trim() ||
      target.project_id !== input.project_id ||
      target.execution_target_id !== input.execution_target_id
    ) {
      return { audience_users: 0, delivered_sessions: 0, failed_sessions: 0 };
    }
    const userIds = await this.audience.acceptedProjectUserIds({
      device_id: input.device_id,
      project_id: input.project_id,
      execution_target_id: input.execution_target_id,
    });
    const audienceInput = {
      device_id: input.device_id,
      project_id: input.project_id,
      execution_target_id: input.execution_target_id,
    };
    return this.deliver(
      userIds,
      {
        type: "project_execution_target_status",
        audience: "project",
        project_id: input.project_id,
        target,
      },
      sessions,
      (userId) => this.audience.isAcceptedProjectUser({ ...audienceInput, user_id: userId }),
    );
  }

  private async deliver(
    userIds: readonly string[],
    frame: DeviceBrowserDeliveryFrame,
    sessions: readonly DeviceBrowserSessionDelivery[],
    revalidate?: (userId: string) => Promise<boolean>,
  ): Promise<DeviceBrowserDeliveryResult> {
    const audience = new Set(userIds);
    let deliveredSessions = 0;
    let failedSessions = 0;
    for (const session of sessions) {
      if (!audience.has(session.user_id)) continue;
      try {
        if (revalidate && !(await revalidate(session.user_id))) continue;
        await session.send(frame);
        deliveredSessions += 1;
      } catch {
        failedSessions += 1;
      }
    }
    return {
      audience_users: audience.size,
      delivered_sessions: deliveredSessions,
      failed_sessions: failedSessions,
    };
  }
}
