import type {
  V2QueryResult,
  V2SqlExecutor,
  V2TransactionRunner,
} from "../persistence/v2/database.js";

export type UsageRequestStatus = "succeeded" | "failed" | "in_progress";
export type UsageTimeInterval = "day" | "week" | "month";
export type UsageBreakdownDimension = "provider" | "model" | "user" | "project" | "phase";

export interface UsageFilters {
  from?: string;
  to?: string;
  provider?: string;
  model?: string;
  userId?: string;
  projectId?: string;
  phaseId?: string;
  status?: UsageRequestStatus;
}

export interface UsageSummary {
  requests: number;
  succeeded_requests: number;
  failed_requests: number;
  in_progress_requests: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  /**
   * Null means at least one measured request in the result had no monetary
   * value (for example, subscription consumption). It must not be presented
   * as a complete zero-dollar total.
   */
  cost_usd: number | null;
  known_cost_usd: number;
  priced_requests: number;
  unpriced_requests: number;
  average_latency_ms: number | null;
  average_output_tokens: number | null;
  average_known_cost_usd: number | null;
}

export interface UsageTimePoint {
  bucket: string;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number | null;
  known_cost_usd: number;
  unpriced_requests: number;
}

export interface UsageBreakdownItem {
  dimension: UsageBreakdownDimension;
  value: string;
  requests: number;
  failed_requests: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number | null;
  known_cost_usd: number;
  unpriced_requests: number;
}

export interface UsageEventItem {
  id: string;
  request_id: string;
  sequence: number;
  event_type: string;
  occurred_at: string;
  provider: string;
  model: string;
  status: string;
  provider_request_id: string | null;
  endpoint: string;
  request_type: string;
  project_id: string | null;
  phase_id: string | null;
  task_id: string | null;
  run_id: string | null;
  initiated_by_user_id: string | null;
  usage_source: string;
  confidence: number;
  pricing_profile_id: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number | null;
  cost_classification: string;
  latency_ms: number | null;
  http_status: number | null;
  error_code: string | null;
  error_category: string | null;
}

export interface UsageEventPage {
  events: UsageEventItem[];
  limit: number;
  offset: number;
  has_more: boolean;
}

interface SummaryRow {
  requests: string | number;
  succeeded_requests: string | number;
  failed_requests: string | number;
  in_progress_requests: string | number;
  input_tokens: string | number;
  output_tokens: string | number;
  cache_read_tokens: string | number;
  cache_write_tokens: string | number;
  cost_usd: string | number | null;
  known_cost_usd: string | number | null;
  priced_requests: string | number;
  unpriced_requests: string | number;
  average_latency_ms: string | number | null;
  average_output_tokens: string | number | null;
  average_known_cost_usd: string | number | null;
}

interface TimeRow {
  bucket: string | Date;
  requests: string | number;
  input_tokens: string | number;
  output_tokens: string | number;
  cost_usd: string | number | null;
  known_cost_usd: string | number | null;
  unpriced_requests: string | number;
}

interface BreakdownRow {
  dimension: UsageBreakdownDimension;
  value: string | null;
  requests: string | number;
  failed_requests: string | number;
  input_tokens: string | number;
  output_tokens: string | number;
  cost_usd: string | number | null;
  known_cost_usd: string | number | null;
  unpriced_requests: string | number;
}

interface EventRow {
  id: string;
  request_id: string;
  sequence: string | number;
  event_type: string;
  occurred_at: string | Date;
  provider: string;
  model: string;
  status: string;
  provider_request_id: string | null;
  endpoint: string;
  request_type: string;
  project_id: string | null;
  phase_id: string | null;
  task_id: string | null;
  run_id: string | null;
  initiated_by_user_id: string | null;
  usage_source: string;
  confidence: string | number;
  pricing_profile_id: string | null;
  input_tokens: string | number | null;
  output_tokens: string | number | null;
  cache_read_tokens: string | number | null;
  cache_write_tokens: string | number | null;
  cost_usd: string | number | null;
  cost_classification: string;
  latency_ms: string | number | null;
  http_status: string | number | null;
  error_code: string | null;
  error_category: string | null;
}

