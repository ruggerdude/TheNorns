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
        border: node.id === selected ? "2px solid #d97706" : "1px solid #666",
        borderRadius: 8,
        padding: 6,
        width: 210,
        fontSize: 12,
        background: node.assignment ? "#ecfdf5" : "#fff",
      },
      data: {
        label: (
          <div>
            <strong>{node.id}</strong> ({node.complexity}/{node.risk})
            {node.assignment ? (
              <div>
                {node.assignment.model} · {node.assignment.worker_count}w · $
                {node.assignment.budget_usd}
                {node.assignment.source === "override" ? " · OVERRIDE" : ""}
              </div>
            ) : (
              <div style={{ color: "#999" }}>unallocated</div>
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
      <div>
        <button
          type="button"
          style={{ position: "fixed", top: 8, right: 8, zIndex: 10 }}
          onClick={() => setView("graph")}
        >
          ← Graph
        </button>
        <Dashboard />
      </div>
    );
  }

  return (
    <div style={{ display: "flex", height: "100vh", fontFamily: "ui-monospace, monospace" }}>
      <div style={{ flex: 1 }} data-testid="graph-canvas">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onConnect={onConnect}
          onEdgesDelete={onEdgesDelete}
          onNodeClick={(_event, node) => setSelected(node.id)}
          fitView
        >
          <Background />
          <Controls />
        </ReactFlow>
      </div>
      <div style={{ width: 340, padding: 16, borderLeft: "1px solid #ddd", overflow: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <button type="button" onClick={onBack} style={{ fontSize: 11 }}>
            ← Projects
          </button>
          <button
            type="button"
            onClick={() => onLogout("Signed out.")}
            style={{ fontSize: 11, color: "#666" }}
          >
            sign out
          </button>
        </div>
        <h2 style={{ margin: "8px 0 0" }}>{project.name}</h2>
        <div style={{ fontSize: 11, color: "#666" }}>
          PM: {project.pm_provider} · reviewer: {project.reviewer_provider}
        </div>
        {graph ? (
          <button type="button" onClick={() => setView("dashboard")} style={{ marginTop: 8 }}>
            PM Dashboard →
          </button>
        ) : null}
        {graph ? (
          <>
            <div data-testid="graph-version">graph v{graph.version}</div>
            <div data-testid="cost-total">
              cost preview: ${graph.cost.total_usd}
              {graph.cost.unallocated.length > 0
                ? ` (${graph.cost.unallocated.length} unallocated)`
                : ""}
            </div>
          </>
        ) : draftOnly ? (
          <p data-testid="draft-hint" style={{ color: "#666", fontSize: 12 }}>
            No plan yet — describe the project below and run Live Planning to get started.
          </p>
        ) : null}
        {error ? (
          <div data-testid="error" style={{ color: "#b91c1c", margin: "8px 0" }}>
            {error}
          </div>
        ) : null}

        <h3>Live Planning</h3>
        {planResult ? (
          <PlanReview
            plan={planResult.plan}
            committing={committing}
            onCancel={() => setPlanResult(null)}
            onCommit={(plan) => void commitPlan(plan)}
          />
        ) : (
          <>
            <textarea
              data-testid="plan-objective"
              placeholder="Describe what to build — e.g. 'Add OAuth login with Google and GitHub'"
              value={planObjective}
              onChange={(e) => setPlanObjective(e.target.value)}
              style={{ width: "100%", height: 56, fontFamily: "inherit", fontSize: 12 }}
            />
            <button
              type="button"
              disabled={planLoading || !planObjective.trim()}
              onClick={() => void runPlanning()}
            >
              {planLoading ? "Planning with real models… (30–90s)" : "Run Live Planning"}
            </button>
            {planError ? (
              <div
                data-testid="plan-error"
                style={{ color: "#b91c1c", margin: "8px 0", fontSize: 12 }}
              >
                {planError}
              </div>
            ) : null}
          </>
        )}

        {graph ? (
          <>
            <h3>Auto Allocate</h3>
            <select value={strategy} onChange={(e) => setStrategy(e.target.value)}>
              <option value="quality">quality</option>
              <option value="balanced">balanced</option>
              <option value="cost">cost</option>
            </select>{" "}
            <button
              type="button"
              onClick={() => void call(`${base}/graph/allocate`, "POST", { strategy })}
            >
              Auto Allocate
            </button>
            <h3>Approval</h3>
            <button
              type="button"
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
                  const body = (await res.json()) as { content_hash?: string; message?: string };
                  if (!res.ok) throw new Error(body.message ?? "approval refused");
                  setApprovalHash(body.content_hash ?? null);
                } catch (err) {
                  setError(err instanceof Error ? err.message : String(err));
                }
              }}
            >
              Approve allocation (budget)
            </button>
            {approvalHash ? (
              <div data-testid="approval-hash" style={{ wordBreak: "break-all", color: "#047857" }}>
                approved: {approvalHash}
              </div>
            ) : null}
            {selectedNode ? (
              <div data-testid="node-panel">
                <h3>{selectedNode.id}</h3>
                <div>{selectedNode.title}</div>
                <div>
                  deps: {selectedNode.dependencies.join(", ") || "none"} · {selectedNode.complexity}
                  /{selectedNode.risk}
                </div>
                {selectedNode.assignment ? (
                  <pre style={{ whiteSpace: "pre-wrap", fontSize: 11 }}>
                    {JSON.stringify(selectedNode.assignment, null, 1)}
                  </pre>
                ) : null}
                <h4>Override</h4>
                <input
                  placeholder="model"
                  value={overrideModel}
                  onChange={(e) => setOverrideModel(e.target.value)}
                  style={{ width: "100%" }}
                />
                <input
                  placeholder="budget usd"
                  value={overrideBudget}
                  onChange={(e) => setOverrideBudget(e.target.value)}
                  style={{ width: "100%", marginTop: 4 }}
                />
                <button
                  type="button"
                  style={{ marginTop: 4 }}
                  onClick={() => {
                    const patch: Record<string, unknown> = {};
                    if (overrideModel) patch.model = overrideModel;
                    if (overrideBudget) patch.budget_usd = Number(overrideBudget);
                    void call(`${base}/graph/nodes/${selectedNode.id}/assignment`, "POST", patch);
                  }}
                >
                  Apply override
                </button>
                <h4>Delete node</h4>
                <button
                  type="button"
                  onClick={() =>
                    void call(`${base}/graph/nodes/${selectedNode.id}?mode=reparent`, "DELETE")
                  }
                >
                  Delete (re-parent)
                </button>{" "}
                <button
                  type="button"
                  onClick={() =>
                    void call(`${base}/graph/nodes/${selectedNode.id}?mode=cascade`, "DELETE")
                  }
                >
                  Delete (cascade)
                </button>
              </div>
            ) : (
              <p style={{ color: "#666" }}>Click a node to inspect, override, or delete it.</p>
            )}
          </>
        ) : null}
      </div>
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
