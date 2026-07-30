import {
  DEVICE_WSS_PROTOCOL_VERSION,
  type DeviceAvailabilityT,
  type DeviceCompatibilityT,
  ProjectExecutionTargetProjection,
  type ProjectExecutionTargetProjectionT,
} from "@norns/contracts";

import type {
  DeviceRepositoryGrant,
  DeviceRepositoryRegistration,
  OwnedDeviceRepositoryAccess,
  PostgresDeviceRepositoryAccessRepository,
  ProjectExecutionTargetOptionRecord,
} from "./repositoryAccess.js";

export interface DeviceRepositoryAccessPresence {
  availability(deviceId: string): DeviceAvailabilityT;
}

export interface ProjectExecutionTargetsProjection {
  project_id: string;
  selected_execution_target_id: string | null;
  work_active: boolean;
  execution_targets: ProjectExecutionTargetProjectionT[];
}

export class DeviceRepositoryAccessError extends Error {
  constructor(
    readonly code:
      | "authorization_denied"
      | "project_not_found"
      | "execution_target_changed"
      | "project_work_active",
  ) {
    super(code);
    this.name = "DeviceRepositoryAccessError";
  }
}

export class DeviceRepositoryAccessService {
  private readonly supportedProtocols: ReadonlySet<string>;

  constructor(
    private readonly repository: PostgresDeviceRepositoryAccessRepository,
    private readonly presence: DeviceRepositoryAccessPresence = {
      availability: () => "offline",
    },
    supportedProtocolVersions: readonly string[] = [DEVICE_WSS_PROTOCOL_VERSION],
    private readonly now: () => Date = () => new Date(),
  ) {
    this.supportedProtocols = new Set(supportedProtocolVersions);
  }

  async getOwnedRepositoryAccess(
    actorUserId: string,
    deviceId: string,
  ): Promise<OwnedDeviceRepositoryAccess> {
    const access = await this.repository.ownedRepositoryAccess(actorUserId, deviceId);
    if (!access) throw new DeviceRepositoryAccessError("authorization_denied");
    return access;
  }

  async registerRepository(input: {
    device_id: string;
    credential_id: string;
    generation: number;
    workspace_id: string;
    repository_id: string;
    repository_display_name: string;
    default_branch: string;
    observed_head: string | null;
  }): Promise<DeviceRepositoryRegistration> {
    const registration = await this.repository.register({
      ...input,
      now: this.now().toISOString(),
    });
    if (!registration) throw new DeviceRepositoryAccessError("authorization_denied");
    return registration;
  }

  async removeRepositoryAccess(input: {
    device_id: string;
    credential_id: string;
    generation: number;
    registration_id: string;
    workspace_id: string;
    repository_id: string;
  }): Promise<DeviceRepositoryRegistration> {
    const registration = await this.repository.removeAccess({
      ...input,
      now: this.now().toISOString(),
    });
    if (!registration) throw new DeviceRepositoryAccessError("authorization_denied");
    return registration;
  }

  async grantRepository(input: {
    actor_user_id: string;
    project_id: string;
    repository_registration_id: string;
  }): Promise<DeviceRepositoryGrant> {
    const grant = await this.repository.grant({ ...input, now: this.now().toISOString() });
    if (!grant) throw new DeviceRepositoryAccessError("authorization_denied");
    return grant;
  }

  async revokeRepositoryGrant(input: {
    actor_user_id: string;
    device_id: string;
    grant_id: string;
  }): Promise<DeviceRepositoryGrant> {
    const grant = await this.repository.revokeGrant({ ...input, now: this.now().toISOString() });
    if (!grant) throw new DeviceRepositoryAccessError("authorization_denied");
    return grant;
  }

  async listProjectExecutionTargets(
    actorUserId: string,
    projectId: string,
  ): Promise<ProjectExecutionTargetsProjection> {
    const record = await this.repository.listTargets(actorUserId, projectId);
    if (!record) throw new DeviceRepositoryAccessError("project_not_found");
    return {
      project_id: record.project_id,
      selected_execution_target_id: record.selected_execution_target_id,
      work_active: record.work_active,
      execution_targets: record.execution_targets.map((target) => this.target(target)),
    };
  }

  async selectProjectExecutionTarget(input: {
    actor_user_id: string;
    project_id: string;
    execution_target_id: string;
    expected_current_execution_target_id: string | null;
  }): Promise<ProjectExecutionTargetsProjection> {
    const outcome = await this.repository.selectTarget({
      ...input,
      now: this.now().toISOString(),
    });
    if (outcome.outcome === "not_found") {
      throw new DeviceRepositoryAccessError("authorization_denied");
    }
    if (outcome.outcome === "execution_target_changed") {
      throw new DeviceRepositoryAccessError("execution_target_changed");
    }
    if (outcome.outcome === "project_work_active") {
      throw new DeviceRepositoryAccessError("project_work_active");
    }
    return this.listProjectExecutionTargets(input.actor_user_id, input.project_id);
  }

  private target(record: ProjectExecutionTargetOptionRecord): ProjectExecutionTargetProjectionT {
    return ProjectExecutionTargetProjection.parse({
      project_id: record.project_id,
      execution_target_id: record.execution_target_id,
      name: record.name,
      location_label: record.location_label,
      os_family: record.os_family,
      status: {
        availability: this.presence.availability(record.device_id),
        compatibility: this.compatibility(record.agent_protocol_version, record.agent_capabilities),
        workload: record.active_run_count > 0 ? "busy" : "idle",
        access: record.access,
      },
      last_seen_at: record.last_seen_at,
    });
  }

  private compatibility(
    protocolVersion: string | null,
    capabilities: readonly string[] | null,
  ): DeviceCompatibilityT {
    if (protocolVersion === null || capabilities === null) return "limited";
    return this.supportedProtocols.has(protocolVersion) ? "ready" : "update_required";
  }
}
