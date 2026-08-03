import {
  ConversationExecutionProjection,
  ProjectRunCancellationProjection,
  ProjectRunCancellationRequest,
} from "@norns/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { type DeviceRunCancellationService, ProjectRunCancellationError } from "./cancellation.js";

const ProjectRunParams = z
  .object({
    projectId: z.string().trim().min(1).max(512),
    runId: z.string().trim().min(1).max(512),
  })
  .strict();

const ConversationParams = z
  .object({
    projectId: z.string().trim().min(1).max(512),
    conversationId: z.string().trim().min(1).max(512),
  })
  .strict();

export type ProjectCancellationRouteService = Pick<
  DeviceRunCancellationService,
  | "requestProjectStop"
  | "requestAllProjectStops"
  | "getProjectCancellation"
  | "getConversationExecution"
>;

export interface ProjectCancellationRouteOptions {
  service: ProjectCancellationRouteService;
  requireUser(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<{ id: string } | null | undefined>;
  now?: () => Date;
}

function noStore(reply: FastifyReply): FastifyReply {
  reply.header("cache-control", "no-store");
  return reply;
}

function cancellationError(reply: FastifyReply, error: ProjectRunCancellationError) {
  if (error.code === "project_run_not_found" || error.code === "conversation_not_found") {
    return noStore(reply).code(404).send({ error: "not_found" });
  }
  if (error.code === "idempotency_conflict") {
    return noStore(reply).code(409).send({ error: "idempotency_conflict" });
  }
  return noStore(reply).code(409).send({ error: error.code });
}

export async function registerProjectCancellationRoutes(
  app: FastifyInstance,
  options: ProjectCancellationRouteOptions,
): Promise<void> {
  const now = options.now ?? (() => new Date());

  app.post("/api/projects/:projectId/runs/:runId/cancel", async (request, reply) => {
    const user = await options.requireUser(request, reply);
    if (!user) return;
    const params = ProjectRunParams.safeParse(request.params);
    const body = ProjectRunCancellationRequest.safeParse(request.body);
    if (!params.success || !body.success) {
      return noStore(reply).code(400).send({ error: "bad_request" });
    }
    try {
      const projection = await options.service.requestProjectStop({
        actor_user_id: user.id,
        project_id: params.data.projectId,
        run_id: params.data.runId,
        reason: body.data.reason,
        idempotency_key: body.data.idempotency_key,
        requested_at: now().toISOString(),
      });
      return noStore(reply).send(ProjectRunCancellationProjection.parse(projection));
    } catch (error) {
      if (error instanceof ProjectRunCancellationError) {
        return cancellationError(reply, error);
      }
      return noStore(reply).code(503).send({ error: "project_cancellation_unavailable" });
    }
  });

  app.post("/api/projects/:projectId/runs/cancel-all", async (request, reply) => {
    const user = await options.requireUser(request, reply);
    if (!user) return;
    const params = z
      .object({ projectId: z.string().trim().min(1).max(512) })
      .strict()
      .safeParse(request.params);
    const body = ProjectRunCancellationRequest.safeParse(request.body);
    if (!params.success || !body.success) {
      return noStore(reply).code(400).send({ error: "bad_request" });
    }
    try {
      const result = await options.service.requestAllProjectStops({
        actor_user_id: user.id,
        project_id: params.data.projectId,
        reason: body.data.reason,
        idempotency_key: body.data.idempotency_key,
        requested_at: now().toISOString(),
      });
      return noStore(reply).send({
        cancellations: result.cancellations.map((projection) =>
          ProjectRunCancellationProjection.parse(projection),
        ),
        failed_run_ids: result.failed_run_ids,
      });
    } catch (error) {
      if (error instanceof ProjectRunCancellationError) {
        return cancellationError(reply, error);
      }
      return noStore(reply).code(503).send({ error: "project_cancellation_unavailable" });
    }
  });

  app.get("/api/projects/:projectId/runs/:runId/cancellation", async (request, reply) => {
    const user = await options.requireUser(request, reply);
    if (!user) return;
    const params = ProjectRunParams.safeParse(request.params);
    if (!params.success) return noStore(reply).code(400).send({ error: "bad_request" });
    try {
      const projection = await options.service.getProjectCancellation(
        user.id,
        params.data.projectId,
        params.data.runId,
      );
      if (!projection) return noStore(reply).code(404).send({ error: "not_found" });
      return noStore(reply).send(ProjectRunCancellationProjection.parse(projection));
    } catch {
      return noStore(reply).code(503).send({ error: "project_cancellation_unavailable" });
    }
  });

  app.get(
    "/api/projects/:projectId/conversations/:conversationId/execution",
    async (request, reply) => {
      const user = await options.requireUser(request, reply);
      if (!user) return;
      const params = ConversationParams.safeParse(request.params);
      if (!params.success) return noStore(reply).code(400).send({ error: "bad_request" });
      try {
        const projection = await options.service.getConversationExecution(
          user.id,
          params.data.projectId,
          params.data.conversationId,
        );
        return noStore(reply).send(ConversationExecutionProjection.parse(projection));
      } catch (error) {
        if (error instanceof ProjectRunCancellationError) {
          return cancellationError(reply, error);
        }
        return noStore(reply).code(503).send({ error: "conversation_execution_unavailable" });
      }
    },
  );
}
