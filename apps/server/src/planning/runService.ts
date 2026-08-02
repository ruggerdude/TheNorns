// Durable planning runs (FRONT DOOR P2 §D1): a pollable HTTP-facing record
// wrapped around the existing runPlanning() loop (./session.ts). This module
// owns only the "shell" — creation, status DTOs, and the persisted reviewer
// preference — the loop itself is untouched execution logic; see
// ./runWorker.ts for the part that actually drives runPlanning().
import type { ProviderName } from "@norns/adapters";
import { type CodexReasoningEffortT, V2QcMode, type V2QcModeT } from "@norns/contracts";
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
  | "cancelled"
  // PHASE TAB P1: terminal human-decision states. converged/cap_reached
  // continue to double as the awaiting-decision states (no separate
  // `awaiting_decision` status was added — a run in either state with no
  // decision recorded IS awaiting a decision).
  | "approved"
  | "rejected";

/** PHASE TAB P1: which implementation providers allocation staffing may use. */
export type WorkerProviderSelection = "anthropic" | "openai" | "both";
export type PlanningRunMode = "planned" | "quick" | "review_only";

/**
 * QCP-4A: the project-layer QC cadence default. Mirrors the CHECK constraint
 * on planning_reviewer_settings.qc_mode (drizzle/0064_qc_pause_points.sql).
 * A review pins its own qc_mode at kickoff (conversation_plan_reviews); this
 * is only the project default consulted at that pin.
 */
export const QC_MODES = V2QcMode.options;
export type QcMode = V2QcModeT;

export interface QcModeSettings {
  qcMode: QcMode;
  allowUnadjudicatedRebuttals: boolean;
}

export interface PlanningParticipantSelection {
  provider: ProviderName;
  model: string;
  reasoning_effort?: CodexReasoningEffortT | undefined;
}

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

/** Durable result of the automatic quick-change execution kickoff. */
export interface PlanningRunExecutionDto {
  started: boolean;
  detail: string;
}

/** PHASE TAB P1: an approved-staffing override for one plan/graph node. */
export interface ApprovedStaffingEntryDto {
  node_id: string;
  provider: ProviderName;
  model: string;
  reasoning_effort?: CodexReasoningEffortT | null | undefined;
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
  mode: PlanningRunMode;
  pm: PlanningParticipantSelection | null;
  agent: PlanningParticipantSelection | null;
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
  /**
   * Quick changes approve and start in the worker. Keeping the kickoff report
   * on the run makes the outcome recoverable after refresh or tab close.
   */
  execution: PlanningRunExecutionDto | null;
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
  mode: PlanningRunMode;
  pm_provider: ProviderName | null;
  pm_model: string | null;
  pm_reasoning_effort: CodexReasoningEffortT | null;
  agent_provider: ProviderName | null;
  agent_model: string | null;
  agent_reasoning_effort: CodexReasoningEffortT | null;
  status: PlanningRunStatus;
  round: number;
  max_rounds: number;
  worker_providers: WorkerProviderSelection;
  decision: PlanningRunDecisionDto | string | null;
  quick_kickoff_result: PlanningRunExecutionDto | string | null;
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
    mode: row.mode ?? "planned",
    pm:
      row.pm_provider && row.pm_model
        ? {
            provider: row.pm_provider,
            model: row.pm_model,
            ...(row.pm_reasoning_effort ? { reasoning_effort: row.pm_reasoning_effort } : {}),
          }
        : null,
    agent:
      row.agent_provider && row.agent_model
        ? {
            provider: row.agent_provider,
            model: row.agent_model,
            ...(row.agent_reasoning_effort ? { reasoning_effort: row.agent_reasoning_effort } : {}),
          }
        : null,
    status: row.status,
    round: row.round,
    max_rounds: row.max_rounds,
    review_rounds_total: row.mode === "quick" ? 0 : row.max_rounds,
    rounds_completed: row.round,
    worker_providers: row.worker_providers,
    decision: row.decision
      ? jsonField(row.decision, null as unknown as PlanningRunDecisionDto)
      : null,
    execution: row.quick_kickoff_result
      ? jsonField(row.quick_kickoff_result, null as unknown as PlanningRunExecutionDto)
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
  mode?: PlanningRunMode;
  /**
   * Authenticated human initiating the run. HTTP creation supplies this for
   * both planned and quick work so every later model call can retain the
   * original requester through asynchronous materialization and execution.
   */
  requestedBy?: string;
  pm?: PlanningParticipantSelection;
  agent?: PlanningParticipantSelection;
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
  /**
   * Conversation-first approvals bind this exact immutable handoff to every
   * materialized task and dispatch. Legacy planning-run approvals omit it.
   */
  handoffId?: string;
  // PHASE TAB P5b: no `plan` payload here — the kickoff implementation
  // deliberately re-loads the run itself (the bridge is the source of truth
  // for materialization), so passing the plan would be a dead field.
  /** Human staffing overrides recorded with the approval, if any. */
  staffing: readonly ApprovedStaffingEntryDto[] | null;
  /**
   * PHASE TAB P4: the id of the human whose decision approved the plan — the
   * session user behind the decision request. A kickoff implementation that
   * records a strategy approval MUST attribute it to this user:
   * `approvals.actor_id` carries a foreign key to `users`, so a synthetic
   * actor id would be refused by the database.
   */
  decidedBy: string;
}

