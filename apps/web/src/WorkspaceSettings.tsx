import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./UtilitySurfaces.css";
import { QC_MODE_OPTIONS, type QcModeT } from "./Projects";
import { ApiError, UnauthorizedError, authHeaders } from "./auth";
import { Alert, Button, Field, Select, Spinner, TextArea } from "./ui";
import {
  UPDATE_DETAIL_OPTIONS,
  UPDATE_INTERVAL_OPTIONS,
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

// QCP-12: the project-layer QC settings, read/written through the same
// route Projects.tsx's New Project wizard already uses
// (PATCH /api/v2/projects/:id/planning-reviewer). Only the fields this panel
// edits are modeled here — reviewer provider/model selection has its own
// route behavior and no post-creation UI yet.
interface PlanningQcSettingsDto {
  qc_mode: QcModeT;
  allow_unadjudicated_rebuttals: boolean;
  default_max_rounds: number;
}

async function planningQcSettingsRequest(
  projectId: string,
  method: "GET" | "PATCH",
  body?: PlanningQcSettingsDto,
): Promise<PlanningQcSettingsDto> {
  const response = await fetch(`/api/v2/projects/${projectId}/planning-reviewer`, {
    method,
    headers: authHeaders(method === "PATCH"),
    ...(method === "PATCH" ? { body: JSON.stringify(body) } : {}),
  });
  if (response.status === 401) throw new UnauthorizedError();
  const payload = (await response.json().catch(() => ({}))) as Partial<PlanningQcSettingsDto> & {
    message?: string;
  };
  if (!response.ok) {
    throw new ApiError(payload.message ?? `request failed: ${response.status}`, response.status);
  }
  // PATCH replies 204/no body; GET is the only caller that needs the payload.
  return payload as PlanningQcSettingsDto;
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

interface ProjectDeletionOptionsDto {
  project_name: string;
  local_folder: { available: boolean; label: string | null };
  github_repository: { available: boolean; label: string | null };
}

interface ProjectDeletionSelection {
  delete_local_folder: boolean;
  delete_github_repository: boolean;
}

async function projectDeletionOptionsRequest(
  projectId: string,
): Promise<ProjectDeletionOptionsDto> {
  const response = await fetch(
    `/api/v2/projects/${encodeURIComponent(projectId)}/deletion-options`,
    { headers: authHeaders() },
  );
  if (response.status === 401) throw new UnauthorizedError();
  const body = (await response.json().catch(() => ({}))) as Partial<ProjectDeletionOptionsDto> & {
    detail?: string;
    message?: string;
  };
  if (!response.ok) {
    throw new ApiError(
      body.message ?? body.detail ?? `request failed: ${response.status}`,
      response.status,
    );
  }
  return body as ProjectDeletionOptionsDto;
}

async function deleteProjectRequest(
  projectId: string,
  selection: ProjectDeletionSelection,
): Promise<void> {
  const response = await fetch(`/api/v2/projects/${encodeURIComponent(projectId)}/destroy`, {
    method: "DELETE",
    headers: authHeaders(true),
    body: JSON.stringify(selection),
  });
  if (response.status === 401) throw new UnauthorizedError();
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      detail?: string;
      error?: string;
      message?: string;
    };
    throw new ApiError(
      body.message ?? body.detail ?? `request failed: ${response.status}`,
      response.status,
      body.error ?? null,
    );
  }
}

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
          {UPDATE_INTERVAL_OPTIONS.map((option) => (
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
          {UPDATE_DETAIL_OPTIONS.map((option) => (
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
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<Error | null>(null);
  const [deletionOptions, setDeletionOptions] = useState<ProjectDeletionOptionsDto | null>(null);
  const [deleteLocalFolder, setDeleteLocalFolder] = useState(false);
  const [deleteGitHubRepository, setDeleteGitHubRepository] = useState(false);

  const onUnauthorizedRef = useRef(onUnauthorized);
  onUnauthorizedRef.current = onUnauthorized;
  const handleUnauthorized = useCallback(() => onUnauthorizedRef.current(), []);

  const [qcSettings, setQcSettings] = useState<PlanningQcSettingsDto | null>(null);
  const [qcMode, setQcMode] = useState<QcModeT>("automatic");
  const [qcRounds, setQcRounds] = useState(1);
  const [qcRebuttals, setQcRebuttals] = useState(false);
  const [qcSaving, setQcSaving] = useState(false);
  const [qcSaved, setQcSaved] = useState(false);

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
        if (caught instanceof UnauthorizedError) handleUnauthorized();
        else setError(caught instanceof Error ? caught.message : String(caught));
      });
    return () => {
      current = false;
    };
  }, [projectId, handleUnauthorized]);

  useEffect(() => {
    let current = true;
    void planningQcSettingsRequest(projectId, "GET")
      .then((next) => {
        if (!current) return;
        setQcSettings(next);
        setQcMode(next.qc_mode);
        setQcRounds(next.default_max_rounds);
        setQcRebuttals(next.allow_unadjudicated_rebuttals);
      })
      .catch((caught) => {
        if (!current) return;
        if (caught instanceof UnauthorizedError) handleUnauthorized();
        else setError(caught instanceof Error ? caught.message : String(caught));
      });
    return () => {
      current = false;
    };
  }, [projectId, handleUnauthorized]);

  const saveQcSettings = async () => {
    setQcSaving(true);
    setError(null);
    setQcSaved(false);
    const body: PlanningQcSettingsDto = {
      qc_mode: qcMode,
      allow_unadjudicated_rebuttals: qcRebuttals,
      default_max_rounds: qcRounds,
    };
    try {
      await planningQcSettingsRequest(projectId, "PATCH", body);
      setQcSettings(body);
      setQcSaved(true);
    } catch (caught) {
      if (caught instanceof UnauthorizedError) handleUnauthorized();
      else setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setQcSaving(false);
    }
  };

  const saveRules = async () => {
    setRulesSaving(true);
    setError(null);
    try {
      const next = await rulesRequest(projectId, "PUT", rulesDraft);
      setRules(next);
      setRulesDraft(next.content);
    } catch (caught) {
      if (caught instanceof UnauthorizedError) handleUnauthorized();
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
      if (caught instanceof UnauthorizedError) handleUnauthorized();
      else setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setArchivingProject(false);
    }
  };

  const openDeleteDialog = async () => {
    setDeleteDialogOpen(true);
    setDeletionOptions(null);
    setDeleteLocalFolder(false);
    setDeleteGitHubRepository(false);
    setDeleteError(null);
    setError(null);
    try {
      setDeletionOptions(await projectDeletionOptionsRequest(projectId));
    } catch (caught) {
      if (caught instanceof UnauthorizedError) handleUnauthorized();
      else setError(caught instanceof Error ? caught.message : String(caught));
      setDeleteDialogOpen(false);
    }
  };

  const deleteProject = async () => {
    setDeletingProject(true);
    setDeleteError(null);
    setError(null);
    try {
      await deleteProjectRequest(projectId, {
        delete_local_folder: deleteLocalFolder,
        delete_github_repository: deleteGitHubRepository,
      });
      setDeleteDialogOpen(false);
      onProjectArchived(projectId);
    } catch (caught) {
      if (caught instanceof UnauthorizedError) handleUnauthorized();
      else setDeleteError(caught instanceof Error ? caught : new Error(String(caught)));
    } finally {
      setDeletingProject(false);
    }
  };

  return (
    <div className="workspace-settings-grid" data-testid="workspace-settings">
      <Suspense fallback={<Spinner label="Loading execution target settings…" />}>
        <ExecutionTargetSettings projectId={projectId} onUnauthorized={handleUnauthorized} />
      </Suspense>

      <section
        className="card workspace-settings-card"
        aria-labelledby="qc-settings-heading"
        data-testid="qc-settings-card"
      >
        <div className="section-head">
          <div>
            <div className="eyebrow">Quality control</div>
            <h2 id="qc-settings-heading">QC review</h2>
          </div>
        </div>
        {qcSettings === null ? (
          <Spinner label="Loading QC settings…" />
        ) : (
          <>
            <div className="qc-settings-fields">
              <Field label="Reviews">
                {/* QCP-14: 0 is allowed here too now — it means review is off,
                  matching the wizard's pre-creation control. */}
                <div className="rounds-stepper" data-testid="qc-settings-rounds">
                  <Button
                    type="button"
                    className="btn-small"
                    disabled={qcRounds <= 0}
                    onClick={() => {
                      setQcRounds((count) => Math.max(0, count - 1));
                      setQcSaved(false);
                    }}
                    aria-label="Fewer rounds"
                  >
                    −
                  </Button>
                  <span className="rounds-value mono">{qcRounds}</span>
                  <Button
                    type="button"
                    className="btn-small"
                    disabled={qcRounds >= 5}
                    onClick={() => {
                      setQcRounds((count) => Math.min(5, count + 1));
                      setQcSaved(false);
                    }}
                    aria-label="More rounds"
                  >
                    +
                  </Button>
                </div>
                <span className="muted">
                  {qcRounds === 1
                    ? "Routine · one reviewer/PM cycle"
                    : qcRounds === 2
                      ? "High-risk · includes an independent recheck"
                      : qcRounds === 0
                        ? "QC is off"
                        : `${qcRounds} review cycles`}
                </span>
              </Field>
              <Field label="Pause mode">
                <div className="qc-mode-control">
                  <Select
                    data-testid="qc-settings-mode"
                    value={qcMode}
                    disabled={qcRounds === 0}
                    onChange={(event) => {
                      setQcMode(event.target.value as QcModeT);
                      setQcSaved(false);
                    }}
                  >
                    {QC_MODE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </Select>
                  <label className="qc-inline-toggle">
                    <input
                      type="checkbox"
                      data-testid="qc-settings-rebuttals"
                      checked={qcRebuttals}
                      disabled={qcRounds === 0}
                      onChange={(event) => {
                        setQcRebuttals(event.target.checked);
                        setQcSaved(false);
                      }}
                    />
                    Allow rebuttals
                  </label>
                </div>
              </Field>
            </div>
            <div className="settings-save-row">
              <span className="muted">{qcSaved ? "Saved" : null}</span>
              <Button
                variant="primary"
                data-testid="qc-settings-save"
                disabled={qcSaving}
                onClick={() => void saveQcSettings()}
              >
                {qcSaving ? "Saving…" : "Save QC settings"}
              </Button>
            </div>
          </>
        )}
      </section>

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
            onClick={() => void openDeleteDialog()}
          >
            Delete project
          </Button>
        </div>
      </section>
      {deleteDialogOpen
        ? createPortal(
            <div className="confirmation-backdrop" role="presentation">
              <dialog
                open
                className="card confirmation-dialog"
                aria-labelledby="delete-project-title"
                aria-describedby="delete-project-description"
              >
                <div>
                  <div className="eyebrow">Are you sure?</div>
                  <h2 id="delete-project-title">Delete {projectName}?</h2>
                </div>
                <p id="delete-project-description">
                  This permanently deletes the project, its plans, and its history.
                </p>
                {deletionOptions === null ? (
                  <Spinner label="Checking linked project files…" />
                ) : (
                  <div className="delete-resource-options">
                    {deletionOptions.local_folder.available ? (
                      <label>
                        <input
                          type="checkbox"
                          checked={deleteLocalFolder}
                          onChange={(event) => setDeleteLocalFolder(event.target.checked)}
                        />
                        <span>
                          Delete local folder
                          {deletionOptions.local_folder.label ? (
                            <small>{deletionOptions.local_folder.label}</small>
                          ) : null}
                        </span>
                      </label>
                    ) : null}
                    {deletionOptions.github_repository.available ? (
                      <label>
                        <input
                          type="checkbox"
                          checked={deleteGitHubRepository}
                          onChange={(event) => setDeleteGitHubRepository(event.target.checked)}
                        />
                        <span>
                          Delete GitHub repository
                          {deletionOptions.github_repository.label ? (
                            <small>{deletionOptions.github_repository.label}</small>
                          ) : null}
                        </span>
                      </label>
                    ) : null}
                  </div>
                )}
                {deletingProject ? (
                  <output className="delete-project-progress">
                    {deleteGitHubRepository
                      ? "Deleting the linked GitHub repository and project… This can take a moment."
                      : deleteLocalFolder
                        ? "Deleting the local folder and project… This can take a moment."
                        : "Deleting the project…"}
                  </output>
                ) : null}
                {deleteError ? <Alert>{deleteError.message}</Alert> : null}
                {deleteError instanceof ApiError &&
                deleteError.code === "github_app_permission_missing" ? (
                  <div className="delete-project-remediation">
                    <p>
                      A GitHub App owner must add <strong>Administration: write</strong>, save the
                      app, and accept the pending permission update on this installation.
                    </p>
                    <p>
                      <a href="https://github.com/settings/apps" target="_blank" rel="noreferrer">
                        Open GitHub App settings
                      </a>{" "}
                      ·{" "}
                      <a
                        href="https://github.com/settings/installations"
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open installed GitHub Apps
                      </a>
                    </p>
                    <Button
                      onClick={() => {
                        setDeleteGitHubRepository(false);
                        setDeleteError(null);
                      }}
                    >
                      Keep GitHub repository instead
                    </Button>
                  </div>
                ) : null}
                <div className="confirmation-actions">
                  <Button
                    disabled={deletingProject}
                    onClick={() => {
                      setDeleteDialogOpen(false);
                      setDeleteError(null);
                    }}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="danger"
                    disabled={deletingProject || deletionOptions === null}
                    onClick={() => void deleteProject()}
                  >
                    {deletingProject ? "Deleting…" : "Yes, delete project"}
                  </Button>
                </div>
              </dialog>
            </div>,
            document.body,
          )
        : null}
      {error ? <Alert>{error}</Alert> : null}
    </div>
  );
}
