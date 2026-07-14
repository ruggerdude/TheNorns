// Phase 6 dashboard view: renders /api/dashboard — engine-derived state only,
// source-labeled cost, experimental ETA, timeline from the audit trail.
import { useEffect, useState } from "react";
import { authHeaders } from "./auth";

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

const card: React.CSSProperties = {
  border: "1px solid #ddd",
  borderRadius: 8,
  padding: 12,
  marginBottom: 12,
};

export function Dashboard(): React.ReactElement {
  const [dto, setDto] = useState<DashboardDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/dashboard", { headers: authHeaders() })
      .then(async (res) => {
        if (!res.ok) throw new Error(`dashboard: ${res.status}`);
        setDto((await res.json()) as DashboardDto);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  if (error) return <div style={{ padding: 24, color: "#b91c1c" }}>{error}</div>;
  if (!dto) return <div style={{ padding: 24 }}>loading…</div>;

  return (
    <div
      style={{
        padding: 24,
        fontFamily: "ui-monospace, monospace",
        maxWidth: 900,
        overflow: "auto",
        height: "100vh",
        boxSizing: "border-box",
      }}
    >
      <h2 style={{ marginTop: 0 }}>
        PM Dashboard{" "}
        {dto.kill_switch ? (
          <span data-testid="kill-switch" style={{ color: "#b91c1c" }}>
            ■ KILL SWITCH
          </span>
        ) : null}
      </h2>
      <div style={card} data-testid="pm-summary">
        <strong>PM summary:</strong> {dto.pm_summary}
      </div>
      <div style={{ display: "flex", gap: 12 }}>
        <div style={{ ...card, flex: 1 }} data-testid="progress">
          <strong>Progress</strong>
          <div style={{ fontSize: 28 }}>{dto.progress_pct}%</div>
          <div style={{ color: "#666" }}>gate-derived · ETA: {dto.eta.label}</div>
        </div>
        <div style={{ ...card, flex: 2 }} data-testid="cost">
          <strong>Cost</strong>
          <div>
            settled ${dto.cost.settled_usd} · reserved ${dto.cost.active_reservations_usd} ·
            approved ${dto.cost.approved_usd} · cap ${dto.cost.project_cap_usd}
          </div>
          <div style={{ color: "#047857" }}>burn: +${dto.cost.burn_rate_usd_per_hour}/hr</div>
          {Object.entries(dto.usage_by_source).map(([source, usage]) => (
            <div key={source} style={{ fontSize: 12, color: "#666" }}>
              [{source}] {usage.input_tokens} in / {usage.output_tokens} out · ${usage.cost_usd}
            </div>
          ))}
        </div>
      </div>
      <div style={{ display: "flex", gap: 12 }}>
        <div style={{ ...card, flex: 1 }} data-testid="nodes">
          <strong>Nodes (graph v{dto.graph_version})</strong>
          {Object.entries(dto.nodes).map(([id, state]) => (
            <div key={id}>
              <span
                style={{
                  color:
                    state === "integrated" ? "#047857" : state === "blocked" ? "#b91c1c" : "#333",
                }}
              >
                {state}
              </span>{" "}
              {id}
            </div>
          ))}
        </div>
        <div style={{ ...card, flex: 1 }}>
          <strong>Blocked</strong>
          {dto.blocked.length === 0 ? <div>none</div> : null}
          {dto.blocked.map((entry) => (
            <div key={entry.node_id} style={{ color: "#b91c1c" }}>
              {entry.node_id}: {entry.reason}
            </div>
          ))}
          <strong>Review queue</strong>
          {dto.review_queue.length === 0 ? <div>empty</div> : null}
          {dto.review_queue.map((id) => (
            <div key={id}>{id}</div>
          ))}
        </div>
      </div>
      <div style={card} data-testid="timeline">
        <strong>Timeline</strong>
        {dto.timeline.length === 0 ? <div style={{ color: "#666" }}>no events yet</div> : null}
        {dto.timeline.map((entry, index) => (
          <div key={`${entry.at}-${index}`} style={{ fontSize: 12 }}>
            {entry.at.slice(11, 19)} · {entry.actor} · {entry.action} {entry.detail}
          </div>
        ))}
      </div>
    </div>
  );
}
