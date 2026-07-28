import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { ApiError, UnauthorizedError, authHeaders } from "./auth";
import { Alert, Button, Field, Input, PageHeader, Select, Spinner } from "./ui";
import "./UsageIntelligence.css";

export type UsageScope =
  | { kind: "global" }
  | { kind: "user"; id: string }
  | { kind: "project"; id: string }
  | { kind: "phase"; id: string };

export interface UsageSummary {
  requests: number;
  succeeded_requests: number;
  failed_requests: number;
  in_progress_requests: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
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
  dimension: "provider" | "model" | "user" | "project" | "phase";
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
  event_type: string;
  occurred_at: string;
  provider: string;
  model: string;
  status: string | null;
  project_id: string | null;
  phase_id: string | null;
  initiated_by_user_id: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number | null;
  latency_ms: number | null;
  error_code: string | null;
}

interface UsageFilters {
  from: string;
  to: string;
  provider: string;
  model: string;
  user: string;
  project: string;
  phase: string;
  status: string;
  interval: "day" | "week" | "month";
}

const emptySummary: UsageSummary = {
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

function dateBoundary(value: string, nextDay = false): string {
  const date = new Date(`${value}T00:00:00`);
  if (nextDay) date.setDate(date.getDate() + 1);
  return date.toISOString();
}

function scopePath(scope: UsageScope): string {
  if (scope.kind === "global") return "/api/usage";
  return `/api/usage/${scope.kind}s/${encodeURIComponent(scope.id)}`;
}

function filterQuery(filters: UsageFilters): string {
  const query = new URLSearchParams();
  if (filters.from) query.set("from", dateBoundary(filters.from));
  if (filters.to) query.set("to", dateBoundary(filters.to, true));
  if (filters.provider.trim()) query.set("provider", filters.provider.trim());
  if (filters.model.trim()) query.set("model", filters.model.trim());
  if (filters.user.trim()) query.set("user", filters.user.trim());
  if (filters.project.trim()) query.set("project", filters.project.trim());
  if (filters.phase.trim()) query.set("phase", filters.phase.trim());
  if (filters.status) query.set("status", filters.status);
  return query.toString();
}

async function usageRequest<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    headers: authHeaders(),
    signal,
  });
  if (response.status === 401) throw new UnauthorizedError();
  const body = (await response.json()) as T & { error?: string; message?: string };
  if (!response.ok) {
    throw new ApiError(
      body.message ?? body.error ?? `Usage request failed: ${response.status}`,
      response.status,
    );
  }
  return body;
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
}

function formatUsd(value: number): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: value > 0 && value < 0.01 ? 4 : 2,
    maximumFractionDigits: value > 0 && value < 0.01 ? 6 : 2,
  }).format(value);
}

function formatCost(value: number | null, knownValue = 0): string {
  return value === null ? `${formatUsd(knownValue)} known` : formatUsd(value);
}

function scopeLabel(scope: UsageScope): string {
  if (scope.kind === "global") return "All usage";
  return `${scope.kind[0]?.toUpperCase()}${scope.kind.slice(1)} usage`;
}

function intervalLabel(interval: UsageFilters["interval"]): string {
  return interval === "day" ? "Daily" : interval === "week" ? "Weekly" : "Monthly";
}

