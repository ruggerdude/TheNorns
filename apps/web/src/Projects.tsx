import {
  DEFAULT_PM_MODEL,
  PM_MODEL_OPTIONS,
  type PmModelT,
  pmModelOption,
  providerForPmModel,
} from "@norns/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { GitHubConnection, GitHubIntegrationStatus } from "./Account";
import { ApiError, type CurrentUser, UnauthorizedError, authHeaders } from "./auth";
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
}

interface AttentionItemDto {
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

interface PortfolioAttentionDto {
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

/**
 * A paired runner is the only party that knows a filesystem path.  The web
 * client receives stable opaque identifiers and presentation-safe names only.
 */
interface LocalRunner {
  runner_id: string;
  generation: number;
  connected: boolean;
  last_seen_at: string | null;
  workspace_picker_ready?: boolean;
  capabilities?: string[];
}

interface LocalWorkspace {
  workspace_id: string;
  label: string;
}

interface LocalWorkspaceEntry {
  entry_id: string;
  label: string;
  kind: "folder" | "repository";
  can_browse: boolean;
}

interface LocalWorkspaceBrowser {
  workspace_id: string;
  breadcrumb?: string[];
  entries: LocalWorkspaceEntry[];
}

interface LocalSelection {
  selection_token: string;
  expires_at: string;
  repository: {
    runner_id: string;
    workspace_id: string;
    repository_id: string;
    repository_display_name: string;
    default_branch: string | null;
    observed_head: string | null;
  };
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

function AttentionDecisionForm({
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
  const [startingPoint, setStartingPoint] = useState<"new" | "existing">("new");
  const [newRepository, setNewRepository] = useState<"none" | "github">("none");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [pmModel, setPmModel] = useState<PmModelT>(DEFAULT_PM_MODEL.anthropic);
  const pmProvider = providerForPmModel(pmModel);
  const selectedModel = pmModelOption(pmModel);
  const [githubStatus, setGitHubStatus] = useState<GitHubIntegrationStatus | null>(null);
  const [selectedConnectionId, setSelectedConnectionId] = useState("");
  const [repositories, setRepositories] = useState<GitHubRepository[]>([]);
  const [selectedRepositoryId, setSelectedRepositoryId] = useState("");
  const [repositoryQuery, setRepositoryQuery] = useState("");
  const [repositoryLoading, setRepositoryLoading] = useState(false);
  const [repositoryName, setRepositoryName] = useState("");
  const [repositoryPrivate, setRepositoryPrivate] = useState(true);
  const [existingSource, setExistingSource] = useState<"github" | "local">("github");
  const [localRunners, setLocalRunners] = useState<LocalRunner[]>([]);
  const [localRunnersLoading, setLocalRunnersLoading] = useState(false);
  const [selectedLocalRunnerId, setSelectedLocalRunnerId] = useState("");
  const [localWorkspaces, setLocalWorkspaces] = useState<LocalWorkspace[]>([]);
  const [localWorkspacesLoading, setLocalWorkspacesLoading] = useState(false);
  const [selectedLocalWorkspaceId, setSelectedLocalWorkspaceId] = useState("");
  const [localBrowser, setLocalBrowser] = useState<LocalWorkspaceBrowser | null>(null);
  const [localNavigation, setLocalNavigation] = useState<string[]>([]);
  const [selectedLocalEntryId, setSelectedLocalEntryId] = useState<string | null>(null);
  const [localBrowserLoading, setLocalBrowserLoading] = useState(false);
  const [localSelection, setLocalSelection] = useState<LocalSelection | null>(null);
  const [localValidationLoading, setLocalValidationLoading] = useState(false);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [attention, setAttention] = useState<PortfolioAttentionDto | null>(null);
  const [attentionBusy, setAttentionBusy] = useState<string | null>(null);

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
      setRepositories([]);
      return;
    }
    setRepositoryLoading(true);
    setSourceError(null);
    try {
      const repositories = await request<GitHubRepository[]>(
        `/api/integrations/github/connections/${encodeURIComponent(selectedConnectionId)}/repositories`,
      );
      setRepositories(repositories);
      setSelectedRepositoryId((current) =>
        repositories.some((repository) => repository.id === current) ? current : "",
      );
    } catch (error) {
      if (error instanceof UnauthorizedError) onUnauthorized();
      else setSourceError(error instanceof Error ? error.message : String(error));
    } finally {
      setRepositoryLoading(false);
    }
  }, [onUnauthorized, selectedConnectionId]);

