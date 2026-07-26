import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import {
  UsageAnalyticsService,
  registerUsageAnalyticsRoutes,
} from "../src/usage-intelligence/analyticsIndex.js";

describe("usage calibration migration", () => {
  it("creates immutable plan and observation audit history", async () => {
    const database = new PGlite();
    await database.exec(`
      CREATE ROLE norns_app;
      CREATE TABLE norns_schema_migrations (name TEXT PRIMARY KEY);
      INSERT INTO norns_schema_migrations (name) VALUES ('0030_ai_usage_telemetry');
      CREATE TABLE users (id TEXT PRIMARY KEY);
      INSERT INTO users (id) VALUES ('admin-1');
      CREATE FUNCTION norns_reject_append_only_mutation()
      RETURNS trigger LANGUAGE plpgsql AS $guard$
      BEGIN
        RAISE EXCEPTION 'append-only';
      END
      $guard$;
    `);
    const migration = readFileSync(
      new URL("../drizzle/0033_usage_calibration_analytics.sql", import.meta.url),
      "utf8",
    );
    await database.exec(migration);
    await database.query(
      `INSERT INTO ai_provider_usage_plans (
         id, provider, plan_name, allowance_unit, allowance_amount,
         effective_from, source, created_by_user_id
       ) VALUES ('plan-1','anthropic','Team','tokens',1000,now(),'contract','admin-1')`,
    );
    await expect(
      database.query("UPDATE ai_provider_usage_plans SET allowance_amount=2000"),
    ).rejects.toThrow(/append-only/);
    await expect(database.query("DELETE FROM ai_provider_usage_plans")).rejects.toThrow(
      /append-only/,
    );
    await database.query(
      `INSERT INTO ai_usage_calibration_observations (
         id, plan_id, provider, model, subscription_tier, cycle_period,
         reset_at, cycle_start, cycle_end, observed_at,
         provider_reading_kind, provider_reading_unit, provider_reading_value,
         displayed_percentage, tokens_used_since_reset, implied_max_tokens,
         canonical_requests, canonical_input_tokens, canonical_output_tokens,
         canonical_cache_read_tokens, canonical_cache_write_tokens,
         canonical_unpriced_requests, confidence, source, recorded_by_user_id
       ) VALUES (
         'observation-1','plan-1','anthropic','claude-sonnet-5','Team',
         'weekly',now() - interval '1 day',now() - interval '1 day',
         now() + interval '6 days',now(),'utilization_percent','percent',20,
         20,100,500,1,80,20,0,0,0,0.9,'manual','admin-1'
       )`,
    );
    await expect(
      database.query("UPDATE ai_usage_calibration_observations SET provider_reading_value=200"),
    ).rejects.toThrow(/append-only/);
    await database.close();
  });
});

