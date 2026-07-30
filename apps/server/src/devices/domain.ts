import type { DeviceAuthorizationPollOutcomeT } from "@norns/contracts";
import type { HashedEnrollmentCode } from "./crypto.js";

export type DeviceAuthorizationRequestState =
  | "pending"
  | "approved_pending_redemption"
  | "active"
  | "denied"
  | "expired";

export type DeviceOsFamily = "macos" | "windows" | "linux" | "other";

export interface DeviceAuthorizationRequestRecord {
  authorization_request_id: string;
  state: DeviceAuthorizationRequestState;
  public_key_spki_der: Buffer;
  public_key_fingerprint: string;
  proposed_name: string;
  os_family: DeviceOsFamily;
  architecture: string;
  owner_user_id: string | null;
  expires_at: string;
  approved_at: string | null;
  redeemed_at: string | null;
  terminal_at: string | null;
  last_polled_at: string | null;
  poll_interval_seconds: number;
  device_id: string | null;
  credential_id: string | null;
  generation: number | null;
}

export interface DeviceAuthorizationDecisionRecord extends DeviceAuthorizationRequestRecord {
  human_code_hash: HashedEnrollmentCode;
}

export interface CreateDeviceAuthorizationRecord {
  authorization_request_id: string;
  device_code_hash: HashedEnrollmentCode;
  human_code_hash: HashedEnrollmentCode;
  public_key_spki_der: Buffer;
  public_key_fingerprint: string;
  proposed_name: string;
  os_family: DeviceOsFamily;
  architecture: string;
  expires_at: string;
  poll_interval_seconds: number;
  created_at: string;
}

export interface DeviceEnrollmentRepository {
  createAuthorization(input: CreateDeviceAuthorizationRecord): Promise<"created" | "not_created">;
  lookupByHumanCode(input: {
    human_code_hash: HashedEnrollmentCode;
    now: string;
  }): Promise<DeviceAuthorizationDecisionRecord | null>;
  getDecisionCandidate(input: {
    authorization_request_id: string;
    now: string;
  }): Promise<DeviceAuthorizationDecisionRecord | null>;
  approve(input: {
    authorization_request_id: string;
    human_code_hash: HashedEnrollmentCode;
    owner_user_id: string;
    now: string;
  }): Promise<DeviceAuthorizationRequestRecord | null>;
  deny(input: {
    authorization_request_id: string;
    human_code_hash: HashedEnrollmentCode;
    denied_by_user_id: string;
    now: string;
  }): Promise<DeviceAuthorizationRequestRecord | null>;
  poll(input: {
    device_code_hash: HashedEnrollmentCode;
    now: string;
  }): Promise<
    | { kind: "not_found" }
    | { kind: "authorization_pending"; retry_after_seconds: number }
    | { kind: "slow_down"; retry_after_seconds: number }
    | {
        kind: "approved_pending_redemption" | "active";
        record: DeviceAuthorizationRequestRecord;
      }
    | { kind: "access_denied" }
    | { kind: "expired_token" }
  >;
  redeem(input: {
    authorization_request_id: string;
    device_code_hash: HashedEnrollmentCode;
    public_key_fingerprint: string;
    device_id: string;
    credential_id: string;
    now: string;
    redemption_result_expires_at: string;
  }): Promise<
    | {
        kind: "active";
        device_id: string;
        credential_id: string;
        generation: number;
      }
    | { kind: "access_denied" }
    | { kind: "expired_token" }
  >;
}

export type DeviceEnrollmentPollOutcome = DeviceAuthorizationPollOutcomeT;

export interface CreatedDeviceAuthorization {
  authorization_request_id: string;
  /** Returned once. Repository records contain only its keyed hash. */
  device_code: string;
  /** Returned once and stored only as a separate normalized-code hash. */
  user_code: string;
  verification_uri: string;
  expires_at: string;
  interval_seconds: number;
}

export interface DeviceAuthorizationLookup {
  authorization_request_id: string;
  /** Opaque, request-bound capability; it is not the submitted human code. */
  authorization_context: string;
  proposed_name: string;
  os_family: DeviceOsFamily;
  architecture: string;
  public_key_fingerprint: string;
  expires_at: string;
}

export class DeviceEnrollmentError extends Error {
  constructor(
    readonly code: "invalid_public_key" | "invalid_device_metadata" | "authorization_not_available",
  ) {
    super(
      code === "invalid_public_key"
        ? "The device enrollment key was rejected."
        : code === "invalid_device_metadata"
          ? "The device enrollment metadata was rejected."
          : "The device authorization request is not available.",
    );
    this.name = "DeviceEnrollmentError";
  }
}
