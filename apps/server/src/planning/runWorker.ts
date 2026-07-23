// Single-instance MVP execution for durable planning runs (FRONT DOOR P2
// §D1). Claims one queued planning_runs row at a time and drives the
// existing runPlanning() loop (./session.ts) against it, persisting
// per-round progress via the loop's onRound hook and a definitive terminal
// result/failure when the loop returns.
//
// This does NOT make runPlanning() itself resumable mid-round: if the
// process dies while a run is in flight, nothing here restarts it from
// where it left off. What it guarantees instead is truthfulness — on
// startup, reconcileOrphans() marks any run left in a non-terminal state as
// failed with an honest reason, rather than leaving it silently stuck. That
// tradeoff assumes a single running instance, per the MVP scope; a
// multi-instance or rolling deploy would need lease-expiry-based recovery
// instead of the blanket "reconcile at boot" sweep used here.
import { randomUUID } from "node:crypto";
import type { ImagePart, LlmAdapter, ProviderName } from "@norns/adapters";
import { PlanContract, type PlanContractT } from "@norns/contracts";
import type { ReviewFindingT, UsageEventT } from "@norns/contracts";
import type { V2TransactionRunner } from "../persistence/v2/database.js";
import type {
  PlanningRunResultDto,
  PlanningRunStatus,
  PlanningRunTranscriptEntryDto,
  PlanningStaffingProposalDto,
  WorkerProviderSelection,
} from "./runService.js";
import type { PlanningRoundEvent, PlanningRoundHook } from "./session.js";
import { planContentHash, runPlanning } from "./session.js";

export type PlanningAdapterFactory = (provider: ProviderName, model: string) => LlmAdapter;

export interface ResolvedPlanningModels {
  pm: { provider: ProviderName; model: string };
  reviewer: { provider: ProviderName; model: string };
}

export interface PlanningStaffingInput {
  projectId: string;
  objective: string;
  plan: PlanContractT;
  /** PHASE TAB P1: the run's implementation-provider constraint. */
  workerProviders: WorkerProviderSelection;
}

export interface PlanningRunWorkerOptions {
  now?: () => Date;
  leaseMs?: number;
  /** Resolves the exact PM/reviewer provider+model pairing for a project. */
  resolveModels: (projectId: string) => Promise<ResolvedPlanningModels>;
  /**
   * Best-effort staffing recommendation (apps/server/src/planning/
   * allocationRecommendation.ts). A failure here never fails the run —
   * staffing_proposal is simply null in the result.
   */
  buildStaffingProposal?: (
    input: PlanningStaffingInput,
  ) => Promise<PlanningStaffingProposalDto | null>;
  /** Mirrors the existing live-planning route's cost-ledger append. */
  recordUsage?: (events: UsageEventT[]) => void;
  /**
   * FRONT DOOR P4: resolves a run's objective attachment ids to provider-neutral
   * image parts for round-1 injection. Best-effort — a failure or an empty
   * result simply means the run proceeds text-only; images never fail a run.
   */
  loadRoundOneImages?: (
    projectId: string,
    attachmentIds: readonly string[],
  ) => Promise<readonly ImagePart[]>;
}

interface ClaimedPlanningRunRow {
  id: string;
  project_id: string;
  objective: string;
  max_rounds: number;
  lease_token: string;
  /** FRONT DOOR P4: objective attachment ids to inject in round 1. */
  attachment_ids: string[] | string;
  /** PHASE TAB P1: implementation-provider constraint for staffing. */
  worker_providers: WorkerProviderSelection;
  /** PHASE TAB P1: { plan, direction } from a "modify" decision, or null. */
  revision_seed: unknown;
  /** PHASE TAB P1: transcript accumulated before a modify re-entry — the new
   *  loop's entries append to it rather than erasing the history. */
  transcript: PlanningRunTranscriptEntryDto[] | string;
}

