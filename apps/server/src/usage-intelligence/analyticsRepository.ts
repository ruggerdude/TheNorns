import { newId } from "../ids.js";
import type { V2QueryResult, V2TransactionRunner } from "../persistence/v2/database.js";

export type HotSpotDimension = "user" | "project" | "phase" | "provider" | "model" | "request_type";

export interface AnalyticsFilters {
  from?: string;
  to?: string;
  provider?: string;
  model?: string;
  userId?: string;
  projectId?: string;
  phaseId?: string;
  requestType?: string;
}

export interface UsageHotSpot {
  dimension: HotSpotDimension;
  value: string;
  requests: number;
  failed_requests: number;
  input_tokens: number;
  output_tokens: number;
  known_cost_usd: number;
  unpriced_requests: number;
}

export interface UsageSignals {
  requests: number;
  failed_requests: number;
  retried_requests: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  known_cost_usd: number;
  failed_known_cost_usd: number;
  retry_known_cost_usd: number;
  priced_requests: number;
  unpriced_requests: number;
}

export type AllowanceUnit = "tokens" | "requests" | "credits" | "usd_equivalent";
export type ProviderReadingKind = "used" | "remaining" | "utilization_percent";

export interface ProviderUsagePlan {
  id: string;
  provider: string;
  plan_name: string;
  allowance_unit: AllowanceUnit;
  allowance_amount: number;
  allowance_usd_equivalent: number | null;
  effective_from: string;
  effective_to: string | null;
  source: string;
  created_by_user_id: string;
  created_at: string;
}

export interface CreateProviderUsagePlan {
  provider: string;
  plan_name: string;
  allowance_unit: AllowanceUnit;
  allowance_amount: number;
  allowance_usd_equivalent: number | null;
  effective_from: string;
  effective_to: string | null;
  source: string;
  created_by_user_id: string;
}

export interface CalibrationObservation {
  id: string;
  plan_id: string;
  provider: string;
  model: string;
  subscription_tier: string;
  cycle_period: "weekly" | "monthly";
  reset_at: string;
  cycle_start: string;
  cycle_end: string;
  observed_at: string;
  provider_reading_kind: ProviderReadingKind;
  provider_reading_unit: AllowanceUnit | "percent";
  provider_reading_value: number;
  displayed_percentage: number;
  tokens_used_since_reset: number;
  implied_max_tokens: number;
  provider_reading_usd_equivalent: number | null;
  canonical_requests: number;
  canonical_input_tokens: number;
  canonical_output_tokens: number;
  canonical_cache_read_tokens: number;
  canonical_cache_write_tokens: number;
  canonical_known_cost_usd: number | null;
  canonical_unpriced_requests: number;
  confidence: number;
  source: "provider_api" | "runtime_report" | "manual" | "import";
  evidence_note: string | null;
  recorded_by_user_id: string;
  recorded_at: string;
}

export interface CreateCalibrationObservation {
  plan_id: string;
  provider: string;
  model: string;
  subscription_tier: string;
  cycle_period: "weekly" | "monthly";
  reset_at: string;
  observed_at: string;
  displayed_percentage: number;
  source: CalibrationObservation["source"];
  evidence_note: string | null;
  recorded_by_user_id: string;
}

type PersistCalibrationObservation = Omit<CalibrationObservation, "id" | "recorded_at">;

export interface ModelPriceProfile {
  id: string;
  provider: string;
  model: string;
  pricing_version: string;
  input_per_million: number;
  output_per_million: number;
  effective_from: string;
  effective_to: string | null;
}

interface HotSpotRow {
  value: string | null;
  requests: string | number;
  failed_requests: string | number;
  input_tokens: string | number;
  output_tokens: string | number;
  known_cost_usd: string | number | null;
  unpriced_requests: string | number;
}

interface SignalRow extends Omit<HotSpotRow, "value"> {
  retried_requests: string | number;
  cache_read_tokens: string | number;
  cache_write_tokens: string | number;
  failed_known_cost_usd: string | number | null;
  retry_known_cost_usd: string | number | null;
  priced_requests: string | number;
}

