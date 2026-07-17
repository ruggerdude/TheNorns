import { pmModelOption } from "@norns/contracts";
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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Account } from "./Account";
import { Admin } from "./Admin";
import { Login, type LoginMode } from "./Login";
import { type PlanLike, PlanReview } from "./PlanReview";
import { type ProjectSummary, ProjectTabs, Projects } from "./Projects";
import {
  ApiError,
  type AuthSession,
  type CurrentUser,
  UnauthorizedError,
  authHeaders,
  clearToken,
  consumeInviteToken,
  consumeRecoveryToken,
  fetchAuthStatus,
  fetchMe,
  getToken,
  requestLogout,
  setToken,
} from "./auth";
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

/** ADR-1: server-authoritative approval status attached to every graph
 *  response. `current` is computed server-side (graph.version +
 *  allocation_fingerprint match); the hash is displayed evidence only. */
interface ApprovalResponse {
  content_hash: string;
  approved_at: string;
  actor: string;
  current: boolean;
}

interface GraphDto {
  version: number;
  nodes: GraphNodeDto[];
  cost: { total_usd: number; unallocated: string[] };
  approval?: ApprovalResponse | null;
}

/** Client-side approval banner state. Distinct from "all nodes allocated" —
 *  those remain different states (a full allocation is not an approval). */
type ApprovalState =
  | { kind: "never" }
  | { kind: "pending" }
  | { kind: "current"; hash: string; approvedAt: string; actor: string }
  | { kind: "stale"; hash: string };

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

/**
 * Frozen contract between App.tsx (orchestration) and PlanReview.tsx
 * (presentation): the *whole* planning result the QC screen needs, not just
 * the plan. Agent B builds PlanReview to accept exactly this as `result`.
 * `outstanding` is already pre-filtered to must-fix findings by the server.
 */
export interface PlanReviewResult {
  status: "converged" | "cap_reached";
  rounds: number;
  plan: PlanLike;
  content_hash: string;
  total_cost_usd: number;
  outstanding: { statement: string }[];
}

interface ProjectResumeDto {
  project: { id: string; name: string; status: string; aggregate_version: number };
  architecture: { title: string; summary: string; repository_revision: string } | null;
  repositories: Array<{ id: string; display_name: string; status: string; health: string }>;
  phases: Array<{
    id: string;
    objective_summary: string;
    status: string;
    tasks: number;
    completed_tasks: number;
    blocked_tasks: number;
  }>;
  attention: { open_decisions: number; active_runs: number; blocked_tasks: number };
  next_recommended_action: string;
}

