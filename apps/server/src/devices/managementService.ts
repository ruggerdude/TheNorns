import {
  DEVICE_WSS_PROTOCOL_VERSION,
  type DeviceAvailabilityT,
  type DeviceCompatibilityT,
  OwnedDeviceProjection,
  type OwnedDeviceProjectionT,
} from "@norns/contracts";

import type {
  OwnedDeviceRecord,
  PostgresDeviceManagementRepository,
} from "./managementRepository.js";
import { DeviceRevocationError, type DeviceRevocationService } from "./revocation.js";

export interface DevicePresenceProjection {
  availability(deviceId: string): DeviceAvailabilityT;
}

export interface DeviceManagementServiceOptions {
  now?: () => Date;
  presence?: DevicePresenceProjection;
  supportedProtocolVersions?: readonly string[];
  requiredCapabilities?: readonly string[];
}

export class DeviceManagementError extends Error {
  constructor(
    readonly code:
      | "device_not_found"
      | "device_revoked"
      | "project_not_found"
      | "invalid_device_name"
      | "invalid_location_label"
      | "invalid_revocation_reason",
  ) {
    super(code);
    this.name = "DeviceManagementError";
  }
}

export class DeviceManagementService {
  private readonly now: () => Date;
  private readonly presence: DevicePresenceProjection;
  private readonly supportedProtocolVersions: ReadonlySet<string>;
  private readonly requiredCapabilities: readonly string[];

  constructor(
    private readonly repository: PostgresDeviceManagementRepository,
    private readonly revocations: Pick<DeviceRevocationService, "revoke">,
    options: DeviceManagementServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.presence = options.presence ?? { availability: () => "offline" };
    this.supportedProtocolVersions = new Set(
      options.supportedProtocolVersions ?? [DEVICE_WSS_PROTOCOL_VERSION],
    );
    this.requiredCapabilities = options.requiredCapabilities ?? [];
  }

  async listOwnedDevices(actorUserId: string): Promise<OwnedDeviceProjectionT[]> {
    const records = await this.repository.listOwned(actorUserId);
    return records.map((record) => this.ownedProjection(record));
  }

  async getOwnedDevice(actorUserId: string, deviceId: string): Promise<OwnedDeviceProjectionT> {
    const record = await this.repository.getOwned(actorUserId, deviceId);
    if (!record) throw new DeviceManagementError("device_not_found");
    return this.ownedProjection(record);
  }

  async renameOwnedDevice(input: {
    actor_user_id: string;
    device_id: string;
    name: string;
    location_label: string | null;
  }): Promise<OwnedDeviceProjectionT> {
    const name = input.name.trim();
    if (name.length < 1 || name.length > 200) {
      throw new DeviceManagementError("invalid_device_name");
    }
    const locationLabel = input.location_label?.trim() || null;
    if (locationLabel !== null && locationLabel.length > 200) {
      throw new DeviceManagementError("invalid_location_label");
    }
    const outcome = await this.repository.renameOwned({
      actor_user_id: input.actor_user_id,
      device_id: input.device_id,
      name,
      location_label: locationLabel,
      updated_at: this.now().toISOString(),
    });
    if (outcome === "not_found") throw new DeviceManagementError("device_not_found");
    if (outcome === "revoked") throw new DeviceManagementError("device_revoked");
    return this.getOwnedDevice(input.actor_user_id, input.device_id);
  }

  async revokeOwnedDevice(input: {
    actor_user_id: string;
    device_id: string;
    reason: string;
  }): Promise<OwnedDeviceProjectionT> {
    const reason = input.reason.trim();
    if (reason.length < 1 || reason.length > 500) {
      throw new DeviceManagementError("invalid_revocation_reason");
    }
    if (!(await this.repository.canManage(input.actor_user_id, input.device_id))) {
      throw new DeviceManagementError("device_not_found");
    }
    try {
      await this.revocations.revoke({
        device_id: input.device_id,
        revoked_by_user_id: input.actor_user_id,
        reason,
        revoked_at: this.now().toISOString(),
      });
    } catch (error) {
      if (
        error instanceof DeviceRevocationError &&
        (error.code === "device_not_found" || error.code === "revocation_not_authorized")
      ) {
        throw new DeviceManagementError("device_not_found");
      }
      throw error;
    }
    return this.getOwnedDevice(input.actor_user_id, input.device_id);
  }

  private ownedProjection(record: OwnedDeviceRecord): OwnedDeviceProjectionT {
    const availability =
      record.lifecycle === "revoked" ? "offline" : this.presence.availability(record.device_id);
    return OwnedDeviceProjection.parse({
      device_id: record.device_id,
      owner_user_id: record.owner_user_id,
      name: record.name,
      location_label: record.location_label,
      os_family: record.os_family,
      os_version: record.os_version,
      lifecycle: record.lifecycle,
      status: {
        availability,
        compatibility: this.compatibility(
          record.agent?.protocol_version ?? null,
          record.agent?.capabilities ?? null,
        ),
        workload: record.lifecycle === "active" && record.active_run_count > 0 ? "busy" : "idle",
        access: record.lifecycle === "revoked" ? "revoked" : "owned",
      },
      last_seen_at: record.last_seen_at,
      active_credential: record.active_credential,
      agent: record.agent,
      repository_grants: record.repository_grants,
      activity: {
        active_run_count: record.active_run_count,
        queued_command_count: record.queued_command_count,
      },
    });
  }

  private compatibility(
    protocolVersion: string | null,
    capabilities: readonly string[] | null,
  ): DeviceCompatibilityT {
    if (protocolVersion === null || capabilities === null) return "limited";
    if (!this.supportedProtocolVersions.has(protocolVersion)) return "update_required";
    const advertised = new Set(capabilities);
    return this.requiredCapabilities.every((capability) => advertised.has(capability))
      ? "ready"
      : "limited";
  }
}
