import {
  DEFAULT_PM_MODEL,
  PM_MODEL_OPTIONS,
  type PmModelT,
  pmModelOption,
  providerForPmModel,
} from "@norns/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GitHubConnection, GitHubIntegrationStatus } from "./Account";
import { AttachmentInput } from "./AttachmentInput";
import { ApiError, type CurrentUser, UnauthorizedError, authHeaders } from "./auth";
import {
  chooseLocalFolder,
  getLocalHelperStatus,
  type LocalFolderSelection,
  type LocalHelperPairing,
  type LocalHelperStatus,
  startLocalHelperPairing,
  watchForLocalHelper,
} from "./localHelper";
import {
  buildSourceFields,
  describeSetup,
  parseGitHubRepoRef,
  type ProjectSourceScenario,
  type ResolvedGitHubRepository,
  type ResolvedLocalFolder,
} from "./projectSourceRequest";
import { Alert, Badge, Brand, Button, Field, Input, Select, Spinner, TextArea } from "./ui";

export interface ProjectSummary {
  id: string;
  name: string;
  description: string;
  pm_provider: "anthropic" | "openai";
  pm_model: PmModelT | null;
  reviewer_provider: "anthropic" | "openai";
  status: "draft" | "planned";
  created_at: string;
  plan_objective: string | null;
  source_type?: "local" | "github" | null;
  source_location?: string | null;
  /** Transient navigation hints attached by the attention center. */
  focus_phase_id?: string | null;
  focus_task_id?: string | null;
  /** FRONT DOOR P1: set by the New Project wizard when it kicked off a
   *  planning run for this project — the workspace opens pre-focused on
   *  that run's progress instead of a blank graph. */
  focus_planning_run_id?: string | null;
}

// ---------------------------------------------------------------------------
// FRONT DOOR P1 (dashboard): per-project progress, read from
// GET /api/v2/projects/:id/resume (P5's `progress`/per-phase tracking
// fields). Kept as a local, loosely-typed slice — the dashboard only reads a
// handful of fields and tolerates a resume response that omits them (older
// projects / a resume call that 404s are both handled as "no data yet").
export interface DashboardPhaseSummary {
  id: string;
  objective_summary: string;
  status: string;
  percent_complete: number;
  tasks_completed: number;
  tasks_total: number;
  eta_at: string | null;
  blocked: boolean;
}

export interface DashboardResumeSummary {
  phases: DashboardPhaseSummary[];
  overall_percent_complete: number;
  blended_eta_at: string | null;
  agents_active: number;
  decisions_waiting: number;
}

/** Human wall-clock ETA from an ISO timestamp, e.g. "~6 hr" / "~2 days". Never
 *  fabricates a number when there is no signal (null in, null-ish text out). */
export function formatEta(
  etaAt: string | null | undefined,
  now: () => Date = () => new Date(),
): string {
  if (!etaAt) return "—";
  const target = Date.parse(etaAt);
  if (!Number.isFinite(target)) return "—";
  const diffMs = target - now().getTime();
  if (diffMs <= 0) return "due now";
  const hours = diffMs / 3_600_000;
  if (hours < 1) return "~< 1 hr";
  if (hours < 36) return `~${Math.round(hours)} hr`;
  const days = hours / 24;
  return `~${Math.round(days)} day${Math.round(days) === 1 ? "" : "s"}`;
}

/** A calendar-style ETA for the aggregate/blended figure, e.g. "Jul 27". */
export function formatEtaDate(etaAt: string | null | undefined): string {
  if (!etaAt) return "—";
  const target = new Date(etaAt);
  if (Number.isNaN(target.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(target);
}

export interface AttentionItemDto {
  key: string;
  project_id: string;
  project_name: string;
  condition_fingerprint: string;
  kind:
    | "decision"
    | "approval"
    | "blocker"
    | "failed_run"
    | "stalled_run"
    | "budget_exception"
    | "milestone";
  severity: "critical" | "high" | "normal" | "low";
  title: string;
  summary: string;
  explanation: string;
  recommendation: string;
  tradeoffs: string[];
  impact: string;
  resumes: string;
  occurred_at: string;
  phase_id?: string | null;
  task_id?: string | null;
  source_type?: string;
  source_id?: string;
  decision?: {
    decision_point_id: string;
    condition_fingerprint: string;
    options: Array<{ id: string; label: string; impact: string; risk: string }>;
    recommendation_option_id: string;
  } | null;
}

export interface PortfolioAttentionDto {
  generated_at: string;
  counts: {
    critical: number;
    high: number;
    decisions: number;
    approvals: number;
    blockers: number;
    active_projects: number;
    active_runs: number;
  };
  items: AttentionItemDto[];
  projects: Array<{
    id: string;
    name: string;
    health: "healthy" | "attention" | "blocked";
    current_phase: string | null;
    completed_tasks: number;
    total_tasks: number;
    active_runs: number;
    attention_count: number;
    next_action: string;
  }>;
}

interface GitHubRepository {
  id: string;
  connection_id: string;
  owner: string;
  name: string;
  full_name: string;
  private: boolean;
  default_branch: string;
  html_url: string;
  clone_url: string;
  description: string | null;
  language: string | null;
  archived: boolean;
  updated_at: string;
  binding_ready?: boolean;
}

interface LocalBindingResult {
  runner_id: string;
  repository_display_name?: string;
}

async function request<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: authHeaders(body !== undefined),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status === 401) throw new UnauthorizedError();
  const json = (await res.json()) as T & { message?: string };
  if (!res.ok) throw new ApiError(json.message ?? `request failed: ${res.status}`, res.status);
  return json;
}

/** Like `request`, but for methods `request`'s POST-if-body/GET-otherwise
 *  shorthand can't express (PATCH with a body, DELETE with none). A 204
 *  (both planning-reviewer mutation routes) has no JSON body to parse. */
