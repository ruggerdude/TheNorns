import { PGlite } from "@electric-sql/pglite";
import type { AiPricingProfileInputT, AiUsageLifecycleEventInputT } from "@norns/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SqlAiUsageTelemetryRepository } from "../src/persistence/v2/aiUsageTelemetry.js";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import {
  AI_USAGE_TELEMETRY_MIGRATION_NAME,
  PHASE1_V2_MIGRATION_NAME,
  type V2MigrationDatabase,
  loadAiUsageTelemetryMigrationSql,
  runPhase1V2Migration,
  runV2Migrations,
} from "../src/persistence/v2/migrate.js";

const asMigrationDatabase = (database: PGlite): V2MigrationDatabase =>
  database as unknown as V2MigrationDatabase;

const profileInput: AiPricingProfileInputT = {
  provider: "provider-without-a-closed-union",
  model: "model-v1",
  pricing_version: "2026-07-a",
  currency: "USD",
  input_per_million: 3,
  output_per_million: 15,
  cache_read_per_million: 0.3,
  cache_write_per_million: 3.75,
  source: "provider price sheet",
  effective_from: "2026-07-01T00:00:00.000Z",
  effective_to: "2026-07-02T00:00:00.000Z",
};

function event(overrides: Partial<AiUsageLifecycleEventInputT> = {}): AiUsageLifecycleEventInputT {
  return {
    request_id: "request-1",
    event_type: "request_started",
    status: "started",
    occurred_at: "2026-07-01T12:00:00.000Z",
    provider: profileInput.provider,
    model: profileInput.model,
    provider_request_id: null,
    endpoint: "/v1/messages",
    request_type: "messages",
    retry_group_id: null,
    retry_attempt: 0,
    initiated_by_user_id: "telemetry-user",
    project_id: "telemetry-project",
    phase_id: null,
    task_id: null,
    run_id: null,
    usage_source: "unavailable",
    confidence: 0,
    pricing_profile_id: null,
    input_tokens: null,
    output_tokens: null,
    cache_read_tokens: null,
    cache_write_tokens: null,
    cost_usd: null,
    cost_classification: "unavailable",
    latency_ms: null,
    http_status: null,
    error_code: null,
    error_category: null,
    error_message_redacted: null,
    sanitized_error: null,
    adjusts_event_id: null,
    ...overrides,
  };
}