interface PlanRow {
  id: string;
  provider: string;
  plan_name: string;
  allowance_unit: AllowanceUnit;
  allowance_amount: string | number;
  allowance_usd_equivalent: string | number | null;
  effective_from: string | Date;
  effective_to: string | Date | null;
  source: string;
  created_by_user_id: string;
  created_at: string | Date;
}

interface ObservationRow {
  id: string;
  plan_id: string;
  provider: string;
  model: string;
  subscription_tier: string;
  cycle_period: "weekly" | "monthly";
  reset_at: string | Date;
  cycle_start: string | Date;
  cycle_end: string | Date;
  observed_at: string | Date;
  provider_reading_kind: ProviderReadingKind;
  provider_reading_unit: AllowanceUnit | "percent";
  provider_reading_value: string | number;
  displayed_percentage: string | number;
  tokens_used_since_reset: string | number;
  implied_max_tokens: string | number;
  provider_reading_usd_equivalent: string | number | null;
  canonical_requests: string | number;
  canonical_input_tokens: string | number;
  canonical_output_tokens: string | number;
  canonical_cache_read_tokens: string | number;
  canonical_cache_write_tokens: string | number;
  canonical_known_cost_usd: string | number | null;
  canonical_unpriced_requests: string | number;
  confidence: string | number;
  source: CalibrationObservation["source"];
  evidence_note: string | null;
  recorded_by_user_id: string;
  recorded_at: string | Date;
}

interface PriceProfileRow {
  id: string;
  provider: string;
  model: string;
  pricing_version: string;
  input_per_million: string | number;
  output_per_million: string | number;
  effective_from: string | Date;
  effective_to: string | Date | null;
}

function number(value: string | number | null): number {
  if (value === null) return 0;
  return typeof value === "number" ? value : Number(value);
}

function nullableNumber(value: string | number | null): number | null {
  return value === null ? null : number(value);
}

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function plan(row: PlanRow): ProviderUsagePlan {
  return {
    ...row,
    allowance_amount: number(row.allowance_amount),
    allowance_usd_equivalent: nullableNumber(row.allowance_usd_equivalent),
    effective_from: iso(row.effective_from),
    effective_to: row.effective_to === null ? null : iso(row.effective_to),
    created_at: iso(row.created_at),
  };
}

function observation(row: ObservationRow): CalibrationObservation {
  return {
    ...row,
    cycle_start: iso(row.cycle_start),
    cycle_end: iso(row.cycle_end),
    reset_at: iso(row.reset_at),
    observed_at: iso(row.observed_at),
    provider_reading_value: number(row.provider_reading_value),
    displayed_percentage: number(row.displayed_percentage),
    tokens_used_since_reset: number(row.tokens_used_since_reset),
    implied_max_tokens: number(row.implied_max_tokens),
    provider_reading_usd_equivalent: nullableNumber(row.provider_reading_usd_equivalent),
    canonical_requests: number(row.canonical_requests),
    canonical_input_tokens: number(row.canonical_input_tokens),
    canonical_output_tokens: number(row.canonical_output_tokens),
    canonical_cache_read_tokens: number(row.canonical_cache_read_tokens),
    canonical_cache_write_tokens: number(row.canonical_cache_write_tokens),
    canonical_known_cost_usd: nullableNumber(row.canonical_known_cost_usd),
    canonical_unpriced_requests: number(row.canonical_unpriced_requests),
    confidence: number(row.confidence),
    recorded_at: iso(row.recorded_at),
  };
}

