import {
  DEVICE_PUBLICATION_PERMIT_CONSUME_HTTP_SIGNATURE_PURPOSE,
  DEVICE_PUBLICATION_PERMIT_ISSUE_HTTP_SIGNATURE_PURPOSE,
  DEVICE_REPOSITORY_REGISTRATION_HTTP_SIGNATURE_PURPOSE,
  DEVICE_REPOSITORY_REGISTRATION_REVOCATION_HTTP_SIGNATURE_PURPOSE,
  type DeviceHttpSignaturePurposeT,
  DevicePublicationPermitConsumeRequest,
  DevicePublicationPermitIssueRequest,
  DeviceRepositoryRegistrationRequest,
  DeviceRepositoryRegistrationResponse,
  DeviceRepositoryRegistrationRevocationRequest,
  DeviceRepositoryRegistrationRevocationResponse,
} from "@norns/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  type AuthenticatedRunnerHttpIdentity,
  type DeviceHttpRequestAuthenticator,
  captureRunnerHttpBodySha256,
  capturedRunnerHttpBodySha256,
  routedDeviceHttpPathSegment,
} from "../execution/index.js";
import {
  DevicePublicationPermitError,
  type DevicePublicationPermitService,
} from "./publicationPermits.js";
import {
  DeviceRepositoryAccessError,
  type DeviceRepositoryAccessService,
} from "./repositoryAccessService.js";

const DeviceParams = z.object({ deviceId: z.string().trim().min(1).max(512) }).strict();
const GrantParams = DeviceParams.extend({
  grantId: z.string().trim().min(1).max(512),
}).strict();
const RegistrationParams = z.object({ registrationId: z.string().trim().min(1).max(512) }).strict();
const PermitParams = z.object({ permitId: z.string().trim().min(1).max(512) }).strict();
const GrantBody = z
  .object({
    repository_registration_id: z.string().trim().min(1).max(512),
    project_id: z.string().trim().min(1).max(512),
  })
  .strict();
const SelectTargetBody = z
  .object({
    execution_target_id: z.string().trim().min(1).max(512),
    expected_current_execution_target_id: z.string().trim().min(1).max(512).nullable(),
  })
  .strict();
const ProjectParams = z.object({ projectId: z.string().trim().min(1).max(512) }).strict();
const EmptyBody = z.object({}).strict();

export interface DeviceRepositoryAccessRouteUser {
  id: string;
}

