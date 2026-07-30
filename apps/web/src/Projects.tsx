import {
  type CodexReasoningEffortT,
  DEFAULT_CODEX_REASONING_EFFORT,
  DEFAULT_PM_MODEL,
  PM_MODEL_OPTIONS,
  type PmModelT,
  pmModelOption,
  providerForPmModel,
} from "@norns/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GitHubConnection, GitHubIntegrationStatus, SettingsTab } from "./Account";
import { PortfolioMenu } from "./PortfolioMenu";
import { AuthenticatedHeaderActions } from "./UserMenu";
import { ApiError, type CurrentUser, UnauthorizedError, authHeaders } from "./auth";
import {
  DISABLED_LOCAL_EXECUTION_CAPABILITIES,
  loadLocalExecutionCapabilities,
} from "./localExecutionCapabilities";
import {
  type LocalRepositoryInventory,
  type LocalRepositorySelection,
  loadLocalRepositories,
} from "./localSources";
import {
  type OnboardingResponse,
  type ProjectOnboardingScenario,
  buildOnboardingFields,
  describeBlocker,
  describeSetup,
  parseGitHubRepoRef,
} from "./projectSourceRequest";
import { Alert, Badge, Brand, Button, Field, Input, Select, Spinner, TextArea } from "./ui";
import { useSingleFlightPolling } from "./useSingleFlightPolling";

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
  /** Transient entry hint for the streamlined planning-to-code journey.
   * Durable recovery is based on the persisted onboarding scenario and latest
   * planning run, so losing this browser-only hint on refresh is harmless. */
  entry_flow?: "adoption" | "new" | null;
}

export interface DerivedProjectIdentity {
  projectName: string;
  repositorySlug: string;
}

/** Turn the one required brief into a concise, editable project identity. */
export function deriveProjectIdentity(
  brief: string,
  explicitName = "",
  explicitRepositorySlug = "",
): DerivedProjectIdentity {
  const normalizedBrief = brief.trim().replace(/\s+/g, " ");
  const briefTitle = normalizedBrief
    .split(/[.!?](?:\s|$)/, 1)[0]
    ?.replace(
      /^(?:please\s+)?(?:build|create|make|develop|implement|design|launch|stand\s+up|set\s+up)\s+/i,
      "",
    )
    .replace(/^(?:a|an|the)\s+/i, "")
    .trim();
  const requestedName = explicitName.trim().replace(/\s+/g, " ");
  const rawName = requestedName || briefTitle || "New project";
  const shortened =
    rawName.length <= 64
      ? rawName
      : `${rawName
          .slice(0, 61)
          .replace(/\s+\S*$/, "")
          .trimEnd()}…`;
  const projectName = shortened.charAt(0).toUpperCase() + shortened.slice(1);
  const repositorySlug =
    (explicitRepositorySlug.trim() || projectName)
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[._-]+|[._-]+$/g, "")
      .slice(0, 100)
      .replace(/[._-]+$/g, "") || "new-project";
  return { projectName, repositorySlug };
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
  total_commits: number;
  last_commit_sha: string | null;
  last_commit_at: string | null;
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

export function isActionableAttention(item: Pick<AttentionItemDto, "kind" | "severity">): boolean {
  return item.kind !== "milestone";
}

/** DESIGN R2: auto-filled placeholder descriptions ("Continue development of
 *  X", the older "Analyze and continue development of X", or the bare
 *  "New project" default) are noise on the dashboard cards. Only genuinely
 *  human- or repository-authored descriptions render; the wizard also no
 *  longer generates these fillers at creation time. */
export function isFillerDescription(description: string | null | undefined): boolean {
  const trimmed = description?.trim() ?? "";
  if (!trimmed || trimmed === "New project") return true;
  return /^(?:analyze and )?continue development of /i.test(trimmed);
}

export function projectSourceLabel(project: ProjectSummary): string {
  if (project.source_type === "github") return "GitHub";
  if (project.source_type === "local") return "Local folder";
  if (
    project.remote_location ||
    project.source_location?.includes("github.com") ||
    project.source_location?.startsWith("git@")
  ) {
    return "GitHub";
  }
  if (project.workspace_location || project.source_location) return "Local folder";
  return "Connected source";
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

async function request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: authHeaders(body !== undefined),
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal,
  });
  if (res.status === 401) throw new UnauthorizedError();
  const json = (await res.json()) as T & { detail?: string; message?: string };
  if (!res.ok) {
    throw new ApiError(
      json.message ?? json.detail ?? `Request failed (${res.status}). Try again.`,
      res.status,
    );
  }
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
  const recoveryDecision =
    item.decision.options.some((option) => option.id === "retry") &&
    item.decision.options.some((option) => option.id === "cancel");

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
        {recoveryDecision
          ? "Retry starts a fresh fenced attempt. Cancel phase closes the phase and every unfinished task."
          : "Direction is recorded in project memory. Delivery to the selected agent remains pending until a coordinator context-assembly step consumes it; active runs are not interrupted."}
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
        {busy
          ? recoveryDecision
            ? "Applying recovery…"
            : "Recording decision…"
          : recoveryDecision && selectedOptionId === "retry"
            ? "Retry safely"
            : recoveryDecision && selectedOptionId === "cancel"
              ? "Cancel phase"
              : "Resolve decision"}
      </Button>
    </section>
  );
}