function factsCte(filters: AnalyticsFilters, params: unknown[]): string {
  const predicates: string[] = [
    `(s.request_type <> 'runtime_aggregate_report'
      OR s.run_id IS NULL
      OR NOT EXISTS (
        SELECT 1
        FROM ai_usage_events provider_event
        WHERE provider_event.run_id = s.run_id
          AND provider_event.request_type <> 'runtime_aggregate_report'
      ))`,
  ];
  const add = (column: string, value: string, operator = "=") => {
    params.push(value);
    predicates.push(`s.${column} ${operator} $${params.length}`);
  };
  if (filters.from) add("occurred_at", filters.from, ">=");
  if (filters.to) add("occurred_at", filters.to, "<");
  if (filters.provider) add("provider", filters.provider);
  if (filters.model) add("model", filters.model);
  if (filters.userId) add("initiated_by_user_id", filters.userId);
  if (filters.projectId) add("project_id", filters.projectId);
  if (filters.phaseId) add("phase_id", filters.phaseId);
  if (filters.requestType) add("request_type", filters.requestType);
  return `
    WITH qualifying_requests AS (
      SELECT
        s.request_id,
        s.occurred_at AS request_occurred_at,
        s.provider,
        s.model,
        s.request_type,
        s.initiated_by_user_id,
        s.project_id,
        s.phase_id,
        s.retry_attempt
      FROM ai_usage_events s
      WHERE s.event_type = 'request_started'
        AND ${predicates.join(" AND ")}
    ),
    scoped_events AS (
      SELECT e.*
      FROM ai_usage_events e
      JOIN qualifying_requests q USING (request_id)
    ),
    requests AS (
      SELECT
        q.request_id,
        q.request_occurred_at,
        q.provider,
        q.model,
        q.request_type,
        q.initiated_by_user_id,
        q.project_id,
        q.phase_id,
        q.retry_attempt,
        CASE
          WHEN BOOL_OR(e.event_type = 'request_failed') THEN 'failed'
          WHEN BOOL_OR(e.event_type = 'request_completed') THEN 'succeeded'
          ELSE 'in_progress'
        END AS request_status
      FROM qualifying_requests q
      JOIN scoped_events e USING (request_id)
      WHERE e.event_type <> 'adjustment'
      GROUP BY
        q.request_id, q.request_occurred_at, q.provider, q.model,
        q.request_type, q.initiated_by_user_id, q.project_id, q.phase_id,
        q.retry_attempt
    ),
    usage_ranked AS (
      SELECT e.*,
        ROW_NUMBER() OVER (
          PARTITION BY e.request_id
          ORDER BY e.sequence DESC, e.recorded_at DESC, e.id DESC
        ) AS usage_rank
      FROM scoped_events e
      WHERE e.event_type = 'usage_observed'
    ),
    adjustments AS (
      SELECT
        request_id,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
        COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
        COALESCE(SUM(cost_usd), 0) AS cost_usd
      FROM scoped_events
      WHERE event_type = 'adjustment'
      GROUP BY request_id
    ),
    request_facts AS (
      SELECT
        r.*,
        u.id AS usage_event_id,
        COALESCE(u.input_tokens, 0) + COALESCE(a.input_tokens, 0) AS input_tokens,
        COALESCE(u.output_tokens, 0) + COALESCE(a.output_tokens, 0) AS output_tokens,
        COALESCE(u.cache_read_tokens, 0) + COALESCE(a.cache_read_tokens, 0)
          AS cache_read_tokens,
        COALESCE(u.cache_write_tokens, 0) + COALESCE(a.cache_write_tokens, 0)
          AS cache_write_tokens,
        CASE
          WHEN u.id IS NULL OR u.cost_usd IS NULL THEN NULL
          ELSE u.cost_usd + COALESCE(a.cost_usd, 0)
        END AS cost_usd
      FROM requests r
      LEFT JOIN usage_ranked u
        ON u.request_id = r.request_id AND u.usage_rank = 1
      LEFT JOIN adjustments a ON a.request_id = r.request_id
    )`;
}

const dimensionColumn: Record<HotSpotDimension, string> = {
  user: "initiated_by_user_id",
  project: "project_id",
  phase: "phase_id",
  provider: "provider",
  model: "model",
  request_type: "request_type",
};

export class UsageAnalyticsRepository {
  constructor(private readonly transactions: V2TransactionRunner) {}

