import type { UsageEventT } from "@norns/contracts";
import type {
  ConversationInferenceBudget,
  ConversationInferenceQuote,
  ConversationInferenceReservation,
  ConversationInferenceScope,
} from "../gateway/providerGateway.js";
import type { V2SqlExecutor, V2TransactionRunner } from "../persistence/v2/database.js";
import { usageBudgetPeriodBounds } from "../usage-intelligence/budgetPolicyService.js";

interface PolicyRow {
  id: string;
  scope_type: "global" | "user" | "project";
  period: "daily" | "weekly" | "monthly";
  provider: string | null;
  model: string | null;
  limit_usd: string | number | null;
  limit_tokens: string | number | null;
}

interface ReservationRow {
  reservation_key: string;
  usage_request_id: string;
  project_id: string;
  work_item_id: string;
  conversation_id: string;
  initiated_by_user_id: string;
  provider: string;
  model: string;
  max_input_tokens: number | string;
  max_output_tokens: number | string;
  max_charge_usd: number | string;
  status: "active" | "settled" | "released" | "retained_ambiguous";
  dispatch_started_at: string | Date | null;
}

function number(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error("invalid usage budget value");
  return parsed;
}

function sameReservation(
  row: ReservationRow,
  scope: ConversationInferenceScope,
  quote: ConversationInferenceQuote,
): boolean {
  return (
    row.usage_request_id === scope.usageRequestId &&
    row.project_id === scope.projectId &&
    row.work_item_id === scope.workItemId &&
    row.conversation_id === scope.conversationId &&
    row.initiated_by_user_id === scope.initiatedByUserId &&
    row.provider === scope.provider &&
    row.model === scope.model &&
    Number(row.max_input_tokens) === quote.maxInputTokens &&
    Number(row.max_output_tokens) === quote.maxOutputTokens &&
    Math.abs(Number(row.max_charge_usd) - quote.maxChargeUsd) < 1e-9
  );
}

