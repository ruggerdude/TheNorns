import { z } from "zod";

import { V2EntityId, V2IsoDateTime, V2NonEmptyString, V2Sha256Hex } from "./v2/common.js";

const DeviceGeneration = z.number().int().nonnegative();
const NonNegativeCount = z.number().int().nonnegative();
const PositivePollingIntervalSeconds = z.number().int().positive();
const NullableLabel = z.string().trim().min(1).max(200).nullable();

/**
 * Device identity is deliberately narrower than ownership, authorization,
 * credential generation, key verification, or connection presence.
 */
export const DeviceIdentity = z
  .object({
    device_id: V2EntityId,
  })
  .strict();
export type DeviceIdentityT = z.infer<typeof DeviceIdentity>;

export const DeviceCredentialIdentity = z
  .object({
    credential_id: V2EntityId,
  })
  .strict();
export type DeviceCredentialIdentityT = z.infer<typeof DeviceCredentialIdentity>;

export const AuthenticatedDeviceIdentity = z
  .object({
    device_id: V2EntityId,
    credential_id: V2EntityId,
  })
  .strict();
export type AuthenticatedDeviceIdentityT = z.infer<typeof AuthenticatedDeviceIdentity>;

/**
 * These are authorization and key-verification attributes for the active
 * credential. They are not part of the device's stable identity.
 */
export const ActiveDeviceCredential = z
  .object({
    device_id: V2EntityId,
    credential_id: V2EntityId,
    generation: DeviceGeneration,
    public_key_fingerprint: V2Sha256Hex,
    state: z.literal("active"),
    activated_at: V2IsoDateTime,
  })
  .strict();
export type ActiveDeviceCredentialT = z.infer<typeof ActiveDeviceCredential>;

export const DeviceAuthorizationState = z.enum([
  "pending",
  "approved_pending_redemption",
  "active",
  "denied",
  "expired",
]);
export type DeviceAuthorizationStateT = z.infer<typeof DeviceAuthorizationState>;

export const DEVICE_AUTHORIZATION_TRANSITIONS = {
  pending: ["approved_pending_redemption", "denied", "expired"],
  approved_pending_redemption: ["active", "denied", "expired"],
  active: [],
  denied: [],
  expired: [],
} as const satisfies Record<DeviceAuthorizationStateT, readonly DeviceAuthorizationStateT[]>;

export function canTransitionDeviceAuthorization(
  from: DeviceAuthorizationStateT,
  to: DeviceAuthorizationStateT,
): boolean {
  return (DEVICE_AUTHORIZATION_TRANSITIONS[from] as readonly DeviceAuthorizationStateT[]).includes(
    to,
  );
}

export const DeviceAuthorizationLifecycle = z
  .object({
    authorization_request_id: V2EntityId,
    state: DeviceAuthorizationState,
    created_at: V2IsoDateTime,
    expires_at: V2IsoDateTime,
    approved_at: V2IsoDateTime.nullable(),
    redeemed_at: V2IsoDateTime.nullable(),
    terminal_at: V2IsoDateTime.nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.state === "pending") {
      if (value.approved_at !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["approved_at"],
          message: "pending authorization cannot have an approval timestamp",
        });
      }
      if (value.redeemed_at !== null || value.terminal_at !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["state"],
          message: "pending authorization cannot be redeemed or terminal",
        });
      }
    }

    if (value.state === "approved_pending_redemption") {
      if (value.approved_at === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["approved_at"],
          message: "approved authorization requires an approval timestamp",
        });
      }
      if (value.redeemed_at !== null || value.terminal_at !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["state"],
          message: "authorization awaiting redemption cannot be redeemed or terminal",
        });
      }
    }

    if (value.state === "active") {
      if (value.approved_at === null || value.redeemed_at === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["state"],
          message: "active authorization requires approval and redemption timestamps",
        });
      }
      if (value.terminal_at !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["terminal_at"],
          message: "active authorization cannot have a terminal timestamp",
        });
      }
    }

    if (value.state === "denied" || value.state === "expired") {
      if (value.redeemed_at !== null || value.terminal_at === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["state"],
          message: "denied or expired authorization must be terminal and unredeemed",
        });
      }
    }
  });
