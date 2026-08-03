// Single-instance MVP execution for durable planning runs (FRONT DOOR P2
// §D1). Claims one queued planning_runs row at a time and drives the
// existing runPlanning() loop (./session.ts) against it, persisting
// per-round progress via the loop's onRound hook and a definitive terminal
// result/failure when the loop returns.
//
// General planning runs still fail truthfully when interrupted mid-round.
// Review-only QC is restart-safe at provider-step boundaries: normalized
// reviewer/revision output is checkpointed with the exact current plan, an
// expired lease is requeued, and a new claim resumes after that step. A call
// that was still in flight at process death may be repeated because providers
// do not expose a portable idempotency guarantee.
import { randomUUID } from "node:crypto";
import type { ImagePart, LlmAdapter, ProviderName } from "@norns/adapters";
import { type CodexReasoningEffortT, PlanContract, type PlanContractT } from "@norns/contracts";
import type { ReviewFindingT, UsageEventT } from "@norns/contracts";
import type { V2QcRevisionFormatT, V2WorkPlanContractT } from "@norns/contracts";
import type { V2TransactionRunner } from "../persistence/v2/database.js";
import {
  type QcMode,
  type ReviewOnlyChatEvent,
  type ReviewOnlyDurableCheckpoint,
  type ReviewOnlyPlanningPausedResult,
  type ReviewOnlyPlanningResult,
  type ReviewOnlyProgressEvent,
  type ReviewOnlyResumeState,
  type ReviewOnlyRound,
  runReviewOnlyPlanning,
} from "./reviewOnlySession.js";
import type {
  ApprovedPlanExecutionKickoff,
  PlanningRunDecisionDto,
  PlanningRunExecutionDto,
  PlanningRunMode,
  PlanningRunResultDto,
  PlanningRunStatus,
  PlanningRunTranscriptEntryDto,
  PlanningStaffingProposalDto,
  WorkerProviderSelection,
} from "./runService.js";
import type { PlanningRoundEvent, PlanningRoundHook } from "./session.js";
import { planContentHash, runPlanning, runQuickPlanning } from "./session.js";

export type PlanningAdapterFactory = (
  provider: ProviderName,
  model: string,
  reasoningEffort?: CodexReasoningEffortT,
) => LlmAdapter;

export interface ResolvedPlanningModels {
  pm: {
    provider: ProviderName;
    model: string;
    reasoning_effort?: CodexReasoningEffortT;
  };
  reviewer: { provider: ProviderName; model: string };
}

export interface PlanningStaffingInput {
  projectId: string;
  initiatedByUserId: string | null;
  objective: string;
  plan: PlanContractT;
  pm: ResolvedPlanningModels["pm"];
  /** PHASE TAB P1: the run's implementation-provider constraint. */
  workerProviders: WorkerProviderSelection;
}

