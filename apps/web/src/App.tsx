import { pmModelOption } from "@norns/contracts";
// TheNorns web app: sole point of entry. Login gates everything; Projects is
// the landing view (list/create); opening a project shows its workspace.
//
// Work (implemented by PhaseTab) is the canonical entry point for new quick
// changes and planned work. Overview keeps recovery UI for durable legacy
// planning runs and strategy reviews so existing work is never abandoned. The older
// synchronous `${base}/plan` + `/plan/load` + PlanReview.tsx flow has no
// remaining caller here; PlanReview.tsx stays for its direct component tests.
//
// The graph editor below (React Flow rendering with editing — edges with
// cycle rejection, node deletion with re-parent/cascade confirmation, Auto
// Allocate, per-node overrides, cost preview, allocation approval) is the
// pre-existing execution path for a project whose graph was already loaded
// before this change; it renders once `graph` exists and is otherwise
// dormant behind the "No plan yet" hint.
import type { Connection, Edge, Node } from "@xyflow/react";
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { SettingsTab } from "./Account";
import { AnalyzeRepositoryControl } from "./AnalyzeRepositoryControl";
import { Debates } from "./Debates";
import { Gantt, type GanttPhase } from "./Gantt";
import { KnowledgeStatusPanel } from "./KnowledgeStatusPanel";
import { Login, type LoginMode } from "./Login";
import { PortfolioMenu } from "./PortfolioMenu";
import { ProjectMembers } from "./ProjectMembers";
import {
  AttentionDecisionForm,
  type AttentionItemDto,
  type PortfolioAttentionDto,
  type ProjectSummary,
  Projects,
} from "./Projects";
import { RunLog } from "./RunLog";
import { StartPhaseControl } from "./StartPhaseControl";
import { type StaffingEdit, StrategyReview, type StrategyReviewDto } from "./StrategyReview";
import { AuthenticatedHeaderActions } from "./UserMenu";
import { WorkspaceSettings } from "./WorkspaceSettings";
import {
  ApiError,
  type AuthSession,
  type CurrentUser,
  UnauthorizedError,
  authHeaders,
  clearToken,
  consumeGitHubCallback,
  consumeInviteToken,
  consumeRecoveryToken,
  fetchAuthStatus,
  fetchMe,
  getToken,
  requestLogout,
  setToken,
} from "./auth";
import type { PhasePlanningRunDto } from "./phaseTabApi";
import {
  type RelationalGraphReadModel,
  buildRelationalGraphReadModel,
} from "./relationalGraphReadModel";
import { ThemeToggle, useTheme } from "./theme";
import {
  Alert,
  Badge,
  Brand,
  Button,
  DismissibleNote,
  Field,
  Input,
  NextStep,
  Select,
  Spinner,
  TextArea,
} from "./ui";
import { type UpdatePreferences, resolveUpdatePreferences } from "./workspacePreferences";

const GraphCanvas = lazy(() =>
  import("./GraphCanvas").then(({ GraphCanvas }) => ({ default: GraphCanvas })),
);
const Account = lazy(() => import("./Account").then(({ Account }) => ({ default: Account })));
const Admin = lazy(() => import("./Admin").then(({ Admin }) => ({ default: Admin })));
const DeviceAuthorizationApproval = lazy(() =>
  import("./DeviceAuthorizationApproval").then(({ DeviceAuthorizationApproval }) => ({
    default: DeviceAuthorizationApproval,
  })),
);
const UsageHub = lazy(() => import("./UsageHub").then(({ UsageHub }) => ({ default: UsageHub })));
const PhaseTab = lazy(() => import("./PhaseTab").then(({ PhaseTab }) => ({ default: PhaseTab })));
const ConversationOverview = lazy(() =>
  import("./ConversationOverview").then(({ ConversationOverview }) => ({
    default: ConversationOverview,
  })),
);
const ProjectOperationsDashboard = lazy(() =>
  import("./ProjectOperationsDashboard").then(({ ProjectOperationsDashboard }) => ({
    default: ProjectOperationsDashboard,
  })),
);

export interface WorkConversationRoute {
  projectId: string;
  conversationId: string | null;
}

export function projectIdFromLocation(): string | null {
  if (typeof window === "undefined") return null;
  const match = /^\/projects\/([^/]+)(?:\/work(?:\/[^/]+)?)?\/?$/.exec(window.location.pathname);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

export function workConversationRouteFromLocation(): WorkConversationRoute | null {
  if (typeof window === "undefined") return null;
  const match = /^\/projects\/([^/]+)\/work(?:\/([^/]+))?\/?$/.exec(window.location.pathname);
  if (!match?.[1]) return null;
  try {
    return {
      projectId: decodeURIComponent(match[1]),
      conversationId: match[2] ? decodeURIComponent(match[2]) : null,
    };
  } catch {
    return null;
  }
}

export function workConversationPath(projectId: string, conversationId?: string | null): string {
  const base = `/projects/${encodeURIComponent(projectId)}/work`;
  return conversationId ? `${base}/${encodeURIComponent(conversationId)}` : base;
}

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
    // EXECUTION E13 — live cost, alongside the throughput fields above.
    // `spend_usd` is real accrued spend from `usage_events`; null means no
    // metered call has landed for this phase yet (never a fabricated 0).
    // `budget_usd` is the phase's real approved_budget_usd (0 = nothing
    // approved yet, which is itself an honest fact, so it is never null).
    spend_usd?: number | null;
    budget_usd?: number;
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
  active_memory_entries?: number;
  recent_completions?: Array<{
    task_id: string;
    title: string;
    completed_at: string;
    pull_request_url?: string | null;
    published_branch?: string | null;
  }>;
}

/** EXECUTION E13 — real accrued spend and the real approved/reserved budget
 *  it is measured against. `spend_usd`/`input_tokens`/`output_tokens` are
 *  null together when nothing has been metered yet (never a fabricated 0,
 *  which would read as "confirmed free"). `budget_usd` is null when no
 *  budget has been reserved for this run yet (distinct from a real
 *  reservation of $0). Optional on the wire so a payload from before this
 *  phase still type-checks. */
interface TaskCostDto {
  spend_usd: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  budget_usd: number | null;
  last_usage_at: string | null;
}

interface PhaseExecutionDto {
  phase: {
    id: string;
    objective_summary: string;
    status: string;
    planning_mode?: "planned" | "quick";
    completed_tasks: number;
    total_tasks: number;
    // EXECUTION E13 — live cost at the phase scope; see TaskCostDto's note
    // on the same honesty rule (null spend != fabricated 0).
    spend_usd?: number | null;
    budget_usd?: number;
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
      // EXECUTION E10 — where the run's work went, so a finished task links to
      // the review instead of only to a commit sha.
      published_branch?: string | null;
      pull_request_url?: string | null;
      publication_note?: string | null;
    } | null;
    // EXECUTION E10 — which verification command failed, and what it printed.
    failed_verification_commands?: Array<{
      name: string;
      command: string[];
      exit_code: number;
      output: string;
    }>;
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
    // EXECUTION E13 — live cost for this task's designated run.
    cost?: TaskCostDto;
  }>;
}

/** True while a run is still able to produce log output / accrue spend —
 *  used both to decide the fast poll cadence (App.tsx) and whether a task's
 *  RunLog panel should keep polling (RunLog.tsx). */
const RUN_ACTIVE_STATES = new Set(["created", "dispatched", "running", "verifying"]);

type PhaseExecutionTask = PhaseExecutionDto["tasks"][number];

function effectivePhaseStatus(execution: PhaseExecutionDto): string {
  const needsAttention = execution.tasks.some(
    (task) =>
      task.state === "failed" ||
      task.state === "blocked" ||
      task.run?.state === "failed" ||
      task.run?.state === "expired" ||
      task.run?.verification_status === "failed",
  );
  if (needsAttention) return "needs attention";
  if (execution.tasks.length > 0 && execution.tasks.every((task) => task.state === "completed")) {
    return "completed";
  }
  return execution.phase.status;
}

/** FRONT DOOR P2's durable planning-run DTO (GET .../planning-runs/:runId),
 *  mirrored client-side. */
