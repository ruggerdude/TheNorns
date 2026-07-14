// TheNorns web app: sole point of entry. Login gates everything; Projects is
// the landing view (list/create); opening a project shows its graph editor —
// React Flow rendering with editing (edges with cycle rejection, node
// deletion with re-parent/cascade confirmation), live cross-provider
// planning with a QC/acceptance-criteria review step before committing, Auto
// Allocate, per-node overrides, cost preview, and allocation approval — all
// through the project-scoped server API.
import {
  Background,
  type Connection,
  Controls,
  type Edge,
  type Node,
  ReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Dashboard } from "./Dashboard";
import { Login } from "./Login";
import { type PlanLike, PlanReview } from "./PlanReview";
import { type ProjectSummary, Projects } from "./Projects";
import { ApiError, UnauthorizedError, authHeaders, clearToken, getToken, setToken } from "./auth";
import { Alert, Badge, Button, Field, Input, Select, Spinner, TextArea } from "./ui";

interface Assignment {
  provider: string;
  model: string;
  worker_count: number;
  reviewer_model: string;
  budget_usd: number;
  rationale: string;
  source: "auto" | "override";
}

interface GraphNodeDto {
  id: string;
  title: string;
  complexity: string;
  risk: string;
  dependencies: string[];
  assignment: Assignment | null;
}

interface GraphDto {
  version: number;
  nodes: GraphNodeDto[];
  cost: { total_usd: number; unallocated: string[] };
}

async function api(path: string, method = "GET", body?: unknown): Promise<GraphDto> {
  const res = await fetch(path, {
    method,
    headers: authHeaders(body !== undefined),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status === 401) throw new UnauthorizedError();
  const json = (await res.json()) as GraphDto & { message?: string };
  if (!res.ok) throw new ApiError(json.message ?? `request failed: ${res.status}`, res.status);
  return json;
}

interface PlanResult {
  status: "converged" | "cap_reached";
  rounds: number;
  plan: PlanLike;
  content_hash: string;
  total_cost_usd: number;
  outstanding: { statement: string }[];
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: authHeaders(true),
    body: JSON.stringify(body),
  });
  if (res.status === 401) throw new UnauthorizedError();
  const json = (await res.json()) as T & { message?: string };
  if (!res.ok)
    throw new ApiError(
      (json as { message?: string }).message ?? `request failed: ${res.status}`,
      res.status,
    );
  return json;
}

/** Layered layout: x by longest-path depth, y by index within the layer. */
function layout(nodes: GraphNodeDto[]): Map<string, { x: number; y: number }> {
  const depths = new Map<string, number>();
  const depthOf = (id: string, seen: Set<string>): number => {
    const cached = depths.get(id);
    if (cached !== undefined) return cached;
    if (seen.has(id)) return 0;
    seen.add(id);
    const node = nodes.find((n) => n.id === id);
    const depth =
      !node || node.dependencies.length === 0
        ? 0
        : Math.max(...node.dependencies.map((dep) => depthOf(dep, seen))) + 1;
    depths.set(id, depth);
    return depth;
  };
  for (const node of nodes) depthOf(node.id, new Set());
  const perLayer = new Map<number, number>();
  const positions = new Map<string, { x: number; y: number }>();
  for (const node of nodes) {
    const depth = depths.get(node.id) ?? 0;
    const index = perLayer.get(depth) ?? 0;
    perLayer.set(depth, index + 1);
    positions.set(node.id, { x: depth * 250 + 20, y: index * 110 + 20 });
  }
  return positions;
}

