// PHASE TAB (P2, reconciled at P3 integration): the ONE api module for the
// Phase tab feature. Every fetch the Phase tab makes lives here — request
// payload shapes, DTO field names, and route paths — reconciled against the
// backend as actually built (apps/server/src/planning/runService.ts and the
// PHASE TAB P1 routes in apps/server/src/server.ts):
//   1. POST /api/v2/projects/:id/planning-runs
//        body: { objective, attachment_ids?, review_rounds? (1–5),
//        worker_providers?: "anthropic" | "openai" | "both" } -> 202
//        { planning_run_id }.
//   2. GET  /api/v2/projects/:id/planning-runs/:runId -> PlanningRunDto.
//        There is NO `awaiting_decision` status: a run with status
//        converged/cap_reached IS awaiting a decision (the backend's
//        DECIDABLE_PLANNING_RUN_STATUSES). The staffed plan lives in
//        result.staffing_proposal.recommendations (node_id/provider/model/
//        worker_count/...), joined to result.plan.modules (id/title/
//        description) for display — see planPhasesFromRun().
//   3. POST /api/v2/projects/:id/planning-runs/:runId/decision
//        { decision: "approve"|"modify"|"reject", direction?, staffing? }.
//        approve/reject -> 200 run DTO (approve additionally carries
//        `execution: { started, detail } | null` — null means the approval
//        is recorded but execution did not auto-start; NOT an error).
//        modify -> 202 run DTO re-queued (status "queued",
//        rounds_completed 0): the UI returns to live-progress polling.
//   4. GET /api/v2/projects/:id/execution-status (project-scoped, no runId)
//        -> { project_id, phases: [{ phase_id, name, state,
//        percent_complete, est_completion, notes }] }.
import { ApiError, UnauthorizedError, authHeaders } from "./auth";

// ---------------------------------------------------------------------------
// Local JSON helpers (App.tsx's are module-private; duplicated minimally so
// this module stays self-contained).
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
// Types (mirroring apps/server/src/planning/runService.ts DTOs)
// ---------------------------------------------------------------------------

export type WorkerProviders = "anthropic" | "openai" | "both";

export interface StartPhasePlanningRunBody {
  objective: string;
  attachment_ids: string[];
  /** 1–5; server default applies when omitted. */
  review_rounds: number;
  worker_providers: WorkerProviders;
}

/** The backend's PlanningRunStatus. There is NO `awaiting_decision`. */
export type PhasePlanningRunStatus =
  | "queued"
  | "drafting"
  | "reviewing"
  | "revising"
  | "converged"
  | "cap_reached"
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

/**
 * Statuses where the human decision panel (approve/modify/reject) is valid —
 * the backend's DECIDABLE_PLANNING_RUN_STATUSES. A run in either state is
 * awaiting a decision (after a modify re-entry reconverges, `decision` still
 * holds the previous modify record, so status — not `decision === null` — is
 * the gate).
 */
export const PHASE_RUN_DECISION_STATUSES: ReadonlySet<PhasePlanningRunStatus> = new Set([
  "converged",
  "cap_reached",
]);

/** One module of the PM's plan (PlanContract.modules[] — display fields only). */
export interface PhasePlanModule {
  id: string;
  title?: string;
  description?: string;
}

/** One allocation recommendation (result.staffing_proposal.recommendations[]). */
export interface PhaseStaffingRecommendation {
  node_id: string;
  provider: "anthropic" | "openai";
  model: string;
  worker_count: number;
  reviewer_model?: string;
  budget_usd?: number;
  rationale?: string;
}

export interface PhaseStaffingProposal {
  summary: string;
  recommendations: PhaseStaffingRecommendation[];
}

export interface PhasePlanningRunTranscriptEntry {
  round: number;
  role: "pm" | "reviewer";
  provider: string;
  model: string;
  summary: string;
  finding_counts: { must_fix: number; should_fix: number; suggestion: number } | null;
}

export interface PhasePlanningRunResult {
  /** The PlanContract payload; only `modules` is read here. */
  plan: { modules?: PhasePlanModule[] } | null;
  content_hash: string;
  total_cost_usd: number;
  staffing_proposal: PhaseStaffingProposal | null;
}

/** The latest human decision recorded on a run, or null while none is. */
export interface PhasePlanningRunDecision {
  decision: "approve" | "modify" | "reject";
  direction: string | null;
  staffing: PlanningRunStaffingOverride[] | null;
  decided_at: string;
}

export interface PhasePlanningRunDto {
  id: string;
  status: PhasePlanningRunStatus;
  round: number;
  max_rounds: number;
  review_rounds_total: number;
  rounds_completed: number;
  worker_providers: WorkerProviders;
  decision: PhasePlanningRunDecision | null;
  transcript: PhasePlanningRunTranscriptEntry[];
  result: PhasePlanningRunResult | null;
  error: string | null;
}

/** One planned phase with its staffing recommendation, ready for display. */
export interface PhasePlanStaffedPhase {
  node_id: string;
  name?: string;
  description?: string | null;
  provider: "anthropic" | "openai";
  model: string;
  worker_count: number;
}

/**
 * Where the staffed phases live inside the run DTO, in one place: the
 * recommendations in result.staffing_proposal, joined to the plan's modules
 * (recommendation.node_id === module.id) for title/description. A run whose
 * staffing proposal is null (the worker could not produce one) yields [] —
 * approve is still valid then (the server treats staffing as optional).
 */
export function planPhasesFromRun(run: PhasePlanningRunDto): PhasePlanStaffedPhase[] {
  const recommendations = run.result?.staffing_proposal?.recommendations ?? [];
  const modules = new Map((run.result?.plan?.modules ?? []).map((m) => [m.id, m]));
  return recommendations.map((rec) => {
    const module = modules.get(rec.node_id);
    return {
      node_id: rec.node_id,
      name: module?.title ?? rec.node_id,
      description: module?.description ?? null,
      provider: rec.provider,
      model: rec.model,
      worker_count: rec.worker_count,
    };
  });
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

/**
 * Approve's kickoff report. `null` means the approval is recorded but
 * execution did not auto-start (it currently begins through the existing
 * strategy/phase start flow) — a neutral fact, not an error.
 */
export interface PhaseExecutionKickoffReport {
  started: boolean;
  detail: string;
}

export type PlanningRunDecisionResponse = PhasePlanningRunDto & {
  /** Present on approve responses only. */
  execution?: PhaseExecutionKickoffReport | null;
};

export interface PhaseExecutionStatusRow {
  phase_id: string;
  name: string;
  /** phases.status: proposed | awaiting_approval | approved | active | blocked | completed | cancelled */
  state: string;
  percent_complete: number;
  est_completion: string | null;
  notes: string;
}

export interface PhaseExecutionStatusDto {
  project_id: string;
  phases: PhaseExecutionStatusRow[];
}

/** Execution-row states that keep the fast poll cadence going. */
export const PHASE_EXECUTION_ACTIVE_STATES: ReadonlySet<string> = new Set(["active"]);

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
): Promise<PlanningRunDecisionResponse> {
  return postJson(`/api/v2/projects/${projectId}/planning-runs/${runId}/decision`, body);
}

/**
 * Poll per-phase execution progress. Project-scoped — the backend's
 * GET /api/v2/projects/:id/execution-status (AttentionService
 * .projectExecution), not tied to a planning run.
 */
export function getPhaseExecutionStatus(projectId: string): Promise<PhaseExecutionStatusDto> {
  return getJson(`/api/v2/projects/${projectId}/execution-status`);
}