export interface ApprovedPlanExecutionKickoff {
  kickoff(input: ApprovedPlanExecutionKickoffInput): Promise<{ started: boolean; detail: string }>;
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
      if (input.mode === "quick" && !input.requestedBy) {
        throw new Error("quick changes require the authenticated requesting user");
      }
      const id = newId("planning_run");
      const createdAt = this.now().toISOString();
      // FRONT DOOR P4: attachment_ids default to '[]' via the column default;
      // pass them through when the caller supplied objective attachments.
      const attachmentIds = JSON.stringify(input.attachmentIds ?? []);
      await tx.query(
        `INSERT INTO planning_runs (
           id, project_id, status, round, max_rounds, objective, transcript,
           result, total_cost_usd, error, created_at, updated_at, attachment_ids,
           worker_providers, mode, requested_by, initiated_by_user_id, pm_provider, pm_model,
           pm_reasoning_effort, agent_provider, agent_model, agent_reasoning_effort
         ) VALUES (
           $1,$2,'queued',0,$3,$4,'[]'::jsonb,NULL,0,NULL,$5,$5,$6::jsonb,$7,
           $8,$9,$9,$10,$11,$12,$13,$14,$15
         )`,
        [
          id,
          projectId,
          maxRounds,
          input.objective,
          createdAt,
          attachmentIds,
          input.workerProviders ?? "both",
          input.mode ?? "planned",
          input.requestedBy ?? null,
          input.pm?.provider ?? null,
          input.pm?.model ?? null,
          input.pm?.reasoning_effort ?? null,
          input.agent?.provider ?? null,
          input.agent?.model ?? null,
          input.agent?.reasoning_effort ?? null,
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

  /**
   * Returns the project's newest planning run, if one exists.
   *
   * Planning is a durable journey, so the browser must be able to recover it
   * without a transient navigation hint. Ordering by creation time and id
   * makes the result deterministic even when two runs are created in the same
   * database clock tick.
   */
  async latest(projectId: string): Promise<PlanningRunDto | null> {
    return this.transactions.transaction(async (tx) => {
      const project = await tx.query<{ id: string }>("SELECT id FROM projects WHERE id = $1", [
        projectId,
      ]);
      if (!project.rows[0]) {
        throw new PlanningRunConflictError("project_not_found", `unknown project "${projectId}"`);
      }
      const result = await tx.query<PlanningRunRow>(
        `SELECT * FROM planning_runs
         WHERE project_id = $1
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
        [projectId],
      );
      const row = result.rows[0];
      return row ? rowToDto(row) : null;
    });
  }

  /** Every durable planning/work conversation for the project, newest first. */
  async list(projectId: string): Promise<PlanningRunDto[]> {
    return this.transactions.transaction(async (tx) => {
      const project = await tx.query<{ id: string }>("SELECT id FROM projects WHERE id = $1", [
        projectId,
      ]);
      if (!project.rows[0]) {
        throw new PlanningRunConflictError("project_not_found", `unknown project "${projectId}"`);
      }
      const result = await tx.query<PlanningRunRow>(
        `SELECT * FROM planning_runs
         WHERE project_id = $1
         ORDER BY created_at DESC, id DESC`,
        [projectId],
      );
      return result.rows.map(rowToDto);
    });
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
          input.decision === "approve" && input.staffing !== undefined ? [...input.staffing] : null,
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

  /**
   * QCP-4A: the project's QC cadence default. Absent a row (or a project that
   * never touched planning settings at all), this is `automatic` /
   * `false` — the shipped default that changes no existing behavior.
   */
  /**
   * The project's default review round count. Zero means QC is off for this
   * project — surfaces key "does this project run QC at all" off this, not
   * off whether a given conversation happens to have reviews yet.
   */
  async defaultMaxRoundsOf(projectId: string): Promise<number> {
    return this.transactions.transaction((tx) => this.defaultMaxRoundsFor(tx, projectId));
  }

  async qcModeSettingsOf(projectId: string): Promise<QcModeSettings> {
    return this.transactions.transaction(async (tx) => {
      const result = await tx.query<{
        qc_mode: QcMode;
        allow_unadjudicated_rebuttals: boolean;
      }>(
        "SELECT qc_mode, allow_unadjudicated_rebuttals FROM planning_reviewer_settings WHERE project_id = $1",
        [projectId],
      );
      const row = result.rows[0];
      return {
        qcMode: row?.qc_mode ?? "automatic",
        allowUnadjudicatedRebuttals: row?.allow_unadjudicated_rebuttals ?? false,
      };
    });
  }

  // ---------------------------------------------------------------------
  // QCP-4A: write path for the project-layer qc_mode default and its
  // allow_unadjudicated_rebuttals escape hatch. Each field is independently
  // optional — omitting one leaves it untouched (COALESCE against the
  // existing row on conflict, against the column's own DB default on first
  // insert) so a caller can change just one setting without first reading
  // the other back. This never reaches into runs already in flight: a review
  // pins its own qc_mode at kickoff (conversation_plan_reviews.qc_mode) and
  // never re-reads this table.
  //
  // QCP-12: default_max_rounds joined the same independently-optional
  // COALESCE chain so a post-creation settings write can change any subset
  // of the three fields without clobbering the others or the reviewer
  // provider/model override (a separate row write, untouched here).
  // ---------------------------------------------------------------------
  async setQcModeSettings(
    projectId: string,
    settings: {
      qcMode?: QcMode | undefined;
      allowUnadjudicatedRebuttals?: boolean | undefined;
      defaultMaxRounds?: number | undefined;
    },
  ): Promise<void> {
    await this.transactions.transaction(async (tx) => {
      const project = await tx.query<{ id: string }>("SELECT id FROM projects WHERE id = $1", [
        projectId,
      ]);
      if (!project.rows[0]) {
        throw new PlanningRunConflictError("project_not_found", `unknown project "${projectId}"`);
      }
      await tx.query(
        `INSERT INTO planning_reviewer_settings
           (project_id, qc_mode, allow_unadjudicated_rebuttals, default_max_rounds)
         VALUES ($1, COALESCE($2, 'automatic'), COALESCE($3, false), COALESCE($4::integer, $5::integer))
         ON CONFLICT (project_id) DO UPDATE
           SET qc_mode = COALESCE($2, planning_reviewer_settings.qc_mode),
               allow_unadjudicated_rebuttals =
                 COALESCE($3, planning_reviewer_settings.allow_unadjudicated_rebuttals),
               default_max_rounds =
                 COALESCE($4::integer, planning_reviewer_settings.default_max_rounds),
               updated_at = now()`,
        [
          projectId,
          settings.qcMode ?? null,
          settings.allowUnadjudicatedRebuttals ?? null,
          settings.defaultMaxRounds ?? null,
          this.defaultMaxRounds,
        ],
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