async function requestVerb(
  path: string,
  method: "PATCH" | "DELETE",
  body?: unknown,
): Promise<void> {
  const res = await fetch(path, {
    method,
    headers: authHeaders(body !== undefined),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) {
    const json = (await res.json().catch(() => ({}))) as { message?: string };
    throw new ApiError(json.message ?? `request failed: ${res.status}`, res.status);
  }
}

export function AttentionDecisionForm({
  item,
  busy,
  onResolve,
}: {
  item: AttentionItemDto & { decision: NonNullable<AttentionItemDto["decision"]> };
  busy: boolean;
  onResolve: (input: {
    selectedOptionId: string;
    rationale: string;
    directionTarget: string;
    directionText: string;
    idempotencyKey: string;
  }) => Promise<void>;
}): React.ReactElement {
  const [selectedOptionId, setSelectedOptionId] = useState(item.decision.recommendation_option_id);
  const [rationale, setRationale] = useState("");
  const [directionTarget, setDirectionTarget] = useState("project_manager");
  const [directionText, setDirectionText] = useState("");
  const [idempotencyKey] = useState(
    () => `decision-${item.decision.decision_point_id}-${globalThis.crypto.randomUUID()}`,
  );

  return (
    <section className="decision-response" aria-label={`Respond to ${item.title}`}>
      <div className="decision-options" role="radiogroup" aria-label="Decision options">
        {item.decision.options.map((option) => {
          const recommended = option.id === item.decision.recommendation_option_id;
          return (
            <label className={selectedOptionId === option.id ? "is-selected" : ""} key={option.id}>
              <input
                type="radio"
                name={`decision-${item.decision.decision_point_id}`}
                value={option.id}
                checked={selectedOptionId === option.id}
                onChange={() => setSelectedOptionId(option.id)}
              />
              <span>
                <strong>{option.label}</strong>
                {recommended ? <Badge tone="info">Recommended</Badge> : null}
                <small>
                  Impact: {option.impact} · Risk: {option.risk}
                </small>
              </span>
            </label>
          );
        })}
      </div>
      <Field label="Decision rationale">
        <TextArea
          value={rationale}
          placeholder="Explain the strategic judgment so it becomes part of project memory…"
          onChange={(event) => setRationale(event.target.value)}
        />
      </Field>
      <div className="decision-direction-grid">
        <Field label="Direct subsequent work to">
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
        <Field label="Optional direction for subsequent work">
          <TextArea
            value={directionText}
            placeholder="Constraints or instructions for the next orchestration/rework step…"
            onChange={(event) => setDirectionText(event.target.value)}
          />
        </Field>
      </div>
      <p className="meta">
        Direction is recorded in project memory. Delivery to the selected agent remains pending
        until a coordinator context-assembly step consumes it; active runs are not interrupted.
      </p>
      <Button
        variant="primary"
        disabled={busy || !selectedOptionId || !rationale.trim()}
        onClick={() =>
          void onResolve({
            selectedOptionId,
            rationale: rationale.trim(),
            directionTarget,
            directionText: directionText.trim(),
            idempotencyKey,
          })
        }
      >
        {busy ? "Recording decision…" : "Resolve decision"}
      </Button>
    </section>
  );
}

export function ProjectTabs({
  projects,
  activeId,
  onSelect,
  onClose,
}: {
  projects: ProjectSummary[];
  activeId?: string | null;
  onSelect: (project: ProjectSummary) => void;
  onClose: (id: string) => void;
}): React.ReactElement | null {
  if (!projects.length) return null;
  return (
    <nav className="project-tabs" aria-label="Open projects">
      <span className="project-tabs-label">Open</span>
      {projects.map((project) => (
        <div
          className={`project-tab ${activeId === project.id ? "is-active" : ""}`}
          key={project.id}
        >
          <button type="button" onClick={() => onSelect(project)} title={`Open ${project.name}`}>
            <span className={`status-dot status-${project.status}`} />
            {project.name}
          </button>
          <button
            type="button"
            className="project-tab-close"
            aria-label={`Close ${project.name}`}
            onClick={() => onClose(project.id)}
          >
            ×
          </button>
        </div>
      ))}
    </nav>
  );
}

export function Projects({
  onOpenProject,
  openProjects,
  onCloseProject,
  onUnauthorized,
  onSignOut,
  user,
  onOpenAccount,
  onOpenAdmin,
}: {
  onOpenProject: (p: ProjectSummary) => void;
  openProjects: ProjectSummary[];
  onCloseProject: (id: string) => void;
  onUnauthorized: () => void;
  onSignOut: () => void;
  user: CurrentUser | null;
  onOpenAccount: () => void;
  onOpenAdmin: () => void;
}): React.ReactElement {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [dialog, setDialog] = useState(false);
  // O1: the wizard's two questions.
  //   Q1 (always): "Is this new, or existing work?"
  //   Q2 (new):      "Where should it live?"      -> local | local_github
  //   Q2 (existing): "Where is it now?"            -> github | local
  // Together they resolve to exactly one of the four onboarding scenarios
  // (see projectSourceRequest.ts's ProjectSourceScenario).
  const [startingPoint, setStartingPoint] = useState<"new" | "existing">("new");
  const [newDestination, setNewDestination] = useState<"local" | "local_github">("local");
  const [existingSource, setExistingSource] = useState<"github" | "local">("github");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [pmModel, setPmModel] = useState<PmModelT>(DEFAULT_PM_MODEL.anthropic);
  const pmProvider = providerForPmModel(pmModel);
  const selectedModel = pmModelOption(pmModel);
  const reviewerProviderPreview = pmProvider === "anthropic" ? "openai" : "anthropic";
  const reviewerPreviewLabel =
    pmModelOption(DEFAULT_PM_MODEL[reviewerProviderPreview])?.label ?? reviewerProviderPreview;
  const [githubStatus, setGitHubStatus] = useState<GitHubIntegrationStatus | null>(null);
  const [githubConnectBusy, setGitHubConnectBusy] = useState(false);
  const [selectedConnectionId, setSelectedConnectionId] = useState("");
  const [repositories, setRepositories] = useState<GitHubRepository[]>([]);
  const [selectedRepositoryId, setSelectedRepositoryId] = useState("");
  const [repositoryQuery, setRepositoryQuery] = useState("");
  const [repositoryLoading, setRepositoryLoading] = useState(false);
  const repositoryRequestEpoch = useRef(0);
  // Whether the GitHub section is picking one of the connection's existing
  // repositories, or creating a fresh one (a real, working server capability
  // — GitHubIntegrationService.createRepository — reused unchanged here).
  const [githubMode, setGitHubMode] = useState<"pick" | "create">("pick");
  const [repositoryName, setRepositoryName] = useState("");
  const [repositoryPrivate, setRepositoryPrivate] = useState(true);
  // O1: local-helper folder picking. `helperStatus` is null while the first
  // check is in flight; thereafter it is one of localHelper.ts's two states
  // ("connected" | "not_installed") — never a dead end either way.
  const [helperStatus, setHelperStatus] = useState<LocalHelperStatus | null>(null);
  const [helperPairing, setHelperPairing] = useState<LocalHelperPairing | null>(null);
  const [helperPairingCopied, setHelperPairingCopied] = useState(false);
  const [helperChooserLoading, setHelperChooserLoading] = useState(false);
  const [folderSelection, setFolderSelection] = useState<LocalFolderSelection | null>(null);
  const pairingRequestedRef = useRef(false);
  const [pendingLocalProject, setPendingLocalProject] = useState<ProjectSummary | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [attention, setAttention] = useState<PortfolioAttentionDto | null>(null);
  const [attentionBusy, setAttentionBusy] = useState<string | null>(null);
  const [roundsCount, setRoundsCount] = useState(3);
  // FRONT DOOR P2b (D2)/O1: the typed-path fallback. Always available, but
  // de-emphasized beneath the native "Choose folder…" button — FRONT DOOR
  // shipped it as the primary local-folder flow; O1 keeps it working, just
  // no longer as the headline control.
  const [localPath, setLocalPath] = useState("");
  // FRONT DOOR P2b: reviewer selector. "auto" means no explicit override
  // (the server's automatic opposite-provider default); any other value is
  // "provider:model" as offered by MODEL_CHOICES below.
  const [reviewerSelection, setReviewerSelection] = useState("auto");
  // FRONT DOOR P1: after `create()` makes a brand-new project with an
  // objective, the wizard moves to a second in-place step — attach reference
  // screenshots (the real AttachmentInput, which needs a live project id),
  // then explicitly kick off the planning run. `wizardStep` gates which half
  // of the single wizard screen renders; `draftProject` is the project that
  // step operates on.
  const [wizardStep, setWizardStep] = useState<"form" | "attach">("form");
  const [draftProject, setDraftProject] = useState<ProjectSummary | null>(null);
  const [wizardAttachmentIds, setWizardAttachmentIds] = useState<string[]>([]);
  const [wizardObjective, setWizardObjective] = useState("");
  const [planningStarting, setPlanningStarting] = useState(false);
  const [planningError, setPlanningError] = useState<string | null>(null);
  // Per-project phase/progress read model for the dashboard rows (P5's
  // tracking additions to GET .../resume). Best-effort: a project whose
  // resume call fails (404 for a brand-new draft, network error, etc.)
  // simply renders without phase lines rather than blocking the dashboard.
  const [resumeById, setResumeById] = useState<Record<string, DashboardResumeSummary>>({});

  // O1: the two answers resolve to exactly one of the four onboarding
  // scenarios. Every scenario needs a local folder; three of the four also
  // need a connected GitHub repository (only "new + local only" doesn't —
  // the human chose Norns-brokered GitHub App tokens for pushing, so there
  // is no "use your own git credentials" path once a remote is involved).
  const scenario: ProjectSourceScenario =
    startingPoint === "new"
      ? newDestination === "local"
        ? "new_local"
        : "new_local_github"
      : existingSource === "github"
        ? "existing_github"
        : "existing_local";
  const needsGitHub = scenario !== "new_local";
  // Scenario (c) (existing code already on GitHub) is inherently "pick the
  // repository that already holds the code" — offering to create a fresh,
  // empty one alongside it doesn't make sense, so that scenario never shows
  // the create-a-new-repo toggle.
  const canCreateNewRepo = needsGitHub && scenario !== "existing_github";

  const refresh = useCallback(async () => {
    try {
      setError(null);
      setProjects(await request<ProjectSummary[]>("/api/projects"));
    } catch (e) {
      e instanceof UnauthorizedError
        ? onUnauthorized()
        : setError(e instanceof Error ? e.message : String(e));
    }
  }, [onUnauthorized]);

  useEffect(() => void refresh(), [refresh]);

  // FRONT DOOR P1: fetch each project's resume (phase list + progress) so the
  // dashboard rows can render per-phase lines, color coding, and aggregate
  // facts. Best-effort per project — one project's failure never blocks the
  // others (Promise.allSettled), and a project without a plan yet (404) just
  // renders with no phase lines, matching the "Draft" card in the mockup.
  useEffect(() => {
    if (!projects || projects.length === 0) return;
    let cancelled = false;
    const load = async () => {
      const settled = await Promise.allSettled(
        projects.map(async (project) => {
          const resume = await request<{
            phases: Array<{
              id: string;
              objective_summary: string;
              status: string;
              percent_complete?: number;
              tasks_completed?: number;
              tasks_total?: number;
              tasks?: number;
              eta_at?: string | null;
              blocked_tasks?: number;
            }>;
            progress?: {
              overall_percent_complete: number;
              blended_eta_at: string | null;
              agents_active: number;
              decisions_waiting: number;
            };
            attention: { open_decisions: number; active_runs: number; blocked_tasks: number };
          }>(`/api/v2/projects/${project.id}/resume`);
          const phases: DashboardPhaseSummary[] = resume.phases.map((phase) => ({
            id: phase.id,
            objective_summary: phase.objective_summary,
            status: phase.status,
            percent_complete: phase.percent_complete ?? 0,
            tasks_completed: phase.tasks_completed ?? 0,
            tasks_total: phase.tasks_total ?? phase.tasks ?? 0,
            eta_at: phase.eta_at ?? null,
            blocked: phase.status === "blocked" || (phase.blocked_tasks ?? 0) > 0,
          }));
          const summary: DashboardResumeSummary = {
            phases,
            overall_percent_complete: resume.progress?.overall_percent_complete ?? 0,
            blended_eta_at: resume.progress?.blended_eta_at ?? null,
            agents_active: resume.progress?.agents_active ?? resume.attention.active_runs,
            decisions_waiting:
              resume.progress?.decisions_waiting ?? resume.attention.open_decisions,
          };
          return [project.id, summary] as const;
        }),
      );
      if (cancelled) return;
      setResumeById((current) => {
        const next = { ...current };
        for (const outcome of settled) {
          if (outcome.status === "fulfilled") next[outcome.value[0]] = outcome.value[1];
        }
        return next;
      });
    };
    void load();
    const timer = window.setInterval(() => void load(), 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [projects]);

  const refreshGitHub = useCallback(async () => {
    try {
      setSourceError(null);
      const status = await request<GitHubIntegrationStatus>("/api/integrations/github/status");
      setGitHubStatus(status);
      const firstConnected = status.connections.find(
        (connection) => connection.status === "connected",
      );
      setSelectedConnectionId((current) => current || firstConnected?.id || "");
    } catch (error) {
      if (error instanceof UnauthorizedError) onUnauthorized();
      else setSourceError(error instanceof Error ? error.message : String(error));
    }
  }, [onUnauthorized]);

  useEffect(() => void refreshGitHub(), [refreshGitHub]);

  const loadRepositories = useCallback(async () => {
    if (!selectedConnectionId) {
      repositoryRequestEpoch.current += 1;
      setRepositories([]);
      return;
    }
    const requestEpoch = ++repositoryRequestEpoch.current;
    setRepositoryLoading(true);
    setSourceError(null);
    try {
      const repositories = await request<GitHubRepository[]>(
        `/api/integrations/github/connections/${encodeURIComponent(selectedConnectionId)}/repositories`,
      );
      if (repositoryRequestEpoch.current !== requestEpoch) return;
      setRepositories(repositories);
      setSelectedRepositoryId((current) =>
        repositories.some((repository) => repository.id === current) ? current : "",
      );
    } catch (error) {
      if (repositoryRequestEpoch.current !== requestEpoch) return;
      if (error instanceof UnauthorizedError) onUnauthorized();
      else setSourceError(error instanceof Error ? error.message : String(error));
    } finally {
      if (repositoryRequestEpoch.current === requestEpoch) setRepositoryLoading(false);
    }
  }, [onUnauthorized, selectedConnectionId]);

  useEffect(() => {
    if (dialog && needsGitHub && githubMode === "pick" && selectedConnectionId) {
      void loadRepositories();
    }
  }, [dialog, githubMode, loadRepositories, needsGitHub, selectedConnectionId]);

  /** Run the existing GitHub authorize/install flow inline, right from the
   *  wizard — "never make the user hunt through settings mid-setup". Mirrors
   *  Account.tsx's openGitHubFlow exactly (same endpoints, same redirect),
   *  just triggered from here instead of the Settings modal. */
  const connectGitHubInline = useCallback(async () => {
    setGitHubConnectBusy(true);
    setSourceError(null);
    try {
      const kind = githubStatus?.user_authorization.connected ? "install" : "authorize";
      const response = await request<{ authorization_url: string } | { installation_url: string }>(
        `/api/integrations/github/${kind}`,
      );
      const url =
        "authorization_url" in response ? response.authorization_url : response.installation_url;
      window.location.assign(url);
    } catch (error) {
      if (error instanceof UnauthorizedError) onUnauthorized();
      else setSourceError(error instanceof Error ? error.message : String(error));
      setGitHubConnectBusy(false);
    }
  }, [githubStatus, onUnauthorized]);

  // O1: local-helper status. Checked once the wizard opens; re-checked
  // whenever the human switches scenario (every scenario needs a folder, so
  // this only needs to run once dialog is open, not per-scenario, but is
  // cheap to repeat and keeps a stale "not_installed" from lingering after a
  // helper connects mid-session).
  useEffect(() => {
    if (!dialog) return;
    let cancelled = false;
    (async () => {
      try {
        const status = await getLocalHelperStatus();
        if (!cancelled) setHelperStatus(status);
      } catch {
        // Never a dead end: treat an unreachable /api/runners the same as
        // "not installed" — the typed-path fallback still works either way.
        if (!cancelled) setHelperStatus({ state: "not_installed" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dialog]);

  // Once we know the helper isn't installed, start a single pairing session
  // so the wizard can show one calm install step immediately, rather than
  // requiring an extra "Pair" click before the command appears.
  useEffect(() => {
    if (helperStatus?.state !== "not_installed" || pairingRequestedRef.current) return;
    pairingRequestedRef.current = true;
    (async () => {
      try {
        setHelperPairing(await startLocalHelperPairing());
      } catch {
        // Best-effort — the typed-path fallback remains available even if
        // pairing itself couldn't be started (e.g. offline).
      }
    })();
  }, [helperStatus]);

  // Poll until the helper connects, then continue automatically — never
  // requires the human to come back and re-check manually.
  useEffect(() => {
    if (helperStatus?.state !== "not_installed") return;
    const stop = watchForLocalHelper((runnerId) => {
      setHelperStatus({ state: "connected", runnerId });
      pairingRequestedRef.current = false;
      setHelperPairing(null);
    });
    return stop;
  }, [helperStatus]);

  const chooseFolder = useCallback(async () => {
    if (helperStatus?.state !== "connected") return;
    const runnerId = helperStatus.runnerId;
    setHelperChooserLoading(true);
    setSourceError(null);
    try {
      const result = await chooseLocalFolder(runnerId);
      if ("cancelled" in result) return;
      setFolderSelection(result);
      setLocalPath("");
      setName((current) => current || result.displayName);
      setDescription(
        (current) => current || `Analyze and continue development of ${result.displayName}`,
      );
    } catch (error) {
      if (error instanceof UnauthorizedError) onUnauthorized();
      else setSourceError(error instanceof Error ? error.message : String(error));
    } finally {
      setHelperChooserLoading(false);
    }
  }, [helperStatus, onUnauthorized]);

  useEffect(() => {
    if (!folderSelection) return;
    const expireSelection = () => {
      setFolderSelection(null);
      setSourceError("Folder selection expired. Choose the folder again to continue.");
    };
    const remaining = Date.parse(folderSelection.expiresAt) - Date.now();
    if (remaining <= 0) {
      expireSelection();
      return;
    }
    const timer = window.setTimeout(expireSelection, Math.min(remaining, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [folderSelection]);

  const refreshAttention = useCallback(async () => {
    try {
      setAttention(await request<PortfolioAttentionDto>("/api/v2/attention"));
    } catch (error) {
      if (error instanceof UnauthorizedError) onUnauthorized();
      else if (!(error instanceof ApiError && error.status === 404)) {
        setError(error instanceof Error ? error.message : String(error));
      }
    }
  }, [onUnauthorized]);

  useEffect(() => {
    void refreshAttention();
    const timer = window.setInterval(() => void refreshAttention(), 10_000);
    return () => window.clearInterval(timer);
  }, [refreshAttention]);

  const dispositionAttention = useCallback(
    async (item: AttentionItemDto, disposition: "acknowledged" | "snoozed") => {
      setAttentionBusy(item.key);
      try {
        const response = await fetch("/api/v2/attention/disposition", {
          method: "POST",
          headers: authHeaders(true),
          body: JSON.stringify({
            item_key: item.key,
            condition_fingerprint: item.condition_fingerprint,
            disposition,
            snoozed_until:
              disposition === "snoozed" ? new Date(Date.now() + 60 * 60_000).toISOString() : null,
          }),
        });
        if (response.status === 401) throw new UnauthorizedError();
        if (!response.ok)
          throw new ApiError("Attention item changed; refresh and try again", response.status);
        await refreshAttention();
      } catch (error) {
        error instanceof UnauthorizedError
          ? onUnauthorized()
          : setError(error instanceof Error ? error.message : String(error));
      } finally {
        setAttentionBusy(null);
      }
    },
    [onUnauthorized, refreshAttention],
  );

  const resolveDecision = useCallback(
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
      setAttentionBusy(item.key);
      try {
        const response = await fetch(
          `/api/v2/projects/${item.project_id}/decision-points/${decision.decision_point_id}/resolve`,
          {
            method: "POST",
            headers: authHeaders(true),
            body: JSON.stringify({
              expected_condition_fingerprint: decision.condition_fingerprint,
              selected_option_id: input.selectedOptionId,
              rationale: input.rationale,
              direction_target: input.directionTarget,
              direction_text: input.directionText,
              idempotency_key: input.idempotencyKey,
            }),
          },
        );
        if (response.status === 401) throw new UnauthorizedError();
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { message?: string };
          throw new ApiError(
            body.message ?? "Decision changed; review the latest options and try again",
            response.status,
          );
        }
        await refreshAttention();
      } catch (error) {
        error instanceof UnauthorizedError
          ? onUnauthorized()
          : setError(error instanceof Error ? error.message : String(error));
      } finally {
        setAttentionBusy(null);
      }
    },
    [onUnauthorized, refreshAttention],
  );

  const create = useCallback(async () => {
    setCreating(true);
    setError(null);
    setSourceError(null);
    try {
      let repository = repositories.find((candidate) => candidate.id === selectedRepositoryId);
      if (needsGitHub && githubMode === "create") {
        if (!selectedConnectionId) {
          setSourceError("Choose a GitHub account or organization to create the repository under.");
          return;
        }
        repository = await request<GitHubRepository>("/api/integrations/github/repositories", {
          connection_id: selectedConnectionId,
          name: repositoryName.trim(),
          description: description.trim(),
          private: repositoryPrivate,
          auto_init: true,
        });
        if (repository.binding_ready === false) {
          setSourceError(
            `${repository.full_name} was created, but this GitHub installation only has selected-repository access. Add the repository to The Norns in GitHub, refresh connections, and then choose it from the list.`,
          );
          return;
        }
      }
      if (needsGitHub && githubMode === "pick" && !repository) {
        setSourceError("Select a GitHub repository to continue.");
        return;
      }
      const trimmedLocalPath = localPath.trim();
      const activeFolderSelection =
        folderSelection && Date.parse(folderSelection.expiresAt) > Date.now() ? folderSelection : null;
      if (!activeFolderSelection && !trimmedLocalPath) {
        setSourceError("Choose a folder, or type a path, to continue.");
        return;
      }
      const local: ResolvedLocalFolder = activeFolderSelection
        ? {
            kind: "runner",
            selectionToken: activeFolderSelection.selectionToken,
            displayName: activeFolderSelection.displayName,
          }
        : { kind: "path", path: trimmedLocalPath };
      const githubResolved: ResolvedGitHubRepository | null =
        needsGitHub && repository
          ? {
              connectionId: repository.connection_id,
              repositoryId: repository.id,
              fullName: repository.full_name,
            }
          : null;
      const { fields: sourceFields } = buildSourceFields({ scenario, local, github: githubResolved });
      const localDisplayName =
        local.kind === "path"
          ? (local.path.split(/[/\\]/).filter(Boolean).pop() ?? "")
          : local.displayName;
      const projectName = name.trim() || repository?.name || localDisplayName || "Untitled project";
      const projectDescription =
        description.trim() ||
        repository?.description ||
        (repository
          ? `Analyze and continue development of ${repository.full_name}`
          : `Analyze and continue development of ${localDisplayName || "this local folder"}`);
      const project =
        local.kind === "runner" && pendingLocalProject
          ? pendingLocalProject
          : await request<ProjectSummary>("/api/projects", {
              name: projectName,
              description: projectDescription,
              pm_provider: pmProvider,
              pm_model: pmModel,
              ...sourceFields,
            });
      const completedProject =
        local.kind === "runner"
          ? await (async () => {
              try {
                await request<LocalBindingResult>(
                  `/api/v2/projects/${project.id}/source-bindings/local`,
                  {
                    selection_token: local.selectionToken,
                    verification_policy_ref: "verification-policy:default-v1",
                  },
                );
                return {
                  ...project,
                  source_type: "local" as const,
                  source_location: local.displayName,
                };
              } catch (bindingError) {
                setPendingLocalProject(project);
                setFolderSelection(null);
                await refresh();
                setSourceError(
                  `Project created, but local folder binding failed: ${
                    bindingError instanceof Error ? bindingError.message : String(bindingError)
                  }. Choose the folder again, then click Retry folder binding. The existing project will be reused.`,
                );
                return null;
              }
            })()
          : project;
      if (!completedProject) return;
      // FRONT DOOR P2b: apply the reviewer selection right after creation,
      // before starting any planning run — resolvePlanningParticipants()
      // reads this per-project setting on every subsequent run.
      try {
        if (reviewerSelection !== "auto") {
          const [reviewerProviderChoice, ...modelParts] = reviewerSelection.split(":");
          await requestVerb(`/api/v2/projects/${completedProject.id}/planning-reviewer`, "PATCH", {
            provider: reviewerProviderChoice,
            model: modelParts.join(":"),
          });
        } else {
          await requestVerb(`/api/v2/projects/${completedProject.id}/planning-reviewer`, "DELETE");
        }
      } catch {
        // Best-effort: an explicit reviewer preference is a nice-to-have,
        // not a blocker — the project still exists and planning still works
        // (falling back to the automatic default) if this call fails.
      }
      setPendingLocalProject(null);
      setProjects((current) => (current ? [completedProject, ...current] : [completedProject]));
      // FRONT DOOR P1: a brand-new project with an objective moves to the
      // wizard's attach-and-launch step instead of navigating away — the
      // objective becomes the planning run's brief once the human confirms
      // (optionally after attaching reference screenshots). "Existing
      // codebase" imports (no fresh objective to plan from) keep the
      // original immediate-navigate behavior.
      if (startingPoint === "new" && description.trim()) {
        setDraftProject(completedProject);
        setWizardObjective(description.trim());
        setWizardAttachmentIds([]);
        setPlanningError(null);
        setWizardStep("attach");
        return;
      }
      setDialog(false);
      setName("");
      setDescription("");
      setStartingPoint("new");
      setNewDestination("local");
      setSelectedRepositoryId("");
      setRepositoryName("");
      setRepositoryQuery("");
      setGitHubMode("pick");
      setExistingSource("github");
      setFolderSelection(null);
      setLocalPath("");
      onOpenProject(completedProject);
    } catch (e) {
      e instanceof UnauthorizedError
        ? onUnauthorized()
        : setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }, [
    name,
    description,
    pmProvider,
    pmModel,
    repositories,
    selectedRepositoryId,
    startingPoint,
    scenario,
    needsGitHub,
    githubMode,
    selectedConnectionId,
    repositoryName,
    repositoryPrivate,
    folderSelection,
    localPath,
    reviewerSelection,
    pendingLocalProject,
    refresh,
    onOpenProject,
    onUnauthorized,
  ]);

  const closeWizard = useCallback(() => {
    setDialog(false);
    setWizardStep("form");
    setDraftProject(null);
    setWizardAttachmentIds([]);
    setWizardObjective("");
    setPlanningError(null);
    setName("");
    setDescription("");
    setStartingPoint("new");
    setNewRepository("none");
    setSelectedRepositoryId("");
    setRepositoryName("");
    setRepositoryQuery("");
    setExistingSource("github");
    setSelectedLocalWorkspaceId("");
    setLocalBrowser(null);
    setLocalSelection(null);
    setLocalPath("");
    setReviewerSelection("auto");
    setRoundsCount(3);
  }, []);

  // FRONT DOOR P1: the wizard's second step — start the planning run the
  // objective + rounds + attachments describe. `attachment_ids` come straight
  // from AttachmentInput's controlled selection (P4's documented contract).
  const startPlanningRun = useCallback(async () => {
    if (!draftProject) return;
    setPlanningStarting(true);
    setPlanningError(null);
    try {
      const run = await request<{ planning_run_id: string }>(
        `/api/v2/projects/${draftProject.id}/planning-runs`,
        {
          objective: wizardObjective,
          max_rounds: roundsCount,
          attachment_ids: wizardAttachmentIds,
        },
      );
      const project = draftProject;
      closeWizard();
      onOpenProject({ ...project, focus_planning_run_id: run.planning_run_id });
    } catch (e) {
      if (e instanceof UnauthorizedError) onUnauthorized();
      else setPlanningError(e instanceof Error ? e.message : String(e));
    } finally {
      setPlanningStarting(false);
    }
  }, [
    draftProject,
    wizardObjective,
    roundsCount,
    wizardAttachmentIds,
    closeWizard,
    onOpenProject,
    onUnauthorized,
  ]);

  /** Skip drafting a plan right now — the project already exists; open its
   *  (still-empty) workspace directly, same as the "existing codebase" path. */
  const skipPlanning = useCallback(() => {
    if (!draftProject) return;
    const project = draftProject;
    closeWizard();
    onOpenProject(project);
  }, [draftProject, closeWizard, onOpenProject]);

  const visible = useMemo(
    () =>
      projects?.filter((p) =>
        `${p.name} ${p.description} ${p.plan_objective ?? ""}`
          .toLowerCase()
          .includes(query.toLowerCase()),
      ),
    [projects, query],
  );
  const planned = projects?.filter((p) => p.status === "planned").length ?? 0;
  const connectedGitHub =
    githubStatus?.connections.filter((connection) => connection.status === "connected") ?? [];
  const selectedConnection = connectedGitHub.find(
    (connection) => connection.id === selectedConnectionId,
  );
  const visibleRepositories = repositories.filter((repository) =>
    repository.full_name.toLowerCase().includes(repositoryQuery.trim().toLowerCase()),
  );
  const selectedRepository = repositories.find(
    (repository) => repository.id === selectedRepositoryId,
  );
  const localSelectionReady = Boolean(
    localSelection &&
      localSelection.repository.runner_id === selectedLocalRunnerId &&
      localSelection.repository.workspace_id === selectedLocalWorkspaceId &&
      Date.parse(localSelection.expires_at) > Date.now(),
  );
  const sourceRequired = startingPoint === "existing" || newRepository === "github";
  const sourceReady =
    startingPoint === "existing"
      ? existingSource === "github"
        ? Boolean(selectedRepositoryId)
        : localSelectionReady || localPath.trim().length > 0
      : newRepository === "github"
        ? Boolean(selectedConnectionId) && Boolean(repositoryName.trim())
        : true;
  const canCreate =
    !creating &&
    (name.trim().length > 0 || startingPoint === "existing") &&
    (description.trim().length > 0 || startingPoint === "existing") &&
    (!sourceRequired || sourceReady);

  return (
    <div className="app-shell">
      <header className="topbar">
        <Brand />
        <div className="header-actions">
          <Button variant="ghost" className="btn-small" onClick={onOpenAccount}>
            Settings
          </Button>
          {user?.role === "admin" ? (
            <Button variant="ghost" className="btn-small" onClick={onOpenAdmin}>
              Admin
            </Button>
          ) : null}
          <Button variant="ghost" className="btn-small" onClick={onSignOut}>
            Sign out
          </Button>
        </div>
      </header>
      <ProjectTabs projects={openProjects} onSelect={onOpenProject} onClose={onCloseProject} />
      <main className="page project-dashboard">
        <div className="dashboard-hero">
          <div>
            <div className="eyebrow">Project dashboard</div>
            <h1>Your projects</h1>
            <p>
              See what is moving, reopen active work, or bring another project into your workspace.
            </p>
          </div>
          <div className="dashboard-actions">
            <Button variant="primary" onClick={() => setDialog(true)}>
              + New project
            </Button>
          </div>
        </div>
        {error ? <Alert testId="projects-error">{error}</Alert> : null}
        {attention ? (
          <section className="attention-center" aria-labelledby="attention-heading">
            <div className="section-head">
              <div>
                <div className="eyebrow">Executive operations</div>
                <h2 id="attention-heading">What needs your attention?</h2>
              </div>
              <span className="muted" aria-live="polite">
                Updated{" "}
                {new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(
                  new Date(attention.generated_at),
                )}
              </span>
            </div>
            <div className="attention-summary" aria-label="Portfolio attention summary">
              <div className={attention.counts.critical ? "is-critical" : ""}>
                <strong>{attention.counts.critical}</strong>
                <span>Critical</span>
              </div>
              <div>
                <strong>{attention.counts.decisions}</strong>
                <span>Decisions</span>
              </div>
              <div>
                <strong>{attention.counts.approvals}</strong>
                <span>Approvals</span>
              </div>
              <div>
                <strong>{attention.counts.blockers}</strong>
                <span>Blockers</span>
              </div>
              <div>
                <strong>{attention.counts.active_runs}</strong>
                <span>Active runs</span>
              </div>
            </div>
            {attention.items.length ? (
              <div className="attention-list" data-testid="attention-list">
                {attention.items.map((item) => (
                  <article className={`attention-item severity-${item.severity}`} key={item.key}>
                    <div className="attention-item-main">
                      <div className="attention-item-labels">
                        <Badge
                          tone={
                            item.severity === "critical"
                              ? "danger"
                              : item.severity === "high"
                                ? "warn"
                                : "default"
                          }
                        >
                          {item.severity}
                        </Badge>
                        <span>{item.project_name}</span>
                        <span>·</span>
                        <span>{item.kind.replaceAll("_", " ")}</span>
                      </div>
                      <h3>{item.title}</h3>
                      <p>{item.summary}</p>
                      <details>
                        <summary>Why this needs judgment</summary>
                        <p>{item.explanation}</p>
                        <p>
                          <strong>Recommendation:</strong> {item.recommendation}
                        </p>
                        <p>
                          <strong>Impact:</strong> {item.impact}
                        </p>
                        <p>
                          <strong>Intended outcome:</strong> {item.resumes}
                        </p>
                        <p className="meta">
                          The decision is recorded immediately. Any task-state change or resumed
                          work occurs through a subsequent coordinator handoff.
                        </p>
                        {item.tradeoffs.length ? (
                          <ul>
                            {item.tradeoffs.map((tradeoff) => (
                              <li key={tradeoff}>{tradeoff}</li>
                            ))}
                          </ul>
                        ) : null}
                      </details>
                      {item.decision ? (
                        <AttentionDecisionForm
                          item={{ ...item, decision: item.decision }}
                          busy={attentionBusy === item.key}
                          onResolve={(input) => resolveDecision(item, input)}
                        />
                      ) : item.kind === "decision" ? (
                        <Alert>
                          Open the project to inspect the affected task. This decision cannot be
                          cleared by acknowledging the notification.
                        </Alert>
                      ) : null}
                    </div>
                    <div className="attention-actions">
                      <Button
                        variant="primary"
                        className="btn-small"
                        onClick={() => {
                          const project = projects?.find(
                            (candidate) => candidate.id === item.project_id,
                          );
                          if (project) {
                            onOpenProject({
                              ...project,
                              ...(item.phase_id ? { focus_phase_id: item.phase_id } : {}),
                              ...(item.task_id ? { focus_task_id: item.task_id } : {}),
                            });
                          }
                        }}
                      >
                        Open project
                      </Button>
                      {item.kind !== "decision" ? (
                        <>
                          <Button
                            className="btn-small"
                            disabled={attentionBusy === item.key}
                            onClick={() => void dispositionAttention(item, "acknowledged")}
                          >
                            Acknowledge
                          </Button>
                          <Button
                            variant="ghost"
                            className="btn-small"
                            disabled={attentionBusy === item.key}
                            onClick={() => void dispositionAttention(item, "snoozed")}
                          >
                            Snooze 1h
                          </Button>
                        </>
                      ) : null}
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="attention-clear">
                <strong>No strategic intervention is waiting.</strong>
                <span>Active work will continue to update here.</span>
              </div>
            )}
            <div className="portfolio-health" aria-label="Portfolio health">
              {attention.projects.map((projectHealth) => (
                <div
                  className={`portfolio-health-row health-${projectHealth.health}`}
                  key={projectHealth.id}
                >
                  <span className="status-dot" />
                  <div>
                    <strong>{projectHealth.name}</strong>
                    <small>{projectHealth.current_phase ?? "No active phase"}</small>
                  </div>
                  <span>
                    {projectHealth.completed_tasks}/{projectHealth.total_tasks} tasks
                  </span>
                  <span>{projectHealth.active_runs} agents</span>
                  <span>{projectHealth.attention_count} attention</span>
                </div>
              ))}
            </div>
          </section>
        ) : null}
        <section className="project-stats" aria-label="Project overview">
          <div>
            <strong>{projects?.length ?? "—"}</strong>
            <span>Total projects</span>
          </div>
          <div>
            <strong>{planned}</strong>
            <span>Planned</span>
          </div>
          <div>
            <strong>{(projects?.length ?? 0) - planned}</strong>
            <span>Drafts</span>
          </div>
          <div>
            <strong>{openProjects.length}</strong>
            <span>Open now</span>
          </div>
        </section>
        <div className="project-toolbar">
          <div>
            <h2>All projects</h2>
            <span className="muted">Select a project to view its workspace and details.</span>
          </div>
          <Input
            aria-label="Search projects"
            placeholder="Search projects…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {projects === null ? (
          <Spinner label="Loading projects…" />
        ) : visible?.length === 0 ? (
          <div className="empty">
            <div>
              <div className="empty-icon">◇</div>
              <strong>{query ? "No matching projects" : "No projects yet"}</strong>
              <p>
                {query ? "Try a different search." : "Create your first project to begin planning."}
              </p>
            </div>
          </div>
        ) : (
          <div className="proj-stack" data-testid="project-list">
            {visible?.map((project) => {
              const resume = resumeById[project.id];
              const blockedPhase = resume?.phases.find((phase) => phase.blocked);
              const activePhase = resume?.phases.find((phase) => phase.status === "active");
              // Color coding (P1 dashboard spec): red = decision waiting/
              // blocked, green = executing, blue = plan ready (staffed but not
              // yet running), neutral = draft/no plan.
              const status: "red" | "green" | "blue" | "neutral" =
                (resume?.decisions_waiting ?? 0) > 0 || blockedPhase
                  ? "red"
                  : activePhase
                    ? "green"
                    : project.status === "planned" && (resume?.phases.length ?? 0) > 0
                      ? "blue"
                      : "neutral";
              const statusLabel =
                status === "red"
                  ? "Decision waiting"
                  : status === "green"
                    ? "On track"
                    : status === "blue"
                      ? "Plan ready"
                      : "Draft";
              return (
                <article
                  className={`card proj-row s-${status}`}
                  key={project.id}
                  data-testid="proj-row"
                >
                  <div className="pr-main">
                    <div className="pr-head">
                      <span className="monogram">{project.name.slice(0, 2).toUpperCase()}</span>
                      <div className="pr-titles">
                        <button
                          type="button"
                          className="pr-title-btn"
                          onClick={() => onOpenProject(project)}
                        >
                          {project.name}
                        </button>
                        <div className="desc">{project.description}</div>
                      </div>
                    </div>
                    <div className="pr-staffing">
                      <span className="role-lbl">Coordinator</span>
                      <span className="chip model-c">
                        {project.pm_model
                          ? (pmModelOption(project.pm_model)?.label ?? project.pm_model)
                          : `${project.pm_provider} default`}
                      </span>
                      <span className="role-lbl">Reviewer</span>
                      <span className="chip model-g">
                        {pmModelOption(DEFAULT_PM_MODEL[project.reviewer_provider])?.label ??
                          project.reviewer_provider}
                      </span>
                    </div>
                    {project.source_location ? (
                      <div className="project-source" title={project.source_location}>
                        <span>{project.source_type === "github" ? "GitHub" : "Local folder"}</span>
                        <strong>{project.source_location}</strong>
                      </div>
                    ) : null}
                    {resume?.phases.length ? (
                      <div className="pr-phases">
                        {resume.phases.map((phase, index) => (
                          <div
                            className={`pr-phase${phase.blocked ? " blocked" : ""}${
                              phase.status === "completed" ? " done" : ""
                            }${phase.status === "queued" || phase.status === "proposed" ? " queued" : ""}`}
                            key={phase.id}
                            data-testid="pr-phase"
                          >
                            <span className="pp-num">P{index + 1}</span>
                            <span className="pp-name">{phase.objective_summary}</span>
                            {phase.blocked ? (
                              <span className="pp-blocked">blocked — needs you</span>
                            ) : (
                              <span className="pp-bar">
                                <span className="track thin">
                                  <i style={{ width: `${phase.percent_complete}%` }} />
                                </span>
                                <span className="pp-pct">{phase.percent_complete}%</span>
                              </span>
                            )}
                            {!phase.blocked ? (
                              <span className="pp-eta">
                                <span className="lbl">ETA</span>
                                {formatEta(phase.eta_at)}
                              </span>
                            ) : null}
                            {/* FRONT DOOR P1 addition: per-phase navigation into
                             *  that phase's activity feed / decision thread —
                             *  opens the project workspace pre-focused on this
                             *  phase (GET .../phases/:phaseId/execution plus
                             *  phase-scoped attention items). */}
                            <button
                              type="button"
                              className="pp-open"
                              data-testid="pp-open"
                              onClick={(event) => {
                                event.stopPropagation();
                                onOpenProject({ ...project, focus_phase_id: phase.id });
                              }}
                            >
                              <span className="bubble">💬</span>{" "}
                              {phase.blocked ? "Answer →" : "Open →"}
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="pr-phases">
                        <div className="pr-phase queued no-plan">
                          <span className="pp-num">—</span>
                          <span className="pp-name muted">
                            No plan drafted yet — phases appear once the coordinator drafts one.
                          </span>
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="pr-side">
                    <Badge
                      tone={
                        status === "red"
                          ? "danger"
                          : status === "green"
                            ? "success"
                            : status === "blue"
                              ? "info"
                              : "default"
                      }
                    >
                      {statusLabel}
                    </Badge>
                    <div className="pr-agg">
                      <span className="big tnum">
                        {resume ? `${resume.overall_percent_complete}%` : "—"}
                      </span>
                      <span className="lbl">
                        overall
                        <br />
                        complete
                      </span>
                    </div>
                    <div className="pr-facts">
                      <div className="pr-fact">
                        <span className="k">Blended ETA</span>
                        <span className="v">{formatEtaDate(resume?.blended_eta_at)}</span>
                      </div>
                      <div className="pr-fact">
                        <span className="k">Agents active</span>
                        <span className="v">{resume?.agents_active ?? 0}</span>
                      </div>
                      <div className="pr-fact">
                        <span className="k">Decisions</span>
                        <span className={`v${(resume?.decisions_waiting ?? 0) > 0 ? " warn" : ""}`}>
                          {resume?.decisions_waiting
                            ? `${resume.decisions_waiting} waiting`
                            : "None"}
                        </span>
                      </div>
                    </div>
                    <button type="button" className="pr-cta" onClick={() => onOpenProject(project)}>
                      Open workspace →
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </main>

      {dialog ? (
        <main className="page wizard-page" aria-label="New project">
          <section className="wizard-shell card">
            <div className="section-head">
              <div>
                <div className="eyebrow">New project</div>
                <h2>Let's set the brief</h2>
                <p className="muted">
                  {wizardStep === "attach"
                    ? "Add reference screenshots, then start the plan."
                    : "Start fresh or bring an existing codebase into The Norns. Nothing runs until you approve the plan."}
                </p>
              </div>
              <Button variant="ghost" className="btn-small" onClick={closeWizard}>
                ×
              </Button>
            </div>
            {wizardStep === "attach" && draftProject ? (
              <div className="form-stack wizard-attach-step" data-testid="wizard-attach-step">
                <Alert>
                  <strong>{draftProject.name}</strong> was created. Attach reference screenshots
                  (optional), then start planning — Norns drafts a plan you'll review before any
                  agent starts.
                </Alert>
                <Field label="Objective">
                  <TextArea
                    data-testid="wizard-objective"
                    value={wizardObjective}
                    onChange={(e) => setWizardObjective(e.target.value)}
                  />
                </Field>
                <Field label="Attach screenshots">
                  <AttachmentInput
                    projectId={draftProject.id}
                    value={wizardAttachmentIds}
                    onChange={setWizardAttachmentIds}
                    purpose="objective"
                    disabled={planningStarting}
                  />
                </Field>
                <Field label="Plan review rounds">
                  <div className="rounds-stepper" data-testid="rounds-stepper">
                    <Button
                      type="button"
                      className="btn-small"
                      disabled={roundsCount <= 1}
                      onClick={() => setRoundsCount((n) => Math.max(1, n - 1))}
                      aria-label="Fewer rounds"
                    >
                      −
                    </Button>
                    <span className="rounds-value mono">{roundsCount}</span>
                    <Button
                      type="button"
                      className="btn-small"
                      disabled={roundsCount >= 5}
                      onClick={() => setRoundsCount((n) => Math.min(5, n + 1))}
                      aria-label="More rounds"
                    >
                      +
                    </Button>
                  </div>
                  <span className="field-help">
                    The coordinator and reviewer debate the plan up to this many rounds, then stop
                    early once they converge.
                  </span>
                </Field>
                {planningError ? <Alert testId="planning-run-error">{planningError}</Alert> : null}
                <div className="actions">
                  <Button variant="ghost" disabled={planningStarting} onClick={skipPlanning}>
                    Skip for now
                  </Button>
                  <Button
                    variant="primary"
                    disabled={planningStarting || !wizardObjective.trim()}
                    onClick={() => void startPlanningRun()}
                  >
                    {planningStarting ? "Starting planning run…" : "Start planning run →"}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="form-stack">
                <fieldset className="source-picker">
                  <legend>What are you starting with?</legend>
                  <div className="source-options">
                    <button
                      type="button"
                      className={startingPoint === "new" ? "is-selected" : ""}
                      onClick={() => {
                        localWorkspaceRequestEpoch.current += 1;
                        localBrowseRequestEpoch.current += 1;
                        localValidationRequestEpoch.current += 1;
                        setStartingPoint("new");
                        setSelectedRepositoryId("");
                        setExistingSource("github");
                        setSelectedLocalRunnerId("");
                        setSelectedLocalWorkspaceId("");
                        setLocalWorkspaces([]);
                        setLocalBrowser(null);
                        setLocalNavigation([]);
                        setLocalSelection(null);
                        setSelectedLocalEntryId(null);
                      }}
                    >
                      <strong>New project</strong>
                      <span>
                        Define a new objective and optionally create its GitHub repository.
                      </span>
                    </button>
                    <button
                      type="button"
                      className={startingPoint === "existing" ? "is-selected" : ""}
                      onClick={() => {
                        setStartingPoint("existing");
                        setNewRepository("none");
                      }}
                    >
                      <strong>Existing codebase</strong>
                      <span>
                        Select a connected repository and let The Norns establish its current state.
                      </span>
                    </button>
                  </div>
                </fieldset>

                {startingPoint === "new" ? (
                  <fieldset className="source-picker">
                    <legend>Repository</legend>
                    <div className="source-options">
                      <button
                        type="button"
                        className={newRepository === "none" ? "is-selected" : ""}
                        onClick={() => setNewRepository("none")}
                      >
                        <strong>Not yet</strong>
                        <span>Create the Norns project now and connect source code later.</span>
                      </button>
                      <button
                        type="button"
                        className={newRepository === "github" ? "is-selected" : ""}
                        onClick={() => setNewRepository("github")}
                      >
                        <strong>Create on GitHub</strong>
                        <span>
                          Create and bind a private or public repository through a workspace
                          connection.
                        </span>
                      </button>
                    </div>
                  </fieldset>
                ) : null}

                {startingPoint === "existing" ? (
                  <fieldset className="source-picker">
                    <legend>Where is the existing code?</legend>
                    <div className="source-options">
                      <button
                        type="button"
                        aria-pressed={existingSource === "github"}
                        className={existingSource === "github" ? "is-selected" : ""}
                        onClick={() => {
                          setExistingSource("github");
                          setLocalSelection(null);
                          setSelectedLocalEntryId(null);
                        }}
                      >
                        <strong>GitHub repository</strong>
                        <span>Select a repository from a workspace GitHub connection.</span>
                      </button>
                      <button
                        type="button"
                        aria-pressed={existingSource === "local"}
                        className={existingSource === "local" ? "is-selected" : ""}
                        onClick={() => {
                          setExistingSource("local");
                          setSelectedRepositoryId("");
                          setSelectedLocalEntryId(null);
                        }}
                      >
                        <strong>Local folder</strong>
                        <span>Choose a Git project folder with the native folder selector.</span>
                      </button>
                    </div>
                  </fieldset>
                ) : null}

                {sourceRequired && (startingPoint === "new" || existingSource === "github") ? (
                  <div className="repository-picker">
                    {sourceError ? <Alert>{sourceError}</Alert> : null}
                    {!githubStatus?.configured ? (
                      <div className="connection-required">
                        <div>
                          <strong>GitHub is not configured</strong>
                          <p>
                            Configure the Norns GitHub App in workspace Settings before selecting
                            repositories.
                          </p>
                        </div>
                        <Button
                          type="button"
                          variant="primary"
                          className="btn-small"
                          onClick={onOpenAccount}
                        >
                          Open Settings
                        </Button>
                      </div>
                    ) : connectedGitHub.length === 0 ? (
                      <div className="connection-required">
                        <div>
                          <strong>No GitHub installations available</strong>
                          <p>
                            {githubStatus.user_authorization.connected
                              ? "Add a personal account or organization in Settings."
                              : "Authorize GitHub in Settings, then add a personal account or organization."}
                          </p>
                        </div>
                        <Button type="button" className="btn-small" onClick={onOpenAccount}>
                          Manage connections
                        </Button>
                      </div>
                    ) : (
                      <>
                        <Field label="GitHub account or organization">
                          <Select
                            data-testid="github-connection"
                            value={selectedConnectionId}
                            onChange={(event) => {
                              setSelectedConnectionId(event.target.value);
                              setSelectedRepositoryId("");
                            }}
                          >
                            {connectedGitHub.map((connection: GitHubConnection) => (
                              <option key={connection.id} value={connection.id}>
                                {connection.owner_login} · {connection.owner_type}
                              </option>
                            ))}
                          </Select>
                        </Field>
                        {startingPoint === "new" ? (
                          <div className="repository-create-fields">
                            <Field label="Repository name">
                              <Input
                                data-testid="github-new-repository-name"
                                value={repositoryName}
                                onChange={(event) => setRepositoryName(event.target.value)}
                                placeholder="notifications-service"
                              />
                            </Field>
                            <Field label="Visibility">
                              <Select
                                value={repositoryPrivate ? "private" : "public"}
                                onChange={(event) =>
                                  setRepositoryPrivate(event.target.value === "private")
                                }
                              >
                                <option value="private">Private</option>
                                <option value="public">Public</option>
                              </Select>
                            </Field>
                            <p className="field-help">
                              The selected GitHub installation must allow repository administration
                              to create a repository.
                            </p>
                          </div>
                        ) : (
                          <>
                            <div className="repository-search">
                              <Input
                                aria-label="Search connected repositories"
                                value={repositoryQuery}
                                onChange={(event) => setRepositoryQuery(event.target.value)}
                                placeholder={`Search ${selectedConnection?.owner_login ?? "repositories"}…`}
                              />
                              <Button
                                type="button"
                                className="btn-small"
                                disabled={repositoryLoading}
                                onClick={() => void loadRepositories()}
                              >
                                Refresh
                              </Button>
                            </div>
                            {repositoryLoading ? (
                              <Spinner label="Loading repositories…" />
                            ) : visibleRepositories.length ? (
                              <div className="repository-list" aria-label="GitHub repositories">
                                {visibleRepositories.map((repository) => (
                                  <button
                                    type="button"
                                    aria-pressed={selectedRepositoryId === repository.id}
                                    disabled={repository.archived}
                                    className={
                                      selectedRepositoryId === repository.id ? "is-selected" : ""
                                    }
                                    key={repository.id}
                                    onClick={() => {
                                      setSelectedRepositoryId(repository.id);
                                      setName((current) => current || repository.name);
                                      setDescription(
                                        (current) =>
                                          current ||
                                          repository.description ||
                                          `Analyze and continue development of ${repository.full_name}`,
                                      );
                                    }}
                                  >
                                    <span>
                                      <strong>{repository.full_name}</strong>
                                      <small>
                                        {repository.description || "No repository description"}
                                      </small>
                                    </span>
                                    <span className="repository-meta">
                                      {repository.private ? "Private" : "Public"}
                                      {repository.language ? ` · ${repository.language}` : ""}
                                      {repository.archived ? " · Archived" : ""}
                                    </span>
                                  </button>
                                ))}
                              </div>
                            ) : (
                              <p className="muted">
                                No repositories match this connection and search.
                              </p>
                            )}
                            {selectedRepository ? (
                              <p className="policy">
                                <strong>{selectedRepository.full_name}</strong> will be validated
                                against the connected installation. Repository metadata is reviewed
                                immediately; code ingestion begins through an approved runner.
                              </p>
                            ) : null}
                          </>
                        )}
                      </>
                    )}
                  </div>
                ) : null}

                {startingPoint === "existing" && existingSource === "local" ? (
                  <div className="repository-picker local-folder-picker">
                    {sourceError ? <Alert>{sourceError}</Alert> : null}
                    {/* FRONT DOOR P2b (D2): folder-first — a plain path is the
                     *  primary local-folder flow and needs no runner online.
                     *  The project is created with an unverified binding
                     *  candidate; a runner only matters later, at execution. */}
                    <Field label="Local folder path">
                      <Input
                        data-testid="local-path-input"
                        value={localPath}
                        onChange={(event) => {
                          const value = event.target.value;
                          setLocalPath(value);
                          if (localSelection) {
                            // A path the human is now typing supersedes any
                            // earlier runner-verified selection.
                            localValidationRequestEpoch.current += 1;
                            setLocalSelection(null);
                            setSelectedLocalEntryId(null);
                          }
                        }}
                        placeholder="/Users/you/code/my-project"
                      />
                    </Field>
                    <p className="runner-note">
                      <span className="dot" /> A runner is only needed once execution starts —
                      planning and staffing work without it.
                    </p>
                    {localRunnersLoading ? (
                      <Spinner label="Looking for paired local runners…" />
                    ) : localRunners.length === 0 ? null : !localRunners.some(
                        (runner) => runner.workspace_picker_ready === true,
                      ) ? (
                      <div className="connection-required">
                        <div>
                          <strong>Local runner update required</strong>
                          <p>
                            Update and restart the connected local runner to enable secure folder
                            selection — or just use the path above.
                          </p>
                        </div>
                        <Button type="button" className="btn-small" onClick={onOpenAccount}>
                          Manage runners
                        </Button>
                      </div>
                    ) : !localRunners.some(
                        (runner) => runner.local_project_onboarding_ready === true,
                      ) ? (
                      <div className="connection-required">
                        <div>
                          <strong>Project storage activation required</strong>
                          <p>
                            Activate durable relational storage before browsing with a runner — or
                            just use the path above.
                          </p>
                        </div>
                      </div>
                    ) : (
                      <details className="local-runner-enhancement">
                        <summary>Browse with a paired runner instead</summary>
                        <div className="repository-search">
                          <Field label="Connected local runner">
                            <Select
                              data-testid="local-runner"
                              value={selectedLocalRunnerId}
                              onChange={(event) => {
                                localWorkspaceRequestEpoch.current += 1;
                                localBrowseRequestEpoch.current += 1;
                                localValidationRequestEpoch.current += 1;
                                setSelectedLocalRunnerId(event.target.value);
                                setSelectedLocalWorkspaceId("");
                                setLocalBrowser(null);
                                setLocalNavigation([]);
                                setLocalSelection(null);
                                setSelectedLocalEntryId(null);
                              }}
                            >
                              {localRunners
                                .filter((runner) => runner.workspace_picker_ready === true)
                                .filter((runner) => runner.local_project_onboarding_ready === true)
                                .map((runner) => (
                                  <option key={runner.runner_id} value={runner.runner_id}>
                                    {runner.runner_id}
                                  </option>
                                ))}
                            </Select>
                          </Field>
                          <Button
                            type="button"
                            className="btn-small"
                            disabled={localWorkspacesLoading}
                            onClick={() => void loadLocalWorkspaces()}
                          >
                            Refresh folders
                          </Button>
                        </div>

                        <div className="native-folder-choice">
                          <Button
                            type="button"
                            variant="primary"
                            disabled={!selectedLocalRunnerId || localChooserLoading}
                            onClick={() => void chooseLocalRepository()}
                          >
                            {localChooserLoading
                              ? "Waiting for folder selection…"
                              : "Choose project folder…"}
                          </Button>
                          <p className="muted">
                            Opens the folder selector on the runner computer. Choose the root of a
                            Git repository; its full path stays on that computer.
                          </p>
                        </div>

                        {localSelection ? (
                          <p className="policy" data-testid="local-selection-summary">
                            <strong>{localSelection.repository.repository_display_name}</strong> is
                            validated on the selected runner
                            {localSelection.repository.default_branch
                              ? ` · ${localSelection.repository.default_branch}`
                              : ""}
                            . The Norns stores only this safe repository metadata, never its path.
                          </p>
                        ) : localWorkspacesLoading ? (
                          <Spinner label="Loading approved folders…" />
                        ) : localWorkspaces.length === 0 ? (
                          <div className="connection-required">
                            <div>
                              <strong>Choose your project folder</strong>
                              <p>
                                The native selector above approves and validates the repository in
                                one step.
                              </p>
                            </div>
                          </div>
                        ) : !localBrowser ? (
                          <div className="repository-list" aria-label="Approved local folders">
                            {localWorkspaces.map((workspace) => (
                              <button
                                type="button"
                                key={workspace.workspace_id}
                                onClick={() =>
                                  void browseLocalWorkspace(workspace.workspace_id, undefined, [])
                                }
                              >
                                <span>
                                  <strong>{workspace.label}</strong>
                                  <small>Approved folder</small>
                                </span>
                                <span className="repository-meta">Browse →</span>
                              </button>
                            ))}
                          </div>
                        ) : (
                          <div
                            className="local-folder-browser"
                            aria-label="Approved local folder browser"
                          >
                            <div className="local-folder-browser-head">
                              <Button
                                type="button"
                                className="btn-small"
                                onClick={() => {
                                  setLocalBrowser(null);
                                  setSelectedLocalWorkspaceId("");
                                  setLocalNavigation([]);
                                  setLocalSelection(null);
                                  setSelectedLocalEntryId(null);
                                }}
                              >
                                Change folder
                              </Button>
                              <Button
                                type="button"
                                className="btn-small"
                                disabled={localBrowserLoading || localNavigation.length === 0}
                                onClick={() => {
                                  const nextNavigation = localNavigation.slice(0, -1);
                                  void browseLocalWorkspace(
                                    localBrowser.workspace_id,
                                    nextNavigation.at(-1),
                                    nextNavigation,
                                  );
                                }}
                              >
                                Back
                              </Button>
                              <div className="local-breadcrumb" aria-label="Folder location">
                                {(localBrowser.breadcrumb ?? []).join(" › ")}
                              </div>
                            </div>
                            {localBrowserLoading ? (
                              <Spinner label="Browsing approved folder…" />
                            ) : localBrowser.entries.length ? (
                              <div className="repository-list" aria-label="Local folder entries">
                                {localBrowser.entries.map((entry) => (
                                  <button
                                    type="button"
                                    key={entry.entry_id}
                                    disabled={
                                      localValidationLoading ||
                                      (!entry.can_browse && entry.kind === "folder")
                                    }
                                    className={
                                      selectedLocalEntryId === entry.entry_id ? "is-selected" : ""
                                    }
                                    onClick={() => {
                                      if (entry.kind === "repository") {
                                        void validateLocalRepository(entry.entry_id);
                                      } else {
                                        void browseLocalWorkspace(
                                          localBrowser.workspace_id,
                                          entry.entry_id,
                                          [...localNavigation, entry.entry_id],
                                        );
                                      }
                                    }}
                                  >
                                    <span>
                                      <strong>{entry.label}</strong>
                                      <small>
                                        {entry.kind === "repository"
                                          ? "Git repository · select to validate"
                                          : "Folder · browse"}
                                      </small>
                                    </span>
                                    <span className="repository-meta">
                                      {entry.kind === "repository" ? "Select" : "Browse →"}
                                    </span>
                                  </button>
                                ))}
                              </div>
                            ) : (
                              <p className="muted">
                                No folders or Git repositories are available here.
                              </p>
                            )}
                          </div>
                        )}
                      </details>
                    )}
                  </div>
                ) : null}

                <div className="project-create-grid">
                  <Field
                    label={
                      startingPoint === "existing" ? "Project name (optional)" : "Project name"
                    }
                  >
                    <Input
                      data-testid="project-name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder={
                        startingPoint === "existing"
                          ? "Defaults to repository name"
                          : "e.g. Notifications service"
                      }
                      autoFocus
                    />
                  </Field>
                  <Field
                    label={
                      startingPoint === "existing" ? "Initial direction (optional)" : "Objective"
                    }
                  >
                    <TextArea
                      data-testid="project-description"
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      placeholder={
                        startingPoint === "existing"
                          ? "What should The Norns focus on after understanding the repository?"
                          : "What should this project deliver?"
                      }
                    />
                  </Field>
                </div>

                <div className="two-col-fields">
                  <Field label="Coordinator model">
                    <Select
                      data-testid="pm-model"
                      value={pmModel}
                      aria-describedby="pm-model-description"
                      onChange={(e) => setPmModel(e.target.value as PmModelT)}
                    >
                      <optgroup label="Anthropic">
                        {PM_MODEL_OPTIONS.anthropic.map((model) => (
                          <option key={model.id} value={model.id}>
                            {model.label}
                          </option>
                        ))}
                      </optgroup>
                      <optgroup label="OpenAI">
                        {PM_MODEL_OPTIONS.openai.map((model) => (
                          <option key={model.id} value={model.id}>
                            {model.label}
                          </option>
                        ))}
                      </optgroup>
                    </Select>
                    <span className="field-help" id="pm-model-description">
                      {selectedModel?.description}
                    </span>
                  </Field>
                  <Field label="Reviewer model">
                    {/* FRONT DOOR P2b: wired to GET/PATCH/DELETE
                     *  .../planning-reviewer. "Automatic" leaves no override —
                     *  the server picks the opposite provider from whatever
                     *  the coordinator is. An explicit pick is PATCHed (or
                     *  DELETEd back to automatic) right after the project is
                     *  created, before any planning run starts. */}
                    <Select
                      data-testid="reviewer-model"
                      value={reviewerSelection}
                      onChange={(e) => setReviewerSelection(e.target.value)}
                    >
                      <option value="auto">
                        Automatic (cross-provider) · {reviewerPreviewLabel}
                      </option>
                      <optgroup label="Anthropic">
                        {PM_MODEL_OPTIONS.anthropic.map((model) => (
                          <option key={model.id} value={`anthropic:${model.id}`}>
                            {model.label}
                          </option>
                        ))}
                      </optgroup>
                      <optgroup label="OpenAI">
                        {PM_MODEL_OPTIONS.openai.map((model) => (
                          <option key={model.id} value={`openai:${model.id}`}>
                            {model.label}
                          </option>
                        ))}
                      </optgroup>
                    </Select>
                    <span className="field-help">
                      A second opinion. Automatic picks the opposite provider from the coordinator;
                      cross-provider review works best.
                    </span>
                  </Field>
                </div>
                {startingPoint === "new" ? (
                  <Field label="Plan review rounds">
                    <div className="rounds-stepper" data-testid="rounds-stepper">
                      <Button
                        type="button"
                        className="btn-small"
                        disabled={roundsCount <= 1}
                        onClick={() => setRoundsCount((n) => Math.max(1, n - 1))}
                        aria-label="Fewer rounds"
                      >
                        −
                      </Button>
                      <span className="rounds-value mono">{roundsCount}</span>
                      <Button
                        type="button"
                        className="btn-small"
                        disabled={roundsCount >= 5}
                        onClick={() => setRoundsCount((n) => Math.min(5, n + 1))}
                        aria-label="More rounds"
                      >
                        +
                      </Button>
                    </div>
                    <span className="field-help">
                      Coordinator and reviewer debate the plan up to this many rounds, then stop
                      early once they converge.
                    </span>
                  </Field>
                ) : null}
                <div className="policy">
                  <strong>Cross-provider review is on.</strong>
                  <br />
                  {selectedModel?.label} will lead planning.{" "}
                  {pmProvider === "anthropic" ? "OpenAI" : "Anthropic"} will independently review
                  the plan.
                </div>
                <Button variant="primary" disabled={!canCreate} onClick={() => void create()}>
                  {creating
                    ? newRepository === "github"
                      ? "Creating repository and project…"
                      : "Creating…"
                    : pendingLocalProject && localSelectionReady
                      ? "Retry repository binding"
                      : startingPoint === "new"
                        ? "Create & draft plan →"
                        : "Create and open project"}
                </Button>
              </div>
            )}
          </section>
        </main>
      ) : null}
    </div>
  );
}
