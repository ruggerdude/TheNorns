import {
  LegacyRepositoryBindingClaimProjection,
  type LegacyRepositoryBindingClaimProjectionT,
  ProjectExecutionTargetProjection,
  type ProjectExecutionTargetProjectionT,
} from "@norns/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, UnauthorizedError, authHeaders } from "./auth";
import "./ExecutionTargetSettings.css";
import { loadLocalExecutionCapabilities } from "./localExecutionCapabilities";
import { Alert, Badge, Button, Field, Input, Spinner } from "./ui";

interface ProjectAccessDecision {
  owner_user_id: string | null;
  user_id: string;
  can_access: boolean;
  source: "admin" | "owner" | "membership" | "legacy_unowned" | "none";
}

interface ExecutionTargetEnvelope {
  project_id: string;
  viewer_role: "owner" | "member";
  selected_execution_target_id: string | null;
  work_active: boolean;
  execution_targets: ProjectExecutionTargetProjectionT[];
  legacy_claim_required: boolean;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hasExactKeys(candidate: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(candidate);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
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

function parseTarget(value: unknown, projectId: string): ProjectExecutionTargetProjectionT {
  const parsed = ProjectExecutionTargetProjection.safeParse(value);
  if (!parsed.success || parsed.data.project_id !== projectId) {
    throw new Error("Execution target response is invalid.");
  }
  return parsed.data;
}

function validateTargets(
  executionTargets: ProjectExecutionTargetProjectionT[],
  selectedId: string | null,
): Set<string> {
  const targetIds = new Set<string>();
  for (const target of executionTargets) {
    if (targetIds.has(target.execution_target_id)) {
      throw new Error("Execution target response is invalid.");
    }
    targetIds.add(target.execution_target_id);
  }
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
  return targetIds;
}

function parseEnvelope(
  value: unknown,
  projectId: string,
  viewerRole: "owner" | "member",
): ExecutionTargetEnvelope {
  const candidate = record(value);
  if (!candidate) throw new Error("Execution target response is invalid.");

  // Backward-compatible Phase 4 projection: it carries no claim data and is
  // still constrained by the independently loaded owner/member access record.
  if (!("viewer_role" in candidate) && !("schema_version" in candidate)) {
    if (
      !hasExactKeys(candidate, [
        "project_id",
        "selected_execution_target_id",
        "work_active",
        "execution_targets",
      ]) ||
      candidate.project_id !== projectId ||
      (typeof candidate.selected_execution_target_id !== "string" &&
        candidate.selected_execution_target_id !== null) ||
      typeof candidate.work_active !== "boolean" ||
      !Array.isArray(candidate.execution_targets)
    ) {
      throw new Error("Execution target response is invalid.");
    }
    const executionTargets = candidate.execution_targets.map((target) =>
      parseTarget(target, projectId),
    );
    validateTargets(executionTargets, candidate.selected_execution_target_id);
    return {
      project_id: projectId,
      viewer_role: viewerRole,
      selected_execution_target_id: candidate.selected_execution_target_id,
      work_active: candidate.work_active,
      execution_targets: executionTargets,
      legacy_claim_required: false,
    };
  }

  const commonValid =
    candidate.schema_version === 1 &&
    candidate.project_id === projectId &&
    candidate.viewer_role === viewerRole &&
    (typeof candidate.selected_execution_target_id === "string" ||
      candidate.selected_execution_target_id === null) &&
    typeof candidate.work_active === "boolean" &&
    Array.isArray(candidate.execution_targets);
  if (!commonValid) throw new Error("Execution target response is invalid.");
  const selectedExecutionTargetId = candidate.selected_execution_target_id as string | null;
  const rawExecutionTargets = candidate.execution_targets as unknown[];

  if (
    !hasExactKeys(candidate, [
      "schema_version",
      "project_id",
      "viewer_role",
      "work_active",
      "selected_execution_target_id",
      "execution_targets",
      "legacy_claim_required",
    ]) ||
    typeof candidate.legacy_claim_required !== "boolean"
  ) {
    throw new Error("Execution target response is invalid.");
  }
  const executionTargets = rawExecutionTargets.map((target) => parseTarget(target, projectId));
  validateTargets(executionTargets, selectedExecutionTargetId);
  if (
    viewerRole === "member" &&
    (executionTargets.length > 1 ||
      executionTargets.some(
        (target) =>
          target.execution_target_id !== selectedExecutionTargetId ||
          target.status.access !== "shared",
      ))
  ) {
    throw new Error("Execution target response is invalid.");
  }
  return {
    project_id: projectId,
    viewer_role: viewerRole,
    selected_execution_target_id: selectedExecutionTargetId,
    work_active: candidate.work_active as boolean,
    execution_targets: executionTargets,
    legacy_claim_required: candidate.legacy_claim_required as boolean,
  };
}

function parseClaim(value: unknown, projectId: string): LegacyRepositoryBindingClaimProjectionT {
  const parsed = LegacyRepositoryBindingClaimProjection.safeParse(value);
  if (!parsed.success || parsed.data.project_id !== projectId) {
    throw new Error("Legacy claim response is invalid.");
  }
  return parsed.data;
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
    if (error.code === "claim_version_changed") {
      return "The repository claim changed in another session. Review the latest state.";
    }
    if (error.code === "project_version_changed") {
      return "The project changed in another session. Review the latest claim before retrying.";
    }
    if (error.code === "claim_already_finalized") {
      return "This repository claim was already completed. The latest project state is shown.";
    }
    if (error.code === "idempotency_conflict") {
      return "This confirmation attempt no longer matches the selected repository. Review and try again.";
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

function newIdempotencyKey(): string {
  return globalThis.crypto.randomUUID();
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
  const [claim, setClaim] = useState<LegacyRepositoryBindingClaimProjectionT | null>(null);
  const [draftTargetId, setDraftTargetId] = useState<string | null>(null);
  const [claimTargetId, setClaimTargetId] = useState<string | null>(null);
  const [claimConfirmation, setClaimConfirmation] = useState("");
  const [claimAttempted, setClaimAttempted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const requestSequence = useRef(0);
  const claimIdempotencyKey = useRef(newIdempotencyKey());
  const currentProjectId = useRef(projectId);
  currentProjectId.current = projectId;

  const resetClaimDraft = useCallback((): void => {
    setClaimTargetId(null);
    setClaimConfirmation("");
    setClaimAttempted(false);
    claimIdempotencyKey.current = newIdempotencyKey();
  }, []);

  const load = useCallback(async (): Promise<boolean> => {
    const sequence = ++requestSequence.current;
    setLoading(true);
    setError(null);
    try {
      const [nextAccess, nextEnvelope, capabilities] = await Promise.all([
        requestJson(`/api/v2/projects/${encodeURIComponent(projectId)}/access`),
        requestJson(`/api/projects/${encodeURIComponent(projectId)}/execution-targets`),
        loadLocalExecutionCapabilities(),
      ]);
      if (sequence !== requestSequence.current || currentProjectId.current !== projectId) {
        return false;
      }
      const parsedAccess = parseAccess(nextAccess, projectId);
      const owner =
        parsedAccess.source === "owner" &&
        parsedAccess.owner_user_id !== null &&
        parsedAccess.owner_user_id === parsedAccess.user_id;
      const viewerRole = owner ? "owner" : parsedAccess.source === "membership" ? "member" : null;
      if (viewerRole === null) {
        setAvailable(false);
        setAccess(null);
        setEnvelope(null);
        return false;
      }
      const parsedEnvelope = parseEnvelope(nextEnvelope, projectId, viewerRole);
      const gatedEnvelope = capabilities.legacy_claim_available
        ? parsedEnvelope
        : { ...parsedEnvelope, legacy_claim_required: false };
      let nextClaim: LegacyRepositoryBindingClaimProjectionT | null = null;
      if (owner && capabilities.legacy_claim_available) {
        try {
          nextClaim = parseClaim(
            await requestJson(
              `/api/projects/${encodeURIComponent(projectId)}/legacy-repository-claim`,
            ),
            projectId,
          );
        } catch (caught) {
          if (!(caught instanceof ApiError && caught.status === 404)) throw caught;
        }
      }
      if (sequence !== requestSequence.current || currentProjectId.current !== projectId) {
        return false;
      }
      setAccess(parsedAccess);
      setEnvelope(gatedEnvelope);
      setClaim(nextClaim?.state === "claim_required" ? nextClaim : null);
      setDraftTargetId(gatedEnvelope.selected_execution_target_id);
      resetClaimDraft();
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
  }, [onUnauthorized, projectId, resetClaimDraft]);

  useEffect(() => {
    setAvailable(null);
    setAccess(null);
    setEnvelope(null);
    setClaim(null);
    setDraftTargetId(null);
    resetClaimDraft();
    setSaving(false);
    setError(null);
    setNotice(null);
    void load();
    return () => {
      requestSequence.current += 1;
    };
  }, [load, resetClaimDraft]);

  const save = async (): Promise<void> => {
    if (
      !envelope ||
      !draftTargetId ||
      envelope.work_active ||
      claim?.state === "claim_required" ||
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
      const nextEnvelope = parseEnvelope(payload, projectId, "owner");
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

  const finalizeClaim = async (
    activeClaim: LegacyRepositoryBindingClaimProjectionT,
    target: LegacyRepositoryBindingClaimProjectionT["candidate_targets"][number],
  ): Promise<void> => {
    if (
      access?.source !== "owner" ||
      access.owner_user_id !== access.user_id ||
      activeClaim.state !== "claim_required" ||
      !activeClaim.can_finalize ||
      envelope?.work_active ||
      claimConfirmation !== target.repository_display_name
    ) {
      return;
    }
    const projectAtStart = projectId;
    setSaving(true);
    setClaimAttempted(true);
    setError(null);
    setNotice(null);
    try {
      const payload = await requestJson(
        `/api/projects/${encodeURIComponent(projectId)}/legacy-repository-claims/${encodeURIComponent(
          activeClaim.claim_id,
        )}/finalize`,
        {
          method: "POST",
          body: JSON.stringify({
            execution_target_id: target.execution_target_id,
            expected_claim_version: activeClaim.claim_version,
            expected_project_version: activeClaim.project_version,
            idempotency_key: claimIdempotencyKey.current,
            confirmation: "use_this_repository",
          }),
        },
      );
      const finalized = parseClaim(payload, projectId);
      if (
        finalized.state !== "finalized" ||
        finalized.finalized_execution_target_id !== target.execution_target_id
      ) {
        throw new Error("Legacy claim response is invalid.");
      }
      if (currentProjectId.current !== projectAtStart) return;
      const reloaded = await load();
      if (reloaded && currentProjectId.current === projectAtStart) {
        setNotice("Repository confirmed and execution target updated.");
      }
    } catch (caught) {
      if (currentProjectId.current !== projectAtStart) return;
      if (caught instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      if (caught instanceof ApiError && caught.code === "project_work_active") {
        setEnvelope((current) => (current ? { ...current, work_active: true } : current));
      }
      if (
        caught instanceof ApiError &&
        (caught.code === "claim_version_changed" ||
          caught.code === "project_version_changed" ||
          caught.code === "claim_already_finalized" ||
          caught.code === "execution_target_changed" ||
          caught.status === 404)
      ) {
        const reloaded = await load();
        if (reloaded && currentProjectId.current === projectAtStart) {
          setError(targetErrorMessage(caught));
        }
        return;
      }
      setError(
        caught instanceof ApiError
          ? targetErrorMessage(caught)
          : "The confirmed switch did not return a usable response. Retry will use the same confirmation attempt.",
      );
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
  const primaryClaim = owner ? claim : null;
  const claimCandidates = primaryClaim?.candidate_targets ?? [];
  const selectedClaimTarget =
    claimCandidates.find((target) => target.execution_target_id === claimTargetId) ?? null;
  const confirmationMatches =
    selectedClaimTarget !== null &&
    claimConfirmation === selectedClaimTarget.repository_display_name;

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
        <div>
          <Alert>{error}</Alert>
        </div>
      ) : null}
      {notice ? (
        <output className="execution-target-notice" aria-live="polite">
          {notice}
        </output>
      ) : null}

      {!owner && envelope?.legacy_claim_required ? (
        <output className="legacy-claim-member">
          <strong>Local repository claim required</strong>
          <p>
            The project owner must reconnect the local execution target before new local work can
            run.
          </p>
        </output>
      ) : null}

      {owner && primaryClaim ? (
        <section className="legacy-claim" aria-labelledby="legacy-claim-heading">
          <div className="legacy-claim-heading">
            <div>
              <h3 id="legacy-claim-heading">Reconnect historical local repository</h3>
              <p className="muted">
                Re-enrollment creates a new device-backed binding. The historical binding is retired
                only after this exact repository is confirmed.
              </p>
            </div>
            <Badge tone={envelope?.work_active ? "warn" : "info"}>
              {claimCandidates.length === 0
                ? "Grant required"
                : envelope?.work_active
                  ? "Work active"
                  : "Confirmation required"}
            </Badge>
          </div>
          <dl className="legacy-claim-repository">
            <div>
              <dt>Historical repository</dt>
              <dd>{primaryClaim.repository_display_name}</dd>
            </div>
          </dl>

          {claimCandidates.length === 0 ? (
            <div className="legacy-claim-guidance">
              <strong>Enroll and approve the actual computer first</strong>
              <p>
                Open its Local Agent, re-catalog the repository, then grant this project access from
                Computers. No historical runner name or online computer is selected automatically.
              </p>
            </div>
          ) : (
            <>
              <fieldset
                className="execution-target-fieldset"
                disabled={saving || envelope?.work_active}
                aria-describedby={envelope?.work_active ? "legacy-claim-active-work" : undefined}
              >
                <legend>Choose the re-cataloged repository to confirm</legend>
                <div className="execution-target-list">
                  {claimCandidates.map((target) => (
                    <label
                      className={`execution-target-option${
                        claimTargetId === target.execution_target_id ? " is-chosen" : ""
                      }`}
                      key={target.execution_target_id}
                    >
                      <input
                        type="radio"
                        name={`legacy-claim-target-${projectId}`}
                        value={target.execution_target_id}
                        checked={claimTargetId === target.execution_target_id}
                        onChange={() => {
                          setClaimTargetId(target.execution_target_id);
                          setClaimConfirmation("");
                          setClaimAttempted(false);
                          claimIdempotencyKey.current = newIdempotencyKey();
                          setNotice(null);
                        }}
                      />
                      <span className="execution-target-summary">
                        <span className="execution-target-heading">
                          <span>
                            <strong>{target.name}</strong>
                            {target.location_label ? <small>{target.location_label}</small> : null}
                          </span>
                          <Badge tone="info">Eligible</Badge>
                        </span>
                        <span className="execution-target-repository">
                          <span>Repository to confirm</span>
                          <strong>{target.repository_display_name}</strong>
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>

              {selectedClaimTarget ? (
                <div className="legacy-claim-confirmation">
                  <Field label={`Type ${selectedClaimTarget.repository_display_name} to confirm`}>
                    <Input
                      autoComplete="off"
                      value={claimConfirmation}
                      disabled={saving || envelope?.work_active}
                      aria-describedby="legacy-claim-confirmation-help"
                      onChange={(event) => setClaimConfirmation(event.target.value)}
                    />
                  </Field>
                  <p className="field-help" id="legacy-claim-confirmation-help">
                    This confirms the selected, currently granted repository is the historical
                    project repository. It does not delete or move local files.
                  </p>
                </div>
              ) : null}

              {envelope?.work_active ? (
                <output id="legacy-claim-active-work" className="execution-target-active-work">
                  The final binding switch is blocked while project work is active.
                </output>
              ) : null}

              <div className="settings-save-row execution-target-save-row">
                <span className="muted">
                  The new binding is immutable and the historical binding is retired atomically.
                </span>
                <Button
                  variant="primary"
                  disabled={
                    saving ||
                    envelope?.work_active ||
                    !primaryClaim.can_finalize ||
                    !selectedClaimTarget ||
                    !confirmationMatches
                  }
                  onClick={() =>
                    selectedClaimTarget
                      ? void finalizeClaim(primaryClaim, selectedClaimTarget)
                      : undefined
                  }
                >
                  {saving
                    ? "Confirming repository…"
                    : claimAttempted
                      ? "Retry confirmed switch"
                      : "Confirm repository and switch"}
                </Button>
              </div>
            </>
          )}
        </section>
      ) : null}

      {!loading &&
      envelope &&
      targets.length === 0 &&
      !primaryClaim &&
      !envelope.legacy_claim_required ? (
        <p className="execution-target-empty">
          No eligible local execution target is currently granted to this project.
        </p>
      ) : null}

      {envelope && targets.length > 0 && !primaryClaim ? (
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

      {owner && envelope?.work_active && !primaryClaim ? (
        <output id="execution-target-active-work" className="execution-target-active-work">
          Target changes are blocked while project work is active.
        </output>
      ) : null}

      {owner && envelope && targets.length > 0 && !primaryClaim ? (
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
