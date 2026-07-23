// Durable planning runs (FRONT DOOR P2 §D1): a pollable HTTP-facing record
// wrapped around the existing runPlanning() loop (./session.ts). This module
// owns only the "shell" — creation, status DTOs, and the persisted reviewer
// preference — the loop itself is untouched execution logic; see
// ./runWorker.ts for the part that actually drives runPlanning().
import type { ProviderName } from "@norns/adapters";
import { newId } from "../ids.js";
import type { V2SqlExecutor, V2TransactionRunner } from "../persistence/v2/database.js";
import type { PersistedReviewerSelection } from "./reviewerSelection.js";

export type PlanningRunStatus =
  | "queued"
  | "drafting"
  | "reviewing"
  | "revising"
  | "converged"
  | "cap_reached"
  | "failed"
  // PHASE TAB P1: terminal human-decision states. converged/cap_reached
  // continue to double as the awaiting-decision states (no separate
  // `awaiting_decision` status was added — a run in either state with no
  // decision recorded IS awaiting a decision).
  | "approved"
  | "rejected";

/** PHASE TAB P1: which implementation providers allocation staffing may use. */
export type WorkerProviderSelection = "anthropic" | "openai" | "both";

/** Statuses a human decision may be recorded against. */
export const DECIDABLE_PLANNING_RUN_STATUSES: readonly PlanningRunStatus[] = [
  "converged",
  "cap_reached",
];

export const NON_TERMINAL_PLANNING_RUN_STATUSES: readonly PlanningRunStatus[] = [
  "queued",
  "drafting",
  "reviewing",
  "revising",
];

export interface PlanningRunTranscriptEntryDto {
  round: number;
  role: "pm" | "reviewer";
  provider: string;
  model: string;
  summary: string;
  finding_counts: { must_fix: number; should_fix: number; suggestion: number } | null;
}

export interface PlanningStaffingProposalDto {
  summary: string;
  recommendations: unknown[];
}

export interface PlanningRunResultDto {
  plan: unknown;
  content_hash: string;
  total_cost_usd: number;
  staffing_proposal: PlanningStaffingProposalDto | null;
}

/** PHASE TAB P1: an approved-staffing override for one plan/graph node. */
export interface ApprovedStaffingEntryDto {
  node_id: string;
  provider: ProviderName;
  model: string;
}

/** PHASE TAB P1: the latest human decision recorded on a run. */
export interface PlanningRunDecisionDto {
  decision: "approve" | "modify" | "reject";
  direction: string | null;
  staffing: ApprovedStaffingEntryDto[] | null;
  decided_at: string;
}

