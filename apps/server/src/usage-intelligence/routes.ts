import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type {
  UsageBreakdownDimension,
  UsageFilters,
  UsageIntelligenceService,
  UsageRequestStatus,
  UsageTimeInterval,
} from "./service.js";

export interface UsageRouteUser {
  id: string;
  email: string;
  role: "admin" | "member";
}

export type UsageRouteScope =
  | { kind: "global" }
  | { kind: "user"; id: string }
  | { kind: "project"; id: string }
  | { kind: "phase"; id: string };

export interface UsageRouteOptions {
  service: UsageIntelligenceService;
  resolveUser: (request: FastifyRequest) => Promise<UsageRouteUser | undefined>;
  /**
   * Project/phase authorization seam. Admins bypass it; a missing callback
   * defaults closed. This lets project membership evolve independently from
   * the telemetry query layer.
   */
  authorizeScope?: (
    user: UsageRouteUser,
    scope: Extract<UsageRouteScope, { kind: "project" | "phase" }>,
  ) => Promise<boolean>;
  exportLimit?: number;
}

const QuerySchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  provider: z.string().trim().min(1).max(200).optional(),
  model: z.string().trim().min(1).max(300).optional(),
  user: z.string().trim().min(1).max(200).optional(),
  project: z.string().trim().min(1).max(200).optional(),
  phase: z.string().trim().min(1).max(200).optional(),
  status: z.enum(["succeeded", "failed", "in_progress"]).optional(),
  interval: z.enum(["day", "week", "month"]).optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
  dimensions: z.string().trim().min(1).max(100).optional(),
});

type ParsedQuery = z.infer<typeof QuerySchema>;