  private query<TRow>(sql: string, params: unknown[] = []): Promise<V2QueryResult<TRow>> {
    return this.transactions.transaction((tx) => tx.query<TRow>(sql, params));
  }

  async hotSpots(
    dimension: HotSpotDimension,
    filters: AnalyticsFilters = {},
    limit = 10,
  ): Promise<UsageHotSpot[]> {
    const params: unknown[] = [];
    const cte = factsCte(filters, params);
    params.push(Math.min(Math.max(Math.trunc(limit), 1), 50));
    const column = dimensionColumn[dimension];
    const result = await this.query<HotSpotRow>(
      `${cte}
       SELECT
         COALESCE(${column}, 'unattributed') AS value,
         COUNT(*) AS requests,
         COUNT(*) FILTER (WHERE request_status = 'failed') AS failed_requests,
         COALESCE(SUM(input_tokens), 0) AS input_tokens,
         COALESCE(SUM(output_tokens), 0) AS output_tokens,
         COALESCE(SUM(cost_usd), 0) AS known_cost_usd,
         COUNT(*) FILTER (
           WHERE usage_event_id IS NOT NULL AND cost_usd IS NULL
         ) AS unpriced_requests
       FROM request_facts
       GROUP BY ${column}
       ORDER BY known_cost_usd DESC, requests DESC, value
       LIMIT $${params.length}`,
      params,
    );
    return result.rows.map((row) => ({
      dimension,
      value: row.value ?? "unattributed",
      requests: number(row.requests),
      failed_requests: number(row.failed_requests),
      input_tokens: number(row.input_tokens),
      output_tokens: number(row.output_tokens),
      known_cost_usd: number(row.known_cost_usd),
      unpriced_requests: number(row.unpriced_requests),
    }));
  }

  async signals(filters: AnalyticsFilters = {}): Promise<UsageSignals> {
    const params: unknown[] = [];
    const cte = factsCte(filters, params);
    const result = await this.query<SignalRow>(
      `${cte}
       SELECT
         COUNT(*) AS requests,
         COUNT(*) FILTER (WHERE request_status = 'failed') AS failed_requests,
         COUNT(*) FILTER (WHERE retry_attempt > 0) AS retried_requests,
         COALESCE(SUM(input_tokens), 0) AS input_tokens,
         COALESCE(SUM(output_tokens), 0) AS output_tokens,
         COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
         COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
         COALESCE(SUM(cost_usd), 0) AS known_cost_usd,
         COALESCE(SUM(cost_usd) FILTER (WHERE request_status = 'failed'), 0)
           AS failed_known_cost_usd,
         COALESCE(SUM(cost_usd) FILTER (WHERE retry_attempt > 0), 0)
           AS retry_known_cost_usd,
         COUNT(*) FILTER (
           WHERE usage_event_id IS NOT NULL AND cost_usd IS NOT NULL
         ) AS priced_requests,
         COUNT(*) FILTER (
           WHERE usage_event_id IS NOT NULL AND cost_usd IS NULL
         ) AS unpriced_requests
       FROM request_facts`,
      params,
    );
    const row = result.rows[0];
    return {
      requests: number(row?.requests ?? 0),
      failed_requests: number(row?.failed_requests ?? 0),
      retried_requests: number(row?.retried_requests ?? 0),
      input_tokens: number(row?.input_tokens ?? 0),
      output_tokens: number(row?.output_tokens ?? 0),
      cache_read_tokens: number(row?.cache_read_tokens ?? 0),
      cache_write_tokens: number(row?.cache_write_tokens ?? 0),
      known_cost_usd: number(row?.known_cost_usd ?? 0),
      failed_known_cost_usd: number(row?.failed_known_cost_usd ?? 0),
      retry_known_cost_usd: number(row?.retry_known_cost_usd ?? 0),
      priced_requests: number(row?.priced_requests ?? 0),
      unpriced_requests: number(row?.unpriced_requests ?? 0),
    };
  }