function number(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullableNumber(value: string | number | null | undefined): number | null {
  return value === null || value === undefined ? null : number(value);
}

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

interface FilterSql {
  where: string;
  params: unknown[];
}

/**
 * Build predicates only from known columns. Values remain query parameters;
 * provider/model/user supplied text can never become executable SQL.
 */
function filterSql(filters: UsageFilters): FilterSql {
  const clauses: string[] = [
    `(s.request_type <> 'runtime_aggregate_report'
      OR s.run_id IS NULL
      OR NOT EXISTS (
        SELECT 1
        FROM ai_usage_events provider_event
        WHERE provider_event.run_id = s.run_id
          AND provider_event.request_type <> 'runtime_aggregate_report'
      ))`,
  ];
  const params: unknown[] = [];
  const add = (column: string, value: unknown, comparison = "=") => {
    params.push(value);
    clauses.push(`s.${column} ${comparison} $${params.length}`);
  };
  if (filters.from) add("occurred_at", filters.from, ">=");
  if (filters.to) add("occurred_at", filters.to, "<");
  if (filters.provider) add("provider", filters.provider);
  if (filters.model) add("model", filters.model);
  if (filters.userId) add("initiated_by_user_id", filters.userId);
  if (filters.projectId) add("project_id", filters.projectId);
  if (filters.phaseId) add("phase_id", filters.phaseId);
  return {
    where: clauses.join(" AND "),
    params,
  };
}

/**
 * One row per logical AI request.
 *
 * `usage_observed` is a cumulative snapshot, so only its highest sequence is
 * selected. Terminal lifecycle events intentionally contain no usage. Every
 * signed adjustment is then applied exactly once. This is the central
 * anti-double-counting rule shared by summaries and time series.
 */
function requestFactsCte(filters: UsageFilters, params: unknown[]): string {
  const filtered = filterSql(filters);
  params.push(...filtered.params);
  const statusPredicate = filters.status
    ? (() => {
        params.push(filters.status);
        return `WHERE r.request_status = $${params.length}`;
      })()
    : "";
  return `
    WITH qualifying_requests AS (
      SELECT
        s.request_id,
        s.occurred_at AS request_occurred_at,
        s.provider,
        s.model,
        s.initiated_by_user_id,
        s.project_id,
        s.phase_id
      FROM ai_usage_events s
      WHERE s.event_type = 'request_started'
        AND ${filtered.where}
    ),
    scoped_events AS (
      SELECT e.*
      FROM ai_usage_events e
      JOIN qualifying_requests q USING (request_id)
    ),
    request_rollup AS (
      SELECT
        q.request_id,
        q.request_occurred_at,
        q.provider,
        q.model,
        q.initiated_by_user_id,
        q.project_id,
        q.phase_id,
        CASE
          WHEN BOOL_OR(e.event_type = 'request_failed') THEN 'failed'
          WHEN BOOL_OR(e.event_type = 'request_completed') THEN 'succeeded'
          ELSE 'in_progress'
        END AS request_status,
        MAX(e.latency_ms) FILTER (
          WHERE e.event_type IN ('request_completed', 'request_failed')
        ) AS latency_ms
      FROM qualifying_requests q
      JOIN scoped_events e USING (request_id)
      WHERE e.event_type <> 'adjustment'
      GROUP BY
        q.request_id, q.request_occurred_at, q.provider, q.model,
        q.initiated_by_user_id, q.project_id, q.phase_id
    ),
    filtered_requests AS (
      SELECT r.*
      FROM request_rollup r
      ${statusPredicate}
    ),
    usage_ranked AS (
      SELECT
        e.*,
        ROW_NUMBER() OVER (
          PARTITION BY e.request_id
          ORDER BY e.sequence DESC, e.recorded_at DESC, e.id DESC
        ) AS usage_rank
      FROM scoped_events e
      JOIN filtered_requests r USING (request_id)
      WHERE e.event_type = 'usage_observed'
    ),
    adjustments AS (
      SELECT
        e.request_id,
        COALESCE(SUM(e.input_tokens), 0) AS input_tokens,
        COALESCE(SUM(e.output_tokens), 0) AS output_tokens,
        COALESCE(SUM(e.cache_read_tokens), 0) AS cache_read_tokens,
        COALESCE(SUM(e.cache_write_tokens), 0) AS cache_write_tokens,
        COALESCE(SUM(e.cost_usd), 0) AS cost_usd
      FROM scoped_events e
      JOIN filtered_requests r USING (request_id)
      WHERE e.event_type = 'adjustment'
      GROUP BY e.request_id
    ),
    request_facts AS (
      SELECT
        r.request_id,
        r.request_occurred_at,
        r.request_status,
        r.latency_ms,
        r.provider,
        r.model,
        r.initiated_by_user_id,
        r.project_id,
        r.phase_id,
        u.id AS usage_event_id,
        COALESCE(u.input_tokens, 0) + COALESCE(a.input_tokens, 0) AS input_tokens,
        COALESCE(u.output_tokens, 0) + COALESCE(a.output_tokens, 0) AS output_tokens,
        COALESCE(u.cache_read_tokens, 0) + COALESCE(a.cache_read_tokens, 0)
          AS cache_read_tokens,
        COALESCE(u.cache_write_tokens, 0) + COALESCE(a.cache_write_tokens, 0)
          AS cache_write_tokens,
        CASE
          WHEN u.id IS NULL THEN NULL
          WHEN u.cost_usd IS NULL THEN NULL
          ELSE u.cost_usd + COALESCE(a.cost_usd, 0)
        END AS cost_usd
      FROM filtered_requests r
      LEFT JOIN usage_ranked u
        ON u.request_id = r.request_id AND u.usage_rank = 1
      LEFT JOIN adjustments a ON a.request_id = r.request_id
    )`;
}

function eventFromRow(row: EventRow): UsageEventItem {
  return {
    id: row.id,
    request_id: row.request_id,
    sequence: number(row.sequence),
    event_type: row.event_type,
    occurred_at: iso(row.occurred_at),
    provider: row.provider,
    model: row.model,
    status: row.status,
    provider_request_id: row.provider_request_id,
    endpoint: row.endpoint,
    request_type: row.request_type,
    project_id: row.project_id,
    phase_id: row.phase_id,
    task_id: row.task_id,
    run_id: row.run_id,
    initiated_by_user_id: row.initiated_by_user_id,
    usage_source: row.usage_source,
    confidence: number(row.confidence),
    pricing_profile_id: row.pricing_profile_id,
    input_tokens: number(row.input_tokens),
    output_tokens: number(row.output_tokens),
    cache_read_tokens: number(row.cache_read_tokens),
    cache_write_tokens: number(row.cache_write_tokens),
    cost_usd: nullableNumber(row.cost_usd),
    cost_classification: row.cost_classification,
    latency_ms: nullableNumber(row.latency_ms),
    http_status: nullableNumber(row.http_status),
    error_code: row.error_code,
    error_category: row.error_category,
  };
}

export class UsageIntelligenceService {
  constructor(private readonly database: V2SqlExecutor | V2TransactionRunner) {}

  private query<TRow>(sql: string, params: unknown[]): Promise<V2QueryResult<TRow>> {
    if ("transaction" in this.database) {
      return this.database.transaction((transaction) => transaction.query<TRow>(sql, params));
    }
    return this.database.query<TRow>(sql, params);
  }

  async summary(filters: UsageFilters = {}): Promise<UsageSummary> {
    const params: unknown[] = [];
    const cte = requestFactsCte(filters, params);
    const result = await this.query<SummaryRow>(
      `${cte}
       SELECT
         COUNT(*) AS requests,
         COUNT(*) FILTER (WHERE request_status = 'succeeded') AS succeeded_requests,
         COUNT(*) FILTER (WHERE request_status = 'failed') AS failed_requests,
         COUNT(*) FILTER (WHERE request_status = 'in_progress') AS in_progress_requests,
         COALESCE(SUM(input_tokens), 0) AS input_tokens,
         COALESCE(SUM(output_tokens), 0) AS output_tokens,
         COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
         COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
         CASE
           WHEN COUNT(*) FILTER (
             WHERE usage_event_id IS NOT NULL AND cost_usd IS NULL
           ) > 0 THEN NULL
           ELSE COALESCE(SUM(cost_usd), 0)
         END AS cost_usd,
         COALESCE(SUM(cost_usd), 0) AS known_cost_usd,
         COUNT(*) FILTER (
           WHERE usage_event_id IS NOT NULL AND cost_usd IS NOT NULL
         ) AS priced_requests,
         COUNT(*) FILTER (
           WHERE usage_event_id IS NOT NULL AND cost_usd IS NULL
         ) AS unpriced_requests,
         AVG(latency_ms) AS average_latency_ms,
         AVG(output_tokens) AS average_output_tokens,
         AVG(cost_usd) FILTER (
           WHERE usage_event_id IS NOT NULL AND cost_usd IS NOT NULL
         ) AS average_known_cost_usd
       FROM request_facts`,
      params,
    );
    const row = result.rows[0];
    if (!row) {
      return {
        requests: 0,
        succeeded_requests: 0,
        failed_requests: 0,
        in_progress_requests: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        cost_usd: 0,
        known_cost_usd: 0,
        priced_requests: 0,
        unpriced_requests: 0,
        average_latency_ms: null,
        average_output_tokens: null,
        average_known_cost_usd: null,
      };
    }
    return {
      requests: number(row.requests),
      succeeded_requests: number(row.succeeded_requests),
      failed_requests: number(row.failed_requests),
      in_progress_requests: number(row.in_progress_requests),
      input_tokens: number(row.input_tokens),
      output_tokens: number(row.output_tokens),
      cache_read_tokens: number(row.cache_read_tokens),
      cache_write_tokens: number(row.cache_write_tokens),
      cost_usd: nullableNumber(row.cost_usd),
      known_cost_usd: number(row.known_cost_usd),
      priced_requests: number(row.priced_requests),
      unpriced_requests: number(row.unpriced_requests),
      average_latency_ms: nullableNumber(row.average_latency_ms),
      average_output_tokens: nullableNumber(row.average_output_tokens),
      average_known_cost_usd: nullableNumber(row.average_known_cost_usd),
    };
  }

  async timeSeries(
    filters: UsageFilters = {},
    interval: UsageTimeInterval = "day",
  ): Promise<UsageTimePoint[]> {
    const params: unknown[] = [];
    const cte = requestFactsCte(filters, params);
    // Interval is a closed union validated at the route and method boundary.
    const result = await this.query<TimeRow>(
      `${cte}
       SELECT
         (
           DATE_TRUNC('${interval}', request_occurred_at AT TIME ZONE 'UTC')
           AT TIME ZONE 'UTC'
         ) AS bucket,
         COUNT(*) AS requests,
         COALESCE(SUM(input_tokens), 0) AS input_tokens,
         COALESCE(SUM(output_tokens), 0) AS output_tokens,
         CASE
           WHEN COUNT(*) FILTER (
             WHERE usage_event_id IS NOT NULL AND cost_usd IS NULL
           ) > 0 THEN NULL
           ELSE COALESCE(SUM(cost_usd), 0)
         END AS cost_usd,
         COALESCE(SUM(cost_usd), 0) AS known_cost_usd,
         COUNT(*) FILTER (
           WHERE usage_event_id IS NOT NULL AND cost_usd IS NULL
         ) AS unpriced_requests
       FROM request_facts
       GROUP BY bucket
       ORDER BY bucket`,
      params,
    );
    return result.rows.map((row) => ({
      bucket: iso(row.bucket),
      requests: number(row.requests),
      input_tokens: number(row.input_tokens),
      output_tokens: number(row.output_tokens),
      cost_usd: nullableNumber(row.cost_usd),
      known_cost_usd: number(row.known_cost_usd),
      unpriced_requests: number(row.unpriced_requests),
    }));
  }

  async breakdown(
    filters: UsageFilters,
    dimensions: UsageBreakdownDimension[],
  ): Promise<UsageBreakdownItem[]> {
    const uniqueDimensions = [...new Set(dimensions)];
    if (uniqueDimensions.length === 0) return [];
    const columns: Record<UsageBreakdownDimension, string> = {
      provider: "provider",
      model: "model",
      user: "initiated_by_user_id",
      project: "project_id",
      phase: "phase_id",
    };
    const params: unknown[] = [];
    const cte = requestFactsCte(filters, params);
    const selects = uniqueDimensions.map((dimension) => {
      const column = columns[dimension];
      return `
        SELECT
          '${dimension}' AS dimension,
          COALESCE(${column}, 'unattributed') AS value,
          COUNT(*) AS requests,
          COUNT(*) FILTER (WHERE request_status = 'failed') AS failed_requests,
          COALESCE(SUM(input_tokens), 0) AS input_tokens,
          COALESCE(SUM(output_tokens), 0) AS output_tokens,
          CASE
            WHEN COUNT(*) FILTER (
              WHERE usage_event_id IS NOT NULL AND cost_usd IS NULL
            ) > 0 THEN NULL
            ELSE COALESCE(SUM(cost_usd), 0)
          END AS cost_usd,
          COALESCE(SUM(cost_usd), 0) AS known_cost_usd,
          COUNT(*) FILTER (
            WHERE usage_event_id IS NOT NULL AND cost_usd IS NULL
          ) AS unpriced_requests
        FROM request_facts
        GROUP BY ${column}`;
    });
    const result = await this.query<BreakdownRow>(
      `${cte}
       ${selects.join(" UNION ALL ")}
       ORDER BY dimension, known_cost_usd DESC, requests DESC, value`,
      params,
    );
    return result.rows.map((row) => ({
      dimension: row.dimension,
      value: row.value ?? "unattributed",
      requests: number(row.requests),
      failed_requests: number(row.failed_requests),
      input_tokens: number(row.input_tokens),
      output_tokens: number(row.output_tokens),
      cost_usd: nullableNumber(row.cost_usd),
      known_cost_usd: number(row.known_cost_usd),
      unpriced_requests: number(row.unpriced_requests),
    }));
  }

  async events(
    filters: UsageFilters = {},
    options: { limit?: number; offset?: number } = {},
  ): Promise<UsageEventPage> {
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 100), 1), 500);
    const offset = Math.max(Math.trunc(options.offset ?? 0), 0);
    const params: unknown[] = [];
    const cte = requestFactsCte(filters, params);
    params.push(limit + 1, offset);
    const result = await this.query<EventRow>(
      `${cte}
       SELECT
         e.id, e.request_id, e.sequence, e.event_type, e.occurred_at,
         e.provider, e.model, e.status, e.provider_request_id, e.endpoint,
         e.request_type, e.project_id, e.phase_id, e.task_id, e.run_id,
         e.initiated_by_user_id, e.usage_source, e.confidence,
         e.pricing_profile_id,
         e.input_tokens, e.output_tokens, e.cache_read_tokens,
         e.cache_write_tokens, e.cost_usd, e.cost_classification,
         e.latency_ms, e.http_status, e.error_code, e.error_category
       FROM scoped_events e
       JOIN filtered_requests r USING (request_id)
       ORDER BY e.occurred_at DESC, e.sequence DESC, e.id DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return {
      events: result.rows.slice(0, limit).map(eventFromRow),
      limit,
      offset,
      has_more: result.rows.length > limit,
    };
  }

  /**
   * Export is intentionally bounded. The route requests `limit + 1`, exposes
   * truncation in a response header, and never allows a single browser request
   * to accumulate an unbounded ledger in server memory.
   */
  async exportEvents(
    filters: UsageFilters = {},
    limit = 50_000,
  ): Promise<{ events: UsageEventItem[]; truncated: boolean }> {
    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 50_000);
    const params: unknown[] = [];
    const cte = requestFactsCte(filters, params);
    params.push(safeLimit + 1);
    const result = await this.query<EventRow>(
      `${cte}
       SELECT
         e.id, e.request_id, e.sequence, e.event_type, e.occurred_at,
         e.provider, e.model, e.status, e.provider_request_id, e.endpoint,
         e.request_type, e.project_id, e.phase_id, e.task_id, e.run_id,
         e.initiated_by_user_id, e.usage_source, e.confidence,
         e.pricing_profile_id,
         e.input_tokens, e.output_tokens, e.cache_read_tokens,
         e.cache_write_tokens, e.cost_usd, e.cost_classification,
         e.latency_ms, e.http_status, e.error_code, e.error_category
       FROM scoped_events e
       JOIN filtered_requests r USING (request_id)
       ORDER BY e.occurred_at DESC, e.sequence DESC, e.id DESC
       LIMIT $${params.length}`,
      params,
    );
    return {
      events: result.rows.slice(0, safeLimit).map(eventFromRow),
      truncated: result.rows.length > safeLimit,
    };
  }
}
