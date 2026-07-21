// EXECUTION E2: the minimal, honest UI trigger for
// `POST /api/v2/projects/:id/phases/:phaseId/start`. Phase E6 owns the wider
// UI; this is deliberately small — one button, backed by the real
// read-only `.../start-readiness` preflight so it is NEVER shown enabled
// when the server-side gate (PhaseLaunchService, on top of the EXISTING,
// unweakened Phase4Coordinator gate) would refuse the work. Every disabled
// state shows the server's own human-readable reason — no state that isn't
// truthful about whether starting the phase will actually work.
import { useCallback, useEffect, useState } from "react";
import { UnauthorizedError, authHeaders } from "./auth";
import { Alert, Button } from "./ui";

export interface PhaseStartReadinessDto {
  ready: boolean;
  schedulable_task_count: number;
  blocking_code: string | null;
  blocking_reason: string | null;
}

export interface PhaseStartTaskOutcomeDto {
  task_id: string;
  task_title: string;
  outcome: "scheduled" | "blocked";
  run_id?: string;
  dispatch_job_id?: string;
  blocked_code?: string;
  blocked_reason?: string;
}

export interface PhaseStartOutcomeDto {
  phase_id: string;
  scheduled: PhaseStartTaskOutcomeDto[];
  blocked: PhaseStartTaskOutcomeDto[];
}

/** Only these phase states have anything to start — an already-executing
 *  phase can still be idempotently re-triggered to pick up newly
 *  dependency-ready tasks (e.g. after a prior batch completes). Every other
 *  status (draft/proposed/awaiting_approval/completed/...) has no trigger at
 *  all, rather than a button that would always be disabled. */
const STARTABLE_PHASE_STATUSES = new Set(["approved", "active"]);

export function StartPhaseControl({
  projectId,
  phaseId,
  phaseStatus,
  onStarted,
  onUnauthorized,
}: {
  projectId: string;
  phaseId: string;
  phaseStatus: string;
  onStarted?: () => void;
  onUnauthorized: () => void;
}): React.ReactElement | null {
  const eligible = STARTABLE_PHASE_STATUSES.has(phaseStatus);
  const [readiness, setReadiness] = useState<PhaseStartReadinessDto | null>(null);
  const [readinessError, setReadinessError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [result, setResult] = useState<PhaseStartOutcomeDto | null>(null);
  const [startError, setStartError] = useState<string | null>(null);

  const loadReadiness = useCallback(async () => {
    if (!eligible) return;
    try {
      setReadinessError(null);
      const res = await fetch(`/api/v2/projects/${projectId}/phases/${phaseId}/start-readiness`, {
        headers: authHeaders(false),
      });
      if (res.status === 401) {
        onUnauthorized();
        return;
      }
      if (!res.ok) {
        setReadinessError(`request failed: ${res.status}`);
        return;
      }
      setReadiness((await res.json()) as PhaseStartReadinessDto);
    } catch (err) {
      setReadinessError(err instanceof Error ? err.message : String(err));
    }
  }, [projectId, phaseId, eligible, onUnauthorized]);

  useEffect(() => {
    void loadReadiness();
  }, [loadReadiness]);

  const start = useCallback(async () => {
    setStarting(true);
    setStartError(null);
    try {
      const res = await fetch(`/api/v2/projects/${projectId}/phases/${phaseId}/start`, {
        method: "POST",
        headers: authHeaders(true),
      });
      if (res.status === 401) {
        onUnauthorized();
        return;
      }
      const json = (await res.json()) as PhaseStartOutcomeDto & {
        error?: string;
        detail?: string;
      };
      if (!res.ok) {
        setStartError(json.detail ?? json.error ?? `request failed: ${res.status}`);
        return;
      }
      setResult(json);
      onStarted?.();
      await loadReadiness();
    } catch (err) {
      if (err instanceof UnauthorizedError) onUnauthorized();
      else setStartError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  }, [projectId, phaseId, onStarted, onUnauthorized, loadReadiness]);

  if (!eligible) return null;

  const disabledReason =
    readinessError ?? (readiness && !readiness.ready ? readiness.blocking_reason : null);

  return (
    <div className="start-phase-control" data-testid="start-phase-control">
      <Button
        className="btn-small"
        variant="primary"
        data-testid="start-phase-button"
        disabled={starting || !readiness?.ready}
        title={disabledReason ?? undefined}
        onClick={() => void start()}
      >
        {starting ? "Starting…" : "Start phase"}
      </Button>
      {disabledReason ? (
        <span className="muted" data-testid="start-phase-blocked-reason" style={{ fontSize: 12 }}>
          {disabledReason}
        </span>
      ) : null}
      {result ? (
        <span className="muted" data-testid="start-phase-result" style={{ fontSize: 12 }}>
          {result.scheduled.length} scheduled, {result.blocked.length} blocked
        </span>
      ) : null}
      {startError ? <Alert testId="start-phase-error">{startError}</Alert> : null}
    </div>
  );
}