  async createPlan(input: CreateProviderUsagePlan): Promise<ProviderUsagePlan> {
    const result = await this.query<PlanRow>(
      `INSERT INTO ai_provider_usage_plans (
         id, provider, plan_name, allowance_unit, allowance_amount,
         allowance_usd_equivalent, effective_from, effective_to, source,
         created_by_user_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [
        newId("ai_provider_plan"),
        input.provider,
        input.plan_name,
        input.allowance_unit,
        input.allowance_amount,
        input.allowance_usd_equivalent,
        input.effective_from,
        input.effective_to,
        input.source,
        input.created_by_user_id,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error("provider usage plan insert returned no row");
    return plan(row);
  }

  async plans(provider?: string): Promise<ProviderUsagePlan[]> {
    const result = await this.query<PlanRow>(
      `SELECT *
       FROM ai_provider_usage_plans
       ${provider ? "WHERE provider=$1" : ""}
       ORDER BY effective_from DESC, created_at DESC`,
      provider ? [provider] : [],
    );
    return result.rows.map(plan);
  }

  async addObservation(input: PersistCalibrationObservation): Promise<CalibrationObservation> {
    const result = await this.query<ObservationRow>(
      `INSERT INTO ai_usage_calibration_observations (
         id, plan_id, provider, model, subscription_tier, cycle_period,
         reset_at, cycle_start, cycle_end, observed_at,
         provider_reading_kind, provider_reading_unit, provider_reading_value,
         displayed_percentage, tokens_used_since_reset, implied_max_tokens,
         provider_reading_usd_equivalent, canonical_requests,
         canonical_input_tokens, canonical_output_tokens,
         canonical_cache_read_tokens, canonical_cache_write_tokens,
         canonical_known_cost_usd, canonical_unpriced_requests, confidence,
         source, evidence_note, recorded_by_user_id
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
         $18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28
       )
       RETURNING *`,
      [
        newId("ai_calibration"),
        input.plan_id,
        input.provider,
        input.model,
        input.subscription_tier,
        input.cycle_period,
        input.reset_at,
        input.cycle_start,
        input.cycle_end,
        input.observed_at,
        input.provider_reading_kind,
        input.provider_reading_unit,
        input.provider_reading_value,
        input.displayed_percentage,
        input.tokens_used_since_reset,
        input.implied_max_tokens,
        input.provider_reading_usd_equivalent,
        input.canonical_requests,
        input.canonical_input_tokens,
        input.canonical_output_tokens,
        input.canonical_cache_read_tokens,
        input.canonical_cache_write_tokens,
        input.canonical_known_cost_usd,
        input.canonical_unpriced_requests,
        input.confidence,
        input.source,
        input.evidence_note,
        input.recorded_by_user_id,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error("calibration observation insert returned no row");
    return observation(row);
  }

  async observations(provider?: string, limit = 100): Promise<CalibrationObservation[]> {
    const params: unknown[] = [];
    if (provider) params.push(provider);
    params.push(Math.min(Math.max(Math.trunc(limit), 1), 500));
    const result = await this.query<ObservationRow>(
      `SELECT *
       FROM ai_usage_calibration_observations
       ${provider ? "WHERE provider=$1" : ""}
       ORDER BY observed_at DESC, recorded_at DESC
       LIMIT $${params.length}`,
      params,
    );
    return result.rows.map(observation);
  }

  async priceProfiles(provider?: string): Promise<ModelPriceProfile[]> {
    const result = await this.query<PriceProfileRow>(
      `SELECT
         id, provider, model, pricing_version, input_per_million,
         output_per_million, effective_from, effective_to
       FROM ai_pricing_profiles
       ${provider ? "WHERE provider=$1" : ""}
       ORDER BY provider, model, effective_from DESC`,
      provider ? [provider] : [],
    );
    return result.rows.map((row) => ({
      ...row,
      input_per_million: number(row.input_per_million),
      output_per_million: number(row.output_per_million),
      effective_from: iso(row.effective_from),
      effective_to: row.effective_to === null ? null : iso(row.effective_to),
    }));
  }
}