export interface PlanningRunWorkerOptions {
  now?: () => Date;
  leaseMs?: number;
  /** Short renewable lease for review-only work so a hard crash recovers
   * promptly without allowing a rolling-deploy peer to steal a live call. */
  reviewLeaseMs?: number;
  /** Delay before retrying a kickoff seam that threw before returning. */
  kickoffRetryMs?: number;
  /**
   * Durable quick-change execution seam. Quick plans are approved in the
   * same transaction as their terminal result, then claimed from the
   * persisted kickoff outbox and sent through this idempotent saga.
   */
  executionKickoff?: ApprovedPlanExecutionKickoff;
  /** Resolves the exact PM/reviewer provider+model pairing for a project. */
  resolveModels: (
    projectId: string,
    run?: {
      mode: PlanningRunMode;
      pm: {
        provider: ProviderName;
        model: string;
        reasoning_effort?: CodexReasoningEffortT;
      } | null;
    },
  ) => Promise<ResolvedPlanningModels>;
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
  loadReviewOnlySeed?: (
    runId: string,
    leaseToken?: string,
  ) => Promise<{
    reviewId: string;
    usageRequestGroupId: string;
    initiatedByUserId: string;
    seedPlan: V2WorkPlanContractT;
    frozenContext: unknown;
    qcMode: QcMode;
    allowUnadjudicatedRebuttals: boolean;
    revisionFormat?: V2QcRevisionFormatT;
    /** Set when this run is a resumed park; rebuilt from the review's own
     *  persisted state (pinned reviewer/PM identity, interim plan, rehydrated
     *  round exchanges) — never re-derived from current project settings. */
    resume?: ReviewOnlyResumeState;
  }>;
  markReviewOnlyStarted?: (reviewId: string, leaseToken?: string) => Promise<void>;
  recordReviewOnlyProgress?: (input: {
    reviewId: string;
    planningRunId: string;
    rounds: readonly ReviewOnlyRound[];
    leaseToken?: string;
  }) => Promise<void>;
  recordReviewOnlyCheckpoint?: (input: {
    reviewId: string;
    planningRunId: string;
    checkpoint: ReviewOnlyDurableCheckpoint;
    leaseToken?: string;
  }) => Promise<void>;
  recordReviewOnlyChatEvent?: (input: {
    reviewId: string;
    planningRunId: string;
    event: ReviewOnlyChatEvent;
    leaseToken?: string;
  }) => Promise<void>;
  recordReviewOnlyStage?: (input: {
    reviewId: string;
    planningRunId: string;
    event: ReviewOnlyProgressEvent;
    leaseToken?: string;
  }) => Promise<void>;
  completeReviewOnly?: (input: {
    reviewId: string;
    planningRunId: string;
    result: ReviewOnlyPlanningResult;
    totalCostUsd: number;
    leaseToken?: string;
  }) => Promise<void>;
  /** A gate parked the review durably — distinct from complete/fail. See
   *  "Durability: a gate parks, it does not wait" (QC-PAUSE-POINTS.md). */
  pauseReviewOnly?: (input: {
    reviewId: string;
    planningRunId: string;
    result: ReviewOnlyPlanningPausedResult;
    leaseToken?: string;
  }) => Promise<void>;
  failReviewOnly?: (planningRunId: string, error: unknown, leaseToken?: string) => Promise<void>;
}

interface ClaimedPlanningRunRow {
  id: string;
  project_id: string;
  mode: PlanningRunMode;
  requested_by: string | null;
  pm_provider: ProviderName | null;
  pm_model: string | null;
  pm_reasoning_effort: CodexReasoningEffortT | null;
  agent_provider: ProviderName | null;
  agent_model: string | null;
  agent_reasoning_effort: CodexReasoningEffortT | null;
  objective: string;
  max_rounds: number;
  lease_token: string;
  execution_attempt: number;
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

interface ClaimedQuickKickoffRow {
  id: string;
  project_id: string;
  requested_by: string;
  decision: PlanningRunDecisionDto | string;
  lease_token: string;
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
  private readonly reviewLeaseMs: number;
  private readonly kickoffRetryMs: number;
  private readonly activeReviewControllers = new Map<
    string,
    { controller: AbortController; leaseToken: string }
  >();
  private draining = false;

  constructor(
    private readonly transactions: V2TransactionRunner,
    private readonly createAdapter: PlanningAdapterFactory,
    private readonly options: PlanningRunWorkerOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.leaseMs = options.leaseMs ?? 10 * 60_000;
    this.reviewLeaseMs = options.reviewLeaseMs ?? 45_000;
    this.kickoffRetryMs = options.kickoffRetryMs ?? 30_000;
  }

  cancelReview(runId: string): boolean {
    const active = this.activeReviewControllers.get(runId);
    active?.controller.abort();
    return active !== undefined;
  }

