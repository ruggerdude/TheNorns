import {
  DEFAULT_PM_MODEL,
  PM_MODEL_OPTIONS,
  type PmModelT,
  pmModelOption,
  providerForPmModel,
} from "@norns/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";
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
  const [dialog, setDialog] = useState<"new" | "existing" | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [pmModel, setPmModel] = useState<PmModelT>(DEFAULT_PM_MODEL.anthropic);
  const pmProvider = providerForPmModel(pmModel);
  const selectedModel = pmModelOption(pmModel);
  const [creating, setCreating] = useState(false);

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

  const create = useCallback(async () => {
    setCreating(true);
    setError(null);
    try {
      const project = await request<ProjectSummary>("/api/projects", {
        name: name.trim(),
        description: description.trim(),
        pm_provider: pmProvider,
        pm_model: pmModel,
      });
      setProjects((current) => (current ? [project, ...current] : [project]));
      setDialog(null);
      setName("");
      setDescription("");
      onOpenProject(project);
    } catch (e) {
      e instanceof UnauthorizedError
        ? onUnauthorized()
        : setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }, [name, description, pmProvider, pmModel, onOpenProject, onUnauthorized]);

  const openIds = useMemo(() => new Set(openProjects.map((p) => p.id)), [openProjects]);
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
  const existingChoices = projects?.filter((p) => !openIds.has(p.id)) ?? [];

  return (
    <div className="app-shell">
      <header className="topbar">
        <Brand />
        <div className="header-actions">
          <Button variant="ghost" className="btn-small" onClick={onOpenAccount}>
            Account
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
            <Button onClick={() => setDialog("existing")}>Add existing</Button>
            <Button variant="primary" onClick={() => setDialog("new")}>
              + New project
            </Button>
          </div>
        </div>
        {error ? <Alert testId="projects-error">{error}</Alert> : null}
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
        <dialog
          open
          className="modal-overlay"
          aria-modal="true"
          aria-label={dialog === "new" ? "New project" : "Add existing project"}
        >
          <button
            className="modal-backdrop"
            type="button"
            aria-label="Close"
            onClick={() => setDialog(null)}
          />
          <section className="modal card">
            <div className="section-head">
              <div>
                <div className="eyebrow">{dialog === "new" ? "Create" : "Workspace"}</div>
                <h2>{dialog === "new" ? "New project" : "Add existing project"}</h2>
              </div>
              <Button variant="ghost" className="btn-small" onClick={() => setDialog(null)}>
                ×
              </Button>
            </div>
            {dialog === "new" ? (
              <div className="form-stack">
                <Field label="Project name">
                  <Input
                    data-testid="project-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. Notifications service"
                    autoFocus
                  />
                </Field>
                <Field label="Objective">
                  <TextArea
                    data-testid="project-description"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="What should this project deliver?"
                  />
                </Field>
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
                  {pmProvider === "anthropic" ? "OpenAI" : "Anthropic"} will independently review
                  the plan.
                </div>
                <Button
                  variant="primary"
                  disabled={creating || !name.trim() || !description.trim()}
                  onClick={() => void create()}
                >
                  {creating ? "Creating…" : "Create and open project"}
                </Button>
              </div>
            ) : existingChoices.length ? (
              <div className="existing-list">
                {existingChoices.map((project) => (
                  <button
                    type="button"
                    key={project.id}
                    onClick={() => {
                      onOpenProject(project);
                      setDialog(null);
                    }}
                  >
                    <span>
                      <strong>{project.name}</strong>
                      <small>{project.description}</small>
                    </span>
                    <Badge tone={project.status === "planned" ? "success" : "warn"}>
                      {project.status}
                    </Badge>
                  </button>
                ))}
              </div>
            ) : (
              <div className="empty compact-empty">
                <div>
                  <strong>Everything is already open</strong>
                  <p>Close a project tab or create a new project.</p>
                </div>
              </div>
            )}
          </section>
        </dialog>
      ) : null}
    </div>
  );
}
