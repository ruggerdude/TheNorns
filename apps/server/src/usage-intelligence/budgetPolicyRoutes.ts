import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type {
  UsageBudgetPeriod,
  UsageBudgetPolicy,
  UsageBudgetPolicyStatus,
  UsageBudgetScopeType,
  UsageBudgetThresholdNotification,
} from "./budgetPolicyRepository.js";
import {
  type UsageBudgetEvaluation,
  UsageBudgetPolicyError,
  type UsageBudgetPolicyService,
} from "./budgetPolicyService.js";

export interface UsageBudgetRouteUser {
  id: string;
  role: "admin" | "member";
}

export interface UsageBudgetRouteScope {
  type: UsageBudgetScopeType;
  id: string | null;
}

export interface UsageBudgetPolicyRouteOptions {
  service: UsageBudgetPolicyService;
  resolveUser: (request: FastifyRequest) => Promise<UsageBudgetRouteUser | undefined>;
  authorizeProject?: (
    user: UsageBudgetRouteUser,
    projectId: string,
    action: "read" | "manage",
  ) => Promise<boolean>;
}

const ScopeType = z.enum(["global", "user", "project"]);
const Period = z.enum(["daily", "weekly", "monthly"]);
const Status = z.enum(["active", "disabled"]);
const Thresholds = z.array(z.number().int().min(1).max(100)).min(1);

const CreateBody = z
  .object({
    scope_type: ScopeType,
    scope_id: z.string().trim().min(1).nullable().optional(),
    period: Period,
    provider: z.string().trim().min(1).max(200).nullable().optional(),
    model: z.string().trim().min(1).max(300).nullable().optional(),
    limit_usd: z.number().positive().finite().nullable().optional(),
    limit_tokens: z.number().int().positive().safe().nullable().optional(),
    threshold_percentages: Thresholds.optional(),
  })
  .strict();

