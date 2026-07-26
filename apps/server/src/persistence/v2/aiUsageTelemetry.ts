import {
  AiPricingProfile,
  AiPricingProfileInput,
  type AiPricingProfileInputT,
  type AiPricingProfileT,
  AiUsageLifecycleEvent,
  AiUsageLifecycleEventInput,
  type AiUsageLifecycleEventInputT,
  type AiUsageLifecycleEventT,
} from "@norns/contracts";
import { newId } from "../../ids.js";
import type { V2SqlExecutor, V2TransactionRunner } from "./database.js";

interface PricingProfileRow {
  id: string;
  schema_version: number;
  provider: string;
  model: string;
  pricing_version: string;
  currency: string;
  input_per_million: string | number;
  output_per_million: string | number;
  cache_read_per_million: string | number | null;
  cache_write_per_million: string | number | null;
  source: string;
  effective_from: string | Date;
  effective_to: string | Date | null;
  created_at: string | Date;
}

interface UsageEventRow {
  id: string;
  schema_version: number;
  request_id: string;
  sequence: number;
  event_type: AiUsageLifecycleEventT["event_type"];
  status: AiUsageLifecycleEventT["status"];
  occurred_at: string | Date;
  recorded_at: string | Date;
  provider: string;
  model: string;
  provider_request_id: string | null;
  endpoint: string;
  request_type: string;
  retry_group_id: string | null;
  retry_attempt: number;
  initiated_by_user_id: string | null;
  project_id: string | null;
  phase_id: string | null;
  task_id: string | null;
  run_id: string | null;
  usage_source: AiUsageLifecycleEventT["usage_source"];
  confidence: string | number;
  pricing_profile_id: string | null;
  input_tokens: string | number | null;
  output_tokens: string | number | null;
  cache_read_tokens: string | number | null;
  cache_write_tokens: string | number | null;
  cost_usd: string | number | null;
  cost_classification: AiUsageLifecycleEventT["cost_classification"];
  latency_ms: number | null;
  http_status: number | null;
  error_code: string | null;
  error_category: string | null;
  error_message_redacted: string | null;
  sanitized_error: Record<string, unknown> | string | null;
  adjusts_event_id: string | null;
}

const PRICING_COLUMNS = `id, schema_version, provider, model, pricing_version, currency,
  input_per_million, output_per_million, cache_read_per_million, cache_write_per_million,
  source, effective_from, effective_to, created_at`;

const EVENT_COLUMNS = `id, schema_version, request_id, sequence, event_type, status,
  occurred_at, recorded_at, provider, model, provider_request_id, endpoint, request_type,
  retry_group_id, retry_attempt, initiated_by_user_id, project_id, phase_id, task_id, run_id,
  usage_source, confidence, pricing_profile_id, input_tokens, output_tokens, cache_read_tokens,
  cache_write_tokens, cost_usd, cost_classification, latency_ms, http_status, error_code,
  error_category, error_message_redacted, sanitized_error, adjusts_event_id`;

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function number(value: string | number): number {
  return typeof value === "number" ? value : Number(value);
}

function nullableNumber(value: string | number | null): number | null {
  return value === null ? null : number(value);
}

function jsonObject(
  value: Record<string, unknown> | string | null,
): Record<string, unknown> | null {
  if (value === null) return null;
  if (typeof value === "string") {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("sanitized_error database value is not an object");
    }
    return parsed as Record<string, unknown>;
  }
  return value;
}

function pricingProfile(row: PricingProfileRow): AiPricingProfileT {
  return AiPricingProfile.parse({
    ...row,
    input_per_million: number(row.input_per_million),
    output_per_million: number(row.output_per_million),
    cache_read_per_million: nullableNumber(row.cache_read_per_million),
    cache_write_per_million: nullableNumber(row.cache_write_per_million),
    effective_from: iso(row.effective_from),
    effective_to: row.effective_to === null ? null : iso(row.effective_to),
    created_at: iso(row.created_at),
  });
}

