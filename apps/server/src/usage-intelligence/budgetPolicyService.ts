import { newId as defaultNewId } from "../ids.js";
import type {
  UsageBudgetMetric,
  UsageBudgetNotificationFilters,
  UsageBudgetPeriod,
  UsageBudgetPolicy,
  UsageBudgetPolicyFilters,
  UsageBudgetPolicyRepository,
  UsageBudgetPolicyRepositoryStore,
  UsageBudgetPolicyStatus,
  UsageBudgetScopeType,
  UsageBudgetThresholdNotification,
} from "./budgetPolicyRepository.js";

export type UsageBudgetPolicyErrorCode =
  | "policy_not_found"
  | "invalid_scope"
  | "invalid_limit"
  | "invalid_thresholds"
  | "invalid_model_scope";

export class UsageBudgetPolicyError extends Error {
  constructor(
    readonly code: UsageBudgetPolicyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "UsageBudgetPolicyError";
  }
}

export interface CreateUsageBudgetPolicyInput {
  scopeType: UsageBudgetScopeType;
  scopeId?: string | null;
  period: UsageBudgetPeriod;
  provider?: string | null;
  model?: string | null;
  limitUsd?: number | null;
  limitTokens?: number | null;
  thresholdPercentages?: number[];
  createdByUserId: string;
}

export interface UpdateUsageBudgetPolicyInput {
  limitUsd?: number | null;
  limitTokens?: number | null;
  thresholdPercentages?: number[];
  status?: UsageBudgetPolicyStatus;
}

export interface UsageBudgetPeriodBounds {
  start: string;
  end: string;
}

export interface UsageBudgetEvaluation {
  policy: UsageBudgetPolicy;
  periodStart: string;
  periodEnd: string;
  evaluatedAt: string;
  consumedUsd: number;
  consumedTokens: number;
  unpricedRequests: number;
  usdComplete: boolean;
  notificationsCreated: UsageBudgetThresholdNotification[];
}

type Clock = () => Date;
type IdFactory = (prefix: string) => string;

const DEFAULT_THRESHOLDS = [50, 75, 90, 100];

function assertScope(scopeType: UsageBudgetScopeType, scopeId: string | null): void {
  if (scopeType === "global" && scopeId !== null) {
    throw new UsageBudgetPolicyError("invalid_scope", "global budgets cannot have a scope id");
  }
  if (scopeType !== "global" && !scopeId) {
    throw new UsageBudgetPolicyError("invalid_scope", `${scopeType} budgets require a scope id`);
  }
}

function assertLimits(limitUsd: number | null, limitTokens: number | null): void {
  const validUsd = limitUsd === null || (Number.isFinite(limitUsd) && limitUsd > 0);
  const validTokens =
    limitTokens === null || (Number.isSafeInteger(limitTokens) && limitTokens > 0);
  if (!validUsd || !validTokens || (limitUsd === null && limitTokens === null)) {
    throw new UsageBudgetPolicyError(
      "invalid_limit",
      "at least one positive USD or token limit is required",
    );
  }
}

function assertThresholds(thresholds: readonly number[]): void {
  if (thresholds.length === 0) {
    throw new UsageBudgetPolicyError(
      "invalid_thresholds",
      "at least one threshold percentage is required",
    );
  }
  let previous = 0;
  for (const threshold of thresholds) {
    if (!Number.isInteger(threshold) || threshold < 1 || threshold > 100 || threshold <= previous) {
      throw new UsageBudgetPolicyError(
        "invalid_thresholds",
        "threshold percentages must be unique ascending integers between 1 and 100",
      );
    }
    previous = threshold;
  }
}

function assertModelScope(provider: string | null, model: string | null): void {
  if (model !== null && provider === null) {
    throw new UsageBudgetPolicyError(
      "invalid_model_scope",
      "model-scoped budgets require a provider",
    );
  }
}

