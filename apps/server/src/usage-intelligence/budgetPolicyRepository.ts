import type { V2SqlExecutor, V2TransactionRunner } from "../persistence/v2/database.js";

export type UsageBudgetScopeType = "global" | "user" | "project";
export type UsageBudgetPeriod = "daily" | "weekly" | "monthly";
export type UsageBudgetPolicyStatus = "active" | "disabled";
export type UsageBudgetMetric = "usd" | "tokens";
export type UsageBudgetNotificationStatus = "ready" | "delivered" | "dismissed";

export interface UsageBudgetPolicy {
  id: string;
  scopeType: UsageBudgetScopeType;
  scopeId: string | null;
  period: UsageBudgetPeriod;
  provider: string | null;
  model: string | null;
  limitUsd: number | null;
  limitTokens: number | null;
  thresholdPercentages: number[];
  status: UsageBudgetPolicyStatus;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateUsageBudgetPolicyRecord {
  id: string;
  scopeType: UsageBudgetScopeType;
  scopeId: string | null;
  period: UsageBudgetPeriod;
  provider: string | null;
  model: string | null;
  limitUsd: number | null;
  limitTokens: number | null;
  thresholdPercentages: number[];
  createdByUserId: string;
}

export interface SaveUsageBudgetPolicyRecord {
  id: string;
  limitUsd: number | null;
  limitTokens: number | null;
  thresholdPercentages: number[];
  status: UsageBudgetPolicyStatus;
}

export interface UsageBudgetPolicyFilters {
  scopeType?: UsageBudgetScopeType;
  scopeId?: string;
  status?: UsageBudgetPolicyStatus;
}

export interface UsageBudgetConsumption {
  consumedUsd: number;
  consumedTokens: number;
  unpricedRequests: number;
}

export interface CreateThresholdNotificationRecord {
  id: string;
  policyId: string;
  periodStart: string;
  periodEnd: string;
  thresholdPercentage: number;
  metric: UsageBudgetMetric;
  consumedUsd: number;
  consumedTokens: number;
  unpricedRequests: number;
  limitUsd: number | null;
  limitTokens: number | null;
}

export interface UsageBudgetThresholdNotification extends CreateThresholdNotificationRecord {
  deliveryStatus: UsageBudgetNotificationStatus;
  createdAt: string;
}

export interface UsageBudgetNotificationFilters extends UsageBudgetPolicyFilters {
  policyId?: string;
  deliveryStatus?: UsageBudgetNotificationStatus;
}

export interface UsageBudgetPolicyRepository {
  policy(policyId: string, forUpdate?: boolean): Promise<UsageBudgetPolicy | null>;
  create(record: CreateUsageBudgetPolicyRecord): Promise<UsageBudgetPolicy>;
  save(record: SaveUsageBudgetPolicyRecord): Promise<UsageBudgetPolicy>;
  list(filters?: UsageBudgetPolicyFilters): Promise<UsageBudgetPolicy[]>;
  activePolicies(policyId?: string): Promise<UsageBudgetPolicy[]>;
  consumption(
    policy: UsageBudgetPolicy,
    periodStart: string,
    cutoff: string,
  ): Promise<UsageBudgetConsumption>;
  insertThresholdNotification(
    record: CreateThresholdNotificationRecord,
  ): Promise<UsageBudgetThresholdNotification | null>;
  notifications(
    filters?: UsageBudgetNotificationFilters,
  ): Promise<UsageBudgetThresholdNotification[]>;
}

export interface UsageBudgetPolicyRepositoryStore {
  transaction<T>(work: (repository: UsageBudgetPolicyRepository) => Promise<T>): Promise<T>;
}

interface PolicyRow {
  id: string;
  scope_type: UsageBudgetScopeType;
  scope_user_id: string | null;
  scope_project_id: string | null;
  period: UsageBudgetPeriod;
  provider: string | null;
  model: string | null;
  limit_usd: string | number | null;
  limit_tokens: string | number | null;
  threshold_percentages: number[];
  status: UsageBudgetPolicyStatus;
  created_by_user_id: string;
  created_at: string | Date;
  updated_at: string | Date;
}

interface ConsumptionRow {
  consumed_usd: string | number | null;
  consumed_tokens: string | number | null;
  unpriced_requests: string | number;
}

interface NotificationRow {
  id: string;
  policy_id: string;
  period_start: string | Date;
  period_end: string | Date;
  threshold_percentage: string | number;
  metric: UsageBudgetMetric;
  consumed_usd: string | number;
  consumed_tokens: string | number;
  unpriced_requests: string | number;
  limit_usd: string | number | null;
  limit_tokens: string | number | null;
  delivery_status: UsageBudgetNotificationStatus;
  created_at: string | Date;
}

function number(value: string | number | null): number {
  return value === null ? 0 : Number(value);
}

function nullableNumber(value: string | number | null): number | null {
  return value === null ? null : Number(value);
}

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function policyFromRow(row: PolicyRow): UsageBudgetPolicy {
  return {
    id: row.id,
    scopeType: row.scope_type,
    scopeId: row.scope_user_id ?? row.scope_project_id,
    period: row.period,
    provider: row.provider,
    model: row.model,
    limitUsd: nullableNumber(row.limit_usd),
    limitTokens: nullableNumber(row.limit_tokens),
    thresholdPercentages: row.threshold_percentages.map(Number),
    status: row.status,
    createdByUserId: row.created_by_user_id,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function notificationFromRow(row: NotificationRow): UsageBudgetThresholdNotification {
  return {
    id: row.id,
    policyId: row.policy_id,
    periodStart: iso(row.period_start),
    periodEnd: iso(row.period_end),
    thresholdPercentage: Number(row.threshold_percentage),
    metric: row.metric,
    consumedUsd: number(row.consumed_usd),
    consumedTokens: number(row.consumed_tokens),
    unpricedRequests: number(row.unpriced_requests),
    limitUsd: nullableNumber(row.limit_usd),
    limitTokens: nullableNumber(row.limit_tokens),
    deliveryStatus: row.delivery_status,
    createdAt: iso(row.created_at),
  };
}

const policyColumns = `
  id, scope_type, scope_user_id, scope_project_id, period, provider, model,
  limit_usd, limit_tokens, threshold_percentages, status, created_by_user_id,
  created_at, updated_at`;

class SqlUsageBudgetPolicyRepository implements UsageBudgetPolicyRepository {
  constructor(private readonly sql: V2SqlExecutor) {}

  async policy(policyId: string, forUpdate = false): Promise<UsageBudgetPolicy | null> {
    const result = await this.sql.query<PolicyRow>(
      `SELECT ${policyColumns}
       FROM usage_budget_policies
       WHERE id=$1
       ${forUpdate ? "FOR UPDATE" : ""}`,
      [policyId],
    );
    const row = result.rows[0];
    return row ? policyFromRow(row) : null;
  }

  async create(record: CreateUsageBudgetPolicyRecord): Promise<UsageBudgetPolicy> {
    const result = await this.sql.query<PolicyRow>(
      `INSERT INTO usage_budget_policies (
         id, scope_type, scope_user_id, scope_project_id, period, provider, model,
         limit_usd, limit_tokens, threshold_percentages, created_by_user_id
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::smallint[],$11
       )
       RETURNING ${policyColumns}`,
      [
        record.id,
        record.scopeType,
        record.scopeType === "user" ? record.scopeId : null,
        record.scopeType === "project" ? record.scopeId : null,
        record.period,
        record.provider,
        record.model,
        record.limitUsd,
        record.limitTokens,
        record.thresholdPercentages,
        record.createdByUserId,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error("usage budget policy insert returned no row");
    return policyFromRow(row);
  }

  async save(record: SaveUsageBudgetPolicyRecord): Promise<UsageBudgetPolicy> {
    const result = await this.sql.query<PolicyRow>(
      `UPDATE usage_budget_policies
       SET limit_usd=$2,
           limit_tokens=$3,
           threshold_percentages=$4::smallint[],
           status=$5,
           updated_at=now()
       WHERE id=$1
       RETURNING ${policyColumns}`,
      [record.id, record.limitUsd, record.limitTokens, record.thresholdPercentages, record.status],
    );
    const row = result.rows[0];
    if (!row) throw new Error(`unknown usage budget policy "${record.id}"`);
    return policyFromRow(row);
  }

  async list(filters: UsageBudgetPolicyFilters = {}): Promise<UsageBudgetPolicy[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      clauses.push(`${sql}=$${params.length}`);
    };
    if (filters.scopeType) add("scope_type", filters.scopeType);
    if (filters.scopeId) {
      params.push(filters.scopeId);
      clauses.push(`(scope_user_id=$${params.length} OR scope_project_id=$${params.length})`);
    }
    if (filters.status) add("status", filters.status);
    const result = await this.sql.query<PolicyRow>(
      `SELECT ${policyColumns}
       FROM usage_budget_policies
       WHERE ${clauses.length === 0 ? "TRUE" : clauses.join(" AND ")}
       ORDER BY created_at, id`,
      params,
    );
    return result.rows.map(policyFromRow);
  }

  async activePolicies(policyId?: string): Promise<UsageBudgetPolicy[]> {
    const params: unknown[] = [];
    const policyPredicate =
      policyId === undefined
        ? ""
        : (() => {
            params.push(policyId);
            return `AND id=$${params.length}`;
          })();
    const result = await this.sql.query<PolicyRow>(
      `SELECT ${policyColumns}
       FROM usage_budget_policies
       WHERE status='active'
       ${policyPredicate}
       ORDER BY created_at, id
       FOR UPDATE`,
      params,
    );
    return result.rows.map(policyFromRow);
  }

  async consumption(
    policy: UsageBudgetPolicy,
    periodStart: string,
    cutoff: string,
  ): Promise<UsageBudgetConsumption> {
    // Canonical input_tokens already describes the request input. Cache-read
    // and cache-write fields are pricing categories, so adding them here would
    // double count tokens for providers that report both.
    const params: unknown[] = [periodStart, cutoff];
    const clauses = [
      "usage.event_type='usage_observed'",
      "usage.occurred_at >= $1",
      "usage.occurred_at < $2",
      `(usage.request_type <> 'runtime_aggregate_report'
        OR usage.run_id IS NULL
        OR NOT EXISTS (
          SELECT 1
          FROM ai_usage_events provider_event
          WHERE provider_event.run_id = usage.run_id
            AND provider_event.request_type <> 'runtime_aggregate_report'
        ))`,
    ];
    const add = (column: string, value: string) => {
      params.push(value);
      clauses.push(`usage.${column}=$${params.length}`);
    };
    if (policy.scopeType === "user" && policy.scopeId) {
      add("initiated_by_user_id", policy.scopeId);
    }
    if (policy.scopeType === "project" && policy.scopeId) {
      add("project_id", policy.scopeId);
    }
    if (policy.provider) add("provider", policy.provider);
    if (policy.model) add("model", policy.model);

    const result = await this.sql.query<ConsumptionRow>(
      `WITH ranked_usage AS (
         SELECT usage.*,
                ROW_NUMBER() OVER (
                  PARTITION BY request_id
                  ORDER BY sequence DESC, recorded_at DESC, id DESC
                ) AS usage_rank
         FROM ai_usage_events usage
         WHERE ${clauses.join(" AND ")}
       ),
       latest_usage AS (
         SELECT * FROM ranked_usage WHERE usage_rank=1
       ),
       adjustment_totals AS (
         SELECT adjustment.request_id,
                COALESCE(SUM(adjustment.input_tokens), 0) AS input_tokens,
                COALESCE(SUM(adjustment.output_tokens), 0) AS output_tokens,
                COALESCE(SUM(adjustment.cost_usd), 0) AS cost_usd
         FROM ai_usage_events adjustment
         JOIN latest_usage usage USING (request_id)
         WHERE adjustment.event_type='adjustment'
           AND adjustment.occurred_at < $2
         GROUP BY adjustment.request_id
       ),
       request_totals AS (
         SELECT usage.request_id,
                usage.input_tokens + usage.output_tokens
                  + COALESCE(adjustment.input_tokens, 0)
                  + COALESCE(adjustment.output_tokens, 0) AS tokens,
                CASE
                  WHEN usage.cost_usd IS NULL THEN NULL
                  ELSE usage.cost_usd + COALESCE(adjustment.cost_usd, 0)
                END AS cost_usd
         FROM latest_usage usage
         LEFT JOIN adjustment_totals adjustment USING (request_id)
       )
       SELECT GREATEST(COALESCE(SUM(cost_usd), 0), 0) AS consumed_usd,
              GREATEST(COALESCE(SUM(tokens), 0), 0) AS consumed_tokens,
              COUNT(*) FILTER (WHERE cost_usd IS NULL) AS unpriced_requests
       FROM request_totals`,
      params,
    );
    const row = result.rows[0];
    return {
      consumedUsd: number(row?.consumed_usd ?? null),
      consumedTokens: number(row?.consumed_tokens ?? null),
      unpricedRequests: number(row?.unpriced_requests ?? 0),
    };
  }

  async insertThresholdNotification(
    record: CreateThresholdNotificationRecord,
  ): Promise<UsageBudgetThresholdNotification | null> {
    const result = await this.sql.query<NotificationRow>(
      `INSERT INTO usage_budget_threshold_notifications (
         id, policy_id, period_start, period_end, threshold_percentage, metric,
         consumed_usd, consumed_tokens, unpriced_requests, limit_usd, limit_tokens
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (policy_id, period_start, threshold_percentage, metric)
       DO NOTHING
       RETURNING *`,
      [
        record.id,
        record.policyId,
        record.periodStart,
        record.periodEnd,
        record.thresholdPercentage,
        record.metric,
        record.consumedUsd,
        record.consumedTokens,
        record.unpricedRequests,
        record.limitUsd,
        record.limitTokens,
      ],
    );
    const row = result.rows[0];
    return row ? notificationFromRow(row) : null;
  }

  async notifications(
    filters: UsageBudgetNotificationFilters = {},
  ): Promise<UsageBudgetThresholdNotification[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    const add = (column: string, value: unknown) => {
      params.push(value);
      clauses.push(`${column}=$${params.length}`);
    };
    if (filters.policyId) add("notification.policy_id", filters.policyId);
    if (filters.deliveryStatus) {
      add("notification.delivery_status", filters.deliveryStatus);
    }
    if (filters.scopeType) add("policy.scope_type", filters.scopeType);
    if (filters.scopeId) {
      params.push(filters.scopeId);
      clauses.push(
        `(policy.scope_user_id=$${params.length} OR policy.scope_project_id=$${params.length})`,
      );
    }
    if (filters.status) add("policy.status", filters.status);
    const result = await this.sql.query<NotificationRow>(
      `SELECT notification.*
       FROM usage_budget_threshold_notifications notification
       JOIN usage_budget_policies policy ON policy.id=notification.policy_id
       WHERE ${clauses.length === 0 ? "TRUE" : clauses.join(" AND ")}
       ORDER BY notification.created_at DESC, notification.id DESC`,
      params,
    );
    return result.rows.map(notificationFromRow);
  }
}

export class PostgresUsageBudgetPolicyRepository implements UsageBudgetPolicyRepositoryStore {
  constructor(private readonly transactions: V2TransactionRunner) {}

  transaction<T>(work: (repository: UsageBudgetPolicyRepository) => Promise<T>): Promise<T> {
    return this.transactions.transaction((sql) => work(new SqlUsageBudgetPolicyRepository(sql)));
  }
}
