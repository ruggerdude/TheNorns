import {
  ProjectExecutionTargetProjection,
  type ProjectExecutionTargetProjectionT,
} from "@norns/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, UnauthorizedError, authHeaders } from "./auth";
import "./ExecutionTargetSettings.css";
import { Alert, Badge, Button, Spinner } from "./ui";

interface ProjectAccessDecision {
  owner_user_id: string | null;
  user_id: string;
  can_access: boolean;
  source: "admin" | "owner" | "membership" | "legacy_unowned" | "none";
}

interface ExecutionTargetEnvelope {
  project_id: string;
  selected_execution_target_id: string | null;
  work_active: boolean;
  execution_targets: ProjectExecutionTargetProjectionT[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseAccess(value: unknown, projectId: string): ProjectAccessDecision {
  const candidate = record(value);
  if (
    candidate?.project_id !== projectId ||
    typeof candidate.user_id !== "string" ||
    (typeof candidate.owner_user_id !== "string" && candidate.owner_user_id !== null) ||
    candidate.can_access !== true ||
    !["admin", "owner", "membership", "legacy_unowned", "none"].includes(String(candidate.source))
  ) {
    throw new Error("Project access response is invalid.");
  }
  return candidate as unknown as ProjectAccessDecision;
}

function parseEnvelope(value: unknown, projectId: string): ExecutionTargetEnvelope {
  const candidate = record(value);
  if (
    candidate?.project_id !== projectId ||
    (typeof candidate.selected_execution_target_id !== "string" &&
      candidate.selected_execution_target_id !== null) ||
    typeof candidate.work_active !== "boolean" ||
    !Array.isArray(candidate.execution_targets)
  ) {
    throw new Error("Execution target response is invalid.");
  }

  const executionTargets = candidate.execution_targets.map((target) => {
    const parsed = ProjectExecutionTargetProjection.safeParse(target);
    if (!parsed.success) throw new Error("Execution target response is invalid.");
    return parsed.data;
  });
  const targetIds = new Set<string>();
  for (const target of executionTargets) {
    if (target.project_id !== projectId || targetIds.has(target.execution_target_id)) {
      throw new Error("Execution target response is invalid.");
    }
    targetIds.add(target.execution_target_id);
  }

  const selectedId = candidate.selected_execution_target_id;
  if (
    selectedId !== null &&
    (!targetIds.has(selectedId) ||
      executionTargets.find((target) => target.execution_target_id === selectedId)?.status
        .access !== "shared")
  ) {
    throw new Error("Execution target response is invalid.");
  }
  if (
    executionTargets.some(
      (target) => target.execution_target_id !== selectedId && target.status.access !== "pending",
    )
  ) {
    throw new Error("Execution target response is invalid.");
  }

  return {
    project_id: projectId,
    selected_execution_target_id: selectedId,
    work_active: candidate.work_active,
    execution_targets: executionTargets,
  };
}

async function requestJson(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, {
    ...init,
    credentials: "include",
    headers: {
      ...authHeaders(Boolean(init?.body)),
      ...init?.headers,
    },
  });
  if (response.status === 401) throw new UnauthorizedError();
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const failure = record(payload);
    const code = typeof failure?.error === "string" ? failure.error : null;
    const message =
      (typeof failure?.message === "string" && failure.message) ||
      (typeof failure?.detail === "string" && failure.detail) ||
      code ||
      `Execution target request failed (${response.status}).`;
    throw new ApiError(message, response.status, code);
  }
  return payload;
}

function osLabel(value: ProjectExecutionTargetProjectionT["os_family"]): string {
  return {
    macos: "macOS",
    windows: "Windows",
    linux: "Linux",
    other: "Other OS",
  }[value];
}

function lastSeen(value: string | null): string {
  if (!value) return "Never";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "Unknown";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp);
}

function humanize(value: string): string {
  return value.replaceAll("_", " ");
}

function statusTone(
  dimension: "availability" | "compatibility" | "workload",
  value: string,
): "default" | "success" | "warn" | "info" {
  if (dimension === "availability") {
    return value === "online" ? "success" : value === "connecting" ? "info" : "default";
  }
  if (dimension === "compatibility") {
    return value === "ready" ? "success" : value === "update_required" ? "warn" : "info";
  }
  return value === "busy" ? "info" : "default";
}

function TargetStatus({
  target,
}: {
  target: ProjectExecutionTargetProjectionT;
}): React.ReactElement {
  return (
    <span className="execution-target-statuses" aria-label={`${target.name} status`}>
      {(["availability", "compatibility", "workload"] as const).map((dimension) => (
        <span className="execution-target-status" key={dimension}>
          <span>{humanize(dimension)}</span>
          <Badge tone={statusTone(dimension, target.status[dimension])}>
            {humanize(target.status[dimension])}
          </Badge>
        </span>
      ))}
    </span>
  );
}

