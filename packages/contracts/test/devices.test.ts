import { describe, expect, it } from "vitest";

import {
  ActiveDeviceCredential,
  AuthenticatedDeviceIdentity,
  CancellationConfirmation,
  CancellationConfirmationState,
  DeviceAuthorizationDecision,
  DeviceAuthorizationLifecycle,
  DeviceAuthorizationPollOutcome,
  DeviceIdentity,
  DeviceLifecycleState,
  DeviceStatusDimensions,
  OwnedDeviceProjection,
  ProjectExecutionTargetProjection,
  SignedDeviceContextRetrievalHttpTranscript,
  SignedDeviceGatewayCredentialMintHttpTranscript,
  SignedDeviceHttpTranscript,
  SignedDeviceVisualEvidenceUploadHttpTranscript,
  SignedDeviceWssAuthenticationTranscript,
  canTransitionDeviceAuthorization,
} from "../src/index.js";

const now = "2026-07-29T12:00:00.000Z";
const later = "2026-07-29T12:10:00.000Z";
const fingerprint = "a".repeat(64);
const bodyHash = "b".repeat(64);

const activeCredential = {
  device_id: "device-1",
  credential_id: "credential-1",
  generation: 3,
  public_key_fingerprint: fingerprint,
  state: "active" as const,
  activated_at: now,
};

describe("device identity and lifecycle", () => {
  it("keeps stable device identity separate from authorization and presence", () => {
    expect(DeviceIdentity.parse({ device_id: "device-1" })).toEqual({
      device_id: "device-1",
    });
    expect(
      DeviceIdentity.safeParse({
        device_id: "device-1",
        owner_user_id: "user-1",
      }).success,
    ).toBe(false);
    expect(
      DeviceIdentity.safeParse({
        device_id: "device-1",
        generation: 3,
        public_key_fingerprint: fingerprint,
        online: true,
      }).success,
    ).toBe(false);

    expect(
      AuthenticatedDeviceIdentity.parse({
        device_id: "device-1",
        credential_id: "credential-1",
      }),
    ).toEqual({
      device_id: "device-1",
      credential_id: "credential-1",
    });
    expect(ActiveDeviceCredential.parse(activeCredential)).toEqual(activeCredential);
  });

  it("allows only the response-loss-safe authorization progression", () => {
    expect(canTransitionDeviceAuthorization("pending", "approved_pending_redemption")).toBe(true);
    expect(canTransitionDeviceAuthorization("approved_pending_redemption", "active")).toBe(true);
    expect(canTransitionDeviceAuthorization("pending", "active")).toBe(false);
    expect(canTransitionDeviceAuthorization("denied", "pending")).toBe(false);
    expect(canTransitionDeviceAuthorization("expired", "active")).toBe(false);

    expect(
      DeviceAuthorizationLifecycle.parse({
        authorization_request_id: "authorization-1",
        state: "approved_pending_redemption",
        created_at: now,
        expires_at: later,
        approved_at: now,
        redeemed_at: null,
        terminal_at: null,
      }).state,
    ).toBe("approved_pending_redemption");

    expect(
      DeviceAuthorizationLifecycle.safeParse({
        authorization_request_id: "authorization-1",
        state: "active",
        created_at: now,
        expires_at: later,
        approved_at: now,
        redeemed_at: null,
        terminal_at: null,
      }).success,
    ).toBe(false);
  });

  it("does not treat availability, compatibility, or workload as lifecycle", () => {
    expect(DeviceLifecycleState.parse("active")).toBe("active");
    expect(DeviceLifecycleState.parse("revoked")).toBe("revoked");
    expect(DeviceLifecycleState.safeParse("online").success).toBe(false);
    expect(DeviceLifecycleState.safeParse("busy").success).toBe(false);
    expect(DeviceLifecycleState.safeParse("update_required").success).toBe(false);
  });
});

