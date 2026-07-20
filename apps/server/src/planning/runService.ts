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
  | "failed";

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

export interface PlanningRunDto {
  id: string;
  project_id: string;
  status: PlanningRunStatus;
  round: number;
  max_rounds: number;
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

interface PlanningRunRow {
  id: string;
  project_id: string;
  status: PlanningRunStatus;
  round: number;
  max_rounds: number;
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
}

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
      await tx.query(
        `INSERT INTO planning_runs (
           id, project_id, status, round, max_rounds, objective, transcript,
           result, total_cost_usd, error, created_at, updated_at
         ) VALUES ($1,$2,'queued',0,$3,$4,'[]'::jsonb,NULL,0,NULL,$5,$5)`,
        [id, projectId, maxRounds, input.objective, createdAt],
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
