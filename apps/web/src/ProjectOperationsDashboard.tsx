import { V2ProjectDashboard, type V2ProjectDashboardT } from "@norns/contracts";
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
        <section className="operations-section is-attention" aria-labelledby="operations-attention">
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
  );
}
