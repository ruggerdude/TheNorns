// The sole point of entry: list your projects, create a new one (name,
// description, PM provider — the reviewer always auto-flips to the other
// provider so cross-provider review holds), and open one to plan/edit/allocate.
import { useCallback, useEffect, useState } from "react";
import { ApiError, UnauthorizedError, authHeaders } from "./auth";

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

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: authHeaders() });
  if (res.status === 401) throw new UnauthorizedError();
  const json = (await res.json()) as T & { message?: string };
  if (!res.ok) throw new ApiError(json.message ?? `request failed: ${res.status}`, res.status);
  return json;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: authHeaders(true),
    body: JSON.stringify(body),
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
}: {
  onOpenProject: (project: ProjectSummary) => void;
  onUnauthorized: () => void;
  onSignOut: () => void;
}): React.ReactElement {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [pmProvider, setPmProvider] = useState<"anthropic" | "openai">("anthropic");
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      setProjects(await getJson<ProjectSummary[]>("/api/projects"));
    } catch (err) {
      if (err instanceof UnauthorizedError) onUnauthorized();
      else setError(err instanceof Error ? err.message : String(err));
    }
  }, [onUnauthorized]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const create = useCallback(async () => {
    setCreating(true);
    setError(null);
    try {
      const project = await postJson<ProjectSummary>("/api/projects", {
        name,
        description,
        pm_provider: pmProvider,
      });
      setName("");
      setDescription("");
      onOpenProject(project);
    } catch (err) {
      if (err instanceof UnauthorizedError) onUnauthorized();
      else setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }, [name, description, pmProvider, onOpenProject, onUnauthorized]);

  return (
    <div
      style={{
        maxWidth: 720,
        margin: "40px auto",
        fontFamily: "ui-monospace, monospace",
        padding: "0 16px 40px",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1 style={{ margin: 0 }}>TheNorns</h1>
        <button type="button" onClick={onSignOut} style={{ fontSize: 11, color: "#666" }}>
          sign out
        </button>
      </div>
      {error ? (
        <div data-testid="projects-error" style={{ color: "#b91c1c", margin: "8px 0" }}>
          {error}
        </div>
      ) : null}

      <h3>New Project</h3>
      <input
        data-testid="project-name"
        placeholder="Project name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        style={{ width: "100%", marginBottom: 6, fontFamily: "inherit" }}
      />
      <textarea
        data-testid="project-description"
        placeholder="Describe what this project should build"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        style={{ width: "100%", height: 60, fontFamily: "inherit", fontSize: 13 }}
      />
      <div style={{ margin: "6px 0" }}>
        PM:{" "}
        <select
          data-testid="pm-provider"
          value={pmProvider}
          onChange={(e) => setPmProvider(e.target.value as "anthropic" | "openai")}
        >
          <option value="anthropic">Anthropic (Claude)</option>
          <option value="openai">OpenAI</option>
        </select>{" "}
        <span style={{ color: "#666", fontSize: 12 }}>
          reviewer: {pmProvider === "anthropic" ? "OpenAI" : "Anthropic"} (cross-provider by policy)
        </span>
      </div>
      <button
        type="button"
        disabled={creating || !name.trim() || !description.trim()}
        onClick={() => void create()}
      >
        {creating ? "Creating…" : "Create Project"}
      </button>

      <h3 style={{ marginTop: 24 }}>Your Projects</h3>
      {projects === null ? (
        <p style={{ color: "#666" }}>Loading…</p>
      ) : projects.length === 0 ? (
        <p style={{ color: "#666" }}>No projects yet — create one above.</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0 }} data-testid="project-list">
          {projects.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => onOpenProject(p)}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  border: "1px solid #ddd",
                  borderRadius: 8,
                  padding: 12,
                  marginBottom: 8,
                  cursor: "pointer",
                  background: "#fff",
                  fontFamily: "inherit",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <strong>{p.name}</strong>
                  <span
                    style={{ fontSize: 11, color: p.status === "planned" ? "#047857" : "#999" }}
                  >
                    {p.status}
                  </span>
                </div>
                <div style={{ fontSize: 12, color: "#666" }}>{p.description}</div>
                <div style={{ fontSize: 11, color: "#999" }}>
                  PM: {p.pm_provider} · reviewer: {p.reviewer_provider}
                  {p.plan_objective ? ` · "${p.plan_objective}"` : ""}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
