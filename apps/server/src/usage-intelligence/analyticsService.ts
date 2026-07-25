import type { V2TransactionRunner } from "../persistence/v2/database.js";
import {
  type AnalyticsFilters,
  type CalibrationObservation,
  type CreateCalibrationObservation,
  type CreateProviderUsagePlan,
  type HotSpotDimension,
  type ProviderUsagePlan,
  UsageAnalyticsRepository,
  type UsageHotSpot,
  type UsageSignals,
} from "./analyticsRepository.js";

const DAY_MS = 86_400_000;

export interface SignalMetrics extends UsageSignals {
  failure_rate: number;
  retry_rate: number;
  cache_efficiency: number;
  average_input_tokens: number;
  average_output_tokens: number;
  average_known_cost_usd: number | null;
}

export interface TrendComparison {
  from: string;
  to: string;
  current: SignalMetrics;
  previous: SignalMetrics;
  change: {
    requests_percent: number | null;
    tokens_percent: number | null;
    known_cost_percent: number | null;
    failure_rate_points: number;
    retry_rate_points: number;
    cache_efficiency_points: number;
  };
}

export interface CalibrationComparison {
  observation_id: string;
  provider: string;
  observed_at: string;
  unit: "tokens" | "requests" | "usd_equivalent";
  actual: number;
  estimated: number;
  actual_to_estimated_ratio: number | null;
  absolute_error_percent: number | null;
  confidence: number;
}

export interface CalibrationReport {
  provider: string | null;
  comparisons: CalibrationComparison[];
  mean_absolute_error_percent: number | null;
  mean_actual_to_estimated_ratio: number | null;
}

export interface CycleForecast {
  provider: string;
  plan_id: string;
  plan_name: string;
  cycle_start: string;
  cycle_end: string;
  allowance_unit: string;
  allowance_amount: number;
  model: string;
  subscription_tier: string;
  cycle_period: "weekly" | "monthly";
  observed_used: number;
  observed_remaining: number;
  rolling_estimated_max_tokens: number;
  estimated_weekly_limit: number;
  estimated_monthly_limit: number;
  confidence_interval_low: number | null;
  confidence_interval_high: number | null;
  confidence_rating: "low" | "medium" | "high";
  utilization_percent: number;
  daily_burn_rate: number | null;
  forecast_exhaustion_at: string | null;
  status: "insufficient_data" | "on_track" | "at_risk" | "exhausted";
  confidence: number;
  observations: number;
  reset_history: Array<{
    reset_at: string;
    observations: number;
    latest_tokens_used: number;
    latest_displayed_percentage: number;
    implied_max_tokens: number;
  }>;
}

export interface OptimizationRecommendation {
  id: string;
  category: "reliability" | "retry" | "caching" | "prompt" | "model" | "workflow";
  priority: "high" | "medium" | "low";
  title: string;
  recommendation: string;
  evidence: string[];
  estimated_savings_usd: number;
  confidence: number;
  assumptions: string[];
}

function rate(numerator: number, denominator: number): number {
  return denominator <= 0 ? 0 : numerator / denominator;
}

function rounded(value: number, precision = 6): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function metrics(signals: UsageSignals): SignalMetrics {
  return {
    ...signals,
    failure_rate: rounded(rate(signals.failed_requests, signals.requests)),
    retry_rate: rounded(rate(signals.retried_requests, signals.requests)),
    cache_efficiency: rounded(
      rate(signals.cache_read_tokens, signals.input_tokens + signals.cache_read_tokens),
    ),
    average_input_tokens: rounded(rate(signals.input_tokens, signals.requests), 2),
    average_output_tokens: rounded(rate(signals.output_tokens, signals.requests), 2),
    average_known_cost_usd:
      signals.priced_requests === 0
        ? null
        : rounded(signals.known_cost_usd / signals.priced_requests, 6),
  };
}

function percentChange(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null;
  return rounded(((current - previous) / previous) * 100, 2);
}

