import { pmModelOption } from "@norns/contracts";
// TheNorns web app: sole point of entry. Login gates everything; Projects is
// the landing view (list/create); opening a project shows its workspace.
//
// FRONT DOOR P1c: planning (first phase and every subsequent one) goes
// through exactly one canonical path — a durable, observable planning run
// (POST .../planning-runs, polled), materialized into a phase + proposed
// strategy (POST .../phases {planning_run_id}), reviewed/staffed/approved in
// StrategyReview.tsx. The old synchronous `${base}/plan` + `/plan/load` +
// PlanReview.tsx flow (this file's former "01 · Live planning" box) has no
// remaining caller here per the design freeze; PlanReview.tsx itself is kept
// only because its own component tests still exercise it directly.
//
// The graph editor below (React Flow rendering with editing — edges with
// cycle rejection, node deletion with re-parent/cascade confirmation, Auto
// Allocate, per-node overrides, cost preview, allocation approval) is the
// pre-existing execution path for a project whose graph was already loaded
// before this change; it renders once `graph` exists and is otherwise
// dormant behind the "No plan yet" hint.
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
import { AttachmentInput } from "./AttachmentInput";
import { Debates } from "./Debates";
import { Gantt, type GanttPhase } from "./Gantt";
import { Login, type LoginMode } from "./Login";
import {
  AttentionDecisionForm,
  type AttentionItemDto,
  type PortfolioAttentionDto,
  type ProjectSummary,
  ProjectTabs,
  Projects,
} from "./Projects";
import { type StaffingEdit, StrategyReview, type StrategyReviewDto } from "./StrategyReview";
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
import { ThemeToggle, useTheme } from "./theme";
import { Alert, Badge, Button, Field, Input, Select, Spinner, TextArea } from "./ui";

interface Assignment {
  provider: string;
  model: string;
  worker_count: number;
  reviewer_model: string;
  budget_usd: number;
  rationale: string;
  source: "auto" | "pm" | "override";
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
  allocation_advice?: {
    summary: string;
    pm_provider: string;
    pm_model: string;
  };
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
    // FRONT DOOR P5 (tracking): additive per-phase progress fields on the
    // resume response (ProjectResumeService.open merges these onto the
    // Phase-3-owned contract rather than widening it — see that service's
    // deviation note). Optional here because the resume DTO's shape long
    // predates them; a stale mock/fixture without them still type-checks.
    percent_complete?: number;
    eta_at?: string | null;
    burn_rate_usd_per_hour?: number | null;
  }>;
  attention: { open_decisions: number; active_runs: number; blocked_tasks: number };
  next_recommended_action: string;
  // FRONT DOOR P5: aggregate project progress + the persisted poll cadence.
  progress?: {
    overall_percent_complete: number;
    blended_eta_at: string | null;
    agents_active: number;
    decisions_waiting: number;
  };
  update_interval_seconds?: number;
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
    assignment: {
      provider: string;
      model: string;
      status: string;
    } | null;
    implementation_agent: {
      profile_id: string;
      provider: string;
      model: string;
      roles: string[];
    } | null;
    reviewer_agent: {
      profile_id: string;
      provider: string;
      model: string;
      roles: string[];
    } | null;
    run: {
      id: string;
      state: string;
      attempt: number;
      verification_status: string;
      commit_sha: string | null;
      failure_detail: string | null;
    } | null;
    evidence_count: number;
    reviews: Array<{
      id: string;
      run_id: string;
      review_round: number;
      decision: "approved" | "rework" | "escalated" | string;
      summary: string;
      evidence: Array<{
        artifact_id: string;
        content_hash: string;
        media_type: string;
        label: string;
      }>;
      created_at: string;
      reviewer: {
        profile_id: string;
        provider: string;
        model: string;
        roles: string[];
      };
    }>;
  }>;
}

type PhaseExecutionTask = PhaseExecutionDto["tasks"][number];

/** FRONT DOOR P2's durable planning-run DTO (GET .../planning-runs/:runId),
 *  mirrored client-side. */
interface PlanningRunPollDto {
  id: string;
  status: "queued" | "drafting" | "reviewing" | "revising" | "converged" | "cap_reached" | "failed";
  round: number;
  max_rounds: number;
  transcript: Array<{
    round: number;
    role: "pm" | "reviewer";
    provider: string;
    model: string;
    summary: string;
    finding_counts: { must_fix: number; should_fix: number; suggestion: number } | null;
  }>;
  result: { plan: unknown; content_hash: string; total_cost_usd: number } | null;
  error: string | null;
}

const NON_TERMINAL_RUN_STATUSES = new Set(["queued", "drafting", "reviewing", "revising"]);

function agentRoleLabel(roles: string[] | undefined): string {
  return roles?.length ? roles.map((role) => role.replaceAll("_", " ")).join(", ") : "Agent";
}

function evidenceLabel(evidence: {
  artifact_id: string;
  content_hash: string;
  media_type: string;
  label: string;
}): string {
  return `${evidence.label} · ${evidence.media_type} · ${evidence.content_hash.slice(0, 12)}`;
}