export function Projects({
  onOpenProject,
  onUnauthorized,
  onSignOut,
  user,
  onOpenAccount,
  onOpenAdmin,
  onOpenUsage,
}: {
  onOpenProject: (p: ProjectSummary) => void;
  openProjects: ProjectSummary[];
  onUnauthorized: () => void;
  onSignOut: () => void;
  user: CurrentUser | null;
  onOpenAccount: (tab?: SettingsTab) => void;
  onOpenAdmin: () => void;
  onOpenUsage?: () => void;
}): React.ReactElement {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState(false);
  // DESIGN P1 bug fix: the New Project view is a full page swapped in-place,
  // so the document keeps whatever scroll offset the dashboard had (and the
  // objective textarea's old autoFocus used to yank it further down). Land at
  // the top like a real page navigation.
  useEffect(() => {
    if (dialog) window.scrollTo(0, 0);
  }, [dialog]);
  // Starting point and source are independent. New work can create a GitHub
  // repository or use an already-initialized local Git repository approved in
  // Connections; Existing work can adopt either source.
  const [startingPoint, setStartingPoint] = useState<"new" | "existing">("new");
  const [sourceKind, setSourceKind] = useState<"github" | "local">("github");
  const [executionLocation, setExecutionLocation] = useState<"github_actions" | "local">(
    "github_actions",
  );
  const scenario: ProjectOnboardingScenario =
    startingPoint === "new" ? "new_repo" : "existing_repo";
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [pmModel, setPmModel] = useState<PmModelT>(DEFAULT_PM_MODEL.anthropic);
  const [pmEffort, setPmEffort] = useState<CodexReasoningEffortT>(DEFAULT_CODEX_REASONING_EFFORT);
  const pmProvider = providerForPmModel(pmModel);
  const selectedModel = pmModelOption(pmModel);
  const reviewerProviderPreview = pmProvider === "anthropic" ? "openai" : "anthropic";
  const reviewerPreviewLabel =
    pmModelOption(DEFAULT_PM_MODEL[reviewerProviderPreview])?.label ?? reviewerProviderPreview;
  const [githubStatus, setGitHubStatus] = useState<GitHubIntegrationStatus | null>(null);
  const [selectedConnectionId, setSelectedConnectionId] = useState("");
  const [repositories, setRepositories] = useState<GitHubRepository[]>([]);
  const [selectedRepositoryId, setSelectedRepositoryId] = useState("");
  const [repositoryQuery, setRepositoryQuery] = useState("");
  const [repositoryLoading, setRepositoryLoading] = useState(false);
  const repositoryRequestEpoch = useRef(0);
  const [repositoryName, setRepositoryName] = useState("");
  const [repositoryPrivate, setRepositoryPrivate] = useState(true);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [githubSetupBusy, setGitHubSetupBusy] = useState(false);
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const [localSources, setLocalSources] = useState<LocalRepositoryInventory | null>(null);
  const [localSourcesError, setLocalSourcesError] = useState<string | null>(null);
  const [localSelection, setLocalSelection] = useState<LocalRepositorySelection | null>(null);
  const [localExecutionCapabilities, setLocalExecutionCapabilities] = useState(
    DISABLED_LOCAL_EXECUTION_CAPABILITIES,
  );
  const [creating, setCreating] = useState(false);
  const [attention, setAttention] = useState<PortfolioAttentionDto | null>(null);
  const [attentionBusy, setAttentionBusy] = useState<string | null>(null);
  const [resumePollIssue, setResumePollIssue] = useState<string | null>(null);
  const [roundsCount, setRoundsCount] = useState(3);
  // FRONT DOOR P2b: reviewer selector. "auto" means no explicit override
  // (the server's automatic opposite-provider default); any other value is
  // "provider:model" as offered by MODEL_CHOICES below.
  const [reviewerSelection, setReviewerSelection] = useState("auto");
  // DESIGN R2 semantic change: the wizard's single submit creates the
  // repository/project and opens it — planning now begins in the conversation
  // after creation, so there is no wizard planning kickoff or attachment
  // upload step anymore. "blocker" means creation succeeded but repository
  // activation needs human attention before the continuation can run.
  const [wizardStep, setWizardStep] = useState<"form" | "blocker" | "adopting">("form");
  const [draftProject, setDraftProject] = useState<ProjectSummary | null>(null);
  const [wizardObjective, setWizardObjective] = useState("");
  const [adoptionStage, setAdoptionStage] = useState<"analyzing" | "planning">("analyzing");
  const [adoptionError, setAdoptionError] = useState<string | null>(null);
  // O1: onboarding blockers (e.g. installation_not_ready) surfaced after a
  // successful create — the project exists either way, this just needs the
  // human's attention before execution can actually run.
  const [onboardingBlockers, setOnboardingBlockers] = useState<string[]>([]);
  // O1: stable per-submit-attempt idempotency key — regenerated each time
  // the wizard opens (a genuinely new submission), NOT on every keystroke or
  // failed-attempt retry, so a double-click or a retried request replays the
  // same outcome instead of creating a second project/repository.
  const [idempotencyKey, setIdempotencyKey] = useState(() => globalThis.crypto.randomUUID());
  // DESIGN R2: the project name comes directly from the "Project name" field;
  // deriveProjectIdentity is used only for normalization and the repository
  // slug (with the optional slug override).
  const derivedIdentity = useMemo(
    () => deriveProjectIdentity("", name, repositoryName),
    [name, repositoryName],
  );
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
  const resumePolling = useSingleFlightPolling({
    enabled: Boolean(projects?.length),
    intervalMs: 15_000,
    maxBackoffMs: 120_000,
    resourceKey: projects?.map((project) => project.id).join("|") ?? "no-projects",
    load: async (signal) => {
      const projectList = projects ?? [];
      const settled = await Promise.allSettled(
        projectList.map(async (project) => {
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
            delivery?: {
              total_commits: number;
              last_commit_sha: string | null;
              last_commit_at: string | null;
            };
            // O1: the resume payload's own plain-language onboarding summary.
            onboarding?: { summary_line?: string | null } | null;
          }>(`/api/v2/projects/${project.id}/resume`, undefined, signal);
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
            total_commits: resume.delivery?.total_commits ?? 0,
            last_commit_sha: resume.delivery?.last_commit_sha ?? null,
            last_commit_at: resume.delivery?.last_commit_at ?? null,
            onboardingSummaryLine: resume.onboarding?.summary_line ?? null,
          };
          return [project.id, summary] as const;
        }),
      );
      return { projectList, settled };
    },
    onSuccess: ({ projectList, settled }) => {
      const failed = settled.filter((outcome) => outcome.status === "rejected").length;
      setResumeById((current) => {
        const next: Record<string, DashboardResumeSummary> = {};
        for (let index = 0; index < settled.length; index += 1) {
          const outcome = settled[index];
          const project = projectList[index];
          if (!outcome || !project) continue;
          if (outcome.status === "fulfilled") {
            next[outcome.value[0]] = outcome.value[1];
          } else {
            const previous = current[project.id];
            if (previous) next[project.id] = previous;
          }
        }
        return next;
      });
      setResumePollIssue(
        failed > 0
          ? `${failed} project update${failed === 1 ? "" : "s"} failed; showing last known progress.`
          : null,
      );
    },
    onError: (pollError) => {
      if (pollError instanceof UnauthorizedError) onUnauthorized();
    },
  });

  useEffect(() => {
    if (projects?.length === 0) {
      setResumeById({});
      setResumePollIssue(null);
    }
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

  useEffect(() => {
    let current = true;
    void loadLocalExecutionCapabilities()
      .then((capabilities) => {
        if (!current) return;
        setLocalExecutionCapabilities(capabilities);
        if (!capabilities.legacy_local_creation_available) {
          setSourceKind("github");
          setExecutionLocation("github_actions");
          setLocalSelection(null);
          setLocalSources(null);
          setLocalSourcesError(null);
        }
      })
      .catch((error: unknown) => {
        if (!current) return;
        if (error instanceof UnauthorizedError) onUnauthorized();
        else setLocalExecutionCapabilities(DISABLED_LOCAL_EXECUTION_CAPABILITIES);
      });
    return () => {
      current = false;
    };
  }, [onUnauthorized]);

  const continueGitHubSetup = useCallback(async (): Promise<void> => {
    if (!githubStatus?.configured) {
      onOpenAccount("connections");
      return;
    }
    setGitHubSetupBusy(true);
    setSourceError(null);
    try {
      const response = await request<{ authorization_url: string } | { installation_url: string }>(
        githubStatus.user_authorization.connected
          ? "/api/integrations/github/install"
          : "/api/integrations/github/authorize?next=install",
      );
      const url =
        "authorization_url" in response ? response.authorization_url : response.installation_url;
      window.location.assign(url);
    } catch (error) {
      if (error instanceof UnauthorizedError) onUnauthorized();
      else setSourceError(error instanceof Error ? error.message : String(error));
      setGitHubSetupBusy(false);
    }
  }, [githubStatus, onOpenAccount, onUnauthorized]);

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

  useSingleFlightPolling({
    enabled:
      dialog &&
      localExecutionCapabilities.legacy_local_creation_available &&
      (sourceKind === "local" ||
        (startingPoint === "new" && sourceKind === "github" && executionLocation === "local")),
    intervalMs: 4_000,
    maxBackoffMs: 60_000,
    resourceKey: "local-sources",
    load: () => loadLocalRepositories(),
    onSuccess: (inventory) => {
      setLocalSourcesError(null);
      setLocalSources(inventory);
      setLocalSelection((current) =>
        current
          ? (inventory.repositories.find(
              (selection) =>
                selection.repository.repository_id === current.repository.repository_id,
            ) ?? null)
          : null,
      );
    },
    onError: (pollError) => {
      if (pollError instanceof UnauthorizedError) onUnauthorized();
      else setLocalSourcesError(pollError.message);
    },
  });

  const attentionPolling = useSingleFlightPolling({
    intervalMs: 10_000,
    maxBackoffMs: 120_000,
    resourceKey: "portfolio-attention",
    load: async (signal) => {
      try {
        return await request<PortfolioAttentionDto>("/api/v2/attention", undefined, signal);
      } catch (pollError) {
        if (pollError instanceof ApiError && pollError.status === 404) return null;
        throw pollError;
      }
    },
    onSuccess: setAttention,
    onError: (pollError) => {
      if (pollError instanceof UnauthorizedError) onUnauthorized();
    },
  });
  const refreshAttention = attentionPolling.refresh;

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
          `/api/v2/projects/${item.project_id}/decision-points/${encodeURIComponent(decision.decision_point_id)}/resolve`,
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
          const body = (await response.json().catch(() => ({}))) as {
            message?: string;
            detail?: string;
          };
          throw new ApiError(
            body.message ??
              body.detail ??
              "Decision changed; review the latest options and try again",
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

  // Close the front door around a project that is ready to open. Creation is
  // inserted into the dashboard earlier so a later planning failure never
  // makes the durable project disappear from the browser.
  const proceedAfterCreate = useCallback(
    (completedProject: ProjectSummary) => {
      setProjects((current) =>
        current?.some((project) => project.id === completedProject.id)
          ? current
          : current
            ? [completedProject, ...current]
            : [completedProject],
      );
      setDialog(false);
      setWizardStep("form");
      setDraftProject(null);
      setWizardObjective("");
      setOnboardingBlockers([]);
      setName("");
      setDescription("");
      setStartingPoint("new");
      setSourceKind("github");
      setSelectedRepositoryId("");
      setRepositoryName("");
      setRepositoryQuery("");
      setLocalSelection(null);
      setLocalSources(null);
      setLocalSourcesError(null);
      setSubmissionError(null);
      setAdoptionError(null);
      setIdempotencyKey(globalThis.crypto.randomUUID());
      onOpenProject(completedProject);
    },
    [onOpenProject],
  );

  const completeAdoption = useCallback(
    async (project: ProjectSummary, objective: string): Promise<void> => {
      setDraftProject(project);
      setWizardObjective(objective);
      setAdoptionError(null);
      setAdoptionStage("analyzing");
      setWizardStep("adopting");
      try {
        await request(`/api/v2/projects/${project.id}/analyze-repository`, {});
        if (objective) {
          setAdoptionStage("planning");
          const run = await request<{ planning_run_id: string }>(
            `/api/v2/projects/${project.id}/planning-runs`,
            {
              objective,
              max_rounds: 3,
              attachment_ids: [],
              pm: {
                provider: pmProvider,
                model: pmModel,
                ...(pmProvider === "openai" ? { reasoning_effort: pmEffort } : {}),
              },
            },
          );
          proceedAfterCreate({
            ...project,
            focus_planning_run_id: run.planning_run_id,
            entry_flow: "adoption",
          });
          return;
        }
        proceedAfterCreate(project);
      } catch (error) {
        if (error instanceof UnauthorizedError) onUnauthorized();
        else setAdoptionError(error instanceof Error ? error.message : String(error));
      }
    },
    [onUnauthorized, pmEffort, pmModel, pmProvider, proceedAfterCreate],
  );

  const applyReviewerPreference = useCallback(
    async (projectId: string): Promise<void> => {
      try {
        if (reviewerSelection !== "auto") {
          const [reviewerProviderChoice, ...modelParts] = reviewerSelection.split(":");
          await requestVerb(`/api/v2/projects/${projectId}/planning-reviewer`, "PATCH", {
            provider: reviewerProviderChoice,
            model: modelParts.join(":"),
          });
        } else {
          await requestVerb(`/api/v2/projects/${projectId}/planning-reviewer`, "DELETE");
        }
      } catch {
        // Best-effort: planning safely falls back to the account default.
      }
    },
    [reviewerSelection],
  );

  /** DESIGN R2: a new project opens straight into the workspace after
   *  creation — planning begins in the conversation there, so the wizard no
   *  longer starts a planning run or uploads objective attachments. The
   *  entry_flow flag is kept: App.tsx uses it to route the canonical
   *  planning journey. */
  const finishNewProject = useCallback(
    (project: ProjectSummary): void => {
      proceedAfterCreate({ ...project, entry_flow: "new" });
    },
    [proceedAfterCreate],
  );

  const prepareNewLocalProject = useCallback(
    async (project: ProjectSummary): Promise<void> => {
      setDraftProject(project);
      setAdoptionError(null);
      setAdoptionStage("analyzing");
      setWizardStep("adopting");
      try {
        await request(`/api/v2/projects/${project.id}/analyze-repository`, {});
        finishNewProject(project);
      } catch (error) {
        if (error instanceof UnauthorizedError) onUnauthorized();
        else setAdoptionError(error instanceof Error ? error.message : String(error));
      }
    },
    [finishNewProject, onUnauthorized],
  );

  const create = useCallback(async () => {
    setCreating(true);
    setError(null);
    setSourceError(null);
    setSubmissionError(null);
    try {
      if (sourceKind === "local") {
        if (!localExecutionCapabilities.legacy_local_creation_available) {
          setSourceError(
            "Creating projects from the legacy local helper is disabled. Choose a GitHub repository.",
          );
          return;
        }
        if (!localSelection) {
          setSourceError("Choose a local Git repository first.");
          return;
        }
        const isNewLocalProject = startingPoint === "new";
        // DESIGN R2: no auto-filled filler description — a new project's
        // description is empty at creation (planning happens in the
        // conversation); an adoption records only the human's optional
        // direction.
        const completedProject = await request<ProjectSummary>("/api/v2/projects/local", {
          name: isNewLocalProject
            ? derivedIdentity.projectName
            : localSelection.repository.repository_display_name,
          description: description.trim(),
          pm_provider: pmProvider,
          pm_model: pmModel,
          selection_token: localSelection.selection_token,
          verification_policy_ref: "verification",
        });
        if (isNewLocalProject) {
          await applyReviewerPreference(completedProject.id);
          await prepareNewLocalProject(completedProject);
          return;
        }
        await completeAdoption(completedProject, description.trim());
        return;
      }
      const repository = repositories.find((candidate) => candidate.id === selectedRepositoryId);
      if (
        scenario === "new_repo" &&
        executionLocation === "local" &&
        !localExecutionCapabilities.legacy_local_creation_available
      ) {
        setSourceError(
          "Creating a local working copy is disabled. Choose GitHub Actions for this project.",
        );
        return;
      }
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
                repositoryName: derivedIdentity.repositorySlug,
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
        startingPoint === "existing"
          ? (repository?.name ?? "Untitled project")
          : derivedIdentity.projectName;
      // DESIGN R2: no auto-filled filler description. New projects start with
      // an empty description (planning happens in the conversation after
      // creation); adoptions keep the human's optional direction or the
      // repository's own GitHub description.
      const projectDescription = description.trim() || repository?.description || "";
      const onboarding = await request<OnboardingResponse>("/api/v2/projects/onboarding", {
        name: projectName,
        description: projectDescription,
        pm_provider: pmProvider,
        pm_model: pmModel,
        idempotency_key: idempotencyKey,
        ...(scenario === "new_repo" ? { local_working_copy: executionLocation === "local" } : {}),
        ...onboardingFields,
      });
      // The onboarding response is a lean summary (project_id, scenario,
      // replayed, workspace/remote/push, blockers) — not the full project
      // record the rest of the app expects, so fetch that separately
      // through the existing GET /api/projects/:id route.
      const completedProject = await request<ProjectSummary>(
        `/api/projects/${onboarding.project_id}`,
      );
      setProjects((current) =>
        current?.some((project) => project.id === completedProject.id)
          ? current
          : current
            ? [completedProject, ...current]
            : [completedProject],
      );
      // Advanced reviewer selection changes planning behavior, so apply it
      // before either the normal continuation or a blocker recovery.
      if (startingPoint === "new") await applyReviewerPreference(completedProject.id);
      if (onboarding.blockers.length > 0) {
        setOnboardingBlockers(onboarding.blockers);
        setDraftProject(completedProject);
        setWizardObjective(description.trim());
        setWizardStep("blocker");
        return;
      }
      if (startingPoint === "existing") {
        await completeAdoption(completedProject, description.trim());
        return;
      }
      finishNewProject(completedProject);
    } catch (e) {
      e instanceof UnauthorizedError
        ? onUnauthorized()
        : setSubmissionError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }, [
    description,
    pmProvider,
    pmModel,
    repositories,
    selectedRepositoryId,
    scenario,
    startingPoint,
    sourceKind,
    executionLocation,
    localExecutionCapabilities.legacy_local_creation_available,
    localSelection,
    selectedConnectionId,
    derivedIdentity,
    repositoryPrivate,
    idempotencyKey,
    applyReviewerPreference,
    completeAdoption,
    finishNewProject,
    prepareNewLocalProject,
    onUnauthorized,
  ]);

  const retryAdoption = useCallback(() => {
    if (!draftProject) return;
    if (startingPoint === "new") {
      void prepareNewLocalProject(draftProject);
      return;
    }
    void completeAdoption(draftProject, wizardObjective);
  }, [completeAdoption, draftProject, prepareNewLocalProject, startingPoint, wizardObjective]);

  const openAdoptedProject = useCallback(() => {
    if (draftProject) proceedAfterCreate(draftProject);
  }, [draftProject, proceedAfterCreate]);

  /** The "blocker" step's Continue action — the project already exists;
   *  this just resumes the normal post-creation flow (attach-and-launch for
   *  a fresh objective, or straight into the workspace). */
  const continueFromBlockers = useCallback(() => {
    if (!draftProject) return;
    const project = draftProject;
    setOnboardingBlockers([]);
    setWizardStep("form");
    if (startingPoint === "new" && sourceKind === "github" && executionLocation === "local") {
      void create();
      return;
    }
    if (startingPoint === "existing") {
      void completeAdoption(project, wizardObjective);
      return;
    }
    finishNewProject(project);
  }, [
    completeAdoption,
    create,
    draftProject,
    executionLocation,
    finishNewProject,
    startingPoint,
    sourceKind,
    wizardObjective,
  ]);

  const closeWizard = useCallback(() => {
    setDialog(false);
    setWizardStep("form");
    setDraftProject(null);
    setWizardObjective("");
    setOnboardingBlockers([]);
    setName("");
    setDescription("");
    setStartingPoint("new");
    setSourceKind("github");
    setExecutionLocation("github_actions");
    setSelectedRepositoryId("");
    setRepositoryName("");
    setRepositoryQuery("");
    setLocalSelection(null);
    setLocalSources(null);
    setLocalSourcesError(null);
    setSubmissionError(null);
    setAdoptionError(null);
    setReviewerSelection("auto");
    setRoundsCount(3);
    setIdempotencyKey(globalThis.crypto.randomUUID());
  }, []);

  const visible = projects;
  const activeAgents =
    attention?.counts.active_runs ??
    Object.values(resumeById).reduce((sum, resume) => sum + resume.agents_active, 0);
  const actionableAttention = attention?.items.filter(isActionableAttention) ?? [];
  const blockedProjects =
    attention?.projects.filter((project) => project.health === "blocked").length ??
    Object.values(resumeById).filter((resume) => resume.phases.some((phase) => phase.blocked))
      .length;
  const hasStatusData =
    attention !== null ||
    Object.keys(resumeById).length > 0 ||
    (projects !== null && projects.length === 0);
  const portfolioState = !hasStatusData
    ? "Status unavailable"
    : actionableAttention.length > 0 ||
        (attention?.counts.approvals ?? 0) > 0 ||
        (attention?.counts.blockers ?? 0) > 0 ||
        blockedProjects > 0
      ? "Needs attention"
      : activeAgents > 0
        ? "Work in progress"
        : "Ready";
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
  const isLocalSource = sourceKind === "local";
  const legacyLocalCreationAvailable = localExecutionCapabilities.legacy_local_creation_available;
  const sourceReady = isLocalSource
    ? legacyLocalCreationAvailable && Boolean(localSelection)
    : scenario === "existing_repo"
      ? Boolean(selectedRepositoryId)
      : Boolean(selectedConnectionId);
  const localCloneReady =
    isLocalSource ||
    startingPoint !== "new" ||
    executionLocation !== "local" ||
    (legacyLocalCreationAvailable &&
      localSources?.state === "connected" &&
      localSources.workspace_clone_ready);
  const canCreate =
    !creating &&
    (isLocalSource || githubConnected) &&
    (name.trim().length > 0 || startingPoint === "existing") &&
    sourceReady &&
    localCloneReady;
  // The confirmation step's one honest passage about where the human's code
  // actually lives (GitHub Actions, not their computer) — null repository
  // name means "not resolved yet", which describeSetup renders as a prompt.
  const confirmationRepositoryFullName = isLocalSource
    ? null
    : scenario === "existing_repo"
      ? (selectedRepository?.full_name ?? null)
      : selectedConnection && name.trim()
        ? `${selectedConnection.owner_login}/${derivedIdentity.repositorySlug}`
        : null;
  const confirmationText = isLocalSource
    ? localSelection
      ? `Norns will not create a folder or initialize Git. It will work only inside the already-initialized, approved local Git repository ${localSelection.repository.repository_display_name}; its filesystem path stays on this computer.`
      : "Select an already-initialized local Git repository approved in Connections. Norns will not create a folder or initialize Git."
    : describeSetup(
        confirmationRepositoryFullName,
        startingPoint === "new" ? executionLocation : "github_actions",
      );

  return (
    <div className={dialog ? "full-page-view project-setup-view" : "app-shell"}>
      <header className="topbar" hidden={dialog}>
        <div className="topbar-main">
          <Brand
            onHome={() => {
              window.history.pushState(null, "", "/");
              window.scrollTo(0, 0);
            }}
          />
          <PortfolioMenu
            projects={projects}
            onOpenPortfolio={() => {
              window.history.pushState(null, "", "/");
              window.scrollTo(0, 0);
            }}
            onOpenProject={onOpenProject}
            onUnauthorized={onUnauthorized}
          />
        </div>
        {user && onOpenUsage ? (
          <AuthenticatedHeaderActions
            user={user}
            onOpenUsage={onOpenUsage}
            onOpenAccount={onOpenAccount}
            onOpenAdmin={onOpenAdmin}
            onSignOut={onSignOut}
            portfolioNavigation={{
              projects,
              onOpenPortfolio: () => {
                window.history.pushState(null, "", "/");
                window.scrollTo(0, 0);
              },
              onOpenProject,
              onUnauthorized,
            }}
          />
        ) : null}
      </header>
      <main className="page-container project-dashboard" hidden={dialog}>
        {error ? <Alert testId="projects-error">{error}</Alert> : null}
        {/* DESIGN R2: one true page title — largest text on the page — with a
            thin gold accent rule, and the primary "New project" action moved
            to the top of the page, centered. Inline styles are stopgaps until
            the shared-CSS requests in P2-SHARED-REQUESTS.md land. */}
        <header className="page-header portfolio-page-header">
          <div>
            <h1>Portfolio</h1>
            <span
              aria-hidden="true"
              style={{
                display: "block",
                width: "48px",
                height: "3px",
                borderRadius: "999px",
                background: "var(--gold)",
                marginTop: "var(--space-2)",
              }}
            />
          </div>
        </header>
        <div
          className="portfolio-primary-action"
          style={{ display: "flex", justifyContent: "center", margin: "0 0 var(--space-5)" }}
        >
          <Button
            variant="primary"
            onClick={() => {
              setIdempotencyKey(globalThis.crypto.randomUUID());
              setSourceError(null);
              setLocalSourcesError(null);
              setSubmissionError(null);
              setDialog(true);
            }}
          >
            + New project
          </Button>
        </div>
        <section className="focus-panel portfolio-pulse-panel" aria-label="Portfolio summary">
          <div className="portfolio-summary-head">
            <div>
              <div className="eyebrow">Portfolio summary</div>
              <strong>
                {!hasStatusData
                  ? "Current status is unavailable"
                  : activeAgents > 0
                    ? "Work is moving"
                    : "Ready for the next project"}
              </strong>
            </div>
            <Badge
              tone={
                portfolioState === "Needs attention"
                  ? "danger"
                  : portfolioState === "Work in progress"
                    ? "success"
                    : portfolioState === "Status unavailable"
                      ? "warn"
                      : "info"
              }
            >
              {portfolioState}
            </Badge>
          </div>
          <div className="portfolio-summary-stats">
            <div>
              <strong>{projects?.length ?? "—"}</strong>
              <span>Total projects</span>
            </div>
            <div>
              <strong>{activeAgents}</strong>
              <span>Active runs</span>
            </div>
            <div>
              <strong>{blockedProjects}</strong>
              <span>Blocked</span>
            </div>
          </div>
          {attentionPolling.error || resumePolling.error || resumePollIssue ? (
            <p className="muted" data-testid="portfolio-refresh-status" aria-live="polite">
              Refresh issue · showing last known data
              {attentionPolling.lastSuccessAt
                ? ` from ${attentionPolling.lastSuccessAt.toLocaleTimeString()}`
                : ""}
              .
            </p>
          ) : (
            <p className="muted" data-testid="portfolio-refresh-status" aria-live="polite">
              {attentionPolling.lastSuccessAt
                ? `Last refreshed ${attentionPolling.lastSuccessAt.toLocaleTimeString()}`
                : "Refreshing status…"}
            </p>
          )}
        </section>
        {attention ? (
          <section className="attention-center" aria-labelledby="attention-heading">
            <div className="section-head">
              <h2 id="attention-heading">Status</h2>
              <span className="muted" aria-live="polite">
                {attentionPolling.error ? "Refresh failed · data from " : "Updated "}
                {new Intl.DateTimeFormat(undefined, {
                  hour: "numeric",
                  minute: "2-digit",
                }).format(new Date(attention.generated_at))}
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
                  <span>
                    {projectHealth.active_runs} active run
                    {projectHealth.active_runs === 1 ? "" : "s"}
                  </span>
                  <span>{projectHealth.attention_count} attention</span>
                </div>
              ))}
            </div>
          </section>
        ) : (
          <section className="attention-center" aria-labelledby="attention-heading">
            <div className="section-head">
              <h2 id="attention-heading">Status</h2>
              <span className="muted">Unavailable</span>
            </div>
            <Alert>Portfolio status is unavailable. Refresh to try again.</Alert>
          </section>
        )}
        <div className="project-toolbar">
          <h2>All projects</h2>
          <span className="project-count">{visible?.length ?? 0} shown</span>
        </div>
        {projects === null ? (
          <Spinner label="Loading projects…" />
        ) : visible?.length === 0 ? (
          <div className="empty">
            <div>
              <div className="empty-icon">◇</div>
              <strong>No projects yet</strong>
              <p>Create your first project to begin planning.</p>
            </div>
          </div>
        ) : (
          <div className="proj-stack" data-testid="project-list">
            {visible?.map((project) => {
              const resume = resumeById[project.id];
              const blockedPhase = resume?.phases.find((phase) => phase.blocked);
              const activePhase = resume?.phases.find((phase) => phase.status === "active");
              const projectAttention = actionableAttention.filter(
                (item) => item.project_id === project.id,
              );
              const failedRun = projectAttention.find((item) => item.kind === "failed_run");
              const stalledRun = projectAttention.find((item) => item.kind === "stalled_run");
              // Color coding (P1 dashboard spec): red = decision waiting/
              // blocked, green = executing, blue = plan ready (staffed but not
              // yet running), neutral = draft/no plan.
              const status: "red" | "green" | "blue" | "neutral" =
                (resume?.decisions_waiting ?? 0) > 0 || blockedPhase || projectAttention.length > 0
                  ? "red"
                  : activePhase
                    ? "green"
                    : project.status === "planned" && (resume?.phases.length ?? 0) > 0
                      ? "blue"
                      : "neutral";
              const statusLabel =
                status === "red"
                  ? failedRun
                    ? "Run failed"
                    : stalledRun
                      ? "Run stalled"
                      : "Needs attention"
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
                        <h3 className="pr-title" id={`project-title-${project.id}`}>
                          {project.name}
                        </h3>
                        {!isFillerDescription(project.description) ? (
                          <div className="desc">{project.description}</div>
                        ) : null}
                      </div>
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
                        <span>{projectSourceLabel(project)}</span>
                        <strong>{resume.onboardingSummaryLine}</strong>
                      </div>
                    ) : project.source_location ? (
                      <div className="project-source" title={project.source_location}>
                        <span>{projectSourceLabel(project)}</span>
                        <strong>{project.source_location}</strong>
                      </div>
                    ) : null}
                  </div>
                  <div
                    className="pr-side project-card-dashboard"
                    aria-label={`${project.name} dashboard`}
                  >
                    {[
                      {
                        key: "complete",
                        label: "Overall complete",
                        value: resume ? `${resume.overall_percent_complete}%` : "—",
                        warn: false,
                      },
                      {
                        key: "agents",
                        label: "Active agents",
                        value: String(resume?.agents_active ?? 0),
                        warn: false,
                      },
                      {
                        key: "decisions",
                        label: "Decisions",
                        value: resume?.decisions_waiting
                          ? `${resume.decisions_waiting} waiting`
                          : "None",
                        warn: (resume?.decisions_waiting ?? 0) > 0,
                      },
                      {
                        key: "eta",
                        label: "Blended ETA",
                        value: formatEtaDate(resume?.blended_eta_at),
                        warn: false,
                      },
                      {
                        key: "commits",
                        label: "Total commits",
                        value: String(resume?.total_commits ?? 0),
                        warn: false,
                      },
                      {
                        key: "last-commit",
                        label: "Last commit",
                        value: resume?.last_commit_sha?.slice(0, 8) ?? "—",
                        warn: false,
                        title: resume?.last_commit_sha ?? undefined,
                      },
                    ].map((fact) => (
                      <div className="project-card-stat" key={fact.key} title={fact.title}>
                        <strong className={fact.warn ? "warn" : ""}>{fact.value}</strong>
                        <span>{fact.label}</span>
                      </div>
                    ))}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </main>

      {dialog ? (
        <>
          {/* DESIGN P1 bug fix: the header sits OUTSIDE the width-constrained
              main so the canonical sticky .full-page-header spans the full
              viewport like every other screen's top strip. */}
          <header className="full-page-header">
            <div className="full-page-header-title">
              <Brand onHome={closeWizard} />
              <span>New project</span>
            </div>
            <Button variant="ghost" className="btn-small" onClick={closeWizard}>
              ← Dashboard
            </Button>
          </header>
          {/* DESIGN R2: no in-page "Project setup" heading (the topbar
              location "New project" is the title) and the standard wide
              container instead of the narrow one. */}
          <main className="page-container wizard-page" aria-label="New project">
            <section className="wizard-shell">
              {wizardStep === "adopting" && draftProject ? (
                <div className="form-stack" data-testid="wizard-adoption-step">
                  <div>
                    <div className="eyebrow">
                      {startingPoint === "new"
                        ? `Preparing ${draftProject.name}`
                        : `Adopting ${draftProject.name}`}
                    </div>
                    <h3>
                      {adoptionStage === "analyzing"
                        ? "Understanding the repository"
                        : "Starting the first plan"}
                    </h3>
                    <p className="muted">
                      {adoptionStage === "analyzing"
                        ? "The Norns is reading a bounded sample of committed files and recording the architecture, constraints, and verification facts needed before coding."
                        : startingPoint === "new"
                          ? "The repository is understood. The product objective is becoming a planning run now."
                          : "The repository is understood. The optional direction is becoming a planning run now."}
                    </p>
                  </div>
                  {adoptionError ? (
                    <>
                      <Alert testId="adoption-error">{adoptionError}</Alert>
                      <div className="actions">
                        <Button variant="ghost" onClick={openAdoptedProject}>
                          Open project anyway
                        </Button>
                        <Button variant="primary" onClick={retryAdoption}>
                          Retry
                        </Button>
                      </div>
                    </>
                  ) : (
                    <Spinner
                      label={
                        adoptionStage === "analyzing"
                          ? "Analyzing committed code…"
                          : "Starting planning run…"
                      }
                    />
                  )}
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
                  {/* DESIGN R2: the project name is the first field and IS the
                      name (used for folder/repo naming) — the old objective
                      textarea is gone; planning happens in the conversation
                      after creation. */}
                  {startingPoint === "new" ? (
                    <Field label="Project name">
                      <Input
                        data-testid="project-name"
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        placeholder="e.g. Apollo customer portal"
                      />
                    </Field>
                  ) : null}
                  <fieldset className="source-picker">
                    <legend>Project type</legend>
                    <div className="source-options">
                      <button
                        type="button"
                        className={startingPoint === "new" ? "is-selected" : ""}
                        onClick={() => {
                          setStartingPoint("new");
                          setSelectedRepositoryId("");
                          setSourceError(null);
                          setLocalSourcesError(null);
                          setSubmissionError(null);
                        }}
                      >
                        <strong>New</strong>
                        <span>
                          Create a GitHub repository or use an approved local Git repository.
                        </span>
                      </button>
                      <button
                        type="button"
                        className={startingPoint === "existing" ? "is-selected" : ""}
                        onClick={() => {
                          setStartingPoint("existing");
                          setExecutionLocation("github_actions");
                          setRepositoryName("");
                          setSourceError(null);
                          setLocalSourcesError(null);
                          setSubmissionError(null);
                        }}
                      >
                        <strong>Existing</strong>
                        <span>
                          {legacyLocalCreationAvailable
                            ? "Choose an existing GitHub or approved local Git repository."
                            : "Choose an existing GitHub repository."}
                        </span>
                      </button>
                    </div>
                  </fieldset>

                  <fieldset className="source-picker">
                    <legend>
                      {startingPoint === "new" ? "Working location" : "Where is the existing code?"}
                    </legend>
                    <div className="source-options">
                      <button
                        type="button"
                        className={sourceKind === "github" ? "is-selected" : ""}
                        onClick={() => {
                          setSourceKind("github");
                          if (startingPoint === "existing") {
                            setExecutionLocation("github_actions");
                          }
                          setLocalSelection(null);
                          setSourceError(null);
                          setLocalSourcesError(null);
                          setSubmissionError(null);
                        }}
                      >
                        <strong>GitHub repository</strong>
                        <span>
                          {startingPoint === "new"
                            ? "Create a repository in a connected account or organization."
                            : "Select from a connected account or organization."}
                        </span>
                      </button>
                      {legacyLocalCreationAvailable ? (
                        <button
                          type="button"
                          className={sourceKind === "local" ? "is-selected" : ""}
                          onClick={() => {
                            setSourceKind("local");
                            setExecutionLocation("github_actions");
                            setSelectedRepositoryId("");
                            setSourceError(null);
                            setLocalSourcesError(null);
                            setSubmissionError(null);
                          }}
                        >
                          <strong>Approved local Git repository</strong>
                          <span>
                            Use a repository already initialized and approved in Connections. Norns
                            does not create the folder.
                          </span>
                        </button>
                      ) : null}
                    </div>
                  </fieldset>

                  {isLocalSource ? (
                    <div className="repository-picker local-folder-picker">
                      {localSourcesError ? (
                        <Alert testId="local-source-error">{localSourcesError}</Alert>
                      ) : null}
                      {sourceError ? <Alert>{sourceError}</Alert> : null}
                      {localSources === null ? (
                        <Spinner label="Loading approved local repositories…" />
                      ) : localSources.state !== "connected" ? (
                        <div className="connection-required">
                          <div>
                            <strong>Local repositories need workspace setup</strong>
                            <p>{localSources.message}</p>
                          </div>
                          <Button
                            type="button"
                            variant="primary"
                            className="btn-small"
                            onClick={() => onOpenAccount("connections")}
                          >
                            Open Connections
                          </Button>
                        </div>
                      ) : localSources.repositories.length ? (
                        <div className="repository-list" aria-label="Approved local repositories">
                          {localSources.repositories.map((selection) => (
                            <button
                              type="button"
                              aria-pressed={
                                localSelection?.repository.repository_id ===
                                selection.repository.repository_id
                              }
                              className={
                                localSelection?.repository.repository_id ===
                                selection.repository.repository_id
                                  ? "is-selected"
                                  : ""
                              }
                              key={selection.repository.repository_id}
                              onClick={() => setLocalSelection(selection)}
                            >
                              <span>
                                <strong>{selection.repository.repository_display_name}</strong>
                                <small>{selection.repository.default_branch}</small>
                              </span>
                              <span className="repository-meta">
                                {selection.repository.observed_head.slice(0, 8)}
                              </span>
                            </button>
                          ))}
                        </div>
                      ) : (
                        <div className="connection-required">
                          <div>
                            <strong>No approved local repositories yet</strong>
                            <p>Add one once in Connections, then it will be available here.</p>
                          </div>
                          <Button
                            type="button"
                            variant="primary"
                            className="btn-small"
                            onClick={() => onOpenAccount("connections")}
                          >
                            Open Connections
                          </Button>
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
                            onClick={() => onOpenAccount("connections")}
                          >
                            Open Connections
                          </Button>
                        </div>
                      ) : !githubConnected ? (
                        <div className="connection-required">
                          <div>
                            <strong>
                              {githubStatus.user_authorization.connected
                                ? "Finish GitHub setup"
                                : "Connect GitHub to continue"}
                            </strong>
                            <p>
                              {githubStatus.user_authorization.connected
                                ? `Your identity is authorized as ${githubStatus.user_authorization.login}. Install The Norns for the personal account or organization where it should create and select repositories.`
                                : "Authorize your identity, then choose the personal account or organization where Norns can work."}
                            </p>
                          </div>
                          <Button
                            type="button"
                            variant="primary"
                            className="btn-small"
                            disabled={githubSetupBusy}
                            onClick={() => void continueGitHubSetup()}
                          >
                            {githubStatus.user_authorization.connected
                              ? "Install The Norns on GitHub"
                              : "Connect GitHub"}
                          </Button>
                        </div>
                      ) : (
                        <>
                          {scenario === "existing_repo" || connectedGitHub.length > 1 ? (
                            <Field
                              label={
                                scenario === "new_repo"
                                  ? "Create repository under"
                                  : "GitHub account or organization"
                              }
                            >
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
                          ) : selectedConnection ? (
                            <p className="field-help" data-testid="automatic-github-destination">
                              Repository destination: {selectedConnection.owner_login}
                            </p>
                          ) : null}
                          {scenario === "new_repo" ? null : (
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
                                      onClick={() => setSelectedRepositoryId(repository.id)}
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

                  {!isLocalSource &&
                  startingPoint === "new" &&
                  githubConnected &&
                  legacyLocalCreationAvailable ? (
                    <fieldset className="source-picker" data-testid="execution-location-picker">
                      <legend>Project location</legend>
                      <div className="source-options">
                        <button
                          type="button"
                          className={executionLocation === "local" ? "is-selected" : ""}
                          onClick={() => {
                            setExecutionLocation("local");
                            setSourceError(null);
                            setLocalSourcesError(null);
                            setSubmissionError(null);
                          }}
                        >
                          <strong>This computer + GitHub</strong>
                          <span>
                            Create the GitHub repository, choose a parent folder, and clone a local
                            working copy for the helper.
                          </span>
                        </button>
                        <button
                          type="button"
                          className={executionLocation === "github_actions" ? "is-selected" : ""}
                          onClick={() => {
                            setExecutionLocation("github_actions");
                            setSourceError(null);
                            setLocalSourcesError(null);
                            setSubmissionError(null);
                          }}
                        >
                          <strong>GitHub Actions</strong>
                          <span>Run approved work in an ephemeral GitHub-hosted runner.</span>
                        </button>
                      </div>
                      {executionLocation === "local" ? (
                        localSourcesError ? (
                          <Alert testId="local-source-error">{localSourcesError}</Alert>
                        ) : localSources === null ? (
                          <Spinner label="Checking Norns Local Agent…" />
                        ) : localSources.state !== "connected" ? (
                          <div className="connection-required">
                            <div>
                              <strong>Norns Local Agent required</strong>
                              <p>{localSources.message}</p>
                            </div>
                            <Button
                              type="button"
                              variant="primary"
                              className="btn-small"
                              onClick={() => onOpenAccount("connections")}
                            >
                              Open Connections
                            </Button>
                          </div>
                        ) : !localSources.workspace_clone_ready ? (
                          <div className="connection-required">
                            <div>
                              <strong>Update Norns Local Agent</strong>
                              <p>
                                Update the agent in Connections to enable secure GitHub cloning.
                              </p>
                            </div>
                            <Button
                              type="button"
                              variant="primary"
                              className="btn-small"
                              onClick={() => onOpenAccount("connections")}
                            >
                              Open Connections
                            </Button>
                          </div>
                        ) : (
                          <p className="field-help">
                            The system folder chooser opens after GitHub creates the repository. The
                            selected path stays on this computer.
                          </p>
                        )
                      ) : null}
                    </fieldset>
                  ) : null}

                  {startingPoint === "new" ? (
                    <>
                      {name.trim() ? (
                        <div className="policy" data-testid="derived-project-summary">
                          <strong>{derivedIdentity.projectName}</strong>
                          <br />
                          {isLocalSource
                            ? localSelection
                              ? `New Norns project in ${localSelection.repository.repository_display_name}`
                              : "Choose an approved local Git repository"
                            : `${selectedConnection?.owner_login ?? "GitHub"}/${derivedIdentity.repositorySlug} · ${
                                repositoryPrivate ? "Private" : "Public"
                              }`}
                        </div>
                      ) : null}
                      <details>
                        <summary>Options</summary>
                        <div className="form-stack">
                          {!isLocalSource ? (
                            <div className="project-create-grid">
                              <Field label="Repository slug override">
                                <Input
                                  data-testid="github-new-repository-name"
                                  value={repositoryName}
                                  onChange={(event) => setRepositoryName(event.target.value)}
                                  placeholder={deriveProjectIdentity("", name).repositorySlug}
                                />
                              </Field>
                            </div>
                          ) : null}
                          {!isLocalSource ? (
                            <Field label="Visibility">
                              <Select
                                data-testid="github-repository-visibility"
                                value={repositoryPrivate ? "private" : "public"}
                                onChange={(event) =>
                                  setRepositoryPrivate(event.target.value === "private")
                                }
                              >
                                <option value="private">Private (default)</option>
                                <option value="public">Public</option>
                              </Select>
                            </Field>
                          ) : null}
                          <div className="two-col-fields">
                            <Field label="Coordinator model">
                              <Select
                                data-testid="pm-model"
                                value={pmModel}
                                aria-describedby="pm-model-description"
                                onChange={(event) => setPmModel(event.target.value as PmModelT)}
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
                            {pmProvider === "openai" ? (
                              <Field label="Coordinator Codex effort">
                                <Select
                                  data-testid="pm-effort"
                                  value={pmEffort}
                                  onChange={(event) =>
                                    setPmEffort(event.target.value as CodexReasoningEffortT)
                                  }
                                >
                                  <option value="minimal">Minimal</option>
                                  <option value="low">Low</option>
                                  <option value="medium">Medium</option>
                                  <option value="high">High</option>
                                  <option value="xhigh">Extra high</option>
                                </Select>
                                <span className="field-help">
                                  Controls reasoning depth for this Codex planning run.
                                </span>
                              </Field>
                            ) : null}
                            <Field label="Reviewer model">
                              <Select
                                data-testid="reviewer-model"
                                value={reviewerSelection}
                                onChange={(event) => setReviewerSelection(event.target.value)}
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
                                Automatic picks the opposite provider from the coordinator.
                              </span>
                            </Field>
                          </div>
                          <Field label="Plan review rounds">
                            {/* DESIGN R2: zero rounds is allowed — it means
                                review is off. */}
                            <div className="rounds-stepper" data-testid="rounds-stepper">
                              <Button
                                type="button"
                                className="btn-small"
                                disabled={roundsCount <= 0}
                                onClick={() => setRoundsCount((count) => Math.max(0, count - 1))}
                                aria-label="Fewer rounds"
                              >
                                −
                              </Button>
                              <span className="rounds-value mono">{roundsCount}</span>
                              <Button
                                type="button"
                                className="btn-small"
                                disabled={roundsCount >= 5}
                                onClick={() => setRoundsCount((count) => Math.min(5, count + 1))}
                                aria-label="More rounds"
                              >
                                +
                              </Button>
                            </div>
                          </Field>
                          {roundsCount > 0 ? (
                            <div className="policy">
                              <strong>Cross-provider review is on.</strong>
                              <br />
                              {selectedModel?.label} will lead planning.{" "}
                              {pmProvider === "anthropic" ? "OpenAI" : "Anthropic"} will
                              independently review the plan.
                            </div>
                          ) : (
                            <div className="policy">
                              <strong>Plan review is off.</strong>
                              <br />
                              {selectedModel?.label} will lead planning with no independent review
                              rounds.
                            </div>
                          )}
                        </div>
                      </details>
                    </>
                  ) : (
                    <Field label="What should The Norns do first? (optional)">
                      <TextArea
                        data-testid="project-description"
                        value={description}
                        onChange={(event) => setDescription(event.target.value)}
                        placeholder="Leave blank to adopt and understand the repository without starting a plan."
                      />
                      <span className="field-help">
                        If provided, planning starts automatically after repository analysis.
                      </span>
                    </Field>
                  )}
                  {submissionError ? (
                    <Alert testId="onboarding-submit-error">{submissionError}</Alert>
                  ) : null}
                  <p className="setup-confirmation" data-testid="setup-confirmation">
                    {confirmationText}
                  </p>
                  <Button variant="primary" disabled={!canCreate} onClick={() => void create()}>
                    {creating
                      ? startingPoint === "new" &&
                        sourceKind === "github" &&
                        executionLocation === "local"
                        ? "Creating GitHub repository and local folder…"
                        : scenario === "new_repo"
                          ? "Creating repository and project…"
                          : "Creating…"
                      : startingPoint === "new"
                        ? "Create project →"
                        : "Adopt project →"}
                  </Button>
                </div>
              )}
            </section>
          </main>
        </>
      ) : null}
    </div>
  );
}
