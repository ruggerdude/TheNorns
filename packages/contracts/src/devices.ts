import { z } from "zod";

import {
  V2EntityId,
  V2GitCommitSha,
  V2IsoDateTime,
  V2NonEmptyString,
  V2Sha256Hex,
} from "./v2/common.js";

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

/**
 * An accepted project target is authorized through a project grant. Its
 * access label is project-relative and therefore identical for every member
 * receiving the same projection.
 */
export const ProjectExecutionTargetStatusDimensions = z
  .object({
    availability: DeviceAvailability,
    compatibility: DeviceCompatibility,
    workload: DeviceWorkload,
    access: z.union([z.literal("shared"), z.literal("pending")]),
  })
  .strict();
export type ProjectExecutionTargetStatusDimensionsT = z.infer<
  typeof ProjectExecutionTargetStatusDimensions
>;

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
    status: ProjectExecutionTargetStatusDimensions,
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
export const DEVICE_REPOSITORY_REGISTRATION_HTTP_SIGNATURE_PURPOSE =
  "norns.runner-http.repository-registration.v1" as const;
export const DEVICE_REPOSITORY_REGISTRATION_REVOCATION_HTTP_SIGNATURE_PURPOSE =
  "norns.runner-http.repository-registration-revocation.v1" as const;
export const DEVICE_PUBLICATION_PERMIT_ISSUE_HTTP_SIGNATURE_PURPOSE =
  "norns.runner-http.publication-permit-issue.v1" as const;
export const DEVICE_PUBLICATION_PERMIT_CONSUME_HTTP_SIGNATURE_PURPOSE =
  "norns.runner-http.publication-permit-consume.v1" as const;
export const DEVICE_PUBLICATION_PERMIT_PURPOSE = "norns.device-publication-permit.v1" as const;
export const DEVICE_WSS_AUTH_SIGNATURE_PURPOSE = "norns.runner-wss-auth.v1" as const;
export const DEVICE_WSS_PROTOCOL_VERSION = "1" as const;

export const DeviceRepositoryRegistrationRequest = z
  .object({
    workspace_id: V2EntityId,
    repository_id: V2EntityId,
    repository_display_name: z.string().trim().min(1).max(240),
    default_branch: z.string().trim().min(1).max(240),
    observed_head: V2GitCommitSha,
  })
  .strict();
export type DeviceRepositoryRegistrationRequestT = z.infer<
  typeof DeviceRepositoryRegistrationRequest
>;

export const DeviceRepositoryRegistrationResponse = z
  .object({
    registration_id: V2EntityId,
    status: z.literal("active"),
    workspace_id: V2EntityId,
    repository_id: V2EntityId,
  })
  .strict();
export type DeviceRepositoryRegistrationResponseT = z.infer<
  typeof DeviceRepositoryRegistrationResponse
>;

export const DeviceRepositoryRegistrationRevocationRequest = z
  .object({
    workspace_id: V2EntityId,
    repository_id: V2EntityId,
  })
  .strict();
export type DeviceRepositoryRegistrationRevocationRequestT = z.infer<
  typeof DeviceRepositoryRegistrationRevocationRequest
>;

export const DeviceRepositoryRegistrationRevocationResponse = z
  .object({
    registration_id: V2EntityId,
    status: z.literal("revoked"),
  })
  .strict();
export type DeviceRepositoryRegistrationRevocationResponseT = z.infer<
  typeof DeviceRepositoryRegistrationRevocationResponse
>;

export const DevicePublicationPermitIssueRequest = z
  .object({
    run_id: V2EntityId,
    repository_registration_id: V2EntityId,
    project_device_repository_grant_id: V2EntityId,
    repository_binding_id: V2EntityId,
    repository_id: V2EntityId,
    branch: z.string().trim().min(1).max(240),
    commit_sha: V2GitCommitSha,
  })
  .strict();
export type DevicePublicationPermitIssueRequestT = z.infer<
  typeof DevicePublicationPermitIssueRequest
>;