function usageEvent(row: UsageEventRow): AiUsageLifecycleEventT {
  return AiUsageLifecycleEvent.parse({
    ...row,
    occurred_at: iso(row.occurred_at),
    recorded_at: iso(row.recorded_at),
    confidence: number(row.confidence),
    input_tokens: nullableNumber(row.input_tokens),
    output_tokens: nullableNumber(row.output_tokens),
    cache_read_tokens: nullableNumber(row.cache_read_tokens),
    cache_write_tokens: nullableNumber(row.cache_write_tokens),
    cost_usd: nullableNumber(row.cost_usd),
    sanitized_error: jsonObject(row.sanitized_error),
  });
}

function eventInput(event: AiUsageLifecycleEventT): AiUsageLifecycleEventInputT {
  const {
    id: _id,
    schema_version: _schemaVersion,
    sequence: _sequence,
    recorded_at: _recordedAt,
    ...input
  } = event;
  return AiUsageLifecycleEventInput.parse(input);
}

function canonicalJson(value: unknown): string {
  const canonical = (current: unknown): unknown => {
    if (Array.isArray(current)) return current.map(canonical);
    if (typeof current !== "object" || current === null) return current;
    return Object.fromEntries(
      Object.entries(current as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonical(child)]),
    );
  };
  return JSON.stringify(canonical(value));
}

export interface AiUsageTelemetryRepository {
  createPricingProfile(input: AiPricingProfileInputT): Promise<AiPricingProfileT>;
  findEffectivePricingProfile(
    provider: string,
    model: string,
    occurredAt: string,
    pricingVersion?: string,
  ): Promise<AiPricingProfileT | null>;
  appendEvent(
    input: AiUsageLifecycleEventInputT,
    stableEventId?: string,
  ): Promise<AiUsageLifecycleEventT>;
  requestEvents(requestId: string): Promise<AiUsageLifecycleEventT[]>;
}

/**
 * SQL persistence boundary for canonical telemetry.
 *
 * Request-scoped advisory locks serialize sequence allocation. Database
 * constraints and triggers independently enforce lifecycle order and
 * append-only history, so direct SQL cannot bypass the invariants.
 */
export class SqlAiUsageTelemetryRepository implements AiUsageTelemetryRepository {
  constructor(private readonly transactions: V2TransactionRunner) {}

  async createPricingProfile(input: AiPricingProfileInputT): Promise<AiPricingProfileT> {
    const validated = AiPricingProfileInput.parse(input);
    return this.transactions.transaction(async (tx) => {
      await this.lock(tx, `ai-pricing:${validated.provider}:${validated.model}`);
      const result = await tx.query<PricingProfileRow>(
        `INSERT INTO ai_pricing_profiles (
           id, provider, model, pricing_version, currency, input_per_million,
           output_per_million, cache_read_per_million, cache_write_per_million,
           source, effective_from, effective_to
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING ${PRICING_COLUMNS}`,
        [
          newId("ai_price"),
          validated.provider,
          validated.model,
          validated.pricing_version,
          validated.currency,
          validated.input_per_million,
          validated.output_per_million,
          validated.cache_read_per_million,
          validated.cache_write_per_million,
          validated.source,
          validated.effective_from,
          validated.effective_to,
        ],
      );
      const row = result.rows[0];
      if (!row) throw new Error("pricing profile insert returned no row");
      return pricingProfile(row);
    });
  }

  findEffectivePricingProfile(
    provider: string,
    model: string,
    occurredAt: string,
    pricingVersion?: string,
  ): Promise<AiPricingProfileT | null> {
    if (provider.trim().length === 0 || model.trim().length === 0) {
      throw new Error("provider and model are required");
    }
    const timestamp = new Date(occurredAt);
    if (Number.isNaN(timestamp.valueOf())) throw new Error("occurredAt must be an ISO timestamp");

    const version = pricingVersion?.trim() || null;
    return this.transactions.transaction(async (tx) => {
      const result = await tx.query<PricingProfileRow>(
        `SELECT ${PRICING_COLUMNS}
         FROM ai_pricing_profiles
         WHERE provider = $1
           AND model = $2
           AND effective_from <= $3
           AND (effective_to IS NULL OR effective_to > $3)
           AND ($4::text IS NULL OR pricing_version = $4)
         ORDER BY effective_from DESC
         LIMIT 1`,
        [provider, model, timestamp.toISOString(), version],
      );
      const row = result.rows[0];
      return row ? pricingProfile(row) : null;
    });
  }