  /** Stop accepting work and durably release every review claim owned by this
   * process. The lease-token predicate fences late provider callbacks. */
  async drain(): Promise<void> {
    this.draining = true;
    const active = [...this.activeReviewControllers.entries()];
    if (active.length > 0) {
      await this.transactions.transaction(async (tx) => {
        for (const [runId, claim] of active) {
          await tx.query(
            `UPDATE planning_runs
                SET status='queued', error=NULL, live_progress=NULL,
                    lease_token=NULL, leased_until=NULL, updated_at=$3
              WHERE id=$1 AND mode='review_only' AND lease_token=$2
                AND status IN ('drafting','reviewing','revising')`,
            [runId, claim.leaseToken, this.now().toISOString()],
          );
        }
      });
      for (const [, claim] of active) claim.controller.abort();
    }
  }

  private async recoverExpiredReviewOnly(): Promise<number> {
    return this.transactions.transaction(async (tx) => {
      const recovered = await tx.query<{ id: string }>(
        `UPDATE planning_runs
            SET status='queued', error=NULL, live_progress=NULL,
                lease_token=NULL, leased_until=NULL, updated_at=$1
          WHERE mode='review_only'
            AND status IN ('drafting','reviewing','revising')
            AND (leased_until IS NULL OR leased_until <= $1)
          RETURNING id`,
        [this.now().toISOString()],
      );
      return recovered.rows.length;
    });
  }

  /** Call once at startup, before any tick(). See the module-level note on
   *  what this does and does not guarantee. Returns the number of runs
   *  reconciled. */
  async reconcileOrphans(): Promise<number> {
    const reconciled = await this.transactions.transaction(async (tx) => {
      const planning = await tx.query<{ id: string }>(
        `UPDATE planning_runs
         SET status = 'failed',
             error = 'orphaned: server restarted before the run completed',
             lease_token = NULL, leased_until = NULL, updated_at = $1
         WHERE mode <> 'review_only'
           AND status IN ('drafting','reviewing','revising')
         RETURNING id`,
        [this.now().toISOString()],
      );
      // A quick kickoff is a durable outbox operation. Unlike an interrupted
      // LLM round, it is safe to resume because the downstream saga is keyed
      // by planning_run_id and is idempotent at every materialization step.
      const kickoff = await tx.query<{ id: string }>(
        `UPDATE planning_runs
         SET quick_kickoff_status = 'pending',
             lease_token = NULL, leased_until = NULL, updated_at = $1
         WHERE mode = 'quick' AND status = 'approved'
           AND quick_kickoff_status = 'in_progress'
         RETURNING id`,
        [this.now().toISOString()],
      );
      return {
        count: planning.rows.length + kickoff.rows.length,
      };
    });
    return reconciled.count + (await this.recoverExpiredReviewOnly());
  }

  /** Processes at most one planning run or pending quick kickoff. */
  async tick(): Promise<"idle" | "processed"> {
    if (this.draining) return "idle";
    await this.recoverExpiredReviewOnly();
    const claim = await this.claim();
    if (claim) {
      await this.execute(claim);
      return "processed";
    }
    return (await this.executeQuickKickoff()) ? "processed" : "idle";
  }

  /** Claims and executes one specific run immediately (used right after
   *  creation so the common case has no poll latency). No-ops if the run is
   *  no longer queued (e.g. a concurrent tick already claimed it). */
  async runNow(runId: string): Promise<"processed" | "not_found"> {
    if (this.draining) return "not_found";
    const claim = await this.claim(runId);
    if (claim) {
      await this.execute(claim);
      return "processed";
    }
    return (await this.executeQuickKickoff(runId)) ? "processed" : "not_found";
  }