function ProjectGraph({
  project,
  onBack,
  onLogout,
}: {
  project: ProjectSummary;
  onBack: () => void;
  onLogout: (message: string) => void;
}): React.ReactElement {
  const base = `/api/projects/${project.id}`;
  const [graph, setGraph] = useState<GraphDto | null>(null);
  const [draftOnly, setDraftOnly] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [strategy, setStrategy] = useState("balanced");
  const [error, setError] = useState<string | null>(null);
  const [approvalHash, setApprovalHash] = useState<string | null>(null);
  const [overrideModel, setOverrideModel] = useState("");
  const [overrideBudget, setOverrideBudget] = useState("");
  const [planObjective, setPlanObjective] = useState("");
  const [planLoading, setPlanLoading] = useState(false);
  const [planResult, setPlanResult] = useState<PlanResult | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [committing, setCommitting] = useState(false);
  const [view, setView] = useState<"graph" | "dashboard">("graph");

  const call = useCallback(
    async (path: string, method = "GET", body?: unknown) => {
      try {
        setError(null);
        const next = await api(path, method, body);
        setGraph(next);
        setDraftOnly(false);
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          onLogout("That token was rejected. Try again.");
        } else {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    },
    [onLogout],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const g = await api(`${base}/graph`);
        if (!cancelled) {
          setGraph(g);
          setDraftOnly(false);
        }
      } catch (err) {
        if (cancelled) return;
        if (err instanceof UnauthorizedError) {
          onLogout("Session expired. Sign in again.");
        } else if (err instanceof ApiError && err.status === 409) {
          setDraftOnly(true); // a fresh project simply has no plan yet
        } else {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [base, onLogout]);

  const runPlanning = useCallback(async () => {
    setPlanLoading(true);
    setPlanError(null);
    setPlanResult(null);
    try {
      const result = await postJson<PlanResult>(`${base}/plan`, { objective: planObjective });
      setPlanResult(result);
    } catch (err) {
      if (err instanceof UnauthorizedError) onLogout("Session expired. Sign in again.");
      else setPlanError(err instanceof Error ? err.message : String(err));
    } finally {
      setPlanLoading(false);
    }
  }, [planObjective, base, onLogout]);

  const commitPlan = useCallback(
    async (plan: PlanLike) => {
      setCommitting(true);
      try {
        await call(`${base}/plan/load`, "POST", { plan });
        setPlanResult(null);
        setPlanObjective("");
      } finally {
        setCommitting(false);
      }
    },
    [call, base],
  );

  const { nodes, edges } = useMemo(() => {
    if (!graph) return { nodes: [] as Node[], edges: [] as Edge[] };
    const positions = layout(graph.nodes);
    const flowNodes: Node[] = graph.nodes.map((node) => ({
      id: node.id,
      position: positions.get(node.id) ?? { x: 0, y: 0 },
      style: {
        border:
          node.id === selected
            ? "2px solid #e59b45"
            : `1px solid ${node.risk === "critical" ? "#a34f56" : node.risk === "high" ? "#9a6a32" : "#39414a"}`,
        borderLeft: `5px solid ${node.risk === "critical" ? "#ff8585" : node.risk === "high" ? "#e59b45" : node.risk === "medium" ? "#86b9ef" : "#76d3a0"}`,
        borderRadius: 12,
        padding: 10,
        width: 210,
        fontSize: 12,
        background: node.assignment ? "#132019" : "#14181d",
        color: "#f3f1eb",
        boxShadow:
          node.id === selected ? "0 0 0 5px rgba(229,155,69,.12)" : "0 10px 30px rgba(0,0,0,.2)",
      },
      data: {
        label: (
          <div>
            <strong>{node.title}</strong>
            <div style={{ color: "#9ba4ae", fontSize: 10, marginTop: 3 }}>
              {node.id} · {node.complexity} · {node.risk} risk
            </div>
            {node.assignment ? (
              <div style={{ marginTop: 7, color: "#9edbb8", fontSize: 10 }}>
                {node.assignment.model} · {node.assignment.worker_count}w · $
                {node.assignment.budget_usd}
                {node.assignment.source === "override" ? " · OVERRIDE" : ""}
              </div>
            ) : (
              <div style={{ color: "#ffcf91", marginTop: 7, fontSize: 10 }}>○ Needs allocation</div>
            )}
          </div>
        ),
      },
    }));
    const flowEdges: Edge[] = graph.nodes.flatMap((node) =>
      node.dependencies.map((dep) => ({
        id: `${dep}->${node.id}`,
        source: dep,
        target: node.id,
        markerEnd: "arrowclosed" as const,
        style: { stroke: "#66717d", strokeWidth: 1.7 },
        animated: node.id === selected || dep === selected,
      })),
    );
    return { nodes: flowNodes, edges: flowEdges };
  }, [graph, selected]);

  const onConnect = useCallback(
    (connection: Connection) => {
      if (connection.source && connection.target) {
        void call(`${base}/graph/edges`, "POST", {
          from: connection.source,
          to: connection.target,
        });
      }
    },
    [call, base],
  );

  const onEdgesDelete = useCallback(
    (deleted: Edge[]) => {
      for (const edge of deleted) {
        void call(`${base}/graph/edges`, "DELETE", { from: edge.source, to: edge.target });
      }
    },
    [call, base],
  );

  const selectedNode = graph?.nodes.find((n) => n.id === selected) ?? null;

  if (view === "dashboard") {
    return (
      <div className="dashboard">
        <Button
          className="btn-small"
          style={{ position: "fixed", top: 16, right: 16, zIndex: 30 }}
          onClick={() => setView("graph")}
        >
          ← Graph workspace
        </Button>
        <Dashboard onUnauthorized={() => onLogout("Session expired. Sign in again.")} />
      </div>
    );
  }

  return (
    <div className="graph-shell">
      <div className="graph-canvas" data-testid="graph-canvas">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onConnect={onConnect}
          onEdgesDelete={onEdgesDelete}
          onNodeClick={(_event, node) => setSelected(node.id)}
          fitView
        >
          <Background color="#353c44" gap={24} size={1} />
          <Controls />
        </ReactFlow>
      </div>
      <aside className="sidebar">
        <div className="sidebar-head">
          <Button className="btn-small" variant="ghost" onClick={onBack}>
            ← Projects
          </Button>
          <Button className="btn-small" variant="ghost" onClick={() => onLogout("Signed out.")}>
            Sign out
          </Button>
        </div>
        <div className="project-heading">
          <div className="eyebrow">Graph workspace</div>
          <h1>{project.name}</h1>
          <div className="meta">
            {project.pm_provider} PM · {project.reviewer_provider} REVIEW
          </div>
        </div>
        {graph ? (
          <>
            <div className="actions">
              <Button className="btn-small" onClick={() => setView("dashboard")}>
                Dashboard ↗
              </Button>
              <Badge tone={graph.cost.unallocated.length ? "warn" : "success"}>
                {graph.cost.unallocated.length
                  ? `${graph.cost.unallocated.length} unallocated`
                  : "Ready"}
              </Badge>
            </div>
            <div className="stat-strip">
              <div className="stat" data-testid="graph-version">
                <strong>v{graph.version}</strong>
                <span>GRAPH VERSION</span>
              </div>
              <div className="stat" data-testid="cost-total">
                <strong>${graph.cost.total_usd}</strong>
                <span>COST PREVIEW</span>
              </div>
            </div>
          </>
        ) : draftOnly ? (
          <div className="empty" data-testid="draft-hint">
            <div>
              <div className="empty-icon">◇</div>
              <strong>No plan yet</strong>
              <p>Describe the outcome below to begin live planning.</p>
            </div>
          </div>
        ) : (
          <Spinner label="Loading graph…" />
        )}
        {error ? <Alert testId="error">{error}</Alert> : null}

        <details className="card side-section" open>
          <summary>01 · Live planning</summary>
          <div className="side-body">
            {planResult ? (
              <PlanReview
                plan={planResult.plan}
                committing={committing}
                onCancel={() => setPlanResult(null)}
                onCommit={(plan) => void commitPlan(plan)}
              />
            ) : (
              <div className="form-stack">
                <Field label="What should this program deliver?">
                  <TextArea
                    data-testid="plan-objective"
                    placeholder="Describe the outcome, constraints, and success conditions…"
                    value={planObjective}
                    onChange={(e) => setPlanObjective(e.target.value)}
                  />
                </Field>
                <Button
                  variant="primary"
                  className="btn-block"
                  disabled={planLoading || !planObjective.trim()}
                  onClick={() => void runPlanning()}
                >
                  {planLoading ? "Planning with both providers…" : "Run live planning →"}
                </Button>
                {planLoading ? <Spinner label="Usually takes 30–90 seconds" /> : null}
                {planError ? <Alert testId="plan-error">{planError}</Alert> : null}
              </div>
            )}
          </div>
        </details>

        {graph ? (
          <>
            <details className="card side-section" open>
              <summary>02 · Allocate</summary>
              <div className="side-body form-stack">
                <Field label="Allocation strategy">
                  <Select value={strategy} onChange={(e) => setStrategy(e.target.value)}>
                    <option value="quality">Quality · strongest models</option>
                    <option value="balanced">Balanced · cost and capability</option>
                    <option value="cost">Cost · leanest viable models</option>
                  </Select>
                </Field>
                <p className="muted" style={{ fontSize: 12, margin: 0 }}>
                  {strategy === "quality"
                    ? "Prioritizes capability on every module."
                    : strategy === "cost"
                      ? "Minimizes spend while meeting module needs."
                      : "Balances model strength against total budget."}
                </p>
                <Button
                  variant="primary"
                  onClick={() => void call(`${base}/graph/allocate`, "POST", { strategy })}
                >
                  Auto allocate
                </Button>
              </div>
            </details>
            <details className="card side-section" open>
              <summary>03 · Approve</summary>
              <div className="side-body">
                <p className="muted" style={{ fontSize: 12 }}>
                  Locks the current graph and budget with a verifiable content hash. Every node must
                  be allocated first.
                </p>
                <Button
                  className="btn-block"
                  disabled={graph.cost.unallocated.length > 0}
                  onClick={async () => {
                    try {
                      setError(null);
                      const res = await fetch(`${base}/graph/approve-allocation`, {
                        method: "POST",
                        headers: authHeaders(),
                      });
                      if (res.status === 401) {
                        onLogout("Session expired. Sign in again.");
                        return;
                      }
                      const body = (await res.json()) as {
                        content_hash?: string;
                        message?: string;
                      };
                      if (!res.ok) throw new Error(body.message ?? "approval refused");
                      setApprovalHash(body.content_hash ?? null);
                    } catch (e) {
                      setError(e instanceof Error ? e.message : String(e));
                    }
                  }}
                >
                  Approve graph & budget
                </Button>
                {approvalHash ? (
                  <div
                    data-testid="approval-hash"
                    className="policy mono"
                    style={{ marginTop: 8, wordBreak: "break-all" }}
                  >
                    ✓ Approved
                    <br />
                    {approvalHash}
                  </div>
                ) : null}
              </div>
            </details>
            <section
              className="card side-section"
              data-testid={selectedNode ? "node-panel" : undefined}
            >
              <div className="section-head">
                <div>
                  <div className="eyebrow">Node inspector</div>
                  <h3>{selectedNode?.title ?? "No node selected"}</h3>
                </div>
                {selectedNode ? (
                  <Badge
                    tone={
                      selectedNode.risk === "critical" || selectedNode.risk === "high"
                        ? "danger"
                        : "info"
                    }
                  >
                    {selectedNode.risk}
                  </Badge>
                ) : null}
              </div>
              {selectedNode ? (
                <div className="form-stack">
                  <div className="meta">
                    {selectedNode.id} · {selectedNode.complexity} COMPLEXITY
                    <br />
                    DEPENDS ON: {selectedNode.dependencies.join(", ") || "NOTHING"}
                  </div>
                  {selectedNode.assignment ? (
                    <div className="assignment">
                      <span>Provider</span>
                      <strong>{selectedNode.assignment.provider}</strong>
                      <span>Model</span>
                      <strong>{selectedNode.assignment.model}</strong>
                      <span>Workers</span>
                      <strong>{selectedNode.assignment.worker_count}</strong>
                      <span>Reviewer</span>
                      <strong>{selectedNode.assignment.reviewer_model}</strong>
                      <span>Budget</span>
                      <strong>${selectedNode.assignment.budget_usd}</strong>
                      <span>Source</span>
                      <Badge
                        tone={selectedNode.assignment.source === "override" ? "success" : "default"}
                      >
                        {selectedNode.assignment.source}
                      </Badge>
                      <span>Rationale</span>
                      <strong>{selectedNode.assignment.rationale}</strong>
                    </div>
                  ) : (
                    <p className="muted">This node has not been allocated.</p>
                  )}
                  <div className="divider" />
                  <Field label="Override model">
                    <Input
                      placeholder="Model identifier"
                      value={overrideModel}
                      onChange={(e) => setOverrideModel(e.target.value)}
                    />
                  </Field>
                  <Field label="Override budget (USD)">
                    <Input
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="0.00"
                      value={overrideBudget}
                      onChange={(e) => setOverrideBudget(e.target.value)}
                    />
                  </Field>
                  <Button
                    disabled={!overrideModel && !overrideBudget}
                    onClick={() => {
                      const patch: Record<string, unknown> = {};
                      if (overrideModel) patch.model = overrideModel;
                      if (overrideBudget) patch.budget_usd = Number(overrideBudget);
                      void call(`${base}/graph/nodes/${selectedNode.id}/assignment`, "POST", patch);
                    }}
                  >
                    Apply override
                  </Button>
                  <div className="divider" />
                  <div>
                    <div className="field-label">Delete node</div>
                    <p className="muted" style={{ fontSize: 12 }}>
                      Re-parent preserves dependents. Cascade also removes everything that depends
                      on this node.
                    </p>
                    <div className="actions">
                      <Button
                        variant="danger"
                        className="btn-small"
                        onClick={() => {
                          if (
                            window.confirm(
                              `Delete ${selectedNode.title} and re-parent its dependents?`,
                            )
                          )
                            void call(
                              `${base}/graph/nodes/${selectedNode.id}?mode=reparent`,
                              "DELETE",
                            );
                        }}
                      >
                        Re-parent
                      </Button>
                      <Button
                        variant="danger"
                        className="btn-small"
                        onClick={() => {
                          if (
                            window.confirm(
                              `Cascade delete ${selectedNode.title} and all dependent nodes? This cannot be undone.`,
                            )
                          )
                            void call(
                              `${base}/graph/nodes/${selectedNode.id}?mode=cascade`,
                              "DELETE",
                            );
                        }}
                      >
                        Cascade delete
                      </Button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="empty" style={{ minHeight: 140 }}>
                  <div>
                    <div className="empty-icon">⌖</div>
                    <p>
                      Select a node to inspect its assignment, override its budget, or delete it.
                    </p>
                  </div>
                </div>
              )}
            </section>
          </>
        ) : null}
      </aside>
    </div>
  );
}

export function App(): React.ReactElement {
  const [token, setTok] = useState<string | null>(getToken());
  const [authError, setAuthError] = useState<string | null>(null);
  const [activeProject, setActiveProject] = useState<ProjectSummary | null>(null);

  const login = useCallback((value: string) => {
    setToken(value);
    setAuthError(null);
    setTok(value);
  }, []);

  const logout = useCallback((message: string) => {
    clearToken();
    setTok(null);
    setAuthError(message);
    setActiveProject(null);
  }, []);

  if (!token) {
    return <Login onLogin={login} error={authError} />;
  }

  if (!activeProject) {
    return (
      <Projects
        onOpenProject={setActiveProject}
        onUnauthorized={() => logout("Session expired. Sign in again.")}
        onSignOut={() => logout("Signed out.")}
      />
    );
  }

  return (
    <ProjectGraph project={activeProject} onBack={() => setActiveProject(null)} onLogout={logout} />
  );
}
