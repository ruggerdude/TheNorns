import { PGlite } from "@electric-sql/pglite";
import {
  AdapterError,
  type CompletionRequest,
  type CompletionResult,
  FakeAdapter,
  makeUsageEvent,
} from "@norns/adapters";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SqlAiUsageTelemetryRepository } from "../src/persistence/v2/aiUsageTelemetry.js";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import {
  AI_USAGE_TELEMETRY_MIGRATION_NAME,
  type V2MigrationDatabase,
  loadAiUsageTelemetryMigrationSql,
  runPhase1V2Migration,
  runV2Migrations,
} from "../src/persistence/v2/migrate.js";
import { AiInvocationTelemetry } from "../src/usage-intelligence/telemetry.js";

const asMigrationDatabase = (database: PGlite): V2MigrationDatabase =>
  database as unknown as V2MigrationDatabase;

class FailingAdapter extends FakeAdapter {
  constructor() {
    super("openai", "failing-openai");
  }

  override async complete(request: CompletionRequest): Promise<CompletionResult> {
    const usage = makeUsageEvent(
      this.model,
      {
        [this.model]: {
          provider: this.provider,
          label: "Failing OpenAI",
          selectable: false,
          supports_structured_output: true,
          input_per_mtok: 1,
          output_per_mtok: 2,
          pricing_version: "test-2026-07",
          pricing_is_estimate: false,
        },
      },
      { projectId: request.projectId },
      12,
      4,
      "provider_api",
    );
    throw new AdapterError("rate_limit", "upstream leaked sk-secret-raw-value", {
      metadata: {
        usage,
        provider_execution_id: "provider-failure-request",
        latency_ms: 42,
        request_dispatched: true,
      },
    });
  }
}

describe.sequential("production AI invocation telemetry", () => {
  let pg: PGlite;
  let repository: SqlAiUsageTelemetryRepository;
  let telemetry: AiInvocationTelemetry;

  beforeAll(async () => {
    pg = new PGlite();
    await pg.exec("CREATE ROLE norns_app NOLOGIN");
    await runPhase1V2Migration(asMigrationDatabase(pg));
    await runV2Migrations(asMigrationDatabase(pg), [
      {
        name: AI_USAGE_TELEMETRY_MIGRATION_NAME,
        sql: await loadAiUsageTelemetryMigrationSql(),
      },
    ]);
    repository = new SqlAiUsageTelemetryRepository(new PGliteTransactionRunner(pg));
    telemetry = new AiInvocationTelemetry(repository);

    await pg.query(
      `INSERT INTO users (
         id, username, display_name, password_hash, role, status
       ) VALUES (
         'invocation-user', 'invocation@example.test', 'Invocation User',
         'hash', 'member', 'active'
       )`,
    );
    await pg.query(
      `INSERT INTO projects (
         id, name, status, assignment_policy_ref, verification_policy_ref, budget_policy_ref
       ) VALUES (
         'invocation-project', 'Invocation', 'initializing',
         'assignment/default', 'verification/default', 'budget/default'
       )`,
    );
  }, 30_000);

  afterAll(async () => {
    if (!pg.closed) await pg.close();
  });

  it("records start, cumulative usage, terminal success, scope, and retry correlation", async () => {
    const pricing = await repository.createPricingProfile({
      provider: "anthropic",
      model: "mock-anthropic",
      pricing_version: "mock-1",
      currency: "USD",
      input_per_million: 2,
      output_per_million: 10,
      cache_read_per_million: null,
      cache_write_per_million: null,
      source: "DEFAULT_MODEL_REGISTRY test fixture",
      effective_from: "2026-01-01T00:00:00.000Z",
      effective_to: null,
    });
    const adapter = new FakeAdapter("anthropic", "mock-anthropic");
    adapter.enqueue("safe response");
    const wrapped = telemetry.wrapAdapter(adapter);

    await wrapped.complete({
      projectId: "invocation-project",
      initiatedByUserId: "invocation-user",
      prompt: "sensitive customer prompt must not be logged",
      telemetryRetryGroupId: "retry-group-1",
      telemetryRetryAttempt: 2,
    });

    const rows = await pg.query<Record<string, unknown>>(
      `SELECT * FROM ai_usage_events
       WHERE model = 'mock-anthropic'
       ORDER BY sequence`,
    );
    expect(rows.rows.map((row) => row.event_type)).toEqual([
      "request_started",
      "usage_observed",
      "request_completed",
    ]);
    expect(rows.rows[0]).toMatchObject({
      endpoint: "/v1/messages",
      initiated_by_user_id: "invocation-user",
      project_id: "invocation-project",
      retry_group_id: "retry-group-1",
      retry_attempt: 2,
      request_type: "completion",
    });
    expect(rows.rows[1]).toMatchObject({
      input_tokens: 100,
      output_tokens: 50,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      usage_source: "provider_api",
      pricing_profile_id: pricing.id,
    });
    expect(rows.rows[2]).toMatchObject({
      status: "succeeded",
      cost_classification: "unavailable",
    });
    expect(JSON.stringify(rows.rows)).not.toContain("sensitive customer prompt");
  });

  it("retains known failure usage and only stores sanitized failure metadata", async () => {
    const wrapped = telemetry.wrapAdapter(new FailingAdapter());

    await expect(
      wrapped.complete({
        projectId: "invocation-project",
        prompt: "another confidential prompt",
      }),
    ).rejects.toThrow("upstream leaked sk-secret-raw-value");

    const rows = await pg.query<Record<string, unknown>>(
      `SELECT * FROM ai_usage_events
       WHERE model = 'failing-openai'
       ORDER BY sequence`,
    );
    expect(rows.rows.map((row) => row.event_type)).toEqual([
      "request_started",
      "usage_observed",
      "request_failed",
    ]);
    expect(rows.rows[0]).toMatchObject({ endpoint: "/v1/responses" });
    expect(rows.rows[1]).toMatchObject({
      input_tokens: 12,
      output_tokens: 4,
      provider_request_id: "provider-failure-request",
    });
    expect(rows.rows[2]).toMatchObject({
      error_code: "rate_limit",
      error_category: "adapter_error",
      error_message_redacted: "provider call failed (rate_limit)",
      latency_ms: 42,
      sanitized_error: {
        retryable: true,
        request_dispatched: true,
      },
    });
    const persisted = JSON.stringify(rows.rows);
    expect(persisted).not.toContain("sk-secret-raw-value");
    expect(persisted).not.toContain("another confidential prompt");
  });
});