export type DeviceAuthorizationLifecycleT = z.infer<typeof DeviceAuthorizationLifecycle>;

/**
 * Connection and workload conditions are projections, not lifecycle values.
 */
export const DeviceLifecycleState = z.enum(["active", "revoked"]);
export type DeviceLifecycleStateT = z.infer<typeof DeviceLifecycleState>;

export const DeviceAvailability = z.enum(["online", "connecting", "offline"]);
export type DeviceAvailabilityT = z.infer<typeof DeviceAvailability>;

export const DeviceCompatibility = z.enum(["ready", "limited", "update_required"]);
export type DeviceCompatibilityT = z.infer<typeof DeviceCompatibility>;

export const DeviceWorkload = z.enum(["idle", "busy"]);
export type DeviceWorkloadT = z.infer<typeof DeviceWorkload>;

export const DeviceAccess = z.enum(["owned", "shared", "pending", "revoked"]);
export type DeviceAccessT = z.infer<typeof DeviceAccess>;

export const DeviceStatusDimensions = z
  .object({
    availability: DeviceAvailability,
    compatibility: DeviceCompatibility,
    workload: DeviceWorkload,
    access: DeviceAccess,
  })
  .strict();
export type DeviceStatusDimensionsT = z.infer<typeof DeviceStatusDimensions>;

export const OwnedDeviceStatusDimensions = z
  .object({
    availability: DeviceAvailability,
    compatibility: DeviceCompatibility,
    workload: DeviceWorkload,
    access: z.union([z.literal("owned"), z.literal("revoked")]),
  })
  .strict();
export type OwnedDeviceStatusDimensionsT = z.infer<typeof OwnedDeviceStatusDimensions>;

export const DeviceOperatingSystemFamily = z.enum(["macos", "windows", "linux", "other"]);
export type DeviceOperatingSystemFamilyT = z.infer<typeof DeviceOperatingSystemFamily>;

export const OwnedDeviceProjection = z
  .object({
    device_id: V2EntityId,
    owner_user_id: V2EntityId,
    name: z.string().trim().min(1).max(200),
    location_label: NullableLabel,
    os_family: DeviceOperatingSystemFamily,
    os_version: V2NonEmptyString.nullable(),
    lifecycle: DeviceLifecycleState,
    status: OwnedDeviceStatusDimensions,
    last_seen_at: V2IsoDateTime.nullable(),
    active_credential: ActiveDeviceCredential.nullable(),
    agent: z
      .object({
        version: V2NonEmptyString,
        protocol_version: V2NonEmptyString,
        capabilities: z.array(V2NonEmptyString),
      })
      .strict()
      .nullable(),
    repository_grants: z.array(
      z
        .object({
          grant_id: V2EntityId,
          project_id: V2EntityId,
          repository_registration_id: V2EntityId,
          state: z.enum(["active", "revoked"]),
        })
        .strict(),
    ),
    activity: z
      .object({
        active_run_count: NonNegativeCount,
        queued_command_count: NonNegativeCount,
      })
      .strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.lifecycle === "active") {
      if (value.status.access !== "owned") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["status", "access"],
          message: "active owned-device projections require owned access",
        });
      }
      if (value.active_credential === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["active_credential"],
          message: "active devices require an active credential",
        });
      }
    }
    if (value.lifecycle === "revoked") {
      if (value.status.access !== "revoked") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["status", "access"],
          message: "revoked owned-device projections require revoked access",
        });
      }
      if (value.active_credential !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["active_credential"],
          message: "revoked devices cannot have an active credential",
        });
      }
    }
    if (value.active_credential !== null && value.active_credential.device_id !== value.device_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["active_credential", "device_id"],
        message: "active credential must belong to the projected device",
      });
    }
  });
export type OwnedDeviceProjectionT = z.infer<typeof OwnedDeviceProjection>;

/**
 * Grant scope is resolved server-side. This projection intentionally exposes
 * only the fields needed to choose an already-authorized execution target.
 */
