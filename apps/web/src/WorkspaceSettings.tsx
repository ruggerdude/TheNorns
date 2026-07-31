import { Suspense, lazy, useEffect, useState } from "react";
import { ApiError, UnauthorizedError, authHeaders } from "./auth";
import { Alert, Button, Field, Select, Spinner, TextArea } from "./ui";
import {
  type UpdateDetailLevel,
  type UpdateIntervalSeconds,
  type UpdatePreferences,
  loadGlobalUpdatePreferences,
  loadProjectUpdatePreferences,
  saveGlobalUpdatePreferences,
  saveProjectUpdatePreferences,
} from "./workspacePreferences";

const ExecutionTargetSettings = lazy(() =>
  import("./ExecutionTargetSettings").then(({ ExecutionTargetSettings }) => ({
    default: ExecutionTargetSettings,
  })),
);

interface ProjectRulesDto {
  filename: string;
  content: string;
  version: number;
  updated_at: string | null;
}

const rulesCache = new Map<string, Promise<ProjectRulesDto>>();

async function rulesRequest(
  projectId: string,
  method: "GET" | "PUT",
  content?: string,
): Promise<ProjectRulesDto> {
  const response = await fetch(`/api/v2/projects/${projectId}/rules`, {
    method,
    headers: authHeaders(method === "PUT"),
    ...(method === "PUT" ? { body: JSON.stringify({ content: content ?? "" }) } : {}),
  });
  if (response.status === 401) throw new UnauthorizedError();
  const body = (await response.json().catch(() => ({}))) as ProjectRulesDto & {
    message?: string;
  };
  if (!response.ok) {
    throw new ApiError(body.message ?? `request failed: ${response.status}`, response.status);
  }
  return body;
}

/** Call when a project workspace opens so rules are warm by the time Settings is visited. */
export function prefetchProjectRules(projectId: string): void {
  if (rulesCache.has(projectId)) return;
  const promise = rulesRequest(projectId, "GET").catch(() => {
    rulesCache.delete(projectId);
    return null as unknown as ProjectRulesDto;
  });
  rulesCache.set(projectId, promise);
}

async function archiveProjectRequest(projectId: string): Promise<void> {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (response.status === 401) throw new UnauthorizedError();
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      detail?: string;
      message?: string;
    };
    throw new ApiError(
      body.message ?? body.detail ?? `request failed: ${response.status}`,
      response.status,
    );
  }
}

async function deleteProjectRequest(projectId: string): Promise<void> {
  const response = await fetch(`/api/v2/projects/${encodeURIComponent(projectId)}/destroy`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (response.status === 401) throw new UnauthorizedError();
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      detail?: string;
      message?: string;
    };
    throw new ApiError(
      body.message ?? body.detail ?? `request failed: ${response.status}`,
      response.status,
    );
  }
}

const intervalOptions: Array<{ value: UpdateIntervalSeconds; label: string }> = [
  { value: 60, label: "Every minute" },
  { value: 300, label: "Every 5 minutes" },
  { value: 900, label: "Every 15 minutes" },
];

const detailOptions: Array<{ value: UpdateDetailLevel; label: string }> = [
  { value: "summary", label: "Progress summary" },
  { value: "detailed", label: "Detailed progress, costs, and completions" },
  { value: "attention", label: "Only blockers and decisions" },
];

