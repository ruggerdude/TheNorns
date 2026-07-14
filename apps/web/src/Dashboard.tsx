import { useEffect, useState } from "react";
import { authHeaders } from "./auth";
import { Alert, Badge, Spinner } from "./ui";
interface DashboardDto {
  graph_version: number;
  nodes: Record<string, string>;
  blocked: { node_id: string; reason: string }[];
  review_queue: string[];
  progress_pct: number;
  eta: { label: string; value: null };
  cost: {
    settled_usd: number;
    active_reservations_usd: number;
    approved_usd: number;
    project_cap_usd: number;
    burn_rate_usd_per_hour: number;
  };
  usage_by_source: Record<
    string,
    { input_tokens: number; output_tokens: number; cost_usd: number }
  >;
  kill_switch: boolean;
  timeline: { at: string; actor: string; action: string; detail: string }[];
  pm_summary: string;
}
const money = (n: number) =>
  new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(n);
const humanDetail = (s: string) => s.replace(/proj_[\w-]{16,}/g, "this project").replace(/_/g, " ");
export function Dashboard({ onUnauthorized }: { onUnauthorized?: () => void }): React.ReactElement {
  const [dto, setDto] = useState<DashboardDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetch("/api/dashboard", { headers: authHeaders() })
      .then(async (r) => {
        if (r.status === 401) {
          onUnauthorized?.();
          return;
        }
        if (!r.ok) throw new Error(`Dashboard could not load (${r.status})`);
        setDto((await r.json()) as DashboardDto);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [onUnauthorized]);
  if (error)
    return (
      <main className="page">
        <Alert>{error}</Alert>
      </main>
    );
  if (!dto)
    return (
      <main className="page">
        <Spinner label="Building dashboard…" />
      </main>
    );
  return (
    <main className="page dashboard">
      <div className="page-intro">
        <div className="eyebrow">Program intelligence</div>
        <h1>PM Dashboard</h1>
      </div>
      <div className="demo-banner">
        <strong>Demo data</strong> · This dashboard is not yet scoped to the project you opened. Its
        metrics come from the execution-engine demo environment.
      </div>
      {dto.kill_switch ? (
        <Alert>
          <span data-testid="kill-switch">Kill switch is active. Execution is halted.</span>
        </Alert>
      ) : null}
      <div className="dashboard-grid">
        <section className="card span-8" data-testid="pm-summary">
          <div className="eyebrow">PM brief</div>
          <h2>{dto.pm_summary}</h2>
        </section>
        <section className="card span-4" data-testid="progress">
          <div className="muted">Progress</div>
          <div className="metric">{dto.progress_pct}%</div>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${dto.progress_pct}%` }} />
          </div>
          <span className="meta">GATE-DERIVED · {dto.eta.label}</span>
        </section>
        <section className="card span-6" data-testid="cost">
          <div className="section-head">
            <h3>Budget</h3>
            <Badge tone="success">{money(dto.cost.burn_rate_usd_per_hour)}/hr</Badge>
          </div>
          <div className="metric">{money(dto.cost.settled_usd)}</div>
          <p className="muted">settled of {money(dto.cost.project_cap_usd)} cap</p>
          <div className="assignment">
            <span>Reserved</span>
            <strong>{money(dto.cost.active_reservations_usd)}</strong>
            <span>Approved</span>
            <strong>{money(dto.cost.approved_usd)}</strong>
            {Object.entries(dto.usage_by_source).map(([s, u]) => (
              <>
                <span key={`${s}-l`}>
                  {s} · {u.input_tokens + u.output_tokens} tokens
                </span>
                <strong key={`${s}-v`}>{money(u.cost_usd)}</strong>
              </>
            ))}
          </div>
        </section>
        <section className="card span-6" data-testid="nodes">
          <div className="section-head">
            <h3>Modules</h3>
            <span className="meta">GRAPH V{dto.graph_version}</span>
          </div>
          {Object.entries(dto.nodes).map(([id, state]) => (
            <div className="assignment" key={id}>
              <strong>{id}</strong>
              <Badge
                tone={
                  state === "integrated" ? "success" : state === "blocked" ? "danger" : "default"
                }
              >
                {state}
              </Badge>
            </div>
          ))}
        </section>
        <section className="card span-4">
          <h3>Attention</h3>
          {dto.blocked.length === 0 ? (
            <p className="muted">No blocked modules.</p>
          ) : (
            dto.blocked.map((x) => (
              <p key={x.node_id}>
                <Badge tone="danger">Blocked</Badge> {x.node_id}: {x.reason}
              </p>
            ))
          )}
          <div className="divider" />
          <h3>Review queue</h3>
          {dto.review_queue.length === 0 ? (
            <p className="muted">Queue is clear.</p>
          ) : (
            dto.review_queue.map((x) => <p key={x}>{x}</p>)
          )}
        </section>
        <section className="card span-8" data-testid="timeline">
          <h3>Timeline</h3>
          {dto.timeline.length === 0 ? (
            <p className="muted">No events yet.</p>
          ) : (
            dto.timeline.map((x, i) => (
              <div className="timeline-row" key={`${x.at}-${i}`}>
                <span className="mono muted">{x.at.slice(11, 16)}</span>
                <strong>{x.actor}</strong>
                <span>
                  {x.action.replace(/\./g, " ")} · {humanDetail(x.detail)}
                </span>
              </div>
            ))
          )}
        </section>
      </div>
    </main>
  );
}