export const DevicePublicationPermitClaims = DevicePublicationPermitIssueRequest.extend({
  purpose: z.literal(DEVICE_PUBLICATION_PERMIT_PURPOSE),
  permit_id: V2EntityId,
  device_id: V2EntityId,
  credential_id: V2EntityId,
  generation: DeviceGeneration,
  issued_at: V2IsoDateTime,
  expires_at: V2IsoDateTime,
}).strict();
export type DevicePublicationPermitClaimsT = z.infer<typeof DevicePublicationPermitClaims>;

const SignedDevicePublicationPermitFields = {
  permit: DevicePublicationPermitClaims,
  key_id: V2EntityId,
  // An Ed25519 signature is exactly 64 bytes. Its canonical RFC 4648 base64
  // encoding is 88 characters, ends in `==`, and has zero unused low bits in
  // the final data character (whose alphabet index is therefore a multiple of
  // sixteen).
  signature_base64: z
    .string()
    .regex(
      /^[A-Za-z0-9+/]{85}[AQgw]==$/,
      "must be canonical base64 for an exact 64-byte Ed25519 signature",
    ),
} as const;

export const SignedDevicePublicationPermit = z.object(SignedDevicePublicationPermitFields).strict();
export type SignedDevicePublicationPermitT = z.infer<typeof SignedDevicePublicationPermit>;

export const DevicePublicationPermitConsumeRequest = z
  .object(SignedDevicePublicationPermitFields)
  .strict();
export type DevicePublicationPermitConsumeRequestT = z.infer<
  typeof DevicePublicationPermitConsumeRequest
>;

export const DevicePublicationPermitConsumeResponse = z
  .object({
    outcome: z.literal("authorized"),
    permit_id: V2EntityId,
    consumed_at: V2IsoDateTime,
  })
  .strict();
export type DevicePublicationPermitConsumeResponseT = z.infer<
  typeof DevicePublicationPermitConsumeResponse
>;

