import {
  CreateDeviceAuthorizationRequest,
  CreateDeviceAuthorizationResponse,
} from "@norns/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { LoginAttemptThrottle } from "../users/loginThrottle.js";
import { DeviceEnrollmentError } from "./domain.js";
import type { DeviceEnrollmentService } from "./service.js";

const AuthorizationRequestId = z.string().trim().min(1).max(512);
const AuthorizationContext = z.string().min(1).max(512);

const PollAuthorizationBody = z
  .object({
    device_code: z.string().min(1).max(128),
    public_key_pem: z.string().min(1).max(2_000).optional(),
    proof_signature_base64: z.string().min(1).max(512).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (Boolean(value.public_key_pem) !== Boolean(value.proof_signature_base64)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "public key and proof signature must be supplied together",
      });
    }
  });

const LookupAuthorizationBody = z
  .object({
    user_code: z.string().min(1).max(32),
  })
  .strict();

const AuthorizationDecisionParams = z
  .object({
    authorizationRequestId: AuthorizationRequestId,
  })
  .strict();

const AuthorizationDecisionBody = z
  .object({
    authorization_context: AuthorizationContext,
  })
  .strict();

export interface DeviceEnrollmentRouteUser {
  id: string;
}

export type DeviceEnrollmentRouteService = Pick<
  DeviceEnrollmentService,
  "createAuthorization" | "lookup" | "approve" | "status" | "deny" | "poll"
>;

export interface DeviceEnrollmentRouteOptions {
  service: DeviceEnrollmentRouteService;
  requireUser(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<DeviceEnrollmentRouteUser | null>;
  requireRecentUser(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<DeviceEnrollmentRouteUser | null>;
  now?: () => Date;
  lookupThrottle?: LoginAttemptThrottle;
}

function noStore(reply: FastifyReply): FastifyReply {
  return reply.header("Cache-Control", "no-store").header("Pragma", "no-cache");
}

function invalidBody(reply: FastifyReply): FastifyReply {
  return noStore(reply).code(400).send({ error: "bad_request" });
}

function sendEnrollmentError(reply: FastifyReply, error: DeviceEnrollmentError): FastifyReply {
  if (error.code === "authorization_not_available") {
    return noStore(reply).code(404).send({ error: "authorization_not_available" });
  }
  return noStore(reply).code(400).send({ error: error.code });
}

/**
 * Phase 1 enrollment routes. They are mounted only when the caller supplies
 * the explicitly enabled runtime, so adding this module does not enable
 * production device capability by itself.
 */
export async function registerDeviceEnrollmentRoutes(
  app: FastifyInstance,
  options: DeviceEnrollmentRouteOptions,
): Promise<void> {
  const now = options.now ?? (() => new Date());
  const lookupThrottle = options.lookupThrottle ?? new LoginAttemptThrottle(10, 15 * 60_000);

  app.post("/api/device-authorizations", async (request, reply) => {
    const parsed = CreateDeviceAuthorizationRequest.safeParse(request.body);
    if (!parsed.success) return invalidBody(reply);
    try {
      return noStore(reply)
        .code(201)
        .send(
          CreateDeviceAuthorizationResponse.parse(
            await options.service.createAuthorization(parsed.data),
          ),
        );
    } catch (error) {
      if (error instanceof DeviceEnrollmentError) return sendEnrollmentError(reply, error);
      return noStore(reply).code(500).send({ error: "device_enrollment_unavailable" });
    }
  });

  app.post("/api/device-authorizations/token", async (request, reply) => {
    const parsed = PollAuthorizationBody.safeParse(request.body);
    if (!parsed.success) return invalidBody(reply);
    try {
      return noStore(reply).send(
        await options.service.poll({
          device_code: parsed.data.device_code,
          ...(parsed.data.public_key_pem && parsed.data.proof_signature_base64
            ? {
                public_key_pem: parsed.data.public_key_pem,
                proof_signature_base64: parsed.data.proof_signature_base64,
              }
            : {}),
        }),
      );
    } catch {
      return noStore(reply).code(500).send({ error: "device_enrollment_unavailable" });
    }
  });

  app.post("/api/device-authorizations/lookup", async (request, reply) => {
    const user = await options.requireUser(request, reply);
    if (!user) return;
    const parsed = LookupAuthorizationBody.safeParse(request.body);
    if (!parsed.success) return invalidBody(reply);

    const throttleKey = lookupThrottle.key(user.id, request.ip);
    const at = now();
    const throttle = lookupThrottle.check(throttleKey, at);
    if (!throttle.allowed) {
      return noStore(reply)
        .header("Retry-After", String(throttle.retry_after_seconds))
        .code(429)
        .send({
          error: "throttled",
          retry_after_seconds: throttle.retry_after_seconds,
        });
    }
    // Count every submitted human code, including a valid one. Clearing the
    // bucket on success would let a caller repeatedly enumerate live codes.
    lookupThrottle.recordFailure(throttleKey, at);

    try {
      return noStore(reply).send(await options.service.lookup(parsed.data));
    } catch (error) {
      if (error instanceof DeviceEnrollmentError) return sendEnrollmentError(reply, error);
      return noStore(reply).code(500).send({ error: "device_enrollment_unavailable" });
    }
  });

  app.get("/api/device-authorizations/:authorizationRequestId/status", async (request, reply) => {
    const user = await options.requireUser(request, reply);
    if (!user) return;
    const params = AuthorizationDecisionParams.safeParse(request.params);
    if (!params.success) return invalidBody(reply);
    try {
      return noStore(reply).send(
        await options.service.status({
          authorization_request_id: params.data.authorizationRequestId,
          owner_user_id: user.id,
        }),
      );
    } catch (error) {
      if (error instanceof DeviceEnrollmentError) return sendEnrollmentError(reply, error);
      return noStore(reply).code(500).send({ error: "device_enrollment_unavailable" });
    }
  });

  app.post("/api/device-authorizations/:authorizationRequestId/approve", async (request, reply) => {
    const user = await options.requireRecentUser(request, reply);
    if (!user) return;
    const params = AuthorizationDecisionParams.safeParse(request.params);
    const body = AuthorizationDecisionBody.safeParse(request.body);
    if (!params.success || !body.success) return invalidBody(reply);
    try {
      return noStore(reply).send(
        await options.service.approve({
          authorization_request_id: params.data.authorizationRequestId,
          authorization_context: body.data.authorization_context,
          owner_user_id: user.id,
        }),
      );
    } catch (error) {
      if (error instanceof DeviceEnrollmentError) return sendEnrollmentError(reply, error);
      return noStore(reply).code(500).send({ error: "device_enrollment_unavailable" });
    }
  });

  app.post("/api/device-authorizations/:authorizationRequestId/deny", async (request, reply) => {
    const user = await options.requireRecentUser(request, reply);
    if (!user) return;
    const params = AuthorizationDecisionParams.safeParse(request.params);
    const body = AuthorizationDecisionBody.safeParse(request.body);
    if (!params.success || !body.success) return invalidBody(reply);
    try {
      return noStore(reply).send(
        await options.service.deny({
          authorization_request_id: params.data.authorizationRequestId,
          authorization_context: body.data.authorization_context,
          denied_by_user_id: user.id,
        }),
      );
    } catch (error) {
      if (error instanceof DeviceEnrollmentError) return sendEnrollmentError(reply, error);
      return noStore(reply).code(500).send({ error: "device_enrollment_unavailable" });
    }
  });
}