function tally(findings: readonly ReviewFindingT[]) {
  const counts = { must_fix: 0, should_fix: 0, suggestion: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}

/** PHASE TAB P1: parse a claimed row's revision_seed (JSONB arrives parsed
 *  from node-pg/PGlite or, defensively, as a JSON string). Returns null when
 *  absent or malformed — a bad seed degrades to a from-scratch draft rather
 *  than failing the run. */
function parseRevisionSeed(value: unknown): { plan: PlanContractT; direction: string } | null {
  let raw = value;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (raw === null || typeof raw !== "object") return null;
  const candidate = raw as { plan?: unknown; direction?: unknown };
  if (typeof candidate.direction !== "string" || candidate.direction.trim().length === 0) {
    return null;
  }
  const plan = PlanContract.safeParse(candidate.plan);
  if (!plan.success) return null;
  return { plan: plan.data, direction: candidate.direction };
}

/** PHASE TAB P1: transcript accumulated before a modify re-entry. */
function parsePriorTranscript(
  value: PlanningRunTranscriptEntryDto[] | string | null | undefined,
): PlanningRunTranscriptEntryDto[] {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? (parsed as PlanningRunTranscriptEntryDto[]) : [];
    } catch {
      return [];
    }
  }
  return Array.isArray(value) ? [...value] : [];
}

function transcriptEntryFor(
  event: PlanningRoundEvent,
  models: ResolvedPlanningModels,
  /** PHASE TAB P1: true when the loop was seeded by a "modify" decision —
   *  the first PM output is then a human-directed revision, not a draft. */
  seeded = false,
): PlanningRunTranscriptEntryDto {
  if (event.phase === "review") {
    const counts = tally(event.findings ?? []);
    return {
      round: event.round,
      role: "reviewer",
      provider: models.reviewer.provider,
      model: models.reviewer.model,
      summary:
        `Reviewed v${event.round}: ${counts.must_fix} must-fix, ${counts.should_fix} ` +
        `should-fix, ${counts.suggestion} suggestion finding(s).`,
      finding_counts: counts,
    };
  }
  const summary =
    event.phase === "draft"
      ? seeded
        ? `Revised the plan per human direction (${event.plan.modules.length} module(s)).`
        : `Drafted the initial plan (${event.plan.modules.length} module(s)).`
      : `Revised the plan to address round ${event.round} findings (${event.plan.modules.length} module(s)).`;
  return {
    round: event.round,
    role: "pm",
    provider: models.pm.provider,
    model: models.pm.model,
    summary,
    finding_counts: null,
  };
}

/** Best-effort guess at the run's live status/round between checkpoints.
 * The terminal write after runPlanning() resolves always overrides this, so
 * an imprecise guess here (e.g. guessing "revising" for what turns out to be
 * the converging round) is harmless — it's only ever visible as an
 * in-progress snapshot to a polling client. */
function intermediateStatusFor(event: PlanningRoundEvent): {
  status: PlanningRunStatus;
  round: number;
} {
  if (event.phase === "draft") return { status: "reviewing", round: event.round };
  if (event.phase === "review") return { status: "revising", round: event.round };
  return { status: "reviewing", round: event.round + 1 };
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 4_000);
}

/** FRONT DOOR P4: JSONB comes back parsed (node-pg/PGlite) or, defensively, as
 *  a JSON string; either way yield an array of non-empty string ids. */
function parseAttachmentIds(value: string[] | string | null | undefined): string[] {
  const raw = typeof value === "string" ? safeJsonArray(value) : (value ?? []);
  return raw.filter((id): id is string => typeof id === "string" && id.length > 0);
}

