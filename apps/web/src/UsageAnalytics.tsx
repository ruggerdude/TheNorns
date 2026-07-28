import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, UnauthorizedError, authHeaders } from "./auth";
import { Alert, Button, Field, Input, PageHeader, Select, Spinner } from "./ui";
import "./UsageAnalytics.css";

interface Signals {
  requests: number;
  failed_requests: number;
  retried_requests: number;
  known_cost_usd: number;
  priced_requests: number;
  unpriced_requests: number;
  failure_rate: number;
  retry_rate: number;
  cache_efficiency: number;
  average_input_tokens: number;
  average_output_tokens: number;
  average_known_cost_usd: number | null;
}

interface TrendResponse {
  current: Signals;
  previous: Signals;
  change: {
    requests_percent: number | null;
    known_cost_percent: number | null;
    failure_rate_points: number;
  };
}

interface HotSpot {
  value: string;
  requests: number;
  failed_requests: number;
  known_cost_usd: number;
  unpriced_requests: number;
}

interface Recommendation {
  id: string;
  priority: "high" | "medium" | "low";
  title: string;
  recommendation: string;
  evidence: string[];
  estimated_savings_usd: number;
  confidence: number;
  assumptions: string[];
}

interface CalibrationReport {
  comparisons: unknown[];
  mean_absolute_error_percent: number | null;
  mean_actual_to_estimated_ratio: number | null;
}

interface CycleForecast {
  plan_name: string;
  allowance_unit: string;
  observed_remaining: number;
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
}

type HotSpotDimension = "user" | "project" | "phase" | "provider" | "model" | "request_type";

interface AnalyticsFilters {
  from: string;
  to: string;
  provider: string;
  dimension: HotSpotDimension;
}

function queryString(filters: AnalyticsFilters): string {
  const query = new URLSearchParams();
  if (filters.from) query.set("from", new Date(`${filters.from}T00:00:00`).toISOString());
  if (filters.to) {
    const to = new Date(`${filters.to}T00:00:00`);
    to.setDate(to.getDate() + 1);
    query.set("to", to.toISOString());
  }
  if (filters.provider.trim()) query.set("provider", filters.provider.trim());
  return query.toString();
}

async function request<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(path, { headers: authHeaders(), signal });
  if (response.status === 401) throw new UnauthorizedError();
  const body = (await response.json()) as T & { error?: string; message?: string };
  if (!response.ok) {
    throw new ApiError(
      body.message ?? body.error ?? `Analytics request failed: ${response.status}`,
      response.status,
    );
  }
  return body;
}

function usd(value: number): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value > 0 && value < 0.01 ? 4 : 2,
  }).format(value);
}

function percent(value: number): string {
  return new Intl.NumberFormat(undefined, {
    style: "percent",
    maximumFractionDigits: 1,
  }).format(value);
}