describe("device projections", () => {
  it("keeps all four UI status dimensions independent", () => {
    expect(
      DeviceStatusDimensions.parse({
        availability: "online",
        compatibility: "limited",
        workload: "busy",
        access: "shared",
      }),
    ).toEqual({
      availability: "online",
      compatibility: "limited",
      workload: "busy",
      access: "shared",
    });
  });

  it("accepts full details only as an owned-device projection", () => {
    const ownedDevice = {
      device_id: "device-1",
      owner_user_id: "user-1",
      name: "Office Mac mini",
      location_label: "Office",
      os_family: "macos" as const,
      os_version: "15.5",
      lifecycle: "active" as const,
      status: {
        availability: "online" as const,
        compatibility: "ready" as const,
        workload: "idle" as const,
        access: "owned" as const,
      },
      last_seen_at: now,
      active_credential: activeCredential,
      agent: {
        version: "1.7.0",
        protocol_version: "3",
        capabilities: ["execution", "visual_evidence"],
      },
      repository_grants: [
        {
          grant_id: "grant-1",
          project_id: "project-1",
          repository_registration_id: "registration-1",
          state: "active" as const,
        },
      ],
      activity: {
        active_run_count: 0,
        queued_command_count: 0,
      },
    };

    expect(OwnedDeviceProjection.parse(ownedDevice)).toEqual(ownedDevice);

    const revokedDevice = {
      ...ownedDevice,
      lifecycle: "revoked" as const,
      status: {
        ...ownedDevice.status,
        availability: "offline" as const,
        access: "revoked" as const,
      },
      active_credential: null,
    };
    expect(OwnedDeviceProjection.parse(revokedDevice)).toEqual(revokedDevice);

    expect(
      OwnedDeviceProjection.safeParse({
        ...ownedDevice,
        status: { ...ownedDevice.status, access: "shared" },
      }).success,
    ).toBe(false);
    expect(
      OwnedDeviceProjection.safeParse({
        ...ownedDevice,
        lifecycle: "revoked",
        status: { ...ownedDevice.status, access: "revoked" },
      }).success,
    ).toBe(false);
    expect(
      OwnedDeviceProjection.safeParse({
        ...ownedDevice,
        active_credential: null,
      }).success,
    ).toBe(false);
    expect(
      OwnedDeviceProjection.safeParse({
        ...revokedDevice,
        status: { ...revokedDevice.status, access: "owned" },
      }).success,
    ).toBe(false);
  });

  it("rejects sensitive or unrelated fields in project execution targets", () => {
    const target = {
      project_id: "project-1",
      execution_target_id: "target-1",
      name: "Office Mac mini",
      location_label: "Office",
      os_family: "macos" as const,
      status: {
        availability: "online" as const,
        compatibility: "ready" as const,
        workload: "idle" as const,
        access: "shared" as const,
      },
      last_seen_at: now,
    };
    expect(ProjectExecutionTargetProjection.parse(target)).toEqual(target);

    const forbiddenFields = {
      public_key_fingerprint: fingerprint,
      version: "1.7.0",
      capabilities: ["execution"],
      grants: ["grant-1"],
      activity: { current_run_id: "run-1" },
      active_task_count: 1,
      repository_count: 2,
    };
    for (const [key, value] of Object.entries(forbiddenFields)) {
      expect(
        ProjectExecutionTargetProjection.safeParse({ ...target, [key]: value }).success,
        key,
      ).toBe(false);
    }
  });
});

describe("action-specific authorization", () => {
  it("models all seven decisions as distinct typed actions", () => {
    const decisions = [
      {
        action: "canViewOwnedDevice",
        device_id: "device-1",
        allowed: true,
        reason_code: null,
      },
      {
        action: "canManageDevice",
        device_id: "device-1",
        allowed: true,
        reason_code: null,
      },
      {
        action: "canGrantRepository",
        project_id: "project-1",
        repository_registration_id: "registration-1",
        allowed: false,
        reason_code: "missing_active_membership",
      },
      {
        action: "canAcceptProjectTarget",
        project_id: "project-1",
        execution_target_id: "target-1",
        allowed: true,
        reason_code: null,
      },
      {
        action: "canDispatch",
        project_id: "project-1",
        execution_target_id: "target-1",
        run_id: "run-1",
        allowed: true,
        reason_code: null,
      },
      {
        action: "canStopProjectRun",
        project_id: "project-1",
        run_id: "run-1",
        allowed: false,
        reason_code: "not_project_owner",
      },
      {
        action: "canEmergencyStopDevice",
        device_id: "device-1",
        allowed: true,
        reason_code: null,
      },
    ];

    for (const decision of decisions) {
      expect(DeviceAuthorizationDecision.safeParse(decision).success, decision.action).toBe(true);
    }

    expect(
      DeviceAuthorizationDecision.safeParse({
        action: "isAllowed",
        allowed: true,
        reason_code: null,
      }).success,
    ).toBe(false);
  });
});

