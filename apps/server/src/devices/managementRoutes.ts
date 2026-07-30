import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import type { LocalAgentDownloads } from "../runners/helperOnboarding.js";
import { DeviceManagementError, type DeviceManagementService } from "./managementService.js";

const DeviceParams = z
  .object({
    deviceId: z.string().trim().min(1).max(512),
  })
  .strict();

const RenameDeviceBody = z
  .object({
    name: z.string().trim().min(1).max(200),
    location_label: z.string().trim().min(1).max(200).nullable(),
  })
  .strict();

const RevokeDeviceBody = z
  .object({
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

export interface DeviceManagementRouteUser {
  id: string;
}

export type DeviceManagementRouteService = Pick<
  DeviceManagementService,
  "listOwnedDevices" | "getOwnedDevice" | "renameOwnedDevice" | "revokeOwnedDevice"
>;

export interface DeviceManagementRouteOptions {
  service: DeviceManagementRouteService;
  localAgentDownloads: LocalAgentDownloads;
  requireUser(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<DeviceManagementRouteUser | null>;
}

function noStore(reply: FastifyReply): FastifyReply {
  return reply.header("Cache-Control", "no-store").header("Pragma", "no-cache");
}

function managementError(reply: FastifyReply, error: DeviceManagementError): FastifyReply {
  if (error.code === "device_not_found" || error.code === "project_not_found") {
    return noStore(reply).code(404).send({ error: error.code });
  }
  if (error.code === "device_revoked") {
    return noStore(reply).code(409).send({ error: error.code });
  }
  return noStore(reply).code(400).send({ error: error.code });
}

function invalidBody(reply: FastifyReply): FastifyReply {
  return noStore(reply).code(400).send({ error: "bad_request" });
}

async function handle<T>(reply: FastifyReply, operation: () => Promise<T>): Promise<FastifyReply> {
  try {
    return noStore(reply).send(await operation());
  } catch (error) {
    if (error instanceof DeviceManagementError) return managementError(reply, error);
    return noStore(reply).code(503).send({ error: "device_management_unavailable" });
  }
}

export async function registerDeviceManagementRoutes(
  app: FastifyInstance,
  options: DeviceManagementRouteOptions,
): Promise<void> {
  app.get("/api/devices", async (request, reply) => {
    const user = await options.requireUser(request, reply);
    if (!user) return;
    return handle(reply, async () => ({
      devices: await options.service.listOwnedDevices(user.id),
      downloads: options.localAgentDownloads,
    }));
  });

  app.get("/api/devices/:deviceId", async (request, reply) => {
    const user = await options.requireUser(request, reply);
    if (!user) return;
    const params = DeviceParams.safeParse(request.params);
    if (!params.success) return invalidBody(reply);
    return handle(reply, () => options.service.getOwnedDevice(user.id, params.data.deviceId));
  });

  app.patch("/api/devices/:deviceId", async (request, reply) => {
    const user = await options.requireUser(request, reply);
    if (!user) return;
    const params = DeviceParams.safeParse(request.params);
    const body = RenameDeviceBody.safeParse(request.body);
    if (!params.success || !body.success) return invalidBody(reply);
    return handle(reply, () =>
      options.service.renameOwnedDevice({
        actor_user_id: user.id,
        device_id: params.data.deviceId,
        name: body.data.name,
        location_label: body.data.location_label,
      }),
    );
  });

  app.post("/api/devices/:deviceId/revoke", async (request, reply) => {
    const user = await options.requireUser(request, reply);
    if (!user) return;
    const params = DeviceParams.safeParse(request.params);
    const body = RevokeDeviceBody.safeParse(request.body);
    if (!params.success || !body.success) return invalidBody(reply);
    return handle(reply, () =>
      options.service.revokeOwnedDevice({
        actor_user_id: user.id,
        device_id: params.data.deviceId,
        reason: body.data.reason,
      }),
    );
  });
}