const SignedDeviceHttpTranscriptFields = {
  device_id: V2EntityId,
  credential_id: V2EntityId,
  generation: DeviceGeneration,
  http_method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]),
  canonical_path_and_query: z
    .string()
    .regex(/^\/[^#\s]*$/, "must be an origin-relative path and canonical query")
    .refine((value) => {
      try {
        return canonicalizeDeviceHttpPathAndQuery(value) === value;
      } catch {
        return false;
      }
    }, "must use the canonical device HTTP path and query encoding"),
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

export const SignedDeviceRepositoryRegistrationHttpTranscript = z
  .object({
    purpose: z.literal(DEVICE_REPOSITORY_REGISTRATION_HTTP_SIGNATURE_PURPOSE),
    ...SignedDeviceHttpTranscriptFields,
  })
  .strict();
export type SignedDeviceRepositoryRegistrationHttpTranscriptT = z.infer<
  typeof SignedDeviceRepositoryRegistrationHttpTranscript
>;

export const SignedDeviceRepositoryRegistrationRevocationHttpTranscript = z
  .object({
    purpose: z.literal(DEVICE_REPOSITORY_REGISTRATION_REVOCATION_HTTP_SIGNATURE_PURPOSE),
    ...SignedDeviceHttpTranscriptFields,
  })
  .strict();
export type SignedDeviceRepositoryRegistrationRevocationHttpTranscriptT = z.infer<
  typeof SignedDeviceRepositoryRegistrationRevocationHttpTranscript
>;

export const SignedDevicePublicationPermitIssueHttpTranscript = z
  .object({
    purpose: z.literal(DEVICE_PUBLICATION_PERMIT_ISSUE_HTTP_SIGNATURE_PURPOSE),
    ...SignedDeviceHttpTranscriptFields,
  })
  .strict();
export type SignedDevicePublicationPermitIssueHttpTranscriptT = z.infer<
  typeof SignedDevicePublicationPermitIssueHttpTranscript
>;

export const SignedDevicePublicationPermitConsumeHttpTranscript = z
  .object({
    purpose: z.literal(DEVICE_PUBLICATION_PERMIT_CONSUME_HTTP_SIGNATURE_PURPOSE),
    ...SignedDeviceHttpTranscriptFields,
  })
  .strict();
export type SignedDevicePublicationPermitConsumeHttpTranscriptT = z.infer<
  typeof SignedDevicePublicationPermitConsumeHttpTranscript
>;

export const SignedDeviceHttpTranscript = z.discriminatedUnion("purpose", [
  SignedDeviceContextRetrievalHttpTranscript,
  SignedDeviceGatewayCredentialMintHttpTranscript,
  SignedDeviceVisualEvidenceUploadHttpTranscript,
  SignedDeviceRepositoryRegistrationHttpTranscript,
  SignedDeviceRepositoryRegistrationRevocationHttpTranscript,
  SignedDevicePublicationPermitIssueHttpTranscript,
  SignedDevicePublicationPermitConsumeHttpTranscript,
]);
export type SignedDeviceHttpTranscriptT = z.infer<typeof SignedDeviceHttpTranscript>;

export type DeviceHttpSignaturePurposeT = SignedDeviceHttpTranscriptT["purpose"];

/**
 * Compatibility-only credential label for a pre-device runner generation.
 * In this mode the transcript's device_id slot carries the legacy runner id;
 * the distinct wire scheme prevents confusing that alias with device identity.
 */
export function legacyRunnerHttpCredentialId(runnerId: string, generation: number): string {
  if (!runnerId.trim() || !Number.isSafeInteger(generation) || generation <= 0) {
    throw new Error("legacy runner HTTP identity is invalid");
  }
  return `legacy-runner:${runnerId}:generation:${generation}`;
}

const RFC3986_UNRESERVED_BYTE = /^[A-Za-z0-9\-._~]$/;
const RFC3986_RAW_PATH_ASCII = /^[A-Za-z0-9\-._~!$&'()*+,;=:@/]$/;
const HEX_BYTE = /^[0-9A-Fa-f]{2}$/;

function percentEncodedByte(byte: number): string {
  return `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x1f || codeUnit === 0x7f) return true;
  }
  return false;
}

function utf8Bytes(value: string): number[] {
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    let codePoint = codeUnit;
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const following = value.charCodeAt(index + 1);
      if (!(following >= 0xdc00 && following <= 0xdfff)) {
        throw new Error("device HTTP signature target contains malformed UTF-16");
      }
      codePoint = 0x10000 + ((codeUnit - 0xd800) << 10) + (following - 0xdc00);
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new Error("device HTTP signature target contains malformed UTF-16");
    }
    if (codePoint <= 0x7f) {
      bytes.push(codePoint);
    } else if (codePoint <= 0x7ff) {
      bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint <= 0xffff) {
      bytes.push(
        0xe0 | (codePoint >> 12),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    } else {
      bytes.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }
  return bytes;
}

function decodeUtf8Strict(bytes: readonly number[]): string {
  let decoded = "";
  for (let index = 0; index < bytes.length; ) {
    const first = bytes[index] as number;
    let codePoint: number;
    let continuationCount: number;
    if (first <= 0x7f) {
      codePoint = first;
      continuationCount = 0;
    } else if (first >= 0xc2 && first <= 0xdf) {
      codePoint = first & 0x1f;
      continuationCount = 1;
    } else if (first >= 0xe0 && first <= 0xef) {
      codePoint = first & 0x0f;
      continuationCount = 2;
    } else if (first >= 0xf0 && first <= 0xf4) {
      codePoint = first & 0x07;
      continuationCount = 3;
    } else {
      throw new Error("device HTTP signature target contains malformed UTF-8");
    }
    if (index + continuationCount >= bytes.length) {
      throw new Error("device HTTP signature target contains truncated UTF-8");
    }
    for (let offset = 1; offset <= continuationCount; offset += 1) {
      const continuation = bytes[index + offset] as number;
      if (continuation < 0x80 || continuation > 0xbf) {
        throw new Error("device HTTP signature target contains malformed UTF-8");
      }
      codePoint = (codePoint << 6) | (continuation & 0x3f);
    }
    if (
      (continuationCount === 2 && codePoint < 0x800) ||
      (continuationCount === 3 && codePoint < 0x10000) ||
      codePoint > 0x10ffff ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff)
    ) {
      throw new Error("device HTTP signature target contains non-scalar UTF-8");
    }
    decoded += String.fromCodePoint(codePoint);
    index += continuationCount + 1;
  }
  return decoded;
}

/**
 * Decode one URI component to Unicode with strict percent and UTF-8 handling.
 * `+` is deliberately just another byte; form-url-encoding is not used here.
 */
function decodeUriComponentStrict(value: string): string {
  const bytes: number[] = [];
  for (let index = 0; index < value.length; ) {
    if (value[index] === "%") {
      const hexadecimal = value.slice(index + 1, index + 3);
      if (!HEX_BYTE.test(hexadecimal)) {
        throw new Error("device HTTP signature target contains an invalid percent escape");
      }
      bytes.push(Number.parseInt(hexadecimal, 16));
      index += 3;
      continue;
    }
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
      throw new Error("device HTTP signature target contains malformed Unicode");
    }
    const character = String.fromCodePoint(codePoint);
    bytes.push(...utf8Bytes(character));
    index += character.length;
  }
  const decoded = decodeUtf8Strict(bytes);
  if (containsControlCharacter(decoded)) {
    throw new Error("device HTTP signature target contains a control character");
  }
  return decoded;
}

function encodeQueryComponent(value: string): string {
  let encoded = "";
  for (const byte of utf8Bytes(value)) {
    const character = String.fromCharCode(byte);
    encoded += RFC3986_UNRESERVED_BYTE.test(character) ? character : percentEncodedByte(byte);
  }
  return encoded;
}

function canonicalizePath(rawPath: string): string {
  const decodedPath = decodeUriComponentStrict(rawPath);
  if (rawPath.includes("\\")) {
    throw new Error("device HTTP signature target contains a raw backslash");
  }

  let encodedPath = "";
  for (let index = 0; index < rawPath.length; ) {
    if (rawPath[index] === "%") {
      const hexadecimal = rawPath.slice(index + 1, index + 3);
      if (!HEX_BYTE.test(hexadecimal)) {
        throw new Error("device HTTP signature target contains an invalid percent escape");
      }
      const byte = Number.parseInt(hexadecimal, 16);
      const character = String.fromCharCode(byte);
      encodedPath += RFC3986_UNRESERVED_BYTE.test(character) ? character : percentEncodedByte(byte);
      index += 3;
      continue;
    }

    const codePoint = rawPath.codePointAt(index);
    if (codePoint === undefined || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
      throw new Error("device HTTP signature target contains malformed Unicode");
    }
    const character = String.fromCodePoint(codePoint);
    if (codePoint <= 0x7f && RFC3986_RAW_PATH_ASCII.test(character)) {
      encodedPath += character;
    } else {
      for (const byte of utf8Bytes(character)) encodedPath += percentEncodedByte(byte);
    }
    index += character.length;
  }

  // Decoding percent-encoded unreserved octets above makes encoded dot
  // segments visible before RFC 3986 section 5.2.4 removal.
  let input = encodedPath;
  let output = "";
  while (input.length > 0) {
    if (input.startsWith("../")) {
      input = input.slice(3);
    } else if (input.startsWith("./")) {
      input = input.slice(2);
    } else if (input.startsWith("/./")) {
      input = input.slice(2);
    } else if (input === "/.") {
      input = "/";
    } else if (input.startsWith("/../")) {
      input = input.slice(3);
      output = output.replace(/\/?[^/]*$/, "");
    } else if (input === "/..") {
      input = "/";
      output = output.replace(/\/?[^/]*$/, "");
    } else if (input === "." || input === "..") {
      input = "";
    } else {
      const nextSlash = input.indexOf("/", input.startsWith("/") ? 1 : 0);
      const segmentEnd = nextSlash === -1 ? input.length : nextSlash;
      output += input.slice(0, segmentEnd);
      input = input.slice(segmentEnd);
    }
  }

  // `decodedPath` is intentionally retained as a strict validation step for
  // the combined raw and percent-encoded octet stream.
  void decodedPath;
  return output || "/";
}

/**
 * ADR-009 §7 canonical origin-form request target. This deliberately does not
 * use URLSearchParams: form decoding would turn `+` into space, preserve
 * duplicate names, and conceal empty pairs.
 */
export function canonicalizeDeviceHttpPathAndQuery(pathAndQuery: string): string {
  if (
    typeof pathAndQuery !== "string" ||
    pathAndQuery.includes("#") ||
    pathAndQuery.includes("\\") ||
    containsControlCharacter(pathAndQuery)
  ) {
    throw new Error("device HTTP signature target is not a valid origin-form target");
  }

  const queryStart = pathAndQuery.indexOf("?");
  const suppliedPath = queryStart === -1 ? pathAndQuery : pathAndQuery.slice(0, queryStart);
  const rawQuery = queryStart === -1 ? null : pathAndQuery.slice(queryStart + 1);
  if ((suppliedPath !== "" && !suppliedPath.startsWith("/")) || suppliedPath.startsWith("//")) {
    throw new Error("device HTTP signature target must use origin form");
  }
  const path = canonicalizePath(suppliedPath || "/");
  if (rawQuery === null || rawQuery === "") return path;
  if (rawQuery.includes(";")) {
    throw new Error("device HTTP signature query cannot use semicolon separators");
  }

  const seenNames = new Set<string>();
  const pairs = rawQuery.split("&").map((rawPair) => {
    if (rawPair.length === 0) {
      throw new Error("device HTTP signature query contains an empty pair");
    }
    const equals = rawPair.indexOf("=");
    const rawName = equals === -1 ? rawPair : rawPair.slice(0, equals);
    const rawValue = equals === -1 ? "" : rawPair.slice(equals + 1);
    const name = decodeUriComponentStrict(rawName);
    const value = decodeUriComponentStrict(rawValue);
    if (name.length === 0) {
      throw new Error("device HTTP signature query contains an empty name");
    }
    if (seenNames.has(name)) {
      throw new Error("device HTTP signature query contains a duplicate decoded name");
    }
    seenNames.add(name);
    return {
      name: encodeQueryComponent(name),
      value: encodeQueryComponent(value),
    };
  });

  pairs.sort((left, right) => {
    const byName = left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
    if (byName !== 0) return byName;
    return left.value < right.value ? -1 : left.value > right.value ? 1 : 0;
  });
  return `${path}?${pairs.map((pair) => `${pair.name}=${pair.value}`).join("&")}`;
}

/**
 * Fixed-key JSON is the byte-level transcript contract. It contains exactly
 * the nine specified fields, with `purpose` providing endpoint domain
 * separation.
 */
export function serializeSignedDeviceHttpTranscript(input: SignedDeviceHttpTranscriptT): string {
  const transcript = SignedDeviceHttpTranscript.parse(input);
  return JSON.stringify({
    purpose: transcript.purpose,
    device_id: transcript.device_id,
    credential_id: transcript.credential_id,
    generation: transcript.generation,
    http_method: transcript.http_method,
    canonical_path_and_query: transcript.canonical_path_and_query,
    body_sha256: transcript.body_sha256,
    timestamp: transcript.timestamp,
    request_id: transcript.request_id,
  });
}

/** Fixed-order bytes signed by the server for a one-use publication permit. */
export function serializeDevicePublicationPermitClaims(
  input: DevicePublicationPermitClaimsT,
): string {
  const permit = DevicePublicationPermitClaims.parse(input);
  return JSON.stringify({
    purpose: permit.purpose,
    permit_id: permit.permit_id,
    run_id: permit.run_id,
    device_id: permit.device_id,
    credential_id: permit.credential_id,
    generation: permit.generation,
    repository_registration_id: permit.repository_registration_id,
    project_device_repository_grant_id: permit.project_device_repository_grant_id,
    repository_binding_id: permit.repository_binding_id,
    repository_id: permit.repository_id,
    branch: permit.branch,
    commit_sha: permit.commit_sha,
    issued_at: permit.issued_at,
    expires_at: permit.expires_at,
  });
}

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

/**
 * Fixed-order JSON is the canonical byte transcript shared by the Local Agent
 * and relay. The schema is parsed first so aliases, unknown fields, and
 * non-canonical value types can never change what one side believes it signed.
 */
export function canonicalDeviceWssAuthenticationTranscript(
  input: SignedDeviceWssAuthenticationTranscriptT,
): string {
  const transcript = SignedDeviceWssAuthenticationTranscript.parse(input);
  return JSON.stringify({
    purpose: transcript.purpose,
    device_id: transcript.device_id,
    credential_id: transcript.credential_id,
    generation: transcript.generation,
    protocol_version: transcript.protocol_version,
    challenge: transcript.challenge,
  });
}