function safeJsonArray(value: string): unknown[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export class PlanningRunWorker {
  private readonly now: () => Date;
  private readonly leaseMs: number;

  constructor(
    private readonly transactions: V2TransactionRunner,
    private readonly createAdapter: PlanningAdapterFactory,
    private readonly options: PlanningRunWorkerOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.leaseMs = options.leaseMs ?? 10 * 60_000;
  }

  /** Call once at startup, before any tick(). See the module-level note on
   *  what this does and does not guarantee. Returns the number of runs
   *  reconciled. */
  async reconcileOrphans(): Promise<number> {
    return this.transactions.transaction(async (tx) => {
      const result = await tx.query<{ id: string }>(
        `UPDATE planning_runs
         SET status = 'failed',
             error = 'orphaned: server restarted before the run completed',
             lease_token = NULL, leased_until = NULL, updated_at = $1
         WHERE status IN ('drafting','reviewing','revising')
         RETURNING id`,
        [this.now().toISOString()],
      );
      return result.rows.length;
    });
  }

  /** Processes at most one queued run. Safe to call from a recurring timer. */
  async tick(): Promise<"idle" | "processed"> {
    const claim = await this.claim();
    if (!claim) return "idle";
    await this.execute(claim);
    return "processed";
  }

  /** Claims and executes one specific run immediately (used right after
   *  creation so the common case has no poll latency). No-ops if the run is
   *  no longer queued (e.g. a concurrent tick already claimed it). */
  async runNow(runId: string): Promise<"processed" | "not_found"> {
    const claim = await this.claim(runId);
    if (!claim) return "not_found";
    await this.execute(claim);
    return "processed";
  }

  private async claim(runId?: string): Promise<ClaimedPlanningRunRow | null> {
    const leaseToken = randomUUID();
    const now = this.now();
    const leasedUntil = new Date(now.getTime() + this.leaseMs).toISOString();
    return this.transactions.transaction(async (tx) => {
      const sql = runId
        ? `WITH next_run AS (
             SELECT id FROM planning_runs WHERE id = $4 AND status = 'queued' FOR UPDATE SKIP LOCKED
           )
           UPDATE planning_runs SET status = 'drafting', lease_token = $1, leased_until = $2, updated_at = $3
           FROM next_run WHERE planning_runs.id = next_run.id
           RETURNING planning_runs.id, planning_runs.project_id, planning_runs.objective,
             planning_runs.max_rounds, planning_runs.lease_token, planning_runs.attachment_ids,
             planning_runs.worker_providers, planning_runs.revision_seed, planning_runs.transcript`
        : `WITH next_run AS (
             SELECT id FROM planning_runs WHERE status = 'queued'
             ORDER BY created_at ASC FOR UPDATE SKIP LOCKED LIMIT 1
           )
           UPDATE planning_runs SET status = 'drafting', lease_token = $1, leased_until = $2, updated_at = $3
           FROM next_run WHERE planning_runs.id = next_run.id
           RETURNING planning_runs.id, planning_runs.project_id, planning_runs.objective,
             planning_runs.max_rounds, planning_runs.lease_token, planning_runs.attachment_ids,
             planning_runs.worker_providers, planning_runs.revision_seed, planning_runs.transcript`;
      const params = runId
        ? [leaseToken, leasedUntil, now.toISOString(), runId]
        : [leaseToken, leasedUntil, now.toISOString()];
      const result = await tx.query<ClaimedPlanningRunRow>(sql, params);
      return result.rows[0] ?? null;
    });
  }

  private async execute(claim: ClaimedPlanningRunRow): Promise<void> {
    let models: ResolvedPlanningModels;
    try {
      models = await this.options.resolveModels(claim.project_id);
    } catch (error) {
      await this.fail(claim, error);
      return;
    }

    const pm = this.createAdapter(models.pm.provider, models.pm.model);
    const reviewer = this.createAdapter(models.reviewer.provider, models.reviewer.model);
    // PHASE TAB P1: a modify re-entry appends to the run's prior transcript
    // (the earlier rounds are history the human already saw) and seeds the
    // loop with the prior plan + the human's direction.
    const revisionSeed = parseRevisionSeed(claim.revision_seed);
    const transcript: PlanningRunTranscriptEntryDto[] = revisionSeed
      ? parsePriorTranscript(claim.transcript)
      : [];

    const onRound: PlanningRoundHook = async (event) => {
      transcript.push(transcriptEntryFor(event, models, revisionSeed !== null));
      const { status, round } = intermediateStatusFor(event);
      await this.persistProgress(claim, status, round, transcript);
    };

    // FRONT DOOR P4: resolve objective attachments to image parts for round-1
    // injection. Best-effort — a load failure degrades to a text-only run
    // rather than failing an otherwise-valid planning run. Seeded (modify)
    // re-entries never re-send images: the plan already encodes them.
    const roundOneImages = revisionSeed ? [] : await this.loadRoundOneImages(claim);

    try {
      const result = await runPlanning({
        pm,
        reviewer,
        objective: claim.objective,
        projectId: claim.project_id,
        maxRounds: claim.max_rounds,
        onRound,
        ...(roundOneImages.length > 0 ? { roundOneImages } : {}),
        ...(revisionSeed ? { revisionSeed } : {}),
      });
      this.options.recordUsage?.(result.usage);
      const totalCostUsd = result.usage.reduce((sum, usage) => sum + usage.estimated_cost_usd, 0);
      let staffingProposal: PlanningStaffingProposalDto | null = null;
      if (this.options.buildStaffingProposal) {
        try {
          staffingProposal = await this.options.buildStaffingProposal({
            projectId: claim.project_id,
            objective: claim.objective,
            plan: result.finalPlan,
            workerProviders: claim.worker_providers ?? "both",
          });
        } catch {
          // Best-effort: staffing never blocks a converged/cap_reached plan.
          staffingProposal = null;
        }
      }
      const resultDto: PlanningRunResultDto = {
        plan: result.finalPlan,
        content_hash: planContentHash(result.finalPlan),
        total_cost_usd: totalCostUsd,
        staffing_proposal: staffingProposal,
      };
      await this.persistTerminal(
        claim,
        result.status,
        result.rounds,
        transcript,
        resultDto,
        totalCostUsd,
      );
    } catch (error) {
      await this.fail(claim, error);
    }
  }

  /** FRONT DOOR P4: parse the claimed row's attachment ids and resolve them to
   *  image parts via the injected loader. Never throws — an empty list means
   *  the run proceeds text-only. */
  private async loadRoundOneImages(claim: ClaimedPlanningRunRow): Promise<readonly ImagePart[]> {
    if (!this.options.loadRoundOneImages) return [];
    const ids = parseAttachmentIds(claim.attachment_ids);
    if (ids.length === 0) return [];
    try {
      return await this.options.loadRoundOneImages(claim.project_id, ids);
    } catch {
      return [];
    }
  }

  private async persistProgress(
    claim: ClaimedPlanningRunRow,
    status: PlanningRunStatus,
    round: number,
    transcript: PlanningRunTranscriptEntryDto[],
  ): Promise<void> {
    await this.transactions.transaction(async (tx) => {
      await tx.query(
        `UPDATE planning_runs SET status = $2, round = $3, transcript = $4::jsonb, updated_at = $5
         WHERE id = $1 AND lease_token = $6`,
        [
          claim.id,
          status,
          round,
          JSON.stringify(transcript),
          this.now().toISOString(),
          claim.lease_token,
        ],
      );
    });
  }

  private async persistTerminal(
    claim: ClaimedPlanningRunRow,
    status: "converged" | "cap_reached",
    round: number,
    transcript: PlanningRunTranscriptEntryDto[],
    result: PlanningRunResultDto,
    totalCostUsd: number,
  ): Promise<void> {
    await this.transactions.transaction(async (tx) => {
      await tx.query(
        `UPDATE planning_runs
         SET status = $2, round = $3, transcript = $4::jsonb, result = $5::jsonb,
             -- PHASE TAB P1: accumulate — a modify re-entry's row already
             -- carries the prior loop's spend (0 for a fresh run).
             total_cost_usd = total_cost_usd + $6, error = NULL, revision_seed = NULL,
             lease_token = NULL, leased_until = NULL, updated_at = $7
         WHERE id = $1 AND lease_token = $8`,
        [
          claim.id,
          status,
          round,
          JSON.stringify(transcript),
          JSON.stringify(result),
          totalCostUsd,
          this.now().toISOString(),
          claim.lease_token,
        ],
      );
    });
  }

  private async fail(claim: ClaimedPlanningRunRow, error: unknown): Promise<void> {
    await this.transactions.transaction(async (tx) => {
      await tx.query(
        `UPDATE planning_runs
         SET status = 'failed', error = $2, lease_token = NULL, leased_until = NULL, updated_at = $3
         WHERE id = $1 AND lease_token = $4`,
        [claim.id, errorMessage(error), this.now().toISOString(), claim.lease_token],
      );
    });
  }
}
