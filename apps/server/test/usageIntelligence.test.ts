import { PGlite } from "@electric-sql/pglite";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  UsageIntelligenceService,
  registerUsageIntelligenceRoutes,
} from "../src/usage-intelligence/index.js";

interface UsageEventFixture {
  id: string;
  request: string;
  sequence: number;
  type:
    | "request_started"
    | "usage_observed"
    | "request_completed"
    | "request_failed"
    | "adjustment";
  at: string;
  provider?: string;
  model?: string;
  user?: string | null;
  project?: string | null;
  phase?: string | null;
  run?: string | null;
  requestType?: string | null;
  input?: number | null;
  output?: number | null;
  cacheRead?: number | null;
  cacheWrite?: number | null;
  cost?: number | null;
  latency?: number | null;
}

describe("AI usage intelligence", () => {
  let database: PGlite;
  let service: UsageIntelligenceService;

  beforeEach(async () => {
    database = new PGlite();
    await database.exec(`
      CREATE TABLE ai_usage_events (
        id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL DEFAULT 1,
        request_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        status TEXT,
        occurred_at TIMESTAMPTZ NOT NULL,
        recorded_at TIMESTAMPTZ NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        provider_request_id TEXT,
        endpoint TEXT,
        request_type TEXT,
        retry_group_id TEXT,
        retry_attempt INTEGER,
        initiated_by_user_id TEXT,
        project_id TEXT,
        phase_id TEXT,
        task_id TEXT,
        run_id TEXT,
        usage_source TEXT,
        confidence TEXT,
        pricing_profile_id TEXT,
        input_tokens BIGINT,
        output_tokens BIGINT,
        cache_read_tokens BIGINT,
        cache_write_tokens BIGINT,
        cost_usd NUMERIC,
        cost_classification TEXT,
        latency_ms INTEGER,
        http_status INTEGER,
        error_code TEXT,
        error_category TEXT,
        error_message_redacted TEXT,
        sanitized_error JSONB,
        adjusts_event_id TEXT
      )
    `);
    service = new UsageIntelligenceService(database);
  });

  afterEach(async () => {
    await database.close();
  });

  async function insert(fixture: UsageEventFixture): Promise<void> {
    await database.query(
      `INSERT INTO ai_usage_events (
         id, request_id, sequence, event_type, status, occurred_at, recorded_at,
         provider, model, initiated_by_user_id, project_id, phase_id,
         run_id, request_type, usage_source, confidence, input_tokens, output_tokens,
         cache_read_tokens, cache_write_tokens, cost_usd, cost_classification,
         latency_ms
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $6, $7, $8, $9, $10, $11,
         $12, $13, 'provider_api', 1, $14, $15, $16, $17, $18,
         CASE WHEN $18::NUMERIC IS NULL THEN 'unavailable' ELSE 'actual' END, $19
       )`,
      [
        fixture.id,
        fixture.request,
        fixture.sequence,
        fixture.type,
        fixture.type === "request_failed"
          ? "failed"
          : fixture.type === "request_completed"
            ? "succeeded"
            : "in_progress",
        fixture.at,
        fixture.provider ?? "anthropic",
        fixture.model ?? "claude-sonnet-5",
        fixture.user ?? "user-1",
        fixture.project ?? "project-1",
        fixture.phase ?? "phase-1",
        fixture.run ?? null,
        fixture.requestType ?? "completion",
        fixture.input ?? null,
        fixture.output ?? null,
        fixture.cacheRead ?? null,
        fixture.cacheWrite ?? null,
        fixture.cost ?? null,
        fixture.latency ?? null,
      ],
    );
  }

  async function seed(): Promise<void> {
    const day = "2026-07-20T12:00:00.000Z";
    await insert({ id: "a1", request: "request-a", sequence: 1, type: "request_started", at: day });
    await insert({
      id: "a2",
      request: "request-a",
      sequence: 2,
      type: "usage_observed",
      at: day,
      input: 100,
      output: 20,
      cacheRead: 10,
      cacheWrite: 5,
      cost: 0.01,
    });
    await insert({
      id: "a3",
      request: "request-a",
      sequence: 3,
      type: "usage_observed",
      at: day,
      input: 150,
      output: 25,
      cacheRead: 15,
      cacheWrite: 5,
      cost: 0.015,
    });
    await insert({
      id: "a4",
      request: "request-a",
      sequence: 4,
      type: "request_completed",
      at: day,
      latency: 200,
    });
    await insert({
      id: "a5",
      request: "request-a",
      sequence: 5,
      type: "adjustment",
      at: day,
      input: -10,
      output: 0,
      cacheRead: -2,
      cacheWrite: 0,
      cost: -0.001,
    });

    await insert({
      id: "b1",
      request: "request-b",
      sequence: 1,
      type: "request_started",
      at: "2026-07-21T12:00:00.000Z",
      provider: "openai",
      model: "gpt-5.6-terra",
    });
    await insert({
      id: "b2",
      request: "request-b",
      sequence: 2,
      type: "usage_observed",
      at: "2026-07-21T12:00:00.000Z",
      provider: "openai",
      model: "gpt-5.6-terra",
      input: 50,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      cost: null,
    });
    await insert({
      id: "b3",
      request: "request-b",
      sequence: 3,
      type: "request_failed",
      at: "2026-07-21T12:00:00.000Z",
      provider: "openai",
      model: "gpt-5.6-terra",
      latency: 400,
    });

    await insert({
      id: "c1",
      request: "request-c",
      sequence: 1,
      type: "request_started",
      at: day,
      project: "project-2",
      phase: "phase-2",
    });
  }

  it("uses only the latest cumulative observation and then applies signed adjustments", async () => {
    await seed();

    const summary = await service.summary({ projectId: "project-1" });

    expect(summary).toEqual({
      requests: 2,
      succeeded_requests: 1,
      failed_requests: 1,
      in_progress_requests: 0,
      input_tokens: 190,
      output_tokens: 35,
      cache_read_tokens: 13,
      cache_write_tokens: 5,
      cost_usd: null,
      known_cost_usd: 0.014,
      priced_requests: 1,
      unpriced_requests: 1,
      average_latency_ms: 300,
      average_output_tokens: 17.5,
      average_known_cost_usd: 0.014,
    });
  });

  it("attributes half-open windows to request start and reads the complete lifecycle", async () => {
    await insert({
      id: "before-start",
      request: "before",
      sequence: 1,
      type: "request_started",
      at: "2026-07-19T23:00:00.000Z",
    });
    await insert({
      id: "before-terminal",
      request: "before",
      sequence: 2,
      type: "request_completed",
      at: "2026-07-20T01:00:00.000Z",
    });
    await insert({
      id: "inside-start",
      request: "inside",
      sequence: 1,
      type: "request_started",
      at: "2026-07-20T12:00:00.000Z",
    });
    await insert({
      id: "inside-usage",
      request: "inside",
      sequence: 2,
      type: "usage_observed",
      at: "2026-07-20T12:05:00.000Z",
      input: 100,
      output: 20,
      cost: 1,
    });
    await insert({
      id: "inside-terminal",
      request: "inside",
      sequence: 3,
      type: "request_completed",
      at: "2026-07-21T01:00:00.000Z",
      latency: 300,
    });
    await insert({
      id: "inside-adjustment",
      request: "inside",
      sequence: 4,
      type: "adjustment",
      at: "2026-07-22T12:00:00.000Z",
      provider: "openai",
      input: -10,
      output: 5,
      cost: 0.25,
    });
    await insert({
      id: "boundary-start",
      request: "boundary",
      sequence: 1,
      type: "request_started",
      at: "2026-07-21T00:00:00.000Z",
    });

    const currentWindow = {
      from: "2026-07-20T00:00:00.000Z",
      to: "2026-07-21T00:00:00.000Z",
      provider: "anthropic",
    };
    const current = await service.summary(currentWindow);
    const adjacent = await service.summary({
      from: currentWindow.to,
      to: "2026-07-22T00:00:00.000Z",
      provider: "anthropic",
    });
    const adjustmentOnly = await service.summary({
      from: "2026-07-22T00:00:00.000Z",
      to: "2026-07-23T00:00:00.000Z",
      provider: "anthropic",
    });
    const lifecycle = await service.events(currentWindow, { limit: 10 });

    expect(current).toMatchObject({
      requests: 1,
      succeeded_requests: 1,
      input_tokens: 90,
      output_tokens: 25,
      known_cost_usd: 1.25,
      average_output_tokens: 25,
      average_known_cost_usd: 1.25,
    });
    expect(adjacent.requests).toBe(1);
    expect(adjustmentOnly.requests).toBe(0);
    expect(lifecycle.events.map((event) => event.id)).toEqual([
      "inside-adjustment",
      "inside-terminal",
      "inside-usage",
      "inside-start",
    ]);
  });

  it("filters by terminal request status without dropping lifecycle rows", async () => {
    await seed();

    const summary = await service.summary({
      projectId: "project-1",
      status: "succeeded",
    });

    expect(summary.requests).toBe(1);
    expect(summary.input_tokens).toBe(140);
    expect(summary.output_tokens).toBe(25);
    expect(summary.cost_usd).toBe(0.014);
    expect(summary.failed_requests).toBe(0);
  });

  it("returns chronological time buckets and bounded event pages", async () => {
    await seed();

    const points = await service.timeSeries({ projectId: "project-1" });
    const breakdowns = await service.breakdown({ projectId: "project-1" }, [
      "provider",
      "model",
      "user",
    ]);
    const firstPage = await service.events({ projectId: "project-1" }, { limit: 2 });

    expect(points).toHaveLength(2);
    expect(points[0]).toMatchObject({
      bucket: "2026-07-20T00:00:00.000Z",
      requests: 1,
      input_tokens: 140,
      known_cost_usd: 0.014,
    });
    expect(points[1]).toMatchObject({
      bucket: "2026-07-21T00:00:00.000Z",
      requests: 1,
      cost_usd: null,
      unpriced_requests: 1,
    });
    expect(firstPage.events).toHaveLength(2);
    expect(firstPage.has_more).toBe(true);
    expect(breakdowns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ dimension: "provider", value: "anthropic", requests: 1 }),
        expect.objectContaining({ dimension: "provider", value: "openai", requests: 1 }),
        expect.objectContaining({ dimension: "model", value: "claude-sonnet-5", requests: 1 }),
        expect.objectContaining({ dimension: "user", value: "user-1", requests: 2 }),
      ]),
    );
  });

  it("suppresses a raced runtime aggregate when provider telemetry exists for the run", async () => {
    const at = "2026-07-22T12:00:00.000Z";
    for (const fixture of [
      {
        id: "runtime-start",
        request: "runtime-request",
        sequence: 1,
        type: "request_started" as const,
        requestType: "runtime_aggregate_report",
      },
      {
        id: "runtime-usage",
        request: "runtime-request",
        sequence: 2,
        type: "usage_observed" as const,
        requestType: "runtime_aggregate_report",
        input: 1_000,
        output: 200,
      },
      {
        id: "runtime-terminal",
        request: "runtime-request",
        sequence: 3,
        type: "request_completed" as const,
        requestType: "runtime_aggregate_report",
      },
      {
        id: "provider-start",
        request: "provider-request",
        sequence: 1,
        type: "request_started" as const,
        requestType: "provider_native",
      },
      {
        id: "provider-usage",
        request: "provider-request",
        sequence: 2,
        type: "usage_observed" as const,
        requestType: "provider_native",
        input: 100,
        output: 20,
        cost: 0.5,
      },
      {
        id: "provider-terminal",
        request: "provider-request",
        sequence: 3,
        type: "request_completed" as const,
        requestType: "provider_native",
      },
    ]) {
      await insert({ ...fixture, at, run: "shared-run" });
    }

    const summary = await service.summary();
    const events = await service.events();

    expect(summary).toMatchObject({
      requests: 1,
      input_tokens: 100,
      output_tokens: 20,
      known_cost_usd: 0.5,
    });
    expect(events.events.map((event) => event.id).sort()).toEqual([
      "provider-start",
      "provider-terminal",
      "provider-usage",
    ]);
  });

  it("enforces global/self scope and produces injection-safe bounded CSV", async () => {
    await seed();
    await database.query(
      "UPDATE ai_usage_events SET provider = '=HYPERLINK(\"https://bad.invalid\")'",
    );
    const app = Fastify();
    registerUsageIntelligenceRoutes(app, {
      service,
      exportLimit: 2,
      resolveUser: async (request) => {
        const role = request.headers["x-test-role"];
        return {
          id: String(request.headers["x-test-user"] ?? "user-1"),
          email: "person@example.com",
          role: role === "admin" ? "admin" : "member",
        };
      },
      authorizeScope: async (_user, scope) =>
        (scope.kind === "project" && scope.id === "project-1") ||
        (scope.kind === "phase" && scope.id === "phase-1"),
    });

    const forbidden = await app.inject({
      method: "GET",
      url: "/api/usage/summary",
      headers: { "x-test-role": "member" },
    });
    expect(forbidden.statusCode).toBe(403);

    const emptyWindow = await app.inject({
      method: "GET",
      url: "/api/usage/users/user-1/summary?from=2026-07-20T00%3A00%3A00.000Z&to=2026-07-20T00%3A00%3A00.000Z",
      headers: { "x-test-user": "user-1" },
    });
    expect(emptyWindow.statusCode).toBe(400);
    expect(emptyWindow.json()).toMatchObject({ message: "from must be before to" });

    const self = await app.inject({
      method: "GET",
      url: "/api/usage/users/user-1/summary?user=user-2",
      headers: { "x-test-user": "user-1" },
    });
    expect(self.statusCode).toBe(200);
    expect(self.json()).toMatchObject({ requests: 3 });

    const anotherUser = await app.inject({
      method: "GET",
      url: "/api/usage/users/user-2/summary",
      headers: { "x-test-user": "user-1" },
    });
    expect(anotherUser.statusCode).toBe(403);

    const project = await app.inject({
      method: "GET",
      url: "/api/usage/projects/project-1/summary",
      headers: { "x-test-user": "user-1" },
    });
    expect(project.statusCode).toBe(200);
    expect(project.json()).toMatchObject({ requests: 2 });

    const projectBreakdown = await app.inject({
      method: "GET",
      url: "/api/usage/projects/project-1/breakdown?dimensions=user,model",
      headers: { "x-test-user": "user-1" },
    });
    expect(projectBreakdown.statusCode).toBe(200);
    expect(projectBreakdown.json().breakdowns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ dimension: "user", value: "user-1", requests: 2 }),
      ]),
    );

    const phase = await app.inject({
      method: "GET",
      url: "/api/usage/phases/phase-1/summary",
      headers: { "x-test-user": "user-1" },
    });
    expect(phase.statusCode).toBe(200);
    expect(phase.json()).toMatchObject({ requests: 2 });

    const inaccessible = await app.inject({
      method: "GET",
      url: "/api/usage/phases/phase-2/summary",
      headers: { "x-test-user": "user-1" },
    });
    expect(inaccessible.statusCode).toBe(403);

    const exportResponse = await app.inject({
      method: "GET",
      url: "/api/usage/users/user-1/export.csv",
      headers: { "x-test-user": "user-1" },
    });
    expect(exportResponse.statusCode).toBe(200);
    expect(exportResponse.headers["x-export-truncated"]).toBe("true");
    expect(exportResponse.body).toContain('"\'=HYPERLINK(""https://bad.invalid"")"');
    expect(exportResponse.body.trim().split("\r\n")).toHaveLength(3);

    await app.close();
  });
});