  useEffect(() => {
    if (
      dialog &&
      startingPoint === "existing" &&
      existingSource === "github" &&
      selectedConnectionId
    ) {
      void loadRepositories();
    }
  }, [dialog, existingSource, loadRepositories, selectedConnectionId, startingPoint]);

  const loadLocalRunners = useCallback(async () => {
    setLocalRunnersLoading(true);
    setSourceError(null);
    try {
      const runners = await request<LocalRunner[]>("/api/runners");
      const connected = runners.filter((runner) => runner.connected);
      setLocalRunners(connected);
      setSelectedLocalRunnerId((current) =>
        connected.some((runner) => runner.runner_id === current)
          ? current
          : (connected[0]?.runner_id ?? ""),
      );
    } catch (error) {
      if (error instanceof UnauthorizedError) onUnauthorized();
      else setSourceError(error instanceof Error ? error.message : String(error));
    } finally {
      setLocalRunnersLoading(false);
    }
  }, [onUnauthorized]);

  const loadLocalWorkspaces = useCallback(async () => {
    if (!selectedLocalRunnerId) {
      setLocalWorkspaces([]);
      return;
    }
    setLocalWorkspacesLoading(true);
    setSourceError(null);
    try {
      const response = await request<{ workspaces: LocalWorkspace[] }>(
        `/api/runners/${encodeURIComponent(selectedLocalRunnerId)}/workspaces`,
      );
      const workspaces = response.workspaces;
      setLocalWorkspaces(workspaces);
      setSelectedLocalWorkspaceId((current) =>
        workspaces.some((workspace) => workspace.workspace_id === current) ? current : "",
      );
    } catch (error) {
      if (error instanceof UnauthorizedError) onUnauthorized();
      else setSourceError(error instanceof Error ? error.message : String(error));
    } finally {
      setLocalWorkspacesLoading(false);
    }
  }, [onUnauthorized, selectedLocalRunnerId]);

  const browseLocalWorkspace = useCallback(
    async (workspaceId: string, entryId: string | undefined, navigation: string[]) => {
      if (!selectedLocalRunnerId) return;
      setLocalBrowserLoading(true);
      setSourceError(null);
      try {
        const browser = await request<LocalWorkspaceBrowser>(
          `/api/runners/${encodeURIComponent(selectedLocalRunnerId)}/workspaces/browse`,
          entryId
            ? { workspace_id: workspaceId, entry_id: entryId }
            : { workspace_id: workspaceId },
        );
        setSelectedLocalWorkspaceId(workspaceId);
        setLocalBrowser({
          ...browser,
          breadcrumb: Array.isArray(browser.breadcrumb) ? browser.breadcrumb : [],
          entries: Array.isArray(browser.entries) ? browser.entries : [],
        });
        setLocalNavigation(navigation);
        setLocalSelection(null);
        setSelectedLocalEntryId(null);
      } catch (error) {
        if (error instanceof UnauthorizedError) onUnauthorized();
        else setSourceError(error instanceof Error ? error.message : String(error));
      } finally {
        setLocalBrowserLoading(false);
      }
    },
    [onUnauthorized, selectedLocalRunnerId],
  );

  const validateLocalRepository = useCallback(
    async (entryId: string) => {
      if (!selectedLocalRunnerId || !selectedLocalWorkspaceId) return;
      setLocalValidationLoading(true);
      setSourceError(null);
      try {
        const selection = await request<LocalSelection>(
          `/api/runners/${encodeURIComponent(selectedLocalRunnerId)}/workspaces/validate`,
          { workspace_id: selectedLocalWorkspaceId, entry_id: entryId },
        );
        setLocalSelection(selection);
        setSelectedLocalEntryId(entryId);
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
        setLocalValidationLoading(false);
      }
    },
    [onUnauthorized, selectedLocalRunnerId, selectedLocalWorkspaceId],
  );

  useEffect(() => {
    if (dialog && startingPoint === "existing" && existingSource === "local") {
      void loadLocalRunners();
    }
  }, [dialog, existingSource, loadLocalRunners, startingPoint]);