export interface DeviceRepositoryAccessRouteOptions {
  service: DeviceRepositoryAccessService;
  publicationPermits: DevicePublicationPermitService;
  runnerAuthentication: Pick<DeviceHttpRequestAuthenticator, "authenticate">;
  requireUser(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<DeviceRepositoryAccessRouteUser | null>;
}

function noStore(reply: FastifyReply): FastifyReply {
  return reply.header("Cache-Control", "no-store").header("Pragma", "no-cache");
}

function invalid(reply: FastifyReply): FastifyReply {
  return noStore(reply).code(400).send({ error: "bad_request" });
}

function repositoryError(reply: FastifyReply, error: DeviceRepositoryAccessError): FastifyReply {
  if (error.code === "execution_target_changed" || error.code === "project_work_active") {
    return noStore(reply).code(409).send({ error: error.code });
  }
  return noStore(reply)
    .code(404)
    .send({ error: error.code === "project_not_found" ? "project_not_found" : "not_found" });
}

function permitError(reply: FastifyReply, error: DevicePublicationPermitError): FastifyReply {
  if (error.code === "invalid_permit") {
    return noStore(reply).code(400).send({ error: error.code });
  }
  if (error.code === "permit_expired" || error.code === "permit_consumed") {
    return noStore(reply).code(409).send({ error: error.code });
  }
  return noStore(reply).code(403).send({ error: error.code });
}

async function authenticateDevice(
  request: FastifyRequest,
  reply: FastifyReply,
  options: DeviceRepositoryAccessRouteOptions,
  purpose: DeviceHttpSignaturePurposeT,
  routedPath: string,
): Promise<Extract<AuthenticatedRunnerHttpIdentity, { kind: "device" }> | null> {
  const auth = await options.runnerAuthentication.authenticate({
    purpose,
    method: request.method,
    path_and_query: request.url,
    routed_path: routedPath,
    body_sha256: capturedRunnerHttpBodySha256(request),
    headers: request.headers as Record<string, string | string[] | undefined>,
  });
  if (!auth.ok || auth.identity.kind !== "device") {
    noStore(reply).code(401).send({ error: "unauthorized" });
    return null;
  }
  return auth.identity;
}

async function ownerEnvelope(
  service: DeviceRepositoryAccessService,
  actorUserId: string,
  deviceId: string,
) {
  return service.getOwnedRepositoryAccess(actorUserId, deviceId);
}

export async function registerDeviceRepositoryAccessRoutes(
  app: FastifyInstance,
  options: DeviceRepositoryAccessRouteOptions,
): Promise<void> {
  app.get("/api/devices/:deviceId/repository-access", async (request, reply) => {
    const user = await options.requireUser(request, reply);
    if (!user) return;
    const params = DeviceParams.safeParse(request.params);
    if (!params.success) return invalid(reply);
    try {
      return noStore(reply).send(
        await ownerEnvelope(options.service, user.id, params.data.deviceId),
      );
    } catch (error) {
      if (error instanceof DeviceRepositoryAccessError) return repositoryError(reply, error);
      return noStore(reply).code(503).send({ error: "device_repository_access_unavailable" });
    }
  });

  app.post("/api/devices/:deviceId/repository-grants", async (request, reply) => {
    const user = await options.requireUser(request, reply);
    if (!user) return;
    const params = DeviceParams.safeParse(request.params);
    const body = GrantBody.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply);
    try {
      const access = await ownerEnvelope(options.service, user.id, params.data.deviceId);
      const registration = access.registrations.find(
        (candidate) => candidate.registration_id === body.data.repository_registration_id,
      );
      if (!registration) return noStore(reply).code(404).send({ error: "not_found" });
      if (registration.state !== "active") {
        return noStore(reply).code(409).send({ error: "repository_registration_revoked" });
      }
      await options.service.grantRepository({
        actor_user_id: user.id,
        project_id: body.data.project_id,
        repository_registration_id: body.data.repository_registration_id,
      });
      return noStore(reply).send(
        await ownerEnvelope(options.service, user.id, params.data.deviceId),
      );
    } catch (error) {
      if (error instanceof DeviceRepositoryAccessError) return repositoryError(reply, error);
      return noStore(reply).code(503).send({ error: "device_repository_access_unavailable" });
    }
  });

  app.post("/api/devices/:deviceId/repository-grants/:grantId/revoke", async (request, reply) => {
    const user = await options.requireUser(request, reply);
    if (!user) return;
    const params = GrantParams.safeParse(request.params);
    const body = EmptyBody.safeParse(request.body ?? {});
    if (!params.success || !body.success) return invalid(reply);
    try {
      const access = await ownerEnvelope(options.service, user.id, params.data.deviceId);
      const grant = access.registrations
        .flatMap((registration) => registration.grants)
        .find((candidate) => candidate.grant_id === params.data.grantId);
      if (!grant) return noStore(reply).code(404).send({ error: "not_found" });
      if (grant.state === "revoked") {
        return noStore(reply).code(409).send({ error: "repository_grant_revoked" });
      }
      await options.service.revokeRepositoryGrant({
        actor_user_id: user.id,
        device_id: params.data.deviceId,
        grant_id: params.data.grantId,
      });
      return noStore(reply).send(
        await ownerEnvelope(options.service, user.id, params.data.deviceId),
      );
    } catch (error) {
      if (error instanceof DeviceRepositoryAccessError) return repositoryError(reply, error);
      return noStore(reply).code(503).send({ error: "device_repository_access_unavailable" });
    }
  });

  app.get("/api/projects/:projectId/execution-targets", async (request, reply) => {
    const user = await options.requireUser(request, reply);
    if (!user) return;
    const params = ProjectParams.safeParse(request.params);
    if (!params.success) return invalid(reply);
    try {
      return noStore(reply).send(
        await options.service.listProjectExecutionTargets(user.id, params.data.projectId),
      );
    } catch (error) {
      if (error instanceof DeviceRepositoryAccessError) return repositoryError(reply, error);
      return noStore(reply).code(503).send({ error: "device_repository_access_unavailable" });
    }
  });