export const ProjectExecutionTargetProjection = z
  .object({
    project_id: V2EntityId,
    execution_target_id: V2EntityId,
    name: z.string().trim().min(1).max(200),
    location_label: NullableLabel,
    os_family: DeviceOperatingSystemFamily,
    status: DeviceStatusDimensions,
    last_seen_at: V2IsoDateTime.nullable(),
  })
  .strict();
export type ProjectExecutionTargetProjectionT = z.infer<typeof ProjectExecutionTargetProjection>;

const AuthorizationDecisionResult = {
  allowed: z.boolean(),
  reason_code: V2NonEmptyString.nullable(),
} as const;

export const CanViewOwnedDeviceDecision = z
  .object({
    action: z.literal("canViewOwnedDevice"),
    device_id: V2EntityId,
    ...AuthorizationDecisionResult,
  })
  .strict();
export type CanViewOwnedDeviceDecisionT = z.infer<typeof CanViewOwnedDeviceDecision>;

export const CanManageDeviceDecision = z
  .object({
    action: z.literal("canManageDevice"),
    device_id: V2EntityId,
    ...AuthorizationDecisionResult,
  })
  .strict();
export type CanManageDeviceDecisionT = z.infer<typeof CanManageDeviceDecision>;

export const CanGrantRepositoryDecision = z
  .object({
    action: z.literal("canGrantRepository"),
    project_id: V2EntityId,
    repository_registration_id: V2EntityId,
    ...AuthorizationDecisionResult,
  })
  .strict();
export type CanGrantRepositoryDecisionT = z.infer<typeof CanGrantRepositoryDecision>;

export const CanAcceptProjectTargetDecision = z
  .object({
    action: z.literal("canAcceptProjectTarget"),
    project_id: V2EntityId,
    execution_target_id: V2EntityId,
    ...AuthorizationDecisionResult,
  })
  .strict();
export type CanAcceptProjectTargetDecisionT = z.infer<typeof CanAcceptProjectTargetDecision>;

export const CanDispatchDecision = z
  .object({
    action: z.literal("canDispatch"),
    project_id: V2EntityId,
    execution_target_id: V2EntityId,
    run_id: V2EntityId,
    ...AuthorizationDecisionResult,
  })
  .strict();
export type CanDispatchDecisionT = z.infer<typeof CanDispatchDecision>;

export const CanStopProjectRunDecision = z
  .object({
    action: z.literal("canStopProjectRun"),
    project_id: V2EntityId,
    run_id: V2EntityId,
    ...AuthorizationDecisionResult,
  })
  .strict();
export type CanStopProjectRunDecisionT = z.infer<typeof CanStopProjectRunDecision>;

export const CanEmergencyStopDeviceDecision = z
  .object({
    action: z.literal("canEmergencyStopDevice"),
    device_id: V2EntityId,
    ...AuthorizationDecisionResult,
  })
  .strict();
export type CanEmergencyStopDeviceDecisionT = z.infer<typeof CanEmergencyStopDeviceDecision>;

export const DeviceAuthorizationDecision = z.discriminatedUnion("action", [
  CanViewOwnedDeviceDecision,
  CanManageDeviceDecision,
  CanGrantRepositoryDecision,
  CanAcceptProjectTargetDecision,
  CanDispatchDecision,
  CanStopProjectRunDecision,
  CanEmergencyStopDeviceDecision,
]);
export type DeviceAuthorizationDecisionT = z.infer<typeof DeviceAuthorizationDecision>;

export const CancellationConfirmationState = z.enum([
  "cancellation_requested",
  "runner_acknowledged",
  "process_exited",
  "unconfirmed_offline",
]);
export type CancellationConfirmationStateT = z.infer<typeof CancellationConfirmationState>;

export const CancellationConfirmation = z
  .object({
    run_id: V2EntityId,
    state: CancellationConfirmationState,
    recorded_at: V2IsoDateTime,
  })
  .strict();
export type CancellationConfirmationT = z.infer<typeof CancellationConfirmation>;