export interface PlanningRunDto {
  id: string;
  project_id: string;
  status: PlanningRunStatus;
  round: number;
  max_rounds: number;
  /** PHASE TAB P1: the run's configured review-round cap (= max_rounds). */
  review_rounds_total: number;
  /** PHASE TAB P1: reviewer rounds completed so far in the current loop (= round). */
  rounds_completed: number;
  /** PHASE TAB P1: providers the allocation recommendation may staff with. */
  worker_providers: WorkerProviderSelection;
  /** PHASE TAB P1: latest human decision, or null while none is recorded. */
  decision: PlanningRunDecisionDto | null;
  objective: string;
  transcript: PlanningRunTranscriptEntryDto[];
  result: PlanningRunResultDto | null;
  total_cost_usd: number;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export class PlanningRunConflictError extends Error {
  constructor(
    readonly code: "project_not_found" | "planning_run_not_found",
    message: string,
  ) {
    super(message);
    this.name = "PlanningRunConflictError";
  }
}

/** PHASE TAB P1: a decision request that cannot be honored in the run's
 *  current state (mapped to HTTP 409 by the route). */
export class PlanningRunDecisionError extends Error {
  constructor(
    readonly code: "invalid_status",
    message: string,
  ) {
    super(message);
    this.name = "PlanningRunDecisionError";
  }
}

interface PlanningRunRow {
  id: string;
  project_id: string;
  status: PlanningRunStatus;
  round: number;
  max_rounds: number;
  worker_providers: WorkerProviderSelection;
  decision: PlanningRunDecisionDto | string | null;
  objective: string;
  transcript: PlanningRunTranscriptEntryDto[] | string;
  result: PlanningRunResultDto | string | null;
  total_cost_usd: string | number;
  error: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function numeric(value: string | number): number {
  return typeof value === "number" ? value : Number(value);
}

function jsonField<T>(value: T | string, fallback: T): T {
  if (typeof value === "string") return JSON.parse(value) as T;
  return value ?? fallback;
}

function rowToDto(row: PlanningRunRow): PlanningRunDto {
  return {
    id: row.id,
    project_id: row.project_id,
    status: row.status,
    round: row.round,
    max_rounds: row.max_rounds,
    review_rounds_total: row.max_rounds,
    rounds_completed: row.round,
    worker_providers: row.worker_providers,
    decision: row.decision
      ? jsonField(row.decision, null as unknown as PlanningRunDecisionDto)
      : null,
    objective: row.objective,
    transcript: jsonField(row.transcript, []),
    result: row.result ? jsonField(row.result, null as unknown as PlanningRunResultDto) : null,
    total_cost_usd: numeric(row.total_cost_usd),
    error: row.error,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

export interface CreatePlanningRunInput {
  objective: string;
  maxRounds?: number;
  /**
   * PHASE TAB P1: which implementation providers the allocation
   * recommendation may staff phases with. Defaults to "both".
   */
  workerProviders?: WorkerProviderSelection;
  /**
   * FRONT DOOR P4: objective image attachment ids to inject into this run's
   * round-1 PM and reviewer messages. Persisted on the run row so the worker
   * (which executes off a bare claim) can resolve them later. Order preserved.
   */
  attachmentIds?: readonly string[];
}

// ---------------------------------------------------------------------------
// PHASE TAB P1: the execution-kickoff seam for an approved planning run.
//
// Starting real execution from an approved plan is NOT a single call today:
// the plan must first be materialized into a phase + proposed StrategyVersion
// (StrategyBridgeService), that strategy approved (its own human-approval
// semantics), tasks and assignments created, and only then can
// PhaseLaunchService.startPhase dispatch work. Auto-driving that chain from a
// planning-run approval would silently bypass the strategy-approval gate, so
// the decision route instead calls this seam when (and only when) a
// deployment wires an implementation. Until one is wired, an approval is
// fully recorded (status, decision, staffing) and the response reports
// `execution: null` — honest, not silently pretending to have started work.
// ---------------------------------------------------------------------------
export interface ApprovedPlanExecutionKickoffInput {
  projectId: string;
  planningRunId: string;
  /** The approved plan (the run result's plan payload). */
  plan: unknown;
  /** Human staffing overrides recorded with the approval, if any. */
  staffing: readonly ApprovedStaffingEntryDto[] | null;
}

export interface ApprovedPlanExecutionKickoff {
  kickoff(
    input: ApprovedPlanExecutionKickoffInput,
  ): Promise<{ started: boolean; detail: string }>;
}

/** PHASE TAB P1: input for a human decision on a terminal-review run. */
export type PlanningRunDecisionInput =
  | { decision: "approve"; staffing?: readonly ApprovedStaffingEntryDto[] }
  | { decision: "modify"; direction: string }
  | { decision: "reject" };

export interface PlanningRunServiceOptions {
  now?: () => Date;
  defaultMaxRounds?: number;
}

export class PlanningRunService {
  private readonly now: () => Date;
  private readonly defaultMaxRounds: number;

  constructor(
    private readonly transactions: V2TransactionRunner,
    options: PlanningRunServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.defaultMaxRounds = options.defaultMaxRounds ?? 3;
  }

  async create(projectId: string, input: CreatePlanningRunInput): Promise<PlanningRunDto> {
    return this.transactions.transaction(async (tx) => {
      const project = await tx.query<{ id: string }>("SELECT id FROM projects WHERE id = $1", [
        projectId,
      ]);
      if (!project.rows[0]) {
        throw new PlanningRunConflictError("project_not_found", `unknown project "${projectId}"`);
      }
      const maxRounds = input.maxRounds ?? (await this.defaultMaxRoundsFor(tx, projectId));
      const id = newId("planning_run");
      const createdAt = this.now().toISOString();
      // FRONT DOOR P4: attachment_ids default to '[]' via the column default;
      // pass them through when the caller supplied objective attachments.
      const attachmentIds = JSON.stringify(input.attachmentIds ?? []);
      await tx.query(
        `INSERT INTO planning_runs (
           id, project_id, status, round, max_rounds, objective, transcript,
           result, total_cost_usd, error, created_at, updated_at, attachment_ids,
           worker_providers
         ) VALUES ($1,$2,'queued',0,$3,$4,'[]'::jsonb,NULL,0,NULL,$5,$5,$6::jsonb,$7)`,
        [
          id,
          projectId,
          maxRounds,
          input.objective,
          createdAt,
          attachmentIds,
          input.workerProviders ?? "both",
        ],
      );
      const row = await this.loadRow(tx, projectId, id);
      return rowToDto(row);
    });
  }

  async get(projectId: string, runId: string): Promise<PlanningRunDto> {
    return this.transactions.transaction(async (tx) =>
      rowToDto(await this.loadRow(tx, projectId, runId)),
    );
  }

  // ---------------------------------------------------------------------
  // PHASE TAB P1: human decision on a terminal-review run.
  //   approve — records the decision (with optional staffing overrides,
  //             validated at the route against the model registry) and moves
  //             the run to 'approved'. The result is retained: it is the plan
  //             the human approved.
  //   modify  — seeds revision_seed with { plan, direction } from the current
  //             result, clears the result, and re-queues the run. The worker
  //             consumes the seed on its next claim: instead of drafting from
  //             scratch it revises the prior plan under the human's direction
  //             and then runs review/revise cycles against the run's
  //             configured round cap (max_rounds) again.
  //   reject  — records the decision and moves the run to 'rejected'; the
  //             result is retained as the plan that was rejected.
  // Only valid while the run is converged or cap_reached; any other state
  // throws PlanningRunDecisionError (HTTP 409). Row-locked (FOR UPDATE) so a
  // concurrent decision or worker claim cannot interleave.
  // ---------------------------------------------------------------------
  async decide(
    projectId: string,
    runId: string,
    input: PlanningRunDecisionInput,
  ): Promise<PlanningRunDto> {
    return this.transactions.transaction(async (tx) => {
      const locked = await tx.query<PlanningRunRow>(
        "SELECT * FROM planning_runs WHERE id = $1 AND project_id = $2 FOR UPDATE",
        [runId, projectId],
      );
      const row = locked.rows[0];
      if (!row) {
        throw new PlanningRunConflictError(
          "planning_run_not_found",
          `unknown planning run "${runId}" for project "${projectId}"`,
        );
      }
      if (!DECIDABLE_PLANNING_RUN_STATUSES.includes(row.status)) {
        throw new PlanningRunDecisionError(
          "invalid_status",
          `planning run "${runId}" is "${row.status}"; decisions require converged or cap_reached`,
        );
      }
      const decidedAt = this.now().toISOString();
      const record: PlanningRunDecisionDto = {
        decision: input.decision,
        direction: input.decision === "modify" ? input.direction : null,
        staffing:
          input.decision === "approve" && input.staffing !== undefined
            ? [...input.staffing]
            : null,
        decided_at: decidedAt,
      };
      if (input.decision === "modify") {
        const result = row.result
          ? jsonField(row.result, null as unknown as PlanningRunResultDto)
          : null;
        const seed = JSON.stringify({ plan: result?.plan ?? null, direction: input.direction });
        await tx.query(
          `UPDATE planning_runs
           SET status = 'queued', round = 0, result = NULL, error = NULL,
               revision_seed = $3::jsonb, decision = $4::jsonb,
               lease_token = NULL, leased_until = NULL, updated_at = $5
           WHERE id = $1 AND project_id = $2`,
          [runId, projectId, seed, JSON.stringify(record), decidedAt],
        );
      } else {
        const status = input.decision === "approve" ? "approved" : "rejected";
        await tx.query(
          `UPDATE planning_runs
           SET status = $3, decision = $4::jsonb, updated_at = $5
           WHERE id = $1 AND project_id = $2`,
          [runId, projectId, status, JSON.stringify(record), decidedAt],
        );
      }
      return rowToDto(await this.loadRow(tx, projectId, runId));
    });
  }

  /** The project's persisted reviewer override, or null when unset. */
  async reviewerSelectionOf(projectId: string): Promise<PersistedReviewerSelection | null> {
    return this.transactions.transaction(async (tx) => {
      const result = await tx.query<{
        reviewer_provider: ProviderName | null;
        reviewer_model: string | null;
      }>(
        "SELECT reviewer_provider, reviewer_model FROM planning_reviewer_settings WHERE project_id = $1",
        [projectId],
      );
      const row = result.rows[0];
      if (!row?.reviewer_provider || !row.reviewer_model) return null;
      return { provider: row.reviewer_provider, model: row.reviewer_model };
    });
  }

  // ---------------------------------------------------------------------
  // FRONT DOOR P2b: write path for the reviewer override. P2 built the
  // storage (planning_reviewer_settings) and the read/resolution above; this
  // is the missing write. `selection: null` clears the override back to the
  // automatic opposite-provider default — resolvePlanningParticipants() picks
  // either state up unchanged on the next planning run, since it only reads
  // reviewerSelectionOf().
  // ---------------------------------------------------------------------
  async setReviewerSelection(
    projectId: string,
    selection: PersistedReviewerSelection | null,
  ): Promise<void> {
    await this.transactions.transaction(async (tx) => {
      const project = await tx.query<{ id: string }>("SELECT id FROM projects WHERE id = $1", [
        projectId,
      ]);
      if (!project.rows[0]) {
        throw new PlanningRunConflictError("project_not_found", `unknown project "${projectId}"`);
      }
      await tx.query(
        `INSERT INTO planning_reviewer_settings (project_id, reviewer_provider, reviewer_model)
         VALUES ($1, $2, $3)
         ON CONFLICT (project_id) DO UPDATE
           SET reviewer_provider = EXCLUDED.reviewer_provider,
               reviewer_model = EXCLUDED.reviewer_model,
               updated_at = now()`,
        [projectId, selection?.provider ?? null, selection?.model ?? null],
      );
    });
  }

  private async defaultMaxRoundsFor(tx: V2SqlExecutor, projectId: string): Promise<number> {
    const result = await tx.query<{ default_max_rounds: number }>(
      "SELECT default_max_rounds FROM planning_reviewer_settings WHERE project_id = $1",
      [projectId],
    );
    return result.rows[0]?.default_max_rounds ?? this.defaultMaxRounds;
  }

  private async loadRow(
    tx: V2SqlExecutor,
    projectId: string,
    runId: string,
  ): Promise<PlanningRunRow> {
    const result = await tx.query<PlanningRunRow>(
      "SELECT * FROM planning_runs WHERE id = $1 AND project_id = $2",
      [runId, projectId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new PlanningRunConflictError(
        "planning_run_not_found",
        `unknown planning run "${runId}" for project "${projectId}"`,
      );
    }
    return row;
  }
}
