import {
  type CodexReasoningEffortT,
  DEFAULT_CODEX_REASONING_EFFORT,
  DEFAULT_PM_MODEL,
  OwnedDeviceProjection,
  type OwnedDeviceProjectionT,
  type PmModelT,
  type PmProviderT,
  type V2QcModeT,
  pmModelOption,
  providerForPmModel,
} from "@norns/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GitHubConnection, GitHubIntegrationStatus, SettingsTab } from "./Account";
import { PortfolioMenu } from "./PortfolioMenu";
import { AuthenticatedHeaderActions } from "./UserMenu";
import { PM_MODEL_GROUPS, aiProviderLabel, defaultReviewerProviderFor } from "./aiProviders";
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
  parseGitHubRepoRef,
} from "./projectSourceRequest";
import { Alert, Badge, Brand, Button, Field, Input, Select, Spinner, TextArea } from "./ui";
import { useSingleFlightPolling } from "./useSingleFlightPolling";
import {
  UPDATE_DETAIL_OPTIONS,
  UPDATE_INTERVAL_OPTIONS,
  type UpdateDetailLevel,
  type UpdateIntervalSeconds,
  loadGlobalUpdatePreferences,
  saveProjectUpdatePreferences,
} from "./workspacePreferences";
import "./CoreSurfaces.css";

export interface ProjectSummary {
  id: string;
  name: string;
  description: string;
  pm_provider: PmProviderT;
  pm_model: PmModelT | null;
  reviewer_provider: PmProviderT;
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
  /** Browser-only handoff from project adoption into the first work brief. */
  initial_work_objective?: string | null;
}

/**
 * Browser-only intent for the single navigation that follows project setup.
 * It is deliberately separate from ProjectSummary because API/list records can
 * retain old entry hints and must still behave like ordinary project opens.
 */
export interface ProjectOpenOptions {
  startNewWork?: boolean;
  initialBrief?: string | null;
}

// QCP-4A: the project-layer QC cadence default. Derived from the contract
// enum so the server CHECK (drizzle/0064_qc_pause_points.sql), the wire, and
// this picker cannot drift apart when a mode is added.
export type QcModeT = V2QcModeT;

/** One line each — a mode picker nobody understands is worse than no picker. */
export const QC_MODE_OPTIONS: ReadonlyArray<{ value: QcModeT; label: string; help: string }> = [
  {
    value: "automatic",
    label: "Automatic after finding review",
    help: "Pauses for your finding decisions before the PM revises, then continues automatically.",
  },
  {
    value: "gated_when_contested",
    label: "Gated when contested (recommended)",
    help: "Pauses for your finding decisions and for unresolved must-fix disagreements.",
  },
  {
    value: "gated_each_round",
    label: "Gated each round",
    help: "Also pauses after each revision so you can inspect changes before the next round.",
  },
  {
    value: "gated_each_step",
    label: "Gated each step",
    help: "Pauses for finding decisions and after every revision — the most cautious cadence.",
  },
];

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

interface CloneDestinationSelection {
  clone_destination_id: string;
  label: string;
  computer_id: string;
}

interface LocalAgentDownloads {
  windows: string | null;
  macos: string | null;
}

interface ProjectDeletionOptions {
  local_folder: { available: boolean; label: string | null };
  github_repository: { available: boolean; label: string | null };
}