function UsageChart({
  points,
  interval,
}: {
  points: UsageTimePoint[];
  interval: UsageFilters["interval"];
}): React.ReactElement {
  const titleId = useId();
  const max = Math.max(...points.map((point) => point.known_cost_usd), 0);
  const width = Math.max(points.length * 44, 320);
  const chartHeight = 128;

  if (points.length === 0) {
    return <p className="usage-empty">No usage was recorded for this period.</p>;
  }

  return (
    <div className="usage-chart-wrap">
      <svg
        className="usage-chart"
        viewBox={`0 0 ${width} 170`}
        role="img"
        aria-labelledby={titleId}
      >
        <title id={titleId}>{intervalLabel(interval)} cost in US dollars</title>
        <line x1="0" y1={chartHeight} x2={width} y2={chartHeight} className="usage-axis" />
        {points.map((point, index) => {
          const height = max === 0 ? 0 : (point.known_cost_usd / max) * (chartHeight - 12);
          const x = index * 44 + 8;
          const date = new Date(point.bucket);
          const fullDate = date.toLocaleDateString(undefined, { timeZone: "UTC" });
          return (
            <g key={point.bucket}>
              <rect
                x={x}
                y={chartHeight - height}
                width="28"
                height={Math.max(height, 1)}
                rx="3"
                className="usage-bar"
              >
                <title>{`${fullDate}: ${formatCost(point.cost_usd, point.known_cost_usd)}, ${formatInteger(point.requests)} requests`}</title>
              </rect>
              <text x={x + 14} y="148" textAnchor="middle" className="usage-chart-label">
                {date.toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                  timeZone: "UTC",
                })}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export function UsageIntelligence({
  scope,
  onUnauthorized,
}: {
  scope: UsageScope;
  onUnauthorized: () => void;
}): React.ReactElement {
  const [draftFilters, setDraftFilters] = useState<UsageFilters>({
    from: "",
    to: "",
    provider: "",
    model: "",
    user: "",
    project: "",
    phase: "",
    status: "",
    interval: "day",
  });
  const [filters, setFilters] = useState(draftFilters);
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [points, setPoints] = useState<UsageTimePoint[]>([]);
  const [events, setEvents] = useState<UsageEventItem[]>([]);
  const [breakdowns, setBreakdowns] = useState<UsageBreakdownItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const basePath = useMemo(() => scopePath(scope), [scope]);
  const query = useMemo(() => filterQuery(filters), [filters]);
  const breakdownDimensions = useMemo(() => {
    if (scope.kind === "global") return ["provider", "model", "project", "user"] as const;
    if (scope.kind === "user") return ["model", "provider"] as const;
    if (scope.kind === "project") return ["user", "model", "provider", "phase"] as const;
    return ["user", "model", "provider"] as const;
  }, [scope.kind]);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const suffix = query ? `?${query}` : "";
        const breakdownQuery = new URLSearchParams(query);
        breakdownQuery.set("dimensions", breakdownDimensions.join(","));
        const seriesQuery = new URLSearchParams(query);
        seriesQuery.set("interval", filters.interval);
        const [nextSummary, seriesResponse, eventsResponse, breakdownResponse] = await Promise.all([
          usageRequest<UsageSummary>(`${basePath}/summary${suffix}`, signal),
          usageRequest<{ points: UsageTimePoint[] }>(
            `${basePath}/timeseries?${seriesQuery.toString()}`,
            signal,
          ),
          usageRequest<{ events: UsageEventItem[] }>(
            `${basePath}/events${suffix ? `${suffix}&` : "?"}limit=100`,
            signal,
          ),
          usageRequest<{ breakdowns: UsageBreakdownItem[] }>(
            `${basePath}/breakdown?${breakdownQuery.toString()}`,
            signal,
          ),
        ]);
        setSummary(nextSummary);
        setPoints(seriesResponse.points);
        setEvents(eventsResponse.events);
        setBreakdowns(breakdownResponse.breakdowns);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        if (caught instanceof UnauthorizedError) {
          onUnauthorized();
          return;
        }
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [basePath, breakdownDimensions, filters.interval, onUnauthorized, query],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const exportHref = `${basePath}/export.csv${query ? `?${query}` : ""}`;
  const totals = summary ?? emptySummary;
  const phaseFocused = scope.kind === "phase" || filters.phase.trim().length > 0;

  return (
    <main className="usage-page page-container" data-testid="usage-intelligence">
      <PageHeader
        eyebrow="Usage intelligence"
        title={phaseFocused ? "Phase usage" : scopeLabel(scope)}
        lede="Requests, tokens, cost, performance, and failures from the usage ledger."
        actions={
          <a className="btn btn-default" href={exportHref} download>
            Export CSV
          </a>
        }
      />

      <form
        className="usage-filters card"
        aria-label="Usage filters"
        onSubmit={(event) => {
          event.preventDefault();
          setFilters({ ...draftFilters });
        }}
      >
        <Field label="From">
          <Input
            type="date"
            value={draftFilters.from}
            onChange={(event) =>
              setDraftFilters((current) => ({ ...current, from: event.target.value }))
            }
          />
        </Field>
        <Field label="To">
          <Input
            type="date"
            value={draftFilters.to}
            onChange={(event) =>
              setDraftFilters((current) => ({ ...current, to: event.target.value }))
            }
          />
        </Field>
        <Field label="Provider">
          <Input
            placeholder="Any provider"
            value={draftFilters.provider}
            onChange={(event) =>
              setDraftFilters((current) => ({ ...current, provider: event.target.value }))
            }
          />
        </Field>
        <Field label="Model">
          <Input
            placeholder="Any model"
            value={draftFilters.model}
            onChange={(event) =>
              setDraftFilters((current) => ({ ...current, model: event.target.value }))
            }
          />
        </Field>
        {scope.kind === "global" || scope.kind === "project" || scope.kind === "phase" ? (
          <Field label="User">
            <Input
              placeholder="Any user ID"
              value={draftFilters.user}
              onChange={(event) =>
                setDraftFilters((current) => ({ ...current, user: event.target.value }))
              }
            />
          </Field>
        ) : null}
        {scope.kind === "global" ? (
          <Field label="Project">
            <Input
              placeholder="Any project ID"
              value={draftFilters.project}
              onChange={(event) =>
                setDraftFilters((current) => ({ ...current, project: event.target.value }))
              }
            />
          </Field>
        ) : null}
        {scope.kind === "global" || scope.kind === "project" ? (
          <Field label="Phase">
            <Input
              placeholder="Any phase ID"
              value={draftFilters.phase}
              onChange={(event) =>
                setDraftFilters((current) => ({ ...current, phase: event.target.value }))
              }
            />
          </Field>
        ) : null}
        <Field label="Status">
          <Select
            value={draftFilters.status}
            onChange={(event) =>
              setDraftFilters((current) => ({ ...current, status: event.target.value }))
            }
          >
            <option value="">Any status</option>
            <option value="succeeded">Succeeded</option>
            <option value="failed">Failed</option>
            <option value="in_progress">In progress</option>
          </Select>
        </Field>
        <Field label="Trend interval">
          <Select
            value={draftFilters.interval}
            onChange={(event) =>
              setDraftFilters((current) => ({
                ...current,
                interval: event.target.value as UsageFilters["interval"],
              }))
            }
          >
            <option value="day">Daily</option>
            <option value="week">Weekly</option>
            <option value="month">Monthly</option>
          </Select>
        </Field>
        <Button type="submit">Apply filters</Button>
      </form>

      {error ? (
        <Alert testId="usage-error">
          {error}{" "}
          <Button className="btn-small" onClick={() => void load()}>
            Try again
          </Button>
        </Alert>
      ) : null}
      {loading && summary === null ? <Spinner label="Loading usage…" /> : null}

      <section className="usage-summary" aria-label="Usage summary" aria-busy={loading}>
        <article className="card usage-stat">
          <span>Requests</span>
          <strong>{formatInteger(totals.requests)}</strong>
          <small>
            {phaseFocused ? `${formatInteger(totals.succeeded_requests)} completed · ` : ""}
            {formatInteger(totals.failed_requests)} failed
            {totals.average_latency_ms === null
              ? ""
              : ` · ${formatInteger(totals.average_latency_ms)} ms average`}
          </small>
        </article>
        <article className="card usage-stat">
          <span>Input tokens</span>
          <strong>{formatInteger(totals.input_tokens)}</strong>
          <small>{formatInteger(totals.cache_read_tokens)} cache reads</small>
        </article>
        <article className="card usage-stat">
          <span>Output tokens</span>
          <strong>{formatInteger(totals.output_tokens)}</strong>
          <small>
            {totals.average_output_tokens === null
              ? "No response token data"
              : `${formatInteger(totals.average_output_tokens)} average per request`}
          </small>
        </article>
        <article className="card usage-stat">
          <span>Cost</span>
          <strong>{formatCost(totals.cost_usd, totals.known_cost_usd)}</strong>
          <small>
            {totals.average_known_cost_usd === null
              ? "No priced interactions"
              : `${formatUsd(totals.average_known_cost_usd)} average across ${formatInteger(totals.priced_requests)} priced request${totals.priced_requests === 1 ? "" : "s"}`}
            {totals.unpriced_requests > 0
              ? ` · ${formatInteger(totals.unpriced_requests)} unpriced`
              : ""}
          </small>
        </article>
      </section>

      <section className="card usage-section" aria-labelledby="usage-cost-heading">
        <div className="section-head">
          <h2 id="usage-cost-heading">{intervalLabel(filters.interval)} cost trend</h2>
          {loading ? <span className="muted">Refreshing…</span> : null}
        </div>
        <UsageChart points={points} interval={filters.interval} />
      </section>

      <section className="card usage-section" aria-labelledby="usage-breakdown-heading">
        <div className="section-head">
          <h2 id="usage-breakdown-heading">
            {scope.kind === "global"
              ? "Provider, model, project, and user usage"
              : scope.kind === "user"
                ? "Most-used models and providers"
                : phaseFocused
                  ? "Phase users, models, and providers"
                  : scope.kind === "project"
                    ? "Project users, models, providers, and phases"
                    : "Usage breakdown"}
          </h2>
          {loading ? <span className="muted">Refreshing…</span> : null}
        </div>
        <div className="usage-table-wrap">
          <table className="usage-table">
            <thead>
              <tr>
                <th scope="col">Breakdown</th>
                <th scope="col">Value</th>
                <th scope="col">Requests</th>
                <th scope="col">Tokens</th>
                <th scope="col">Known cost</th>
              </tr>
            </thead>
            <tbody>
              {breakdowns.length === 0 ? (
                <tr>
                  <td colSpan={5} className="usage-empty">
                    No matching usage breakdown.
                  </td>
                </tr>
              ) : (
                breakdowns.map((item) => (
                  <tr key={`${item.dimension}-${item.value}`}>
                    <td>{item.dimension}</td>
                    <td>{item.value}</td>
                    <td>{formatInteger(item.requests)}</td>
                    <td>{formatInteger(item.input_tokens + item.output_tokens)}</td>
                    <td>{formatCost(item.cost_usd, item.known_cost_usd)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card usage-section" aria-labelledby="usage-events-heading">
        <div className="section-head">
          <h2 id="usage-events-heading">Recent activity</h2>
          <span className="muted">{events.length} events</span>
        </div>
        <div className="usage-table-wrap">
          <table className="usage-table">
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Provider / model</th>
                <th scope="col">Event</th>
                <th scope="col">Tokens</th>
                <th scope="col">Cost</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {events.length === 0 ? (
                <tr>
                  <td colSpan={6} className="usage-empty">
                    No matching activity.
                  </td>
                </tr>
              ) : (
                events.map((event) => (
                  <tr key={event.id}>
                    <td>{new Date(event.occurred_at).toLocaleString()}</td>
                    <td>
                      <strong>{event.provider}</strong>
                      <span className="usage-model">{event.model}</span>
                    </td>
                    <td>{event.event_type.replaceAll("_", " ")}</td>
                    <td>{formatInteger(event.input_tokens + event.output_tokens)}</td>
                    <td>{event.cost_usd === null ? "—" : formatUsd(event.cost_usd)}</td>
                    <td>
                      {event.error_code ? (
                        <span className="usage-failed">
                          Failed <span className="usage-error-code">({event.error_code})</span>
                        </span>
                      ) : (
                        (event.status ?? "—").replaceAll("_", " ")
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
