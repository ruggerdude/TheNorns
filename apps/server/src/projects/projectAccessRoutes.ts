import { V2AddProjectMemberRequest, V2TransferProjectOwnershipRequest } from "@norns/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ProjectAccessService } from "./projectAccessService.js";
import { ProjectAccessError } from "./projectAccessService.js";

export interface ProjectAccessRouteIdentity {
  id: string;
}

export interface ProjectAccessRouteOptions {
  service: ProjectAccessService;
  requireIdentity: (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<ProjectAccessRouteIdentity | null>;
}

function handleProjectAccessError(reply: FastifyReply, error: unknown): void {
  if (!(error instanceof ProjectAccessError)) throw error;
  const status =
    error.code === "project_not_found" ||
    error.code === "identity_not_found" ||
    error.code === "member_not_found"
      ? 404
      : error.code === "forbidden"
        ? 403
        : error.code === "identity_inactive"
          ? 401
          : 409;
  reply.code(status).send({ error: error.code, message: error.message });
}

/**
 * Narrow registration seam for project collaboration. The host supplies its
 * existing session resolver; this module never parses bearer tokens itself.
 */
export function registerProjectAccessRoutes(
  app: FastifyInstance,
  options: ProjectAccessRouteOptions,
): void {
  app.get("/api/v2/project-access", async (request, reply) => {
    const identity = await options.requireIdentity(request, reply);
    if (!identity) return;
    try {
      reply.header("Cache-Control", "no-store").send({
        schema_version: 2,
        project_ids: await options.service.listAccessibleProjectIds(identity),
      });
    } catch (error) {
      handleProjectAccessError(reply, error);
    }
  });

  app.get("/api/v2/projects/:projectId/access", async (request, reply) => {
    const identity = await options.requireIdentity(request, reply);
    if (!identity) return;
    const { projectId } = request.params as { projectId: string };
    try {
      reply
        .header("Cache-Control", "no-store")
        .send(await options.service.access(projectId, identity));
    } catch (error) {
      handleProjectAccessError(reply, error);
    }
  });

  app.get("/api/v2/projects/:projectId/members", async (request, reply) => {
    const identity = await options.requireIdentity(request, reply);
    if (!identity) return;
    const { projectId } = request.params as { projectId: string };
    try {
      reply
        .header("Cache-Control", "no-store")
        .send(await options.service.members(projectId, identity));
    } catch (error) {
      handleProjectAccessError(reply, error);
    }
  });

  app.get("/api/v2/projects/:projectId/member-candidates", async (request, reply) => {
    const identity = await options.requireIdentity(request, reply);
    if (!identity) return;
    const { projectId } = request.params as { projectId: string };
    try {
      reply.header("Cache-Control", "no-store").send({
        schema_version: 2,
        project_id: projectId,
        candidates: await options.service.memberCandidates(projectId, identity),
      });
    } catch (error) {
      handleProjectAccessError(reply, error);
    }
  });

  app.post("/api/v2/projects/:projectId/members", async (request, reply) => {
    const identity = await options.requireIdentity(request, reply);
    if (!identity) return;
    const body = V2AddProjectMemberRequest.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "bad_request", issues: body.error.issues });
    }
    const { projectId } = request.params as { projectId: string };
    try {
      reply.send(await options.service.addMember(projectId, identity, body.data.user_id));
    } catch (error) {
      handleProjectAccessError(reply, error);
    }
  });

  app.delete("/api/v2/projects/:projectId/members/:userId", async (request, reply) => {
    const identity = await options.requireIdentity(request, reply);
    if (!identity) return;
    const { projectId, userId } = request.params as {
      projectId: string;
      userId: string;
    };
    try {
      reply.send(await options.service.removeMember(projectId, identity, userId));
    } catch (error) {
      handleProjectAccessError(reply, error);
    }
  });

  app.put("/api/v2/projects/:projectId/owner", async (request, reply) => {
    const identity = await options.requireIdentity(request, reply);
    if (!identity) return;
    const body = V2TransferProjectOwnershipRequest.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "bad_request", issues: body.error.issues });
    }
    const { projectId } = request.params as { projectId: string };
    try {
      reply.send(
        await options.service.transferOwnership(projectId, identity, body.data.owner_user_id),
      );
    } catch (error) {
      handleProjectAccessError(reply, error);
    }
  });
}