  app.put("/api/projects/:projectId/execution-target", async (request, reply) => {
    const user = await options.requireUser(request, reply);
    if (!user) return;
    const params = ProjectParams.safeParse(request.params);
    const body = SelectTargetBody.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply);
    try {
      return noStore(reply).send(
        await options.service.selectProjectExecutionTarget({
          actor_user_id: user.id,
          project_id: params.data.projectId,
          ...body.data,
        }),
      );
    } catch (error) {
      if (error instanceof DeviceRepositoryAccessError) return repositoryError(reply, error);
      return noStore(reply).code(503).send({ error: "device_repository_access_unavailable" });
    }
  });

  app.post(
    "/api/device-repository-registrations",
    { preParsing: captureRunnerHttpBodySha256 },
    async (request, reply) => {
      const body = DeviceRepositoryRegistrationRequest.safeParse(request.body);
      if (!body.success) return invalid(reply);
      const identity = await authenticateDevice(
        request,
        reply,
        options,
        DEVICE_REPOSITORY_REGISTRATION_HTTP_SIGNATURE_PURPOSE,
        "/api/device-repository-registrations",
      );
      if (!identity) return;
      try {
        const registration = await options.service.registerRepository({
          ...identity,
          ...body.data,
          observed_head: body.data.observed_head,
        });
        return noStore(reply).send(
          DeviceRepositoryRegistrationResponse.parse({
            registration_id: registration.registration_id,
            status: "active",
            workspace_id: registration.workspace_id,
            repository_id: registration.repository_id,
          }),
        );
      } catch (error) {
        if (error instanceof DeviceRepositoryAccessError) {
          return noStore(reply).code(403).send({ error: error.code });
        }
        return noStore(reply).code(503).send({ error: "device_repository_access_unavailable" });
      }
    },
  );

  app.post(
    "/api/device-repository-registrations/:registrationId/revoke",
    { preParsing: captureRunnerHttpBodySha256 },
    async (request, reply) => {
      const params = RegistrationParams.safeParse(request.params);
      const body = DeviceRepositoryRegistrationRevocationRequest.safeParse(request.body);
      if (!params.success || !body.success) return invalid(reply);
      const identity = await authenticateDevice(
        request,
        reply,
        options,
        DEVICE_REPOSITORY_REGISTRATION_REVOCATION_HTTP_SIGNATURE_PURPOSE,
        `/api/device-repository-registrations/${routedDeviceHttpPathSegment(
          params.data.registrationId,
        )}/revoke`,
      );
      if (!identity) return;
      try {
        const registration = await options.service.removeRepositoryAccess({
          ...identity,
          registration_id: params.data.registrationId,
          ...body.data,
        });
        return noStore(reply).send(
          DeviceRepositoryRegistrationRevocationResponse.parse({
            registration_id: registration.registration_id,
            status: "revoked",
          }),
        );
      } catch (error) {
        if (error instanceof DeviceRepositoryAccessError) {
          return noStore(reply).code(403).send({ error: error.code });
        }
        return noStore(reply).code(503).send({ error: "device_repository_access_unavailable" });
      }
    },
  );

  app.post(
    "/api/device-publication-permits",
    { preParsing: captureRunnerHttpBodySha256 },
    async (request, reply) => {
      const body = DevicePublicationPermitIssueRequest.safeParse(request.body);
      if (!body.success) return invalid(reply);
      const identity = await authenticateDevice(
        request,
        reply,
        options,
        DEVICE_PUBLICATION_PERMIT_ISSUE_HTTP_SIGNATURE_PURPOSE,
        "/api/device-publication-permits",
      );
      if (!identity) return;
      try {
        return noStore(reply).send(await options.publicationPermits.issue(identity, body.data));
      } catch (error) {
        if (error instanceof DevicePublicationPermitError) return permitError(reply, error);
        return noStore(reply).code(503).send({ error: "publication_permit_unavailable" });
      }
    },
  );

  app.post(
    "/api/device-publication-permits/:permitId/consume",
    { preParsing: captureRunnerHttpBodySha256 },
    async (request, reply) => {
      const params = PermitParams.safeParse(request.params);
      const body = DevicePublicationPermitConsumeRequest.safeParse(request.body);
      if (!params.success || !body.success || body.data.permit.permit_id !== params.data.permitId) {
        return invalid(reply);
      }
      const identity = await authenticateDevice(
        request,
        reply,
        options,
        DEVICE_PUBLICATION_PERMIT_CONSUME_HTTP_SIGNATURE_PURPOSE,
        `/api/device-publication-permits/${routedDeviceHttpPathSegment(
          params.data.permitId,
        )}/consume`,
      );
      if (!identity) return;
      try {
        return noStore(reply).send(await options.publicationPermits.consume(identity, body.data));
      } catch (error) {
        if (error instanceof DevicePublicationPermitError) return permitError(reply, error);
        return noStore(reply).code(503).send({ error: "publication_permit_unavailable" });
      }
    },
  );
}
