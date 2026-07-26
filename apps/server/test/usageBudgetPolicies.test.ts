import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import {
  type V2MigrationDatabase,
  runCurrentV2Migrations,
  runV2Migrations,
} from "../src/persistence/v2/migrate.js";
import { PostgresUsageBudgetPolicyRepository } from "../src/usage-intelligence/budgetPolicyRepository.js";
import { registerUsageBudgetPolicyRoutes } from "../src/usage-intelligence/budgetPolicyRoutes.js";
import {
  UsageBudgetPolicyService,
  usageBudgetPeriodBounds,
} from "../src/usage-intelligence/budgetPolicyService.js";

const migrationUrl = new URL("../drizzle/0032_usage_intelligence_policies.sql", import.meta.url);
const evaluatedAt = new Date("2026-07-22T12:00:00.000Z");

interface EventInput {
  id: string;
  requestId: string;
  sequence: number;
  eventType: "request_started" | "usage_observed" | "request_completed" | "adjustment";
  occurredAt: string;
  provider?: string;
  model?: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  costUsd?: number | null;
  costClassification?: "actual" | "subscription_consumption" | "unavailable";
  usageSource?: "provider_api" | "manual_adjustment" | "unavailable";
  adjustsEventId?: string | null;
}

describe.sequential("usage-intelligence period budget policies", () => {
  let pg: PGlite;
  let service: UsageBudgetPolicyService;
  let app: FastifyInstance;
  let idCounter = 0;
  let globalPolicyId: string;
  let projectPolicyId: string;

  async function appendEvent(input: EventInput): Promise<void> {
    const lifecycleStatus = {
      request_started: "started",
      usage_observed: "in_progress",
      request_completed: "succeeded",
      adjustment: "adjusted",
    } as const;
    await pg.query(
      `INSERT INTO ai_usage_events (
         id, request_id, sequence, event_type, status, occurred_at,
         provider, model, endpoint, request_type, initiated_by_user_id,
         project_id, usage_source, confidence, input_tokens, output_tokens,
         cache_read_tokens, cache_write_tokens, cost_usd, cost_classification,
         adjusts_event_id
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,'/v1/responses','completion','member',
         'project-budget',$9,1,$10,$11,$12,$13,$14,$15,$16
       )`,
      [
        input.id,
        input.requestId,
        input.sequence,
        input.eventType,
        lifecycleStatus[input.eventType],
        input.occurredAt,
        input.provider ?? "openai",
        input.model ?? "gpt-budget",
        input.usageSource ??
          (input.eventType === "usage_observed" ? "provider_api" : "unavailable"),
        input.inputTokens ?? null,
        input.outputTokens ?? null,
        input.cacheReadTokens ?? null,
        input.cacheWriteTokens ?? null,
        input.costUsd ?? null,
        input.costClassification ??
          (input.eventType === "usage_observed" ? "actual" : "unavailable"),
        input.adjustsEventId ?? null,
      ],
    );
  }

  async function appendMeasuredRequest(input: {
    requestId: string;
    occurredAt: string;
    provider?: string;
    model?: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number | null;
  }): Promise<void> {
    await appendEvent({
      id: `${input.requestId}-start`,
      requestId: input.requestId,
      sequence: 1,
      eventType: "request_started",
      occurredAt: input.occurredAt,
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.model ? { model: input.model } : {}),
    });
    await appendEvent({
      id: `${input.requestId}-usage`,
      requestId: input.requestId,
      sequence: 2,
      eventType: "usage_observed",
      occurredAt: input.occurredAt,
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.model ? { model: input.model } : {}),
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: input.costUsd,
      costClassification: input.costUsd === null ? "subscription_consumption" : "actual",
    });
    await appendEvent({
      id: `${input.requestId}-complete`,
      requestId: input.requestId,
      sequence: 3,
      eventType: "request_completed",
      occurredAt: input.occurredAt,
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.model ? { model: input.model } : {}),
    });
  }

  async function post(url: string, user: string, payload: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url,
      headers: { "x-test-user": user },
      payload,
    });
  }

  beforeAll(async () => {
    pg = new PGlite();
    await pg.exec("CREATE ROLE norns_app NOLOGIN");
    await runCurrentV2Migrations(pg as unknown as V2MigrationDatabase);
    await pg.exec(`
      INSERT INTO users (
        id, username, display_name, email, name, password_hash,
        password_hash_scheme, role, status
      ) VALUES
        ('admin','admin@example.com','Admin','admin@example.com','Admin',
         'hash','scrypt-v1','admin','active'),
        ('member','member@example.com','Member','member@example.com','Member',
         'hash','scrypt-v1','member','active'),
        ('outsider','outsider@example.com','Outsider','outsider@example.com','Outsider',
         'hash','scrypt-v1','member','active');
      INSERT INTO projects (
        id, name, status, assignment_policy_ref, verification_policy_ref, budget_policy_ref
      ) VALUES (
        'project-budget','Budget Project','active',
        'assignment/default','verification/default','budget/default'
      );
    `);
    const migrationSql = await readFile(migrationUrl, "utf8");
    await runV2Migrations(pg as unknown as V2MigrationDatabase, [
      { name: "0032_usage_intelligence_policies", sql: migrationSql },
    ]);

    await appendEvent({
      id: "current-start",
      requestId: "current",
      sequence: 1,
      eventType: "request_started",
      occurredAt: "2026-07-22T10:00:00.000Z",
    });
    await appendEvent({
      id: "current-usage-1",
      requestId: "current",
      sequence: 2,
      eventType: "usage_observed",
      occurredAt: "2026-07-22T10:01:00.000Z",
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 6,
    });
    await appendEvent({
      id: "current-usage-2",
      requestId: "current",
      sequence: 3,
      eventType: "usage_observed",
      occurredAt: "2026-07-22T10:02:00.000Z",
      inputTokens: 200,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 12,
    });
    await appendEvent({
      id: "current-complete",
      requestId: "current",
      sequence: 4,
      eventType: "request_completed",
      occurredAt: "2026-07-22T10:03:00.000Z",
    });
    await appendEvent({
      id: "current-adjustment",
      requestId: "current",
      sequence: 5,
      eventType: "adjustment",
      occurredAt: "2026-07-22T10:04:00.000Z",
      inputTokens: -20,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: -2,
      costClassification: "actual",
      usageSource: "manual_adjustment",
      adjustsEventId: "current-usage-2",
    });
    await appendMeasuredRequest({
      requestId: "subscription",
      occurredAt: "2026-07-22T11:00:00.000Z",
      provider: "anthropic",
      model: "claude-budget",
      inputTokens: 300,
      outputTokens: 100,
      costUsd: null,
    });
    await appendMeasuredRequest({
      requestId: "week-old",
      occurredAt: "2026-07-20T09:00:00.000Z",
      inputTokens: 400,
      outputTokens: 100,
      costUsd: 20,
    });
    await appendMeasuredRequest({
      requestId: "prior-week",
      occurredAt: "2026-07-19T09:00:00.000Z",
      inputTokens: 900,
      outputTokens: 100,
      costUsd: 40,
    });

    const transactions = new PGliteTransactionRunner(pg);
    service = new UsageBudgetPolicyService(new PostgresUsageBudgetPolicyRepository(transactions), {
      clock: () => new Date(evaluatedAt),
      newId: (prefix) => `${prefix}-${++idCounter}`,
    });
    app = Fastify({ logger: false });
    registerUsageBudgetPolicyRoutes(app, {
      service,
      resolveUser: async (request) => {
        const header = request.headers["x-test-user"];
        const id = Array.isArray(header) ? header[0] : header;
        if (!id) return undefined;
        return { id, role: id === "admin" ? "admin" : "member" };
      },
      authorizeProject: async (user, projectId, action) =>
        user.id === "member" && projectId === "project-budget" && action === "read",
    });
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await pg.close();
  });

  it("computes UTC daily, ISO-weekly, and monthly boundaries", () => {
    expect(usageBudgetPeriodBounds("daily", evaluatedAt)).toEqual({
      start: "2026-07-22T00:00:00.000Z",
      end: "2026-07-23T00:00:00.000Z",
    });
    expect(usageBudgetPeriodBounds("weekly", evaluatedAt)).toEqual({
      start: "2026-07-20T00:00:00.000Z",
      end: "2026-07-27T00:00:00.000Z",
    });
    expect(usageBudgetPeriodBounds("monthly", evaluatedAt)).toEqual({
      start: "2026-07-01T00:00:00.000Z",
      end: "2026-08-01T00:00:00.000Z",
    });
  });

  it("configures scoped policies through authenticated routes", async () => {
    expect((await app.inject({ method: "GET", url: "/api/usage/budgets" })).statusCode).toBe(401);
    expect(
      (
        await post("/api/usage/budgets", "member", {
          scope_type: "user",
          scope_id: "member",
          period: "daily",
          limit_tokens: 1000,
        })
      ).statusCode,
    ).toBe(403);

    const global = await post("/api/usage/budgets", "admin", {
      scope_type: "global",
      period: "daily",
      provider: "openai",
      model: "gpt-budget",
      limit_usd: 10,
      limit_tokens: 560,
    });
    expect(global.statusCode).toBe(201);
    expect(global.json()).toMatchObject({
      scope_type: "global",
      period: "daily",
      threshold_percentages: [50, 75, 90, 100],
    });
    globalPolicyId = (global.json() as { id: string }).id;

    const project = await post("/api/usage/budgets", "admin", {
      scope_type: "project",
      scope_id: "project-budget",
      period: "daily",
      limit_usd: 100,
      limit_tokens: 1000,
    });
    expect(project.statusCode).toBe(201);
    projectPolicyId = (project.json() as { id: string }).id;
    expect(
      (
        await post("/api/usage/budgets", "admin", {
          scope_type: "user",
          scope_id: "member",
          period: "weekly",
          limit_usd: 60,
          limit_tokens: 2000,
        })
      ).statusCode,
    ).toBe(201);

    const invalidThresholds = await app.inject({
      method: "PATCH",
      url: `/api/usage/budgets/${globalPolicyId}`,
      headers: { "x-test-user": "admin" },
      payload: { threshold_percentages: [75, 50] },
    });
    expect(invalidThresholds.statusCode).toBe(422);

    const updatedProject = await app.inject({
      method: "PATCH",
      url: `/api/usage/budgets/${projectPolicyId}`,
      headers: { "x-test-user": "admin" },
      payload: { threshold_percentages: [60, 100] },
    });
    expect(updatedProject.statusCode).toBe(200);
    expect(updatedProject.json()).toMatchObject({ threshold_percentages: [60, 100] });

    const ownPolicies = await app.inject({
      method: "GET",
      url: "/api/usage/budgets?scope_type=user&scope_id=member",
      headers: { "x-test-user": "member" },
    });
    expect(ownPolicies.statusCode).toBe(200);
    expect((ownPolicies.json() as { policies: unknown[] }).policies).toHaveLength(1);

    const forbiddenGlobal = await app.inject({
      method: "GET",
      url: "/api/usage/budgets?scope_type=global",
      headers: { "x-test-user": "member" },
    });
    expect(forbiddenGlobal.statusCode).toBe(403);
  });

  it("evaluates canonical request facts once and deduplicates every threshold", async () => {
    const first = await post("/api/usage/budgets/evaluate", "admin", {});
    expect(first.statusCode).toBe(200);
    const evaluations = (first.json() as { evaluations: Array<Record<string, unknown>> })
      .evaluations;
    expect(evaluations).toHaveLength(3);

    const global = evaluations.find(
      (item) => (item.policy as { scope_type: string }).scope_type === "global",
    );
    expect(global).toMatchObject({
      consumed_usd: 10,
      consumed_tokens: 280,
      unpriced_requests: 0,
      usd_complete: true,
    });
    expect((global?.notifications_created as unknown[]).length).toBe(5);

    const project = evaluations.find(
      (item) => (item.policy as { scope_type: string }).scope_type === "project",
    );
    expect(project).toMatchObject({
      consumed_usd: 10,
      consumed_tokens: 680,
      unpriced_requests: 1,
      usd_complete: false,
    });
    expect((project?.notifications_created as unknown[]).length).toBe(1);

    const user = evaluations.find(
      (item) => (item.policy as { scope_type: string }).scope_type === "user",
    );
    expect(user).toMatchObject({
      consumed_usd: 30,
      consumed_tokens: 1180,
      unpriced_requests: 1,
      usd_complete: false,
    });
    expect((user?.notifications_created as unknown[]).length).toBe(2);

    const second = await post("/api/usage/budgets/evaluate", "admin", {});
    expect(second.statusCode).toBe(200);
    expect(
      (
        second.json() as { evaluations: Array<{ notifications_created: unknown[] }> }
      ).evaluations.flatMap((item) => item.notifications_created),
    ).toHaveLength(0);

    const count = await pg.query<{ count: string | number }>(
      "SELECT count(*) AS count FROM usage_budget_threshold_notifications",
    );
    expect(Number(count.rows[0]?.count)).toBe(8);

    const ownNotifications = await app.inject({
      method: "GET",
      url: "/api/usage/budget-notifications?scope_type=user&scope_id=member",
      headers: { "x-test-user": "member" },
    });
    expect(ownNotifications.statusCode).toBe(200);
    expect((ownNotifications.json() as { notifications: unknown[] }).notifications).toHaveLength(2);
  });
});