const UpdateBody = z
  .object({
    limit_usd: z.number().positive().finite().nullable().optional(),
    limit_tokens: z.number().int().positive().safe().nullable().optional(),
    threshold_percentages: Thresholds.optional(),
    status: Status.optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, "at least one update is required");

const EvaluateBody = z
  .object({
    policy_id: z.string().trim().min(1).optional(),
  })
  .strict();

const ListQuery = z
  .object({
    scope_type: ScopeType.optional(),
    scope_id: z.string().trim().min(1).optional(),
    status: Status.optional(),
    policy_id: z.string().trim().min(1).optional(),
    delivery_status: z.enum(["ready", "delivered", "dismissed"]).optional(),
  })
  .strict();

function policyDto(policy: UsageBudgetPolicy) {
  return {
    id: policy.id,
    schema_version: 1,
    scope_type: policy.scopeType,
    scope_id: policy.scopeId,
    period: policy.period,
    provider: policy.provider,
    model: policy.model,
    limit_usd: policy.limitUsd,
    limit_tokens: policy.limitTokens,
    threshold_percentages: policy.thresholdPercentages,
    status: policy.status,
    created_by_user_id: policy.createdByUserId,
    created_at: policy.createdAt,
    updated_at: policy.updatedAt,
  };
}

function notificationDto(notification: UsageBudgetThresholdNotification) {
  return {
    id: notification.id,
    schema_version: 1,
    policy_id: notification.policyId,
    period_start: notification.periodStart,
    period_end: notification.periodEnd,
    threshold_percentage: notification.thresholdPercentage,
    metric: notification.metric,
    consumed_usd: notification.consumedUsd,
    consumed_tokens: notification.consumedTokens,
    unpriced_requests: notification.unpricedRequests,
    limit_usd: notification.limitUsd,
    limit_tokens: notification.limitTokens,
    delivery_status: notification.deliveryStatus,
    created_at: notification.createdAt,
  };
}

function evaluationDto(evaluation: UsageBudgetEvaluation) {
  return {
    policy: policyDto(evaluation.policy),
    period_start: evaluation.periodStart,
    period_end: evaluation.periodEnd,
    evaluated_at: evaluation.evaluatedAt,
    consumed_usd: evaluation.consumedUsd,
    consumed_tokens: evaluation.consumedTokens,
    unpriced_requests: evaluation.unpricedRequests,
    usd_complete: evaluation.usdComplete,
    notifications_created: evaluation.notificationsCreated.map(notificationDto),
  };
}

function handlePolicyError(reply: FastifyReply, error: unknown): void {
  if (!(error instanceof UsageBudgetPolicyError)) throw error;
  const status = error.code === "policy_not_found" ? 404 : 422;
  reply.code(status).send({ error: error.code, message: error.message });
}

async function routeUser(
  request: FastifyRequest,
  reply: FastifyReply,
  options: UsageBudgetPolicyRouteOptions,
): Promise<UsageBudgetRouteUser | null> {
  const user = await options.resolveUser(request);
  if (!user) {
    reply.code(401).send({ error: "unauthorized" });
    return null;
  }
  return user;
}

async function authorizeScope(
  user: UsageBudgetRouteUser,
  scope: UsageBudgetRouteScope,
  action: "read" | "manage",
  options: UsageBudgetPolicyRouteOptions,
): Promise<boolean> {
  if (user.role === "admin") return true;
  if (scope.type === "global") return false;
  if (scope.type === "user") return action === "read" && scope.id === user.id;
  return scope.id !== null && (await options.authorizeProject?.(user, scope.id, action)) === true;
}

function scopeOf(policy: UsageBudgetPolicy): UsageBudgetRouteScope {
  return { type: policy.scopeType, id: policy.scopeId };
}

function queryScope(query: z.infer<typeof ListQuery>): UsageBudgetRouteScope | null {
  if (!query.scope_type) return null;
  return { type: query.scope_type, id: query.scope_id ?? null };
}

async function authorizeList(
  user: UsageBudgetRouteUser,
  query: z.infer<typeof ListQuery>,
  reply: FastifyReply,
  options: UsageBudgetPolicyRouteOptions,
): Promise<boolean> {
  if (user.role === "admin") return true;
  const scope = queryScope(query);
  if (!scope || !(await authorizeScope(user, scope, "read", options))) {
    reply.code(403).send({ error: "forbidden" });
    return false;
  }
  return true;
}

function badRequest(reply: FastifyReply, error: z.ZodError): FastifyReply {
  return reply.code(400).send({ error: "bad_request", issues: error.issues });
}

export function registerUsageBudgetPolicyRoutes(
  app: FastifyInstance,
  options: UsageBudgetPolicyRouteOptions,
): void {
  app.get("/api/usage/budgets", async (request, reply) => {
    const user = await routeUser(request, reply, options);
    if (!user) return;
    const query = ListQuery.safeParse(request.query);
    if (!query.success) return badRequest(reply, query.error);
    if (!(await authorizeList(user, query.data, reply, options))) return;
    const policies = await options.service.list({
      ...(query.data.scope_type ? { scopeType: query.data.scope_type } : {}),
      ...(query.data.scope_id ? { scopeId: query.data.scope_id } : {}),
      ...(query.data.status ? { status: query.data.status } : {}),
    });
    reply.header("Cache-Control", "no-store").send({ policies: policies.map(policyDto) });
  });

  app.post("/api/usage/budgets", async (request, reply) => {
    const user = await routeUser(request, reply, options);
    if (!user) return;
    const body = CreateBody.safeParse(request.body);
    if (!body.success) return badRequest(reply, body.error);
    const scope = {
      type: body.data.scope_type,
      id: body.data.scope_id ?? null,
    } satisfies UsageBudgetRouteScope;
    if (!(await authorizeScope(user, scope, "manage", options))) {
      return reply.code(403).send({ error: "forbidden" });
    }
    try {
      const created = await options.service.create({
        scopeType: body.data.scope_type,
        period: body.data.period as UsageBudgetPeriod,
        createdByUserId: user.id,
        ...(body.data.scope_id === undefined ? {} : { scopeId: body.data.scope_id }),
        ...(body.data.provider === undefined ? {} : { provider: body.data.provider }),
        ...(body.data.model === undefined ? {} : { model: body.data.model }),
        ...(body.data.limit_usd === undefined ? {} : { limitUsd: body.data.limit_usd }),
        ...(body.data.limit_tokens === undefined ? {} : { limitTokens: body.data.limit_tokens }),
        ...(body.data.threshold_percentages === undefined
          ? {}
          : { thresholdPercentages: body.data.threshold_percentages }),
      });
      reply.code(201).send(policyDto(created));
    } catch (error) {
      handlePolicyError(reply, error);
    }
  });

  app.patch("/api/usage/budgets/:policyId", async (request, reply) => {
    const user = await routeUser(request, reply, options);
    if (!user) return;
    const body = UpdateBody.safeParse(request.body);
    if (!body.success) return badRequest(reply, body.error);
    const { policyId } = request.params as { policyId: string };
    try {
      const policy = await options.service.get(policyId);
      if (!(await authorizeScope(user, scopeOf(policy), "manage", options))) {
        return reply.code(403).send({ error: "forbidden" });
      }
      const updated = await options.service.update(policyId, {
        ...(body.data.limit_usd === undefined ? {} : { limitUsd: body.data.limit_usd }),
        ...(body.data.limit_tokens === undefined ? {} : { limitTokens: body.data.limit_tokens }),
        ...(body.data.threshold_percentages === undefined
          ? {}
          : { thresholdPercentages: body.data.threshold_percentages }),
        ...(body.data.status === undefined
          ? {}
          : { status: body.data.status as UsageBudgetPolicyStatus }),
      });
      reply.send(policyDto(updated));
    } catch (error) {
      handlePolicyError(reply, error);
    }
  });

  app.post("/api/usage/budgets/evaluate", async (request, reply) => {
    const user = await routeUser(request, reply, options);
    if (!user) return;
    const body = EvaluateBody.safeParse(request.body ?? {});
    if (!body.success) return badRequest(reply, body.error);
    try {
      if (body.data.policy_id) {
        const policy = await options.service.get(body.data.policy_id);
        if (!(await authorizeScope(user, scopeOf(policy), "manage", options))) {
          return reply.code(403).send({ error: "forbidden" });
        }
      } else if (user.role !== "admin") {
        return reply.code(403).send({ error: "forbidden" });
      }
      const evaluations = await options.service.evaluate(body.data.policy_id);
      reply.send({ evaluations: evaluations.map(evaluationDto) });
    } catch (error) {
      handlePolicyError(reply, error);
    }
  });

  app.get("/api/usage/budget-notifications", async (request, reply) => {
    const user = await routeUser(request, reply, options);
    if (!user) return;
    const query = ListQuery.safeParse(request.query);
    if (!query.success) return badRequest(reply, query.error);
    if (!(await authorizeList(user, query.data, reply, options))) return;
    const notifications = await options.service.notifications({
      ...(query.data.scope_type ? { scopeType: query.data.scope_type } : {}),
      ...(query.data.scope_id ? { scopeId: query.data.scope_id } : {}),
      ...(query.data.status ? { status: query.data.status } : {}),
      ...(query.data.policy_id ? { policyId: query.data.policy_id } : {}),
      ...(query.data.delivery_status ? { deliveryStatus: query.data.delivery_status } : {}),
    });
    reply
      .header("Cache-Control", "no-store")
      .send({ notifications: notifications.map(notificationDto) });
  });
}
