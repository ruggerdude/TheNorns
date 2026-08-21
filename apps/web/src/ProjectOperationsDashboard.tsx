import {
  type V2ProjectCodingMetricsT,
  V2ProjectDashboard,
  type V2ProjectDashboardT,
} from "@norns/contracts";
import { useCallback, useEffect, useState } from "react";
import { ApiError, UnauthorizedError, authHeaders } from "./auth";
import { Alert, Button, Spinner } from "./ui";
import "./ProjectOperationsDashboard.css";

type DashboardSection = V2ProjectDashboardT[keyof Omit<
  V2ProjectDashboardT,
  "schema_version" | "project_id" | "generated_at"
>];

function formatMoney(value: number | null): string {
  return value === null
    ? "Unavailable"
    : new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(value);
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat().format(Math.round(value));
}

function formatCompactInteger(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(
    Math.round(value),
  );
}

function formatPercent(value: number | null): string {
  return value === null
    ? "—"
    : new Intl.NumberFormat(undefined, {
        style: "percent",
        maximumFractionDigits: 1,
      }).format(value);
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return "<1m";
  const totalMinutes = Math.round(seconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 24) return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours === 0 ? `${days}d` : `${days}d ${remainingHours}h`;
}

function formatCoveredMoney(value: number | null, coverage: number): string {
  return value === null ? `Unavailable (${formatPercent(coverage)} covered)` : formatMoney(value);
}

function SectionUnavailable({
  title,
  section,
}: {
  title: string;
  section: Extract<DashboardSection, { availability: "unavailable" }>;
}): React.ReactElement {
  return (
    <section className="operations-section operations-unavailable" aria-label={title}>
      <strong>{title} unavailable</strong>
      <p>{section.detail ?? "The authoritative source could not be read."}</p>
    </section>
  );
}

function MetricCard({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail: string;
  tone?: "good" | "warn";
}): React.ReactElement {
  return (
    <div className={tone ? `coding-metric-card is-${tone}` : "coding-metric-card"}>
      <dt>{label}</dt>
      <dd>{value}</dd>
      <small>{detail}</small>
    </div>
  );
}