function observationUsed(
  plan: ProviderUsagePlan,
  observation: CalibrationObservation,
): number | null {
  if (observation.provider_reading_kind === "utilization_percent") {
    return observation.tokens_used_since_reset;
  }
  if (observation.provider_reading_unit !== plan.allowance_unit) {
    return null;
  }
  if (observation.provider_reading_kind === "remaining") {
    return Math.max(plan.allowance_amount - observation.provider_reading_value, 0);
  }
  return observation.provider_reading_value;
}

function cycleEnd(resetAt: string, period: "weekly" | "monthly"): string {
  const end = new Date(resetAt);
  if (period === "weekly") {
    end.setUTCDate(end.getUTCDate() + 7);
  } else {
    end.setUTCMonth(end.getUTCMonth() + 1);
  }
  return end.toISOString();
}

function sanitizeEvidenceNote(value: string | null): string | null {
  if (value === null) return null;
  const withoutMarkupOrSecrets = value
    .replace(/<[^>]*>/g, " ")
    .replace(
      /\b(api[_ -]?key|access[_ -]?token|password|secret)\b\s*[:=]\s*\S+/gi,
      "$1=[redacted]",
    );
  const sanitized = [...withoutMarkupOrSecrets]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? " " : character;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
  return sanitized.length === 0 ? null : sanitized;
}

function observationConfidence(requests: number, displayedPercentage: number): number {
  const sample = Math.min(requests / 20, 1);
  const roundingPenalty = displayedPercentage < 2 ? 0.65 : displayedPercentage < 5 ? 0.8 : 1;
  return rounded((0.45 + sample * 0.45) * roundingPenalty, 4);
}

function comparison(
  plan: ProviderUsagePlan,
  item: CalibrationObservation,
): CalibrationComparison | null {
  let unit: CalibrationComparison["unit"];
  let actual: number;
  let estimated: number;
  const actualUsd =
    item.provider_reading_kind === "utilization_percent"
      ? null
      : item.provider_reading_kind === "remaining"
        ? plan.allowance_usd_equivalent === null || item.provider_reading_usd_equivalent === null
          ? null
          : Math.max(plan.allowance_usd_equivalent - item.provider_reading_usd_equivalent, 0)
        : item.provider_reading_usd_equivalent;
  if (actualUsd !== null && item.canonical_known_cost_usd !== null) {
    unit = "usd_equivalent";
    actual = actualUsd;
    estimated = item.canonical_known_cost_usd;
  } else if (plan.allowance_unit === "tokens") {
    const used = observationUsed(plan, item);
    if (used === null) return null;
    unit = "tokens";
    actual = used;
    estimated =
      item.canonical_input_tokens +
      item.canonical_output_tokens +
      item.canonical_cache_read_tokens +
      item.canonical_cache_write_tokens;
  } else if (plan.allowance_unit === "requests") {
    const used = observationUsed(plan, item);
    if (used === null) return null;
    unit = "requests";
    actual = used;
    estimated = item.canonical_requests;
  } else {
    return null;
  }
  return {
    observation_id: item.id,
    provider: item.provider,
    observed_at: item.observed_at,
    unit,
    actual,
    estimated,
    actual_to_estimated_ratio: estimated === 0 ? null : rounded(actual / estimated),
    absolute_error_percent:
      actual === 0
        ? estimated === 0
          ? 0
          : null
        : rounded((Math.abs(actual - estimated) / actual) * 100, 2),
    confidence: item.confidence,
  };
}

export class UsageAnalyticsService {
  readonly repository: UsageAnalyticsRepository;

  constructor(
    transactions: V2TransactionRunner,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.repository = new UsageAnalyticsRepository(transactions);
  }