function TaskQcPanel({
  task,
  projectId,
  phaseId,
  focused,
  onUnauthorized,
}: {
  task: PhaseExecutionTask;
  projectId: string;
  phaseId: string;
  focused: boolean;
  onUnauthorized: () => void;
}): React.ReactElement {
  const [directionTarget, setDirectionTarget] = useState("project_manager");
  const [directionText, setDirectionText] = useState("");
  const [directionBusy, setDirectionBusy] = useState(false);
  const [directionStatus, setDirectionStatus] = useState<string | null>(null);
  const reviewer = task.reviewer_agent ?? task.reviews?.at(-1)?.reviewer ?? null;
  const implementationAgent = task.implementation_agent;

  const sendDirection = async () => {
    if (!directionText.trim()) return;
    setDirectionBusy(true);
    setDirectionStatus(null);
    try {
      await postJson(`/api/v2/projects/${projectId}/directions`, {
        phase_id: phaseId,
        task_id: task.id,
        direction_target: directionTarget,
        direction_text: directionText.trim(),
        idempotency_key: `direction-${task.id}-${Date.now()}`,
      });
      setDirectionText("");
      setDirectionStatus("Direction recorded in project memory. Agent delivery is pending.");
    } catch (error) {
      if (error instanceof UnauthorizedError) onUnauthorized();
      else setDirectionStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setDirectionBusy(false);
    }
  };

  return (
    <article
      className={`phase-task task-${task.state} ${focused ? "is-focused" : ""}`}
      id={`task-qc-${task.id}`}
      data-testid={`task-qc-${task.id}`}
    >
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

      <div className="agent-identity-grid">
        <section className="agent-identity-card" aria-label="Implementation Agent">
          <span className="eyebrow">Implementation Agent</span>
          {implementationAgent ? (
            <>
              <strong>{implementationAgent.model}</strong>
              <span>
                {implementationAgent.provider} · {agentRoleLabel(implementationAgent.roles)}
              </span>
              <span className="mono">
                {implementationAgent.profile_id} · {task.assignment?.status ?? "assigned"}
              </span>
            </>
          ) : (
            <span className="muted">No implementation agent assigned</span>
          )}
        </section>
        <section className="agent-identity-card" aria-label="Independent QC Reviewer">
          <span className="eyebrow">Independent QC Reviewer</span>
          {reviewer ? (
            <>
              <strong>{reviewer.model}</strong>
              <span>
                {reviewer.provider} · {agentRoleLabel(reviewer.roles)}
              </span>
              <span className="mono">{reviewer.profile_id}</span>
            </>
          ) : (
            <span className="muted">Awaiting independent reviewer assignment</span>
          )}
        </section>
      </div>

      {task.run ? (
        <div className="run-line">
          <span>
            Run {task.run.attempt}: {task.run.state}
          </span>
          <span>Verification: {task.run.verification_status}</span>
          {task.run.commit_sha ? <code>{task.run.commit_sha.slice(0, 8)}</code> : null}
        </div>
      ) : null}
      {task.run?.failure_detail ? <Alert>{task.run.failure_detail}</Alert> : null}

      <details className="task-qc-details" open={focused || Boolean(task.reviews?.length)}>
        <summary>
          QC timeline · {task.reviews?.length ?? 0} review
          {(task.reviews?.length ?? 0) === 1 ? "" : "s"}
        </summary>
        <div className="qc-timeline">
          {task.reviews?.length ? (
            task.reviews.map((review) => (
              <article className="qc-review" key={review.id}>
                <div className="qc-review-head">
                  <strong>Round {review.review_round}</strong>
                  <Badge
                    tone={
                      review.decision === "approved"
                        ? "success"
                        : review.decision === "escalated"
                          ? "danger"
                          : "warn"
                    }
                  >
                    {review.decision}
                  </Badge>
                  <time dateTime={review.created_at}>
                    {new Intl.DateTimeFormat(undefined, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    }).format(new Date(review.created_at))}
                  </time>
                </div>
                <p className="qc-reviewer">
                  <strong>{review.reviewer.model}</strong> · {review.reviewer.provider} ·{" "}
                  {review.reviewer.profile_id}
                </p>
                <p className="qc-summary">{review.summary}</p>
                {review.evidence.length ? (
                  <div className="qc-evidence">
                    <strong>Evidence reviewed</strong>
                    <ul>
                      {review.evidence.map((evidence, index) => (
                        <li key={`${review.id}-evidence-${index}`}>{evidenceLabel(evidence)}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </article>
            ))
          ) : (
            <p className="muted">No independent QC review has been recorded yet.</p>
          )}

          <section className="task-direction" aria-label={`Direction for ${task.title}`}>
            <div>
              <strong>Provide direction</strong>
              <p className="muted">
                Direction is recorded in project memory. Delivery to the selected agent remains
                pending until a coordinator context-assembly step consumes it; active runs are not
                interrupted.
              </p>
            </div>
            <Field label="Send to">
              <Select
                value={directionTarget}
                onChange={(event) => setDirectionTarget(event.target.value)}
              >
                <option value="project_manager">Project Manager</option>
                <option value="implementation_agent">Implementation Agent</option>
                <option value="reviewer">QC Reviewer</option>
                <option value="all_agents">All agents</option>
              </Select>
            </Field>
            <Field label="Direction">
              <TextArea
                value={directionText}
                placeholder="Clarify constraints, request rework, or give the next-step direction…"
                onChange={(event) => setDirectionText(event.target.value)}
              />
            </Field>
            <Button
              className="btn-small"
              variant="primary"
              disabled={directionBusy || !directionText.trim()}
              onClick={() => void sendDirection()}
            >
              {directionBusy ? "Recording…" : "Record direction"}
            </Button>
            {directionStatus ? <Alert>{directionStatus}</Alert> : null}
          </section>
        </div>
      </details>
    </article>
  );
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

async function patchJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "PATCH",
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
  const { theme } = useTheme();
  const base = `/api/projects/${project.id}`;
  const [graph, setGraph] = useState<GraphDto | null>(null);
  const [draftOnly, setDraftOnly] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [strategy, setStrategy] = useState("balanced");
  const [allocationLoading, setAllocationLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [approval, setApproval] = useState<ApprovalState>({ kind: "never" });
  // UI-7: override drafts are keyed by node id (not flat state) so a half-typed
  // override for one node never leaks into another; switching selection shows
  // that node's own pending draft or a clean slate, never the previous node's.
  const [overrideDrafts, setOverrideDrafts] = useState<
    Record<string, { model: string; budget: string }>
  >({});
  const [overrideError, setOverrideError] = useState<string | null>(null);
  const [resume, setResume] = useState<ProjectResumeDto | null>(null);
  const [monitoredPhaseId, setMonitoredPhaseId] = useState<string | null>(null);
  const [phaseExecution, setPhaseExecution] = useState<PhaseExecutionDto | null>(null);
  const [executionError, setExecutionError] = useState<string | null>(null);
  const [showDebates, setShowDebates] = useState(false);
  // FRONT DOOR P1d (layout): the workspace shell reorganized into a normal
  // top-width page with a tab bar, per the approved mockup — the graph
  // canvas was the dominant panel before this, everything else crammed into
  // a narrow sidebar. Purely a layout change: every section below is the
  // exact same JSX/logic that existed already, just grouped under a tab.
  const [workspaceTab, setWorkspaceTab] = useState<"overview" | "plan" | "graph">("overview");
  const focusedTaskId = project.focus_task_id ?? null;

  // ------------------------------------------------------------------
  // FRONT DOOR P1: new-phase creation goes through an observable planning
  // run -> materialize-into-phase -> strategy review, replacing the old
  // "Create the next phase" raw-objective text box (UI regression it left:
  // a phase created that way had no staffing, no reviewer, no plan to
  // approve — just a bare objective string).
  // ------------------------------------------------------------------
  const [nextPhaseObjective, setNextPhaseObjective] = useState("");
  const [nextPhaseRounds, setNextPhaseRounds] = useState(3);
  const [nextPhaseAttachmentIds, setNextPhaseAttachmentIds] = useState<string[]>([]);
  const [activePlanningRunId, setActivePlanningRunId] = useState<string | null>(
    project.focus_planning_run_id ?? null,
  );
  const [planningRun, setPlanningRun] = useState<PlanningRunPollDto | null>(null);
  const [planningRunStarting, setPlanningRunStarting] = useState(false);
  const [planningRunError, setPlanningRunError] = useState<string | null>(null);
  const [materializingPhase, setMaterializingPhase] = useState(false);
  const [strategyReview, setStrategyReview] = useState<StrategyReviewDto | null>(null);
  const [strategyBusy, setStrategyBusy] = useState(false);
  const [strategyError, setStrategyError] = useState<string | null>(null);
  // Phase-scoped "needs you": the portfolio attention feed filtered to this
  // project + the currently monitored phase (P1 human-approved addition —
  // the phase-detail view's Q&A/decision thread).
  const [phaseAttention, setPhaseAttention] = useState<AttentionItemDto[]>([]);
  const [phaseAttentionBusy, setPhaseAttentionBusy] = useState<string | null>(null);
  // FRONT DOOR P5: tracking update-interval control.
  const [intervalSaving, setIntervalSaving] = useState(false);

  // Last-known-*good* approval state (never "pending"): what we revert to when
  // an in-flight mutation fails, so the banner is never left stuck at pending.
  const lastGoodApprovalRef = useRef<ApprovalState>({ kind: "never" });

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

  const [resumeError, setResumeError] = useState<string | null>(null);
  const loadResume = useCallback(async () => {
    try {
      setResume(await getJson<ProjectResumeDto>(`/api/v2/projects/${project.id}/resume`));
    } catch (err) {
      if (err instanceof UnauthorizedError) onLogout("Session expired. Sign in again.");
      else if (!(err instanceof ApiError && err.status === 404)) {
        setResumeError(err instanceof Error ? err.message : String(err));
      }
    }
  }, [project.id, onLogout]);

  useEffect(() => {
    void loadResume();
  }, [loadResume]);

  // FRONT DOOR P5 (tracking): poll cadence honors the persisted
  // update_interval_seconds once known; falls back to a 15s default until
  // the first resume response arrives.
  useEffect(() => {
    const seconds = resume?.update_interval_seconds ?? 15;
    const timer = window.setInterval(() => void loadResume(), Math.max(5, seconds) * 1000);
    return () => window.clearInterval(timer);
  }, [resume?.update_interval_seconds, loadResume]);

  useEffect(() => {
    if (project.focus_phase_id) {
      setMonitoredPhaseId(project.focus_phase_id);
      return;
    }
    if (!resume?.phases.length) return;
    if (!monitoredPhaseId || !resume.phases.some((phase) => phase.id === monitoredPhaseId)) {
      const preferred =
        resume.phases.find((phase) => phase.status === "active") ?? resume.phases[0];
      setMonitoredPhaseId(preferred?.id ?? null);
    }
  }, [resume, monitoredPhaseId, project.focus_phase_id]);

  useEffect(() => {
    if (!focusedTaskId || !phaseExecution?.tasks.some((task) => task.id === focusedTaskId)) return;
    document.getElementById(`task-qc-${focusedTaskId}`)?.scrollIntoView?.({
      behavior: "smooth",
      block: "center",
    });
  }, [focusedTaskId, phaseExecution]);

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

  // FRONT DOOR P1: replaces the old raw-objective "Create the next phase"
  // text box. New-phase creation goes through an observable planning run
  // (poll below), then materializing that run into a phase + proposed
  // strategy, then the StrategyReview screen for staffing + approval.
  const startNextPhasePlanningRun = useCallback(async () => {
    if (!nextPhaseObjective.trim()) return;
    setPlanningRunStarting(true);
    setPlanningRunError(null);
    try {
      const run = await postJson<{ planning_run_id: string }>(
        `/api/v2/projects/${project.id}/planning-runs`,
        {
          objective: nextPhaseObjective.trim(),
          max_rounds: nextPhaseRounds,
          attachment_ids: nextPhaseAttachmentIds,
        },
      );
      setActivePlanningRunId(run.planning_run_id);
      setNextPhaseObjective("");
      setNextPhaseAttachmentIds([]);
    } catch (err) {
      if (err instanceof UnauthorizedError) onLogout("Session expired. Sign in again.");
      else setPlanningRunError(err instanceof Error ? err.message : String(err));
    } finally {
      setPlanningRunStarting(false);
    }
  }, [nextPhaseObjective, nextPhaseRounds, nextPhaseAttachmentIds, project.id, onLogout]);

  const pollPlanningRun = useCallback(async () => {
    if (!activePlanningRunId) return;
    try {
      setPlanningRun(
        await getJson<PlanningRunPollDto>(
          `/api/v2/projects/${project.id}/planning-runs/${activePlanningRunId}`,
        ),
      );
    } catch (err) {
      if (err instanceof UnauthorizedError) onLogout("Session expired. Sign in again.");
      else setPlanningRunError(err instanceof Error ? err.message : String(err));
    }
  }, [activePlanningRunId, project.id, onLogout]);

  useEffect(() => {
    if (!activePlanningRunId) return;
    void pollPlanningRun();
    const timer = window.setInterval(() => void pollPlanningRun(), 3_000);
    return () => window.clearInterval(timer);
  }, [activePlanningRunId, pollPlanningRun]);

  const materializePhaseFromRun = useCallback(async () => {
    if (!activePlanningRunId) return;
    setMaterializingPhase(true);
    setPlanningRunError(null);
    try {
      const review = await postJson<StrategyReviewDto>(`/api/v2/projects/${project.id}/phases`, {
        planning_run_id: activePlanningRunId,
      });
      setStrategyReview(review);
      setMonitoredPhaseId(review.phase.id);
      setActivePlanningRunId(null);
      setPlanningRun(null);
      await loadResume();
    } catch (err) {
      if (err instanceof UnauthorizedError) onLogout("Session expired. Sign in again.");
      else setPlanningRunError(err instanceof Error ? err.message : String(err));
    } finally {
      setMaterializingPhase(false);
    }
  }, [activePlanningRunId, project.id, onLogout, loadResume]);

  const editStrategyStaffing = useCallback(
    async (edits: StaffingEdit[]) => {
      if (!strategyReview) return;
      setStrategyBusy(true);
      setStrategyError(null);
      try {
        const next = await patchJson<StrategyReviewDto>(
          `/api/v2/projects/${project.id}/phases/${strategyReview.phase.id}/strategy/staffing`,
          { assignments: edits },
        );
        setStrategyReview(next);
      } catch (err) {
        if (err instanceof UnauthorizedError) onLogout("Session expired. Sign in again.");
        else setStrategyError(err instanceof Error ? err.message : String(err));
      } finally {
        setStrategyBusy(false);
      }
    },
    [strategyReview, project.id, onLogout],
  );

  const approveStrategy = useCallback(async () => {
    if (!strategyReview?.strategy) return;
    setStrategyBusy(true);
    setStrategyError(null);
    try {
      await postJson(
        `/api/v2/projects/${project.id}/phases/${strategyReview.phase.id}/strategy/approve`,
        { expected_content_hash: strategyReview.strategy.content_hash },
      );
      setStrategyReview(null);
      await loadResume();
    } catch (err) {
      if (err instanceof UnauthorizedError) onLogout("Session expired. Sign in again.");
      else setStrategyError(err instanceof Error ? err.message : String(err));
    } finally {
      setStrategyBusy(false);
    }
  }, [strategyReview, project.id, onLogout, loadResume]);

  // FRONT DOOR P1 human-approved addition: phase-scoped "needs you" — the
  // portfolio attention feed filtered to this project, then (for the
  // decision-thread panel) to the monitored phase. Kept project-wide (not
  // phase-scoped at fetch time) because the Gantt's blocked-decision gates
  // (FRONT DOOR P1b) need every phase's attention state, not just the one
  // currently monitored.
  const [projectAttentionItems, setProjectAttentionItems] = useState<AttentionItemDto[]>([]);
  const loadProjectAttention = useCallback(async () => {
    try {
      const portfolio = await getJson<PortfolioAttentionDto>("/api/v2/attention");
      setProjectAttentionItems(portfolio.items.filter((item) => item.project_id === project.id));
    } catch (err) {
      if (err instanceof UnauthorizedError) onLogout("Session expired. Sign in again.");
      // A 404 (no phase3/attention wiring) just means nothing to show here.
    }
  }, [project.id, onLogout]);

  useEffect(() => {
    void loadProjectAttention();
    const timer = window.setInterval(() => void loadProjectAttention(), 10_000);
    return () => window.clearInterval(timer);
  }, [loadProjectAttention]);

  useEffect(() => {
    setPhaseAttention(
      monitoredPhaseId
        ? projectAttentionItems.filter((item) => item.phase_id === monitoredPhaseId)
        : [],
    );
  }, [projectAttentionItems, monitoredPhaseId]);

  // FRONT DOOR P1b: per-phase blocking-decision label for the Gantt's red
  // gate diamonds — the first (most relevant) attention item's title for
  // each phase that has one, kept even for phases other than the one
  // currently monitored.
  const blockedPhaseLabels = useMemo(() => {
    const labels = new Map<string, string>();
    for (const item of projectAttentionItems) {
      if (!item.phase_id) continue;
      if (item.kind !== "decision" && item.kind !== "blocker") continue;
      if (!labels.has(item.phase_id)) labels.set(item.phase_id, item.title);
    }
    return labels;
  }, [projectAttentionItems]);

  // FRONT DOOR P1b: real per-phase agent counts for the Gantt's count chip
  // (distinct implementation + reviewer agent profiles currently staffed).
  // The resume DTO has no per-phase agent count, so this fetches each
  // phase's execution DTO once phases are known — small N (phases per
  // project), and refreshed on the same cadence as the resume poll.
  const [phaseAgentCounts, setPhaseAgentCounts] = useState<Record<string, number>>({});
  const loadPhaseAgentCounts = useCallback(async () => {
    if (!resume?.phases.length) return;
    const settled = await Promise.allSettled(
      resume.phases.map(async (phase) => {
        const execution = await getJson<PhaseExecutionDto>(
          `/api/v2/projects/${project.id}/phases/${phase.id}/execution`,
        );
        const agentIds = new Set<string>();
        for (const task of execution.tasks) {
          if (task.implementation_agent) agentIds.add(task.implementation_agent.profile_id);
          if (task.reviewer_agent) agentIds.add(task.reviewer_agent.profile_id);
        }
        return [phase.id, agentIds.size] as const;
      }),
    );
    setPhaseAgentCounts((current) => {
      const next = { ...current };
      for (const outcome of settled) {
        if (outcome.status === "fulfilled") next[outcome.value[0]] = outcome.value[1];
      }
      return next;
    });
  }, [resume?.phases, project.id]);

  useEffect(() => {
    void loadPhaseAgentCounts();
    const timer = window.setInterval(() => void loadPhaseAgentCounts(), 20_000);
    return () => window.clearInterval(timer);
  }, [loadPhaseAgentCounts]);

  // FRONT DOOR P1b: the resume phase list, projected into the Gantt's input
  // shape. Phases are already priority-ordered by the server (resume SQL:
  // `ORDER BY p.priority DESC, ...`).
  const ganttPhases: GanttPhase[] = useMemo(
    () =>
      (resume?.phases ?? []).map((phase) => ({
        id: phase.id,
        name: phase.objective_summary,
        status: phase.status,
        percentComplete:
          phase.percent_complete ??
          (phase.tasks > 0 ? Math.round((phase.completed_tasks / phase.tasks) * 100) : 0),
        etaAt: phase.eta_at ?? null,
        agentCount: phaseAgentCounts[phase.id],
        blockedLabel: blockedPhaseLabels.get(phase.id) ?? null,
      })),
    [resume?.phases, phaseAgentCounts, blockedPhaseLabels],
  );

  const resolvePhaseDecision = useCallback(
    async (
      item: AttentionItemDto,
      input: {
        selectedOptionId: string;
        rationale: string;
        directionTarget: string;
        directionText: string;
      },
    ) => {
      const decision = item.decision;
      if (!decision) return;
      setPhaseAttentionBusy(item.key);
      try {
        await postJson(
          `/api/v2/projects/${item.project_id}/decision-points/${decision.decision_point_id}/resolve`,
          {
            expected_condition_fingerprint: decision.condition_fingerprint,
            selected_option_id: input.selectedOptionId,
            rationale: input.rationale,
            direction_target: input.directionTarget,
            direction_text: input.directionText,
            idempotency_key: `decision-${decision.decision_point_id}-${globalThis.crypto.randomUUID()}`,
          },
        );
        await loadProjectAttention();
      } catch (err) {
        if (err instanceof UnauthorizedError) onLogout("Session expired. Sign in again.");
      } finally {
        setPhaseAttentionBusy(null);
      }
    },
    [onLogout, loadProjectAttention],
  );

  // FRONT DOOR P5 (tracking): update-interval control, PATCHed to the
  // project settings and honored by the resume poll cadence below.
  const updateInterval = useCallback(
    async (seconds: 60 | 300 | 900) => {
      setIntervalSaving(true);
      try {
        await patchJson(`/api/v2/projects/${project.id}/settings`, {
          update_interval_seconds: seconds,
        });
        await loadResume();
      } catch (err) {
        if (err instanceof UnauthorizedError) onLogout("Session expired. Sign in again.");
      } finally {
        setIntervalSaving(false);
      }
    },
    [project.id, onLogout, loadResume],
  );

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

  const allocateProject = useCallback(async () => {
    setAllocationLoading(true);
    try {
      await call(
        strategy === "pm" ? `${base}/graph/recommend-allocation` : `${base}/graph/allocate`,
        "POST",
        strategy === "pm" ? {} : { strategy },
      );
    } finally {
      setAllocationLoading(false);
    }
  }, [base, call, strategy]);

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
        background:
          theme === "light"
            ? node.assignment
              ? "#e8f5ed"
              : "#ffffff"
            : node.assignment
              ? "#132019"
              : "#14181d",
        color: theme === "light" ? "#17202a" : "#f3f1eb",
        boxShadow:
          node.id === selected ? "0 0 0 5px rgba(229,155,69,.12)" : "0 10px 30px rgba(0,0,0,.2)",
      },
      data: {
        label: (
          <div>
            <strong>{node.title}</strong>
            <div
              style={{
                color: theme === "light" ? "#65717d" : "#9ba4ae",
                fontSize: 10,
                marginTop: 3,
              }}
            >
              {node.id} · {node.complexity} · {node.risk} risk
            </div>
            {node.assignment ? (
              <div
                style={{
                  marginTop: 7,
                  color: theme === "light" ? "#247147" : "#9edbb8",
                  fontSize: 10,
                }}
              >
                {node.assignment.model} · {node.assignment.worker_count}w · $
                {node.assignment.budget_usd}
                {node.assignment.source === "override"
                  ? " · OVERRIDE"
                  : node.assignment.source === "pm"
                    ? " · PM PICK"
                    : ""}
              </div>
            ) : (
              <div
                style={{
                  color: theme === "light" ? "#8a5715" : "#ffcf91",
                  marginTop: 7,
                  fontSize: 10,
                }}
              >
                ○ Needs allocation
              </div>
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
        style: { stroke: theme === "light" ? "#7a8793" : "#66717d", strokeWidth: 1.7 },
        animated: node.id === selected || dep === selected,
      })),
    );
    return { nodes: flowNodes, edges: flowEdges };
  }, [graph, selected, theme]);

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

  if (showDebates) {
    return (
      <Debates
        projectId={project.id}
        onUnauthorized={() => onLogout("Session expired. Sign in again.")}
        onBack={() => setShowDebates(false)}
      />
    );
  }

  // UI-6: the "Dashboard" entry is intentionally not rendered for a real
  // project — it fetched a hardcoded global demo session's data (now moved to
  // its own /api/demo/dashboard surface by Agent C). A durable per-project
  // dashboard is deferred; until then a real project's workspace exposes no
  // dashboard entry and fires no dashboard fetch.

  return (
    <div className="workspace-shell">
      <ProjectTabs
        projects={openProjects}
        activeId={project.id}
        onSelect={onOpenProject}
        onClose={onCloseProject}
      />
      <header className="workspace-topbar">
        <Button className="btn-small" variant="ghost" onClick={onBack}>
          ← Main menu
        </Button>
        <div className="header-actions">
          {user?.role === "admin" ? (
            <Button className="btn-small" variant="ghost" onClick={onOpenAdmin}>
              Admin
            </Button>
          ) : null}
          <Button className="btn-small" variant="ghost" onClick={() => onLogout("Signed out.")}>
            Sign out
          </Button>
        </div>
      </header>
      <main className="page workspace-page">
        <div className="project-heading workspace-header">
          <div className="eyebrow">Workspace</div>
          <h1>{project.name}</h1>
          <div className="meta">
            <Badge tone={project.status === "planned" ? "success" : "warn"}>{project.status}</Badge>
            <span className="chip model-c">
              {project.pm_model
                ? (pmModelOption(project.pm_model)?.label ?? project.pm_model)
                : `${project.pm_provider} default (legacy)`}{" "}
              · Coordinator
            </span>
            <span className="chip model-g">{project.reviewer_provider} · Reviewer</span>
          </div>
          {project.source_location ? (
            <div className="project-detail-source" title={project.source_location}>
              <span>{project.source_type === "github" ? "GitHub" : "Local"}</span>
              {project.source_location}
            </div>
          ) : null}
        </div>

        {/* FRONT DOOR P1d: Overview | Plan | Graph | Debates | Settings — the
         *  approved mockup's workspace tab bar. Debates and Settings keep
         *  their pre-existing behavior (a full-page swap / the Account
         *  modal) unchanged; they're just reachable from this row now. */}
        <nav className="workspace-tabs" aria-label="Workspace sections">
          <button
            type="button"
            className={workspaceTab === "overview" ? "on" : ""}
            onClick={() => setWorkspaceTab("overview")}
          >
            Overview
          </button>
          <button
            type="button"
            className={workspaceTab === "plan" ? "on" : ""}
            onClick={() => setWorkspaceTab("plan")}
          >
            Plan
          </button>
          <button
            type="button"
            className={workspaceTab === "graph" ? "on" : ""}
            onClick={() => setWorkspaceTab("graph")}
          >
            Graph
          </button>
          <button type="button" onClick={() => setShowDebates(true)}>
            Debates
          </button>
          <button type="button" onClick={onOpenAccount}>
            Settings
          </button>
        </nav>

        {workspaceTab === "overview" ? (
          <div className="workspace-tab-panel" data-testid="workspace-tab-overview">
            {error ? <Alert testId="error">{error}</Alert> : null}

            {resume && resume.phases.length === 0 && !strategyReview && !activePlanningRunId ? (
              <button
                type="button"
                className="card workspace-empty-pointer"
                data-testid="overview-no-plan-pointer"
                onClick={() => setWorkspaceTab("plan")}
              >
                <strong>No plan yet</strong>
                <span>Draft the plan →</span>
              </button>
            ) : null}

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
                  {/* FRONT DOOR P1b: the mini-Gantt strip on the workspace phase
                   *  board — compact per-phase gates + progress at a glance. */}
                  {ganttPhases.length > 0 ? (
                    <div data-testid="workspace-mini-gantt">
                      <Gantt phases={ganttPhases} mini />
                    </div>
                  ) : null}
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
                          <h3 id="phase-execution-heading">
                            {phaseExecution.phase.objective_summary}
                          </h3>
                        </div>
                        <Badge
                          tone={phaseExecution.phase.status === "completed" ? "success" : "info"}
                        >
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
                        {phaseExecution.phase.completed_tasks}/{phaseExecution.phase.total_tasks}{" "}
                        tasks complete · updates every 5 seconds
                      </p>
                      <div className="phase-task-list" data-testid="phase-task-list">
                        {phaseExecution.tasks.map((task) => (
                          <TaskQcPanel
                            key={task.id}
                            task={task}
                            projectId={project.id}
                            phaseId={phaseExecution.phase.id}
                            focused={focusedTaskId === task.id}
                            onUnauthorized={() => onLogout("Session expired. Sign in again.")}
                          />
                        ))}
                      </div>
                    </section>
                  ) : monitoredPhaseId && !executionError ? (
                    <Spinner label="Loading phase execution…" />
                  ) : null}
                  {executionError ? <Alert testId="execution-error">{executionError}</Alert> : null}

                  {/* FRONT DOOR P1 human-approved addition: the monitored phase's
                   *  Q&A / decision thread, scoped to exactly this phase — reached
                   *  by clicking a dashboard phase line's "Open →"/"Answer →"
                   *  button (which sets focus_phase_id -> monitoredPhaseId). */}
                  {monitoredPhaseId && phaseAttention.length > 0 ? (
                    <section
                      className="card needs-you-panel"
                      aria-labelledby="phase-needs-you-heading"
                      data-testid="phase-needs-you"
                    >
                      <div className="section-head">
                        <div>
                          <div className="eyebrow">Needs you</div>
                          <h3 id="phase-needs-you-heading">
                            {phaseAttention.length} item{phaseAttention.length === 1 ? "" : "s"} in
                            this phase
                          </h3>
                        </div>
                      </div>
                      {phaseAttention.map((item) => (
                        <article
                          key={item.key}
                          className={`attention-item severity-${item.severity}`}
                        >
                          <h4>{item.title}</h4>
                          <p>{item.summary}</p>
                          {item.decision ? (
                            <AttentionDecisionForm
                              item={{ ...item, decision: item.decision }}
                              busy={phaseAttentionBusy === item.key}
                              onResolve={(input) => resolvePhaseDecision(item, input)}
                            />
                          ) : null}
                        </article>
                      ))}
                    </section>
                  ) : null}

                  {resumeError ? <Alert testId="resume-error">{resumeError}</Alert> : null}
                </div>
              </details>
            ) : null}

            {resume ? (
              <details className="card side-section" open data-testid="tracking-settings">
                <summary>Tracking</summary>
                <div className="side-body">
                  {/* FRONT DOOR P1b: the full Gantt — one bar per phase on a
                   *  shared axis, gate diamonds (plan-approval / blocked-decision
                   *  / passed), and a Today line. See Gantt.tsx for the ordinal-
                   *  placement rationale (the resume DTO has no phase
                   *  timestamps yet). */}
                  <Gantt phases={ganttPhases} />
                  <p className="muted" style={{ fontSize: 12, marginTop: 14 }}>
                    How often the workspace polls for progress. Faster refresh costs a little more
                    background traffic; slower saves it.
                  </p>
                  <fieldset className="interval-picker" aria-label="Update interval">
                    {[60, 300, 900].map((seconds) => (
                      <Button
                        key={seconds}
                        className="btn-small"
                        variant={resume.update_interval_seconds === seconds ? "primary" : "default"}
                        disabled={intervalSaving}
                        onClick={() => void updateInterval(seconds as 60 | 300 | 900)}
                      >
                        {seconds < 3600 ? `${Math.round(seconds / 60)}m` : `${seconds / 3600}h`}
                      </Button>
                    ))}
                  </fieldset>
                </div>
              </details>
            ) : null}
          </div>
        ) : null}

        {workspaceTab === "plan" ? (
          <div className="workspace-tab-panel" data-testid="workspace-tab-plan">
            {/* FRONT DOOR P1: new-phase creation via an observable planning
             *  run, replacing the old raw-objective text box. FRONT DOOR
             *  P1c: also the one canonical entry point for a project's very
             *  first plan (see the "Draft the plan" label below). */}
            {resume ? (
              <details className="card side-section" open data-testid="planning-section">
                <summary>Plan</summary>
                <div className="side-body form-stack">
                  {activePlanningRunId ? (
                    <section className="card planning-run-status" data-testid="planning-run-status">
                      <div className="eyebrow">Drafting next phase</div>
                      <Badge tone={planningRun?.status === "failed" ? "danger" : "info"}>
                        {planningRun?.status ?? "queued"}
                      </Badge>
                      <p className="muted" style={{ fontSize: 12 }}>
                        Round {planningRun?.round ?? 0} of{" "}
                        {planningRun?.max_rounds ?? nextPhaseRounds}
                      </p>
                      {planningRun?.result ? (
                        <p className="meta mono" data-testid="planning-run-cost">
                          Planning cost so far: ${planningRun.result.total_cost_usd.toFixed(2)}
                        </p>
                      ) : null}
                      {planningRun?.transcript.length ? (
                        <ul className="planning-transcript" data-testid="planning-transcript">
                          {planningRun.transcript.map((entry, index) => (
                            <li key={`${entry.round}-${entry.role}-${index}`}>
                              Round {entry.round} · {entry.role} ({entry.model}): {entry.summary}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      {planningRun &&
                      (planningRun.status === "converged" ||
                        planningRun.status === "cap_reached") ? (
                        <Button
                          variant="primary"
                          disabled={materializingPhase}
                          onClick={() => void materializePhaseFromRun()}
                        >
                          {materializingPhase ? "Creating phase…" : "Create phase from this run →"}
                        </Button>
                      ) : NON_TERMINAL_RUN_STATUSES.has(planningRun?.status ?? "queued") ? (
                        <Spinner label="Coordinator and reviewer are drafting…" />
                      ) : null}
                    </section>
                  ) : (
                    <>
                      {/* FRONT DOOR P1c: this is the ONE canonical planning
                       *  entry point — a brand-new draft project's very first
                       *  plan goes through exactly the same durable planning-run
                       *  flow as every subsequent phase (no separate legacy
                       *  "01 · Live planning" box anymore). */}
                      <Field
                        label={
                          resume.phases.length === 0 ? "Draft the plan" : "Draft the next phase"
                        }
                      >
                        <TextArea
                          data-testid="next-phase-objective"
                          placeholder="What should this phase deliver?"
                          value={nextPhaseObjective}
                          onChange={(event) => setNextPhaseObjective(event.target.value)}
                        />
                      </Field>
                      <Field label="Attach screenshots">
                        <AttachmentInput
                          projectId={project.id}
                          value={nextPhaseAttachmentIds}
                          onChange={setNextPhaseAttachmentIds}
                          purpose="objective"
                          disabled={planningRunStarting}
                        />
                      </Field>
                      <Field label="Plan review rounds">
                        <div className="rounds-stepper" data-testid="next-phase-rounds-stepper">
                          <Button
                            type="button"
                            className="btn-small"
                            disabled={nextPhaseRounds <= 1}
                            onClick={() => setNextPhaseRounds((n) => Math.max(1, n - 1))}
                            aria-label="Fewer rounds"
                          >
                            −
                          </Button>
                          <span className="rounds-value mono">{nextPhaseRounds}</span>
                          <Button
                            type="button"
                            className="btn-small"
                            disabled={nextPhaseRounds >= 5}
                            onClick={() => setNextPhaseRounds((n) => Math.min(5, n + 1))}
                            aria-label="More rounds"
                          >
                            +
                          </Button>
                        </div>
                      </Field>
                      <Button
                        variant="primary"
                        disabled={planningRunStarting || !nextPhaseObjective.trim()}
                        onClick={() => void startNextPhasePlanningRun()}
                      >
                        {planningRunStarting
                          ? "Starting planning run…"
                          : resume.phases.length === 0
                            ? "Draft plan →"
                            : "Draft next phase →"}
                      </Button>
                    </>
                  )}
                  {planningRunError ? (
                    <Alert testId="planning-run-error">{planningRunError}</Alert>
                  ) : null}
                </div>
              </details>
            ) : null}

            {strategyReview ? (
              <details className="card side-section" open data-testid="strategy-review-section">
                <summary>Plan review · {strategyReview.phase.objective_summary}</summary>
                <div className="side-body">
                  <StrategyReview
                    review={strategyReview}
                    approving={strategyBusy}
                    savingStaffing={strategyBusy}
                    error={strategyError}
                    onEditStaffing={(edits) => void editStrategyStaffing(edits)}
                    onApprove={() => void approveStrategy()}
                  />
                </div>
              </details>
            ) : null}
          </div>
        ) : null}

        {workspaceTab === "graph" ? (
          <div className="workspace-tab-panel" data-testid="workspace-tab-graph">
            {/* FRONT DOOR P1d: the React Flow canvas, demoted to its own tab —
             *  same component, same props, same handlers as before; only the
             *  surrounding layout changed. */}
            <div className="graph-canvas" data-testid="graph-canvas">
              <ReactFlow
                nodes={nodes}
                edges={edges}
                onConnect={onConnect}
                onEdgesDelete={onEdgesDelete}
                onNodeClick={(_event, node) => setSelected(node.id)}
                fitView
              >
                <Background color={theme === "light" ? "#c5ccd3" : "#353c44"} gap={24} size={1} />
                <Controls />
              </ReactFlow>
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

            {graph ? (
              <>
                <details className="card side-section" open>
                  <summary>02 · Allocate</summary>
                  <div className="side-body form-stack">
                    <Field label="Allocation strategy">
                      <Select value={strategy} onChange={(e) => setStrategy(e.target.value)}>
                        <option value="pm">Project manager · best-fit team</option>
                        <option value="quality">Quality · strongest models</option>
                        <option value="balanced">Balanced · cost and capability</option>
                        <option value="cost">Cost · leanest viable models</option>
                      </Select>
                    </Field>
                    <p className="muted" style={{ fontSize: 12, margin: 0 }}>
                      {strategy === "pm"
                        ? "Asks the selected PM to choose workers, models, reviewers, and budgets for this graph."
                        : strategy === "quality"
                          ? "Prioritizes capability on every module."
                          : strategy === "cost"
                            ? "Minimizes spend while meeting module needs."
                            : "Balances model strength against total budget."}
                    </p>
                    <Button
                      variant="primary"
                      disabled={allocationLoading}
                      onClick={() => void allocateProject()}
                    >
                      {allocationLoading
                        ? strategy === "pm"
                          ? "Project manager is staffing…"
                          : "Allocating…"
                        : strategy === "pm"
                          ? "Ask PM to recommend team"
                          : "Auto allocate"}
                    </Button>
                    {graph.allocation_advice ? (
                      <div className="policy" data-testid="allocation-advice">
                        <strong>PM recommendation</strong>
                        <br />
                        {graph.allocation_advice.summary}
                        <div className="meta" style={{ marginTop: 6 }}>
                          {graph.allocation_advice.pm_provider} · {graph.allocation_advice.pm_model}
                        </div>
                      </div>
                    ) : null}
                  </div>
                </details>
                <details className="card side-section" open>
                  <summary>03 · Approve</summary>
                  <div className="side-body">
                    <p className="muted" style={{ fontSize: 12 }}>
                      Locks the current graph and budget with a verifiable content hash. Every node
                      must be allocated first.
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
                      <output
                        data-testid="approval-stale"
                        className="policy"
                        style={{ marginTop: 8 }}
                      >
                        ⚠ Approval out of date — the graph or allocation changed since it was
                        approved. Re-approve to lock the current graph and budget.
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
                      <output
                        data-testid="approval-none"
                        className="policy"
                        style={{ marginTop: 8 }}
                      >
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
                            tone={
                              selectedNode.assignment.source === "override"
                                ? "success"
                                : selectedNode.assignment.source === "pm"
                                  ? "info"
                                  : "default"
                            }
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
                      {overrideError ? (
                        <Alert testId="override-error">{overrideError}</Alert>
                      ) : null}
                      <div className="actions">
                        <Button
                          variant="primary"
                          className="btn-small"
                          disabled={
                            approval.kind === "pending" ||
                            (!draft.model.trim() && !draft.budget.trim())
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
                          Re-parent preserves dependents. Cascade also removes everything that
                          depends on this node.
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
                          Select a node to inspect its assignment, override its budget, or delete
                          it.
                        </p>
                      </div>
                    </div>
                  )}
                </section>
              </>
            ) : null}
          </div>
        ) : null}
      </main>
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
  const githubCallback =
    typeof window === "undefined"
      ? null
      : new URLSearchParams(window.location.search).get("github");
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
      .catch((error: unknown) => {
        if (cancelled) return;
        clearToken();
        setTok(null);
        setUser(null);
        setAuthError(
          error instanceof UnauthorizedError
            ? "Session expired. Sign in again."
            : "The session could not be restored. Sign in again.",
        );
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
      <>
        <ThemeToggle />
        <Login
          mode={mode}
          inviteToken={inviteToken}
          recoveryToken={recoveryToken}
          onRecoveryComplete={() => setRecoveryToken(null)}
          onAuthenticated={authenticated}
          error={authError}
        />
      </>
    );
  }

  return (
    <>
      <ThemeToggle />
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
          githubCallback={githubCallback}
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