  async appendEvent(
    input: AiUsageLifecycleEventInputT,
    stableEventId = newId("ai_usage_event"),
  ): Promise<AiUsageLifecycleEventT> {
    const validated = AiUsageLifecycleEventInput.parse(input);
    if (stableEventId.trim().length === 0) throw new Error("stableEventId must not be empty");

    return this.transactions.transaction(async (tx) => {
      await this.lock(tx, `ai-usage:${validated.request_id}`);
      const duplicate = await tx.query<UsageEventRow>(
        `SELECT ${EVENT_COLUMNS} FROM ai_usage_events WHERE id = $1`,
        [stableEventId],
      );
      const existing = duplicate.rows[0];
      if (existing) {
        const parsed = usageEvent(existing);
        if (canonicalJson(eventInput(parsed)) !== canonicalJson(validated)) {
          throw new Error(`telemetry event id ${stableEventId} was reused with different content`);
        }
        return parsed;
      }

      const sequenceResult = await tx.query<{ sequence: number }>(
        `SELECT COALESCE(MAX(sequence), 0)::int + 1 AS sequence
         FROM ai_usage_events
         WHERE request_id = $1`,
        [validated.request_id],
      );
      const sequence = sequenceResult.rows[0]?.sequence;
      if (!sequence) throw new Error("could not allocate telemetry event sequence");

      const result = await tx.query<UsageEventRow>(
        `INSERT INTO ai_usage_events (
           id, request_id, sequence, event_type, status, occurred_at, provider, model,
           provider_request_id, endpoint, request_type, retry_group_id, retry_attempt,
           initiated_by_user_id, project_id, phase_id, task_id, run_id, usage_source,
           confidence, pricing_profile_id, input_tokens, output_tokens, cache_read_tokens,
           cache_write_tokens, cost_usd, cost_classification, latency_ms, http_status,
           error_code, error_category, error_message_redacted, sanitized_error, adjusts_event_id
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
           $18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33::jsonb,$34
         )
         RETURNING ${EVENT_COLUMNS}`,
        [
          stableEventId,
          validated.request_id,
          sequence,
          validated.event_type,
          validated.status,
          validated.occurred_at,
          validated.provider,
          validated.model,
          validated.provider_request_id,
          validated.endpoint,
          validated.request_type,
          validated.retry_group_id,
          validated.retry_attempt,
          validated.initiated_by_user_id,
          validated.project_id,
          validated.phase_id,
          validated.task_id,
          validated.run_id,
          validated.usage_source,
          validated.confidence,
          validated.pricing_profile_id,
          validated.input_tokens,
          validated.output_tokens,
          validated.cache_read_tokens,
          validated.cache_write_tokens,
          validated.cost_usd,
          validated.cost_classification,
          validated.latency_ms,
          validated.http_status,
          validated.error_code,
          validated.error_category,
          validated.error_message_redacted,
          validated.sanitized_error === null ? null : JSON.stringify(validated.sanitized_error),
          validated.adjusts_event_id,
        ],
      );
      const row = result.rows[0];
      if (!row) throw new Error("telemetry event insert returned no row");
      return usageEvent(row);
    });
  }

  requestEvents(requestId: string): Promise<AiUsageLifecycleEventT[]> {
    if (requestId.trim().length === 0) throw new Error("requestId must not be empty");
    return this.transactions.transaction(async (tx) => {
      const result = await tx.query<UsageEventRow>(
        `SELECT ${EVENT_COLUMNS}
         FROM ai_usage_events
         WHERE request_id = $1
         ORDER BY sequence`,
        [requestId],
      );
      return result.rows.map(usageEvent);
    });
  }

  private async lock(tx: V2SqlExecutor, key: string): Promise<void> {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
  }
}
