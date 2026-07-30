import {
  BeginLegacyRepositoryBindingClaimRequest,
  FinalizeLegacyRepositoryBindingClaimRequest,
  LegacyRepositoryBindingClaimProjection,
} from "@norns/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  LegacyRepositoryClaimError,
  type LegacyRepositoryClaimService,
} from "./legacyRepositoryClaims.js";

const ProjectParams = z.object({ projectId: z.string().trim().min(1).max(512) }).strict();
const ClaimParams = ProjectParams.extend({
  claimId: z.string().trim().min(1).max(512),
}).strict();

export interface LegacyRepositoryClaimRouteOptions {
  service: LegacyRepositoryClaimService;
  requireUser(request: FastifyRequest, reply: FastifyReply): Promise<{ id: string } | null>;
  now?: () => Date;
}

function noStore(reply: FastifyReply): FastifyReply {
  return reply.header("Cache-Control", "no-store").header("Pragma", "no-cache");
}

function claimError(reply: FastifyReply, error: LegacyRepositoryClaimError): FastifyReply {
  if (error.code === "not_found") {
    return noStore(reply).code(404).send({ error: "not_found" });
  }
  return noStore(reply).code(409).send({ error: error.code });
}

export async function registerLegacyRepositoryClaimRoutes(
  app: FastifyInstance,
  options: LegacyRepositoryClaimRouteOptions,
): Promise<void> {
  const now = options.now ?? (() => new Date());

  app.get("/api/projects/:projectId/legacy-repository-claim", async (request, reply) => {
    const user = await options.requireUser(request, reply);
    if (!user) return;
    const params = ProjectParams.safeParse(request.params);
    if (!params.success) {
      return noStore(reply).code(400).send({ error: "bad_request" });
    }
    try {
      const claim = await options.service.getCurrent(user.id, params.data.projectId);
      return claim
        ? noStore(reply).send(LegacyRepositoryBindingClaimProjection.parse(claim))
        : noStore(reply).code(404).send({ error: "not_found" });
    } catch {
      return noStore(reply).code(503).send({ error: "legacy_repository_claim_unavailable" });
    }
  });

  app.post("/api/projects/:projectId/legacy-repository-claim/begin", async (request, reply) => {
    const user = await options.requireUser(request, reply);
    if (!user) return;
    const params = ProjectParams.safeParse(request.params);
    const body = BeginLegacyRepositoryBindingClaimRequest.safeParse(request.body);
    if (!params.success || !body.success) {
      return noStore(reply).code(400).send({ error: "bad_request" });
    }
    try {
      return noStore(reply).send(
        LegacyRepositoryBindingClaimProjection.parse(
          await options.service.begin({
            actor_user_id: user.id,
            project_id: params.data.projectId,
            ...body.data,
            now: now().toISOString(),
          }),
        ),
      );
    } catch (error) {
      if (error instanceof LegacyRepositoryClaimError) return claimError(reply, error);
      return noStore(reply).code(503).send({ error: "legacy_repository_claim_unavailable" });
    }
  });

  app.get("/api/projects/:projectId/legacy-repository-claims/:claimId", async (request, reply) => {
    const user = await options.requireUser(request, reply);
    if (!user) return;
    const params = ClaimParams.safeParse(request.params);
    if (!params.success) {
      return noStore(reply).code(400).send({ error: "bad_request" });
    }
    try {
      const claim = await options.service.get(user.id, params.data.projectId, params.data.claimId);
      return claim
        ? noStore(reply).send(LegacyRepositoryBindingClaimProjection.parse(claim))
        : noStore(reply).code(404).send({ error: "not_found" });
    } catch {
      return noStore(reply).code(503).send({ error: "legacy_repository_claim_unavailable" });
    }
  });

  app.post(
    "/api/projects/:projectId/legacy-repository-claims/:claimId/finalize",
    async (request, reply) => {
      const user = await options.requireUser(request, reply);
      if (!user) return;
      const params = ClaimParams.safeParse(request.params);
      const body = FinalizeLegacyRepositoryBindingClaimRequest.safeParse(request.body);
      if (!params.success || !body.success) {
        return noStore(reply).code(400).send({ error: "bad_request" });
      }
      try {
        return noStore(reply).send(
          LegacyRepositoryBindingClaimProjection.parse(
            await options.service.finalize({
              actor_user_id: user.id,
              project_id: params.data.projectId,
              claim_id: params.data.claimId,
              execution_target_id: body.data.execution_target_id,
              expected_claim_version: body.data.expected_claim_version,
              expected_project_version: body.data.expected_project_version,
              idempotency_key: body.data.idempotency_key,
              now: now().toISOString(),
            }),
          ),
        );
      } catch (error) {
        if (error instanceof LegacyRepositoryClaimError) return claimError(reply, error);
        return noStore(reply).code(503).send({ error: "legacy_repository_claim_unavailable" });
      }
    },
  );
}