function PreferenceFields({
  value,
  onChange,
  prefix,
}: {
  value: UpdatePreferences;
  onChange: (value: UpdatePreferences) => void;
  prefix: string;
}): React.ReactElement {
  return (
    <div className="update-preference-fields">
      <Field label={`${prefix} timing`}>
        <Select
          value={value.intervalSeconds}
          onChange={(event) =>
            onChange({
              ...value,
              intervalSeconds: Number(event.target.value) as UpdateIntervalSeconds,
            })
          }
        >
          {intervalOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={`${prefix} content`}>
        <Select
          value={value.detailLevel}
          onChange={(event) =>
            onChange({ ...value, detailLevel: event.target.value as UpdateDetailLevel })
          }
        >
          {detailOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      </Field>
    </div>
  );
}

export function WorkspaceSettings({
  projectId,
  projectName,
  onProjectArchived,
  onPreferencesChanged,
  onUnauthorized,
}: {
  projectId: string;
  projectName: string;
  onProjectArchived: (projectId: string) => void;
  onPreferencesChanged: (preferences: UpdatePreferences) => void;
  onUnauthorized: () => void;
}): React.ReactElement {
  const [rules, setRules] = useState<ProjectRulesDto | null>(null);
  const [rulesDraft, setRulesDraft] = useState("");
  const [rulesSaving, setRulesSaving] = useState(false);
  const [globalDraft, setGlobalDraft] = useState(loadGlobalUpdatePreferences);
  const projectStored = loadProjectUpdatePreferences(projectId);
  const [inheritGlobal, setInheritGlobal] = useState(projectStored === null);
  const [projectDraft, setProjectDraft] = useState<UpdatePreferences>(
    projectStored ?? loadGlobalUpdatePreferences(),
  );
  const [preferencesSaved, setPreferencesSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [archivingProject, setArchivingProject] = useState(false);
  const [deletingProject, setDeletingProject] = useState(false);

  useEffect(() => {
    let current = true;
    const cached = rulesCache.get(projectId);
    const promise = cached ?? rulesRequest(projectId, "GET");
    if (cached) rulesCache.delete(projectId);
    void promise
      .then((next) => {
        if (!current) return;
        setRules(next);
        setRulesDraft(next.content);
      })
      .catch((caught) => {
        if (!current) return;
        if (caught instanceof UnauthorizedError) onUnauthorized();
        else setError(caught instanceof Error ? caught.message : String(caught));
      });
    return () => {
      current = false;
    };
  }, [projectId, onUnauthorized]);

  const saveRules = async () => {
    setRulesSaving(true);
    setError(null);
    try {
      const next = await rulesRequest(projectId, "PUT", rulesDraft);
      setRules(next);
      setRulesDraft(next.content);
    } catch (caught) {
      if (caught instanceof UnauthorizedError) onUnauthorized();
      else setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRulesSaving(false);
    }
  };

  const savePreferences = () => {
    saveGlobalUpdatePreferences(globalDraft);
    saveProjectUpdatePreferences(projectId, inheritGlobal ? null : projectDraft);
    const resolved = inheritGlobal ? globalDraft : projectDraft;
    onPreferencesChanged(resolved);
    setPreferencesSaved(true);
  };

  const archiveProject = async () => {
    const confirmed = window.confirm(
      `Archive "${projectName}"?\n\nIt will leave Portfolio and the active project menu. Its GitHub repository and history are preserved, and an admin can unarchive it later. Projects with active work cannot be archived.`,
    );
    if (!confirmed) return;

    setArchivingProject(true);
    setError(null);
    try {
      await archiveProjectRequest(projectId);
      onProjectArchived(projectId);
    } catch (caught) {
      if (caught instanceof UnauthorizedError) onUnauthorized();
      else setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setArchivingProject(false);
    }
  };

  const deleteProject = async () => {
    const confirmed = window.confirm(
      `Permanently delete "${projectName}"?\n\nThis cannot be undone. All project data including plans, phases, and history will be permanently removed.`,
    );
    if (!confirmed) return;

    setDeletingProject(true);
    setError(null);
    try {
      await deleteProjectRequest(projectId);
      onProjectArchived(projectId);
    } catch (caught) {
      if (caught instanceof UnauthorizedError) onUnauthorized();
      else setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setDeletingProject(false);
    }
  };

  return (
    <div className="workspace-settings-grid" data-testid="workspace-settings">
      <Suspense fallback={<Spinner label="Loading execution target settings…" />}>
        <ExecutionTargetSettings projectId={projectId} onUnauthorized={onUnauthorized} />
      </Suspense>

      <section className="card workspace-settings-card" aria-labelledby="updates-heading">
        <div className="section-head">
          <div>
            <div className="eyebrow">Progress updates</div>
            <h2 id="updates-heading">Timing and content</h2>
          </div>
        </div>
        <p className="muted">
          Set the normal update cadence once, then override it only for projects that need different
          attention.
        </p>
        <div className="settings-preference-group">
          <h3>Global default</h3>
          <PreferenceFields value={globalDraft} onChange={setGlobalDraft} prefix="Default" />
        </div>
        <div className="settings-preference-group">
          <label className="debate-toggle">
            <input
              type="checkbox"
              checked={inheritGlobal}
              onChange={(event) => {
                setInheritGlobal(event.target.checked);
                setPreferencesSaved(false);
              }}
            />
            Use the global default for this project
          </label>
          {!inheritGlobal ? (
            <PreferenceFields value={projectDraft} onChange={setProjectDraft} prefix="Project" />
          ) : null}
        </div>
        <div className="settings-save-row">
          <span className="muted">
            {preferencesSaved ? "Update preferences saved" : "Changes apply to workspace updates"}
          </span>
          <Button variant="primary" onClick={savePreferences}>
            Save update preferences
          </Button>
        </div>
      </section>

      <section className="card workspace-settings-card" aria-labelledby="project-rules-heading">
        <div className="section-head">
          <div>
            <div className="eyebrow">Project rules</div>
            <h2 id="project-rules-heading">{rules?.filename ?? "NORN.md"}</h2>
          </div>
          {rules?.version ? <span className="mono muted">v{rules.version}</span> : null}
        </div>
        <p className="muted">
          Markdown instructions in this file are included in every future agent briefing for this
          project, like a project-level CLAUDE.md.
        </p>
        {!rules ? (
          <Spinner label="Loading project rules…" />
        ) : (
          <>
            <TextArea
              className="project-rules-editor"
              aria-label="Project rules"
              value={rulesDraft}
              placeholder={
                "# Project rules\n\n- Run the complete test suite before committing.\n- Preserve public API compatibility."
              }
              onChange={(event) => setRulesDraft(event.target.value)}
            />
            <div className="settings-save-row">
              <span className="muted">
                {rules.updated_at
                  ? `Last saved ${new Date(rules.updated_at).toLocaleString()}`
                  : "No project-specific rules yet"}
              </span>
              <Button
                variant="primary"
                disabled={rulesSaving || rulesDraft.trim() === rules.content}
                onClick={() => void saveRules()}
              >
                {rulesSaving ? "Saving…" : "Save rules"}
              </Button>
            </div>
          </>
        )}
      </section>

      <section
        className="card workspace-settings-card workspace-settings-danger"
        aria-labelledby="remove-project-heading"
      >
        <div className="section-head">
          <div>
            <div className="eyebrow">Danger zone</div>
            <h2 id="remove-project-heading">Remove project</h2>
          </div>
        </div>
        <p className="muted">
          Archive removes the project from Portfolio while preserving its data. Delete permanently
          removes all project data and cannot be undone.
        </p>
        <div className="settings-save-row">
          <span className="muted">Projects with active work cannot be archived.</span>
          <Button
            variant="danger"
            disabled={archivingProject}
            onClick={() => void archiveProject()}
          >
            {archivingProject ? "Archiving…" : "Archive project"}
          </Button>
        </div>
        <div className="settings-save-row">
          <span className="muted">This action is permanent and cannot be undone.</span>
          <Button
            variant="danger"
            disabled={deletingProject}
            onClick={() => void deleteProject()}
          >
            {deletingProject ? "Deleting…" : "Delete project"}
          </Button>
        </div>
      </section>
      {error ? <Alert>{error}</Alert> : null}
    </div>
  );
}
