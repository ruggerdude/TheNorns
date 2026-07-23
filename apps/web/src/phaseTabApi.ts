// PHASE TAB (P2): the ONE api module for the Phase tab feature. Every fetch
// the Phase tab makes lives here — request payload shapes, DTO field names,
// and route paths — so the integrator reconciling frontend/backend drift
// touches exactly this file. Components import functions + types from here
// and never call fetch themselves.
//
// Contract built against (backend agent building in parallel):
//   1. POST /api/v2/projects/:id/planning-runs
//        body gains optional `review_rounds` (1–5) and
//        `worker_providers`: "anthropic" | "openai" | "both".
//   2. GET  /api/v2/projects/:id/planning-runs/:runId
//        DTO gains `review_rounds_total`, `rounds_completed`; statuses may
//        additionally be awaiting_decision/approved/rejected; the plan's
//        phases carry staffing {node_id, name/description, provider, model,
//        worker_count}.
//   3. POST /api/v2/projects/:id/planning-runs/:runId/decision
//        { decision: "approve"|"modify"|"reject", direction?, staffing? }.
//   4. GET execution status poll — route below is a PLACEHOLDER
//        (`.../planning-runs/:runId/execution`); integrator points it at the
//        backend's final route.
import { ApiError, UnauthorizedError, authHeaders } from "./auth";

// ---------------------------------------------------------------------------
// Local JSON helpers (App.tsx's are module-private; duplicated minimally so
// this module stays self-contained for the integrator).
// ---------------------------------------------------------------------------

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: authHeaders(false) });
  if (res.status === 401) throw new UnauthorizedError();
  const json = (await res.json().catch(() => ({}))) as T & { message?: string };
  if (!res.ok)
    throw new ApiError(
      (json as { message?: string }).message ?? `request failed: ${res.status}`,
      res.status,
    );
  return json;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: authHeaders(true),
    body: JSON.stringify(body),
  });
  if (res.status === 401) throw new UnauthorizedError();
  const json = (await res.json().catch(() => ({}))) as T & { message?: string };
  if (!res.ok)
    throw new ApiError(
      (json as { message?: string }).message ?? `request failed: ${res.status}`,
      res.status,
    );
  return json;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WorkerProviders = "anthropic" | "openai" | "both";

export interface StartPhasePlanningRunBody {
  objective: string;
  attachment_ids: string[];
  /** 1–5; server default applies when omitted. */
  review_rounds: number;
  worker_providers: WorkerProviders;
}

export type PhasePlanningRunStatus =
  | "queued"
  | "drafting"
  | "reviewing"
  | "revising"
  | "converged"
  | "cap_reached"
  | "awaiting_decision"
  | "approved"
  | "rejected"
  | "failed";

/** Statuses where the coordinator/reviewer loop is still producing output. */
export const PHASE_RUN_ACTIVE_STATUSES: ReadonlySet<PhasePlanningRunStatus> = new Set([
  "queued",
  "drafting",
  "reviewing",
  "revising",
]);

/** Statuses where the human decision panel (approve/modify/reject) is valid. */
export const PHASE_RUN_DECISION_STATUSES: ReadonlySet<PhasePlanningRunStatus> = new Set([
  "converged",
  "cap_reached",
  "awaiting_decision",
]);

/** One planned phase with its staffing (allocation) recommendation. */
export interface PhasePlanStaffedPhase {
  node_id: string;
  /** Contract says `name/description`; both optional-ish, name preferred. */
  name?: string;
  description?: string | null;
  provider: "anthropic" | "openai";
  model: string;
  worker_count: number;
}

export interface PhasePlanningRunTranscriptEntry {
  round: number;
  role: "pm" | "reviewer";
  provider: string;
  model: string;
  summary: string;
  finding_counts: { must_fix: number; should_fix: number; suggestion: number } | null;
}

export interface PhasePlanningRunDto {
  id: string;
  status: PhasePlanningRunStatus;
  round: number;
  max_rounds: number;
  review_rounds_total: number;
  rounds_completed: number;
  transcript: PhasePlanningRunTranscriptEntry[];
  result: {
    plan: { phases?: PhasePlanStaffedPhase[] } | null;
    content_hash: string;
    total_cost_usd: number;
  } | null;
  error: string | null;
}

/**
 * Where the staffed phases live inside the run DTO, in one place. If the
 * backend lands them somewhere else (e.g. top-level `phases`), only this
 * function changes.
 */
export function planPhasesFromRun(run: PhasePlanningRunDto): PhasePlanStaffedPhase[] {
  return run.result?.plan?.phases ?? [];
}

export interface PlanningRunStaffingOverride {
  node_id: string;
  provider: "anthropic" | "openai";
  model: string;
}

export interface PlanningRunDecisionBody {
  decision: "approve" | "modify" | "reject";
  /** Required for `modify`: sends the run back through review with this direction. */
  direction?: string;
  /** For `approve`: per-phase staffing overrides from the decision panel. */
  staffing?: PlanningRunStaffingOverride[];
}

export interface PhaseExecutionStatusRow {
  phase_id: string;
  name: string;
  state: string;
  percent_complete: number;
  est_completion: string | null;
  notes: string | null;
}

export interface PhaseExecutionStatusDto {
  phases: PhaseExecutionStatusRow[];
}

/** Execution-row states that keep the fast poll cadence going. */
export const PHASE_EXECUTION_ACTIVE_STATES: ReadonlySet<string> = new Set([
  "queued",
  "created",
  "dispatched",
  "running",
  "executing",
  "verifying",
  "in_progress",
]);

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

export function startPhasePlanningRun(
  projectId: string,
  body: StartPhasePlanningRunBody,
): Promise<{ planning_run_id: string }> {
  return postJson(`/api/v2/projects/${projectId}/planning-runs`, body);
}

export function getPhasePlanningRun(
  projectId: string,
  runId: string,
): Promise<PhasePlanningRunDto> {
  return getJson(`/api/v2/projects/${projectId}/planning-runs/${runId}`);
}

export function postPlanningRunDecision(
  projectId: string,
  runId: string,
  body: PlanningRunDecisionBody,
): Promise<PhasePlanningRunDto> {
  return postJson(`/api/v2/projects/${projectId}/planning-runs/${runId}/decision`, body);
}

/**
 * Poll per-phase execution status once a run is approved.
 * PLACEHOLDER ROUTE — the backend's final route may differ; integrator
 * repoints this one call.
 */
export function getPhaseExecutionStatus(
  projectId: string,
  runId: string,
): Promise<PhaseExecutionStatusDto> {
  return getJson(`/api/v2/projects/${projectId}/planning-runs/${runId}/execution`);
}