describe("usage analytics and deterministic optimization", () => {
  let database: PGlite;
  let service: UsageAnalyticsService;

  beforeEach(async () => {
    database = new PGlite();
    await database.exec(`
      CREATE TABLE ai_usage_events (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        status TEXT NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL,
        recorded_at TIMESTAMPTZ NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        request_type TEXT NOT NULL,
        retry_attempt INTEGER NOT NULL,
        initiated_by_user_id TEXT,
        project_id TEXT,
        phase_id TEXT,
        run_id TEXT,
        input_tokens BIGINT,
        output_tokens BIGINT,
        cache_read_tokens BIGINT,
        cache_write_tokens BIGINT,
        cost_usd NUMERIC
      );
      CREATE TABLE ai_pricing_profiles (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        pricing_version TEXT NOT NULL,
        input_per_million NUMERIC NOT NULL,
        output_per_million NUMERIC NOT NULL,
        effective_from TIMESTAMPTZ NOT NULL,
        effective_to TIMESTAMPTZ
      );
      INSERT INTO ai_pricing_profiles (
        id, provider, model, pricing_version, input_per_million,
        output_per_million, effective_from
      ) VALUES
        ('price-premium','anthropic','claude-premium','premium-v1',10,50,'2026-01-01'),
        ('price-economy','anthropic','claude-economy','economy-v1',1,5,'2026-01-01');
      CREATE TABLE ai_provider_usage_plans (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        plan_name TEXT NOT NULL,
        allowance_unit TEXT NOT NULL,
        allowance_amount NUMERIC NOT NULL,
        allowance_usd_equivalent NUMERIC,
        effective_from TIMESTAMPTZ NOT NULL,
        effective_to TIMESTAMPTZ,
        source TEXT NOT NULL,
        created_by_user_id TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE ai_usage_calibration_observations (
        id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        subscription_tier TEXT NOT NULL,
        cycle_period TEXT NOT NULL,
        reset_at TIMESTAMPTZ NOT NULL,
        cycle_start TIMESTAMPTZ NOT NULL,
        cycle_end TIMESTAMPTZ NOT NULL,
        observed_at TIMESTAMPTZ NOT NULL,
        provider_reading_kind TEXT NOT NULL,
        provider_reading_unit TEXT NOT NULL,
        provider_reading_value NUMERIC NOT NULL,
        displayed_percentage NUMERIC NOT NULL,
        tokens_used_since_reset BIGINT NOT NULL,
        implied_max_tokens NUMERIC NOT NULL,
        provider_reading_usd_equivalent NUMERIC,
        canonical_requests INTEGER NOT NULL,
        canonical_input_tokens BIGINT NOT NULL,
        canonical_output_tokens BIGINT NOT NULL,
        canonical_cache_read_tokens BIGINT NOT NULL,
        canonical_cache_write_tokens BIGINT NOT NULL,
        canonical_known_cost_usd NUMERIC,
        canonical_unpriced_requests INTEGER NOT NULL,
        confidence NUMERIC NOT NULL,
        source TEXT NOT NULL,
        evidence_note TEXT,
        recorded_by_user_id TEXT NOT NULL,
        recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    service = new UsageAnalyticsService(
      new PGliteTransactionRunner(database),
      () => new Date("2026-07-20T00:00:00.000Z"),
    );
  });

  afterEach(async () => {
    await database.close();
  });

  it("rejects an observation at the exclusive end of its usage cycle", async () => {
    const plan = await service.createPlan({
      provider: "anthropic",
      plan_name: "Team",
      allowance_unit: "tokens",
      allowance_amount: 1_000,
      allowance_usd_equivalent: null,
      effective_from: "2026-07-01T00:00:00.000Z",
      effective_to: null,
      source: "contract",
      created_by_user_id: "admin-1",
    });

    await expect(
      service.addObservation({
        plan_id: plan.id,
        provider: "anthropic",
        model: "claude-premium",
        subscription_tier: "Team",
        cycle_period: "weekly",
        reset_at: "2026-07-13T00:00:00.000Z",
        observed_at: "2026-07-20T00:00:00.000Z",
        displayed_percentage: 20,
        source: "manual",
        evidence_note: null,
        recorded_by_user_id: "admin-1",
      }),
    ).rejects.toThrow("observation time must fall within a valid usage cycle");
  });

  async function request(input: {
    id: string;
    at: string;
    provider?: string;
    model?: string;
    requestType?: string;
    user?: string;
    project?: string;
    phase?: string;
    run?: string;
    terminalAt?: string;
    retry?: number;
    inputTokens: number;
    outputTokens: number;
    cost: number;
    failed?: boolean;
  }): Promise<void> {
    const common = [
      input.at,
      input.provider ?? "anthropic",
      input.model ?? "claude-premium",
      input.requestType ?? "planning",
      input.retry ?? 0,
      input.user ?? "user-1",
      input.project ?? "project-1",
    ];
    await database.query(
      `INSERT INTO ai_usage_events (
         id, request_id, sequence, event_type, status, occurred_at, recorded_at,
         provider, model, request_type, retry_attempt, initiated_by_user_id,
         project_id, run_id, input_tokens, output_tokens, cache_read_tokens, cost_usd
       ) VALUES
         ($1,$1,1,'request_started','started',$2,$2,$3,$4,$5,$6,$7,$8,$9,NULL,NULL,NULL,NULL),
         ($10,$1,2,'usage_observed','in_progress',$2,$2,$3,$4,$5,$6,$7,$8,$9,$11,$12,0,$13),
         ($14,$1,3,$15,$16,$2,$2,$3,$4,$5,$6,$7,$8,$9,NULL,NULL,NULL,NULL)`,
      [
        input.id,
        ...common,
        input.run ?? null,
        `${input.id}-usage`,
        input.inputTokens,
        input.outputTokens,
        input.cost,
        `${input.id}-terminal`,
        input.failed ? "request_failed" : "request_completed",
        input.failed ? "failed" : "succeeded",
      ],
    );
    if (input.phase) {
      await database.query("UPDATE ai_usage_events SET phase_id=$2 WHERE request_id=$1", [
        input.id,
        input.phase,
      ]);
    }
    if (input.terminalAt) {
      await database.query(
        "UPDATE ai_usage_events SET occurred_at=$2, recorded_at=$2 WHERE id=$1",
        [`${input.id}-terminal`, input.terminalAt],
      );
    }
  }

  async function seedUsage(): Promise<void> {
    await request({
      id: "previous",
      at: "2026-07-10T12:00:00.000Z",
      inputTokens: 20_000,
      outputTokens: 2_000,
      cost: 5,
      phase: "phase-1",
    });
    await request({
      id: "current-a",
      at: "2026-07-18T12:00:00.000Z",
      inputTokens: 60_000,
      outputTokens: 5_000,
      cost: 10,
      phase: "phase-1",
    });
    await request({
      id: "current-b",
      at: "2026-07-19T12:00:00.000Z",
      retry: 1,
      inputTokens: 50_000,
      outputTokens: 4_000,
      cost: 5,
      failed: true,
      phase: "phase-1",
    });
    await request({
      id: "current-c",
      at: "2026-07-19T14:00:00.000Z",
      retry: 2,
      inputTokens: 60_000,
      outputTokens: 3_000,
      cost: 4,
      failed: true,
      phase: "phase-1",
    });
  }

  it("compares trends and reports all requested hot-spot dimensions", async () => {
    await seedUsage();
    const filter = {
      from: "2026-07-15T00:00:00.000Z",
      to: "2026-07-20T00:00:00.000Z",
    };

    const trend = await service.trends(filter);
    expect(trend.current).toMatchObject({
      requests: 3,
      failed_requests: 2,
      retried_requests: 2,
      input_tokens: 170_000,
      known_cost_usd: 19,
      average_output_tokens: 4_000,
      average_known_cost_usd: 6.333333,
    });
    expect(trend.previous.requests).toBe(1);
    expect(trend.change.requests_percent).toBe(200);

    for (const dimension of [
      "user",
      "project",
      "phase",
      "provider",
      "model",
      "request_type",
    ] as const) {
      const hotSpots = await service.hotSpots(dimension, filter);
      expect(hotSpots[0]).toMatchObject({ dimension, requests: 3, known_cost_usd: 19 });
    }
  });

  it("gives provider observations precedence over raced runtime aggregates", async () => {
    await request({
      id: "runtime-fallback",
      at: "2026-07-19T12:00:00.000Z",
      requestType: "runtime_aggregate_report",
      run: "race-run",
      inputTokens: 1_000,
      outputTokens: 200,
      cost: 0,
    });
    await request({
      id: "provider-source",
      at: "2026-07-19T12:00:01.000Z",
      requestType: "provider_native",
      run: "race-run",
      inputTokens: 100,
      outputTokens: 20,
      cost: 0.5,
    });

    await expect(service.signals()).resolves.toMatchObject({
      requests: 1,
      input_tokens: 100,
      output_tokens: 20,
      known_cost_usd: 0.5,
    });
  });

  it("uses non-overlapping start windows while retaining terminal and late adjustments", async () => {
    await request({
      id: "before",
      at: "2026-07-14T23:00:00.000Z",
      terminalAt: "2026-07-15T01:00:00.000Z",
      inputTokens: 10,
      outputTokens: 1,
      cost: 0.1,
      phase: "phase-before",
    });
    await request({
      id: "inside",
      at: "2026-07-19T12:00:00.000Z",
      terminalAt: "2026-07-20T01:00:00.000Z",
      inputTokens: 100,
      outputTokens: 10,
      cost: 1,
      phase: "phase-inside",
    });
    await database.query(
      `INSERT INTO ai_usage_events (
         id, request_id, sequence, event_type, status, occurred_at, recorded_at,
         provider, model, request_type, retry_attempt, initiated_by_user_id,
         project_id, phase_id, input_tokens, output_tokens, cache_read_tokens,
         cache_write_tokens, cost_usd
       ) VALUES (
         'inside-adjustment','inside',4,'adjustment','succeeded',
         '2026-07-21T12:00:00.000Z','2026-07-21T12:00:00.000Z',
         'anthropic','claude-premium','planning',0,'user-1','project-1',
         'phase-inside',20,5,0,0,2
       )`,
    );
    await request({
      id: "boundary",
      at: "2026-07-20T00:00:00.000Z",
      inputTokens: 30,
      outputTokens: 3,
      cost: 0.3,
      phase: "phase-boundary",
    });

    const current = await service.signals({
      from: "2026-07-15T00:00:00.000Z",
      to: "2026-07-20T00:00:00.000Z",
    });
    const adjacent = await service.signals({
      from: "2026-07-20T00:00:00.000Z",
      to: "2026-07-21T00:00:00.000Z",
    });
    const adjustmentOnly = await service.signals({
      from: "2026-07-21T00:00:00.000Z",
      to: "2026-07-22T00:00:00.000Z",
    });
    const phaseHotSpot = await service.hotSpots("phase", {
      from: "2026-07-15T00:00:00.000Z",
      to: "2026-07-20T00:00:00.000Z",
    });

    expect(current).toMatchObject({
      requests: 1,
      input_tokens: 120,
      output_tokens: 15,
      known_cost_usd: 3,
      average_output_tokens: 15,
      average_known_cost_usd: 3,
    });
    expect(adjacent.requests).toBe(1);
    expect(adjustmentOnly.requests).toBe(0);
    expect(phaseHotSpot[0]).toMatchObject({
      value: "phase-inside",
      requests: 1,
      known_cost_usd: 3,
    });
  });

  it("forecasts cycle exhaustion and calibrates canonical estimates", async () => {
    const plan = await service.createPlan({
      provider: "anthropic",
      plan_name: "Team token cycle",
      allowance_unit: "tokens",
      allowance_amount: 1_000,
      allowance_usd_equivalent: 100,
      effective_from: "2026-07-01T00:00:00.000Z",
      effective_to: null,
      source: "provider contract",
      created_by_user_id: "admin-1",
    });
    await request({
      id: "historical-cycle",
      at: "2026-07-08T12:00:00.000Z",
      inputTokens: 90,
      outputTokens: 10,
      cost: 0.1,
    });
    await request({
      id: "current-cycle-a",
      at: "2026-07-14T12:00:00.000Z",
      inputTokens: 80,
      outputTokens: 20,
      cost: 0.1,
    });
    await request({
      id: "current-cycle-b",
      at: "2026-07-16T12:00:00.000Z",
      inputTokens: 90,
      outputTokens: 10,
      cost: 0.1,
    });
    const base = {
      plan_id: plan.id,
      provider: "anthropic",
      model: "claude-premium",
      subscription_tier: "Team",
      cycle_period: "weekly" as const,
      source: "manual" as const,
      evidence_note: "Provider console reading",
      recorded_by_user_id: "admin-1",
    };
    await service.addObservation({
      ...base,
      reset_at: "2026-07-06T00:00:00.000Z",
      observed_at: "2026-07-10T00:00:00.000Z",
      displayed_percentage: 25,
    });
    await service.addObservation({
      ...base,
      reset_at: "2026-07-13T00:00:00.000Z",
      observed_at: "2026-07-15T00:00:00.000Z",
      displayed_percentage: 20,
    });
    await service.addObservation({
      ...base,
      reset_at: "2026-07-13T00:00:00.000Z",
      observed_at: "2026-07-18T00:00:00.000Z",
      displayed_percentage: 40,
    });

    const forecast = await service.forecast("anthropic");
    expect(forecast).toMatchObject({
      model: "claude-premium",
      subscription_tier: "Team",
      observed_used: 200,
      rolling_estimated_max_tokens: 466.666667,
      estimated_weekly_limit: 466.666667,
      observed_remaining: 266.666667,
      daily_burn_rate: 40,
      forecast_exhaustion_at: "2026-07-24T16:00:00.000Z",
      status: "on_track",
      observations: 3,
    });
    expect(forecast?.confidence_interval_low).not.toBeNull();
    expect(forecast?.confidence_interval_high).not.toBeNull();
    expect(forecast?.reset_history).toHaveLength(2);

    const calibration = await service.calibration("anthropic");
    expect(calibration.comparisons).toHaveLength(3);
    expect(calibration.mean_actual_to_estimated_ratio).toBe(1);
    expect(calibration.mean_absolute_error_percent).toBe(0);
  });

  it("emits deterministic, evidence-backed rules without an AI dependency", async () => {
    await seedUsage();
    const filters = {
      from: "2026-07-15T00:00:00.000Z",
      to: "2026-07-20T00:00:00.000Z",
    };

    const first = await service.recommendations(filters);
    const second = await service.recommendations(filters);

    expect(second).toEqual(first);
    expect(first.map((item) => item.category)).toEqual(
      expect.arrayContaining(["reliability", "retry", "caching", "prompt", "model", "workflow"]),
    );
    expect(first.every((item) => item.evidence.length > 0)).toBe(true);
    expect(first.every((item) => item.estimated_savings_usd >= 0)).toBe(true);
    expect(first.every((item) => item.confidence > 0 && item.confidence <= 1)).toBe(true);
    expect(first.map((item) => item.id)).toEqual(
      expect.arrayContaining(["benchmark-cheaper-model", "evaluate-parallelization"]),
    );
    expect(
      first.find((item) => item.id === "benchmark-cheaper-model")?.assumptions.join(" "),
    ).toMatch(/not realized savings/i);
    expect(
      first.find((item) => item.id === "evaluate-parallelization")?.assumptions.join(" "),
    ).toMatch(/no cost savings/i);
  });

  it("keeps analytics and calibration routes admin-only", async () => {
    await seedUsage();
    const app = Fastify();
    registerUsageAnalyticsRoutes(app, {
      service,
      requireAdmin: async (request, reply) => {
        if (request.headers["x-admin"] !== "yes") {
          reply.code(403).send({ error: "forbidden" });
          return null;
        }
        return { id: "admin-1", email: "admin@example.com" };
      },
    });

    const denied = await app.inject({ method: "GET", url: "/api/usage/analytics/signals" });
    expect(denied.statusCode).toBe(403);

    const emptyWindow = await app.inject({
      method: "GET",
      url: "/api/usage/analytics/signals?from=2026-07-20T00%3A00%3A00.000Z&to=2026-07-20T00%3A00%3A00.000Z",
      headers: { "x-admin": "yes" },
    });
    expect(emptyWindow.statusCode).toBe(400);
    expect(emptyWindow.json()).toMatchObject({ message: "from must be before to" });

    const response = await app.inject({
      method: "GET",
      url: "/api/usage/analytics/hot-spots?dimension=phase",
      headers: { "x-admin": "yes" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      dimension: "phase",
      hot_spots: [{ value: "phase-1", requests: 4 }],
    });

    const plan = await service.createPlan({
      provider: "anthropic",
      plan_name: "Team",
      allowance_unit: "tokens",
      allowance_amount: 1_000_000,
      allowance_usd_equivalent: null,
      effective_from: "2026-07-01T00:00:00.000Z",
      effective_to: null,
      source: "contract",
      created_by_user_id: "admin-1",
    });
    const observationBody = {
      plan_id: plan.id,
      provider: "anthropic",
      model: "claude-premium",
      subscription_tier: "Team",
      cycle_period: "weekly",
      reset_at: "2026-07-15T00:00:00.000Z",
      observed_at: "2026-07-20T00:00:00.000Z",
      displayed_percentage: 50,
      source: "manual",
      evidence_note: "<script>alert(1)</script> api_key=super-secret Provider console",
    };
    const inventedTotals = await app.inject({
      method: "POST",
      url: "/api/usage/calibration/observations",
      headers: { "x-admin": "yes" },
      payload: { ...observationBody, canonical_input_tokens: 1 },
    });
    expect(inventedTotals.statusCode).toBe(400);

    const recorded = await app.inject({
      method: "POST",
      url: "/api/usage/calibration/observations",
      headers: { "x-admin": "yes" },
      payload: observationBody,
    });
    expect(recorded.statusCode).toBe(201);
    expect(recorded.json()).toMatchObject({
      canonical_requests: 3,
      canonical_input_tokens: 170_000,
      canonical_output_tokens: 12_000,
      tokens_used_since_reset: 182_000,
      implied_max_tokens: 364_000,
    });
    expect(recorded.json().evidence_note).not.toMatch(/script|super-secret/i);
    expect(recorded.json().evidence_note).toContain("api_key=[redacted]");
    await app.close();
  });
});