  private async claim(runId?: string): Promise<ClaimedPlanningRunRow | null> {
    const leaseToken = randomUUID();
    const now = this.now();
    const leasedUntil = new Date(now.getTime() + this.leaseMs).toISOString();
    const reviewLeasedUntil = new Date(now.getTime() + this.reviewLeaseMs).toISOString();
    return this.transactions.transaction(async (tx) => {
      const sql = runId
        ? `WITH next_run AS (
             SELECT id FROM planning_runs WHERE id = $4 AND status = 'queued' FOR UPDATE SKIP LOCKED
           )
           UPDATE planning_runs SET
             status = CASE planning_runs.mode WHEN 'review_only' THEN 'reviewing' ELSE 'drafting' END,
             execution_attempt = planning_runs.execution_attempt + 1,
             lease_token = $1,
             leased_until = CASE WHEN planning_runs.mode='review_only'
               THEN $5::timestamptz ELSE $2::timestamptz END,
             updated_at = $3
           FROM next_run WHERE planning_runs.id = next_run.id
           RETURNING planning_runs.id, planning_runs.project_id, planning_runs.objective,
             planning_runs.max_rounds, planning_runs.lease_token, planning_runs.execution_attempt,
             planning_runs.attachment_ids,
             planning_runs.worker_providers, planning_runs.revision_seed, planning_runs.transcript,
             planning_runs.mode, planning_runs.requested_by,
             planning_runs.pm_provider, planning_runs.pm_model, planning_runs.pm_reasoning_effort,
             planning_runs.agent_provider, planning_runs.agent_model,
             planning_runs.agent_reasoning_effort`
        : `WITH next_run AS (
             SELECT id FROM planning_runs WHERE status = 'queued'
             ORDER BY created_at ASC FOR UPDATE SKIP LOCKED LIMIT 1
           )
           UPDATE planning_runs SET
             status = CASE planning_runs.mode WHEN 'review_only' THEN 'reviewing' ELSE 'drafting' END,
             execution_attempt = planning_runs.execution_attempt + 1,
             lease_token = $1,
             leased_until = CASE WHEN planning_runs.mode='review_only'
               THEN $4::timestamptz ELSE $2::timestamptz END,
             updated_at = $3
           FROM next_run WHERE planning_runs.id = next_run.id
           RETURNING planning_runs.id, planning_runs.project_id, planning_runs.objective,
             planning_runs.max_rounds, planning_runs.lease_token, planning_runs.execution_attempt,
             planning_runs.attachment_ids,
             planning_runs.worker_providers, planning_runs.revision_seed, planning_runs.transcript,
             planning_runs.mode, planning_runs.requested_by,
             planning_runs.pm_provider, planning_runs.pm_model, planning_runs.pm_reasoning_effort,
             planning_runs.agent_provider, planning_runs.agent_model,
             planning_runs.agent_reasoning_effort`;
      const params = runId
        ? [leaseToken, leasedUntil, now.toISOString(), runId, reviewLeasedUntil]
        : [leaseToken, leasedUntil, now.toISOString(), reviewLeasedUntil];
      const result = await tx.query<ClaimedPlanningRunRow>(sql, params);
      return result.rows[0] ?? null;
    });
  }

