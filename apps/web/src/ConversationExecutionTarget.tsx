import type {
  ConversationExecutionProjectionT,
  ProjectRunCancellationProjectionT,
  ProjectRunCancellationRequestT,
} from "@norns/contracts";
import { ProjectRunCancellationRequest } from "@norns/contracts";
import { useEffect, useState } from "react";

import { ApiError, UnauthorizedError } from "./auth";
import { cancelProjectRun } from "./conversationApi";
import { Badge, Button } from "./ui";

const CANCELLATION_COPY = {
  cancellation_requested: {
    label: "Cancellation requested",
    detail:
      "The server recorded the stop and asked the runner to stop. Local process exit is not yet confirmed.",
    tone: "warn",
  },
  runner_acknowledged: {
    label: "Runner acknowledged",
    detail: "The runner acknowledged the stop request. Local process exit is not yet confirmed.",
    tone: "info",
  },
  process_exited: {
    label: "Process exited",
    detail: "The runner confirmed that the complete managed process tree exited.",
    tone: "success",
  },
  unconfirmed_offline: {
    label: "Unconfirmed offline",
    detail:
      "The runner is offline, so the server cannot confirm that its local process has exited.",
    tone: "default",
  },
} as const;

type CancellationState = keyof typeof CANCELLATION_COPY;

function requestStorageKey(projectId: string, runId: string): string {
  return `norns:project-run-stop:${projectId}:${runId}`;
}

function readLockedRequest(
  projectId: string,
  runId: string,
): ProjectRunCancellationRequestT | null {
  try {
    const value = window.sessionStorage.getItem(requestStorageKey(projectId, runId));
    if (!value) return null;
    const parsed = ProjectRunCancellationRequest.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function persistLockedRequest(
  projectId: string,
  runId: string,
  request: ProjectRunCancellationRequestT | null,
): void {
  try {
    const key = requestStorageKey(projectId, runId);
    if (request) window.sessionStorage.setItem(key, JSON.stringify(request));
    else window.sessionStorage.removeItem(key);
  } catch {
    // Exact retries remain locked in component state when session storage is unavailable.
  }
}

function cancellationTimestamp(cancellation: ProjectRunCancellationProjectionT): string {
  if (cancellation.state === "process_exited" && cancellation.process_exited_at) {
    return cancellation.process_exited_at;
  }
  if (cancellation.state === "runner_acknowledged" && cancellation.runner_acknowledged_at) {
    return cancellation.runner_acknowledged_at;
  }
  if (cancellation.state === "unconfirmed_offline" && cancellation.unconfirmed_offline_at) {
    return cancellation.unconfirmed_offline_at;
  }
  return cancellation.cancellation_requested_at;
}

function readableTimestamp(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function newIdempotencyKey(runId: string): string {
  const suffix =
    globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36)}`;
  return `stop-${runId}-${suffix}`;
}

export function executionTargetHeaderLabel(
  projection: ConversationExecutionProjectionT | null,
): string | null {
  if (!projection?.target) return null;
  const prefix =
    projection.presentation === "idle"
      ? "Execution target"
      : projection.presentation === "historical"
        ? "Last ran on"
        : ["created", "dispatched"].includes(projection.run?.state ?? "")
          ? "Preparing on"
          : projection.run?.state === "waiting_for_human"
            ? "Waiting on"
            : "Running on";
  return `${prefix} · ${projection.target.name}`;
}

export function CancellationStatus({
  cancellation,
}: {
  cancellation: ProjectRunCancellationProjectionT;
}): React.ReactElement {
  const copy = CANCELLATION_COPY[cancellation.state as CancellationState];
  const recordedAt = cancellationTimestamp(cancellation);
  return (
    <output
      className="project-run-cancellation-status"
      data-cancellation-state={cancellation.state}
      aria-live="polite"
    >
      <div>
        <strong>{copy.label}</strong>
        <Badge tone={copy.tone}>{cancellation.state}</Badge>
      </div>
      <p>{copy.detail}</p>
      <small>
        Recorded{" "}
        <time dateTime={recordedAt} title={recordedAt}>
          {readableTimestamp(recordedAt)}
        </time>
      </small>
    </output>
  );
}

export function ProjectRunStopControl({
  projectId,
  run,
  pauseBusy = false,
  pauseError = null,
  onPause,
  onCancellation,
  onUnauthorized,
}: {
  projectId: string;
  run: NonNullable<ConversationExecutionProjectionT["run"]>;
  pauseBusy?: boolean;
  pauseError?: string | null;
  onPause?: () => void;
  onCancellation: (cancellation: ProjectRunCancellationProjectionT) => void;
  onUnauthorized: () => void;
}): React.ReactElement | null {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lockedRequest, setLockedRequest] = useState<ProjectRunCancellationRequestT | null>(() =>
    readLockedRequest(projectId, run.run_id),
  );

  useEffect(() => {
    setError(null);
    setLockedRequest(readLockedRequest(projectId, run.run_id));
  }, [projectId, run.run_id]);

  useEffect(() => {
    if (!run.cancellation) return;
    persistLockedRequest(projectId, run.run_id, null);
    setLockedRequest(null);
  }, [projectId, run.cancellation, run.run_id]);

  if (!run.can_stop && !run.cancellation && !onPause) return null;

  const submit = async () => {
    const request =
      lockedRequest ??
      ({
        reason: "Stopped by the user from the Development chat.",
        idempotency_key: newIdempotencyKey(run.run_id),
      } satisfies ProjectRunCancellationRequestT);

    setBusy(true);
    setError(null);
    if (!lockedRequest) {
      setLockedRequest(request);
      persistLockedRequest(projectId, run.run_id, request);
    }
    try {
      const cancellation = await cancelProjectRun(projectId, run.run_id, request);
      persistLockedRequest(projectId, run.run_id, null);
      setLockedRequest(null);
      onCancellation(cancellation);
    } catch (caught) {
      if (caught instanceof UnauthorizedError) {
        persistLockedRequest(projectId, run.run_id, null);
        setLockedRequest(null);
        onUnauthorized();
      } else if (caught instanceof ApiError && [400, 403, 404].includes(caught.status)) {
        persistLockedRequest(projectId, run.run_id, null);
        setLockedRequest(null);
        setError(caught.message);
      } else {
        setError(
          "The stop response was lost. The exact reason and request are locked for a safe retry.",
        );
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="project-run-stop" aria-label="Development run controls">
      <div className="project-run-stop-heading">
        <strong>Run controls</strong>
        <Badge tone={run.state === "running" ? "info" : "default"}>{run.state}</Badge>
      </div>
      {run.cancellation ? <CancellationStatus cancellation={run.cancellation} /> : null}
      {(run.can_stop || onPause) && !run.cancellation ? (
        <div className="project-run-stop-actions">
          {onPause ? (
            <Button type="button" disabled={busy || pauseBusy} onClick={onPause}>
              {pauseBusy ? "Pausing…" : "Pause"}
            </Button>
          ) : null}
          {run.can_stop ? (
            <Button type="button" variant="danger" disabled={busy || pauseBusy} onClick={submit}>
              {busy ? "Stopping…" : lockedRequest ? "Retry stop" : "Stop"}
            </Button>
          ) : null}
        </div>
      ) : null}
      {error || pauseError ? (
        <output className="conversation-action-error" role="alert">
          {error ?? pauseError}
        </output>
      ) : null}
    </section>
  );
}