interface PlanningRunPollDto {
  id: string;
  status:
    | "queued"
    | "drafting"
    | "reviewing"
    | "revising"
    | "converged"
    | "cap_reached"
    | "failed"
    | "cancelled";
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

function formatUsd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/**
 * EXECUTION E13 — a single honest line of cost. Renders "—" rather than a
 * fabricated $0.00 whenever `spendUsd` is null (nothing metered yet), even
 * when a real budget is already known. Returns null (nothing rendered) only
 * when there is NEITHER a spend figure NOR a budget figure to show — the
 * caller decides whether that absence itself is worth a line ("no run yet").
 */
function CostLine({
  spendUsd,
  budgetUsd,
  testId,
}: {
  spendUsd: number | null | undefined;
  budgetUsd: number | null | undefined;
  testId?: string;
}): React.ReactElement | null {
  if (spendUsd === undefined && budgetUsd === undefined) return null;
  const spendText =
    spendUsd === null || spendUsd === undefined ? (
      <span className="cost-unknown">no metered spend yet</span>
    ) : (
      <span className="cost-amount">{formatUsd(spendUsd)}</span>
    );
  return (
    <div className="cost-line" data-testid={testId}>
      <span>Spend:</span>
      {spendText}
      {budgetUsd !== null && budgetUsd !== undefined ? (
        <span>of {formatUsd(budgetUsd)} budget</span>
      ) : (
        <span className="cost-unknown">budget not reserved yet</span>
      )}
    </div>
  );
}

function TaskQcPanel({
  task,
  projectId,
  phaseId,
  reviewRequired,
  focused,
  onUnauthorized,
}: {
  task: PhaseExecutionTask;
  projectId: string;
  phaseId: string;
  reviewRequired: boolean;
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
            <span className="muted">
              {reviewRequired
                ? "Awaiting independent reviewer assignment"
                : "Review not required for this quick change"}
            </span>
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
          {/* EXECUTION E10 — the click-through to the review. E4 published the
              branch and opened the pull request; until now that fact lived only
              in a run-log string and the UI could not link to it. */}
          {task.run.pull_request_url ? (
            <a
              className="run-pull-request"
              data-testid={`task-pr-${task.id}`}
              href={task.run.pull_request_url}
              rel="noreferrer noopener"
              target="_blank"
            >
              View pull request
            </a>
          ) : task.run.published_branch ? (
            <span className="muted" data-testid={`task-branch-${task.id}`}>
              Branch {task.run.published_branch}
              {task.run.publication_note ? ` · ${task.run.publication_note}` : ""}
            </span>
          ) : null}
        </div>
      ) : null}
      {/* EXECUTION E13 — live cost for this task's designated run. Absent
          entirely (no line at all) when the task has no run yet; a "—"
          rather than $0.00 once a run exists but nothing has been metered. */}
      {task.run && task.cost ? (
        <CostLine
          spendUsd={task.cost.spend_usd}
          budgetUsd={task.cost.budget_usd}
          testId={`task-cost-${task.id}`}
        />
      ) : null}
      {/* EXECUTION E13 — the run's streamed log output, live while the run is
          active and frozen (one final fetch, then no more polling) once it
          is not. */}
      {task.run ? (
        <RunLog
          projectId={projectId}
          phaseId={phaseId}
          taskId={task.id}
          active={RUN_ACTIVE_STATES.has(task.run.state)}
          onUnauthorized={onUnauthorized}
        />
      ) : null}
      {task.run?.failure_detail ? <Alert>{task.run.failure_detail}</Alert> : null}
      {/* EXECUTION E10 — WHICH command failed, and its output. A red badge over
          a sha256 digest is not something a human can act on. */}
      {task.failed_verification_commands?.length ? (
        <details
          className="verification-failures"
          data-testid={`task-verification-${task.id}`}
          open
        >
          <summary>
            Verification failed: {task.failed_verification_commands.map((c) => c.name).join(", ")}
          </summary>
          {task.failed_verification_commands.map((failure) => (
            <div className="verification-failure" key={`${task.id}-${failure.name}`}>
              <div className="verification-failure-head">
                <code>{failure.command.join(" ")}</code>
                <span className="muted">exit {failure.exit_code}</span>
              </div>
              {failure.output ? <pre className="verification-output">{failure.output}</pre> : null}
            </div>
          ))}
        </details>
      ) : null}

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
            <p className="muted">
              {reviewRequired
                ? "No independent QC review has been recorded yet."
                : "Review not required for this quick change."}
            </p>
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
  const json = (await res.json()) as T & { message?: string; detail?: string };
  if (!res.ok)
    throw new ApiError(json.message ?? json.detail ?? `request failed: ${res.status}`, res.status);
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

/** Layered layout with clear horizontal and vertical connector corridors. */
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
    positions.set(node.id, { x: depth * 300 + 20, y: index * 140 + 20 });
  }
  return positions;
}