function CodingMetricsPanel({
  metrics,
  generatedAt,
}: {
  metrics: V2ProjectCodingMetricsT;
  generatedAt: string;
}): React.ReactElement {
  const tokens = metrics.tokens_per_accepted_task;
  const cost = metrics.cost_per_accepted_task;
  const firstPass = metrics.first_pass_yield;
  const rework = metrics.rework_ratio;
  const changeFailure = metrics.change_failure_rate;
  return (
    <section
      className="card project-coding-metrics"
      aria-labelledby="project-coding-metrics-title"
      data-testid="project-coding-metrics"
    >
      <header className="operations-header coding-metrics-header">
        <div>
          <div className="eyebrow">Speed · efficiency · quality</div>
          <h2 id="project-coding-metrics-title">Coding metrics</h2>
          <span className="muted">All-time results · updated {formatTime(generatedAt)}</span>
        </div>
      </header>

      <dl className="coding-metrics-grid" aria-label="Coding performance summary">
        <MetricCard
          label="Completed tasks"
          value={formatInteger(metrics.completed_tasks)}
          detail={`${formatInteger(metrics.completed_tasks_last_30_days)} in the last 30 days · ${formatInteger(metrics.total_tasks)} total`}
        />
        <MetricCard
          label="Time to verified delivery"
          value={formatDuration(metrics.time_to_verified_delivery.median_seconds)}
          detail={`${formatInteger(metrics.time_to_verified_delivery.sample_size)} delivered tasks · p75 ${formatDuration(metrics.time_to_verified_delivery.p75_seconds)}`}
        />
        <MetricCard
          label="First-pass yield"
          value={formatPercent(firstPass.rate)}
          detail={`${formatInteger(firstPass.first_pass_tasks)} of ${formatInteger(firstPass.completed_tasks)} passed without a retry`}
          tone={firstPass.rate !== null && firstPass.rate >= 0.8 ? "good" : undefined}
        />
        <MetricCard
          label="Tokens per accepted task"
          value={
            tokens.per_accepted_task === null ? "—" : formatCompactInteger(tokens.per_accepted_task)
          }
          detail={`${formatCompactInteger(tokens.total_tokens)} coding tokens across all attempts`}
        />
        <MetricCard
          label="Cost per accepted task"
          value={
            cost.per_accepted_task_usd === null ? "—" : formatMoney(cost.per_accepted_task_usd)
          }
          detail={
            cost.total_cost_usd === null
              ? `${formatPercent(cost.coverage_rate)} of run costs captured`
              : `${formatMoney(cost.total_cost_usd)} across ${formatInteger(cost.total_runs)} runs`
          }
        />
        <MetricCard
          label="Rework ratio"
          value={formatPercent(rework.rate)}
          detail={`${formatCompactInteger(rework.rework_tokens)} tokens spent on retry attempts`}
          tone={rework.rate !== null && rework.rate > 0.3 ? "warn" : undefined}
        />
        <MetricCard
          label="Change-failure rate"
          value={formatPercent(changeFailure.rate)}
          detail={`${formatInteger(changeFailure.failed_deployments)} failed of ${formatInteger(changeFailure.terminal_deployments)} terminal deployments`}
          tone={changeFailure.rate !== null && changeFailure.rate > 0.15 ? "warn" : undefined}
        />
      </dl>

      <div className="coding-token-mix" aria-label="Coding token mix">
        <div>
          <span>Input</span>
          <strong>{formatCompactInteger(tokens.input_tokens)}</strong>
        </div>
        <div>
          <span>Output</span>
          <strong>{formatCompactInteger(tokens.output_tokens)}</strong>
        </div>
        <div>
          <span>Cache reads</span>
          <strong>{formatCompactInteger(tokens.cache_read_tokens)}</strong>
        </div>
        <div>
          <span>Cache writes</span>
          <strong>{formatCompactInteger(tokens.cache_write_tokens)}</strong>
        </div>
        <div>
          <span>Reasoning</span>
          <strong>Not reported</strong>
        </div>
        <div>
          <span>Recorded active time</span>
          <strong>{formatDuration(metrics.active_coding_seconds)}</strong>
        </div>
      </div>

      <details className="coding-metrics-drilldown">
        <summary>Performance by phase</summary>
        <div className="coding-metrics-table-wrap">
          <table>
            <thead>
              <tr>
                <th>Phase</th>
                <th>Delivered</th>
                <th>Median delivery</th>
                <th>First pass</th>
                <th>Tokens</th>
                <th>Cost</th>
              </tr>
            </thead>
            <tbody>
              {metrics.phase_breakdown.map((phase) => (
                <tr key={phase.phase_id}>
                  <th scope="row">{phase.phase_name}</th>
                  <td>
                    {phase.completed_tasks}/{phase.total_tasks}
                  </td>
                  <td>{formatDuration(phase.median_delivery_seconds)}</td>
                  <td>{formatPercent(phase.first_pass_yield)}</td>
                  <td>{formatCompactInteger(phase.total_tokens)}</td>
                  <td>{formatCoveredMoney(phase.total_cost_usd, phase.cost_coverage_rate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      <details className="coding-metrics-drilldown">
        <summary>Performance by agent and model</summary>
        <div className="coding-metrics-table-wrap">
          <table>
            <thead>
              <tr>
                <th>Agent/model</th>
                <th>Runs</th>
                <th>Succeeded / failed</th>
                <th>Active time</th>
                <th>Tokens</th>
                <th>Cost</th>
              </tr>
            </thead>
            <tbody>
              {metrics.agent_breakdown.map((agent) => (
                <tr key={agent.agent_profile_id}>
                  <th scope="row">
                    {agent.provider} · {agent.model}
                  </th>
                  <td>{agent.run_count}</td>
                  <td>
                    {agent.succeeded_runs} / {agent.failed_runs}
                  </td>
                  <td>{formatDuration(agent.active_coding_seconds)}</td>
                  <td>{formatCompactInteger(agent.total_tokens)}</td>
                  <td>{formatCoveredMoney(agent.total_cost_usd, agent.cost_coverage_rate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      <details className="coding-metrics-drilldown">
        <summary>Task-level performance</summary>
        <div className="coding-metrics-table-wrap">
          <table>
            <thead>
              <tr>
                <th>Task</th>
                <th>Size / risk</th>
                <th>Status</th>
                <th>Attempts</th>
                <th>Delivery</th>
                <th>Tokens</th>
                <th>Cost</th>
              </tr>
            </thead>
            <tbody>
              {metrics.task_breakdown.map((task) => (
                <tr key={task.task_id}>
                  <th scope="row">{task.title}</th>
                  <td>
                    {task.complexity} · {task.risk}
                  </td>
                  <td>{task.state.replaceAll("_", " ")}</td>
                  <td>{task.attempt_count}</td>
                  <td>{formatDuration(task.delivery_seconds)}</td>
                  <td>{formatCompactInteger(task.total_tokens)}</td>
                  <td>{formatCoveredMoney(task.total_cost_usd, task.cost_coverage_rate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      <p className="muted coding-metrics-note">
        Delivery time runs from the first coding start through verified task completion. Rework is
        retry-attempt token usage. Change failure uses recorded deployment outcomes; post-deploy
        incident escape tracking is not yet available.
      </p>
    </section>
  );
}

export function ProjectOperationsDashboard({
  projectId,
  onUnauthorized,
}: {
  projectId: string;
  onUnauthorized: () => void;
}): React.ReactElement | null {
  const [dashboard, setDashboard] = useState<V2ProjectDashboardT | null>(null);
  const [loading, setLoading] = useState(true);
  const [unsupported, setUnsupported] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/v2/projects/${encodeURIComponent(projectId)}/dashboard`, {
        credentials: "include",
        headers: authHeaders(),
      });
      if (response.status === 401) throw new UnauthorizedError();
      if (response.status === 404) {
        setUnsupported(true);
        return;
      }
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
      };
      if (!response.ok) {
        throw new ApiError(
          body.message ?? body.error ?? `Dashboard request failed: ${response.status}`,
          response.status,
          body.error ?? null,
        );
      }
      setDashboard(V2ProjectDashboard.parse(body));
      setUnsupported(false);
    } catch (caught) {
      if (caught instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, [onUnauthorized, projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (unsupported) return null;
  if (loading && dashboard === null) {
    return (
      <section
        className="card project-operations-dashboard"
        aria-label="Project spending and status"
      >
        <Spinner label="Loading spending and status…" />
      </section>
    );
  }
  if (error && dashboard === null) {
    return (
      <section
        className="card project-operations-dashboard"
        aria-label="Project spending and status"
      >
        <Alert testId="project-operations-error">{error}</Alert>
        <Button onClick={() => void load()}>Retry</Button>
      </section>
    );
  }
  if (!dashboard) return null;

  return (
    <>
      <section
        className="card project-operations-dashboard"
        aria-labelledby="project-operations-title"
        data-testid="project-operations-dashboard"
      >
        <header className="operations-header">
          <div>
            <h2 id="project-operations-title">Spending and status</h2>
            <span className="muted">Updated {formatTime(dashboard.generated_at)}</span>
          </div>
          <Button className="btn-small" disabled={loading} onClick={() => void load()}>
            {loading ? "Refreshing…" : "Refresh"}
          </Button>
        </header>
        {error ? <Alert testId="project-operations-refresh-error">{error}</Alert> : null}

        <dl className="operations-summary" aria-label="Project spending and status summary">
          <div>
            <dt>Current spend</dt>
            <dd>
              {dashboard.budget.availability === "available"
                ? formatMoney(dashboard.budget.data.current_spend_usd)
                : "—"}
            </dd>
          </div>
          <div>
            <dt>Projected budget</dt>
            <dd>
              {dashboard.budget.availability === "available"
                ? formatMoney(dashboard.budget.data.projected_budget_usd)
                : "—"}
            </dd>
          </div>
          <div>
            <dt>Active work</dt>
            <dd>
              {dashboard.active_work.availability === "available"
                ? dashboard.active_work.data.length
                : "—"}
            </dd>
          </div>
          <div
            className={
              dashboard.needs_attention.availability === "available" &&
              dashboard.needs_attention.data.length > 0
                ? "needs-attention"
                : ""
            }
          >
            <dt>Needs attention</dt>
            <dd>
              {dashboard.needs_attention.availability === "available"
                ? dashboard.needs_attention.data.length
                : "—"}
            </dd>
          </div>
          <div>
            <dt>Open decisions</dt>
            <dd>
              {dashboard.open_decisions.availability === "available"
                ? dashboard.open_decisions.data.length
                : "—"}
            </dd>
          </div>
        </dl>

        {dashboard.budget.availability === "unavailable" ? (
          <SectionUnavailable title="Spending" section={dashboard.budget} />
        ) : null}

        {dashboard.needs_attention.availability === "unavailable" ? (
          <SectionUnavailable title="Attention status" section={dashboard.needs_attention} />
        ) : dashboard.needs_attention.data.length > 0 ? (
          <section
            className="operations-section is-attention"
            aria-labelledby="operations-attention"
          >
            <h3 id="operations-attention">Needs attention</h3>
            <ul className="operations-list">
              {dashboard.needs_attention.data.map((item) => (
                <li key={item.key}>
                  {item.deep_link ? (
                    <a href={item.deep_link}>
                      <strong>{item.title}</strong>
                    </a>
                  ) : (
                    <strong>{item.title}</strong>
                  )}
                  <p>{item.summary}</p>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {dashboard.open_decisions.availability === "unavailable" ? (
          <SectionUnavailable title="Open decisions" section={dashboard.open_decisions} />
        ) : dashboard.open_decisions.data.length > 0 ? (
          <section className="operations-section" aria-labelledby="operations-decisions">
            <h3 id="operations-decisions">Open decisions</h3>
            <ul className="operations-list">
              {dashboard.open_decisions.data.map((decision) => (
                <li key={decision.id}>
                  {decision.deep_link ? (
                    <a href={decision.deep_link}>
                      <strong>{decision.title}</strong>
                    </a>
                  ) : (
                    <strong>{decision.title}</strong>
                  )}
                  <p>{decision.detail}</p>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </section>
      {dashboard.coding_metrics.availability === "available" ? (
        <CodingMetricsPanel
          metrics={dashboard.coding_metrics.data}
          generatedAt={dashboard.generated_at}
        />
      ) : (
        <section className="card project-coding-metrics" aria-label="Coding metrics">
          <SectionUnavailable title="Coding metrics" section={dashboard.coding_metrics} />
        </section>
      )}
    </>
  );
}
