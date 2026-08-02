import { useCallback, useEffect, useState } from "react";
import "./UtilitySurfaces.css";
import { ApiError, UnauthorizedError, authHeaders } from "./auth";
import { Alert, Badge, Button, Spinner, TextArea } from "./ui";

interface GlobalRulesDto {
  filename: "NORN.md";
  content: string;
  version: number;
  updated_at: string | null;
}

interface ArchivedProjectSummary {
  id: string;
  name: string;
  description: string;
  archived_at: string;
}

async function settingsRequest<T>(
  method: "GET" | "POST" | "PUT",
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: "include",
    headers: authHeaders(body !== undefined),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (response.status === 401) throw new UnauthorizedError();
  const payload = (await response.json().catch(() => ({}))) as T & {
    error?: string;
    message?: string;
  };
  if (!response.ok) {
    throw new ApiError(
      payload.message ?? payload.error ?? `request failed: ${response.status}`,
      response.status,
    );
  }
  return payload;
}

export function GlobalRulesSettings({
  onUnauthorized,
}: {
  onUnauthorized: () => void;
}): React.ReactElement {
  const [rules, setRules] = useState<GlobalRulesDto | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fail = useCallback(
    (caught: unknown) => {
      if (caught instanceof UnauthorizedError) onUnauthorized();
      else setError(caught instanceof Error ? caught.message : String(caught));
    },
    [onUnauthorized],
  );

  useEffect(() => {
    let current = true;
    void settingsRequest<GlobalRulesDto>("GET", "/api/v2/admin/rules")
      .then((next) => {
        if (!current) return;
        setRules(next);
        setDraft(next.content);
      })
      .catch((caught) => {
        if (current) fail(caught);
      });
    return () => {
      current = false;
    };
  }, [fail]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const next = await settingsRequest<GlobalRulesDto>("PUT", "/api/v2/admin/rules", {
        content: draft,
      });
      setRules(next);
      setDraft(next.content);
    } catch (caught) {
      fail(caught);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="admin-global-rules" data-testid="global-rules-settings">
      <div className="section-head">
        <div>
          <div className="eyebrow">Global agent rules</div>
          <h3>{rules?.filename ?? "NORN.md"}</h3>
        </div>
        {rules?.version ? <span className="mono muted">v{rules.version}</span> : null}
      </div>
      <p className="muted">
        These instructions are included in every project briefing. A project’s own NORN.md can add
        more specific rules.
      </p>
      {error ? <Alert>{error}</Alert> : null}
      {rules ? (
        <>
          <TextArea
            className="global-rules-editor"
            aria-label="Global NORN.md"
            value={draft}
            placeholder="# Global rules&#10;&#10;- Share a concise progress update every five minutes."
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className="settings-save-row">
            <span className="muted">
              {rules.updated_at
                ? `Last saved ${new Date(rules.updated_at).toLocaleString()}`
                : "No global rules yet"}
            </span>
            <Button
              variant="primary"
              disabled={saving || draft.trim() === rules.content.trim()}
              onClick={() => void save()}
            >
              {saving ? "Saving…" : "Save global rules"}
            </Button>
          </div>
        </>
      ) : error ? null : (
        <Spinner label="Loading global rules…" />
      )}
    </div>
  );
}

export function ArchivedProjectsSettings({
  onUnauthorized,
}: {
  onUnauthorized: () => void;
}): React.ReactElement {
  const [projects, setProjects] = useState<ArchivedProjectSummary[] | null>(null);
  const [restoringProjectId, setRestoringProjectId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fail = useCallback(
    (caught: unknown) => {
      if (caught instanceof UnauthorizedError) onUnauthorized();
      else setError(caught instanceof Error ? caught.message : String(caught));
    },
    [onUnauthorized],
  );

  const refresh = useCallback(async () => {
    setError(null);
    try {
      setProjects(
        await settingsRequest<ArchivedProjectSummary[]>("GET", "/api/admin/projects/archived"),
      );
    } catch (caught) {
      fail(caught);
    }
  }, [fail]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const restore = async (project: ArchivedProjectSummary) => {
    if (
      !window.confirm(
        `Unarchive "${project.name}"?\n\nIt will return to Portfolio and the active project menu.`,
      )
    ) {
      return;
    }
    setRestoringProjectId(project.id);
    setError(null);
    try {
      await settingsRequest(
        "POST",
        `/api/admin/projects/${encodeURIComponent(project.id)}/restore`,
      );
      await refresh();
    } catch (caught) {
      fail(caught);
    } finally {
      setRestoringProjectId(null);
    }
  };

  return (
    <section
      className="card admin-archived-projects"
      aria-labelledby="archived-projects-heading"
      data-testid="archive-settings"
    >
      <div className="section-head">
        <div>
          <div className="eyebrow">Project recovery</div>
          <h3 id="archived-projects-heading">Archived projects</h3>
        </div>
        <Badge tone="info">{projects?.length ?? 0}</Badge>
      </div>
      {error ? <Alert>{error}</Alert> : null}
      {projects === null ? (
        error ? null : (
          <Spinner label="Loading archived projects…" />
        )
      ) : projects.length === 0 ? (
        <p className="muted">No archived projects.</p>
      ) : (
        <ul className="admin-archived-list" data-testid="archived-project-list">
          {projects.map((project) => (
            <li key={project.id}>
              <div>
                <strong>{project.name}</strong>
                <small>Archived {new Date(project.archived_at).toLocaleDateString()}</small>
              </div>
              <Button
                className="btn-small"
                disabled={restoringProjectId === project.id}
                onClick={() => void restore(project)}
              >
                {restoringProjectId === project.id ? "Unarchiving…" : "Unarchive"}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