interface PhaseExecutionDto {
  phase: {
    id: string;
    objective_summary: string;
    status: string;
    completed_tasks: number;
    total_tasks: number;
  };
  tasks: Array<{
    id: string;
    title: string;
    state: string;
    complexity: string;
    risk: string;
    dependencies: string[];
    assignment: { provider: string; model: string; status: string } | null;
    run: {
      id: string;
      state: string;
      attempt: number;
      verification_status: string;
      commit_sha: string | null;
      failure_detail: string | null;
    } | null;
    evidence_count: number;
  }>;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: authHeaders(false) });
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) throw new ApiError(`request failed: ${res.status}`, res.status);
  return (await res.json()) as T;
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
  openProjects,
  onOpenProject,
  onCloseProject,
  onLogout,
  user,
  onOpenAccount,
  onOpenAdmin,
}: {
  project: ProjectSummary;
  onBack: () => void;
  openProjects: ProjectSummary[];
  onOpenProject: (project: ProjectSummary) => void;
  onCloseProject: (id: string) => void;
  onLogout: (message: string) => void;
  user: CurrentUser | null;
  onOpenAccount: () => void;
  onOpenAdmin: () => void;
}): React.ReactElement {
  const base = `/api/projects/${project.id}`;
  const [graph, setGraph] = useState<GraphDto | null>(null);
  const [draftOnly, setDraftOnly] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [strategy, setStrategy] = useState("balanced");
  const [error, setError] = useState<string | null>(null);
  const [approval, setApproval] = useState<ApprovalState>({ kind: "never" });
  // UI-7: override drafts are keyed by node id (not flat state) so a half-typed
  // override for one node never leaks into another; switching selection shows
  // that node's own pending draft or a clean slate, never the previous node's.
  const [overrideDrafts, setOverrideDrafts] = useState<
    Record<string, { model: string; budget: string }>
  >({});
  const [overrideError, setOverrideError] = useState<string | null>(null);
  const [planObjective, setPlanObjective] = useState("");
  const [planLoading, setPlanLoading] = useState(false);
  const [planResult, setPlanResult] = useState<PlanReviewResult | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [resume, setResume] = useState<ProjectResumeDto | null>(null);
  const [phaseObjective, setPhaseObjective] = useState("");
  const [phaseCreating, setPhaseCreating] = useState(false);
  const [phaseError, setPhaseError] = useState<string | null>(null);
  const [monitoredPhaseId, setMonitoredPhaseId] = useState<string | null>(null);
  const [phaseExecution, setPhaseExecution] = useState<PhaseExecutionDto | null>(null);
  const [executionError, setExecutionError] = useState<string | null>(null);

  // Last-known-*good* approval state (never "pending"): what we revert to when
  // an in-flight mutation fails, so the banner is never left stuck at pending.
  const lastGoodApprovalRef = useRef<ApprovalState>({ kind: "never" });
  // Guards against double-submit of a plan/load while one is already in flight.
  const committingRef = useRef(false);
  // The exact (still-edited) plan last handed to commitPlan, so Retry resubmits
  // it rather than a stale copy.
  const lastCommitPlanRef = useRef<PlanLike | null>(null);

  const applyApproval = useCallback((next: ApprovalState) => {
    lastGoodApprovalRef.current = next;
    setApproval(next);
  }, []);

  // ADR-1: mount/refresh and every mutation response reconcile the banner from
  // the server's `approval` field — the source of truth — not client memory.
  const reconcileApproval = useCallback(
    (g: GraphDto) => {
      const a = g.approval;
      if (a?.current) {
        applyApproval({
          kind: "current",
          hash: a.content_hash,
          approvedAt: a.approved_at,
          actor: a.actor,
        });
      } else if (a) {
        applyApproval({ kind: "stale", hash: a.content_hash });
      } else {
        applyApproval({ kind: "never" });
      }
    },
    [applyApproval],
  );

  const call = useCallback(
    async (path: string, method = "GET", body?: unknown) => {
      const prevApproval = lastGoodApprovalRef.current;
      try {
        setError(null);
        setApproval({ kind: "pending" }); // a mutation is in flight
        const next = await api(path, method, body);
        setGraph(next);
        setDraftOnly(false);
        reconcileApproval(next);
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          onLogout("Session expired. Sign in again.");
        } else {
          setError(err instanceof Error ? err.message : String(err));
          setApproval(prevApproval); // revert; never leave the banner at pending
        }
      }
    },
    [onLogout, reconcileApproval],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const g = await api(`${base}/graph`);
        if (!cancelled) {
          setGraph(g);
          setDraftOnly(false);
          reconcileApproval(g);
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
  }, [base, onLogout, reconcileApproval]);

  const loadResume = useCallback(async () => {
    try {
      setResume(await getJson<ProjectResumeDto>(`/api/v2/projects/${project.id}/resume`));
    } catch (err) {
      if (err instanceof UnauthorizedError) onLogout("Session expired. Sign in again.");
      else if (!(err instanceof ApiError && err.status === 404)) {
        setPhaseError(err instanceof Error ? err.message : String(err));
      }
    }
  }, [project.id, onLogout]);

  useEffect(() => {
    void loadResume();
  }, [loadResume]);

  useEffect(() => {
    if (!resume?.phases.length) return;
    if (!monitoredPhaseId || !resume.phases.some((phase) => phase.id === monitoredPhaseId)) {
      const preferred =
        resume.phases.find((phase) => phase.status === "active") ?? resume.phases[0];
      setMonitoredPhaseId(preferred?.id ?? null);
    }
  }, [resume, monitoredPhaseId]);

  const loadPhaseExecution = useCallback(async () => {
    if (!monitoredPhaseId) return;
    try {
      setExecutionError(null);
      setPhaseExecution(
        await getJson<PhaseExecutionDto>(
          `/api/v2/projects/${project.id}/phases/${monitoredPhaseId}/execution`,
        ),
      );
    } catch (err) {
      if (err instanceof UnauthorizedError) onLogout("Session expired. Sign in again.");
      else setExecutionError(err instanceof Error ? err.message : String(err));
    }
  }, [monitoredPhaseId, project.id, onLogout]);

  useEffect(() => {
    if (!monitoredPhaseId) return;
    void loadPhaseExecution();
    const timer = window.setInterval(() => void loadPhaseExecution(), 5_000);
    return () => window.clearInterval(timer);
  }, [monitoredPhaseId, loadPhaseExecution]);

  const createPersistentPhase = useCallback(async () => {
    if (!resume || !phaseObjective.trim()) return;
    setPhaseCreating(true);
    setPhaseError(null);
    try {
      await postJson(`/api/v2/projects/${project.id}/phases`, {
        objective_summary: phaseObjective.trim(),
        priority: resume.phases.length,
        predecessor_phase_ids: [],
        expected_project_version: resume.project.aggregate_version,
        idempotency_key: `phase-${Date.now()}`,
      });
      setPhaseObjective("");
      await loadResume();
    } catch (err) {
      if (err instanceof UnauthorizedError) onLogout("Session expired. Sign in again.");
      else setPhaseError(err instanceof Error ? err.message : String(err));
    } finally {
      setPhaseCreating(false);
    }
  }, [resume, phaseObjective, project.id, loadResume, onLogout]);

  const runPlanning = useCallback(async () => {
    setPlanLoading(true);
    setPlanError(null);
    setCommitError(null);
    setPlanResult(null);
    try {
      const result = await postJson<PlanReviewResult>(`${base}/plan`, { objective: planObjective });
      setPlanResult(result);
    } catch (err) {
      if (err instanceof UnauthorizedError) onLogout("Session expired. Sign in again.");
      else setPlanError(err instanceof Error ? err.message : String(err));
    } finally {
      setPlanLoading(false);
    }
  }, [planObjective, base, onLogout]);

  // UI-2: commit is error-aware — it does NOT go through call() (which swallows
  // errors). QC review state (planResult/planObjective) is cleared only after a
  // confirmed-successful load; a failure keeps everything the human edited.
  const commitPlan = useCallback(
    async (plan: PlanLike) => {
      if (committingRef.current) return; // no double-submit while in flight
      committingRef.current = true;
      lastCommitPlanRef.current = plan;
      setCommitting(true);
      setCommitError(null);
      const prevApproval = lastGoodApprovalRef.current;
      setApproval({ kind: "pending" });
      try {
        const next = await api(`${base}/plan/load`, "POST", { plan });
        setGraph(next);
        setDraftOnly(false);
        setError(null);
        reconcileApproval(next);
        setPlanResult(null); // success only: safe to leave the QC screen
        setPlanObjective("");
        setCommitError(null);
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          onLogout("Session expired. Sign in again."); // 401 still signs out
          return;
        }
        setCommitError(err instanceof Error ? err.message : String(err));
        setApproval(prevApproval);
        // planResult / planObjective deliberately untouched -> edits survive
      } finally {
        committingRef.current = false;
        setCommitting(false);
      }
    },
    [base, onLogout, reconcileApproval],
  );

  const retryCommit = useCallback(async () => {
    const plan = lastCommitPlanRef.current;
    if (plan) await commitPlan(plan); // committingRef guard blocks concurrent retries
  }, [commitPlan]);

  // ADR-1: approval is a POST that persists server-side; on success the server
  // reports it as current, so we show the hash as evidence.
  const approveAllocationAction = useCallback(async () => {
    const prevApproval = lastGoodApprovalRef.current;
    setError(null);
    setApproval({ kind: "pending" });
    try {
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
        approved_at?: string;
        actor?: string;
        message?: string;
      };
      if (!res.ok) throw new Error(body.message ?? "approval refused");
      applyApproval({
        kind: "current",
        hash: body.content_hash ?? "",
        approvedAt: body.approved_at ?? new Date().toISOString(),
        actor: body.actor ?? "operator",
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setApproval(prevApproval);
    }
  }, [base, onLogout, applyApproval]);

  // UI-7 draft helpers (keyed by node id).
  const draft = (selected ? overrideDrafts[selected] : undefined) ?? { model: "", budget: "" };
  const setDraft = useCallback(
    (patch: Partial<{ model: string; budget: string }>) => {
      if (!selected) return;
      setOverrideDrafts((drafts) => ({
        ...drafts,
        [selected]: { ...(drafts[selected] ?? { model: "", budget: "" }), ...patch },
      }));
    },
    [selected],
  );
  const clearDraft = useCallback((nodeId: string) => {
    setOverrideDrafts((drafts) => {
      const next = { ...drafts };
      delete next[nodeId];
      return next;
    });
  }, []);

  const saveOverride = useCallback(async () => {
    if (!selected) return;
    const nodeId = selected;
    const d = overrideDrafts[nodeId] ?? { model: "", budget: "" };
    setOverrideError(null);
    const patch: Record<string, unknown> = {};
    if (d.model.trim()) patch.model = d.model.trim();
    if (d.budget.trim()) {
      // UI-7.6: validate client-side; never call the API with an invalid budget.
      const budget = Number(d.budget);
      if (!Number.isFinite(budget) || budget <= 0) {
        setOverrideError("Budget must be a positive number.");
        return;
      }
      patch.budget_usd = budget;
    }
    if (Object.keys(patch).length === 0) {
      setOverrideError("Enter a model or budget to override.");
      return;
    }
    const prevApproval = lastGoodApprovalRef.current;
    setError(null);
    setApproval({ kind: "pending" });
    try {
      const next = await api(`${base}/graph/nodes/${nodeId}/assignment`, "POST", patch);
      setGraph(next);
      setDraftOnly(false);
      clearDraft(nodeId); // success clears the draft
      // Override changed the allocation -> server marks approval not-current.
      reconcileApproval(next);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onLogout("Session expired. Sign in again.");
      } else {
        setOverrideError(err instanceof Error ? err.message : String(err)); // failed save keeps the draft
        setApproval(prevApproval);
      }
    }
  }, [selected, overrideDrafts, base, onLogout, clearDraft, reconcileApproval]);

  const cancelOverride = useCallback(() => {
    if (selected) clearDraft(selected); // restore server-known values (empty draft = no pending override)
    setOverrideError(null);
  }, [selected, clearDraft]);

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

  // UI-6: the "Dashboard" entry is intentionally not rendered for a real
  // project — it fetched a hardcoded global demo session's data (now moved to
  // its own /api/demo/dashboard surface by Agent C). A durable per-project
  // dashboard is deferred; until then a real project's workspace exposes no
  // dashboard entry and fires no dashboard fetch.

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
        <ProjectTabs
          projects={openProjects}
          activeId={project.id}
          onSelect={onOpenProject}
          onClose={onCloseProject}
        />
        <div className="sidebar-head">
          <Button className="btn-small" variant="ghost" onClick={onBack}>
            ← Main menu
          </Button>
          <div className="header-actions">
            <Button className="btn-small" variant="ghost" onClick={onOpenAccount}>
              Settings
            </Button>
            {user?.role === "admin" ? (
              <Button className="btn-small" variant="ghost" onClick={onOpenAdmin}>
                Admin
              </Button>
            ) : null}
            <Button className="btn-small" variant="ghost" onClick={() => onLogout("Signed out.")}>
              Sign out
            </Button>
          </div>
        </div>
        <div className="project-heading">
          <div className="eyebrow">Graph workspace</div>
          <h1>{project.name}</h1>
          <div className="meta">
            {project.pm_model
              ? (pmModelOption(project.pm_model)?.label ?? project.pm_model)
              : `${project.pm_provider} default (legacy)`}{" "}
            PM · {project.pm_provider} · {project.reviewer_provider} REVIEW
          </div>
          {project.source_location ? (
            <div className="project-detail-source" title={project.source_location}>
              <span>{project.source_type === "github" ? "GitHub" : "Local"}</span>
              {project.source_location}
            </div>
          ) : null}
        </div>
        {graph ? (
          <>
            <div className="actions">
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

        {resume ? (
          <details className="card side-section" open data-testid="project-resume">
            <summary>Project Resume</summary>
            <div className="side-body form-stack">
              <div className="stat-strip">
                <div className="stat">
                  <strong>{resume.phases.length}</strong>
                  <span>PHASES</span>
                </div>
                <div className="stat">
                  <strong>
                    {resume.attention.open_decisions + resume.attention.blocked_tasks}
                  </strong>
                  <span>NEEDS ATTENTION</span>
                </div>
              </div>
              {resume.architecture ? (
                <div>
                  <strong>{resume.architecture.title}</strong>
                  <p className="muted" style={{ fontSize: 12 }}>
                    {resume.architecture.summary}
                  </p>
                </div>
              ) : null}
              <Alert>{resume.next_recommended_action}</Alert>
              {resume.phases.map((phase) => (
                <div className="project-row" key={phase.id}>
                  <div>
                    <strong>{phase.objective_summary}</strong>
                    <div className="muted" style={{ fontSize: 12 }}>
                      {phase.status} · {phase.completed_tasks}/{phase.tasks} tasks complete
                    </div>
                  </div>
                  <Button
                    className="btn-small"
                    variant={monitoredPhaseId === phase.id ? "primary" : "default"}
                    onClick={() => setMonitoredPhaseId(phase.id)}
                  >
                    {monitoredPhaseId === phase.id ? "Monitoring" : "Monitor"}
                  </Button>
                </div>
              ))}
              {phaseExecution ? (
                <section className="phase-execution" aria-labelledby="phase-execution-heading">
                  <div className="section-head">
                    <div>
                      <div className="eyebrow">Live phase</div>
                      <h3 id="phase-execution-heading">{phaseExecution.phase.objective_summary}</h3>
                    </div>
                    <Badge tone={phaseExecution.phase.status === "completed" ? "success" : "info"}>
                      {phaseExecution.phase.status}
                    </Badge>
                  </div>
                  <div className="phase-progress" aria-label="Phase task progress">
                    <span
                      style={{
                        width: `${phaseExecution.phase.total_tasks ? (phaseExecution.phase.completed_tasks / phaseExecution.phase.total_tasks) * 100 : 0}%`,
                      }}
                    />
                  </div>
                  <p className="muted">
                    {phaseExecution.phase.completed_tasks}/{phaseExecution.phase.total_tasks} tasks
                    complete · updates every 5 seconds
                  </p>
                  <div className="phase-task-list" data-testid="phase-task-list">
                    {phaseExecution.tasks.map((task) => (
                      <article className={`phase-task task-${task.state}`} key={task.id}>
                        <div className="phase-task-head">
                          <strong>{task.title}</strong>
                          <Badge
                            tone={
                              task.state === "completed"
                                ? "success"
                                : ["blocked", "failed"].includes(task.state)
                                  ? "danger"
                                  : ["in_progress", "verifying", "in_review"].includes(task.state)
                                    ? "info"
                                    : "default"
                            }
                          >
                            {task.state.replaceAll("_", " ")}
                          </Badge>
                        </div>
                        <div className="phase-task-meta">
                          <span>
                            {task.complexity} · {task.risk} risk
                          </span>
                          {task.dependencies.length ? (
                            <span>Depends on {task.dependencies.length}</span>
                          ) : (
                            <span>Ready path</span>
                          )}
                          <span>{task.evidence_count} evidence</span>
                        </div>
                        {task.assignment ? (
                          <p>
                            <strong>Agent:</strong> {task.assignment.model} ·{" "}
                            {task.assignment.status}
                          </p>
                        ) : (
                          <p className="muted">No agent assigned</p>
                        )}
                        {task.run ? (
                          <div className="run-line">
                            <span>
                              Run {task.run.attempt}: {task.run.state}
                            </span>
                            <span>Verification: {task.run.verification_status}</span>
                            {task.run.commit_sha ? (
                              <code>{task.run.commit_sha.slice(0, 8)}</code>
                            ) : null}
                          </div>
                        ) : null}
                        {task.run?.failure_detail ? <Alert>{task.run.failure_detail}</Alert> : null}
                      </article>
                    ))}
                  </div>
                </section>
              ) : monitoredPhaseId && !executionError ? (
                <Spinner label="Loading phase execution…" />
              ) : null}
              {executionError ? <Alert testId="execution-error">{executionError}</Alert> : null}
              <Field label="Create the next phase">
                <Input
                  data-testid="phase-objective"
                  placeholder="e.g. Add animations"
                  value={phaseObjective}
                  onChange={(event) => setPhaseObjective(event.target.value)}
                />
              </Field>
              <Button
                variant="primary"
                disabled={phaseCreating || !phaseObjective.trim()}
                onClick={() => void createPersistentPhase()}
              >
                {phaseCreating ? "Creating phase…" : "Create phase"}
              </Button>
              {phaseError ? <Alert testId="phase-error">{phaseError}</Alert> : null}
            </div>
          </details>
        ) : null}

        <details className="card side-section" open>
          <summary>01 · Live planning</summary>
          <div className="side-body">
            {planResult ? (
              <>
                <PlanReview
                  result={planResult}
                  committing={committing}
                  onCancel={() => {
                    setPlanResult(null);
                    setCommitError(null);
                  }}
                  onCommit={(plan) => void commitPlan(plan)}
                />
                {commitError ? (
                  <Alert testId="commit-error">
                    <div>Couldn’t load the plan: {commitError}</div>
                    <Button
                      className="btn-small"
                      data-testid="commit-retry"
                      disabled={committing}
                      onClick={() => void retryCommit()}
                    >
                      {committing ? "Retrying…" : "Retry load"}
                    </Button>
                  </Alert>
                ) : null}
              </>
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
                  disabled={graph.cost.unallocated.length > 0 || approval.kind === "pending"}
                  onClick={() => void approveAllocationAction()}
                >
                  Approve graph & budget
                </Button>
                {/* Status is conveyed with visible text, not colour alone (UI-1.6). */}
                {approval.kind === "current" ? (
                  <div
                    data-testid="approval-hash"
                    className="policy mono"
                    style={{ marginTop: 8, wordBreak: "break-all" }}
                  >
                    ✓ Approved · current
                    <br />
                    {approval.hash}
                  </div>
                ) : approval.kind === "stale" ? (
                  <output data-testid="approval-stale" className="policy" style={{ marginTop: 8 }}>
                    ⚠ Approval out of date — the graph or allocation changed since it was approved.
                    Re-approve to lock the current graph and budget.
                  </output>
                ) : approval.kind === "pending" ? (
                  <output
                    data-testid="approval-pending"
                    className="policy"
                    style={{ marginTop: 8 }}
                  >
                    Checking approval status…
                  </output>
                ) : (
                  <output data-testid="approval-none" className="policy" style={{ marginTop: 8 }}>
                    Not yet approved.
                  </output>
                )}
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
                      value={draft.model}
                      onChange={(e) => setDraft({ model: e.target.value })}
                    />
                  </Field>
                  <Field label="Override budget (USD)">
                    <Input
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="0.00"
                      value={draft.budget}
                      onChange={(e) => setDraft({ budget: e.target.value })}
                    />
                  </Field>
                  {overrideError ? <Alert testId="override-error">{overrideError}</Alert> : null}
                  <div className="actions">
                    <Button
                      variant="primary"
                      className="btn-small"
                      disabled={
                        approval.kind === "pending" || (!draft.model.trim() && !draft.budget.trim())
                      }
                      onClick={() => void saveOverride()}
                    >
                      Save override
                    </Button>
                    <Button
                      variant="ghost"
                      className="btn-small"
                      disabled={!draft.model.trim() && !draft.budget.trim()}
                      onClick={cancelOverride}
                    >
                      Cancel
                    </Button>
                  </div>
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
  const [openProjects, setOpenProjects] = useState<ProjectSummary[]>([]);
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [needsBootstrap, setNeedsBootstrap] = useState(false);
  const [inviteToken] = useState<string | null>(() => consumeInviteToken());
  const [recoveryToken, setRecoveryToken] = useState<string | null>(() => consumeRecoveryToken());
  const requestedSettingsTab =
    typeof window === "undefined"
      ? null
      : new URLSearchParams(window.location.search).get("settings");
  const [showAccount, setShowAccount] = useState(requestedSettingsTab !== null);
  const [showAdmin, setShowAdmin] = useState(false);

  useEffect(() => {
    // An invite link always wins, regardless of bootstrap state — no need to
    // ask the server at all in that case.
    if (token || inviteToken || recoveryToken) return;
    fetchAuthStatus()
      .then((status) => setNeedsBootstrap(status.needs_bootstrap))
      .catch(() => setNeedsBootstrap(false));
  }, [token, inviteToken, recoveryToken]);

  useEffect(() => {
    if (!token) {
      setUser(null);
      return;
    }
    let cancelled = false;
    fetchMe()
      .then((u) => {
        if (!cancelled) setUser(u);
      })
      .catch(() => {
        if (!cancelled) setUser(null);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const authenticated = useCallback((session: AuthSession) => {
    setToken(session.token);
    setUser(session.user);
    setAuthError(null);
    setTok("present");
  }, []);

  const logout = useCallback((message: string) => {
    void requestLogout();
    clearToken();
    setTok(null);
    setUser(null);
    setAuthError(message);
    setActiveProject(null);
    setOpenProjects([]);
    setShowAccount(false);
    setShowAdmin(false);
  }, []);

  const openProject = useCallback((project: ProjectSummary) => {
    setOpenProjects((current) =>
      current.some((p) => p.id === project.id)
        ? current.map((p) => (p.id === project.id ? project : p))
        : [...current, project],
    );
    setActiveProject(project);
  }, []);

  const closeProject = useCallback((id: string) => {
    setOpenProjects((current) => current.filter((project) => project.id !== id));
    setActiveProject((active) => (active?.id === id ? null : active));
  }, []);

  if (!token) {
    const mode: LoginMode = recoveryToken
      ? "recovery"
      : inviteToken
        ? "invite"
        : needsBootstrap
          ? "bootstrap"
          : "login";
    return (
      <Login
        mode={mode}
        inviteToken={inviteToken}
        recoveryToken={recoveryToken}
        onRecoveryComplete={() => setRecoveryToken(null)}
        onAuthenticated={authenticated}
        error={authError}
      />
    );
  }

  return (
    <>
      {!activeProject ? (
        <Projects
          onOpenProject={openProject}
          openProjects={openProjects}
          onCloseProject={closeProject}
          onUnauthorized={() => logout("Session expired. Sign in again.")}
          onSignOut={() => logout("Signed out.")}
          user={user}
          onOpenAccount={() => setShowAccount(true)}
          onOpenAdmin={() => setShowAdmin(true)}
        />
      ) : (
        <ProjectGraph
          project={activeProject}
          onBack={() => setActiveProject(null)}
          openProjects={openProjects}
          onOpenProject={openProject}
          onCloseProject={closeProject}
          onLogout={logout}
          user={user}
          onOpenAccount={() => setShowAccount(true)}
          onOpenAdmin={() => setShowAdmin(true)}
        />
      )}
      {showAccount && user ? (
        <Account
          user={user}
          onClose={() => setShowAccount(false)}
          onSignOut={() => logout("Signed out.")}
          onUnauthorized={() => logout("Session expired. Sign in again.")}
          initialTab={requestedSettingsTab === "connections" ? "connections" : "profile"}
        />
      ) : null}
      {showAdmin && user?.role === "admin" ? (
        <Admin
          onClose={() => setShowAdmin(false)}
          onUnauthorized={() => logout("Session expired. Sign in again.")}
        />
      ) : null}
    </>
  );
}
