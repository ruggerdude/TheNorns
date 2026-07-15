import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, type CurrentUser, UnauthorizedError, authHeaders } from "./auth";
import { Alert, Badge, Brand, Button, Field, Input, Select, Spinner, TextArea } from "./ui";
export interface ProjectSummary {
  id: string;
  name: string;
  description: string;
  pm_provider: "anthropic" | "openai";
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
export function Projects({
  onOpenProject,
  onUnauthorized,
  onSignOut,
  user,
  onOpenAccount,
  onOpenAdmin,
}: {
  onOpenProject: (p: ProjectSummary) => void;
  onUnauthorized: () => void;
  onSignOut: () => void;
  user: CurrentUser | null;
  onOpenAccount: () => void;
  onOpenAdmin: () => void;
}): React.ReactElement {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [pmProvider, setPmProvider] = useState<"anthropic" | "openai">("anthropic");
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState("");
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
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const create = useCallback(async () => {
    setCreating(true);
    setError(null);
    try {
      const p = await request<ProjectSummary>("/api/projects", {
        name,
        description,
        pm_provider: pmProvider,
      });
      onOpenProject(p);
    } catch (e) {
      e instanceof UnauthorizedError
        ? onUnauthorized()
        : setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }, [name, description, pmProvider, onOpenProject, onUnauthorized]);
  const visible = useMemo(
    () =>
      projects
        ?.filter((p) => (p.name + p.description).toLowerCase().includes(query.toLowerCase()))
        .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)),
    [projects, query],
  );
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
      <main className="page">
        <div className="page-intro">
          <div className="eyebrow">Program workspace</div>
          <h1>Work, made legible.</h1>
          <p>
            Create a program, convene a cross-provider planning pair, and turn the result into a
            graph your team can actually execute.
          </p>
        </div>
        {error ? <Alert testId="projects-error">{error}</Alert> : null}
        <div className="projects-layout">
          <section className="card">
            <div className="section-head">
              <div>
                <h2>Start a project</h2>
                <span className="muted">Define the outcome and choose its lead.</span>
              </div>
              <span className="badge badge-warn">New</span>
            </div>
            <div className="form-stack">
              <Field label="Project name">
                <Input
                  data-testid="project-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Notifications service"
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
              <Field label="Program manager">
                <Select
                  data-testid="pm-provider"
                  value={pmProvider}
                  onChange={(e) => setPmProvider(e.target.value as typeof pmProvider)}
                >
                  <option value="anthropic">Anthropic · Claude</option>
                  <option value="openai">OpenAI</option>
                </Select>
              </Field>
              <div className="policy">
                <strong>Cross-provider review is always on.</strong>
                <br />
                {pmProvider === "anthropic" ? "OpenAI" : "Anthropic"} will independently review the
                plan before you see it.
              </div>
              <Button
                variant="primary"
                className="btn-block"
                disabled={creating || !name.trim() || !description.trim()}
                onClick={() => void create()}
              >
                {creating ? "Creating…" : "Create project →"}
              </Button>
            </div>
          </section>
          <section className="card">
            <div className="section-head">
              <div>
                <h2>Your projects</h2>
                <span className="muted">{projects?.length ?? 0} programs in this workspace</span>
              </div>
              {projects?.length ? (
                <Input
                  aria-label="Search projects"
                  placeholder="Search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  style={{ width: 150 }}
                />
              ) : null}
            </div>
            {projects === null ? (
              <Spinner label="Loading projects…" />
            ) : visible?.length === 0 ? (
              <div className="empty">
                <div>
                  <div className="empty-icon">◇</div>
                  <strong>
                    {query ? "No matching projects" : "Your first program starts here"}
                  </strong>
                  <p>
                    {query
                      ? "Try a different search."
                      : "Use the form to define an outcome and assemble its planning pair."}
                  </p>
                </div>
              </div>
            ) : (
              <ul className="project-list" data-testid="project-list">
                {visible?.map((p) => (
                  <li key={p.id}>
                    <button type="button" className="project-row" onClick={() => onOpenProject(p)}>
                      <div className="project-row-top">
                        <strong>{p.name}</strong>
                        <Badge tone={p.status === "planned" ? "success" : "default"}>
                          {p.status}
                        </Badge>
                      </div>
                      <p>{p.description}</p>
                      <div className="meta">
                        {new Intl.DateTimeFormat(undefined, {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        }).format(new Date(p.created_at))}{" "}
                        · {p.pm_provider} PM · {p.reviewer_provider} review
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