describe.sequential("canonical AI usage telemetry", () => {
  let pg: PGlite;
  let repository: SqlAiUsageTelemetryRepository;

  beforeAll(async () => {
    pg = new PGlite();
    await pg.exec("CREATE ROLE norns_app NOLOGIN");
    await runPhase1V2Migration(asMigrationDatabase(pg));
    const result = await runV2Migrations(asMigrationDatabase(pg), [
      {
        name: AI_USAGE_TELEMETRY_MIGRATION_NAME,
        sql: await loadAiUsageTelemetryMigrationSql(),
      },
    ]);
    expect(result).toMatchObject([{ name: AI_USAGE_TELEMETRY_MIGRATION_NAME, applied: true }]);
    repository = new SqlAiUsageTelemetryRepository(new PGliteTransactionRunner(pg));

    await pg.query(
      `INSERT INTO users (
         id, username, display_name, password_hash, role, status
       ) VALUES ('telemetry-user', 'telemetry@example.test', 'Telemetry User', 'hash', 'member', 'active')`,
    );
    await pg.query(
      `INSERT INTO projects (
         id, name, status, assignment_policy_ref, verification_policy_ref, budget_policy_ref
       ) VALUES (
         'telemetry-project', 'Telemetry', 'initializing',
         'assignment/default', 'verification/default', 'budget/default'
       )`,
    );
  }, 30_000);

  afterAll(async () => {
    if (!pg.closed) await pg.close();
  });

  it("registers 0028 as a checksum-pinned, replay-safe migration", async () => {
    const replay = await runV2Migrations(asMigrationDatabase(pg), [
      {
        name: AI_USAGE_TELEMETRY_MIGRATION_NAME,
        sql: await loadAiUsageTelemetryMigrationSql(),
      },
    ]);
    expect(replay).toMatchObject([{ name: AI_USAGE_TELEMETRY_MIGRATION_NAME, applied: false }]);
    const applied = await pg.query<{ name: string }>(
      "SELECT name FROM norns_schema_migrations WHERE name IN ($1, $2) ORDER BY name",
      [PHASE1_V2_MIGRATION_NAME, AI_USAGE_TELEMETRY_MIGRATION_NAME],
    );
    expect(applied.rows.map((row) => row.name)).toEqual([
      PHASE1_V2_MIGRATION_NAME,
      AI_USAGE_TELEMETRY_MIGRATION_NAME,
    ]);
  });

  it("stores an ordered lifecycle, cumulative usage, and a signed adjustment", async () => {
    const pricing = await repository.createPricingProfile(profileInput);
    expect(pricing).toMatchObject({
      schema_version: 1,
      provider: profileInput.provider,
      currency: "USD",
      cache_read_per_million: 0.3,
    });
    expect(
      await repository.findEffectivePricingProfile(
        profileInput.provider,
        profileInput.model,
        "2026-07-01T12:00:00.000Z",
      ),
    ).toEqual(pricing);
    expect(
      await repository.findEffectivePricingProfile(
        profileInput.provider,
        profileInput.model,
        "2026-07-01T12:00:00.000Z",
        "a-different-pricing-version",
      ),
    ).toBeNull();

    await repository.appendEvent(event(), "usage-start");
    const observed = await repository.appendEvent(
      event({
        event_type: "usage_observed",
        status: "in_progress",
        occurred_at: "2026-07-01T12:00:01.000Z",
        provider_request_id: "provider-request-1",
        usage_source: "provider_api",
        confidence: 1,
        pricing_profile_id: pricing.id,
        input_tokens: 120,
        output_tokens: 30,
        cache_read_tokens: 20,
        cache_write_tokens: 5,
        cost_usd: 0.001,
        cost_classification: "actual",
      }),
      "usage-observed",
    );
    await repository.appendEvent(
      event({
        event_type: "request_completed",
        status: "succeeded",
        occurred_at: "2026-07-01T12:00:02.000Z",
        provider_request_id: "provider-request-1",
        usage_source: "provider_api",
        confidence: 1,
        latency_ms: 200,
        http_status: 200,
      }),
      "usage-completed",
    );
    await repository.appendEvent(
      event({
        event_type: "adjustment",
        status: "adjusted",
        occurred_at: "2026-07-01T12:00:03.000Z",
        usage_source: "manual_adjustment",
        confidence: 1,
        input_tokens: -5,
        output_tokens: null,
        cache_read_tokens: -5,
        cache_write_tokens: null,
        cost_usd: -0.0001,
        cost_classification: "actual",
        adjusts_event_id: observed.id,
      }),
      "usage-adjustment",
    );

    const lifecycle = await repository.requestEvents("request-1");
    expect(lifecycle.map(({ sequence, event_type }) => ({ sequence, event_type }))).toEqual([
      { sequence: 1, event_type: "request_started" },
      { sequence: 2, event_type: "usage_observed" },
      { sequence: 3, event_type: "request_completed" },
      { sequence: 4, event_type: "adjustment" },
    ]);
    expect(lifecycle[1]).toMatchObject({
      input_tokens: 120,
      cache_read_tokens: 20,
      cost_usd: 0.001,
    });
    expect(lifecycle[2]).toMatchObject({
      input_tokens: null,
      output_tokens: null,
      cost_usd: null,
      status: "succeeded",
    });

    const idempotentRetry = await repository.appendEvent(
      event({
        event_type: "request_completed",
        status: "succeeded",
        occurred_at: "2026-07-01T12:00:02.000Z",
        provider_request_id: "provider-request-1",
        usage_source: "provider_api",
        confidence: 1,
        latency_ms: 200,
        http_status: 200,
      }),
      "usage-completed",
    );
    expect(idempotentRetry.sequence).toBe(3);
    expect(await repository.requestEvents("request-1")).toHaveLength(4);
  });

  it("rejects overlapping prices, invalid lifecycle transitions, and history mutation", async () => {
    await expect(
      repository.createPricingProfile({
        ...profileInput,
        pricing_version: "overlap",
        effective_from: "2026-07-01T06:00:00.000Z",
        effective_to: "2026-07-03T00:00:00.000Z",
      }),
    ).rejects.toThrow(/overlaps/);

    await expect(
      repository.appendEvent(
        event({
          request_id: "request-without-start",
          event_type: "usage_observed",
          status: "in_progress",
          usage_source: "provider_api",
          confidence: 1,
          input_tokens: 1,
          output_tokens: 1,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          cost_usd: null,
          cost_classification: "unavailable",
        }),
      ),
    ).rejects.toThrow(/must begin with request_started/);

    await expect(
      repository.appendEvent(
        event({
          event_type: "request_failed",
          status: "failed",
          occurred_at: "2026-07-01T12:00:04.000Z",
          error_code: "too_late",
        }),
      ),
    ).rejects.toThrow(/terminal/);

    await expect(
      pg.query("UPDATE ai_usage_events SET model = 'rewritten' WHERE id = 'usage-start'"),
    ).rejects.toThrow(/append-only/);
    await expect(
      pg.query("DELETE FROM ai_usage_events WHERE id = 'usage-adjustment'"),
    ).rejects.toThrow(/append-only/);
    await expect(pg.query("TRUNCATE ai_usage_events")).rejects.toThrow(/append-only/);
    await expect(pg.query("UPDATE ai_pricing_profiles SET source = 'rewritten'")).rejects.toThrow(
      /append-only/,
    );

    await expect(pg.query("DELETE FROM projects WHERE id = 'telemetry-project'")).rejects.toThrow();
    await expect(pg.query("DELETE FROM users WHERE id = 'telemetry-user'")).rejects.toThrow();
  });
});