  useEffect(() => {
    if (dialog && startingPoint === "existing" && existingSource === "local") {
      void loadLocalWorkspaces();
    }
  }, [dialog, existingSource, loadLocalWorkspaces, startingPoint]);

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
      if (startingPoint === "new" && newRepository === "github") {
        repository = await request<GitHubRepository>("/api/integrations/github/repositories", {
          connection_id: selectedConnectionId,
          name: repositoryName.trim(),
          description: description.trim(),
          private: repositoryPrivate,
          auto_init: true,
        });
        if (repository.binding_ready === false) {
          setSourceError(
            `${repository.full_name} was created, but this GitHub installation only has selected-repository access. Add the repository to The Norns in GitHub, refresh connections, and then import it as existing code.`,
          );
          return;
        }
      }
      if (startingPoint === "existing" && existingSource === "github" && !repository) {
        setSourceError("Select a GitHub repository to continue.");
        return;
      }
      if (startingPoint === "existing" && existingSource === "local" && !localSelection) {
        setSourceError("Select and validate a local Git repository to continue.");
        return;
      }
      const projectName =
        name.trim() ||
        repository?.name ||
        localSelection?.repository.repository_display_name ||
        "Untitled project";
      const projectDescription =
        description.trim() ||
        repository?.description ||
        (repository
          ? `Analyze and continue development of ${repository.full_name}`
          : localSelection
            ? `Analyze and continue development of ${localSelection.repository.repository_display_name}`
            : "New project");
      const project = await request<ProjectSummary>("/api/projects", {
        name: projectName,
        description: projectDescription,
        pm_provider: pmProvider,
        pm_model: pmModel,
        ...(repository
          ? {
              source_type: "github",
              github_connection_id: repository.connection_id,
              github_repository_id: repository.id,
            }
          : {}),
      });
      const completedProject = localSelection
        ? await (async () => {
            try {
              await request<LocalBindingResult>(
                `/api/v2/projects/${project.id}/source-bindings/local`,
                {
                  selection_token: localSelection.selection_token,
                  verification_policy_ref: "verification-policy:default-v1",
                },
              );
              return {
                ...project,
                source_type: "local" as const,
                source_location: localSelection.repository.repository_display_name,
              };
            } catch (bindingError) {
              await refresh();
              setSourceError(
                `Project created, but local repository binding failed: ${
                  bindingError instanceof Error ? bindingError.message : String(bindingError)
                }. Close this dialog, then open the created project to retry the binding.`,
              );
              return null;
            }
          })()
        : project;
      if (!completedProject) return;
      setProjects((current) => (current ? [completedProject, ...current] : [completedProject]));
      setDialog(false);
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
    newRepository,
    selectedConnectionId,
    repositoryName,
    repositoryPrivate,
    existingSource,
    localSelection,
    refresh,
    onOpenProject,
    onUnauthorized,
  ]);

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
  const sourceRequired = startingPoint === "existing" || newRepository === "github";
  const sourceReady =
    startingPoint === "existing"
      ? existingSource === "github"
        ? Boolean(selectedRepositoryId)
        : Boolean(localSelection)
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
          <div className="project-grid" data-testid="project-list">
            {visible?.map((project) => (
              <article className="project-card" key={project.id}>
                <button
                  type="button"
                  className="project-card-main"
                  onClick={() => onOpenProject(project)}
                >
                  <div className="project-card-head">
                    <span className="project-monogram">
                      {project.name.slice(0, 2).toUpperCase()}
                    </span>
                    <Badge tone={project.status === "planned" ? "success" : "warn"}>
                      {project.status}
                    </Badge>
                  </div>
                  <h3>{project.name}</h3>
                  <p>{project.description}</p>
                  {project.plan_objective ? (
                    <div className="project-objective">
                      <span>Current objective</span>
                      {project.plan_objective}
                    </div>
                  ) : null}
                  {project.source_location ? (
                    <div className="project-source" title={project.source_location}>
                      <span>{project.source_type === "github" ? "GitHub" : "Local folder"}</span>
                      <strong>{project.source_location}</strong>
                    </div>
                  ) : null}
                  <dl className="project-facts">
                    <div>
                      <dt>Lead</dt>
                      <dd>
                        {project.pm_model
                          ? (pmModelOption(project.pm_model)?.label ?? project.pm_model)
                          : `${project.pm_provider} default (legacy)`}
                      </dd>
                    </div>
                    <div>
                      <dt>Review</dt>
                      <dd>{project.reviewer_provider}</dd>
                    </div>
                    <div>
                      <dt>Created</dt>
                      <dd>
                        {new Intl.DateTimeFormat(undefined, {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        }).format(new Date(project.created_at))}
                      </dd>
                    </div>
                  </dl>
                  <span className="project-open-link">
                    Open project <span>→</span>
                  </span>
                </button>
              </article>
            ))}
          </div>
        )}
      </main>

      {dialog ? (
        <dialog open className="modal-overlay" aria-modal="true" aria-label="New project">
          <button
            className="modal-backdrop"
            type="button"
            aria-label="Close"
            onClick={() => setDialog(false)}
          />
          <section className="modal modal-wide project-create-modal card">
            <div className="section-head">
              <div>
                <div className="eyebrow">Create</div>
                <h2>New project</h2>
                <p className="muted">Start fresh or bring an existing codebase into The Norns.</p>
              </div>
              <Button variant="ghost" className="btn-small" onClick={() => setDialog(false)}>
                ×
              </Button>
            </div>
            <div className="form-stack">
              <fieldset className="source-picker">
                <legend>What are you starting with?</legend>
                <div className="source-options">
                  <button
                    type="button"
                    className={startingPoint === "new" ? "is-selected" : ""}
                    onClick={() => {
                      setStartingPoint("new");
                      setSelectedRepositoryId("");
                    }}
                  >
                    <strong>New project</strong>
                    <span>Define a new objective and optionally create its GitHub repository.</span>
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
                      <span>Browse folders approved by a paired local runner.</span>
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
                            The selected GitHub installation must allow repository administration to
                            create a repository.
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
                  {localRunnersLoading ? (
                    <Spinner label="Looking for paired local runners…" />
                  ) : localRunners.length === 0 ? (
                    <div className="connection-required">
                      <div>
                        <strong>No local runner is online</strong>
                        <p>
                          Pair and start a runner on the computer that owns this folder, then
                          refresh this list. Folder paths never leave that computer.
                        </p>
                      </div>
                      <Button type="button" className="btn-small" onClick={onOpenAccount}>
                        Manage runners
                      </Button>
                    </div>
                  ) : (
                    <>
                      <div className="repository-search">
                        <Field label="Connected local runner">
                          <Select
                            data-testid="local-runner"
                            value={selectedLocalRunnerId}
                            onChange={(event) => {
                              setSelectedLocalRunnerId(event.target.value);
                              setSelectedLocalWorkspaceId("");
                              setLocalBrowser(null);
                              setLocalNavigation([]);
                              setLocalSelection(null);
                              setSelectedLocalEntryId(null);
                            }}
                          >
                            {localRunners.map((runner) => (
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

                      {localWorkspacesLoading ? (
                        <Spinner label="Loading approved folders…" />
                      ) : localWorkspaces.length === 0 ? (
                        <div className="connection-required">
                          <div>
                            <strong>No approved folders</strong>
                            <p>
                              Add an approved root when starting the selected runner, then refresh.
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
                          {localSelection ? (
                            <p className="policy" data-testid="local-selection-summary">
                              <strong>{localSelection.repository.repository_display_name}</strong>{" "}
                              is validated on the selected runner
                              {localSelection.repository.default_branch
                                ? ` · ${localSelection.repository.default_branch}`
                                : ""}
                              . The Norns stores only this safe repository metadata, never its path.
                            </p>
                          ) : null}
                        </div>
                      )}
                    </>
                  )}
                </div>
              ) : null}

              <div className="project-create-grid">
                <Field
                  label={startingPoint === "existing" ? "Project name (optional)" : "Project name"}
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

              <Field label="Project manager model">
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
              <div className="policy">
                <strong>Cross-provider review is on.</strong>
                <br />
                {selectedModel?.label} will lead planning.{" "}
                {pmProvider === "anthropic" ? "OpenAI" : "Anthropic"} will independently review the
                plan.
              </div>
              <Button variant="primary" disabled={!canCreate} onClick={() => void create()}>
                {creating
                  ? newRepository === "github"
                    ? "Creating repository and project…"
                    : "Creating…"
                  : "Create and open project"}
              </Button>
            </div>
          </section>
        </dialog>
      ) : null}
    </div>
  );
}