function TargetSummary({
  target,
  selected,
}: {
  target: ProjectExecutionTargetProjectionT;
  selected: boolean;
}): React.ReactElement {
  return (
    <span className="execution-target-summary">
      <span className="execution-target-heading">
        <span>
          <strong>{target.name}</strong>
          {target.location_label ? <small>{target.location_label}</small> : null}
        </span>
        <span className="execution-target-heading-badges">
          <Badge tone={selected ? "success" : "info"}>{selected ? "Current" : "Eligible"}</Badge>
          <span className="muted">{osLabel(target.os_family)}</span>
        </span>
      </span>
      <TargetStatus target={target} />
      <span className="execution-target-last-seen">
        <span>Last seen</span>
        <time dateTime={target.last_seen_at ?? undefined}>{lastSeen(target.last_seen_at)}</time>
      </span>
    </span>
  );
}

function targetErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "project_work_active") {
      return "Execution target cannot be changed while project work is active.";
    }
    if (error.code === "execution_target_changed") {
      return "The execution target changed in another session. Review the latest selection.";
    }
    if (error.status === 403) {
      return "Only the project owner can change the execution target.";
    }
    if (error.status === 404) {
      return "That execution target is no longer available to this project.";
    }
    return error.message;
  }
  return error instanceof Error ? error.message : "Execution targets could not be loaded.";
}