function parsedFilters(query: ParsedQuery, scope: UsageRouteScope): UsageFilters {
  const filters: UsageFilters = {};
  if (query.from) filters.from = query.from;
  if (query.to) filters.to = query.to;
  if (query.provider) filters.provider = query.provider;
  if (query.model) filters.model = query.model;
  if (query.status) filters.status = query.status as UsageRequestStatus;
  if (query.user) filters.userId = query.user;
  if (query.project) filters.projectId = query.project;
  if (query.phase) filters.phaseId = query.phase;
  if (scope.kind === "user") filters.userId = scope.id;
  if (scope.kind === "project") filters.projectId = scope.id;
  if (scope.kind === "phase") filters.phaseId = scope.id;
  return filters;
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text = String(value);
  // CSV opened in a spreadsheet must not execute provider/model/error text as
  // a formula. Preserve the visible value while forcing it to a text cell.
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function usageCsv(
  events: Awaited<ReturnType<UsageIntelligenceService["exportEvents"]>>["events"],
): string {
  const columns = [
    "id",
    "request_id",
    "sequence",
    "event_type",
    "occurred_at",
    "provider",
    "model",
    "status",
    "provider_request_id",
    "endpoint",
    "request_type",
    "initiated_by_user_id",
    "project_id",
    "phase_id",
    "task_id",
    "run_id",
    "usage_source",
    "confidence",
    "pricing_profile_id",
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "cost_usd",
    "cost_classification",
    "latency_ms",
    "http_status",
    "error_code",
    "error_category",
  ] as const;
  const lines = [columns.map(csvCell).join(",")];
  for (const event of events) {
    lines.push(columns.map((column) => csvCell(event[column])).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

async function authorize(
  request: FastifyRequest,
  reply: FastifyReply,
  scope: UsageRouteScope,
  options: UsageRouteOptions,
): Promise<UsageRouteUser | null> {
  const user = await options.resolveUser(request);
  if (!user) {
    reply.code(401).send({ error: "unauthorized" });
    return null;
  }
  if (scope.kind === "global") {
    if (user.role !== "admin") {
      reply.code(403).send({ error: "forbidden", message: "admin role required" });
      return null;
    }
    return user;
  }
  if (scope.kind === "user") {
    if (user.role !== "admin" && user.id !== scope.id) {
      reply.code(403).send({ error: "forbidden" });
      return null;
    }
    return user;
  }
  if (user.role === "admin") return user;
  if (!(await options.authorizeScope?.(user, scope))) {
    reply.code(403).send({ error: "forbidden" });
    return null;
  }
  return user;
}

function queryOrBadRequest(request: FastifyRequest, reply: FastifyReply): ParsedQuery | null {
  const parsed = QuerySchema.safeParse(request.query);
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

function registerScopeRoutes(
  app: FastifyInstance,
  base: string,
  scopeFromRequest: (request: FastifyRequest) => UsageRouteScope,
  options: UsageRouteOptions,
): void {
  app.get(`${base}/summary`, async (request, reply) => {
    const scope = scopeFromRequest(request);
    if (!(await authorize(request, reply, scope, options))) return;
    const query = queryOrBadRequest(request, reply);
    if (!query) return;
    return reply
      .header("Cache-Control", "no-store")
      .send(await options.service.summary(parsedFilters(query, scope)));
  });

  app.get(`${base}/timeseries`, async (request, reply) => {
    const scope = scopeFromRequest(request);
    if (!(await authorize(request, reply, scope, options))) return;
    const query = queryOrBadRequest(request, reply);
    if (!query) return;
    const points = await options.service.timeSeries(
      parsedFilters(query, scope),
      (query.interval ?? "day") as UsageTimeInterval,
    );
    return reply
      .header("Cache-Control", "no-store")
      .send({ interval: query.interval ?? "day", points });
  });

  app.get(`${base}/breakdown`, async (request, reply) => {
    const scope = scopeFromRequest(request);
    if (!(await authorize(request, reply, scope, options))) return;
    const query = queryOrBadRequest(request, reply);
    if (!query) return;
    const allowed: Record<UsageRouteScope["kind"], UsageBreakdownDimension[]> = {
      global: ["provider", "model", "project", "user", "phase"],
      user: ["provider", "model"],
      project: ["provider", "model", "user", "phase"],
      phase: ["provider", "model", "user"],
    };
    const requested = (query.dimensions ?? allowed[scope.kind].join(",")).split(",");
    const dimensions = requested.filter((value): value is UsageBreakdownDimension =>
      allowed[scope.kind].includes(value as UsageBreakdownDimension),
    );
    if (dimensions.length !== requested.length) {
      return reply.code(403).send({ error: "forbidden", message: "breakdown not available" });
    }
    return reply.header("Cache-Control", "no-store").send({
      breakdowns: await options.service.breakdown(parsedFilters(query, scope), dimensions),
    });
  });

  app.get(`${base}/events`, async (request, reply) => {
    const scope = scopeFromRequest(request);
    if (!(await authorize(request, reply, scope, options))) return;
    const query = queryOrBadRequest(request, reply);
    if (!query) return;
    return reply.header("Cache-Control", "no-store").send(
      await options.service.events(parsedFilters(query, scope), {
        ...(query.limit === undefined ? {} : { limit: query.limit }),
        ...(query.offset === undefined ? {} : { offset: query.offset }),
      }),
    );
  });

  app.get(`${base}/export.csv`, async (request, reply) => {
    const scope = scopeFromRequest(request);
    if (!(await authorize(request, reply, scope, options))) return;
    const query = queryOrBadRequest(request, reply);
    if (!query) return;
    const exported = await options.service.exportEvents(
      parsedFilters(query, scope),
      options.exportLimit,
    );
    return reply
      .header("Cache-Control", "no-store")
      .header("Content-Disposition", 'attachment; filename="ai-usage.csv"')
      .header("X-Export-Truncated", exported.truncated ? "true" : "false")
      .type("text/csv; charset=utf-8")
      .send(usageCsv(exported.events));
  });
}

export function registerUsageIntelligenceRoutes(
  app: FastifyInstance,
  options: UsageRouteOptions,
): void {
  registerScopeRoutes(app, "/api/usage", () => ({ kind: "global" }), options);
  registerScopeRoutes(
    app,
    "/api/usage/users/:scopeId",
    (request) => ({
      kind: "user",
      id: (request.params as { scopeId: string }).scopeId,
    }),
    options,
  );
  registerScopeRoutes(
    app,
    "/api/usage/projects/:scopeId",
    (request) => ({
      kind: "project",
      id: (request.params as { scopeId: string }).scopeId,
    }),
    options,
  );
  registerScopeRoutes(
    app,
    "/api/usage/phases/:scopeId",
    (request) => ({
      kind: "phase",
      id: (request.params as { scopeId: string }).scopeId,
    }),
    options,
  );
}