  private async execute(claim: ClaimedPlanningRunRow): Promise<void> {
    const quick = claim.mode === "quick";
    const reviewOnly = claim.mode === "review_only";
    const pmOverride =
      claim.pm_provider && claim.pm_model
        ? {
            provider: claim.pm_provider,
            model: claim.pm_model,
            ...(claim.pm_reasoning_effort ? { reasoning_effort: claim.pm_reasoning_effort } : {}),
          }
        : null;
    let models: ResolvedPlanningModels;
    try {
      if (reviewOnly) {
        if (!pmOverride || !claim.agent_provider || !claim.agent_model) {
          throw new Error("review-only planning run is missing durable PM/reviewer model pins");
        }
        models = {
          pm: pmOverride,
          reviewer: {
            provider: claim.agent_provider,
            model: claim.agent_model,
          },
        };
      } else {
        models = await this.options.resolveModels(claim.project_id, {
          mode: claim.mode ?? "planned",
          pm: pmOverride,
        });
      }
    } catch (error) {
      if (reviewOnly && this.options.failReviewOnly) {
        await this.options.failReviewOnly(claim.id, error, claim.lease_token);
      } else {
        await this.fail(claim, error);
      }
      return;
    }

    let pm: LlmAdapter;
    let reviewer: LlmAdapter | null;
    try {
      pm = this.createAdapter(models.pm.provider, models.pm.model, models.pm.reasoning_effort);
      reviewer = quick ? null : this.createAdapter(models.reviewer.provider, models.reviewer.model);
    } catch (error) {
      if (reviewOnly && this.options.failReviewOnly) {
        await this.options.failReviewOnly(claim.id, error, claim.lease_token);
      } else {
        await this.fail(claim, error);
      }
      return;
    }

    if (reviewOnly) {
      await this.executeReviewOnly(claim, pm, reviewer, models);
      return;
    }
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
      if (quick) {
        const result = await runQuickPlanning({
          pm,
          objective: claim.objective,
          projectId: claim.project_id,
          ...(claim.requested_by ? { initiatedByUserId: claim.requested_by } : {}),
          ...(roundOneImages.length > 0 ? { images: roundOneImages } : {}),
        });
        this.options.recordUsage?.(result.usage);
        const totalCostUsd = result.usage.reduce((sum, usage) => sum + usage.estimated_cost_usd, 0);
        transcript.push({
          round: 0,
          role: "pm",
          provider: models.pm.provider,
          model: models.pm.model,
          summary: "Prepared one executable quick-change task.",
          finding_counts: null,
        });
        let staffingProposal: PlanningStaffingProposalDto | null = null;
        if (claim.agent_provider && claim.agent_model) {
          staffingProposal = {
            summary: `Quick change assigned to ${claim.agent_provider}:${claim.agent_model}.`,
            recommendations: result.finalPlan.modules.map((module) => ({
              node_id: module.id,
              provider: claim.agent_provider,
              model: claim.agent_model,
              reasoning_effort: claim.agent_reasoning_effort,
              worker_count: 1,
              budget_usd: 25,
              rationale: "Agent explicitly selected for this quick change.",
            })),
          };
        } else if (this.options.buildStaffingProposal) {
          try {
            staffingProposal = await this.options.buildStaffingProposal({
              projectId: claim.project_id,
              initiatedByUserId: claim.requested_by,
              objective: claim.objective,
              plan: result.finalPlan,
              pm: models.pm,
              workerProviders: claim.worker_providers ?? "both",
            });
          } catch {
            // The quick change remains durable even if an allocation call
            // fails. The bridge's explicit fallback keeps execution truthful.
            staffingProposal = null;
          }
        }
        const resultDto: PlanningRunResultDto = {
          plan: result.finalPlan,
          content_hash: planContentHash(result.finalPlan),
          total_cost_usd: totalCostUsd,
          staffing_proposal: staffingProposal,
        };
        // A quick change has no human-review checkpoint. Persisting the plan,
        // approval, actor, and pending kickoff together means correctness
        // never depends on a React effect surviving navigation or tab close.
        const approved = await this.persistQuickApproval(
          claim,
          transcript,
          resultDto,
          totalCostUsd,
        );
        if (approved) await this.executeQuickKickoff(claim.id);
        return;
      }

      if (!reviewer) throw new Error("planned run is missing its reviewer");
      const result = await runPlanning({
        pm,
        reviewer,
        objective: claim.objective,
        projectId: claim.project_id,
        ...(claim.requested_by ? { initiatedByUserId: claim.requested_by } : {}),
        maxRounds: claim.max_rounds,
        onRound,
        ...(roundOneImages.length > 0 ? { roundOneImages } : {}),
        ...(revisionSeed ? { revisionSeed } : {}),
      });
      this.options.recordUsage?.(result.usage);
      const totalCostUsd = result.usage.reduce((sum, usage) => sum + usage.estimated_cost_usd, 0);
      let staffingProposal: PlanningStaffingProposalDto | null = null;
      if (claim.agent_provider && claim.agent_model) {
        staffingProposal = {
          summary: `Plan assigned to ${claim.agent_provider}:${claim.agent_model}.`,
          recommendations: result.finalPlan.modules.map((module) => ({
            node_id: module.id,
            provider: claim.agent_provider,
            model: claim.agent_model,
            reasoning_effort: claim.agent_reasoning_effort,
            worker_count: 1,
            budget_usd: 25,
            rationale: "Agent explicitly selected for this run.",
          })),
        };
      } else if (this.options.buildStaffingProposal) {
        try {
          staffingProposal = await this.options.buildStaffingProposal({
            projectId: claim.project_id,
            initiatedByUserId: claim.requested_by,
            objective: claim.objective,
            plan: result.finalPlan,
            pm: models.pm,
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

  private async executeReviewOnly(
    claim: ClaimedPlanningRunRow,
    pm: LlmAdapter,
    reviewer: LlmAdapter | null,
    models: ResolvedPlanningModels,
  ): Promise<void> {
    const controller = new AbortController();
    this.activeReviewControllers.set(claim.id, {
      controller,
      leaseToken: claim.lease_token,
    });
    const heartbeat = setInterval(
      () => {
        void this.renewReviewLease(claim).catch(() => undefined);
      },
      Math.max(1_000, Math.floor(this.reviewLeaseMs / 3)),
    );
    heartbeat.unref?.();
    try {
      if (
        !reviewer ||
        !this.options.loadReviewOnlySeed ||
        !this.options.markReviewOnlyStarted ||
        !this.options.completeReviewOnly ||
        !this.options.pauseReviewOnly ||
        !this.options.failReviewOnly
      ) {
        throw new Error("review-only planning workflow is not configured");
      }
      const seed = await this.options.loadReviewOnlySeed(claim.id, claim.lease_token);
      const preparingRound = seed.resume
        ? seed.resume.checkpoint === "after_review"
          ? seed.resume.fromRound
          : seed.resume.fromRound + 1
        : 1;
      await this.options.recordReviewOnlyStage?.({
        reviewId: seed.reviewId,
        planningRunId: claim.id,
        leaseToken: claim.lease_token,
        event: {
          stage: "preparing",
          round: preparingRound,
          attempt: 1,
          provider: reviewer.provider,
          model: reviewer.model,
          completedItems: 0,
          totalItems: seed.seedPlan.plan.modules.length,
          activity: "Preparing the plan for independent quality review",
        },
      });
      await this.options.markReviewOnlyStarted(seed.reviewId, claim.lease_token);
      const result = await runReviewOnlyPlanning({
        pm,
        reviewer,
        projectId: claim.project_id,
        initiatedByUserId: seed.initiatedByUserId,
        seedPlan: seed.seedPlan,
        frozenContext: seed.frozenContext,
        telemetryGroupId: seed.usageRequestGroupId,
        maxRounds: claim.max_rounds,
        signal: controller.signal,
        qcMode: seed.qcMode,
        allowUnadjudicatedRebuttals: seed.allowUnadjudicatedRebuttals,
        revisionFormat: seed.revisionFormat ?? "legacy_full",
        executionAttempt: claim.execution_attempt,
        ...(seed.resume ? { resume: seed.resume } : {}),
        onCheckpoint: (checkpoint: ReviewOnlyDurableCheckpoint) =>
          this.options.recordReviewOnlyCheckpoint?.({
            reviewId: seed.reviewId,
            planningRunId: claim.id,
            checkpoint,
            leaseToken: claim.lease_token,
          }),
        ...(this.options.recordReviewOnlyProgress
          ? {
              onProgress: (rounds: readonly ReviewOnlyRound[]) =>
                this.options.recordReviewOnlyProgress?.({
                  reviewId: seed.reviewId,
                  planningRunId: claim.id,
                  rounds,
                  leaseToken: claim.lease_token,
                }),
            }
          : {}),
        ...(this.options.recordReviewOnlyChatEvent
          ? {
              onChatEvent: (event: ReviewOnlyChatEvent) =>
                this.options.recordReviewOnlyChatEvent?.({
                  reviewId: seed.reviewId,
                  planningRunId: claim.id,
                  event,
                  leaseToken: claim.lease_token,
                }),
            }
          : {}),
        ...(this.options.recordReviewOnlyStage
          ? {
              onStage: (event: ReviewOnlyProgressEvent) =>
                this.options.recordReviewOnlyStage?.({
                  reviewId: seed.reviewId,
                  planningRunId: claim.id,
                  event,
                  leaseToken: claim.lease_token,
                }),
              onOutput: (event: ReviewOnlyProgressEvent) =>
                this.options.recordReviewOnlyStage?.({
                  reviewId: seed.reviewId,
                  planningRunId: claim.id,
                  event,
                  leaseToken: claim.lease_token,
                }),
            }
          : {}),
      });
      this.options.recordUsage?.(result.usage);
      if (result.status === "paused") {
        // A gate parked the review — this is neither a completion nor a
        // failure. No await on a human here: pauseReviewOnly persists state
        // and releases the lease, then this method returns and the worker
        // exits, exactly like the completed/failed paths below.
        await this.options.pauseReviewOnly({
          reviewId: seed.reviewId,
          planningRunId: claim.id,
          result,
          leaseToken: claim.lease_token,
        });
        return;
      }
      const totalCostUsd = result.usage.reduce(
        (total, usage) => total + usage.estimated_cost_usd,
        0,
      );
      await this.options.completeReviewOnly({
        reviewId: seed.reviewId,
        planningRunId: claim.id,
        result,
        totalCostUsd,
        leaseToken: claim.lease_token,
      });
    } catch (error) {
      if (!(this.draining && controller.signal.aborted)) {
        await this.options.failReviewOnly?.(claim.id, error, claim.lease_token);
      }
    } finally {
      clearInterval(heartbeat);
      this.activeReviewControllers.delete(claim.id);
    }
    void models;
  }

  private async renewReviewLease(claim: ClaimedPlanningRunRow): Promise<void> {
    const now = this.now();
    const leasedUntil = new Date(now.getTime() + this.reviewLeaseMs).toISOString();
    await this.transactions.transaction(async (tx) => {
      await tx.query(
        `UPDATE planning_runs
            SET leased_until=$3, updated_at=$4
          WHERE id=$1 AND mode='review_only' AND lease_token=$2
            AND status IN ('reviewing','revising')`,
        [claim.id, claim.lease_token, leasedUntil, now.toISOString()],
      );
    });
  }

  /**
   * Claims and executes one durable quick-change kickoff. There may be more
   * than one invocation after a process death between the external call and
   * the completion write; the kickoff saga's planning_run_id idempotency
   * makes the observable phase/task/run effects exactly once.
   */
  private async executeQuickKickoff(runId?: string): Promise<boolean> {
    if (!this.options.executionKickoff) return false;
    const claim = await this.claimQuickKickoff(runId);
    if (!claim) return false;
    try {
      const decision =
        typeof claim.decision === "string"
          ? (JSON.parse(claim.decision) as PlanningRunDecisionDto)
          : claim.decision;
      const report = await this.options.executionKickoff.kickoff({
        projectId: claim.project_id,
        planningRunId: claim.id,
        staffing: decision.staffing ?? null,
        decidedBy: claim.requested_by,
      });
      await this.completeQuickKickoff(claim, report);
    } catch (error) {
      await this.retryQuickKickoff(claim, error);
    }
    return true;
  }

  private async claimQuickKickoff(runId?: string): Promise<ClaimedQuickKickoffRow | null> {
    const leaseToken = randomUUID();
    const now = this.now();
    const nowIso = now.toISOString();
    const leasedUntil = new Date(now.getTime() + this.leaseMs).toISOString();
    return this.transactions.transaction(async (tx) => {
      const sql = runId
        ? `WITH next_run AS (
             SELECT id FROM planning_runs
              WHERE id = $4 AND mode = 'quick' AND status = 'approved'
                AND quick_kickoff_status = 'pending'
                AND (leased_until IS NULL OR leased_until <= $3)
              FOR UPDATE SKIP LOCKED
           )
           UPDATE planning_runs
              SET quick_kickoff_status = 'in_progress',
                  quick_kickoff_attempts = quick_kickoff_attempts + 1,
                  lease_token = $1, leased_until = $2, updated_at = $3
             FROM next_run
            WHERE planning_runs.id = next_run.id
           RETURNING planning_runs.id, planning_runs.project_id,
             planning_runs.requested_by, planning_runs.decision,
             planning_runs.lease_token`
        : `WITH next_run AS (
             SELECT id FROM planning_runs
              WHERE mode = 'quick' AND status = 'approved'
                AND quick_kickoff_status = 'pending'
                AND (leased_until IS NULL OR leased_until <= $3)
              ORDER BY updated_at ASC
              FOR UPDATE SKIP LOCKED LIMIT 1
           )
           UPDATE planning_runs
              SET quick_kickoff_status = 'in_progress',
                  quick_kickoff_attempts = quick_kickoff_attempts + 1,
                  lease_token = $1, leased_until = $2, updated_at = $3
             FROM next_run
            WHERE planning_runs.id = next_run.id
           RETURNING planning_runs.id, planning_runs.project_id,
             planning_runs.requested_by, planning_runs.decision,
             planning_runs.lease_token`;
      const params = runId
        ? [leaseToken, leasedUntil, nowIso, runId]
        : [leaseToken, leasedUntil, nowIso];
      const result = await tx.query<ClaimedQuickKickoffRow>(sql, params);
      return result.rows[0] ?? null;
    });
  }

  private async completeQuickKickoff(
    claim: ClaimedQuickKickoffRow,
    report: PlanningRunExecutionDto,
  ): Promise<void> {
    await this.transactions.transaction(async (tx) => {
      await tx.query(
        `UPDATE planning_runs
            SET quick_kickoff_status = 'completed',
                quick_kickoff_result = $2::jsonb,
                lease_token = NULL, leased_until = NULL, updated_at = $3
          WHERE id = $1 AND status = 'approved'
            AND quick_kickoff_status = 'in_progress' AND lease_token = $4`,
        [claim.id, JSON.stringify(report), this.now().toISOString(), claim.lease_token],
      );
    });
  }

  private async retryQuickKickoff(claim: ClaimedQuickKickoffRow, error: unknown): Promise<void> {
    const now = this.now();
    const retryAt = new Date(now.getTime() + this.kickoffRetryMs).toISOString();
    const report: PlanningRunExecutionDto = {
      started: false,
      detail: errorMessage(error),
    };
    await this.transactions.transaction(async (tx) => {
      await tx.query(
        `UPDATE planning_runs
            SET quick_kickoff_status = 'pending',
                quick_kickoff_result = $2::jsonb,
                lease_token = NULL, leased_until = $3, updated_at = $4
          WHERE id = $1 AND status = 'approved'
            AND quick_kickoff_status = 'in_progress' AND lease_token = $5`,
        [claim.id, JSON.stringify(report), retryAt, now.toISOString(), claim.lease_token],
      );
    });
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

  private async persistQuickApproval(
    claim: ClaimedPlanningRunRow,
    transcript: PlanningRunTranscriptEntryDto[],
    result: PlanningRunResultDto,
    totalCostUsd: number,
  ): Promise<boolean> {
    if (!claim.requested_by) {
      throw new Error("quick change is missing its authenticated requesting user");
    }
    const decidedAt = this.now().toISOString();
    const decision: PlanningRunDecisionDto = {
      decision: "approve",
      direction: null,
      staffing: null,
      decided_at: decidedAt,
    };
    return this.transactions.transaction(async (tx) => {
      const persisted = await tx.query<{ id: string }>(
        `UPDATE planning_runs
            SET status = 'approved', round = 0, transcript = $2::jsonb,
                result = $3::jsonb, total_cost_usd = total_cost_usd + $4,
                decision = $5::jsonb, quick_kickoff_status = 'pending',
                quick_kickoff_result = NULL, error = NULL, revision_seed = NULL,
                lease_token = NULL, leased_until = NULL, updated_at = $6
          WHERE id = $1 AND mode = 'quick' AND lease_token = $7
          RETURNING id`,
        [
          claim.id,
          JSON.stringify(transcript),
          JSON.stringify(result),
          totalCostUsd,
          JSON.stringify(decision),
          decidedAt,
          claim.lease_token,
        ],
      );
      return persisted.rows.length === 1;
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