export class SqlConversationInferenceBudget implements ConversationInferenceBudget {
  constructor(
    private readonly transactions: V2TransactionRunner,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async reserve(
    scope: ConversationInferenceScope,
    quote: ConversationInferenceQuote,
  ): Promise<ConversationInferenceReservation | null> {
    const reserved = await this.transactions.transaction(async (sql) => {
      const replay = (
        await sql.query<ReservationRow>(
          `SELECT * FROM conversation_inference_reservations
            WHERE reservation_key=$1 FOR UPDATE`,
          [scope.reservationKey],
        )
      ).rows[0];
      if (replay) {
        if (!sameReservation(replay, scope, quote)) {
          throw new Error("conversation reservation idempotency conflict");
        }
        return replay;
      }

      const policies = (
        await sql.query<PolicyRow>(
          `SELECT id,scope_type,period,provider,model,limit_usd,limit_tokens
             FROM usage_budget_policies
            WHERE status='active'
              AND (
                scope_type='global'
                OR (scope_type='user' AND scope_user_id=$1)
                OR (scope_type='project' AND scope_project_id=$2)
              )
              AND (provider IS NULL OR provider=$3)
              AND (model IS NULL OR model=$4)
            ORDER BY id
            FOR UPDATE`,
          [scope.initiatedByUserId, scope.projectId, scope.provider, scope.model],
        )
      ).rows;

      for (const policy of policies) {
        const limitUsd = number(policy.limit_usd);
        const limitTokens = number(policy.limit_tokens);
        if (limitUsd === null && limitTokens === null) {
          throw new Error(`usage budget policy "${policy.id}" is incomplete`);
        }
        const bounds = usageBudgetPeriodBounds(policy.period, this.now());
        // READ COMMITTED takes a new snapshot per statement. Read the fallback
        // first: if canonical telemetry commits between these reads, spend is
        // temporarily counted twice (safe refusal) instead of missed by both.
        const held = await this.held(sql, scope, policy, bounds.start, bounds.end);
        const consumed = await this.consumed(sql, scope, policy, bounds.start, bounds.end);
        if (limitUsd !== null && consumed.unpricedRequests > 0) {
          throw new Error(`usage budget policy "${policy.id}" has unpriced historical usage`);
        }
        if (
          (limitUsd !== null && consumed.usd + held.usd + quote.maxChargeUsd > limitUsd + 1e-9) ||
          (limitTokens !== null &&
            consumed.tokens + held.tokens + quote.maxInputTokens + quote.maxOutputTokens >
              limitTokens)
        ) {
          return null;
        }
      }

      return (
        await sql.query<ReservationRow>(
          `INSERT INTO conversation_inference_reservations (
             reservation_key,usage_request_id,project_id,work_item_id,conversation_id,
             initiated_by_user_id,provider,model,max_input_tokens,max_output_tokens,
             max_charge_usd,status
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'active')
           RETURNING *`,
          [
            scope.reservationKey,
            scope.usageRequestId,
            scope.projectId,
            scope.workItemId,
            scope.conversationId,
            scope.initiatedByUserId,
            scope.provider,
            scope.model,
            quote.maxInputTokens,
            quote.maxOutputTokens,
            quote.maxChargeUsd,
          ],
        )
      ).rows[0];
    });
    return reserved ? this.hold(scope.reservationKey) : null;
  }

  private hold(reservationKey: string): ConversationInferenceReservation {
    return {
      markDispatching: () =>
        this.transactions.transaction(async (sql) => {
          const updated = await sql.query<{ reservation_key: string }>(
            `UPDATE conversation_inference_reservations
                SET dispatch_started_at=COALESCE(dispatch_started_at,now()),updated_at=now()
              WHERE reservation_key=$1 AND status='active'
              RETURNING reservation_key`,
            [reservationKey],
          );
          if (!updated.rows[0]) {
            throw new Error(`inactive conversation reservation "${reservationKey}"`);
          }
        }),
      settle: (usage) => this.resolve(reservationKey, "settled", usage),
      release: () => this.resolve(reservationKey, "released"),
      retainAmbiguous: () => this.resolve(reservationKey, "retained_ambiguous"),
    };
  }

  reconcile(): Promise<number> {
    return this.transactions.transaction(async (sql) => {
      const active = await sql.query<
        ReservationRow & {
          provider_request_id: string | null;
          usage_status: "pending" | "exact" | "unavailable";
          input_tokens: string | number | null;
          output_tokens: string | number | null;
          cost_usd: string | number | null;
        }
      >(
        `SELECT reservation.*,attempt.provider_request_id,attempt.usage_status,
                attempt.input_tokens,attempt.output_tokens,attempt.cost_usd
           FROM conversation_inference_reservations reservation
           JOIN conversation_turn_attempts attempt ON attempt.id=reservation.reservation_key
          WHERE reservation.status='active'
          ORDER BY reservation.created_at,reservation.reservation_key
          FOR UPDATE OF reservation`,
      );
      for (const row of active.rows) {
        const exact = row.usage_status === "exact";
        const definitelyUndispatched =
          row.dispatch_started_at === null && row.provider_request_id === null;
        const status = exact
          ? "settled"
          : definitelyUndispatched
            ? "released"
            : "retained_ambiguous";
        const actualCharge = exact
          ? Number(row.cost_usd ?? 0)
          : status === "retained_ambiguous"
            ? Number(row.max_charge_usd)
            : 0;
        const actualTokens = exact
          ? Number(row.input_tokens ?? 0) + Number(row.output_tokens ?? 0)
          : status === "retained_ambiguous"
            ? Number(row.max_input_tokens) + Number(row.max_output_tokens)
            : 0;
        await sql.query(
          `UPDATE conversation_inference_reservations
              SET status=$2,actual_charge_usd=$3,actual_tokens=$4,
                  resolved_at=now(),updated_at=now()
            WHERE reservation_key=$1 AND status='active'`,
          [row.reservation_key, status, actualCharge, actualTokens],
        );
      }
      return active.rows.length;
    });
  }

  private async resolve(
    reservationKey: string,
    outcome: "settled" | "released" | "retained_ambiguous",
    usage?: UsageEventT,
  ): Promise<void> {
    await this.transactions.transaction(async (sql) => {
      const row = (
        await sql.query<ReservationRow>(
          `SELECT * FROM conversation_inference_reservations
            WHERE reservation_key=$1 FOR UPDATE`,
          [reservationKey],
        )
      ).rows[0];
      if (!row) throw new Error(`unknown conversation reservation "${reservationKey}"`);
      if (row.status !== "active") return;
      const actualUsd =
        outcome === "settled"
          ? (usage?.actual_cost_usd ?? usage?.estimated_cost_usd)
          : outcome === "retained_ambiguous"
            ? Number(row.max_charge_usd)
            : 0;
      const actualTokens =
        outcome === "settled"
          ? (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0)
          : outcome === "retained_ambiguous"
            ? Number(row.max_input_tokens) + Number(row.max_output_tokens)
            : 0;
      if (outcome === "settled" && !usage) {
        throw new Error("exact settlement requires provider usage");
      }
      await sql.query(
        `UPDATE conversation_inference_reservations
            SET status=$2,actual_charge_usd=$3,actual_tokens=$4,resolved_at=now(),updated_at=now()
          WHERE reservation_key=$1 AND status='active'`,
        [reservationKey, outcome, actualUsd, actualTokens],
      );
    });
  }

  private async consumed(
    sql: V2SqlExecutor,
    scope: ConversationInferenceScope,
    policy: PolicyRow,
    start: string,
    end: string,
  ): Promise<{ usd: number; tokens: number; unpricedRequests: number }> {
    const params: unknown[] = [start, end];
    const clauses = [
      "usage.event_type='usage_observed'",
      "usage.occurred_at >= $1",
      "usage.occurred_at < $2",
      `(usage.request_type <> 'runtime_aggregate_report'
        OR usage.run_id IS NULL
        OR NOT EXISTS (
          SELECT 1
            FROM ai_usage_events provider_event
           WHERE provider_event.run_id=usage.run_id
             AND provider_event.request_type <> 'runtime_aggregate_report'
        ))`,
    ];
    const add = (column: string, value: string) => {
      params.push(value);
      clauses.push(`usage.${column}=$${params.length}`);
    };
    if (policy.scope_type === "user") add("initiated_by_user_id", scope.initiatedByUserId);
    if (policy.scope_type === "project") add("project_id", scope.projectId);
    if (policy.provider) add("provider", scope.provider);
    if (policy.model) add("model", scope.model);
    const row = (
      await sql.query<{
        usd: string | number;
        tokens: string | number;
        unpriced_requests: string | number;
      }>(
        `WITH ranked_usage AS (
           SELECT usage.*,row_number() OVER (
             PARTITION BY request_id ORDER BY sequence DESC,recorded_at DESC,id DESC
           ) AS usage_rank
             FROM ai_usage_events usage WHERE ${clauses.join(" AND ")}
         ),
         latest_usage AS (
           SELECT * FROM ranked_usage WHERE usage_rank=1
         ),
         adjustment_totals AS (
           SELECT adjustment.request_id,
                  COALESCE(sum(adjustment.input_tokens),0) AS input_tokens,
                  COALESCE(sum(adjustment.output_tokens),0) AS output_tokens,
                  COALESCE(sum(adjustment.cost_usd),0) AS cost_usd
             FROM ai_usage_events adjustment
             JOIN latest_usage usage USING (request_id)
            WHERE adjustment.event_type='adjustment'
              AND adjustment.occurred_at < $2
            GROUP BY adjustment.request_id
         ),
         request_totals AS (
           SELECT usage.request_id,
                  usage.input_tokens+usage.output_tokens
                    +COALESCE(adjustment.input_tokens,0)
                    +COALESCE(adjustment.output_tokens,0) AS tokens,
                  CASE WHEN usage.cost_usd IS NULL THEN NULL
                    ELSE usage.cost_usd+COALESCE(adjustment.cost_usd,0)
                  END AS cost_usd
             FROM latest_usage usage
             LEFT JOIN adjustment_totals adjustment USING (request_id)
         )
         SELECT GREATEST(COALESCE(sum(cost_usd),0),0) AS usd,
                GREATEST(COALESCE(sum(tokens),0),0) AS tokens,
                count(*) FILTER (WHERE cost_usd IS NULL) AS unpriced_requests
           FROM request_totals`,
        params,
      )
    ).rows[0];
    return {
      usd: Number(row?.usd ?? 0),
      tokens: Number(row?.tokens ?? 0),
      unpricedRequests: Number(row?.unpriced_requests ?? 0),
    };
  }

  private async held(
    sql: V2SqlExecutor,
    scope: ConversationInferenceScope,
    policy: PolicyRow,
    start: string,
    end: string,
  ): Promise<{ usd: number; tokens: number }> {
    const params: unknown[] = [start, end];
    const clauses = [
      "reservation.created_at >= $1",
      "reservation.created_at < $2",
      `(reservation.status IN ('active','retained_ambiguous')
        OR (
          reservation.status='settled'
          AND NOT EXISTS (
            SELECT 1
              FROM ai_usage_events usage
             WHERE usage.request_id=reservation.usage_request_id
               AND usage.event_type='usage_observed'
          )
        ))`,
    ];
    const add = (column: string, value: string) => {
      params.push(value);
      clauses.push(`reservation.${column}=$${params.length}`);
    };
    if (policy.scope_type === "user") add("initiated_by_user_id", scope.initiatedByUserId);
    if (policy.scope_type === "project") add("project_id", scope.projectId);
    if (policy.provider) add("provider", scope.provider);
    if (policy.model) add("model", scope.model);
    const row = (
      await sql.query<{ usd: string | number; tokens: string | number }>(
        `SELECT COALESCE(sum(
                  CASE WHEN reservation.status='active'
                    THEN reservation.max_charge_usd
                    ELSE reservation.actual_charge_usd
                  END
                ),0) AS usd,
                COALESCE(sum(
                  CASE WHEN reservation.status='active'
                    THEN reservation.max_input_tokens+reservation.max_output_tokens
                    ELSE reservation.actual_tokens
                  END
                ),0) AS tokens
           FROM conversation_inference_reservations reservation
          WHERE ${clauses.join(" AND ")}`,
        params,
      )
    ).rows[0];
    return { usd: Number(row?.usd ?? 0), tokens: Number(row?.tokens ?? 0) };
  }
}