function localAgentDownloads(payload: unknown): LocalAgentDownloads | null {
  if (!payload || typeof payload !== "object" || !("downloads" in payload)) return null;
  const downloads = (payload as { downloads: unknown }).downloads;
  if (!downloads || typeof downloads !== "object") return null;
  const candidate = downloads as Record<string, unknown>;
  return {
    windows: typeof candidate.windows === "string" ? candidate.windows : null,
    macos: typeof candidate.macos === "string" ? candidate.macos : null,
  };
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
  newProjectRequested = false,
  onNewProjectRequestHandled,
}: {
  onOpenProject: (p: ProjectSummary, options?: ProjectOpenOptions) => void;
  openProjects: ProjectSummary[];
  onUnauthorized: () => void;
  onSignOut: () => void;
  user: CurrentUser | null;
  onOpenAccount: (tab?: SettingsTab) => void;
  onOpenAdmin: () => void;
  onOpenUsage?: () => void;
  newProjectRequested?: boolean;
  onNewProjectRequestHandled?: () => void;
}): React.ReactElement {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState(newProjectRequested);
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
  const [executionLocation, setExecutionLocation] = useState<
    "github_actions" | "this_computer" | "remote_computer"
  >("github_actions");
  const scenario: ProjectOnboardingScenario =
    startingPoint === "new" ? "new_repo" : "existing_repo";
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [pmModel, setPmModel] = useState<PmModelT>(DEFAULT_PM_MODEL.anthropic);
  const [pmEffort, setPmEffort] = useState<CodexReasoningEffortT>(DEFAULT_CODEX_REASONING_EFFORT);
  const pmProvider = providerForPmModel(pmModel);
  const reviewerProviderPreview = defaultReviewerProviderFor(pmProvider);
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
  const [computers, setComputers] = useState<OwnedDeviceProjectionT[] | null>(null);
  const [agentDownloads, setAgentDownloads] = useState<LocalAgentDownloads | null>(null);
  const [computersError, setComputersError] = useState<string | null>(null);
  const [selectedComputerId, setSelectedComputerId] = useState("");
  const [cloneDestination, setCloneDestination] = useState<CloneDestinationSelection | null>(null);
  const [folderPickerBusy, setFolderPickerBusy] = useState(false);
  const [folderPickerError, setFolderPickerError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [creationStatus, setCreationStatus] = useState<string | null>(null);
  const [attention, setAttention] = useState<PortfolioAttentionDto | null>(null);
  const [attentionBusy, setAttentionBusy] = useState<string | null>(null);
  const [resumePollIssue, setResumePollIssue] = useState<string | null>(null);
  const [roundsCount, setRoundsCount] = useState(1);
  // FRONT DOOR P2b: reviewer selector. "auto" means no explicit override
  // (the server's automatic opposite-provider default); any other value is
  // "provider:model" as offered by MODEL_CHOICES below.
  const [reviewerSelection, setReviewerSelection] = useState("auto");
  // QCP-4A: the project-layer QC cadence default. Ships as "automatic" so no
  // existing project's behavior changes; the picker only ever sets this
  // project's default, not any review already in flight (those pin their own
  // qc_mode at kickoff).
  const [qcMode, setQcMode] = useState<QcModeT>("automatic");
  const [allowUnadjudicatedRebuttals, setAllowUnadjudicatedRebuttals] = useState(false);
  const [projectUpdatePreferences, setProjectUpdatePreferences] = useState(
    loadGlobalUpdatePreferences,
  );
  // DESIGN R2 semantic change: the wizard's single submit creates the
  // repository/project and opens it — planning now begins in the conversation
  // after creation, so there is no wizard planning kickoff or attachment
  // upload step anymore. "blocker" means creation succeeded but repository
  // activation needs human attention before the continuation can run.
  const [wizardStep, setWizardStep] = useState<"form" | "blocker" | "adopting">("form");
  const [draftProject, setDraftProject] = useState<ProjectSummary | null>(null);
  const [wizardObjective, setWizardObjective] = useState("");
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
  const [archivedProjects, setArchivedProjects] = useState<Array<
    ProjectSummary & { archived_at: string }
  > | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [archiveBusy, setArchiveBusy] = useState<string | null>(null);

  const refreshArchived = useCallback(async () => {
    try {
      const list = await request<Array<ProjectSummary & { archived_at: string }>>(
        "/api/admin/projects/archived",
      );
      setArchivedProjects(list);
    } catch {
      setArchivedProjects([]);
    }
  }, []);

  const restoreProject = async (id: string, name: string) => {
    if (!window.confirm(`Restore "${name}" to the portfolio?`)) return;
    setArchiveBusy(id);
    try {
      await fetch(`/api/admin/projects/${encodeURIComponent(id)}/restore`, {
        method: "POST",
        headers: authHeaders(),
      });
      await Promise.all([refresh(), refreshArchived()]);
    } catch (caught) {
      if (caught instanceof UnauthorizedError) onUnauthorized();
    } finally {
      setArchiveBusy(null);
    }
  };

  const destroyArchivedProject = async (id: string, name: string) => {
    if (!window.confirm(`Permanently delete "${name}"? This cannot be undone.`)) return;
    setArchiveBusy(id);
    setError(null);
    try {
      const options = await request<ProjectDeletionOptions>(
        `/api/v2/projects/${encodeURIComponent(id)}/deletion-options`,
      );
      const deleteLocalFolder =
        options.local_folder.available &&
        window.confirm(
          `Also delete the local folder${options.local_folder.label ? ` "${options.local_folder.label}"` : ""}? The files in that folder will be permanently removed.`,
        );
      const deleteGitHubRepository =
        options.github_repository.available &&
        window.confirm(
          `Also delete the GitHub repository${options.github_repository.label ? ` "${options.github_repository.label}"` : ""}? This cannot be undone.`,
        );
      await requestVerb(`/api/v2/projects/${encodeURIComponent(id)}/destroy`, "DELETE", {
        delete_local_folder: deleteLocalFolder,
        delete_github_repository: deleteGitHubRepository,
      });
      await refreshArchived();
    } catch (caught) {
      caught instanceof UnauthorizedError
        ? onUnauthorized()
        : setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setArchiveBusy(null);
    }
  };

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
          setLocalSelection(null);
          setLocalSources(null);
          setLocalSourcesError(null);
        }
        if (!capabilities.computers_available || !capabilities.repository_grants_available) {
          setExecutionLocation("github_actions");
          setComputers(null);
          setComputersError(null);
          setSelectedComputerId("");
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
      sourceKind === "local",
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

  useSingleFlightPolling({
    enabled:
      dialog &&
      startingPoint === "new" &&
      sourceKind === "github" &&
      executionLocation !== "github_actions" &&
      localExecutionCapabilities.computers_available,
    intervalMs: 4_000,
    maxBackoffMs: 60_000,
    resourceKey: "project-computers",
    load: async () => {
      const payload = await request<{ devices: unknown; downloads?: unknown }>("/api/devices");
      return {
        computers: OwnedDeviceProjection.array().parse(payload.devices),
        downloads: localAgentDownloads(payload),
      };
    },
    onSuccess: ({ computers: availableComputers, downloads }) => {
      setComputersError(null);
      setComputers(availableComputers);
      setAgentDownloads(downloads);
      setSelectedComputerId((current) => {
        if (availableComputers.some((computer) => computer.device_id === current)) return current;
        return (
          availableComputers.find(
            (computer) =>
              computer.lifecycle === "active" &&
              computer.status.availability === "online" &&
              computer.agent?.capabilities.includes("workspace_picker") &&
              computer.agent.capabilities.includes("workspace_repository_inventory") &&
              computer.agent?.capabilities.includes("workspace_clone") &&
              computer.agent.capabilities.includes("workspace_clone_destination"),
          )?.device_id ??
          availableComputers.find((computer) => computer.lifecycle === "active")?.device_id ??
          ""
        );
      });
    },
    onError: (pollError) => {
      if (pollError instanceof UnauthorizedError) onUnauthorized();
      else {
        setComputersError("Norns couldn't check your computers. Open Computers and try again.");
      }
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
      const startNewWork =
        completedProject.entry_flow === "new" || completedProject.entry_flow === "adoption";
      const initialBrief = completedProject.initial_work_objective ?? null;
      const stableProject = {
        ...completedProject,
        entry_flow: null,
        initial_work_objective: null,
      };
      setProjects((current) =>
        current?.some((project) => project.id === completedProject.id)
          ? current
          : current
            ? [stableProject, ...current]
            : [stableProject],
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
      setCloneDestination(null);
      setFolderPickerBusy(false);
      setFolderPickerError(null);
      setLocalSources(null);
      setLocalSourcesError(null);
      setSubmissionError(null);
      setAdoptionError(null);
      setCreationStatus(null);
      setReviewerSelection("auto");
      setRoundsCount(1);
      setQcMode("automatic");
      setAllowUnadjudicatedRebuttals(false);
      setProjectUpdatePreferences(loadGlobalUpdatePreferences());
      setIdempotencyKey(globalThis.crypto.randomUUID());
      onOpenProject(stableProject, {
        startNewWork,
        initialBrief,
      });
    },
    [onOpenProject],
  );

  const completeAdoption = useCallback(
    async (project: ProjectSummary, objective: string): Promise<void> => {
      setDraftProject(project);
      setWizardObjective(objective);
      setAdoptionError(null);
      setWizardStep("adopting");
      try {
        await request(`/api/v2/projects/${project.id}/analyze-repository`, {});
        proceedAfterCreate({
          ...project,
          entry_flow: "adoption",
          initial_work_objective: objective || null,
        });
      } catch (error) {
        if (error instanceof UnauthorizedError) onUnauthorized();
        else setAdoptionError(error instanceof Error ? error.message : String(error));
      }
    },
    [onUnauthorized, proceedAfterCreate],
  );

  const applyReviewerPreference = useCallback(
    async (projectId: string): Promise<void> => {
      try {
        if (reviewerSelection !== "auto") {
          const [reviewerProviderChoice, ...modelParts] = reviewerSelection.split(":");
          await requestVerb(`/api/v2/projects/${projectId}/planning-reviewer`, "PATCH", {
            provider: reviewerProviderChoice,
            model: modelParts.join(":"),
            qc_mode: qcMode,
            allow_unadjudicated_rebuttals: allowUnadjudicatedRebuttals,
            default_max_rounds: roundsCount,
          });
        } else {
          await requestVerb(`/api/v2/projects/${projectId}/planning-reviewer`, "DELETE");
          // QCP-4A: the QC cadence default is independent of the reviewer
          // override, so it still needs its own write when the reviewer
          // stays automatic (DELETE only clears the provider/model pair).
          await requestVerb(`/api/v2/projects/${projectId}/planning-reviewer`, "PATCH", {
            qc_mode: qcMode,
            allow_unadjudicated_rebuttals: allowUnadjudicatedRebuttals,
            default_max_rounds: roundsCount,
          });
        }
      } catch {
        // Best-effort: planning safely falls back to the account default.
      }
    },
    [reviewerSelection, qcMode, allowUnadjudicatedRebuttals, roundsCount],
  );

  const chooseCloneDestination = useCallback(async (): Promise<void> => {
    if (!selectedComputerId) return;
    setFolderPickerBusy(true);
    setFolderPickerError(null);
    setSubmissionError(null);
    try {
      const selection = await request<
        { cancelled: true } | { clone_destination_id: string; label: string }
      >(`/api/v2/computers/${encodeURIComponent(selectedComputerId)}/clone-destination`, {});
      if ("cancelled" in selection) return;
      setCloneDestination({ ...selection, computer_id: selectedComputerId });
    } catch (error) {
      if (error instanceof UnauthorizedError) onUnauthorized();
      else setFolderPickerError(error instanceof Error ? error.message : String(error));
    } finally {
      setFolderPickerBusy(false);
    }
  }, [onUnauthorized, selectedComputerId]);

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
    setCreationStatus(null);
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
        setCreationStatus("Creating the project and preparing its repository…");
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
      const computerExecution = executionLocation !== "github_actions";
      if (
        scenario === "new_repo" &&
        computerExecution &&
        (!localExecutionCapabilities.computers_available ||
          !localExecutionCapabilities.repository_grants_available)
      ) {
        setSourceError(
          "Computer working copies are not enabled. Choose GitHub Actions for this project.",
        );
        return;
      }
      if (scenario === "new_repo" && computerExecution && !selectedComputerId) {
        setSourceError("Choose an online computer for the new working folder.");
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
      setCreationStatus(
        scenario === "new_repo"
          ? computerExecution
            ? "Creating the GitHub repository and cloning its working folder…"
            : "Creating the GitHub repository and project…"
          : "Connecting the repository and creating the project…",
      );
      const onboarding = await request<OnboardingResponse>("/api/v2/projects/onboarding", {
        name: projectName,
        description: projectDescription,
        pm_provider: pmProvider,
        pm_model: pmModel,
        idempotency_key: idempotencyKey,
        ...(scenario === "new_repo"
          ? {
              local_working_copy: computerExecution,
              ...(computerExecution ? { computer_id: selectedComputerId } : {}),
              ...(computerExecution && cloneDestination
                ? { clone_destination_id: cloneDestination.clone_destination_id }
                : {}),
            }
          : {}),
        ...onboardingFields,
      });
      // The onboarding response is a lean summary (project_id, scenario,
      // replayed, workspace/remote/push, blockers) — not the full project
      // record the rest of the app expects, so fetch that separately
      // through the existing GET /api/projects/:id route.
      setCreationStatus("Repository ready. Loading the new project…");
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
      if (startingPoint === "new") {
        setCreationStatus("Project created. Saving QC settings…");
        await applyReviewerPreference(completedProject.id);
        saveProjectUpdatePreferences(completedProject.id, projectUpdatePreferences);
      }
      if (onboarding.blockers.length > 0) {
        setOnboardingBlockers(onboarding.blockers);
        setDraftProject(completedProject);
        setWizardObjective(description.trim());
        setWizardStep("blocker");
        return;
      }
      if (startingPoint === "existing") {
        setCreationStatus("Project created. Preparing the repository…");
        await completeAdoption(completedProject, description.trim());
        return;
      }
      setCreationStatus("Setup complete. Opening the project…");
      finishNewProject(completedProject);
    } catch (e) {
      setCreationStatus(null);
      if (executionLocation !== "github_actions") setCloneDestination(null);
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
    selectedComputerId,
    cloneDestination,
    projectUpdatePreferences,
    localExecutionCapabilities.computers_available,
    localExecutionCapabilities.repository_grants_available,
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
    if (!draftProject) return;
    if (startingPoint === "new") {
      finishNewProject(draftProject);
      return;
    }
    proceedAfterCreate({
      ...draftProject,
      entry_flow: "adoption",
      initial_work_objective: wizardObjective || null,
    });
  }, [draftProject, finishNewProject, proceedAfterCreate, startingPoint, wizardObjective]);

  /** The "blocker" step's Continue action — the project already exists;
   *  this just resumes the normal post-creation flow (attach-and-launch for
   *  a fresh objective, or straight into the workspace). */
  const continueFromBlockers = useCallback(() => {
    if (!draftProject) return;
    const project = draftProject;
    setOnboardingBlockers([]);
    setWizardStep("form");
    if (
      startingPoint === "new" &&
      sourceKind === "github" &&
      executionLocation !== "github_actions"
    ) {
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

  const openNewProject = useCallback(() => {
    setIdempotencyKey(globalThis.crypto.randomUUID());
    setSourceError(null);
    setLocalSourcesError(null);
    setSubmissionError(null);
    setDialog(true);
  }, []);

  useEffect(() => {
    if (!newProjectRequested) return;
    openNewProject();
    onNewProjectRequestHandled?.();
  }, [newProjectRequested, onNewProjectRequestHandled, openNewProject]);

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
    setCloneDestination(null);
    setFolderPickerBusy(false);
    setFolderPickerError(null);
    setLocalSources(null);
    setLocalSourcesError(null);
    setSubmissionError(null);
    setAdoptionError(null);
    setCreationStatus(null);
    setReviewerSelection("auto");
    setRoundsCount(1);
    setQcMode("automatic");
    setAllowUnadjudicatedRebuttals(false);
    setProjectUpdatePreferences(loadGlobalUpdatePreferences());
    setIdempotencyKey(globalThis.crypto.randomUUID());
  }, []);

  const openPortfolio = useCallback(() => {
    closeWizard();
    window.history.pushState(null, "", "/");
    window.scrollTo(0, 0);
  }, [closeWizard]);

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
  const computerCreationAvailable =
    localExecutionCapabilities.computers_available &&
    localExecutionCapabilities.repository_grants_available;
  const selectedComputer = computers?.find((computer) => computer.device_id === selectedComputerId);
  const readyComputers =
    computers?.filter(
      (computer) =>
        computer.lifecycle === "active" &&
        computer.status.availability === "online" &&
        computer.agent?.capabilities.includes("workspace_picker") &&
        computer.agent.capabilities.includes("workspace_repository_inventory") &&
        computer.agent.capabilities.includes("workspace_clone") &&
        computer.agent.capabilities.includes("workspace_clone_destination"),
    ) ?? [];
  const activeComputers = computers?.filter((computer) => computer.lifecycle === "active") ?? [];
  const computersNeedingFolderUpdate = activeComputers.filter(
    (computer) =>
      computer.status.availability === "online" &&
      !readyComputers.some((readyComputer) => readyComputer.device_id === computer.device_id),
  );
  const computerNeedingFolderUpdate =
    computersNeedingFolderUpdate.find((computer) => computer.device_id === selectedComputerId) ??
    computersNeedingFolderUpdate[0];
  const folderUpdateDownload =
    computerNeedingFolderUpdate?.os_family === "macos"
      ? agentDownloads?.macos
      : computerNeedingFolderUpdate?.os_family === "windows"
        ? agentDownloads?.windows
        : null;
  const computerExecution = executionLocation !== "github_actions";
  const sourceReady = isLocalSource
    ? legacyLocalCreationAvailable && Boolean(localSelection)
    : scenario === "existing_repo"
      ? Boolean(selectedRepositoryId)
      : Boolean(selectedConnectionId);
  const localCloneReady =
    isLocalSource ||
    startingPoint !== "new" ||
    !computerExecution ||
    (computerCreationAvailable &&
      selectedComputer !== undefined &&
      cloneDestination?.computer_id === selectedComputer.device_id &&
      readyComputers.some((computer) => computer.device_id === selectedComputer.device_id));
  const canCreate =
    !creating &&
    (isLocalSource || githubConnected) &&
    (name.trim().length > 0 || startingPoint === "existing") &&
    sourceReady &&
    localCloneReady;
  return (
    <div className={`app-shell${dialog ? " project-setup-view" : ""}`}>
      <header className="topbar">
        <div className="topbar-main">
          <Brand onHome={openPortfolio} />
          <PortfolioMenu
            projects={projects}
            onNewProject={openNewProject}
            onOpenPortfolio={openPortfolio}
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
              onNewProject: openNewProject,
              onOpenPortfolio: openPortfolio,
              onOpenProject,
              onUnauthorized,
            }}
          />
        ) : null}
      </header>
      <main className="page-container project-dashboard core-portfolio-page" hidden={dialog}>
        {error ? <Alert testId="projects-error">{error}</Alert> : null}
        <header className="page-header portfolio-page-header core-portfolio-header">
          <div>
            <div className="eyebrow">Workspace overview</div>
            <h1>Portfolio</h1>
            <p>Monitor active work, resolve exceptions, and open any project from one view.</p>
          </div>
        </header>
        <section
          className="core-portfolio-status"
          aria-labelledby="attention-heading"
          aria-label="Portfolio summary"
        >
          <div className="core-portfolio-status-header">
            <div>
              <div className="core-status-title-row">
                <h2 id="attention-heading">Status</h2>
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
              <p>
                {!hasStatusData
                  ? "Current status is unavailable"
                  : actionableAttention.length > 0
                    ? `${actionableAttention.length} item${actionableAttention.length === 1 ? "" : "s"} need review`
                    : activeAgents > 0
                      ? "Work is moving without intervention"
                      : "Ready for the next project"}
              </p>
            </div>
            <p
              className="core-refresh-status"
              data-testid="portfolio-refresh-status"
              aria-live="polite"
            >
              {attentionPolling.error || resumePolling.error || resumePollIssue
                ? `Refresh issue · showing last known data${
                    attentionPolling.lastSuccessAt
                      ? ` from ${attentionPolling.lastSuccessAt.toLocaleTimeString()}`
                      : ""
                  }.`
                : attentionPolling.lastSuccessAt
                  ? `Updated ${attentionPolling.lastSuccessAt.toLocaleTimeString([], {
                      hour: "numeric",
                      minute: "2-digit",
                    })}`
                  : "Refreshing status…"}
            </p>
          </div>

          <div className="core-portfolio-metrics" aria-label="Portfolio attention summary">
            <div>
              <span>Projects</span>
              <strong>{projects?.length ?? "—"}</strong>
            </div>
            <div>
              <span>Active runs</span>
              <strong>{attention?.counts.active_runs ?? activeAgents}</strong>
            </div>
            <div className={(attention?.counts.decisions ?? 0) > 0 ? "is-warning" : ""}>
              <span>Decisions</span>
              <strong>{attention?.counts.decisions ?? 0}</strong>
            </div>
            <div
              className={(attention?.counts.blockers ?? blockedProjects) > 0 ? "is-critical" : ""}
            >
              <span>Blockers</span>
              <strong>{attention?.counts.blockers ?? blockedProjects}</strong>
            </div>
          </div>

          {attention ? (
            attention.items.length ? (
              <div className="attention-list core-attention-list" data-testid="attention-list">
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
            )
          ) : (
            <Alert>Portfolio status is unavailable. Refresh to try again.</Alert>
          )}
        </section>
        <div className="project-toolbar core-project-toolbar">
          <div>
            <h2>Projects</h2>
            <p>Open a project to continue planning, review decisions, or follow active work.</p>
          </div>
          <span className="project-count">{visible?.length ?? 0}</span>
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
              const health = attention?.projects.find((h) => h.id === project.id);
              const blockedPhase = resume?.phases.find((phase) => phase.blocked);
              const activePhase = resume?.phases.find((phase) => phase.status === "active");
              const projectAttention = actionableAttention.filter(
                (item) => item.project_id === project.id,
              );
              const failedRun = projectAttention.find((item) => item.kind === "failed_run");
              const stalledRun = projectAttention.find((item) => item.kind === "stalled_run");
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
              const phaseName = health?.current_phase ?? activePhase?.objective_summary ?? null;
              const tasksDone = health?.completed_tasks ?? 0;
              const tasksTotal = health?.total_tasks ?? 0;
              return (
                <a
                  className={`card proj-row core-project-row s-${status}`}
                  key={project.id}
                  data-testid="proj-row"
                  href={`#project-${encodeURIComponent(project.id)}`}
                  aria-label={`Enter ${project.name}`}
                  onClick={(event) => {
                    event.preventDefault();
                    onOpenProject(project);
                  }}
                >
                  <div className="core-project-identity">
                    <div className="core-project-title-row">
                      <span className="status-dot" aria-hidden="true" />
                      <h3 className="pr-title" id={`project-title-${project.id}`}>
                        {project.name}
                      </h3>
                    </div>
                    {!isFillerDescription(project.description) ? (
                      <p>{project.description}</p>
                    ) : phaseName ? (
                      <p>{phaseName}</p>
                    ) : (
                      <p>{projectSourceLabel(project)}</p>
                    )}
                    <div className="core-project-meta">
                      <span>{projectSourceLabel(project)}</span>
                      {phaseName ? <span>{phaseName}</span> : null}
                    </div>
                  </div>
                  <div className="core-project-state">
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
                    {(resume?.decisions_waiting ?? 0) > 0 ? (
                      <span className="core-project-warning">
                        {resume?.decisions_waiting} decision
                        {resume?.decisions_waiting === 1 ? "" : "s"}
                      </span>
                    ) : null}
                  </div>
                  <div className="core-project-progress" aria-label={`${project.name} stats`}>
                    <div>
                      <span>
                        {tasksDone}/{tasksTotal} tasks
                      </span>
                      <span>{resume?.agents_active ?? 0} runs</span>
                      <strong>{resume ? `${resume.overall_percent_complete}%` : "—"}</strong>
                    </div>
                    <div
                      className="core-project-progress-track"
                      role="progressbar"
                      aria-label={`${project.name} completion`}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={resume?.overall_percent_complete ?? 0}
                      tabIndex={0}
                    >
                      <span style={{ width: `${resume?.overall_percent_complete ?? 0}%` }} />
                    </div>
                  </div>
                  <div className="core-project-agents" aria-label={`${project.name} models`}>
                    <span title="Coordinator">
                      {project.pm_model
                        ? (pmModelOption(project.pm_model)?.label ?? project.pm_model)
                        : `${aiProviderLabel(project.pm_provider)} default`}
                    </span>
                    <span title="Reviewer">
                      {pmModelOption(DEFAULT_PM_MODEL[project.reviewer_provider])?.label ??
                        aiProviderLabel(project.reviewer_provider)}
                    </span>
                  </div>
                </a>
              );
            })}
          </div>
        )}
        <details
          className="archived-toggle"
          onToggle={(event) => {
            const open = (event.target as HTMLDetailsElement).open;
            setShowArchived(open);
            if (open) void refreshArchived();
          }}
        >
          <summary>Archived projects</summary>
          {showArchived ? (
            archivedProjects === null ? (
              <Spinner label="Loading…" />
            ) : archivedProjects.length === 0 ? (
              <p className="muted">No archived projects.</p>
            ) : (
              <ul className="admin-archived-list">
                {archivedProjects.map((project) => (
                  <li key={project.id}>
                    <div>
                      <strong>{project.name}</strong>
                      <small>Archived {new Date(project.archived_at).toLocaleDateString()}</small>
                    </div>
                    <div className="archive-actions">
                      <Button
                        className="btn-small"
                        disabled={archiveBusy === project.id}
                        onClick={() => void restoreProject(project.id, project.name)}
                      >
                        {archiveBusy === project.id ? "Restoring…" : "Restore"}
                      </Button>
                      <Button
                        variant="danger"
                        className="btn-small"
                        disabled={archiveBusy === project.id}
                        onClick={() => void destroyArchivedProject(project.id, project.name)}
                      >
                        Delete
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )
          ) : null}
        </details>
      </main>

      {dialog ? (
        <>
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
                    <h3>Understanding the repository</h3>
                    <p className="muted">
                      The Norns is reading a bounded sample of committed files and recording the
                      architecture, constraints, and verification facts needed before coding.
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
                    <Spinner label="Analyzing committed code…" />
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
                <div className="form-stack project-setup-form">
                  {/* DESIGN R2: the project name is the first field and IS the
                      name (used for folder/repo naming) — the old objective
                      textarea is gone; planning happens in the conversation
                      after creation. */}
                  <section className="setup-section" aria-labelledby="project-name-section">
                    <header className="setup-section-header">
                      <span className="setup-section-number" aria-hidden="true">
                        1
                      </span>
                      <div>
                        <h2 id="project-name-section">Name of project</h2>
                      </div>
                    </header>
                    {startingPoint === "new" ? (
                      <Field label="Project name">
                        <Input
                          data-testid="project-name"
                          value={name}
                          onChange={(event) => setName(event.target.value)}
                          placeholder="e.g. Apollo customer portal"
                        />
                      </Field>
                    ) : (
                      <p className="setup-section-note">
                        The project will use the name of the GitHub repository you select.
                      </p>
                    )}
                  </section>

                  <section className="setup-section" aria-labelledby="github-section">
                    <header className="setup-section-header">
                      <span className="setup-section-number" aria-hidden="true">
                        2
                      </span>
                      <div>
                        <h2 id="github-section">GitHub</h2>
                        <p>Choose the repository and where it belongs.</p>
                      </div>
                    </header>
                    <fieldset className="source-picker setup-choice-group">
                      <legend>Repository</legend>
                      <div className="source-options">
                        <button
                          type="button"
                          className={
                            sourceKind === "github" && startingPoint === "new" ? "is-selected" : ""
                          }
                          onClick={() => {
                            setStartingPoint("new");
                            setSourceKind("github");
                            setSelectedRepositoryId("");
                            setLocalSelection(null);
                            setSourceError(null);
                            setLocalSourcesError(null);
                            setSubmissionError(null);
                          }}
                        >
                          <strong>New GitHub</strong>
                          <span>
                            Create a new repository in a connected GitHub account or organization.
                          </span>
                        </button>
                        <button
                          type="button"
                          className={
                            sourceKind === "github" && startingPoint === "existing"
                              ? "is-selected"
                              : ""
                          }
                          onClick={() => {
                            setStartingPoint("existing");
                            setSourceKind("github");
                            setExecutionLocation("github_actions");
                            setRepositoryName("");
                            setLocalSelection(null);
                            setSourceError(null);
                            setLocalSourcesError(null);
                            setSubmissionError(null);
                          }}
                        >
                          <strong>Existing GitHub</strong>
                          <span>
                            Select a repository from a connected GitHub account or organization.
                          </span>
                        </button>
                      </div>
                    </fieldset>

                    {startingPoint === "new" && !isLocalSource ? (
                      <div className="github-repository-row">
                        <Field label="Repository name">
                          <Input
                            data-testid="github-new-repository-name"
                            value={repositoryName}
                            onChange={(event) => setRepositoryName(event.target.value)}
                            placeholder={deriveProjectIdentity("", name).repositorySlug}
                          />
                        </Field>
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
                        {name.trim() ? (
                          <div
                            className="github-repository-summary"
                            data-testid="derived-project-summary"
                          >
                            <span className="github-repository-summary-label">Repository</span>
                            <span>
                              {`${selectedConnection?.owner_login ?? "GitHub"}/${derivedIdentity.repositorySlug}`}{" "}
                              · {repositoryPrivate ? "Private" : "Public"}
                            </span>
                          </div>
                        ) : null}
                      </div>
                    ) : null}

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
                                Configure the Norns GitHub App in workspace Settings before
                                selecting repositories.
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
                                          selectedRepositoryId === repository.id
                                            ? "is-selected"
                                            : ""
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
                  </section>

                  <section className="setup-section" aria-labelledby="project-section">
                    <header className="setup-section-header">
                      <span className="setup-section-number" aria-hidden="true">
                        3
                      </span>
                      <div>
                        <h2 id="project-section">Project</h2>
                        <p>Choose where the project runs and where its files live.</p>
                      </div>
                    </header>
                    {!isLocalSource && startingPoint === "new" && githubConnected ? (
                      <fieldset
                        className="source-picker setup-choice-group"
                        data-testid="execution-location-picker"
                      >
                        <legend>Project location</legend>
                        <div className="source-options source-options-three project-location-options">
                          <button
                            type="button"
                            className={executionLocation === "this_computer" ? "is-selected" : ""}
                            disabled={!computerCreationAvailable}
                            onClick={() => {
                              setExecutionLocation("this_computer");
                              setCloneDestination(null);
                              setFolderPickerError(null);
                              setSourceError(null);
                              setComputersError(null);
                              setSubmissionError(null);
                            }}
                          >
                            <strong>This computer</strong>
                            <span>Select a folder here with the Local Agent.</span>
                          </button>
                          <button
                            type="button"
                            className={executionLocation === "remote_computer" ? "is-selected" : ""}
                            disabled={!computerCreationAvailable}
                            onClick={() => {
                              setExecutionLocation("remote_computer");
                              setCloneDestination(null);
                              setFolderPickerError(null);
                              setSourceError(null);
                              setComputersError(null);
                              setSubmissionError(null);
                            }}
                          >
                            <strong>Remote computer</strong>
                            <span>Select a folder with that computer's Local Agent.</span>
                          </button>
                          <button
                            type="button"
                            className={executionLocation === "github_actions" ? "is-selected" : ""}
                            onClick={() => {
                              setExecutionLocation("github_actions");
                              setCloneDestination(null);
                              setFolderPickerError(null);
                              setSourceError(null);
                              setComputersError(null);
                              setSubmissionError(null);
                            }}
                          >
                            <strong>GitHub Actions</strong>
                            <span>Use an ephemeral GitHub-hosted runner.</span>
                          </button>
                        </div>
                        {computerExecution ? (
                          computersError ? (
                            <Alert testId="computer-source-error">{computersError}</Alert>
                          ) : computers === null ? (
                            <Spinner label="Checking your computers…" />
                          ) : readyComputers.length === 0 ? (
                            <div className="connection-required connection-required-action-only">
                              {computersNeedingFolderUpdate.length > 0 && folderUpdateDownload ? (
                                <a
                                  className="btn btn-primary btn-small"
                                  href={folderUpdateDownload}
                                >
                                  Update agent
                                </a>
                              ) : (
                                <Button type="button" className="btn-small" disabled>
                                  {computersNeedingFolderUpdate.length > 0
                                    ? "Agent update needed"
                                    : activeComputers.length > 0
                                      ? "Agent offline"
                                      : "No agent"}
                                </Button>
                              )}
                            </div>
                          ) : (
                            <div className="computer-project-picker">
                              <input
                                type="hidden"
                                data-testid="project-computer"
                                value={selectedComputerId}
                              />
                              <div
                                className="computer-choice-list"
                                role="radiogroup"
                                aria-label={
                                  executionLocation === "this_computer"
                                    ? "Computer you are using"
                                    : "Remote computer"
                                }
                              >
                                {readyComputers.map((computer) => (
                                  <label
                                    className={
                                      selectedComputerId === computer.device_id ? "is-selected" : ""
                                    }
                                    key={computer.device_id}
                                  >
                                    <input
                                      type="radio"
                                      name="project-computer"
                                      value={computer.device_id}
                                      checked={selectedComputerId === computer.device_id}
                                      onChange={() => {
                                        setSelectedComputerId(computer.device_id);
                                        setCloneDestination(null);
                                        setFolderPickerError(null);
                                      }}
                                    />
                                    <span className="computer-choice-status" aria-hidden="true" />
                                    <span>
                                      <strong>{computer.name}</strong>
                                      <small>{computer.location_label || "Online"}</small>
                                    </span>
                                  </label>
                                ))}
                              </div>
                              <div className="folder-destination">
                                <div>
                                  <span className="folder-destination-label">Project folder</span>
                                  <strong>
                                    {cloneDestination?.computer_id === selectedComputerId
                                      ? cloneDestination.label
                                      : "No folder selected"}
                                  </strong>
                                  <small>The folder path stays on the selected computer.</small>
                                </div>
                                <Button
                                  type="button"
                                  className="btn-small"
                                  disabled={folderPickerBusy || !selectedComputerId}
                                  onClick={() => void chooseCloneDestination()}
                                >
                                  {folderPickerBusy ? "Waiting for folder…" : "Select folder"}
                                </Button>
                              </div>
                              {folderPickerError ? (
                                <Alert testId="folder-picker-error">{folderPickerError}</Alert>
                              ) : null}
                            </div>
                          )
                        ) : null}
                      </fieldset>
                    ) : startingPoint === "existing" ? (
                      <Field label="What should The Norns do first? (optional)">
                        <TextArea
                          data-testid="project-description"
                          value={description}
                          onChange={(event) => setDescription(event.target.value)}
                          placeholder="Leave blank to adopt and understand the repository without starting a plan."
                        />
                      </Field>
                    ) : null}
                  </section>

                  {startingPoint === "new" ? (
                    <section className="setup-section" aria-labelledby="qc-section">
                      <header className="setup-section-header">
                        <span className="setup-section-number" aria-hidden="true">
                          4
                        </span>
                        <div>
                          <h2 id="qc-section">QC options</h2>
                          <p>Set the planning models and review cadence.</p>
                        </div>
                      </header>
                      <div className="two-col-fields">
                        <Field label="Project Manager">
                          <Select
                            data-testid="pm-model"
                            value={pmModel}
                            onChange={(event) => setPmModel(event.target.value as PmModelT)}
                          >
                            {PM_MODEL_GROUPS.map((group) => (
                              <optgroup key={group.provider} label={group.label}>
                                {group.models.map((model) => (
                                  <option key={model.id} value={model.id}>
                                    {model.label}
                                  </option>
                                ))}
                              </optgroup>
                            ))}
                          </Select>
                        </Field>
                        <Field label="Reviewer model">
                          <Select
                            data-testid="reviewer-model"
                            value={reviewerSelection}
                            onChange={(event) => setReviewerSelection(event.target.value)}
                          >
                            <option value="auto">
                              Automatic (cross-provider) · {reviewerPreviewLabel}
                            </option>
                            {PM_MODEL_GROUPS.map((group) => (
                              <optgroup key={group.provider} label={group.label}>
                                {group.models.map((model) => (
                                  <option key={model.id} value={`${group.provider}:${model.id}`}>
                                    {model.label}
                                  </option>
                                ))}
                              </optgroup>
                            ))}
                          </Select>
                        </Field>
                        {pmProvider === "openai" ? (
                          <Field label="Project Manager Codex effort">
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
                          </Field>
                        ) : null}
                      </div>
                      <div className="qc-review-controls">
                        <Field label="Reviews">
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
                        <label className="qc-review-toggle">
                          <input
                            type="checkbox"
                            data-testid="allow-unadjudicated-rebuttals"
                            checked={allowUnadjudicatedRebuttals}
                            disabled={roundsCount === 0}
                            onChange={(event) =>
                              setAllowUnadjudicatedRebuttals(event.target.checked)
                            }
                          />
                          <strong>Allow rebuttals</strong>
                        </label>
                        <label className="qc-review-toggle">
                          <input
                            type="checkbox"
                            data-testid="skip-reviews"
                            checked={roundsCount === 0}
                            onChange={(event) => setRoundsCount(event.target.checked ? 0 : 1)}
                          />
                          <strong>Skip reviews</strong>
                        </label>
                      </div>
                      <div className="qc-preferences-row">
                        <Field label="Pause mode">
                          <Select
                            data-testid="qc-mode"
                            value={qcMode}
                            disabled={roundsCount === 0}
                            onChange={(event) => setQcMode(event.target.value as QcModeT)}
                          >
                            {QC_MODE_OPTIONS.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </Select>
                        </Field>
                        <Field label="Update timing">
                          <Select
                            data-testid="project-update-timing"
                            value={projectUpdatePreferences.intervalSeconds}
                            onChange={(event) =>
                              setProjectUpdatePreferences((current) => ({
                                ...current,
                                intervalSeconds: Number(
                                  event.target.value,
                                ) as UpdateIntervalSeconds,
                              }))
                            }
                          >
                            {UPDATE_INTERVAL_OPTIONS.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </Select>
                        </Field>
                        <Field label="Update content">
                          <Select
                            data-testid="project-update-content"
                            value={projectUpdatePreferences.detailLevel}
                            onChange={(event) =>
                              setProjectUpdatePreferences((current) => ({
                                ...current,
                                detailLevel: event.target.value as UpdateDetailLevel,
                              }))
                            }
                          >
                            {UPDATE_DETAIL_OPTIONS.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </Select>
                        </Field>
                      </div>
                    </section>
                  ) : null}
                  {submissionError ? (
                    <Alert testId="onboarding-submit-error">{submissionError}</Alert>
                  ) : null}
                  {creationStatus ? (
                    <output
                      className="project-creation-status"
                      data-testid="project-creation-status"
                      aria-live="polite"
                    >
                      <span className="spinner" aria-hidden="true" />
                      <div>
                        <strong>Setting up your project</strong>
                        <span>{creationStatus}</span>
                      </div>
                    </output>
                  ) : null}
                  <div className="project-create-actions">
                    <Button variant="primary" disabled={!canCreate} onClick={() => void create()}>
                      {creating
                        ? "Creating project…"
                        : startingPoint === "new"
                          ? "Create project →"
                          : "Adopt project →"}
                    </Button>
                  </div>
                </div>
              )}
            </section>
          </main>
        </>
      ) : null}
    </div>
  );
}