function change(value: number | null): string {
  if (value === null) return "No comparable prior baseline";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(1)}% vs prior period`;
}

export function UsageAnalytics({
  onUnauthorized,
}: {
  onUnauthorized: () => void;
}): React.ReactElement {
  const [draft, setDraft] = useState<AnalyticsFilters>({
    from: "",
    to: "",
    provider: "",
    dimension: "provider",
  });
  const [filters, setFilters] = useState(draft);
  const [trend, setTrend] = useState<TrendResponse | null>(null);
  const [hotSpots, setHotSpots] = useState<HotSpot[]>([]);
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [calibration, setCalibration] = useState<CalibrationReport | null>(null);
  const [forecast, setForecast] = useState<CycleForecast | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const query = useMemo(() => queryString(filters), [filters]);

  const load = useCallback(
    async (signal: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const suffix = query ? `?${query}` : "";
        const hotSpotQuery = `${suffix ? `${suffix}&` : "?"}dimension=${filters.dimension}`;
        const calibrationQuery = filters.provider
          ? `?provider=${encodeURIComponent(filters.provider.trim())}`
          : "";
        const calls = [
          request<TrendResponse>(`/api/usage/analytics/trends${suffix}`, signal),
          request<{ hot_spots: HotSpot[] }>(
            `/api/usage/analytics/hot-spots${hotSpotQuery}`,
            signal,
          ),
          request<{ recommendations: Recommendation[] }>(
            `/api/usage/analytics/recommendations${suffix}`,
            signal,
          ),
          request<CalibrationReport>(`/api/usage/analytics/calibration${calibrationQuery}`, signal),
        ] as const;
        const [nextTrend, hotSpotResponse, recommendationResponse, nextCalibration] =
          await Promise.all(calls);
        let nextForecast: CycleForecast | null = null;
        if (filters.provider.trim()) {
          try {
            nextForecast = await request<CycleForecast>(
              `/api/usage/analytics/forecast/${encodeURIComponent(filters.provider.trim())}`,
              signal,
            );
          } catch (caught) {
            if (!(caught instanceof ApiError) || caught.status !== 404) throw caught;
          }
        }
        setTrend(nextTrend);
        setHotSpots(hotSpotResponse.hot_spots);
        setRecommendations(recommendationResponse.recommendations);
        setCalibration(nextCalibration);
        setForecast(nextForecast);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        if (caught instanceof UnauthorizedError) {
          onUnauthorized();
          return;
        }
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    },
    [filters.dimension, filters.provider, onUnauthorized, query],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  return (
    <main className="usage-analytics-page page-container" data-testid="usage-analytics">
      <PageHeader
        eyebrow="Usage intelligence"
        title="Analytics and optimization"
        lede="Deterministic trend, calibration, reliability, and efficiency signals from canonical usage."
      />

      <form
        className="usage-analytics-filters card"
        aria-label="Analytics filters"
        onSubmit={(event) => {
          event.preventDefault();
          setFilters({ ...draft });
        }}
      >
        <Field label="From">
          <Input
            type="date"
            value={draft.from}
            onChange={(event) => setDraft((current) => ({ ...current, from: event.target.value }))}
          />
        </Field>
        <Field label="To">
          <Input
            type="date"
            value={draft.to}
            onChange={(event) => setDraft((current) => ({ ...current, to: event.target.value }))}
          />
        </Field>
        <Field label="Provider">
          <Input
            placeholder="All providers"
            value={draft.provider}
            onChange={(event) =>
              setDraft((current) => ({ ...current, provider: event.target.value }))
            }
          />
        </Field>
        <Field label="Hot spot">
          <Select
            value={draft.dimension}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                dimension: event.target.value as HotSpotDimension,
              }))
            }
          >
            <option value="provider">Provider</option>
            <option value="model">Model</option>
            <option value="request_type">Request type</option>
            <option value="project">Project</option>
            <option value="phase">Phase</option>
            <option value="user">User</option>
          </Select>
        </Field>
        <Button type="submit">Apply filters</Button>
      </form>

      {error ? <Alert testId="usage-analytics-error">{error}</Alert> : null}
      {loading && trend === null ? <Spinner label="Loading analytics…" /> : null}

      {trend ? (
        <section className="usage-analytics-summary" aria-label="Analytics summary">
          <article className="card usage-stat">
            <span>Requests</span>
            <strong>{trend.current.requests.toLocaleString()}</strong>
            <small>{change(trend.change.requests_percent)}</small>
          </article>
          <article className="card usage-stat">
            <span>Known cost</span>
            <strong>{usd(trend.current.known_cost_usd)}</strong>
            <small>
              {trend.current.average_known_cost_usd === null
                ? "No priced interactions"
                : `${usd(trend.current.average_known_cost_usd)} average per priced interaction`}
            </small>
          </article>
          <article className="card usage-stat">
            <span>Failure / retry</span>
            <strong>
              {percent(trend.current.failure_rate)} / {percent(trend.current.retry_rate)}
            </strong>
            <small>{trend.current.failed_requests} failed requests</small>
          </article>
          <article className="card usage-stat">
            <span>Cache efficiency</span>
            <strong>{percent(trend.current.cache_efficiency)}</strong>
            <small>
              {trend.current.average_input_tokens.toFixed(0)} input /{" "}
              {trend.current.average_output_tokens.toFixed(0)} response tokens average
            </small>
          </article>
        </section>
      ) : null}

      {forecast ? (
        <section className="card usage-analytics-forecast" aria-labelledby="forecast-heading">
          <div>
            <h2 id="forecast-heading">Cycle forecast · {forecast.plan_name}</h2>
            <p>
              {forecast.utilization_percent.toFixed(1)}% used ·{" "}
              {forecast.observed_remaining.toLocaleString()} {forecast.allowance_unit} remaining
            </p>
            <p>
              Estimated capacity: {forecast.estimated_weekly_limit.toLocaleString()} weekly ·{" "}
              {forecast.estimated_monthly_limit.toLocaleString()} monthly
            </p>
          </div>
          <strong className={`usage-forecast-${forecast.status}`}>
            {forecast.status.replaceAll("_", " ")}
          </strong>
          <p className="muted">
            {forecast.forecast_exhaustion_at
              ? `Projected exhaustion ${new Date(forecast.forecast_exhaustion_at).toLocaleString()}`
              : "More observations are needed for an exhaustion date."}{" "}
            · {percent(forecast.confidence)} confidence
            {" · "}
            {forecast.confidence_rating}
            {forecast.confidence_interval_low === null || forecast.confidence_interval_high === null
              ? " · confidence interval pending more cycles"
              : ` · 95% interval ${forecast.confidence_interval_low.toLocaleString()}–${forecast.confidence_interval_high.toLocaleString()} tokens`}
          </p>
        </section>
      ) : null}

      <section className="card usage-section" aria-labelledby="hotspots-heading">
        <div className="section-head">
          <h2 id="hotspots-heading">Hot spots by {filters.dimension.replaceAll("_", " ")}</h2>
          {loading ? <span className="muted">Refreshing…</span> : null}
        </div>
        <div className="usage-table-wrap">
          <table className="usage-table">
            <thead>
              <tr>
                <th scope="col">Value</th>
                <th scope="col">Requests</th>
                <th scope="col">Failures</th>
                <th scope="col">Known cost</th>
              </tr>
            </thead>
            <tbody>
              {hotSpots.map((item) => (
                <tr key={item.value}>
                  <td>{item.value}</td>
                  <td>{item.requests.toLocaleString()}</td>
                  <td>{item.failed_requests.toLocaleString()}</td>
                  <td>{usd(item.known_cost_usd)}</td>
                </tr>
              ))}
              {hotSpots.length === 0 ? (
                <tr>
                  <td colSpan={4} className="usage-empty">
                    No matching usage.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card usage-section" aria-labelledby="calibration-heading">
        <h2 id="calibration-heading">Estimate calibration</h2>
        {calibration?.mean_absolute_error_percent === null || calibration === null ? (
          <p className="usage-empty">No comparable provider observations yet.</p>
        ) : (
          <p>
            Mean absolute error:{" "}
            <strong>{calibration.mean_absolute_error_percent.toFixed(1)}%</strong> across{" "}
            {calibration.comparisons.length} observations.
          </p>
        )}
      </section>

      <section className="usage-recommendations" aria-labelledby="recommendations-heading">
        <h2 id="recommendations-heading">Optimization recommendations</h2>
        {recommendations.length === 0 ? (
          <p className="usage-empty">
            No deterministic recommendation crossed its evidence threshold.
          </p>
        ) : (
          recommendations.map((item) => (
            <article className="card usage-recommendation" key={item.id}>
              <div className="section-head">
                <h3>{item.title}</h3>
                <span className={`usage-priority usage-priority-${item.priority}`}>
                  {item.priority}
                </span>
              </div>
              <p>{item.recommendation}</p>
              <ul>
                {item.evidence.map((evidence) => (
                  <li key={evidence}>{evidence}</li>
                ))}
              </ul>
              <p className="muted">
                Estimated savings: {usd(item.estimated_savings_usd)} · {percent(item.confidence)}{" "}
                confidence
              </p>
            </article>
          ))
        )}
      </section>
    </main>
  );
}
