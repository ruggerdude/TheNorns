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
  type OnboardingResponse,
  type ProjectOnboardingScenario,
  buildOnboardingFields,
  describeBlocker,
  describeSetup,
  parseGitHubRepoRef,
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
  // O1: fields the onboarding endpoint's project record now carries
  // (workspace_location/remote_location describe where the code actually
  // lives; onboarding_scenario is "new_repo" | "existing_repo"). Optional —
  // older projects created before this endpoint existed won't have them.
  workspace_location?: string | null;
  remote_location?: string | null;
  onboarding_scenario?: ProjectOnboardingScenario | null;
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
  // O1: the resume payload's own plain-language summary (e.g. "Runs in
  // github.com/acme/app · Pushes to github.com/acme/app") — prefer this
  // over re-deriving the sentence client-side; it's only absent for
  // projects that predate the onboarding endpoint or haven't resumed yet.
  onboardingSummaryLine: string | null;
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

interface LocalHelperStatus {
  state: "connected" | "degraded" | "disconnected" | "not_installed";
  runner_id: string | null;
  message: string;
  install_command: string;
  install_command_windows: string;
}

interface LocalFolderSelection {
  selection_token: string;
  expires_at: string;
  repository: {
    runner_id: string;
    repository_id: string;
    repository_display_name: string;
    default_branch: string;
    observed_head: string;
  };
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
  // O1: the wizard's one question — "Is this new, or existing work?" — plus
  // GitHub connection/repository state. Execution runs in GitHub Actions
  // (never on the human's machine), so both answers resolve to a GitHub
  // repository; they differ only in whether Norns creates it (new_repo) or
  // the human picks one that already exists (existing_repo).
  const [startingPoint, setStartingPoint] = useState<"new" | "existing">("new");
  const [existingSource, setExistingSource] = useState<"github" | "local">("github");
  const scenario: ProjectOnboardingScenario =
    startingPoint === "new" ? "new_repo" : "existing_repo";
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
  const [repositoryName, setRepositoryName] = useState("");
  const [repositoryPrivate, setRepositoryPrivate] = useState(true);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [localHelper, setLocalHelper] = useState<LocalHelperStatus | null>(null);
  const [localInstallCommand, setLocalInstallCommand] = useState("");
  const [localSelection, setLocalSelection] = useState<LocalFolderSelection | null>(null);
  const [localBusy, setLocalBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [removingProjectId, setRemovingProjectId] = useState<string | null>(null);
  const [attention, setAttention] = useState<PortfolioAttentionDto | null>(null);
  const [attentionBusy, setAttentionBusy] = useState<string | null>(null);
  const [roundsCount, setRoundsCount] = useState(3);
  // FRONT DOOR P2b: reviewer selector. "auto" means no explicit override
  // (the server's automatic opposite-provider default); any other value is
  // "provider:model" as offered by MODEL_CHOICES below.
  const [reviewerSelection, setReviewerSelection] = useState("auto");
  // FRONT DOOR P1: after `create()` makes a brand-new project with an
  // objective, the wizard moves to a second in-place step — attach reference
  // screenshots (the real AttachmentInput, which needs a live project id),
  // then explicitly kick off the planning run. `wizardStep` gates which half
  // of the single wizard screen renders; `draftProject` is the project that
  // step operates on. "blocker" is a third step: the onboarding call
  // succeeded but came back with something like installation_not_ready —
  // shown before "attach"/navigating away so it isn't missed.
  const [wizardStep, setWizardStep] = useState<"form" | "blocker" | "attach">("form");
  const [draftProject, setDraftProject] = useState<ProjectSummary | null>(null);
  const [wizardAttachmentIds, setWizardAttachmentIds] = useState<string[]>([]);
  const [wizardObjective, setWizardObjective] = useState("");
  const [planningStarting, setPlanningStarting] = useState(false);
  const [planningError, setPlanningError] = useState<string | null>(null);
  // O1: onboarding blockers (e.g. installation_not_ready) surfaced after a
  // successful create — the project exists either way, this just needs the
  // human's attention before execution can actually run.
  const [onboardingBlockers, setOnboardingBlockers] = useState<string[]>([]);
  // O1: stable per-submit-attempt idempotency key — regenerated each time
  // the wizard opens (a genuinely new submission), NOT on every keystroke or
  // failed-attempt retry, so a double-click or a retried request replays the
  // same outcome instead of creating a second project/repository.
  const [idempotencyKey, setIdempotencyKey] = useState(() => globalThis.crypto.randomUUID());
  // Per-project phase/progress read model for the dashboard rows (P5's
  // tracking additions to GET .../resume). Best-effort: a project whose
  // resume call fails (404 for a brand-new draft, network error, etc.)
  // simply renders without phase lines rather than blocking the dashboard.
  const [resumeById, setResumeById] = useState<Record<string, DashboardResumeSummary>>({});

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
            // O1: the resume payload's own plain-language onboarding summary.
            onboarding?: { summary_line?: string | null } | null;
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
            onboardingSummaryLine: resume.onboarding?.summary_line ?? null,
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
    if (dialog && scenario === "existing_repo" && selectedConnectionId) {
      void loadRepositories();
    }
  }, [dialog, loadRepositories, scenario, selectedConnectionId]);

  /** Run the existing GitHub authorize/install flow inline, right from the
   *  wizard — "never make the user hunt through settings mid-setup". Mirrors
   *  Account.tsx's openGitHubFlow exactly (same endpoints, same redirect),
   *  just triggered from here instead of the Settings modal. Both scenarios
   *  need a GitHub connection now, so this is first-class in the wizard, not
   *  a secondary path. */
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

  const refreshLocalHelper = useCallback(async () => {
    try {
      const status = await request<LocalHelperStatus>("/api/runners/helper/status");
      setLocalHelper(status);
      if (status.state === "connected") setLocalInstallCommand("");
    } catch (error) {
      if (error instanceof UnauthorizedError) onUnauthorized();
      else setSourceError(error instanceof Error ? error.message : String(error));
    }
  }, [onUnauthorized]);

  useEffect(() => {
    if (!dialog || startingPoint !== "existing" || existingSource !== "local") return;
    void refreshLocalHelper();
    const timer = window.setInterval(() => void refreshLocalHelper(), 2_000);
    return () => window.clearInterval(timer);
  }, [dialog, existingSource, refreshLocalHelper, startingPoint]);

  const prepareLocalHelper = useCallback(async () => {
    setLocalBusy(true);
    setSourceError(null);
    try {
      const setup = await request<{ install_command: string }>("/api/pairing/start", {});
      setLocalInstallCommand(setup.install_command);
    } catch (error) {
      if (error instanceof UnauthorizedError) onUnauthorized();
      else setSourceError(error instanceof Error ? error.message : String(error));
    } finally {
      setLocalBusy(false);
    }
  }, [onUnauthorized]);

  const chooseLocalFolder = useCallback(async () => {
    if (!localHelper?.runner_id) return;
    setLocalBusy(true);
    setSourceError(null);
    try {
      const selection = await request<LocalFolderSelection | { cancelled: true }>(
        `/api/runners/${encodeURIComponent(localHelper.runner_id)}/workspaces/choose`,
        {},
      );
      if ("cancelled" in selection) return;
      setLocalSelection(selection);
      setName((current) => current || selection.repository.repository_display_name);
      setDescription(
        (current) =>
          current ||
          `Analyze and continue development of ${selection.repository.repository_display_name}`,
      );
    } catch (error) {
      if (error instanceof UnauthorizedError) onUnauthorized();
      else setSourceError(error instanceof Error ? error.message : String(error));
    } finally {
      setLocalBusy(false);
    }
  }, [localHelper, onUnauthorized]);

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

  const removeProject = useCallback(
    async (project: ProjectSummary) => {
      const confirmed = window.confirm(
        `Remove "${project.name}" from the dashboard?\n\nThis archives the project but does not delete its GitHub repository or historical records. Projects with active work cannot be removed.`,
      );
      if (!confirmed) return;

      setRemovingProjectId(project.id);
      setError(null);
      try {
        await requestVerb(`/api/projects/${project.id}`, "DELETE");
        setProjects(
          (current) => current?.filter((candidate) => candidate.id !== project.id) ?? null,
        );
        setResumeById((current) => {
          const next = { ...current };
          Reflect.deleteProperty(next, project.id);
          return next;
        });
        onCloseProject(project.id);
        void refreshAttention();
      } catch (error) {
        error instanceof UnauthorizedError
          ? onUnauthorized()
          : setError(error instanceof Error ? error.message : String(error));
      } finally {
        setRemovingProjectId(null);
      }
    },
    [onCloseProject, onUnauthorized, refreshAttention],
  );

  // FRONT DOOR P1: a brand-new project with an objective moves to the
  // wizard's attach-and-launch step instead of navigating away — the
  // objective becomes the planning run's brief once the human confirms
  // (optionally after attaching reference screenshots). "Existing work"
  // imports (no fresh objective to plan from) keep the original
  // immediate-navigate behavior. Shared by the direct success path and by
  // "Continue" on the onboarding-blockers step, so a blocker doesn't skip
  // this logic.
  const proceedAfterCreate = useCallback(
    (completedProject: ProjectSummary) => {
      setProjects((current) => (current ? [completedProject, ...current] : [completedProject]));
      if (startingPoint === "new" && description.trim()) {
        setDraftProject(completedProject);
        setWizardObjective(description.trim());
        setWizardAttachmentIds([]);
        setPlanningError(null);
        setWizardStep("attach");
        return;
      }
      setDialog(false);
      setWizardStep("form");
      setDraftProject(null);
      setOnboardingBlockers([]);
      setName("");
      setDescription("");
      setStartingPoint("new");
      setExistingSource("github");
      setSelectedRepositoryId("");
      setRepositoryName("");
      setRepositoryQuery("");
      setLocalSelection(null);
      setLocalInstallCommand("");
      setIdempotencyKey(globalThis.crypto.randomUUID());
      onOpenProject(completedProject);
    },
    [startingPoint, description, onOpenProject],
  );

  const create = useCallback(async () => {
    setCreating(true);
    setError(null);
    setSourceError(null);
    try {
      if (startingPoint === "existing" && existingSource === "local") {
        if (!localSelection) {
          setSourceError("Choose a local Git repository first.");
          return;
        }
        const completedProject = await request<ProjectSummary>("/api/v2/projects/local", {
          name: name.trim() || localSelection.repository.repository_display_name,
          description:
            description.trim() ||
            `Analyze and continue development of ${localSelection.repository.repository_display_name}`,
          pm_provider: pmProvider,
          pm_model: pmModel,
          selection_token: localSelection.selection_token,
          verification_policy_ref: "verification",
        });
        try {
          if (reviewerSelection !== "auto") {
            const [reviewerProviderChoice, ...modelParts] = reviewerSelection.split(":");
            await requestVerb(
              `/api/v2/projects/${completedProject.id}/planning-reviewer`,
              "PATCH",
              {
                provider: reviewerProviderChoice,
                model: modelParts.join(":"),
              },
            );
          } else {
            await requestVerb(
              `/api/v2/projects/${completedProject.id}/planning-reviewer`,
              "DELETE",
            );
          }
        } catch {
          // The automatic opposite-provider reviewer remains active.
        }
        proceedAfterCreate(completedProject);
        return;
      }
      const repository = repositories.find((candidate) => candidate.id === selectedRepositoryId);
      if (scenario === "new_repo" && !selectedConnectionId) {
        setSourceError("Choose a GitHub account or organization to create the repository under.");
        return;
      }
      if (scenario === "existing_repo" && !repository) {
        setSourceError("Select a GitHub repository to continue.");
        return;
      }
      const onboardingFields = buildOnboardingFields({
        scenario,
        newRepo:
          scenario === "new_repo"
            ? {
                connectionId: selectedConnectionId,
                repositoryName: repositoryName.trim(),
                private: repositoryPrivate,
              }
            : undefined,
        existingRepo:
          scenario === "existing_repo" && repository
            ? {
                connectionId: repository.connection_id,
                repositoryId: repository.id,
                fullName: repository.full_name,
              }
            : undefined,
      });
      const projectName =
        name.trim() || repository?.name || repositoryName.trim() || "Untitled project";
      const projectDescription =
        description.trim() ||
        repository?.description ||
        (repository
          ? `Analyze and continue development of ${repository.full_name}`
          : "New project");
      const onboarding = await request<OnboardingResponse>("/api/v2/projects/onboarding", {
        name: projectName,
        description: projectDescription,
        pm_provider: pmProvider,
        pm_model: pmModel,
        idempotency_key: idempotencyKey,
        ...onboardingFields,
      });
      // The onboarding response is a lean summary (project_id, scenario,
      // replayed, workspace/remote/push, blockers) — not the full project
      // record the rest of the app expects, so fetch that separately
      // through the existing GET /api/projects/:id route.
      const completedProject = await request<ProjectSummary>(
        `/api/projects/${onboarding.project_id}`,
      );
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
      if (onboarding.blockers.length > 0) {
        // The project exists either way — a blocker (e.g.
        // installation_not_ready) means execution can't actually run yet,
        // not that creation failed. Surface it plainly and require an
        // explicit "Continue" before moving on, so it isn't missed.
        setOnboardingBlockers(onboarding.blockers);
        setDraftProject(completedProject);
        setWizardStep("blocker");
        return;
      }
      proceedAfterCreate(completedProject);
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
    scenario,
    startingPoint,
    existingSource,
    localSelection,
    selectedConnectionId,
    repositoryName,
    repositoryPrivate,
    reviewerSelection,
    idempotencyKey,
    proceedAfterCreate,
    onUnauthorized,
  ]);

  /** The "blocker" step's Continue action — the project already exists;
   *  this just resumes the normal post-creation flow (attach-and-launch for
   *  a fresh objective, or straight into the workspace). */
  const continueFromBlockers = useCallback(() => {
    if (!draftProject) return;
    const project = draftProject;
    setOnboardingBlockers([]);
    setWizardStep("form");
    proceedAfterCreate(project);
  }, [draftProject, proceedAfterCreate]);

  const closeWizard = useCallback(() => {
    setDialog(false);
    setWizardStep("form");
    setDraftProject(null);
    setWizardAttachmentIds([]);
    setWizardObjective("");
    setPlanningError(null);
    setOnboardingBlockers([]);
    setName("");
    setDescription("");
    setStartingPoint("new");
    setExistingSource("github");
    setSelectedRepositoryId("");
    setRepositoryName("");
    setRepositoryQuery("");
    setLocalSelection(null);
    setLocalInstallCommand("");
    setReviewerSelection("auto");
    setRoundsCount(3);
    setIdempotencyKey(globalThis.crypto.randomUUID());
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
  // The searchable list also accepts a pasted repo URL as a shortcut —
  // parsed and matched against the loaded list's full_name.
  const parsedRepositoryQuery = parseGitHubRepoRef(repositoryQuery);
  const visibleRepositories = repositories.filter((repository) => {
    const trimmedQuery = repositoryQuery.trim().toLowerCase();
    if (!trimmedQuery) return true;
    if (repository.full_name.toLowerCase().includes(trimmedQuery)) return true;
    return parsedRepositoryQuery
      ? repository.full_name.toLowerCase() ===
          `${parsedRepositoryQuery.owner}/${parsedRepositoryQuery.name}`.toLowerCase()
      : false;
  });
  const selectedRepository = repositories.find(
    (repository) => repository.id === selectedRepositoryId,
  );
  const githubConnected = connectedGitHub.length > 0;
  const isLocalExisting = startingPoint === "existing" && existingSource === "local";
  const sourceReady = isLocalExisting
    ? Boolean(localSelection)
    : scenario === "existing_repo"
      ? Boolean(selectedRepositoryId)
      : Boolean(selectedConnectionId) && Boolean(repositoryName.trim());
  const canCreate =
    !creating &&
    (isLocalExisting || githubConnected) &&
    (name.trim().length > 0 || startingPoint === "existing") &&
    (description.trim().length > 0 || startingPoint === "existing") &&
    sourceReady;
  // The confirmation step's one honest passage about where the human's code
  // actually lives (GitHub Actions, not their computer) — null repository
  // name means "not resolved yet", which describeSetup renders as a prompt.
  const confirmationRepositoryFullName = isLocalExisting
    ? null
    : scenario === "existing_repo"
      ? (selectedRepository?.full_name ?? null)
      : selectedConnection && repositoryName.trim()
        ? `${selectedConnection.owner_login}/${repositoryName.trim()}`
        : null;
  const confirmationText = isLocalExisting
    ? localSelection
      ? `The helper will work only inside ${localSelection.repository.repository_display_name}; its filesystem path stays on this computer.`
      : "Choose a local Git repository with the system folder picker."
    : describeSetup(confirmationRepositoryFullName);

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
            <Button
              variant="primary"
              onClick={() => {
                setIdempotencyKey(globalThis.crypto.randomUUID());
                setDialog(true);
              }}
            >
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
                  <a
                    className="pr-row-enter"
                    href={`#project-${encodeURIComponent(project.id)}`}
                    aria-label={`Enter ${project.name}`}
                    onClick={(event) => {
                      event.preventDefault();
                      onOpenProject(project);
                    }}
                  >
                    <span className="sr-only">Enter {project.name}</span>
                  </a>
                  <div className="pr-main">
                    <div className="pr-head">
                      <span className="monogram">{project.name.slice(0, 2).toUpperCase()}</span>
                      <div className="pr-titles">
                        <button
                          type="button"
                          className="pr-title-btn"
                          id={`project-title-${project.id}`}
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
                    {/* O1: prefer the resume payload's own plain-language
                     *  onboarding summary over re-deriving it client-side;
                     *  fall back to the legacy source_location display for
                     *  projects that predate the onboarding endpoint. */}
                    {resume?.onboardingSummaryLine ? (
                      <div className="project-source" title={resume.onboardingSummaryLine}>
                        <span>GitHub</span>
                        <strong>{resume.onboardingSummaryLine}</strong>
                      </div>
                    ) : project.source_location ? (
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
                    <div className="pr-actions">
                      <button
                        type="button"
                        className="pr-cta"
                        onClick={() => onOpenProject(project)}
                      >
                        Enter project →
                      </button>
                      <Button
                        type="button"
                        variant="ghost"
                        className="btn-small pr-remove"
                        aria-label="Remove project from dashboard"
                        aria-describedby={`project-title-${project.id}`}
                        disabled={removingProjectId === project.id}
                        onClick={() => void removeProject(project)}
                      >
                        {removingProjectId === project.id ? "Removing…" : "Remove"}
                      </Button>
                    </div>
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
                    : wizardStep === "blocker"
                      ? "One thing needs fixing before this project can run."
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
                <AttachmentInput
                  variant="composer"
                  label="Objective"
                  textAreaTestId="wizard-objective"
                  placeholder="Describe the project, paste a screenshot, or add a reference file…"
                  textValue={wizardObjective}
                  onTextChange={setWizardObjective}
                  projectId={draftProject.id}
                  value={wizardAttachmentIds}
                  onChange={setWizardAttachmentIds}
                  purpose="objective"
                  disabled={planningStarting}
                />
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
            ) : wizardStep === "blocker" && draftProject ? (
              <div className="form-stack" data-testid="wizard-blocker-step">
                <Alert testId="onboarding-blockers">
                  <strong>{draftProject.name}</strong> was created, but needs attention before it
                  can run:
                  <ul>
                    {onboardingBlockers.map((code) => (
                      <li key={code}>{describeBlocker(code)}</li>
                    ))}
                  </ul>
                </Alert>
                <div className="actions">
                  <Button variant="primary" onClick={continueFromBlockers}>
                    Continue →
                  </Button>
                </div>
              </div>
            ) : (
              <div className="form-stack">
                <fieldset className="source-picker">
                  <legend>Is this new, or existing work?</legend>
                  <div className="source-options">
                    <button
                      type="button"
                      className={startingPoint === "new" ? "is-selected" : ""}
                      onClick={() => {
                        setStartingPoint("new");
                        setSelectedRepositoryId("");
                      }}
                    >
                      <strong>New</strong>
                      <span>Norns creates a GitHub repository for it.</span>
                    </button>
                    <button
                      type="button"
                      className={startingPoint === "existing" ? "is-selected" : ""}
                      onClick={() => {
                        setStartingPoint("existing");
                        setRepositoryName("");
                      }}
                    >
                      <strong>Existing</strong>
                      <span>Choose a GitHub repository or a local folder.</span>
                    </button>
                  </div>
                </fieldset>

                {startingPoint === "existing" ? (
                  <fieldset className="source-picker">
                    <legend>Where is the existing code?</legend>
                    <div className="source-options">
                      <button
                        type="button"
                        className={existingSource === "github" ? "is-selected" : ""}
                        onClick={() => {
                          setExistingSource("github");
                          setLocalSelection(null);
                          setSourceError(null);
                        }}
                      >
                        <strong>GitHub repository</strong>
                        <span>Select from a connected account or organization.</span>
                      </button>
                      <button
                        type="button"
                        className={existingSource === "local" ? "is-selected" : ""}
                        onClick={() => {
                          setExistingSource("local");
                          setSelectedRepositoryId("");
                          setSourceError(null);
                        }}
                      >
                        <strong>Local folder</strong>
                        <span>Use this computer's secure system folder picker.</span>
                      </button>
                    </div>
                  </fieldset>
                ) : null}

                {isLocalExisting ? (
                  <div className="repository-picker local-folder-picker">
                    {sourceError ? <Alert>{sourceError}</Alert> : null}
                    {localHelper?.state === "connected" ? (
                      <div className="connection-required">
                        <div>
                          <strong>Local folder access is ready</strong>
                          <p>{localHelper.message}</p>
                          {localSelection ? (
                            <p data-testid="local-folder-selection">
                              Selected:{" "}
                              <strong>{localSelection.repository.repository_display_name}</strong>
                            </p>
                          ) : null}
                        </div>
                        <Button
                          type="button"
                          variant="primary"
                          disabled={localBusy}
                          onClick={() => void chooseLocalFolder()}
                        >
                          {localBusy
                            ? "Waiting for folder…"
                            : localSelection
                              ? "Choose a different folder"
                              : "Choose folder"}
                        </Button>
                      </div>
                    ) : (
                      <div className="connection-required local-helper-setup">
                        <div>
                          <strong>One-time local helper setup</strong>
                          <p>
                            {localHelper?.message ??
                              "Checking whether the local folder helper is available…"}
                          </p>
                        </div>
                        <Button
                          type="button"
                          variant="primary"
                          disabled={localBusy}
                          onClick={() => void prepareLocalHelper()}
                        >
                          {localBusy ? "Preparing…" : "Set up local folder access"}
                        </Button>
                        {localInstallCommand ? (
                          <div className="local-helper-command">
                            <code>{localInstallCommand}</code>
                            <Button
                              type="button"
                              className="btn-small"
                              onClick={() =>
                                void navigator.clipboard.writeText(localInstallCommand)
                              }
                            >
                              Copy setup command
                            </Button>
                            <small>
                              Paste this once in Terminal. This page will detect the helper
                              automatically; no runner or pairing code needs to be entered here.
                            </small>
                          </div>
                        ) : null}
                      </div>
                    )}
                  </div>
                ) : (
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
                    ) : !githubConnected ? (
                      <div className="connection-required">
                        <div>
                          <strong>Connect GitHub to continue</strong>
                          <p>
                            {githubStatus.user_authorization.connected
                              ? "Add a personal account or organization to create or select repositories."
                              : "Authorize GitHub, then add a personal account or organization."}
                          </p>
                        </div>
                        <Button
                          type="button"
                          variant="primary"
                          className="btn-small"
                          disabled={githubConnectBusy}
                          onClick={() => void connectGitHubInline()}
                        >
                          {githubConnectBusy ? "Connecting…" : "Connect GitHub"}
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
                        {scenario === "new_repo" ? (
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
                                placeholder={`Search ${selectedConnection?.owner_login ?? "repositories"} or paste a repo URL…`}
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
                          </>
                        )}
                      </>
                    )}
                  </div>
                )}

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
                {/* O1: the confirmation step's one honest passage about where
                 *  the human's code actually lives — a GitHub Actions job
                 *  inside the repository, never their own computer. */}
                <p className="setup-confirmation" data-testid="setup-confirmation">
                  {confirmationText}
                </p>
                <Button variant="primary" disabled={!canCreate} onClick={() => void create()}>
                  {creating
                    ? scenario === "new_repo"
                      ? "Creating repository and project…"
                      : "Creating…"
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