export function ExecutionTargetSettings({
  projectId,
  onUnauthorized,
}: {
  projectId: string;
  onUnauthorized: () => void;
}): React.ReactElement | null {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [access, setAccess] = useState<ProjectAccessDecision | null>(null);
  const [envelope, setEnvelope] = useState<ExecutionTargetEnvelope | null>(null);
  const [draftTargetId, setDraftTargetId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const requestSequence = useRef(0);
  const currentProjectId = useRef(projectId);
  currentProjectId.current = projectId;

  const load = useCallback(async (): Promise<boolean> => {
    const sequence = ++requestSequence.current;
    setLoading(true);
    setError(null);
    try {
      const [nextAccess, nextEnvelope] = await Promise.all([
        requestJson(`/api/v2/projects/${encodeURIComponent(projectId)}/access`),
        requestJson(`/api/projects/${encodeURIComponent(projectId)}/execution-targets`),
      ]);
      if (sequence !== requestSequence.current || currentProjectId.current !== projectId) {
        return false;
      }
      const parsedAccess = parseAccess(nextAccess, projectId);
      const parsedEnvelope = parseEnvelope(nextEnvelope, projectId);
      const owner =
        parsedAccess.source === "owner" &&
        parsedAccess.owner_user_id !== null &&
        parsedAccess.owner_user_id === parsedAccess.user_id;
      if (
        !owner &&
        (parsedEnvelope.execution_targets.length > 1 ||
          parsedEnvelope.execution_targets.some(
            (target) =>
              target.execution_target_id !== parsedEnvelope.selected_execution_target_id ||
              target.status.access !== "shared",
          ))
      ) {
        throw new Error("Execution target response is invalid.");
      }
      setAccess(parsedAccess);
      setEnvelope(parsedEnvelope);
      setDraftTargetId(parsedEnvelope.selected_execution_target_id);
      setAvailable(true);
      return true;
    } catch (caught) {
      if (sequence !== requestSequence.current || currentProjectId.current !== projectId) {
        return false;
      }
      if (caught instanceof UnauthorizedError) {
        onUnauthorized();
        return false;
      }
      if (caught instanceof ApiError && caught.status === 404) {
        setAvailable(false);
        setAccess(null);
        setEnvelope(null);
        return false;
      }
      setAvailable(true);
      setError(targetErrorMessage(caught));
      return false;
    } finally {
      if (sequence === requestSequence.current && currentProjectId.current === projectId) {
        setLoading(false);
      }
    }
  }, [onUnauthorized, projectId]);

  useEffect(() => {
    setAvailable(null);
    setAccess(null);
    setEnvelope(null);
    setDraftTargetId(null);
    setSaving(false);
    setError(null);
    setNotice(null);
    void load();
    return () => {
      requestSequence.current += 1;
    };
  }, [load]);

  const save = async (): Promise<void> => {
    if (
      !envelope ||
      !draftTargetId ||
      envelope.work_active ||
      access?.source !== "owner" ||
      access.owner_user_id !== access.user_id
    ) {
      return;
    }
    const projectAtStart = projectId;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const payload = await requestJson(
        `/api/projects/${encodeURIComponent(projectId)}/execution-target`,
        {
          method: "PUT",
          body: JSON.stringify({
            execution_target_id: draftTargetId,
            expected_current_execution_target_id: envelope.selected_execution_target_id,
          }),
        },
      );
      if (currentProjectId.current !== projectAtStart) return;
      const nextEnvelope = parseEnvelope(payload, projectId);
      setEnvelope(nextEnvelope);
      setDraftTargetId(nextEnvelope.selected_execution_target_id);
      setNotice(
        nextEnvelope.selected_execution_target_id === envelope.selected_execution_target_id
          ? "Execution target is already current."
          : "Execution target updated.",
      );
    } catch (caught) {
      if (currentProjectId.current !== projectAtStart) return;
      if (caught instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      if (caught instanceof ApiError && caught.code === "project_work_active") {
        setEnvelope((current) => (current ? { ...current, work_active: true } : current));
        setDraftTargetId(envelope.selected_execution_target_id);
      }
      if (
        caught instanceof ApiError &&
        (caught.code === "execution_target_changed" || caught.status === 404)
      ) {
        const reloaded = await load();
        if (reloaded && currentProjectId.current === projectAtStart) {
          setError(targetErrorMessage(caught));
        }
        return;
      }
      setError(targetErrorMessage(caught));
    } finally {
      if (currentProjectId.current === projectAtStart) setSaving(false);
    }
  };

  if (available === false) return null;

  const owner =
    access?.source === "owner" &&
    access.owner_user_id !== null &&
    access.owner_user_id === access.user_id;
  const targets = envelope?.execution_targets ?? [];

  return (
    <section
      className="card workspace-settings-card execution-target-settings"
      aria-labelledby="execution-target-heading"
    >
      <div className="section-head">
        <div>
          <div className="eyebrow">Local execution</div>
          <h2 id="execution-target-heading">Execution target</h2>
        </div>
        {access ? (
          <Badge tone={owner ? "info" : "default"}>{owner ? "Project owner" : "Read only"}</Badge>
        ) : null}
      </div>
      <p className="muted">
        Choose the computer already granted access to this project. Local paths and other computer
        details stay private.
      </p>

      {loading && envelope === null ? <Spinner label="Loading execution targets…" /> : null}
      {error ? (
        <div role="alert">
          <Alert>{error}</Alert>
        </div>
      ) : null}
      {notice ? (
        <output className="execution-target-notice" aria-live="polite">
          {notice}
        </output>
      ) : null}

      {!loading && envelope && targets.length === 0 ? (
        <p className="execution-target-empty">
          No eligible local execution target is currently granted to this project.
        </p>
      ) : null}

      {envelope && targets.length > 0 ? (
        owner ? (
          <fieldset
            className="execution-target-fieldset"
            disabled={saving || envelope.work_active}
            aria-describedby={envelope.work_active ? "execution-target-active-work" : undefined}
          >
            <legend className="sr-only">Eligible project execution targets</legend>
            <div className="execution-target-list">
              {targets.map((target) => {
                const selected =
                  target.execution_target_id === envelope.selected_execution_target_id;
                return (
                  <label
                    className={`execution-target-option${
                      draftTargetId === target.execution_target_id ? " is-chosen" : ""
                    }`}
                    key={target.execution_target_id}
                  >
                    <input
                      type="radio"
                      name={`execution-target-${projectId}`}
                      value={target.execution_target_id}
                      checked={draftTargetId === target.execution_target_id}
                      onChange={() => {
                        setDraftTargetId(target.execution_target_id);
                        setNotice(null);
                      }}
                    />
                    <TargetSummary target={target} selected={selected} />
                  </label>
                );
              })}
            </div>
          </fieldset>
        ) : (
          <>
            <p className="execution-target-read-only">
              Only the project owner can change this setting.
            </p>
            <ul className="execution-target-list execution-target-read-only-list">
              {targets.map((target) => (
                <li className="execution-target-option" key={target.execution_target_id}>
                  <TargetSummary
                    target={target}
                    selected={target.execution_target_id === envelope.selected_execution_target_id}
                  />
                </li>
              ))}
            </ul>
          </>
        )
      ) : null}

      {owner && envelope?.work_active ? (
        <output id="execution-target-active-work" className="execution-target-active-work">
          Target changes are blocked while project work is active.
        </output>
      ) : null}

      {owner && envelope && targets.length > 0 ? (
        <div className="settings-save-row execution-target-save-row">
          <span className="muted">
            Changing target creates a new immutable binding for future work.
          </span>
          <Button
            variant="primary"
            disabled={
              saving ||
              envelope.work_active ||
              !draftTargetId ||
              draftTargetId === envelope.selected_execution_target_id
            }
            onClick={() => void save()}
          >
            {saving ? "Saving target…" : "Save execution target"}
          </Button>
        </div>
      ) : null}

      {!loading && error && envelope === null ? (
        <Button className="execution-target-retry" onClick={() => void load()}>
          Retry
        </Button>
      ) : null}
    </section>
  );
}