export const DeviceAuthorizationPollOutcome = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("authorization_pending"),
      retry_after_seconds: PositivePollingIntervalSeconds,
    })
    .strict(),
  z
    .object({
      outcome: z.literal("slow_down"),
      retry_after_seconds: PositivePollingIntervalSeconds,
    })
    .strict(),
  z
    .object({
      outcome: z.literal("approved_pending_redemption"),
      authorization_request_id: V2EntityId,
    })
    .strict(),
  z
    .object({
      outcome: z.literal("active"),
      identity: AuthenticatedDeviceIdentity,
      generation: DeviceGeneration,
    })
    .strict(),
  z
    .object({
      outcome: z.literal("access_denied"),
    })
    .strict(),
  z
    .object({
      outcome: z.literal("expired_token"),
    })
    .strict(),
]);
export type DeviceAuthorizationPollOutcomeT = z.infer<typeof DeviceAuthorizationPollOutcome>;

export const DEVICE_CONTEXT_RETRIEVAL_HTTP_SIGNATURE_PURPOSE =
  "norns.runner-http.context-retrieval.v1" as const;
export const DEVICE_GATEWAY_CREDENTIAL_MINT_HTTP_SIGNATURE_PURPOSE =
  "norns.runner-http.gateway-credential-mint.v1" as const;
export const DEVICE_VISUAL_EVIDENCE_UPLOAD_HTTP_SIGNATURE_PURPOSE =
  "norns.runner-http.visual-evidence-upload.v1" as const;
export const DEVICE_WSS_AUTH_SIGNATURE_PURPOSE = "norns.runner-wss-auth.v1" as const;

const SignedDeviceHttpTranscriptFields = {
  device_id: V2EntityId,
  credential_id: V2EntityId,
  generation: DeviceGeneration,
  http_method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]),
  canonical_path_and_query: z
    .string()
    .regex(/^\/[^#\s]*$/, "must be an origin-relative path and canonical query"),
  body_sha256: V2Sha256Hex,
  timestamp: V2IsoDateTime,
  request_id: V2EntityId,
} as const;

export const SignedDeviceContextRetrievalHttpTranscript = z
  .object({
    purpose: z.literal(DEVICE_CONTEXT_RETRIEVAL_HTTP_SIGNATURE_PURPOSE),
    ...SignedDeviceHttpTranscriptFields,
  })
  .strict();
export type SignedDeviceContextRetrievalHttpTranscriptT = z.infer<
  typeof SignedDeviceContextRetrievalHttpTranscript
>;

export const SignedDeviceGatewayCredentialMintHttpTranscript = z
  .object({
    purpose: z.literal(DEVICE_GATEWAY_CREDENTIAL_MINT_HTTP_SIGNATURE_PURPOSE),
    ...SignedDeviceHttpTranscriptFields,
  })
  .strict();
export type SignedDeviceGatewayCredentialMintHttpTranscriptT = z.infer<
  typeof SignedDeviceGatewayCredentialMintHttpTranscript
>;

export const SignedDeviceVisualEvidenceUploadHttpTranscript = z
  .object({
    purpose: z.literal(DEVICE_VISUAL_EVIDENCE_UPLOAD_HTTP_SIGNATURE_PURPOSE),
    ...SignedDeviceHttpTranscriptFields,
  })
  .strict();
export type SignedDeviceVisualEvidenceUploadHttpTranscriptT = z.infer<
  typeof SignedDeviceVisualEvidenceUploadHttpTranscript
>;

export const SignedDeviceHttpTranscript = z.discriminatedUnion("purpose", [
  SignedDeviceContextRetrievalHttpTranscript,
  SignedDeviceGatewayCredentialMintHttpTranscript,
  SignedDeviceVisualEvidenceUploadHttpTranscript,
]);
export type SignedDeviceHttpTranscriptT = z.infer<typeof SignedDeviceHttpTranscript>;

export const SignedDeviceWssAuthenticationTranscript = z
  .object({
    purpose: z.literal(DEVICE_WSS_AUTH_SIGNATURE_PURPOSE),
    device_id: V2EntityId,
    credential_id: V2EntityId,
    generation: DeviceGeneration,
    protocol_version: V2NonEmptyString,
    challenge: V2NonEmptyString,
  })
  .strict();
export type SignedDeviceWssAuthenticationTranscriptT = z.infer<
  typeof SignedDeviceWssAuthenticationTranscript
>;