function ProjectGraph({
  project,
  onBack,
  onOpenProject,
  onProjectArchived,
  onLogout,
  user,
  onOpenAccount,
  onOpenAdmin,
  onOpenNewProject,
  onOpenUsage,
  initialWorkRoute,
  initialConversationId,
  onConversationSelected,
  onNewConversation,
  onConversationRouteCleared,
}: {
  project: ProjectSummary;
  onBack: () => void;
  onOpenProject: (project: ProjectSummary) => void;
  onProjectArchived: (projectId: string) => void;
  onLogout: (message: string) => void;
  user: CurrentUser | null;
  onOpenAccount: () => void;
  onOpenAdmin: () => void;
  onOpenNewProject: () => void;
  onOpenUsage: () => void;
  initialWorkRoute?: boolean;
  initialConversationId?: string | null;
  onConversationSelected?: (conversationId: string, replace?: boolean) => void;
  onNewConversation?: () => void;
  onConversationRouteCleared?: () => void;
}): React.ReactElement {
  const { theme } = useTheme();
  const base = `/api/projects/${project.id}`;
  const isAdoptionJourney =
    project.entry_flow === "adoption" ||
    project.onboarding_scenario === "existing_repo" ||
    project.source_type === "local";
  const isCanonicalPlanningJourney =
    isAdoptionJourney || project.entry_flow === "new" || project.onboarding_scenario === "new_repo";
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
  const [phaseJourneyRunId, setPhaseJourneyRunId] = useState<string | null>(
    isCanonicalPlanningJourney ? (project.focus_planning_run_id ?? null) : null,
  );
  const [phaseComposerRequested, setPhaseComposerRequested] = useState(false);
  const [relationalPlanningRun, setRelationalPlanningRun] = useState<PhasePlanningRunDto | null>(
    null,
  );
  // FRONT DOOR P1d (layout): the workspace shell reorganized into a normal
  // top-width page with a tab bar, per the approved mockup — the graph
  // canvas was the dominant panel before this, everything else crammed into
  // a narrow sidebar. Purely a layout change: every section below is the
  // exact same JSX/logic that existed already, just grouped under a tab.
  type WorkspaceTab = "overview" | "work" | "graph" | "members" | "debates" | "settings";
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>(
    initialWorkRoute || initialConversationId ? "work" : "overview",
  );
  const [mobileWorkspaceNavOpen, setMobileWorkspaceNavOpen] = useState(false);
  const previousInitialWorkRoute = useRef(initialWorkRoute);
  const suppressRouteExitReset = useRef(false);
  const [lastWorkspaceUpdateAt, setLastWorkspaceUpdateAt] = useState<Date | null>(null);
  const [updatePreferences, setUpdatePreferences] = useState<UpdatePreferences>(() =>
    resolveUpdatePreferences(project.id),
  );
  const focusedTaskId = project.focus_task_id ?? null;

  // ------------------------------------------------------------------
  // Legacy planning recovery state. New work is composed in Work; these
  // values remain only so a pre-existing planning run can still be inspected
  // and materialized without abandoning durable work.
  // ------------------------------------------------------------------
  const [activePlanningRunId, setActivePlanningRunId] = useState<string | null>(
    isCanonicalPlanningJourney ? null : (project.focus_planning_run_id ?? null),
  );
  const [planningRun, setPlanningRun] = useState<PlanningRunPollDto | null>(null);
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
  // Last-known-*good* approval state (never "pending"): what we revert to when
  // an in-flight mutation fails, so the banner is never left stuck at pending.
  const lastGoodApprovalRef = useRef<ApprovalState>({ kind: "never" });
  const handleWorkspaceUnauthorized = useCallback(
    () => onLogout("Session expired. Sign in again."),
    [onLogout],
  );

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
      const next = await getJson<ProjectResumeDto>(`/api/v2/projects/${project.id}/resume`);
      setResume(next);
      setLastWorkspaceUpdateAt(new Date());
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

  const loadLatestRelationalPlanningRun = useCallback(async () => {
    try {
      const { planning_run } = await getJson<{ planning_run: PhasePlanningRunDto | null }>(
        `/api/v2/projects/${project.id}/planning-runs/latest`,
      );
      setRelationalPlanningRun(planning_run);
    } catch (err) {
      if (err instanceof UnauthorizedError) onLogout("Session expired. Sign in again.");
      // Projects created before planning runs existed legitimately have no
      // relational fallback. Their legacy workspace remains unchanged.
    }
  }, [project.id, onLogout]);

  const selectWorkspaceTab = useCallback(
    (nextTab: WorkspaceTab) => {
      setWorkspaceTab(nextTab);
      setMobileWorkspaceNavOpen(false);
      if (nextTab !== "work") {
        suppressRouteExitReset.current = true;
        onConversationRouteCleared?.();
      }
      if (draftOnly && !graph) void loadLatestRelationalPlanningRun();
    },
    [draftOnly, graph, loadLatestRelationalPlanningRun, onConversationRouteCleared],
  );

  useEffect(() => {
    if (!mobileWorkspaceNavOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileWorkspaceNavOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [mobileWorkspaceNavOpen]);

  useEffect(() => {
    if (initialWorkRoute || initialConversationId) {
      setWorkspaceTab("work");
    } else if (previousInitialWorkRoute.current) {
      if (suppressRouteExitReset.current) suppressRouteExitReset.current = false;
      else setWorkspaceTab("overview");
    }
    previousInitialWorkRoute.current = initialWorkRoute;
  }, [initialConversationId, initialWorkRoute]);

  // A project can carry a focused planning run for recovery or attention.
  // Prepare that run for Work, but never let saved server state override the
  // normal project landing page. Only an explicit /work route selects Work.
  useEffect(() => {
    let cancelled = false;
    if (isCanonicalPlanningJourney && project.focus_planning_run_id) {
      setPhaseJourneyRunId(project.focus_planning_run_id);
      void getJson<PhasePlanningRunDto>(
        `/api/v2/projects/${project.id}/planning-runs/${project.focus_planning_run_id}`,
      )
        .then((planningRun) => {
          if (!cancelled) setRelationalPlanningRun(planningRun);
        })
        .catch((err) => {
          if (err instanceof UnauthorizedError) onLogout("Session expired. Sign in again.");
        });
      return () => {
        cancelled = true;
      };
    }
    setPhaseJourneyRunId(null);
    if (!isCanonicalPlanningJourney) {
      return () => {
        cancelled = true;
      };
    }
    void getJson<{ planning_run: PhasePlanningRunDto | null }>(
      `/api/v2/projects/${project.id}/planning-runs/latest`,
    )
      .then(async ({ planning_run }) => {
        if (cancelled || !planning_run) return;
        setRelationalPlanningRun(planning_run);
        const planningNeedsAttention = [
          "queued",
          "drafting",
          "reviewing",
          "revising",
          "converged",
          "cap_reached",
        ].includes(planning_run.status);
        if (planningNeedsAttention) {
          setPhaseJourneyRunId(planning_run.id);
          return;
        }
        if (planning_run.status !== "approved") return;

        // Quick runs persist their automatic kickoff outcome on the planning
        // run. Surface a refusal/failure before consulting project-scoped
        // phase rows, where an unrelated active phase could mask it.
        if (planning_run.mode === "quick" && planning_run.execution?.started !== true) {
          setPhaseJourneyRunId(planning_run.id);
          return;
        }

        // An approved run normally belongs on Overview once coding is active.
        // If approval survived but materialization/dispatch did not, return to
        // the journey so its idempotent Retry coding start action is visible.
        const execution = await getJson<{ phases: Array<{ state: string }> }>(
          `/api/v2/projects/${project.id}/execution-status`,
        );
        if (cancelled) return;
        const needsKickoffRecovery =
          execution.phases.length === 0 ||
          execution.phases.some((phase) =>
            ["proposed", "awaiting_approval", "approved", "blocked"].includes(phase.state),
          );
        if (needsKickoffRecovery) {
          setPhaseJourneyRunId(planning_run.id);
        }
      })
      .catch((err) => {
        if (err instanceof UnauthorizedError) onLogout("Session expired. Sign in again.");
        // Planning-run recovery is best-effort for projects created before
        // this API existed; the normal workspace remains fully available.
      });
    return () => {
      cancelled = true;
    };
  }, [project.id, project.focus_planning_run_id, isCanonicalPlanningJourney, onLogout]);

  // A project can remain visible through the legacy workspace while all new
  // work is relational. Load the same fallback used by Graph as soon as the
  // legacy graph is absent so Overview, Tracking, and Knowledge do not claim
  // there is no phase until the human happens to open Graph.
  useEffect(() => {
    if (!draftOnly || graph) return;
    void loadLatestRelationalPlanningRun();
  }, [draftOnly, graph, loadLatestRelationalPlanningRun]);

  // Workspace updates use the user's global cadence unless this project has
  // a local override. Active runs still use the faster execution poll below.
  useEffect(() => {
    const timer = window.setInterval(
      () => void loadResume(),
      updatePreferences.intervalSeconds * 1000,
    );
    return () => window.clearInterval(timer);
  }, [updatePreferences.intervalSeconds, loadResume]);

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

  // Do not display the previous phase's tasks while a newly-selected phase is
  // loading; the relational Graph read model consumes this same state.
  useEffect(() => {
    if (!monitoredPhaseId) return;
    setPhaseExecution(null);
    setExecutionError(null);
  }, [monitoredPhaseId]);

  // EXECUTION E13 — polling cadence, and why it does NOT simply obey
  // `update_interval_seconds` here.
  //
  // The human's configured interval (60/300/900s) is honored for IDLE
  // polling — a phase with no run currently executing gets exactly that
  // cadence, same as the resume poll below. But a live run needs faster
  // feedback than a 5-minute (or 15-minute) default would ever give, and
  // that need is inherent to what this phase built (live cost, live logs),
  // not a reason to silently override the human's choice everywhere. So:
  // while ANY task in the monitored phase has a run in a still-executing
  // state, this poll runs at a fixed, fast PHASE_ACTIVE_POLL_MS regardless of
  // the configured value; the moment no run is active, it reverts to the
  // configured interval (falling back to the same 15s default the resume
  // poll uses before the first resume response names one). This is the same
  // number this poll already used unconditionally before E13 — now it is a
  // deliberate choice made explicit, rather than an interval that happened to
  // ignore the setting.
  const PHASE_ACTIVE_POLL_MS = 5_000;
  const phaseHasActiveRun = useMemo(
    () =>
      (phaseExecution?.tasks ?? []).some(
        (task) => task.run && RUN_ACTIVE_STATES.has(task.run.state),
      ),
    [phaseExecution],
  );
  const monitoredPhaseStatus = phaseExecution ? effectivePhaseStatus(phaseExecution) : null;
  useEffect(() => {
    if (!monitoredPhaseId) return;
    void loadPhaseExecution();
    const idleMs = updatePreferences.intervalSeconds * 1000;
    const pollMs = phaseHasActiveRun ? PHASE_ACTIVE_POLL_MS : idleMs;
    const timer = window.setInterval(() => void loadPhaseExecution(), pollMs);
    return () => window.clearInterval(timer);
  }, [monitoredPhaseId, loadPhaseExecution, phaseHasActiveRun, updatePreferences.intervalSeconds]);

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

  const relationalGraph = useMemo<RelationalGraphReadModel | null>(() => {
    if (!draftOnly) return null;
    const currentPhase =
      resume?.phases.find((phase) => phase.id === monitoredPhaseId) ?? resume?.phases[0] ?? null;
    return buildRelationalGraphReadModel({
      planningRun: relationalPlanningRun,
      phaseExecution,
      phase: currentPhase,
    });
  }, [draftOnly, monitoredPhaseId, phaseExecution, relationalPlanningRun, resume?.phases]);

  // When the legacy resume has not learned about a relational run yet, keep a
  // single honest phase projection for every Overview consumer. This is a
  // presentation fallback only: its planning-run id is never sent to a
  // phase-scoped API as though it were a durable phase id.
  const relationalPhaseFallback = useMemo(() => {
    if (resume?.phases.length || !relationalGraph || !relationalPlanningRun) return null;
    const run = relationalPlanningRun;
    const title =
      run.objective?.trim() ||
      run.result?.plan?.objective?.trim() ||
      run.result?.plan?.modules?.[0]?.title?.trim() ||
      relationalGraph.title;
    const kickoffNeedsAttention = run.status === "approved" && run.execution?.started !== true;
    const failed = run.status === "failed";
    const status =
      run.status === "approved" && run.execution?.started === true ? "active" : run.status;
    const statusLabel = kickoffNeedsAttention
      ? "approved · coding needs restart"
      : failed
        ? "planning failed"
        : status.replaceAll("_", " ");
    const nextAction = kickoffNeedsAttention
      ? "Retry coding start in Work"
      : failed
        ? "Review the planning failure in Work"
        : run.status === "converged" || run.status === "cap_reached"
          ? "Review the plan in Work"
          : status === "active"
            ? "Monitor coding in Work"
            : "Continue this work in Work";

    return {
      id: `planning-run:${run.id}`,
      title,
      status,
      statusLabel,
      taskCount: relationalGraph.graph.nodes.length,
      completedTasks: 0,
      percentComplete: 0,
      blockedLabel: kickoffNeedsAttention
        ? "Coding needs a restart"
        : failed
          ? "Planning stopped"
          : null,
      needsAttention: kickoffNeedsAttention || failed || run.status === "cap_reached",
      nextAction,
    };
  }, [relationalGraph, relationalPlanningRun, resume?.phases.length]);

  const projectNeedsAttention =
    (resume?.attention.blocked_tasks ?? 0) > 0 ||
    monitoredPhaseStatus === "needs attention" ||
    Boolean(relationalPhaseFallback?.needsAttention);

  // FRONT DOOR P1b: the resume phase list, projected into the Gantt's input
  // shape. Phases are already priority-ordered by the server (resume SQL:
  // `ORDER BY p.priority DESC, ...`).
  const ganttPhases: GanttPhase[] = useMemo(() => {
    const durablePhases = (resume?.phases ?? []).map((phase) => ({
      id: phase.id,
      name: phase.objective_summary,
      status: phase.status,
      percentComplete:
        phase.percent_complete ??
        (phase.tasks > 0 ? Math.round((phase.completed_tasks / phase.tasks) * 100) : 0),
      etaAt: phase.eta_at ?? null,
      agentCount: phaseAgentCounts[phase.id],
      blockedLabel: blockedPhaseLabels.get(phase.id) ?? null,
    }));
    if (durablePhases.length > 0 || !relationalPhaseFallback) return durablePhases;
    return [
      {
        id: relationalPhaseFallback.id,
        name: relationalPhaseFallback.title,
        status: relationalPhaseFallback.status,
        percentComplete: relationalPhaseFallback.percentComplete,
        etaAt: null,
        blockedLabel: relationalPhaseFallback.blockedLabel,
      },
    ];
  }, [resume?.phases, phaseAgentCounts, blockedPhaseLabels, relationalPhaseFallback]);

  const resolvePhaseDecision = useCallback(
    async (
      item: AttentionItemDto,
      input: {
        selectedOptionId: string;
        rationale: string;
        directionTarget: string;
        directionText: string;
        idempotencyKey: string;
      },
    ) => {
      const decision = item.decision;
      if (!decision) return;
      setPhaseAttentionBusy(item.key);
      try {
        await postJson(
          `/api/v2/projects/${item.project_id}/decision-points/${encodeURIComponent(decision.decision_point_id)}/resolve`,
          {
            expected_condition_fingerprint: decision.condition_fingerprint,
            selected_option_id: input.selectedOptionId,
            rationale: input.rationale,
            direction_target: input.directionTarget,
            direction_text: input.directionText,
            idempotency_key: input.idempotencyKey,
          },
        );
        // A retry can replace the designated run immediately. Refresh the
        // task/run read model in the same user action so Overview never keeps
        // showing the failed attempt while the attention feed already refers
        // to its replacement.
        await Promise.all([loadProjectAttention(), loadPhaseExecution(), loadResume()]);
      } catch (err) {
        if (err instanceof UnauthorizedError) onLogout("Session expired. Sign in again.");
        else setResumeError(err instanceof Error ? err.message : String(err));
      } finally {
        setPhaseAttentionBusy(null);
      }
    },
    [onLogout, loadProjectAttention, loadPhaseExecution, loadResume],
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

  const displayGraph: GraphDto | null = graph ?? relationalGraph?.graph ?? null;
  const graphIsReadOnly = !graph && relationalGraph !== null;

  const { nodes, edges } = useMemo(() => {
    if (!displayGraph) return { nodes: [] as Node[], edges: [] as Edge[] };
    const positions = layout(displayGraph.nodes);
    const flowNodes: Node[] = displayGraph.nodes.map((node) => ({
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
                {node.assignment.model} · {node.assignment.worker_count}w
                {graphIsReadOnly ? "" : ` · $${node.assignment.budget_usd}`}
                {!graphIsReadOnly && node.assignment.source === "override"
                  ? " · OVERRIDE"
                  : !graphIsReadOnly && node.assignment.source === "pm"
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
    const flowEdges: Edge[] = displayGraph.nodes.flatMap((node) =>
      node.dependencies.map((dep) => ({
        id: `${dep}->${node.id}`,
        source: dep,
        target: node.id,
        type: "orthogonal",
        markerEnd: "arrowclosed" as const,
        style: { stroke: theme === "light" ? "#7a8793" : "#66717d", strokeWidth: 1.7 },
        animated: node.id === selected || dep === selected,
      })),
    );
    return { nodes: flowNodes, edges: flowEdges };
  }, [displayGraph, graphIsReadOnly, selected, theme]);

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

  const selectedNode = displayGraph?.nodes.find((n) => n.id === selected) ?? null;

  // UI-6: the "Dashboard" entry is intentionally not rendered for a real
  // project — it fetched a hardcoded global demo session's data (now moved to
  // its own /api/demo/dashboard surface by Agent C). A durable per-project
  // dashboard is deferred; until then a real project's workspace exposes no
  // dashboard entry and fires no dashboard fetch.

  return (
    <div className="workspace-shell">
      {/* The shared rail names the active project explicitly; project
          switching stays in Portfolio instead of duplicating browser tabs. */}
      <header className="topbar">
        <div className="workspace-nav-start">
          <Brand onHome={onBack} />
          <PortfolioMenu
            activeProjectId={project.id}
            onNewProject={onOpenNewProject}
            onOpenPortfolio={onBack}
            onOpenProject={onOpenProject}
            onUnauthorized={() => onLogout("Session expired. Sign in again.")}
          />
          <div className="workspace-rail-project" data-testid="workspace-project-context">
            <span>Project</span>
            <strong title={project.name}>{project.name}</strong>
          </div>
        </div>
        <Button
          className="btn-small workspace-mobile-menu"
          aria-controls="workspace-navigation"
          aria-expanded={mobileWorkspaceNavOpen}
          onClick={() => setMobileWorkspaceNavOpen((open) => !open)}
        >
          Menu
        </Button>
        {mobileWorkspaceNavOpen ? (
          <button
            type="button"
            className="workspace-mobile-backdrop"
            aria-label="Close navigation"
            onClick={() => setMobileWorkspaceNavOpen(false)}
          />
        ) : null}
        {/* Keep project identity and its sections in one rail flow. This avoids
            the title and navigation drifting into each other as copy changes. */}
        <nav
          className={`workspace-tabs${mobileWorkspaceNavOpen ? " is-mobile-open" : ""}`}
          id="workspace-navigation"
          aria-label="Workspace sections"
        >
          <div className="workspace-mobile-nav-head">
            <strong>{project.name}</strong>
            <Button
              className="btn-small"
              variant="ghost"
              aria-label="Close workspace navigation"
              onClick={() => setMobileWorkspaceNavOpen(false)}
            >
              ×
            </Button>
          </div>
          <div className="workspace-mobile-portfolio-switcher">
            <PortfolioMenu
              activeProjectId={project.id}
              onNewProject={() => {
                setMobileWorkspaceNavOpen(false);
                onOpenNewProject();
              }}
              onOpenPortfolio={() => {
                setMobileWorkspaceNavOpen(false);
                onBack();
              }}
              onOpenProject={(nextProject) => {
                setMobileWorkspaceNavOpen(false);
                onOpenProject(nextProject);
              }}
              onUnauthorized={() => onLogout("Session expired. Sign in again.")}
            />
          </div>
          <button
            type="button"
            className={workspaceTab === "overview" ? "on" : ""}
            aria-current={workspaceTab === "overview" ? "page" : undefined}
            onClick={() => selectWorkspaceTab("overview")}
          >
            Overview
          </button>
          <button
            type="button"
            className={workspaceTab === "work" ? "on" : ""}
            aria-current={workspaceTab === "work" ? "page" : undefined}
            onClick={() => selectWorkspaceTab("work")}
          >
            Work
          </button>
          <button
            type="button"
            className={workspaceTab === "graph" ? "on" : ""}
            aria-current={workspaceTab === "graph" ? "page" : undefined}
            onClick={() => selectWorkspaceTab("graph")}
          >
            Graph
          </button>
          <button
            type="button"
            className={workspaceTab === "members" ? "on" : ""}
            aria-current={workspaceTab === "members" ? "page" : undefined}
            onClick={() => selectWorkspaceTab("members")}
          >
            Members
          </button>
          <button
            type="button"
            className={workspaceTab === "debates" ? "on" : ""}
            aria-current={workspaceTab === "debates" ? "page" : undefined}
            onClick={() => selectWorkspaceTab("debates")}
          >
            Debates
          </button>
          <button
            type="button"
            className={workspaceTab === "settings" ? "on" : ""}
            aria-current={workspaceTab === "settings" ? "page" : undefined}
            onClick={() => selectWorkspaceTab("settings")}
          >
            Settings
          </button>
          {user && mobileWorkspaceNavOpen ? (
            <div className="workspace-mobile-global-actions">
              <span>Account</span>
              <button
                type="button"
                onClick={() => {
                  setMobileWorkspaceNavOpen(false);
                  onOpenUsage();
                }}
              >
                Usage
              </button>
              <button
                type="button"
                onClick={() => {
                  setMobileWorkspaceNavOpen(false);
                  onOpenAccount();
                }}
              >
                Account settings
              </button>
              {user.role === "admin" ? (
                <button
                  type="button"
                  onClick={() => {
                    setMobileWorkspaceNavOpen(false);
                    onOpenAdmin();
                  }}
                >
                  Admin
                </button>
              ) : null}
              <div className="workspace-mobile-theme">
                <span>Appearance</span>
                <ThemeToggle />
              </div>
              <button
                type="button"
                onClick={() => {
                  setMobileWorkspaceNavOpen(false);
                  onLogout("Signed out.");
                }}
              >
                Sign out
              </button>
            </div>
          ) : null}
        </nav>
        {user ? (
          <AuthenticatedHeaderActions
            user={user}
            onOpenUsage={onOpenUsage}
            onOpenAccount={onOpenAccount}
            onOpenAdmin={onOpenAdmin}
            onSignOut={() => onLogout("Signed out.")}
          />
        ) : null}
      </header>
      <main className={`page workspace-page workspace-page-${workspaceTab}`}>
        <div className="project-heading workspace-header">
          <div className="eyebrow">Workspace</div>
          <h1>{project.name}</h1>
          <div className="meta">
            <Badge
              tone={
                projectNeedsAttention ? "danger" : project.status === "planned" ? "success" : "warn"
              }
            >
              {projectNeedsAttention ? "needs attention" : project.status}
            </Badge>
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

        {workspaceTab === "overview" ? (
          <div className="workspace-tab-panel" data-testid="workspace-tab-overview">
            {error ? <Alert testId="error">{error}</Alert> : null}

            {resume ? (
              <section className="card project-overview-dashboard" data-testid="overview-dashboard">
                <div className="section-head">
                  <div>
                    <div className="eyebrow">Project dashboard</div>
                    <h2>Overview</h2>
                  </div>
                  <span className="muted workspace-updated-at">
                    {lastWorkspaceUpdateAt
                      ? `Updated ${lastWorkspaceUpdateAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
                      : "Loading current status…"}
                  </span>
                </div>
                <div className="side-body form-stack">
                  <div className="stat-strip overview-stat-grid">
                    <div className="stat">
                      <strong data-testid="overview-progress">
                        {resume.progress?.overall_percent_complete ?? 0}%
                      </strong>
                      <span>COMPLETE</span>
                    </div>
                    <div className="stat">
                      <strong data-testid="overview-phase-count">
                        {resume.phases.length > 0
                          ? resume.phases.length
                          : relationalPhaseFallback
                            ? 1
                            : 0}
                      </strong>
                      <span>PHASES</span>
                    </div>
                    <div className="stat">
                      <strong data-testid="overview-attention-count">
                        {resume.attention.open_decisions +
                          resume.attention.blocked_tasks +
                          (relationalPhaseFallback?.needsAttention ? 1 : 0)}
                      </strong>
                      <span>NEEDS ATTENTION</span>
                    </div>
                    <div className="stat">
                      <strong data-testid="overview-active-agents">
                        {resume.progress?.agents_active ?? resume.attention.active_runs}
                      </strong>
                      <span>ACTIVE AGENTS</span>
                    </div>
                  </div>
                  <div
                    className={`workspace-update-digest digest-${updatePreferences.detailLevel}`}
                    data-testid="workspace-update-digest"
                  >
                    <div>
                      <span className="eyebrow">Periodic update</span>
                      <strong>
                        {updatePreferences.detailLevel === "attention"
                          ? projectNeedsAttention
                            ? "This project needs your attention"
                            : "No blockers or decisions need you"
                          : `${resume.progress?.overall_percent_complete ?? 0}% complete across ${
                              resume.phases.length || (relationalPhaseFallback ? 1 : 0)
                            } phase${
                              resume.phases.length === 1 || relationalPhaseFallback ? "" : "s"
                            }`}
                      </strong>
                    </div>
                    {updatePreferences.detailLevel === "detailed" ? (
                      <p>
                        {resume.attention.active_runs} active run
                        {resume.attention.active_runs === 1 ? "" : "s"} ·{" "}
                        {resume.recent_completions?.length ?? 0} recent completion
                        {(resume.recent_completions?.length ?? 0) === 1 ? "" : "s"} ·{" "}
                        {resume.active_memory_entries ?? 0} saved project context items
                      </p>
                    ) : updatePreferences.detailLevel === "summary" ? (
                      <p>{relationalPhaseFallback?.nextAction ?? resume.next_recommended_action}</p>
                    ) : null}
                    <span className="muted">
                      Every {Math.round(updatePreferences.intervalSeconds / 60)} minute
                      {updatePreferences.intervalSeconds === 60 ? "" : "s"}
                    </span>
                  </div>
                  {resume.architecture ? (
                    <div data-testid="resume-architecture">
                      <strong>{resume.architecture.title}</strong>
                      <p className="muted">{resume.architecture.summary}</p>
                    </div>
                  ) : null}
                  {/* POLISH P3: `next_recommended_action` is guidance, not a
                   *  failure — it rendered in the red `<Alert>` (exclamation
                   *  icon) and users read "Analyze the repository…" as an
                   *  error. Neutral NextStep now; `<Alert>` stays for real
                   *  problems (the `error` state above, analyze failures).
                   *  When the recommended step is the repository analysis,
                   *  the button that actually performs it rides along. */}
                  <NextStep
                    testId="next-step"
                    action={
                      !resume.architecture && resume.repositories.length > 0 ? (
                        <AnalyzeRepositoryControl
                          projectId={project.id}
                          onAnalyzed={() => void loadResume()}
                          onUnauthorized={() => onLogout("Session expired. Sign in again.")}
                        />
                      ) : undefined
                    }
                  >
                    {relationalPhaseFallback?.nextAction ?? resume.next_recommended_action}
                  </NextStep>
                  {/* FRONT DOOR P1b: the mini-Gantt strip on the workspace phase
                   *  board — compact per-phase gates + progress at a glance. */}
                  {ganttPhases.length > 0 ? (
                    <>
                      <div data-testid="workspace-mini-gantt">
                        <Gantt phases={ganttPhases} mini />
                      </div>
                      <div className="overview-project-timeline" data-testid="project-timeline">
                        <div className="section-head">
                          <div>
                            <div className="eyebrow">Schedule</div>
                            <h3>Project timeline</h3>
                          </div>
                        </div>
                        <Gantt phases={ganttPhases} />
                      </div>
                    </>
                  ) : null}
                  {resume.phases.map((phase) => (
                    <div className="project-row" key={phase.id}>
                      <div>
                        <strong>{phase.objective_summary}</strong>
                        <div className="muted">
                          {phase.status} · {phase.completed_tasks}/{phase.tasks} tasks complete
                        </div>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        {/* EXECUTION E2: the "Start phase" trigger — only
                         *  ever enabled when the real server-side gate
                         *  (PhaseLaunchService) reports the phase ready. */}
                        <StartPhaseControl
                          projectId={project.id}
                          phaseId={phase.id}
                          phaseStatus={phase.status}
                          onStarted={() => void loadResume()}
                          onUnauthorized={() => onLogout("Session expired. Sign in again.")}
                        />
                        <Button
                          className="btn-small"
                          variant={monitoredPhaseId === phase.id ? "primary" : "default"}
                          onClick={() => setMonitoredPhaseId(phase.id)}
                        >
                          {monitoredPhaseId === phase.id ? "Monitoring" : "Monitor"}
                        </Button>
                      </div>
                    </div>
                  ))}
                  {relationalPhaseFallback ? (
                    <div
                      className="project-row"
                      data-testid="relational-overview-phase"
                      key={relationalPhaseFallback.id}
                    >
                      <div>
                        <strong>{relationalPhaseFallback.title}</strong>
                        <div className="muted">
                          {relationalPhaseFallback.statusLabel} ·{" "}
                          {relationalPhaseFallback.completedTasks}/
                          {relationalPhaseFallback.taskCount} tasks complete
                        </div>
                      </div>
                      <Button
                        className="btn-small"
                        variant={relationalPhaseFallback.needsAttention ? "primary" : "default"}
                        onClick={() => setWorkspaceTab("work")}
                      >
                        Open in Work
                      </Button>
                    </div>
                  ) : null}
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
                          tone={
                            monitoredPhaseStatus === "needs attention"
                              ? "danger"
                              : monitoredPhaseStatus === "completed"
                                ? "success"
                                : "info"
                          }
                        >
                          {monitoredPhaseStatus}
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
                        tasks complete · updates every{" "}
                        {phaseHasActiveRun
                          ? "5 seconds"
                          : `${updatePreferences.intervalSeconds} seconds`}
                      </p>
                      {/* EXECUTION E13 — live cost for the whole phase. */}
                      <CostLine
                        spendUsd={phaseExecution.phase.spend_usd}
                        budgetUsd={phaseExecution.phase.budget_usd}
                        testId="phase-cost"
                      />
                      <DismissibleNote
                        storageKey="norns:e13-cost-log-note"
                        testId="e13-honesty-note"
                      >
                        Spend and run-log figures come from real metered provider calls and streamed
                        runner output recorded since this instrumentation shipped. A run or task
                        with nothing recorded yet shows as "no data", never as $0.00 or an empty log
                        presented as complete.
                      </DismissibleNote>
                      <div className="phase-task-list" data-testid="phase-task-list">
                        {phaseExecution.tasks.map((task) => (
                          <TaskQcPanel
                            key={task.id}
                            task={task}
                            projectId={project.id}
                            phaseId={phaseExecution.phase.id}
                            reviewRequired={phaseExecution.phase.planning_mode !== "quick"}
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
              </section>
            ) : null}

            {resume &&
            resume.phases.length === 0 &&
            !relationalPhaseFallback &&
            !strategyReview &&
            !activePlanningRunId ? (
              <button
                type="button"
                className="card workspace-empty-pointer"
                data-testid="overview-no-plan-pointer"
                onClick={() => setWorkspaceTab("work")}
              >
                <strong>No work planned yet</strong>
                <span>Start in Work →</span>
              </button>
            ) : null}

            <Suspense fallback={<Spinner label="Loading project operations…" />}>
              <ProjectOperationsDashboard
                projectId={project.id}
                onUnauthorized={() => onLogout("Session expired. Sign in again.")}
                onOpenLegacyPlanningRun={(planningRunId) => {
                  setActivePlanningRunId(planningRunId);
                }}
              />
            </Suspense>

            <Suspense fallback={<Spinner label="Loading project conversations…" />}>
              <ConversationOverview
                projectId={project.id}
                onOpenConversation={(conversationId) => {
                  setWorkspaceTab("work");
                  onConversationSelected?.(conversationId);
                }}
                onUnauthorized={handleWorkspaceUnauthorized}
              />
            </Suspense>

            <KnowledgeStatusPanel
              projectId={project.id}
              phaseId={monitoredPhaseId}
              relationalPhase={
                relationalPhaseFallback
                  ? {
                      name: relationalPhaseFallback.title,
                      status: relationalPhaseFallback.statusLabel,
                      nextAction: relationalPhaseFallback.nextAction,
                    }
                  : null
              }
              onUnauthorized={handleWorkspaceUnauthorized}
            />
          </div>
        ) : null}

        {workspaceTab === "overview" && (activePlanningRunId || strategyReview) ? (
          <div className="workspace-tab-panel overview-plan-recovery" data-testid="overview-plan">
            {/* Optional legacy planning recovery belongs on Overview so an
             * empty Plan tab never occupies permanent navigation. */}
            <details className="card side-section" open data-testid="planning-section">
              <summary>Plan in progress</summary>
              <div className="side-body form-stack">
                {activePlanningRunId ? (
                  <section className="card planning-run-status" data-testid="planning-run-status">
                    <div className="eyebrow">Drafting next phase</div>
                    <Badge tone={planningRun?.status === "failed" ? "danger" : "info"}>
                      {planningRun?.status ?? "queued"}
                    </Badge>
                    <p className="muted">
                      Round {planningRun?.round ?? 0} of {planningRun?.max_rounds ?? "—"}
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
                    (planningRun.status === "converged" || planningRun.status === "cap_reached") ? (
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
                ) : null}
                {planningRunError ? (
                  <Alert testId="planning-run-error">{planningRunError}</Alert>
                ) : null}
              </div>
            </details>

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

        {/* WORK TAB: goal -> planning run with reviewer rounds ->
         *  human decision (approve/modify/reject with staffing) -> execution
         *  status. Self-contained in PhaseTab.tsx; all its fetches go through
         *  phaseTabApi.ts (the integrator's single reconciliation point). */}
        {workspaceTab === "work" ? (
          <div className="workspace-tab-panel" data-testid="workspace-tab-work">
            <Suspense fallback={<Spinner label="Loading conversation workspace…" />}>
              <PhaseTab
                projectId={project.id}
                initialRunId={phaseJourneyRunId}
                initialConversationId={initialConversationId}
                initialNewConversation={Boolean(initialWorkRoute && !initialConversationId)}
                designatedExecution={phaseExecution}
                composerRequested={phaseComposerRequested}
                onComposerOpened={() => setPhaseComposerRequested(true)}
                onRunStarted={(runId) => {
                  setPhaseJourneyRunId(runId);
                  setPhaseComposerRequested(false);
                }}
                onJourneyChanged={() => {
                  void loadResume();
                  void loadLatestRelationalPlanningRun();
                  void loadPhaseExecution();
                }}
                onOpenRecoveryDetails={(phaseId) => {
                  setMonitoredPhaseId(phaseId);
                  setWorkspaceTab("overview");
                  if (phaseId === monitoredPhaseId) void loadPhaseExecution();
                }}
                onConversationSelected={onConversationSelected}
                onNewConversation={onNewConversation}
                onUnauthorized={() => onLogout("Session expired. Sign in again.")}
              />
            </Suspense>
          </div>
        ) : null}

        {workspaceTab === "debates" ? (
          <div className="workspace-tab-panel" data-testid="workspace-tab-debates">
            <Debates
              embedded
              projectId={project.id}
              onUnauthorized={() => onLogout("Session expired. Sign in again.")}
            />
          </div>
        ) : null}

        {workspaceTab === "settings" ? (
          <div className="workspace-tab-panel" data-testid="workspace-tab-settings">
            <WorkspaceSettings
              projectId={project.id}
              projectName={project.name}
              onProjectArchived={onProjectArchived}
              onPreferencesChanged={setUpdatePreferences}
              onUnauthorized={() => onLogout("Session expired. Sign in again.")}
            />
          </div>
        ) : null}

        {workspaceTab === "graph" ? (
          <div className="workspace-tab-panel" data-testid="workspace-tab-graph">
            {/* FRONT DOOR P1d: the React Flow canvas, demoted to its own tab —
             *  same component, same props, same handlers as before; only the
             *  surrounding layout changed. */}
            <div className="graph-canvas" data-testid="graph-canvas">
              <Suspense fallback={<Spinner label="Loading graph…" />}>
                <GraphCanvas
                  nodes={nodes}
                  edges={edges}
                  editable={Boolean(graph) && !graphIsReadOnly}
                  theme={theme}
                  onConnect={onConnect}
                  onEdgesDelete={onEdgesDelete}
                  onNodeSelect={setSelected}
                />
              </Suspense>
            </div>
            {displayGraph ? (
              <>
                <div className="actions">
                  <Badge
                    tone={
                      graphIsReadOnly
                        ? relationalGraph?.status === "blocked" ||
                          relationalGraph?.status === "failed"
                          ? "warn"
                          : "info"
                        : displayGraph.cost.unallocated.length
                          ? "warn"
                          : "success"
                    }
                  >
                    {graphIsReadOnly
                      ? "Relational read model"
                      : displayGraph.cost.unallocated.length
                        ? `${displayGraph.cost.unallocated.length} unallocated`
                        : "Ready"}
                  </Badge>
                </div>
                <div className="stat-strip">
                  <div className="stat" data-testid="graph-version">
                    <strong>
                      {graphIsReadOnly ? displayGraph.nodes.length : `v${displayGraph.version}`}
                    </strong>
                    <span>{graphIsReadOnly ? "CURRENT WORK ITEMS" : "GRAPH VERSION"}</span>
                  </div>
                  <div className="stat" data-testid="cost-total">
                    <strong>
                      {graphIsReadOnly
                        ? (relationalGraph?.status ?? "current")
                        : `$${displayGraph.cost.total_usd}`}
                    </strong>
                    <span>{graphIsReadOnly ? "RELATIONAL STATUS" : "COST PREVIEW"}</span>
                  </div>
                </div>
              </>
            ) : draftOnly ? (
              <div className="empty" data-testid="draft-hint">
                <div>
                  <div className="empty-icon">◇</div>
                  <strong>No plan yet</strong>
                  <p>Start work in Phase to create the first planning run.</p>
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
                    <p className="muted" style={{ margin: 0 }}>
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
                    <p className="muted">
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
                        <p className="muted">
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
            ) : relationalGraph ? (
              <section
                className="card side-section"
                data-testid="relational-graph-summary"
                aria-labelledby="relational-graph-title"
              >
                <div className="side-body form-stack">
                  <div className="section-head">
                    <div>
                      <div className="eyebrow">Read-only relational view</div>
                      <h3 id="relational-graph-title">{relationalGraph.title}</h3>
                    </div>
                    <Badge
                      tone={
                        relationalGraph.status === "blocked" || relationalGraph.status === "failed"
                          ? "warn"
                          : "info"
                      }
                    >
                      {relationalGraph.status.replaceAll("_", " ")}
                    </Badge>
                  </div>
                  <p className="muted">
                    This graph comes from the current planning run and phase execution records.
                    Allocation and graph-edit controls remain available only for legacy imported
                    graphs.
                  </p>
                  {selectedNode ? (
                    <div className="assignment" data-testid="relational-node-details">
                      <span>Work item</span>
                      <strong>{selectedNode.title}</strong>
                      <span>Complexity</span>
                      <strong>{selectedNode.complexity}</strong>
                      <span>Risk</span>
                      <strong>{selectedNode.risk}</strong>
                      <span>Depends on</span>
                      <strong>{selectedNode.dependencies.join(", ") || "Nothing"}</strong>
                      <span>Agent</span>
                      <strong>
                        {selectedNode.assignment
                          ? `${selectedNode.assignment.provider} · ${selectedNode.assignment.model}`
                          : "Not assigned yet"}
                      </strong>
                      <span>Reviewer</span>
                      <strong>{selectedNode.assignment?.reviewer_model ?? "Not assigned"}</strong>
                    </div>
                  ) : (
                    <p className="muted">Select a work item to inspect its current assignment.</p>
                  )}
                </div>
              </section>
            ) : null}
          </div>
        ) : null}

        {workspaceTab === "members" ? (
          <div className="workspace-tab-panel" data-testid="workspace-tab-members">
            <ProjectMembers
              projectId={project.id}
              onUnauthorized={() => onLogout("Session expired. Sign in again.")}
            />
          </div>
        ) : null}
      </main>
    </div>
  );
}

type GlobalPage = "usage" | "settings" | "admin" | "device-authorization";

function GlobalPageShell({
  page,
  user,
  activeProject,
  onOpenNewProject,
  onOpenPortfolio,
  onOpenProject,
  onOpenUsage,
  onOpenAccount,
  onOpenAdmin,
  onSignOut,
  children,
}: {
  page: GlobalPage;
  user: CurrentUser;
  activeProject: ProjectSummary | null;
  onOpenNewProject: () => void;
  onOpenPortfolio: () => void;
  onOpenProject: (project: ProjectSummary) => void;
  onOpenUsage: () => void;
  onOpenAccount: (tab?: SettingsTab) => void;
  onOpenAdmin: () => void;
  onSignOut: () => void;
  children: ReactNode;
}): React.ReactElement {
  return (
    <div className="app-shell global-page-shell">
      <header className="topbar">
        <div className="topbar-main">
          <Brand onHome={onOpenPortfolio} />
          <PortfolioMenu
            activeProjectId={activeProject?.id ?? null}
            onNewProject={onOpenNewProject}
            onOpenPortfolio={onOpenPortfolio}
            onOpenProject={onOpenProject}
            onUnauthorized={onSignOut}
          />
        </div>
        <AuthenticatedHeaderActions
          user={user}
          activeView={page === "device-authorization" ? null : page}
          onOpenUsage={onOpenUsage}
          onOpenAccount={onOpenAccount}
          onOpenAdmin={onOpenAdmin}
          onSignOut={onSignOut}
          portfolioNavigation={{
            activeProjectId: activeProject?.id ?? null,
            onNewProject: onOpenNewProject,
            onOpenPortfolio,
            onOpenProject,
            onUnauthorized: onSignOut,
          }}
        />
      </header>
      <div className="global-page-content">{children}</div>
    </div>
  );
}

export function App(): React.ReactElement {
  const [token, setTok] = useState<string | null>(getToken());
  const [authError, setAuthError] = useState<string | null>(null);
  const [activeProject, setActiveProject] = useState<ProjectSummary | null>(null);
  const [openProjects, setOpenProjects] = useState<ProjectSummary[]>([]);
  const [workConversationRoute, setWorkConversationRoute] = useState<WorkConversationRoute | null>(
    () => workConversationRouteFromLocation(),
  );
  const [routedProjectId, setRoutedProjectId] = useState<string | null>(() =>
    projectIdFromLocation(),
  );
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [needsBootstrap, setNeedsBootstrap] = useState(false);
  const [inviteToken] = useState<string | null>(() => consumeInviteToken());
  const [recoveryToken, setRecoveryToken] = useState<string | null>(() => consumeRecoveryToken());
  const requestedSettingsTab =
    typeof window === "undefined"
      ? null
      : new URLSearchParams(window.location.search).get("settings");
  const [githubCallback] = useState<string | null>(() =>
    typeof window === "undefined" ? null : consumeGitHubCallback(),
  );
  const [showAccount, setShowAccount] = useState(requestedSettingsTab !== null);
  const [accountTab, setAccountTab] = useState<SettingsTab>(
    requestedSettingsTab === "connections" ? "connections" : "profile",
  );
  const [showAdmin, setShowAdmin] = useState(false);
  const [showUsage, setShowUsage] = useState(false);
  const [newProjectRequested, setNewProjectRequested] = useState(false);
  const resetProjectNavigation = useCallback(() => {
    setActiveProject(null);
    setWorkConversationRoute(null);
    setRoutedProjectId(null);
    setNewProjectRequested(false);
    if (window.location.pathname !== "/") {
      window.history.replaceState(null, "", "/");
    }
  }, []);

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
        resetProjectNavigation();
        setAuthError(
          error instanceof UnauthorizedError
            ? "Session expired. Sign in again."
            : "The session could not be restored. Sign in again.",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [resetProjectNavigation, token]);

  useEffect(() => {
    const handlePopState = () => {
      const route = workConversationRouteFromLocation();
      const projectId = projectIdFromLocation();
      setWorkConversationRoute(route);
      setRoutedProjectId(projectId);
      if (!projectId && window.location.pathname === "/") setActiveProject(null);
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    if (!token || !routedProjectId) return;
    if (activeProject?.id === routedProjectId) return;
    let cancelled = false;
    fetch(`/api/projects/${encodeURIComponent(routedProjectId)}`, {
      credentials: "include",
      headers: authHeaders(),
    })
      .then(async (response) => {
        if (response.status === 401) throw new UnauthorizedError();
        const payload = (await response.json().catch(() => ({}))) as ProjectSummary & {
          message?: string;
        };
        if (!response.ok) {
          throw new ApiError(
            payload.message ?? `request failed: ${response.status}`,
            response.status,
          );
        }
        if (cancelled) return;
        setOpenProjects((current) =>
          current.some((project) => project.id === payload.id)
            ? current.map((project) => (project.id === payload.id ? payload : project))
            : [...current, payload],
        );
        setActiveProject(payload);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (error instanceof UnauthorizedError) {
          clearToken();
          setTok(null);
          setUser(null);
          setAuthError("Session expired. Sign in again.");
          return;
        }
        setAuthError(
          error instanceof Error ? error.message : "The project link could not be opened.",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [activeProject?.id, routedProjectId, token]);

  const authenticated = useCallback((session: AuthSession) => {
    setToken(session.token);
    setUser(session.user);
    setAuthError(null);
    setTok("present");
  }, []);

  const logout = useCallback(
    (message: string) => {
      void requestLogout();
      clearToken();
      setTok(null);
      setUser(null);
      setAuthError(message);
      resetProjectNavigation();
      setOpenProjects([]);
      setShowAccount(false);
      setShowAdmin(false);
      setShowUsage(false);
    },
    [resetProjectNavigation],
  );

  const openProject = useCallback((project: ProjectSummary) => {
    setOpenProjects((current) =>
      current.some((p) => p.id === project.id)
        ? current.map((p) => (p.id === project.id ? project : p))
        : [...current, project],
    );
    setActiveProject(project);
    setNewProjectRequested(false);
    setWorkConversationRoute(null);
    setRoutedProjectId(project.id);
    window.history.pushState(null, "", `/projects/${encodeURIComponent(project.id)}`);
  }, []);

  const closeProject = useCallback(
    (id: string) => {
      setOpenProjects((current) => current.filter((project) => project.id !== id));
      if (activeProject?.id === id) {
        setActiveProject(null);
        setWorkConversationRoute(null);
        setRoutedProjectId(null);
        window.history.pushState(null, "", "/");
      }
    },
    [activeProject?.id],
  );

  const openConversation = useCallback(
    (projectId: string, conversationId: string, replace = false) => {
      const route = { projectId, conversationId };
      setWorkConversationRoute(route);
      setRoutedProjectId(projectId);
      const path = workConversationPath(projectId, conversationId);
      if (replace) window.history.replaceState(null, "", path);
      else if (window.location.pathname !== path) window.history.pushState(null, "", path);
    },
    [],
  );

  const openNewConversation = useCallback((projectId: string) => {
    setWorkConversationRoute({ projectId, conversationId: null });
    setRoutedProjectId(projectId);
    window.history.replaceState(null, "", workConversationPath(projectId));
  }, []);

  const clearConversationRoute = useCallback((projectId: string) => {
    setWorkConversationRoute(null);
    setRoutedProjectId(projectId);
    const path = `/projects/${encodeURIComponent(projectId)}`;
    if (window.location.pathname !== path) window.history.pushState(null, "", path);
  }, []);

  const openAccount = useCallback((tab: SettingsTab = "profile") => {
    setAccountTab(tab);
    setShowAdmin(false);
    setShowUsage(false);
    setShowAccount(true);
  }, []);

  const openAdmin = useCallback(() => {
    setShowAccount(false);
    setShowUsage(false);
    setShowAdmin(true);
  }, []);

  const handleCurrentUserRoleChanged = useCallback((role: "admin" | "member") => {
    setUser((current) => (current ? { ...current, role } : current));
    if (role !== "admin") setShowAdmin(false);
  }, []);

  const openUsage = useCallback(() => {
    setShowAccount(false);
    setShowAdmin(false);
    setShowUsage(true);
  }, []);

  const closeGlobalPage = useCallback(() => {
    setShowAccount(false);
    setShowAdmin(false);
    setShowUsage(false);
  }, []);

  const navigateToPortfolio = useCallback((newProject: boolean) => {
    setShowAccount(false);
    setShowAdmin(false);
    setShowUsage(false);
    setActiveProject(null);
    setNewProjectRequested(newProject);
    setWorkConversationRoute(null);
    setRoutedProjectId(null);
    window.history.pushState(null, "", "/");
  }, []);

  const openPortfolio = useCallback(() => navigateToPortfolio(false), [navigateToPortfolio]);
  const openNewProject = useCallback(() => navigateToPortfolio(true), [navigateToPortfolio]);
  const handleNewProjectRequest = useCallback(() => setNewProjectRequested(false), []);

  const openProjectFromGlobalNavigation = useCallback(
    (project: ProjectSummary) => {
      closeGlobalPage();
      openProject(project);
    },
    [closeGlobalPage, openProject],
  );

  const globalPage: GlobalPage | null = showAccount
    ? "settings"
    : showAdmin && user?.role === "admin"
      ? "admin"
      : showUsage
        ? "usage"
        : null;
  const deviceAuthorizationRoute =
    typeof window !== "undefined" && window.location.pathname === "/device-authorization";

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
        {/* DESIGN P1: the toggle lives in topbar actions on shell screens; the
            login screen has no topbar yet, so it keeps a floating fallback. */}
        <div className="floating-theme-toggle">
          <ThemeToggle />
        </div>
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

  if (deviceAuthorizationRoute && user) {
    return (
      <GlobalPageShell
        page="device-authorization"
        user={user}
        activeProject={activeProject}
        onOpenNewProject={openNewProject}
        onOpenPortfolio={openPortfolio}
        onOpenProject={openProjectFromGlobalNavigation}
        onOpenUsage={openUsage}
        onOpenAccount={openAccount}
        onOpenAdmin={openAdmin}
        onSignOut={() => logout("Signed out.")}
      >
        <Suspense fallback={<Spinner label="Loading device authorization…" />}>
          <DeviceAuthorizationApproval
            user={user}
            onUnauthorized={() => logout("Session expired. Sign in again.")}
          />
        </Suspense>
      </GlobalPageShell>
    );
  }

  if (globalPage && user) {
    return (
      <GlobalPageShell
        page={globalPage}
        user={user}
        activeProject={activeProject}
        onOpenNewProject={openNewProject}
        onOpenPortfolio={openPortfolio}
        onOpenProject={openProjectFromGlobalNavigation}
        onOpenUsage={openUsage}
        onOpenAccount={openAccount}
        onOpenAdmin={openAdmin}
        onSignOut={() => logout("Signed out.")}
      >
        {globalPage === "settings" ? (
          <Suspense fallback={<Spinner label="Loading settings…" />}>
            <Account
              embedded
              user={user}
              onClose={closeGlobalPage}
              onSignOut={() => logout("Signed out.")}
              onUnauthorized={() => logout("Session expired. Sign in again.")}
              initialTab={accountTab}
              githubCallback={githubCallback}
            />
          </Suspense>
        ) : globalPage === "admin" ? (
          <Suspense fallback={<Spinner label="Loading administration…" />}>
            <Admin
              embedded
              onClose={closeGlobalPage}
              onUnauthorized={() => logout("Session expired. Sign in again.")}
              currentUserId={user.id}
              onCurrentUserRoleChanged={handleCurrentUserRoleChanged}
            />
          </Suspense>
        ) : (
          <Suspense fallback={<Spinner label="Loading usage intelligence…" />}>
            <UsageHub
              embedded
              user={user}
              {...(activeProject
                ? { project: { id: activeProject.id, name: activeProject.name } }
                : {})}
              onClose={closeGlobalPage}
              onUnauthorized={() => logout("Session expired. Sign in again.")}
            />
          </Suspense>
        )}
      </GlobalPageShell>
    );
  }

  return !activeProject ? (
    <Projects
      onOpenProject={openProject}
      openProjects={openProjects}
      onUnauthorized={() => logout("Session expired. Sign in again.")}
      onSignOut={() => logout("Signed out.")}
      user={user}
      onOpenAccount={openAccount}
      onOpenAdmin={openAdmin}
      onOpenUsage={openUsage}
      newProjectRequested={newProjectRequested}
      onNewProjectRequestHandled={handleNewProjectRequest}
    />
  ) : (
    <ProjectGraph
      key={activeProject.id}
      project={activeProject}
      onBack={openPortfolio}
      onOpenProject={openProject}
      onProjectArchived={closeProject}
      onLogout={logout}
      user={user}
      onOpenAccount={openAccount}
      onOpenAdmin={openAdmin}
      onOpenNewProject={openNewProject}
      onOpenUsage={openUsage}
      initialWorkRoute={workConversationRoute?.projectId === activeProject.id}
      initialConversationId={
        workConversationRoute?.projectId === activeProject.id
          ? workConversationRoute.conversationId
          : null
      }
      onConversationSelected={(conversationId, replace) =>
        openConversation(activeProject.id, conversationId, replace)
      }
      onNewConversation={() => openNewConversation(activeProject.id)}
      onConversationRouteCleared={() => clearConversationRoute(activeProject.id)}
    />
  );
}