function startOfUtcDay(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

export function usageBudgetPeriodBounds(
  period: UsageBudgetPeriod,
  at: Date,
): UsageBudgetPeriodBounds {
  const start = startOfUtcDay(at);
  if (period === "weekly") {
    const daysSinceMonday = (start.getUTCDay() + 6) % 7;
    start.setUTCDate(start.getUTCDate() - daysSinceMonday);
  } else if (period === "monthly") {
    start.setUTCDate(1);
  }

  const end = new Date(start);
  if (period === "daily") end.setUTCDate(end.getUTCDate() + 1);
  if (period === "weekly") end.setUTCDate(end.getUTCDate() + 7);
  if (period === "monthly") end.setUTCMonth(end.getUTCMonth() + 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

function reached(consumed: number, limit: number, threshold: number): boolean {
  return consumed * 100 >= limit * threshold;
}

async function requirePolicy(
  repository: UsageBudgetPolicyRepository,
  policyId: string,
  forUpdate = false,
): Promise<UsageBudgetPolicy> {
  const policy = await repository.policy(policyId, forUpdate);
  if (!policy) {
    throw new UsageBudgetPolicyError(
      "policy_not_found",
      `unknown usage budget policy "${policyId}"`,
    );
  }
  return policy;
}

export class UsageBudgetPolicyService {
  private readonly clock: Clock;
  private readonly newId: IdFactory;

  constructor(
    private readonly store: UsageBudgetPolicyRepositoryStore,
    options: { clock?: Clock; newId?: IdFactory } = {},
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.newId = options.newId ?? defaultNewId;
  }

  get(policyId: string): Promise<UsageBudgetPolicy> {
    return this.store.transaction((repository) => requirePolicy(repository, policyId));
  }

  list(filters: UsageBudgetPolicyFilters = {}): Promise<UsageBudgetPolicy[]> {
    return this.store.transaction((repository) => repository.list(filters));
  }

  create(input: CreateUsageBudgetPolicyInput): Promise<UsageBudgetPolicy> {
    const scopeId = input.scopeId?.trim() || null;
    const provider = input.provider?.trim() || null;
    const model = input.model?.trim() || null;
    const limitUsd = input.limitUsd ?? null;
    const limitTokens = input.limitTokens ?? null;
    const thresholdPercentages = input.thresholdPercentages ?? DEFAULT_THRESHOLDS;
    assertScope(input.scopeType, scopeId);
    assertLimits(limitUsd, limitTokens);
    assertThresholds(thresholdPercentages);
    assertModelScope(provider, model);
    return this.store.transaction((repository) =>
      repository.create({
        id: this.newId("usage_budget_policy"),
        scopeType: input.scopeType,
        scopeId,
        period: input.period,
        provider,
        model,
        limitUsd,
        limitTokens,
        thresholdPercentages: [...thresholdPercentages],
        createdByUserId: input.createdByUserId,
      }),
    );
  }

  update(policyId: string, input: UpdateUsageBudgetPolicyInput): Promise<UsageBudgetPolicy> {
    return this.store.transaction(async (repository) => {
      const current = await requirePolicy(repository, policyId, true);
      const limitUsd = input.limitUsd === undefined ? current.limitUsd : input.limitUsd;
      const limitTokens = input.limitTokens === undefined ? current.limitTokens : input.limitTokens;
      const thresholdPercentages = input.thresholdPercentages ?? current.thresholdPercentages;
      assertLimits(limitUsd, limitTokens);
      assertThresholds(thresholdPercentages);
      return repository.save({
        id: policyId,
        limitUsd,
        limitTokens,
        thresholdPercentages: [...thresholdPercentages],
        status: input.status ?? current.status,
      });
    });
  }

  evaluate(policyId?: string): Promise<UsageBudgetEvaluation[]> {
    const evaluatedAt = this.clock();
    const evaluatedAtIso = evaluatedAt.toISOString();
    return this.store.transaction(async (repository) => {
      const policies = await repository.activePolicies(policyId);
      if (policyId && policies.length === 0) {
        await requirePolicy(repository, policyId);
        return [];
      }
      const evaluations: UsageBudgetEvaluation[] = [];
      for (const policy of policies) {
        const bounds = usageBudgetPeriodBounds(policy.period, evaluatedAt);
        const cutoff = evaluatedAt.getTime() < Date.parse(bounds.end) ? evaluatedAtIso : bounds.end;
        const consumption = await repository.consumption(policy, bounds.start, cutoff);
        const notificationsCreated: UsageBudgetThresholdNotification[] = [];
        for (const threshold of policy.thresholdPercentages) {
          const metrics: UsageBudgetMetric[] = [];
          if (
            policy.limitUsd !== null &&
            reached(consumption.consumedUsd, policy.limitUsd, threshold)
          ) {
            metrics.push("usd");
          }
          if (
            policy.limitTokens !== null &&
            reached(consumption.consumedTokens, policy.limitTokens, threshold)
          ) {
            metrics.push("tokens");
          }
          for (const metric of metrics) {
            const created = await repository.insertThresholdNotification({
              id: this.newId("usage_budget_notification"),
              policyId: policy.id,
              periodStart: bounds.start,
              periodEnd: bounds.end,
              thresholdPercentage: threshold,
              metric,
              consumedUsd: consumption.consumedUsd,
              consumedTokens: consumption.consumedTokens,
              unpricedRequests: consumption.unpricedRequests,
              limitUsd: policy.limitUsd,
              limitTokens: policy.limitTokens,
            });
            if (created) notificationsCreated.push(created);
          }
        }
        evaluations.push({
          policy,
          periodStart: bounds.start,
          periodEnd: bounds.end,
          evaluatedAt: evaluatedAtIso,
          consumedUsd: consumption.consumedUsd,
          consumedTokens: consumption.consumedTokens,
          unpricedRequests: consumption.unpricedRequests,
          usdComplete: consumption.unpricedRequests === 0,
          notificationsCreated,
        });
      }
      return evaluations;
    });
  }

  notifications(
    filters: UsageBudgetNotificationFilters = {},
  ): Promise<UsageBudgetThresholdNotification[]> {
    return this.store.transaction((repository) => repository.notifications(filters));
  }
}