describe("cancellation and enrollment polling", () => {
  it("keeps all four cancellation confirmation states observable", () => {
    const states = [
      "cancellation_requested",
      "runner_acknowledged",
      "process_exited",
      "unconfirmed_offline",
    ] as const;

    for (const state of states) {
      expect(CancellationConfirmationState.parse(state)).toBe(state);
      expect(
        CancellationConfirmation.parse({
          run_id: "run-1",
          state,
          recorded_at: now,
        }).state,
      ).toBe(state);
    }
  });

  it("supports RFC 8628 polling outcomes, including slow_down", () => {
    const outcomes = [
      { outcome: "authorization_pending", retry_after_seconds: 5 },
      { outcome: "slow_down", retry_after_seconds: 10 },
      {
        outcome: "approved_pending_redemption",
        authorization_request_id: "authorization-1",
      },
      {
        outcome: "active",
        identity: { device_id: "device-1", credential_id: "credential-1" },
        generation: 3,
      },
      { outcome: "access_denied" },
      { outcome: "expired_token" },
    ];

    for (const outcome of outcomes) {
      expect(DeviceAuthorizationPollOutcome.safeParse(outcome).success, outcome.outcome).toBe(true);
    }
    expect(DeviceAuthorizationPollOutcome.safeParse({ outcome: "slow_down" }).success).toBe(false);
    expect(DeviceAuthorizationPollOutcome.safeParse({ outcome: "expired" }).success).toBe(false);
  });
});

describe("signed transport transcripts", () => {
  it("binds HTTP purpose, identity, generation, request, body, and canonical target", () => {
    const transcript = {
      purpose: "norns.runner-http.context-retrieval.v1" as const,
      device_id: "device-1",
      credential_id: "credential-1",
      generation: 3,
      http_method: "POST" as const,
      canonical_path_and_query: "/api/runner/context?project_id=project-1",
      body_sha256: bodyHash,
      timestamp: now,
      request_id: "request-1",
    };
    expect(SignedDeviceHttpTranscript.parse(transcript)).toEqual(transcript);
    expect(SignedDeviceContextRetrievalHttpTranscript.parse(transcript)).toEqual(transcript);
    expect(
      SignedDeviceGatewayCredentialMintHttpTranscript.parse({
        ...transcript,
        purpose: "norns.runner-http.gateway-credential-mint.v1",
      }).purpose,
    ).toBe("norns.runner-http.gateway-credential-mint.v1");
    expect(
      SignedDeviceVisualEvidenceUploadHttpTranscript.parse({
        ...transcript,
        purpose: "norns.runner-http.visual-evidence-upload.v1",
      }).purpose,
    ).toBe("norns.runner-http.visual-evidence-upload.v1");
    expect(
      SignedDeviceHttpTranscript.safeParse({
        ...transcript,
        canonical_path_and_query: "https://example.com/api/runner/context",
      }).success,
    ).toBe(false);
    expect(
      SignedDeviceHttpTranscript.safeParse({
        ...transcript,
        body_sha256: undefined,
      }).success,
    ).toBe(false);
    expect(
      SignedDeviceHttpTranscript.safeParse({
        ...transcript,
        purpose: "norns.runner-http.v1",
      }).success,
    ).toBe(false);
    expect(SignedDeviceGatewayCredentialMintHttpTranscript.safeParse(transcript).success).toBe(
      false,
    );
    expect(
      SignedDeviceVisualEvidenceUploadHttpTranscript.safeParse({
        ...transcript,
        purpose: "norns.runner-http.gateway-credential-mint.v1",
      }).success,
    ).toBe(false);
  });

  it("requires a domain-separated WSS transcript instead of a bare nonce", () => {
    const transcript = {
      purpose: "norns.runner-wss-auth.v1" as const,
      device_id: "device-1",
      credential_id: "credential-1",
      generation: 3,
      protocol_version: "3",
      challenge: "server-challenge",
    };
    expect(SignedDeviceWssAuthenticationTranscript.parse(transcript)).toEqual(transcript);
    expect(
      SignedDeviceWssAuthenticationTranscript.safeParse({
        challenge: "server-challenge",
      }).success,
    ).toBe(false);
    expect(
      SignedDeviceWssAuthenticationTranscript.safeParse({
        ...transcript,
        purpose: "norns.runner-http.v1",
      }).success,
    ).toBe(false);
  });
});
