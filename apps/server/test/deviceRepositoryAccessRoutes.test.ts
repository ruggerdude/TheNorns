import { type KeyObject, createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  DEVICE_PUBLICATION_PERMIT_CONSUME_HTTP_SIGNATURE_PURPOSE,
  DEVICE_PUBLICATION_PERMIT_ISSUE_HTTP_SIGNATURE_PURPOSE,
  DEVICE_PUBLICATION_PERMIT_PURPOSE,
  DEVICE_REPOSITORY_REGISTRATION_HTTP_SIGNATURE_PURPOSE,
  DEVICE_REPOSITORY_REGISTRATION_REVOCATION_HTTP_SIGNATURE_PURPOSE,
  type DeviceHttpSignaturePurposeT,
  serializeSignedDeviceHttpTranscript,
} from "@norns/contracts";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerDeviceRepositoryAccessRoutes } from "../src/devices/index.js";
import { DeviceHttpRequestAuthenticator } from "../src/execution/deviceHttpAuth.js";

describe("Phase 4 repository access routes", () => {
  const identity = { device_id: "device-1", credential_id: "credential-1", generation: 1 };
  const now = "2026-07-30T12:00:00.000Z";
  const permit = {
    purpose: DEVICE_PUBLICATION_PERMIT_PURPOSE,
    permit_id: "permit-1",
    run_id: "run-1",
    ...identity,
    repository_registration_id: "registration-1",
    project_device_repository_grant_id: "grant-1",
    repository_binding_id: "binding-1",
    repository_id: "repository-1",
    branch: "norns/task-1",
    commit_sha: "a".repeat(40),
    issued_at: now,
    expires_at: "2026-07-30T12:00:30.000Z",
  } as const;
  const signatureBase64 = `${"A".repeat(86)}==`;
  let privateKey: KeyObject;
  let app: ReturnType<typeof Fastify>;
  let replayIds: Set<string>;
  let service: Record<string, ReturnType<typeof vi.fn>>;
  let publicationPermits: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(async () => {
    const pair = generateKeyPairSync("ed25519");
    replayIds = new Set();
    const authenticator = new DeviceHttpRequestAuthenticator({
      repository: {
        activeCredential: async () => ({
          public_key_spki_der: pair.publicKey.export({ format: "der", type: "spki" }),
        }),
        consumeRequestId: async (request) => {
          if (replayIds.has(request.request_id)) return "replayed";
          replayIds.add(request.request_id);
          return "consumed";
        },
        consumeLegacyRequestId: async () => "replayed",
      },
      legacyCompatibility: { enabled: false },
      now: () => new Date(now),
    });
    privateKey = pair.privateKey;
    service = {
      getOwnedRepositoryAccess: vi.fn(async () => ({
        device_id: "device-1",
        registrations: [
          {
            registration_id: "registration-1",
            repository_id: "repository-1",
            repository_display_name: "Norns",
            default_branch: "main",
            state: "active",
            grants: [{ grant_id: "grant-1", project_id: "project-1", state: "active" }],
          },
        ],
        eligible_projects: [{ project_id: "project-1", name: "Project One" }],
      })),
      grantRepository: vi.fn(async () => undefined),
      revokeRepositoryGrant: vi.fn(async () => undefined),
      listProjectExecutionTargets: vi.fn(async () => ({
        project_id: "project-1",
        selected_execution_target_id: null,
        work_active: false,
        execution_targets: [],
      })),
      selectProjectExecutionTarget: vi.fn(async () => ({
        project_id: "project-1",
        selected_execution_target_id: "grant-1",
        work_active: false,
        execution_targets: [],
      })),
      registerRepository: vi.fn(async (input) => ({
        registration_id: "registration-1",
        ...input,
        state: "active",
      })),
      removeRepositoryAccess: vi.fn(async () => ({
        registration_id: "registration-1",
        state: "revoked",
      })),
    };
    publicationPermits = {
      issue: vi.fn(async () => ({
        permit,
        key_id: "publication-key-1",
        signature_base64: signatureBase64,
      })),
      consume: vi.fn(async () => ({
        outcome: "authorized",
        permit_id: "permit-1",
        consumed_at: now,
      })),
    };
    app = Fastify();
    await registerDeviceRepositoryAccessRoutes(app, {
      service: service as never,
      publicationPermits: publicationPermits as never,
      runnerAuthentication: authenticator,
      requireUser: async (request, reply) => {
        const user = request.headers["x-test-user"];
        if (typeof user !== "string") {
          reply.code(401).send({ error: "unauthorized" });
          return null;
        }
        return { id: user };
      },
    });
  });

  afterEach(async () => {
    await app?.close();
  });

  function signedRequest(
    purpose: DeviceHttpSignaturePurposeT,
    path: string,
    body: unknown,
    requestId: string,
    signedBody: unknown = body,
  ) {
    const payload = JSON.stringify(body);
    const signedPayload = JSON.stringify(signedBody);
    const transcript = serializeSignedDeviceHttpTranscript({
      purpose,
      ...identity,
      http_method: "POST",
      canonical_path_and_query: path,
      body_sha256: createHash("sha256").update(signedPayload).digest("hex"),
      timestamp: now,
      request_id: requestId,
    });
    const signature = sign(null, Buffer.from(transcript), privateKey).toString("base64");
    return {
      method: "POST" as const,
      url: path,
      payload,
      headers: {
        "content-type": "application/json",
        authorization: `Norns-Device ${signature}`,
        "x-norns-device-id": identity.device_id,
        "x-norns-credential-id": identity.credential_id,
        "x-norns-device-generation": String(identity.generation),
        "x-norns-timestamp": now,
        "x-norns-request-id": requestId,
      },
    };
  }

  it("returns only the strict owner repository-access envelope", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/devices/device-1/repository-access",
      headers: { "x-test-user": "device-owner" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      device_id: "device-1",
      registrations: [
        {
          registration_id: "registration-1",
          repository_id: "repository-1",
          repository_display_name: "Norns",
          default_branch: "main",
          state: "active",
          grants: [{ grant_id: "grant-1", project_id: "project-1", state: "active" }],
        },
      ],
      eligible_projects: [{ project_id: "project-1", name: "Project One" }],
    });
  });

  it("keeps grant management owner-scoped and target selection grant-ID based", async () => {
    const grant = await app.inject({
      method: "POST",
      url: "/api/devices/device-1/repository-grants",
      headers: { "x-test-user": "device-owner" },
      payload: { repository_registration_id: "registration-1", project_id: "project-1" },
    });
    expect(grant.statusCode).toBe(200);
    expect(service.grantRepository).toHaveBeenCalledWith({
      actor_user_id: "device-owner",
      project_id: "project-1",
      repository_registration_id: "registration-1",
    });

    const revoke = await app.inject({
      method: "POST",
      url: "/api/devices/device-1/repository-grants/grant-1/revoke",
      headers: { "x-test-user": "device-owner" },
      payload: {},
    });
    expect(revoke.statusCode).toBe(200);
    expect(service.revokeRepositoryGrant).toHaveBeenCalledWith({
      actor_user_id: "device-owner",
      device_id: "device-1",
      grant_id: "grant-1",
    });

    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/projects/project-1/execution-targets",
          headers: { "x-test-user": "project-owner" },
        })
      ).json(),
    ).toEqual({
      project_id: "project-1",
      selected_execution_target_id: null,
      work_active: false,
      execution_targets: [],
    });
    const selected = await app.inject({
      method: "PUT",
      url: "/api/projects/project-1/execution-target",
      headers: { "x-test-user": "project-owner" },
      payload: {
        execution_target_id: "grant-1",
        expected_current_execution_target_id: null,
      },
    });
    expect(selected.statusCode).toBe(200);
    expect(service.selectProjectExecutionTarget).toHaveBeenCalledWith({
      actor_user_id: "project-owner",
      project_id: "project-1",
      execution_target_id: "grant-1",
      expected_current_execution_target_id: null,
    });
  });

  it.each([
    {
      purpose: DEVICE_REPOSITORY_REGISTRATION_HTTP_SIGNATURE_PURPOSE,
      path: "/api/device-repository-registrations",
      body: {
        workspace_id: "workspace-1",
        repository_id: "repository-1",
        repository_display_name: "Norns",
        default_branch: "main",
        observed_head: "a".repeat(40),
      },
    },
    {
      purpose: DEVICE_REPOSITORY_REGISTRATION_REVOCATION_HTTP_SIGNATURE_PURPOSE,
      path: "/api/device-repository-registrations/registration-1/revoke",
      body: { workspace_id: "workspace-1", repository_id: "repository-1" },
    },
    {
      purpose: DEVICE_PUBLICATION_PERMIT_ISSUE_HTTP_SIGNATURE_PURPOSE,
      path: "/api/device-publication-permits",
      body: {
        run_id: "run-1",
        repository_registration_id: "registration-1",
        project_device_repository_grant_id: "grant-1",
        repository_binding_id: "binding-1",
        repository_id: "repository-1",
        branch: "norns/task-1",
        commit_sha: "a".repeat(40),
      },
    },
    {
      purpose: DEVICE_PUBLICATION_PERMIT_CONSUME_HTTP_SIGNATURE_PURPOSE,
      path: "/api/device-publication-permits/permit-1/consume",
      body: {
        permit,
        key_id: "publication-key-1",
        signature_base64: signatureBase64,
      },
    },
  ])("body-binds and replay-protects $purpose", async ({ purpose, path, body }) => {
    const first = signedRequest(purpose, path, body, `request-${purpose}`);
    expect((await app.inject(first)).statusCode).toBe(200);
    expect((await app.inject(first)).statusCode).toBe(401);

    const changed = structuredClone(body) as Record<string, unknown>;
    if ("repository_display_name" in changed) changed.repository_display_name = "Changed";
    else if ("workspace_id" in changed) changed.workspace_id = "workspace-2";
    else if ("branch" in changed) changed.branch = "norns/other";
    else {
      changed.key_id = "publication-key-2";
    }
    const tampered = signedRequest(purpose, path, changed, `tampered-${purpose}`, body);
    expect((await app.inject(tampered)).statusCode).toBe(401);
  });
});
