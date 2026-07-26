import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AllowanceUnit, AnalyticsFilters } from "./analyticsRepository.js";
import type { UsageAnalyticsService } from "./analyticsService.js";

export interface UsageAnalyticsAdmin {
  id: string;
  email: string;
}

export interface UsageAnalyticsRouteOptions {
  service: UsageAnalyticsService;
  requireAdmin: (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<UsageAnalyticsAdmin | null>;
}

const FilterQuery = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  provider: z.string().trim().min(1).max(200).optional(),
  model: z.string().trim().min(1).max(300).optional(),
  user: z.string().trim().min(1).max(200).optional(),
  project: z.string().trim().min(1).max(200).optional(),
  phase: z.string().trim().min(1).max(200).optional(),
  request_type: z.string().trim().min(1).max(200).optional(),
  dimension: z.enum(["user", "project", "phase", "provider", "model", "request_type"]).optional(),
  limit: z.coerce.number().int().positive().max(50).optional(),
});

const PlanBody = z
  .object({
    provider: z.string().trim().min(1).max(200),
    plan_name: z.string().trim().min(1).max(300),
    allowance_unit: z.enum(["tokens", "requests", "credits", "usd_equivalent"]),
    allowance_amount: z.number().positive().finite(),
    allowance_usd_equivalent: z.number().positive().finite().nullable().default(null),
    effective_from: z.string().datetime({ offset: true }),
    effective_to: z.string().datetime({ offset: true }).nullable().default(null),
    source: z.string().trim().min(1).max(300),
  })
  .strict();

const ObservationBody = z
  .object({
    plan_id: z.string().trim().min(1).max(300),
    provider: z.string().trim().min(1).max(200),
    model: z.string().trim().min(1).max(300),
    subscription_tier: z.string().trim().min(1).max(200),
    cycle_period: z.enum(["weekly", "monthly"]).default("weekly"),
    reset_at: z.string().datetime({ offset: true }),
    observed_at: z.string().datetime({ offset: true }),
    displayed_percentage: z.number().positive().max(100).finite(),
    source: z.enum(["provider_api", "runtime_report", "manual", "import"]),
    evidence_note: z.string().trim().min(1).max(2_000).nullable().default(null),
  })
  .strict();

function filters(query: z.infer<typeof FilterQuery>): AnalyticsFilters {
  return {
    ...(query.from ? { from: query.from } : {}),
    ...(query.to ? { to: query.to } : {}),
    ...(query.provider ? { provider: query.provider } : {}),
    ...(query.model ? { model: query.model } : {}),
    ...(query.user ? { userId: query.user } : {}),
    ...(query.project ? { projectId: query.project } : {}),
    ...(query.phase ? { phaseId: query.phase } : {}),
    ...(query.request_type ? { requestType: query.request_type } : {}),
  };
}

function badRequest(reply: FastifyReply, error: unknown): void {
  reply.code(400).send({
    error: "bad_request",
    message: error instanceof Error ? error.message : String(error),
  });
}

function query(request: FastifyRequest, reply: FastifyReply): z.infer<typeof FilterQuery> | null {
  const parsed = FilterQuery.safeParse(request.query);
  if (!parsed.success) {
    reply.code(400).send({ error: "bad_request", issues: parsed.error.issues });
    return null;
  }
  if (
    parsed.data.from &&
    parsed.data.to &&
    Date.parse(parsed.data.from) >= Date.parse(parsed.data.to)
  ) {
    reply.code(400).send({ error: "bad_request", message: "from must be before to" });
    return null;
  }
  return parsed.data;
}

export function registerUsageAnalyticsRoutes(
  app: FastifyInstance,
  options: UsageAnalyticsRouteOptions,
): void {
  app.get("/api/usage/analytics/trends", async (request, reply) => {
    if (!(await options.requireAdmin(request, reply))) return;
    const parsed = query(request, reply);
    if (!parsed) return;
    try {
      return reply
        .header("Cache-Control", "no-store")
        .send(await options.service.trends(filters(parsed)));
    } catch (error) {
      badRequest(reply, error);
    }
  });

  app.get("/api/usage/analytics/hot-spots", async (request, reply) => {
    if (!(await options.requireAdmin(request, reply))) return;
    const parsed = query(request, reply);
    if (!parsed) return;
    return reply.header("Cache-Control", "no-store").send({
      dimension: parsed.dimension ?? "provider",
      hot_spots: await options.service.hotSpots(
        parsed.dimension ?? "provider",
        filters(parsed),
        parsed.limit ?? 10,
      ),
    });
  });

  app.get("/api/usage/analytics/signals", async (request, reply) => {
    if (!(await options.requireAdmin(request, reply))) return;
    const parsed = query(request, reply);
    if (!parsed) return;
    return reply
      .header("Cache-Control", "no-store")
      .send(await options.service.signals(filters(parsed)));
  });

  app.get("/api/usage/analytics/recommendations", async (request, reply) => {
    if (!(await options.requireAdmin(request, reply))) return;
    const parsed = query(request, reply);
    if (!parsed) return;
    return reply
      .header("Cache-Control", "no-store")
      .send({ recommendations: await options.service.recommendations(filters(parsed)) });
  });

  app.get("/api/usage/analytics/calibration", async (request, reply) => {
    if (!(await options.requireAdmin(request, reply))) return;
    const parsed = query(request, reply);
    if (!parsed) return;
    return reply
      .header("Cache-Control", "no-store")
      .send(await options.service.calibration(parsed.provider));
  });

  app.get("/api/usage/analytics/forecast/:provider", async (request, reply) => {
    if (!(await options.requireAdmin(request, reply))) return;
    const provider = (request.params as { provider: string }).provider.trim();
    if (!provider) return reply.code(400).send({ error: "bad_request" });
    const forecast = await options.service.forecast(provider);
    if (!forecast) return reply.code(404).send({ error: "forecast_unavailable" });
    return reply.header("Cache-Control", "no-store").send(forecast);
  });

  app.get("/api/usage/calibration/plans", async (request, reply) => {
    if (!(await options.requireAdmin(request, reply))) return;
    const parsed = query(request, reply);
    if (!parsed) return;
    return reply
      .header("Cache-Control", "no-store")
      .send({ plans: await options.service.plans(parsed.provider) });
  });

  app.post("/api/usage/calibration/plans", async (request, reply) => {
    const admin = await options.requireAdmin(request, reply);
    if (!admin) return;
    const parsed = PlanBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "bad_request", issues: parsed.error.issues });
    }
    try {
      return reply.code(201).send(
        await options.service.createPlan({
          ...parsed.data,
          allowance_unit: parsed.data.allowance_unit as AllowanceUnit,
          created_by_user_id: admin.id,
        }),
      );
    } catch (error) {
      badRequest(reply, error);
    }
  });

  app.get("/api/usage/calibration/observations", async (request, reply) => {
    if (!(await options.requireAdmin(request, reply))) return;
    const parsed = query(request, reply);
    if (!parsed) return;
    return reply.header("Cache-Control", "no-store").send({
      observations: await options.service.observations(parsed.provider, parsed.limit ?? 100),
    });
  });

  app.post("/api/usage/calibration/observations", async (request, reply) => {
    const admin = await options.requireAdmin(request, reply);
    if (!admin) return;
    const parsed = ObservationBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "bad_request", issues: parsed.error.issues });
    }
    try {
      return reply.code(201).send(
        await options.service.addObservation({
          ...parsed.data,
          recorded_by_user_id: admin.id,
        }),
      );
    } catch (error) {
      badRequest(reply, error);
    }
  });
}