  async trends(
    filters: AnalyticsFilters = {},
    range: { from?: string; to?: string } = {},
  ): Promise<TrendComparison> {
    const to = new Date(range.to ?? filters.to ?? this.clock().toISOString());
    const from = new Date(range.from ?? filters.from ?? to.getTime() - 30 * DAY_MS);
    if (
      Number.isNaN(from.valueOf()) ||
      Number.isNaN(to.valueOf()) ||
      from.valueOf() >= to.valueOf()
    ) {
      throw new Error("analytics range must have a valid from before to");
    }
    const duration = to.getTime() - from.getTime();
    const previousFrom = new Date(from.getTime() - duration);
    const { from: _filteredFrom, to: _filteredTo, ...common } = filters;
    const [currentSignals, previousSignals] = await Promise.all([
      this.repository.signals({
        ...common,
        from: from.toISOString(),
        to: to.toISOString(),
      }),
      this.repository.signals({
        ...common,
        from: previousFrom.toISOString(),
        to: from.toISOString(),
      }),
    ]);
    const current = metrics(currentSignals);
    const previous = metrics(previousSignals);
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      current,
      previous,
      change: {
        requests_percent: percentChange(current.requests, previous.requests),
        tokens_percent: percentChange(
          current.input_tokens + current.output_tokens,
          previous.input_tokens + previous.output_tokens,
        ),
        known_cost_percent: percentChange(current.known_cost_usd, previous.known_cost_usd),
        failure_rate_points: rounded((current.failure_rate - previous.failure_rate) * 100, 2),
        retry_rate_points: rounded((current.retry_rate - previous.retry_rate) * 100, 2),
        cache_efficiency_points: rounded(
          (current.cache_efficiency - previous.cache_efficiency) * 100,
          2,
        ),
      },
    };
  }

  async signals(filters: AnalyticsFilters = {}): Promise<SignalMetrics> {
    return metrics(await this.repository.signals(filters));
  }

  hotSpots(
    dimension: HotSpotDimension,
    filters: AnalyticsFilters = {},
    limit = 10,
  ): Promise<UsageHotSpot[]> {
    return this.repository.hotSpots(dimension, filters, limit);
  }

  async createPlan(input: CreateProviderUsagePlan): Promise<ProviderUsagePlan> {
    if (
      input.provider.trim().length === 0 ||
      input.plan_name.trim().length === 0 ||
      input.source.trim().length === 0
    ) {
      throw new Error("provider, plan name, and source are required");
    }
    if (!Number.isFinite(input.allowance_amount) || input.allowance_amount <= 0) {
      throw new Error("allowance amount must be positive");
    }
    if (
      input.effective_to !== null &&
      Date.parse(input.effective_to) <= Date.parse(input.effective_from)
    ) {
      throw new Error("plan effective_to must be after effective_from");
    }
    return this.repository.createPlan(input);
  }

  plans(provider?: string): Promise<ProviderUsagePlan[]> {
    return this.repository.plans(provider);
  }

  async addObservation(input: CreateCalibrationObservation): Promise<CalibrationObservation> {
    const selected = (await this.repository.plans(input.provider)).find(
      (candidate) => candidate.id === input.plan_id,
    );
    if (!selected) throw new Error("calibration plan was not found for this provider");
    const cycleStart = Date.parse(input.reset_at);
    const derivedCycleEnd = Date.parse(cycleEnd(input.reset_at, input.cycle_period));
    const observedAt = Date.parse(input.observed_at);
    if (
      !Number.isFinite(cycleStart) ||
      !Number.isFinite(derivedCycleEnd) ||
      !Number.isFinite(observedAt) ||
      derivedCycleEnd <= cycleStart ||
      observedAt < cycleStart ||
      observedAt >= derivedCycleEnd
    ) {
      throw new Error("observation time must fall within a valid usage cycle");
    }
    if (
      !Number.isFinite(input.displayed_percentage) ||
      input.displayed_percentage <= 0 ||
      input.displayed_percentage > 100
    ) {
      throw new Error("displayed percentage must be greater than zero and at most 100");
    }
    const canonical = await this.repository.signals({
      provider: input.provider,
      model: input.model,
      from: input.reset_at,
      to: input.observed_at,
    });
    const tokensUsedSinceReset = canonical.input_tokens + canonical.output_tokens;
    const impliedMaxTokens = tokensUsedSinceReset / (input.displayed_percentage / 100);
    return this.repository.addObservation({
      ...input,
      reset_at: new Date(input.reset_at).toISOString(),
      cycle_start: new Date(input.reset_at).toISOString(),
      cycle_end: new Date(derivedCycleEnd).toISOString(),
      provider_reading_kind: "utilization_percent",
      provider_reading_unit: "percent",
      provider_reading_value: input.displayed_percentage,
      displayed_percentage: input.displayed_percentage,
      tokens_used_since_reset: tokensUsedSinceReset,
      implied_max_tokens: impliedMaxTokens,
      provider_reading_usd_equivalent: null,
      canonical_requests: canonical.requests,
      canonical_input_tokens: canonical.input_tokens,
      canonical_output_tokens: canonical.output_tokens,
      canonical_cache_read_tokens: canonical.cache_read_tokens,
      canonical_cache_write_tokens: canonical.cache_write_tokens,
      canonical_known_cost_usd: canonical.unpriced_requests > 0 ? null : canonical.known_cost_usd,
      canonical_unpriced_requests: canonical.unpriced_requests,
      confidence: observationConfidence(canonical.requests, input.displayed_percentage),
      evidence_note: sanitizeEvidenceNote(input.evidence_note),
    });
  }

  observations(provider?: string, limit = 100): Promise<CalibrationObservation[]> {
    return this.repository.observations(provider, limit);
  }

  async calibration(provider?: string): Promise<CalibrationReport> {
    const [plans, observations] = await Promise.all([
      this.repository.plans(provider),
      this.repository.observations(provider, 500),
    ]);
    const planById = new Map(plans.map((item) => [item.id, item]));
    const comparisons = observations.flatMap((item) => {
      const selected = planById.get(item.plan_id);
      if (!selected) return [];
      const compared = comparison(selected, item);
      return compared ? [compared] : [];
    });
    const comparableErrors = comparisons
      .map((item) => item.absolute_error_percent)
      .filter((value): value is number => value !== null);
    const comparableRatios = comparisons
      .map((item) => item.actual_to_estimated_ratio)
      .filter((value): value is number => value !== null);
    return {
      provider: provider ?? null,
      comparisons,
      mean_absolute_error_percent:
        comparableErrors.length === 0
          ? null
          : rounded(
              comparableErrors.reduce((sum, value) => sum + value, 0) / comparableErrors.length,
              2,
            ),
      mean_actual_to_estimated_ratio:
        comparableRatios.length === 0
          ? null
          : rounded(
              comparableRatios.reduce((sum, value) => sum + value, 0) / comparableRatios.length,
            ),
    };
  }

  async forecast(provider: string): Promise<CycleForecast | null> {
    const now = this.clock();
    const plans = await this.repository.plans(provider);
    const selected =
      plans.find(
        (item) =>
          Date.parse(item.effective_from) <= now.getTime() &&
          (item.effective_to === null || Date.parse(item.effective_to) > now.getTime()),
      ) ?? plans[0];
    if (!selected) return null;
    const all = (await this.repository.observations(provider, 500)).filter(
      (item) => item.plan_id === selected.id,
    );
    const current = all.filter(
      (item) =>
        Date.parse(item.cycle_start) <= now.getTime() &&
        Date.parse(item.cycle_end) >= now.getTime(),
    );
    const cycle =
      current.length > 0 ? current : all.filter((item) => item.cycle_start === all[0]?.cycle_start);
    if (cycle.length === 0) return null;
    const ordered = [...cycle].sort(
      (left, right) => Date.parse(left.observed_at) - Date.parse(right.observed_at),
    );
    const latestCycleObservation = ordered.at(-1);
    if (!latestCycleObservation) return null;
    const compatible = all.filter(
      (item) =>
        item.model === latestCycleObservation.model &&
        item.subscription_tier === latestCycleObservation.subscription_tier &&
        item.cycle_period === latestCycleObservation.cycle_period &&
        item.implied_max_tokens >= 0,
    );
    const usable = ordered.map((item) => ({
      item,
      used: item.tokens_used_since_reset,
    }));
    if (usable.length === 0) return null;
    const latest = usable.at(-1);
    if (!latest) return null;
    const implied = compatible.map((item) => item.implied_max_tokens);
    const rollingEstimate = implied.reduce((sum, value) => sum + value, 0) / implied.length;
    const used = Math.max(latest.used, 0);
    const remaining = Math.max(rollingEstimate - used, 0);
    let dailyBurnRate: number | null = null;
    let exhaustionAt: string | null = null;
    const elapsedDays =
      (Date.parse(latest.item.observed_at) - Date.parse(latest.item.reset_at)) / DAY_MS;
    if (elapsedDays > 0 && used > 0) {
      dailyBurnRate = used / elapsedDays;
      exhaustionAt = new Date(
        Date.parse(latest.item.observed_at) + (remaining / dailyBurnRate) * DAY_MS,
      ).toISOString();
    }
    const status: CycleForecast["status"] =
      remaining <= 0
        ? "exhausted"
        : exhaustionAt === null
          ? "insufficient_data"
          : Date.parse(exhaustionAt) <= Date.parse(latest.item.cycle_end)
            ? "at_risk"
            : "on_track";
    const mean = rollingEstimate;
    const sampleDeviation =
      implied.length < 2
        ? null
        : Math.sqrt(
            implied.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (implied.length - 1),
          );
    const intervalMargin =
      sampleDeviation === null ? null : 1.96 * (sampleDeviation / Math.sqrt(implied.length));
    const variation = mean === 0 || sampleDeviation === null ? 1 : sampleDeviation / mean;
    const historyConfidence =
      implied.length < 2
        ? latest.item.confidence * 0.35
        : Math.min(...compatible.map((item) => item.confidence)) *
          Math.min(implied.length / 5, 1) *
          Math.max(0.2, 1 - Math.min(variation, 0.8));
    const weekly = latest.item.cycle_period === "weekly" ? mean : mean * (12 / (365.25 / 7));
    const monthly = latest.item.cycle_period === "monthly" ? mean : mean * (365.25 / 7 / 12);
    const resets = new Map<string, CalibrationObservation[]>();
    for (const item of compatible) {
      const items = resets.get(item.reset_at) ?? [];
      items.push(item);
      resets.set(item.reset_at, items);
    }
    const resetHistory = [...resets.entries()]
      .sort(([left], [right]) => Date.parse(right) - Date.parse(left))
      .map(([resetAt, items]) => {
        const latestItem = [...items].sort(
          (left, right) => Date.parse(right.observed_at) - Date.parse(left.observed_at),
        )[0];
        if (!latestItem) throw new Error("calibration reset history is empty");
        return {
          reset_at: resetAt,
          observations: items.length,
          latest_tokens_used: latestItem.tokens_used_since_reset,
          latest_displayed_percentage: latestItem.displayed_percentage,
          implied_max_tokens: rounded(latestItem.implied_max_tokens),
        };
      });
    const finalConfidence = rounded(historyConfidence, 4);
    return {
      provider,
      plan_id: selected.id,
      plan_name: selected.plan_name,
      cycle_start: latest.item.cycle_start,
      cycle_end: latest.item.cycle_end,
      allowance_unit: selected.allowance_unit,
      allowance_amount: selected.allowance_amount,
      model: latest.item.model,
      subscription_tier: latest.item.subscription_tier,
      cycle_period: latest.item.cycle_period,
      observed_used: rounded(used),
      observed_remaining: rounded(remaining),
      rolling_estimated_max_tokens: rounded(rollingEstimate),
      estimated_weekly_limit: rounded(weekly),
      estimated_monthly_limit: rounded(monthly),
      confidence_interval_low:
        intervalMargin === null ? null : rounded(Math.max(mean - intervalMargin, 0)),
      confidence_interval_high: intervalMargin === null ? null : rounded(mean + intervalMargin),
      confidence_rating:
        finalConfidence >= 0.75 ? "high" : finalConfidence >= 0.5 ? "medium" : "low",
      utilization_percent: rounded(rate(used, rollingEstimate) * 100, 2),
      daily_burn_rate: dailyBurnRate === null ? null : rounded(dailyBurnRate),
      forecast_exhaustion_at: exhaustionAt,
      status,
      confidence: finalConfidence,
      observations: compatible.length,
      reset_history: resetHistory,
    };
  }

  async recommendations(filters: AnalyticsFilters = {}): Promise<OptimizationRecommendation[]> {
    const [signal, models, requestTypes, priceProfiles] = await Promise.all([
      this.signals(filters),
      this.hotSpots("model", filters, 5),
      this.hotSpots("request_type", filters, 5),
      this.repository.priceProfiles(filters.provider),
    ]);
    const recommendations: OptimizationRecommendation[] = [];
    const sampleConfidence = Math.min(0.95, 0.4 + Math.log10(Math.max(signal.requests, 1)) * 0.2);
    if (signal.failed_requests >= 2 && signal.failure_rate >= 0.05) {
      recommendations.push({
        id: "reduce-failed-request-spend",
        category: "reliability",
        priority: signal.failure_rate >= 0.2 ? "high" : "medium",
        title: "Reduce failed request spend",
        recommendation:
          "Investigate the dominant sanitized failure categories and stop non-retryable calls before provider dispatch.",
        evidence: [
          `${signal.failed_requests} of ${signal.requests} requests failed (${rounded(signal.failure_rate * 100, 2)}%).`,
          `${signal.failed_known_cost_usd.toFixed(4)} USD of known cost belongs to failed requests.`,
        ],
        estimated_savings_usd: rounded(signal.failed_known_cost_usd * 0.5),
        confidence: rounded(sampleConfidence * 0.9, 4),
        assumptions: ["Half of current failed-request cost is preventable."],
      });
    }
    if (signal.retried_requests >= 2 && signal.retry_rate >= 0.1) {
      recommendations.push({
        id: "tighten-retry-policy",
        category: "retry",
        priority: signal.retry_rate >= 0.25 ? "high" : "medium",
        title: "Tighten retry policy",
        recommendation:
          "Separate retryable transport failures from deterministic request failures and add bounded backoff.",
        evidence: [
          `${signal.retried_requests} of ${signal.requests} requests were retry attempts (${rounded(signal.retry_rate * 100, 2)}%).`,
          `${signal.retry_known_cost_usd.toFixed(4)} USD of known cost belongs to retry attempts.`,
        ],
        estimated_savings_usd: rounded(signal.retry_known_cost_usd * 0.25),
        confidence: rounded(sampleConfidence * 0.8, 4),
        assumptions: [
          "One quarter of retry-attempt cost can be avoided without reducing successful work.",
        ],
      });
    }
    if (signal.input_tokens >= 100_000 && signal.cache_efficiency < 0.15) {
      recommendations.push({
        id: "increase-cache-reuse",
        category: "caching",
        priority: signal.cache_efficiency < 0.05 ? "high" : "medium",
        title: "Increase prompt-cache reuse",
        recommendation:
          "Stabilize repeated system/context prefixes and use provider cache controls on eligible requests.",
        evidence: [
          `${signal.input_tokens} input tokens were observed.`,
          `Cache-read efficiency is ${rounded(signal.cache_efficiency * 100, 2)}%.`,
        ],
        estimated_savings_usd: rounded(signal.known_cost_usd * 0.1),
        confidence: rounded(sampleConfidence * 0.7, 4),
        assumptions: ["Eligible repeated input can reduce ten percent of current known cost."],
      });
    }
    if (signal.requests >= 3 && signal.average_input_tokens >= 20_000) {
      recommendations.push({
        id: "trim-large-prompts",
        category: "prompt",
        priority: signal.average_input_tokens >= 50_000 ? "high" : "medium",
        title: "Trim oversized request context",
        recommendation:
          "Measure context sections independently, remove duplicated material, and retrieve only task-relevant evidence.",
        evidence: [
          `Average request input is ${signal.average_input_tokens.toFixed(0)} tokens.`,
          `${signal.input_tokens} total input tokens were observed.`,
        ],
        estimated_savings_usd: rounded(signal.known_cost_usd * 0.08),
        confidence: rounded(sampleConfidence * 0.65, 4),
        assumptions: [
          "Context trimming can reduce eight percent of known cost without changing outputs.",
        ],
      });
    }
    const leadingModel = models[0];
    if (
      leadingModel &&
      signal.requests >= 3 &&
      rate(leadingModel.known_cost_usd, signal.known_cost_usd) >= 0.6
    ) {
      const now = this.clock().getTime();
      const activeProfiles = priceProfiles.filter(
        (profile) =>
          Date.parse(profile.effective_from) <= now &&
          (profile.effective_to === null || Date.parse(profile.effective_to) > now),
      );
      const currentProfile = activeProfiles.find(
        (profile) =>
          profile.model === leadingModel.value &&
          (!filters.provider || profile.provider === filters.provider),
      );
      const candidate =
        currentProfile &&
        activeProfiles
          .filter(
            (profile) =>
              profile.provider === currentProfile.provider &&
              profile.model !== currentProfile.model &&
              profile.input_per_million < currentProfile.input_per_million &&
              profile.output_per_million < currentProfile.output_per_million,
          )
          .sort(
            (left, right) =>
              left.input_per_million +
              left.output_per_million -
              (right.input_per_million + right.output_per_million),
          )[0];
      const currentModeled =
        currentProfile &&
        (leadingModel.input_tokens * currentProfile.input_per_million +
          leadingModel.output_tokens * currentProfile.output_per_million) /
          1_000_000;
      const candidateModeled =
        candidate &&
        (leadingModel.input_tokens * candidate.input_per_million +
          leadingModel.output_tokens * candidate.output_per_million) /
          1_000_000;
      recommendations.push({
        id: candidate ? "benchmark-cheaper-model" : "review-model-concentration",
        category: "model",
        priority: "low",
        title: candidate ? "Benchmark a lower-price model" : "Review concentrated model spend",
        recommendation: candidate
          ? `Benchmark ${candidate.model} against ${leadingModel.value} on the same acceptance tests before changing routing.`
          : "Benchmark lower-cost compatible models on the same acceptance tests before changing routing.",
        evidence: [
          `${leadingModel.value} accounts for ${rounded(rate(leadingModel.known_cost_usd, signal.known_cost_usd) * 100, 2)}% of known cost.`,
          `${leadingModel.requests} requests used this model.`,
          ...(currentProfile && candidate
            ? [
                `${currentProfile.pricing_version} lists ${currentProfile.input_per_million}/${currentProfile.output_per_million} USD per million input/output tokens; ${candidate.pricing_version} lists ${candidate.input_per_million}/${candidate.output_per_million}.`,
              ]
            : []),
        ],
        estimated_savings_usd:
          currentModeled !== undefined && candidateModeled !== undefined
            ? rounded(Math.max(currentModeled - candidateModeled, 0))
            : 0,
        confidence: rounded(sampleConfidence * 0.45, 4),
        assumptions: [
          "The savings figure is a price-profile model, not realized savings.",
          "Token volume is held constant in the comparison.",
          "No model change should ship without quality and latency benchmarks.",
        ],
      });
    }
    const leadingType = requestTypes[0];
    if (
      leadingType &&
      signal.requests >= 3 &&
      rate(leadingType.known_cost_usd, signal.known_cost_usd) >= 0.5
    ) {
      recommendations.push({
        id: "evaluate-parallelization",
        category: "workflow",
        priority: "low",
        title: "Evaluate independent work for parallel execution",
        recommendation:
          "Inspect dependency edges for this repeated request type and parallelize only tasks proven independent.",
        evidence: [
          `${leadingType.value} accounts for ${rounded(rate(leadingType.known_cost_usd, signal.known_cost_usd) * 100, 2)}% of known cost.`,
          `${leadingType.requests} requests were observed.`,
        ],
        estimated_savings_usd: 0,
        confidence: rounded(sampleConfidence * 0.55, 4),
        assumptions: [
          "Usage records do not prove task independence; dependency validation is required.",
          "Parallelization is a latency opportunity; no cost savings are claimed.",
        ],
      });
    }
    return recommendations.sort(
      (left, right) =>
        right.estimated_savings_usd - left.estimated_savings_usd || left.id.localeCompare(right.id),
    );
  }
}
