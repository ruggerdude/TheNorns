import { createHash, randomUUID } from "node:crypto";
import { AdapterError, type LlmAdapter, prepareStructuredOutputPrompt } from "@norns/adapters";
import {
  V2Debate,
  V2DebateActor,
  type V2DebateActorT,
  V2DebateContext,
  V2DebateFinding,
  type V2DebateFindingT,
  V2DebateJudgment,
  type V2DebateJudgmentT,
  V2DebateMessage,
  type V2DebateMessageT,
  V2DebateRound,
  V2DebateRun,
  type V2DebateStoppingObservationT,
  V2DebateTurn,
  evaluateV2DebateStopping,
} from "@norns/contracts";
import { newId } from "../ids.js";
import type { V2SqlExecutor, V2TransactionRunner } from "../persistence/v2/database.js";
import {
  type DebateFindingDraftT,
  type DebateJudgeResultT,
  type DebateParticipantProposalResultT,
  type DebateParticipantRevisionResultT,
  type DebateStructuredPrompt,
  type DebateSynthesisResultT,
  buildJudgePrompt,
  buildParticipantProposalPrompt,
  buildParticipantRevisionPrompt,
  buildSynthesisPrompt,
} from "./protocol.js";

type DebateTurnOutput =
  | DebateParticipantProposalResultT
  | DebateParticipantRevisionResultT
  | DebateJudgeResultT
  | DebateSynthesisResultT;

interface ClaimedJob {
  jobId: string;
  leaseToken: string;
  turnAttemptId: string;
  debate: z.infer<typeof V2Debate>;
  run: z.infer<typeof V2DebateRun>;
  round: z.infer<typeof V2DebateRound>;
  turn: z.infer<typeof V2DebateTurn>;
  actor: V2DebateActorT;
  contexts: Array<{
    context: z.infer<typeof V2DebateContext>;
    resolved_content: string;
  }>;
  transcript: V2DebateMessageT[];
  findings: V2DebateFindingT[];
  judgment: V2DebateJudgmentT | null;
}

// Type-only namespace import keeps the runtime surface on the contracts package.
import type { z } from "zod";

export type DebateAdapterFactory = (provider: string, model: string) => LlmAdapter;

export interface DebateWorkerOptions {
  now?: () => Date;
  leaseMs?: number;
  maxAttempts?: number;
  /** @deprecated Charges are frozen on debate_runs when a run starts. */
  maximumTurnCharge?: (actor: V2DebateActorT) => number;
}

export class DebateWorker {
  private readonly now: () => Date;
  private readonly leaseMs: number;
  private readonly maxAttempts: number;

  constructor(
    private readonly transactions: V2TransactionRunner,
    private readonly createAdapter: DebateAdapterFactory,
    options: DebateWorkerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.leaseMs = options.leaseMs ?? 60_000;
    this.maxAttempts = options.maxAttempts ?? 3;
  }

  /** Process at most one durable turn. Safe to call from a short recurring timer. */
  async tick(): Promise<"idle" | "completed" | "failed"> {
    let claim: ClaimedJob | null;
    try {
      claim = await this.claim();
    } catch {
      return "failed";
    }
    if (!claim) return "idle";

    let prompt: DebateStructuredPrompt<DebateTurnOutput>;
    let adapter: LlmAdapter;
    try {
      const basePrompt = this.promptFor(claim);
      prompt = {
        ...basePrompt,
        prompt: prepareStructuredOutputPrompt(
          basePrompt.prompt,
          basePrompt.schema,
          basePrompt.schemaName,
        ),
      };
      const conservativeInputTokens = Buffer.byteLength(
        `${prompt.system}\n\n${prompt.prompt}`,
        "utf8",
      );
      if (conservativeInputTokens > claim.actor.max_input_tokens) {
        throw new AdapterError(
          "invalid_request",
          `prepared debate prompt exceeds actor input cap (${conservativeInputTokens} > ${claim.actor.max_input_tokens})`,
        );
      }
      adapter = this.createAdapter(claim.actor.provider, claim.actor.model);
      await this.recordPromptDispatch(claim, prompt);
    } catch (error) {
      await this.fail(claim, error, false);
      return "failed";
    }

    const startedAt = this.now();
    const runDeadline =
      Date.parse(claim.run.started_at ?? claim.run.created_at) +
      claim.debate.stopping_policy.max_duration_seconds * 1_000;
    const remainingMs = Math.max(1, runDeadline - startedAt.getTime());
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), remainingMs);
    const heartbeat = setInterval(
      () => {
        void this.extendLease(claim).catch(() => undefined);
      },
      Math.max(1_000, Math.floor(this.leaseMs / 3)),
    );
    timeout.unref?.();
    heartbeat.unref?.();
    try {
      const result = await adapter.completeStructured(
        {
          system: prompt.system,
          prompt: prompt.prompt,
          maxTokens: prompt.maxTokens,
          projectId: claim.debate.project_id,
          debateId: claim.debate.id,
          debateRunId: claim.run.id,
          debateTurnId: claim.turn.id,
          debateTurnAttemptId: claim.turnAttemptId,
          signal: abortController.signal,
          structuredOutputPrepared: true,
        },
        prompt.schema,
        prompt.schemaName,
      );
      const executionSnapshot = claim.run.actor_execution_snapshots.find(
        (snapshot) => snapshot.actor_id === claim.actor.id,
      );
      if (!executionSnapshot) throw new Error("run actor execution snapshot is missing");
      const frozenCostUsd =
        (result.usage.input_tokens * executionSnapshot.pricing.input_per_mtok_usd +
          result.usage.output_tokens * executionSnapshot.pricing.output_per_mtok_usd) /
        1_000_000;
      await this.complete(claim, result.value, {
        inputTokens: result.usage.input_tokens,
        outputTokens: result.usage.output_tokens,
        costUsd: frozenCostUsd,
        latencyMs: Math.max(0, this.now().getTime() - startedAt.getTime()),
        providerExecutionId: result.provider_execution_id ?? null,
        finishReason: result.finish_reason ?? null,
      });
      return "completed";
    } catch (error) {
      await this.fail(claim, error, true);
      return "failed";
    } finally {
      clearTimeout(timeout);
      clearInterval(heartbeat);
    }
  }

  private async extendLease(claim: ClaimedJob): Promise<void> {
    await this.transactions.transaction(async (tx) => {
      const leasedUntil = new Date(this.now().getTime() + this.leaseMs).toISOString();
      await tx.query(
        `UPDATE debate_jobs SET leased_until = $3, updated_at = $4
         WHERE id = $1 AND state = 'leased' AND lease_token = $2`,
        [claim.jobId, claim.leaseToken, leasedUntil, this.now().toISOString()],
      );
      await tx.query(
        `UPDATE debate_turn_attempts SET leased_until = $3, updated_at = $4
         WHERE id = $1 AND state = 'leased' AND lease_token = $2`,
        [claim.turnAttemptId, claim.leaseToken, leasedUntil, this.now().toISOString()],
      );
    });
  }

  private promptFor(claim: ClaimedJob): DebateStructuredPrompt<DebateTurnOutput> {
    const base = {
      debate: claim.debate,
      run: claim.run,
      round: claim.round,
      turn: claim.turn,
      actor: claim.actor,
      contexts: claim.contexts,
      transcript: claim.transcript,
    };
    if (claim.actor.actor_kind === "judge") {
      return buildJudgePrompt(base) as DebateStructuredPrompt<DebateTurnOutput>;
    }
    if (claim.actor.actor_kind === "synthesizer") {
      return buildSynthesisPrompt({
        ...base,
        judgment: claim.judgment,
        open_findings: claim.findings.filter((finding) => finding.disposition === "open"),
      }) as DebateStructuredPrompt<DebateTurnOutput>;
    }
    const prior = [...claim.transcript]
      .reverse()
      .find((message) => message.actor_snapshot?.id === claim.actor.id);
    if (prior && claim.findings.length > 0) {
      return buildParticipantRevisionPrompt({
        ...base,
        previous_message_id: prior.id,
        findings: claim.findings.filter((finding) => finding.disposition === "open"),
      }) as DebateStructuredPrompt<DebateTurnOutput>;
    }
    return buildParticipantProposalPrompt(base) as DebateStructuredPrompt<DebateTurnOutput>;
  }

  private async recordPromptDispatch(
    claim: ClaimedJob,
    prompt: DebateStructuredPrompt<DebateTurnOutput>,
  ): Promise<void> {
    await this.transactions.transaction(async (tx) => {
      const job = await tx.query<{ lease_token: string | null; state: string }>(
        "SELECT lease_token, state FROM debate_jobs WHERE id = $1 FOR UPDATE",
        [claim.jobId],
      );
      if (job.rows[0]?.state !== "leased" || job.rows[0]?.lease_token !== claim.leaseToken) {
        throw new Error("debate job lease was lost before provider dispatch");
      }
      const promptHash = createHash("sha256")
        .update(`${prompt.system}\n\n${prompt.prompt}`)
        .digest("hex");
      await tx.query("UPDATE debate_turns SET prompt_hash = $2, updated_at = $3 WHERE id = $1", [
        claim.turn.id,
        promptHash,
        this.now().toISOString(),
      ]);
      await this.appendRunEvent(tx, claim, {
        eventType: "debate_turn_dispatched",
        payload: {
          round_number: claim.round.round_number,
          turn_number: claim.turn.turn_number,
          turn_attempt_id: claim.turnAttemptId,
          actor_snapshot: claim.actor,
          provider: claim.actor.provider,
          model: claim.actor.model,
          runtime: claim.actor.runtime,
          prompt_hash: promptHash,
          transport_prompt_bytes: Buffer.byteLength(`${prompt.system}\n\n${prompt.prompt}`, "utf8"),
          prompt_protocol: prompt.schemaName,
          context_manifest: prompt.contextManifest,
          pricing_snapshot: claim.run.actor_execution_snapshots.find(
            (snapshot) => snapshot.actor_id === claim.actor.id,
          )?.pricing,
        },
        occurredAt: this.now().toISOString(),
      });
    });
  }

  private async claim(): Promise<ClaimedJob | null> {
    const claimed = await this.transactions.transaction(async (tx) => {
      const now = this.now();
      const leaseToken = randomUUID();
      const leasedUntil = new Date(now.getTime() + this.leaseMs).toISOString();
      const expired = await tx.query<{
        id: string;
        project_id: string;
        debate_id: string;
        debate_run_id: string;
        turn_attempt_id: string;
      }>(
        `SELECT id, project_id, debate_id, debate_run_id, turn_attempt_id
         FROM debate_jobs
         WHERE state = 'leased' AND leased_until <= $1
         ORDER BY leased_until ASC
         LIMIT 50`,
        [now.toISOString()],
      );
      for (const abandoned of expired.rows) {
        const run = await tx.query<{
          event_version: number;
          state: string;
          lifecycle_version: number;
        }>(
          "SELECT event_version, state, lifecycle_version FROM debate_runs WHERE id = $1 FOR UPDATE",
          [abandoned.debate_run_id],
        );
        const stillExpired = await tx.query<{ id: string }>(
          `SELECT id FROM debate_jobs
           WHERE id = $1 AND state = 'leased' AND leased_until <= $2
           FOR UPDATE SKIP LOCKED`,
          [abandoned.id, now.toISOString()],
        );
        if (!stillExpired.rows[0]) continue;
        const cancellationRequested = run.rows[0]?.state === "cancelling";
        await tx.query(
          `UPDATE debate_jobs SET state = 'dead_letter', lease_token = NULL,
            leased_until = NULL, updated_at = $2 WHERE id = $1`,
          [abandoned.id, now.toISOString()],
        );
        await tx.query(
          `UPDATE debate_turn_attempts SET state = $2, failure_code = 'ambiguous_execution',
            failure_detail = 'worker lease expired before a durable provider result was committed',
            lease_token = NULL, leased_until = NULL, finished_at = $3, updated_at = $3
           WHERE id = $1`,
          [
            abandoned.turn_attempt_id,
            cancellationRequested ? "cancelled" : "expired",
            now.toISOString(),
          ],
        );
        await tx.query(
          `UPDATE debate_turns SET state = $2, completed_at = $3, updated_at = $3
           WHERE designated_attempt_id = $1`,
          [
            abandoned.turn_attempt_id,
            cancellationRequested ? "cancelled" : "expired",
            now.toISOString(),
          ],
        );
        if (cancellationRequested) {
          await tx.query(
            `UPDATE debate_reservations SET status = 'settled',
              resolution_outcome = 'cancelled_assumed_full_charge', settled_usd = amount_usd,
              version = version + 1, updated_at = $2
             WHERE turn_attempt_id = $1 AND status = 'active'`,
            [abandoned.turn_attempt_id, now.toISOString()],
          );
          await tx.query(
            `UPDATE debate_rounds SET state = 'cancelled', finished_at = $2, updated_at = $2
             WHERE debate_run_id = $1 AND state IN ('pending','active')`,
            [abandoned.debate_run_id, now.toISOString()],
          );
        } else {
          await tx.query(
            `UPDATE debate_reservations SET status = 'retained_ambiguous',
              retained_usd = amount_usd, version = version + 1, updated_at = $2
             WHERE turn_attempt_id = $1 AND status = 'active'`,
            [abandoned.turn_attempt_id, now.toISOString()],
          );
        }
        const eventSequence = Number(run.rows[0]?.event_version ?? 0) + 1;
        await tx.query(
          `INSERT INTO debate_events (
             id, project_id, debate_id, debate_run_id, sequence, event_type,
             lifecycle_version, actor_type, correlation_id, causation_id, payload, occurred_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,'system',$4,$1,$8::jsonb,$9)`,
          [
            newId("debate_event"),
            abandoned.project_id,
            abandoned.debate_id,
            abandoned.debate_run_id,
            eventSequence,
            cancellationRequested
              ? "debate_run_cancelled_after_expired_lease"
              : "debate_turn_execution_ambiguous",
            Number(run.rows[0]?.lifecycle_version ?? 0) + 1,
            JSON.stringify({
              turn_attempt_id: abandoned.turn_attempt_id,
              reason: "expired_worker_lease",
              requires_human_retry: !cancellationRequested,
              assumed_full_charge: cancellationRequested,
            }),
            now.toISOString(),
          ],
        );
        await tx.query(
          `UPDATE debate_runs SET state = $2, stop_reason = $3,
            lifecycle_version = lifecycle_version + 1, event_version = $4,
            aggregate_version = aggregate_version + 1,
            finished_at = CASE WHEN $2 = 'cancelled' THEN $5::timestamptz ELSE NULL END,
            updated_at = $5 WHERE id = $1`,
          [
            abandoned.debate_run_id,
            cancellationRequested ? "cancelled" : "paused",
            cancellationRequested ? "cancelled" : "ambiguous_execution",
            eventSequence,
            now.toISOString(),
          ],
        );
      }
      const result = await tx.query<{
        id: string;
        project_id: string;
        debate_id: string;
        debate_run_id: string;
        turn_attempt_id: string;
      }>(
        `SELECT j.id, j.project_id, j.debate_id, j.debate_run_id, j.turn_attempt_id
         FROM debate_jobs j
         JOIN debate_runs r ON r.id = j.debate_run_id
         WHERE j.state = 'queued'
           AND r.state IN ('queued','running','finalizing')
         ORDER BY j.created_at ASC
         LIMIT 1`,
      );
      const job = result.rows[0];
      if (!job) return null;
      const currentRun = await tx.query<{ state: string }>(
        `SELECT state FROM debate_runs WHERE id = $1
         AND state IN ('queued','running','finalizing') FOR UPDATE`,
        [job.debate_run_id],
      );
      if (!currentRun.rows[0]) return null;
      const queuedJob = await tx.query<{ id: string }>(
        "SELECT id FROM debate_jobs WHERE id = $1 AND state = 'queued' FOR UPDATE SKIP LOCKED",
        [job.id],
      );
      if (!queuedJob.rows[0]) return null;
      await tx.query(
        `UPDATE debate_jobs SET state = 'leased', lease_token = $2, leased_until = $3,
          updated_at = $4 WHERE id = $1`,
        [job.id, leaseToken, leasedUntil, now.toISOString()],
      );
      await tx.query(
        `UPDATE debate_turn_attempts SET state = 'running', lease_token = $2,
          leased_until = $3, started_at = COALESCE(started_at, $4), updated_at = $4
         WHERE id = $1`,
        [job.turn_attempt_id, leaseToken, leasedUntil, now.toISOString()],
      );
      await tx.query(
        `UPDATE debate_turns SET state = 'running', updated_at = $2
         WHERE designated_attempt_id = $1`,
        [job.turn_attempt_id, now.toISOString()],
      );
      await tx.query(
        `UPDATE debate_runs SET state = CASE WHEN state = 'finalizing' THEN 'finalizing' ELSE 'running' END,
          lifecycle_version = lifecycle_version + CASE WHEN state = 'queued' THEN 1 ELSE 0 END,
          aggregate_version = aggregate_version + 1, updated_at = $2 WHERE id = $1`,
        [job.debate_run_id, now.toISOString()],
      );
      if (currentRun.rows[0].state === "queued") {
        const run = await tx.query<{ event_version: number; lifecycle_version: number }>(
          "SELECT event_version, lifecycle_version FROM debate_runs WHERE id = $1 FOR UPDATE",
          [job.debate_run_id],
        );
        const sequence = Number(run.rows[0]?.event_version ?? 0) + 1;
        await tx.query(
          `INSERT INTO debate_events (
             id, project_id, debate_id, debate_run_id, sequence, event_type,
             lifecycle_version, actor_type, correlation_id, causation_id, payload, occurred_at
           ) VALUES ($1,$2,$3,$4,$5,'debate_run_running',$6,'system',$4,$1,$7::jsonb,$8)`,
          [
            newId("debate_event"),
            job.project_id,
            job.debate_id,
            job.debate_run_id,
            sequence,
            Number(run.rows[0]?.lifecycle_version ?? 0),
            JSON.stringify({ turn_attempt_id: job.turn_attempt_id }),
            now.toISOString(),
          ],
        );
        await tx.query(
          "UPDATE debate_runs SET event_version = $2, aggregate_version = aggregate_version + 1 WHERE id = $1",
          [job.debate_run_id, sequence],
        );
      }
      return { ...job, leaseToken };
    });
    if (!claimed) return null;
    try {
      return await this.loadClaim(claimed);
    } catch (error) {
      await this.failClaimPreparation(claimed, error);
      throw error;
    }
  }

  private async failClaimPreparation(
    claimed: {
      id: string;
      project_id: string;
      debate_id: string;
      debate_run_id: string;
      turn_attempt_id: string;
      leaseToken: string;
    },
    error: unknown,
  ): Promise<void> {
    await this.transactions.transaction(async (tx) => {
      const run = await tx.query<{ event_version: number; lifecycle_version: number }>(
        "SELECT event_version, lifecycle_version FROM debate_runs WHERE id = $1 FOR UPDATE",
        [claimed.debate_run_id],
      );
      const job = await tx.query<{ lease_token: string | null }>(
        "SELECT lease_token FROM debate_jobs WHERE id = $1 FOR UPDATE",
        [claimed.id],
      );
      if (job.rows[0]?.lease_token !== claimed.leaseToken) return;
      const now = this.now().toISOString();
      const detail = error instanceof Error ? error.message : String(error);
      await tx.query(
        `UPDATE debate_jobs SET state = 'dead_letter', lease_token = NULL, leased_until = NULL,
          updated_at = $2 WHERE id = $1`,
        [claimed.id, now],
      );
      await tx.query(
        `UPDATE debate_turn_attempts SET state = 'failed', failure_code = 'pre_dispatch_failure',
          failure_detail = $2, lease_token = NULL, leased_until = NULL,
          finished_at = $3, updated_at = $3 WHERE id = $1`,
        [claimed.turn_attempt_id, detail.slice(0, 10_000), now],
      );
      await tx.query(
        "UPDATE debate_turns SET state = 'failed', completed_at = $2, updated_at = $2 WHERE designated_attempt_id = $1",
        [claimed.turn_attempt_id, now],
      );
      await tx.query(
        `UPDATE debate_reservations SET status = 'released', resolution_outcome = 'pre_dispatch_failure',
          released_usd = amount_usd, version = version + 1, updated_at = $2
         WHERE turn_attempt_id = $1 AND status = 'active'`,
        [claimed.turn_attempt_id, now],
      );
      const sequence = Number(run.rows[0]?.event_version ?? 0) + 1;
      await tx.query(
        `INSERT INTO debate_events (
           id, project_id, debate_id, debate_run_id, sequence, event_type,
           lifecycle_version, actor_type, correlation_id, causation_id, payload, occurred_at
         ) VALUES ($1,$2,$3,$4,$5,'debate_turn_pre_dispatch_failed',$6,'system',$4,$1,$7::jsonb,$8)`,
        [
          newId("debate_event"),
          claimed.project_id,
          claimed.debate_id,
          claimed.debate_run_id,
          sequence,
          Number(run.rows[0]?.lifecycle_version ?? 0) + 1,
          JSON.stringify({
            turn_attempt_id: claimed.turn_attempt_id,
            detail: detail.slice(0, 10_000),
          }),
          now,
        ],
      );
      await tx.query(
        `UPDATE debate_runs SET state = 'paused', stop_reason = 'pre_dispatch_failure',
          lifecycle_version = lifecycle_version + 1, event_version = $2,
          aggregate_version = aggregate_version + 1, updated_at = $3 WHERE id = $1`,
        [claimed.debate_run_id, sequence, now],
      );
    });
  }

  private async loadClaim(claimed: {
    id: string;
    project_id: string;
    debate_id: string;
    debate_run_id: string;
    turn_attempt_id: string;
    leaseToken: string;
  }): Promise<ClaimedJob> {
    return this.transactions.transaction(async (tx) => {
      const [debateResult, runResult, turnResult, actorResult] = await Promise.all([
        tx.query<Record<string, unknown>>("SELECT * FROM debates WHERE id = $1", [
          claimed.debate_id,
        ]),
        tx.query<Record<string, unknown>>("SELECT * FROM debate_runs WHERE id = $1", [
          claimed.debate_run_id,
        ]),
        tx.query<Record<string, unknown>>(
          "SELECT * FROM debate_turns WHERE designated_attempt_id = $1",
          [claimed.turn_attempt_id],
        ),
        tx.query<Record<string, unknown>>(
          `SELECT a.* FROM debate_actors a JOIN debate_turns t ON t.actor_id = a.id
           WHERE t.designated_attempt_id = $1`,
          [claimed.turn_attempt_id],
        ),
      ]);
      const rawTurn = turnResult.rows[0];
      if (!rawTurn) throw new Error("claimed debate turn disappeared");
      const roundResult = await tx.query<Record<string, unknown>>(
        "SELECT * FROM debate_rounds WHERE id = $1",
        [rawTurn.round_id],
      );
      const contextsResult = await tx.query<Record<string, unknown>>(
        "SELECT * FROM debate_contexts WHERE debate_id = $1 ORDER BY ordinal",
        [claimed.debate_id],
      );
      const messagesResult = await tx.query<Record<string, unknown>>(
        `SELECT m.* FROM debate_messages m
         WHERE m.debate_run_id = $1
           AND (
             m.message_kind <> 'human'
             OR (
               (m.intervention_target_actor_id IS NULL OR m.intervention_target_actor_id = $2)
               AND (
                 (
                   m.intervention_apply_at = 'next_turn'
                   AND $3 = (
                     SELECT MIN(next_turn.turn_number)
                     FROM debate_turns next_turn
                     WHERE next_turn.debate_run_id = $1
                       AND next_turn.turn_number > m.intervention_applies_after_turn
                       AND next_turn.actor_id = COALESCE(m.intervention_target_actor_id, $2)
                   )
                 )
                 OR (m.intervention_apply_at = 'next_round'
                   AND $4 = m.intervention_applies_after_round + 1)
               )
             )
           )
         ORDER BY m.sequence`,
        [
          claimed.debate_run_id,
          actorResult.rows[0]?.id,
          rawTurn.turn_number,
          roundResult.rows[0]?.round_number,
        ],
      );
      const findingsResult = await tx.query<Record<string, unknown>>(
        `SELECT f.finding_key AS key, f.*,
           COALESCE((
             SELECT r.payload->>'disposition' FROM debate_revisions r
             WHERE r.debate_run_id = f.debate_run_id
               AND r.revision_kind = 'finding_disposition'
               AND r.payload->>'finding_id' = f.id
             ORDER BY r.revision_number DESC LIMIT 1
           ), f.disposition) AS disposition
         FROM debate_findings f WHERE f.debate_run_id = $1 ORDER BY f.created_at`,
        [claimed.debate_run_id],
      );
      const judgmentResult = await tx.query<Record<string, unknown>>(
        "SELECT * FROM debate_judgments WHERE debate_run_id = $1 ORDER BY created_at DESC LIMIT 1",
        [claimed.debate_run_id],
      );
      const rawDebate = normalizeDates(debateResult.rows[0]);
      const debate = V2Debate.parse({
        ...without(rawDebate, ["created_by_actor_type", "created_by_actor_id"]),
        created_by: {
          actor_type: rawDebate.created_by_actor_type,
          actor_id: rawDebate.created_by_actor_id,
        },
      });
      const run = V2DebateRun.parse(normalizeDates(runResult.rows[0]));
      const round = V2DebateRound.parse(
        without(normalizeDates(roundResult.rows[0]), ["project_id", "debate_id"]),
      );
      const turn = V2DebateTurn.parse(
        without(normalizeDates(rawTurn), ["project_id", "debate_id"]),
      );
      const actorDefinition = parseActor(actorResult.rows[0]);
      const actorSnapshot = run.actor_execution_snapshots.find(
        (snapshot) => snapshot.actor_id === actorDefinition.id,
      );
      if (!actorSnapshot) throw new Error("run actor execution snapshot is missing");
      const actor = V2DebateActor.parse({
        ...actorDefinition,
        provider: actorSnapshot.provider,
        model: actorSnapshot.model,
        runtime: actorSnapshot.runtime,
        max_input_tokens: actorSnapshot.max_input_tokens,
        max_output_tokens: actorSnapshot.max_output_tokens,
        budget_limit_usd: actorSnapshot.budget_limit_usd,
        max_turns: actorSnapshot.max_turns,
      });
      const contexts = contextsResult.rows.map((row) => {
        if (row.inline_content === null) {
          throw new Error("artifact-backed debate contexts require an artifact resolver");
        }
        const normalized = normalizeDates(row);
        return {
          context: V2DebateContext.parse({
            ...without(normalized, ["project_id", "artifact_id"]),
            artifact: null,
          }),
          resolved_content: String(row.inline_content),
        };
      });
      const transcript = messagesResult.rows.map((row) =>
        V2DebateMessage.parse(without(normalizeDates(row), ["project_id", "debate_id"])),
      );
      const findingRows = findingsResult.rows.map((row) => {
        const normalized = normalizeDates(row);
        return V2DebateFinding.parse({
          ...without(normalized, ["project_id", "debate_id", "finding_key"]),
          key: normalized.finding_key,
        });
      });
      const findingsByKey = new Map<string, V2DebateFindingT>();
      for (const finding of findingRows) findingsByKey.set(finding.key, finding);
      const findings = [...findingsByKey.values()];
      const judgment = judgmentResult.rows[0]
        ? V2DebateJudgment.parse(
            without(normalizeDates(judgmentResult.rows[0]), ["project_id", "debate_id"]),
          )
        : null;
      return {
        jobId: claimed.id,
        leaseToken: claimed.leaseToken,
        turnAttemptId: claimed.turn_attempt_id,
        debate,
        run,
        round,
        turn,
        actor,
        contexts,
        transcript,
        findings,
        judgment,
      };
    });
  }

  private async complete(
    claim: ClaimedJob,
    output: DebateTurnOutput,
    usage: {
      inputTokens: number;
      outputTokens: number;
      costUsd: number;
      latencyMs: number;
      providerExecutionId: string | null;
      finishReason: string | null;
    },
  ): Promise<void> {
    await this.transactions.transaction(async (tx) => {
      const runLock = await tx.query<{ state: string; stop_after: "none" | "turn" | "round" }>(
        "SELECT state, stop_after FROM debate_runs WHERE id = $1 FOR UPDATE",
        [claim.run.id],
      );
      const requestedState = runLock.rows[0]?.state;
      const requestedStopAfter = runLock.rows[0]?.stop_after ?? "none";
      const locked = await tx.query<{
        lease_token: string | null;
        state: string;
        delivery_attempt: number;
      }>("SELECT lease_token, state, delivery_attempt FROM debate_jobs WHERE id = $1 FOR UPDATE", [
        claim.jobId,
      ]);
      const job = locked.rows[0];
      if (!job || job.state !== "leased" || job.lease_token !== claim.leaseToken) {
        throw new Error("debate job lease is no longer designated");
      }
      const now = this.now().toISOString();
      const sequenceResult = await tx.query<{ sequence: number }>(
        "SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM debate_messages WHERE debate_run_id = $1",
        [claim.run.id],
      );
      const sequence = Number(sequenceResult.rows[0]?.sequence ?? 1);
      const messageId = newId("debate_message");
      const content = outputContent(output);
      const structuredOutput = JSON.stringify(output);
      const structuredOutputHash = createHash("sha256").update(structuredOutput).digest("hex");
      const priorActorMessage = await tx.query<{ id: string }>(
        `SELECT id FROM debate_messages
         WHERE debate_run_id = $1 AND actor_snapshot->>'id' = $2
         ORDER BY sequence DESC LIMIT 1`,
        [claim.run.id, claim.actor.id],
      );
      const supersedesMessageId = priorActorMessage.rows[0]?.id ?? null;
      await tx.query(
        `INSERT INTO debate_messages (
           id, project_id, debate_id, debate_run_id, sequence, message_kind,
           actor_snapshot, turn_id, turn_attempt_id, supersedes_message_id,
           structured_output, structured_output_hash, content, content_hash, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11::jsonb,$12,$13,$14,$15)`,
        [
          messageId,
          claim.debate.project_id,
          claim.debate.id,
          claim.run.id,
          sequence,
          claim.actor.actor_kind,
          JSON.stringify(claim.actor),
          claim.turn.id,
          claim.turnAttemptId,
          supersedesMessageId,
          structuredOutput,
          structuredOutputHash,
          content,
          createHash("sha256").update(content).digest("hex"),
          now,
        ],
      );
      if (supersedesMessageId) {
        const priorRevision = await tx.query<{ id: string }>(
          `SELECT id FROM debate_revisions
           WHERE debate_run_id = $1 AND revision_kind = 'correction'
             AND payload->>'message_id' = $2
           ORDER BY revision_number DESC LIMIT 1`,
          [claim.run.id, supersedesMessageId],
        );
        await this.insertRevision(tx, claim, {
          kind: "correction",
          rationale: "Participant supplied a validated revision of its prior message.",
          payload: { message_id: messageId, supersedes_message_id: supersedesMessageId },
          supersedesRevisionId: priorRevision.rows[0]?.id ?? null,
          now,
        });
      }
      const findings = "findings" in output ? output.findings : [];
      await this.insertFindings(tx, claim, messageId, findings, now);
      const findingDispositions =
        "finding_dispositions" in output ? output.finding_dispositions : [];
      for (const disposition of findingDispositions) {
        const matches = await tx.query<{ id: string }>(
          `SELECT f.id FROM debate_findings f
           WHERE f.debate_run_id = $1 AND f.finding_key = $2
             AND NOT EXISTS (
               SELECT 1 FROM debate_revisions r
               WHERE r.debate_run_id = f.debate_run_id
                 AND r.revision_kind = 'finding_disposition'
                 AND r.payload->>'finding_id' = f.id
                 AND r.payload->>'disposition' IN ('accepted','rejected','deferred','resolved')
             )
           ORDER BY f.created_at`,
          [claim.run.id, disposition.key],
        );
        for (const finding of matches.rows) {
          await this.insertRevision(tx, claim, {
            kind: "finding_disposition",
            rationale: disposition.rationale,
            payload: {
              finding_id: finding.id,
              finding_key: disposition.key,
              disposition: disposition.disposition,
              message_id: messageId,
            },
            now,
          });
        }
      }
      if (claim.actor.actor_kind === "judge") {
        const judge = output as DebateJudgeResultT;
        const evidence: Array<{
          artifact_id: string;
          content_hash: string;
          media_type: string;
          label: string;
        }> = [];
        for (const id of judge.evidence_message_ids) {
          const cited = await tx.query<{ content_hash: string }>(
            "SELECT content_hash FROM debate_messages WHERE debate_run_id = $1 AND id = $2",
            [claim.run.id, id],
          );
          const contentHash = cited.rows[0]?.content_hash;
          if (!contentHash) throw new Error(`judge cited missing debate message ${id}`);
          evidence.push({
            artifact_id: id,
            content_hash: contentHash,
            media_type: "application/vnd.norns.debate-message",
            label: "Debate message",
          });
        }
        const revisionId = await this.insertRevision(tx, claim, {
          kind: "judgment",
          rationale: judge.rationale,
          payload: { message_id: messageId, conclusion: judge.conclusion },
          now,
        });
        await tx.query(
          `INSERT INTO debate_judgments (
             id, project_id, debate_id, debate_run_id, revision_id, judge_actor_id, conclusion,
             rationale, evidence, content_hash, created_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)`,
          [
            newId("debate_judgment"),
            claim.debate.project_id,
            claim.debate.id,
            claim.run.id,
            revisionId,
            claim.actor.id,
            judge.conclusion,
            judge.rationale,
            JSON.stringify(evidence),
            createHash("sha256").update(`${judge.conclusion}\n${judge.rationale}`).digest("hex"),
            now,
          ],
        );
      }
      if (claim.actor.actor_kind === "synthesizer") {
        const synthesis = output as DebateSynthesisResultT;
        const revisionId = await this.insertRevision(tx, claim, {
          kind: "final_output",
          rationale: synthesis.rationale,
          payload: { message_id: messageId, summary: synthesis.summary },
          now,
        });
        await tx.query(
          `INSERT INTO debate_final_outputs (
             id, project_id, debate_id, debate_run_id, revision_id, content, content_hash, created_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            newId("debate_output"),
            claim.debate.project_id,
            claim.debate.id,
            claim.run.id,
            revisionId,
            synthesis.content,
            createHash("sha256").update(synthesis.content).digest("hex"),
            now,
          ],
        );
      }
      await tx.query(
        `INSERT INTO debate_usage_events (
           id, project_id, debate_id, debate_run_id, turn_attempt_id, provider,
           model, runtime, pricing_snapshot, input_tokens, output_tokens, cost_usd, latency_ms, occurred_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14)`,
        [
          newId("debate_usage"),
          claim.debate.project_id,
          claim.debate.id,
          claim.run.id,
          claim.turnAttemptId,
          claim.actor.provider,
          claim.actor.model,
          claim.actor.runtime,
          JSON.stringify(
            claim.run.actor_execution_snapshots.find(
              (snapshot) => snapshot.actor_id === claim.actor.id,
            )?.pricing,
          ),
          usage.inputTokens,
          usage.outputTokens,
          usage.costUsd,
          usage.latencyMs,
          now,
        ],
      );
      const reservation = await tx.query<{ amount_usd: string | number }>(
        "SELECT amount_usd FROM debate_reservations WHERE turn_attempt_id = $1 FOR UPDATE",
        [claim.turnAttemptId],
      );
      const reserved = Number(reservation.rows[0]?.amount_usd ?? 0);
      if (usage.costUsd > reserved + 0.000001) {
        throw new Error("provider usage exceeded the conservative debate reservation");
      }
      await tx.query(
        `UPDATE debate_reservations SET status = 'settled', resolution_outcome = 'completed',
          settled_usd = $2, released_usd = amount_usd - $2, retained_usd = 0,
          version = version + 1, updated_at = $3 WHERE turn_attempt_id = $1`,
        [claim.turnAttemptId, usage.costUsd, now],
      );
      await tx.query(
        `UPDATE debate_turn_attempts SET state = 'completed', provider_execution_id = $2,
          finished_at = $3, lease_token = NULL, leased_until = NULL, updated_at = $3 WHERE id = $1`,
        [claim.turnAttemptId, usage.providerExecutionId, now],
      );
      await tx.query(
        `UPDATE debate_turns SET state = 'completed', output_message_id = $2,
          completed_at = $3, updated_at = $3 WHERE id = $1`,
        [claim.turn.id, messageId, now],
      );
      await tx.query(
        "UPDATE debate_jobs SET state = 'succeeded', lease_token = NULL, leased_until = NULL, updated_at = $2 WHERE id = $1",
        [claim.jobId, now],
      );
      await this.appendRunEvent(tx, claim, {
        eventType: `${claim.actor.actor_kind}_turn_completed`,
        payload: {
          round_number: claim.round.round_number,
          turn_number: claim.turn.turn_number,
          turn_attempt_id: claim.turnAttemptId,
          actor_snapshot: claim.actor,
          message_id: messageId,
          content,
          findings,
          finding_dispositions: findingDispositions,
          structured_output: output,
          structured_output_hash: structuredOutputHash,
          usage: {
            input_tokens: usage.inputTokens,
            output_tokens: usage.outputTokens,
            cost_usd: usage.costUsd,
            latency_ms: usage.latencyMs,
          },
          finish_reason: usage.finishReason,
        },
        occurredAt: now,
      });
      if (requestedState === "cancelling") {
        await tx.query(
          `UPDATE debate_jobs SET state = 'cancelled', updated_at = $2
           WHERE debate_run_id = $1 AND state = 'queued'`,
          [claim.run.id, now],
        );
        await tx.query(
          `UPDATE debate_reservations SET status = 'released', resolution_outcome = 'cancelled',
            released_usd = amount_usd, version = version + 1, updated_at = $2
           WHERE debate_run_id = $1 AND status = 'active'`,
          [claim.run.id, now],
        );
        await tx.query(
          `UPDATE debate_rounds SET state = 'cancelled', finished_at = $2, updated_at = $2
           WHERE debate_run_id = $1 AND state IN ('pending','active')`,
          [claim.run.id, now],
        );
        await tx.query(
          `UPDATE debate_runs SET state = 'cancelled', lifecycle_version = lifecycle_version + 1,
            aggregate_version = aggregate_version + 1, finished_at = $2, updated_at = $2
           WHERE id = $1`,
          [claim.run.id, now],
        );
        await this.appendRunEvent(tx, claim, {
          eventType: "debate_run_cancelled",
          payload: { stop_reason: "operator_cancelled" },
          occurredAt: now,
          lifecycleEvent: true,
        });
        return;
      }
      await this.advance(tx, claim, output, messageId, now, requestedStopAfter);
      if (requestedState === "pausing") {
        const pausedResult = await tx.query<{ state: string }>(
          `UPDATE debate_runs SET state = 'paused', lifecycle_version = lifecycle_version + 1,
            aggregate_version = aggregate_version + 1, updated_at = $2
           WHERE id = $1 AND state NOT IN ('completed','cancelled','failed') RETURNING state`,
          [claim.run.id, now],
        );
        if (pausedResult.rows[0]) {
          await this.appendRunEvent(tx, claim, {
            eventType: "debate_run_paused",
            payload: { stop_reason: "operator_pause" },
            occurredAt: now,
            lifecycleEvent: true,
          });
        }
      }
    });
  }

  private async advance(
    tx: V2SqlExecutor,
    claim: ClaimedJob,
    output: DebateTurnOutput,
    messageId: string,
    now: string,
    stopAfter: "none" | "turn" | "round",
  ): Promise<void> {
    const actorsResult = await tx.query<Record<string, unknown>>(
      "SELECT * FROM debate_actors WHERE debate_id = $1 ORDER BY position",
      [claim.debate.id],
    );
    const actors = actorsResult.rows.map(parseActor);
    const participants = actors.filter((actor) => actor.actor_kind === "participant");
    const judge = actors.find((actor) => actor.actor_kind === "judge") ?? null;
    const synthesizer = actors.find((actor) => actor.actor_kind === "synthesizer") ?? null;
    const roundActors = judge ? [...participants, judge] : participants;
    const currentIndex = roundActors.findIndex((actor) => actor.id === claim.actor.id);

    if (claim.actor.actor_kind === "synthesizer") {
      await this.completeRun(tx, claim, "synthesis_completed", now);
      return;
    }
    if (currentIndex >= 0 && currentIndex + 1 < roundActors.length && stopAfter !== "turn") {
      await this.scheduleTurn(
        tx,
        claim,
        roundActors[currentIndex + 1] as V2DebateActorT,
        claim.round.round_number,
        now,
      );
      return;
    }

    const roundOutputRows = await tx.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM debate_events
       WHERE debate_run_id = $1
         AND event_type IN ('participant_turn_completed','judge_turn_completed')
         AND (payload->>'round_number')::integer = $2
       ORDER BY sequence`,
      [claim.run.id, claim.round.round_number],
    );
    const roundOutputs = roundOutputRows.rows
      .map((row) => row.payload.structured_output)
      .filter((value): value is DebateTurnOutput => Boolean(value && typeof value === "object"));
    const signalRows = roundOutputs.map(semanticSignals);
    const judgeOutput = roundOutputRows.rows.find(
      (row) =>
        typeof row.payload.actor_snapshot === "object" &&
        row.payload.actor_snapshot !== null &&
        (row.payload.actor_snapshot as Record<string, unknown>).actor_kind === "judge",
    );
    const judgeSignals = judgeOutput?.payload.structured_output
      ? semanticSignals(judgeOutput.payload.structured_output as DebateTurnOutput)
      : null;
    const disagreements = signalRows
      .map((signal) => signal.disagreementFingerprint)
      .filter((value): value is string => value !== null)
      .sort();
    const signals = {
      consensus: judge
        ? (judgeSignals?.consensus ?? false)
        : signalRows.length >= participants.length &&
          signalRows.every((signal) => signal.consensus),
      materialChange: signalRows.some((signal) => signal.materialChange),
      disagreementFingerprint:
        disagreements.length > 0
          ? createHash("sha256").update(disagreements.join(":"), "utf8").digest("hex")
          : null,
    };
    await tx.query(
      `UPDATE debate_rounds SET state = 'completed', consensus_reported = $2,
        material_change = $3, unresolved_disagreement_fingerprint = $4,
        finished_at = $5, updated_at = $5 WHERE id = $1`,
      [
        claim.round.id,
        signals.consensus,
        signals.materialChange,
        signals.disagreementFingerprint,
        now,
      ],
    );
    const accounting = await tx.query<{
      input_tokens: string | number;
      output_tokens: string | number;
      cost_usd: string | number;
    }>(
      `SELECT COALESCE(SUM(input_tokens),0) AS input_tokens,
        COALESCE(SUM(output_tokens),0) AS output_tokens,
        COALESCE(SUM(cost_usd),0) AS cost_usd
       FROM debate_usage_events WHERE debate_run_id = $1`,
      [claim.run.id],
    );
    const recentRounds = await tx.query<{
      material_change: boolean | null;
      unresolved_disagreement_fingerprint: string | null;
    }>(
      `SELECT material_change, unresolved_disagreement_fingerprint
       FROM debate_rounds WHERE debate_run_id = $1 AND state = 'completed'
       ORDER BY round_number DESC`,
      [claim.run.id],
    );
    let consecutiveNoMaterialChange = 0;
    for (const round of recentRounds.rows) {
      if (round.material_change !== false) break;
      consecutiveNoMaterialChange += 1;
    }
    let consecutiveRepeatedDisagreement = 0;
    const latestFingerprint = recentRounds.rows[0]?.unresolved_disagreement_fingerprint ?? null;
    if (latestFingerprint !== null) {
      for (const round of recentRounds.rows) {
        if (round.unresolved_disagreement_fingerprint !== latestFingerprint) break;
        consecutiveRepeatedDisagreement += 1;
      }
    }
    const totals = accounting.rows[0];
    const observation: V2DebateStoppingObservationT = {
      completed_rounds: claim.round.round_number,
      elapsed_seconds: Math.max(
        0,
        (Date.parse(now) - Date.parse(claim.run.started_at ?? claim.run.created_at)) / 1000,
      ),
      input_tokens: Number(totals?.input_tokens ?? 0),
      output_tokens: Number(totals?.output_tokens ?? 0),
      cost_usd: Number(totals?.cost_usd ?? 0),
      consensus_reported: signals.consensus,
      consecutive_no_material_change_rounds: consecutiveNoMaterialChange,
      consecutive_repeated_disagreement_rounds: consecutiveRepeatedDisagreement,
      consecutive_provider_failures: 0,
      requested_stop: stopAfter !== "none",
    };
    const stopReason = evaluateV2DebateStopping(claim.debate.stopping_policy, observation);
    if (stopReason) {
      await tx.query(
        `UPDATE debate_runs SET state = 'finalizing', stop_reason = $2,
          lifecycle_version = lifecycle_version + 1, aggregate_version = aggregate_version + 1,
          updated_at = $3 WHERE id = $1`,
        [claim.run.id, stopReason, now],
      );
      await this.appendRunEvent(tx, claim, {
        eventType: "debate_run_finalizing",
        payload: { stop_reason: stopReason },
        occurredAt: now,
        lifecycleEvent: true,
      });
      if (synthesizer) {
        await this.scheduleTurn(tx, claim, synthesizer, claim.round.round_number, now, true);
      } else {
        await tx.query(
          `INSERT INTO debate_final_outputs (
             id, project_id, debate_id, debate_run_id, content, content_hash, created_at
           ) SELECT $1,$2,$3,$4,content,content_hash,$5 FROM debate_messages WHERE id = $6`,
          [
            newId("debate_output"),
            claim.debate.project_id,
            claim.debate.id,
            claim.run.id,
            now,
            messageId,
          ],
        );
        await this.completeRun(tx, claim, stopReason, now);
      }
      return;
    }
    await this.scheduleTurn(
      tx,
      claim,
      participants[0] as V2DebateActorT,
      claim.round.round_number + 1,
      now,
      true,
    );
  }

  private async scheduleTurn(
    tx: V2SqlExecutor,
    claim: ClaimedJob,
    actor: V2DebateActorT,
    roundNumber: number,
    now: string,
    createRound = false,
  ): Promise<void> {
    const executionSnapshot = claim.run.actor_execution_snapshots.find(
      (snapshot) => snapshot.actor_id === actor.id,
    );
    if (!executionSnapshot) throw new Error(`run snapshot missing for actor ${actor.id}`);
    const amount = executionSnapshot.maximum_turn_charge_usd;
    if (amount > actor.budget_limit_usd) {
      throw new Error(`actor ${actor.id} budget cannot cover its maximum turn charge`);
    }
    const consumed = await tx.query<{
      committed_cost: string | number;
      input_tokens: string | number;
      output_tokens: string | number;
      actor_committed_cost: string | number;
      actor_turns: string | number;
    }>(
      `SELECT
         COALESCE((SELECT SUM(settled_usd + retained_usd +
           CASE WHEN status = 'active' THEN amount_usd ELSE 0 END)
           FROM debate_reservations WHERE debate_run_id = $1), 0) AS committed_cost,
         COALESCE((SELECT SUM(input_tokens) FROM debate_usage_events WHERE debate_run_id = $1), 0) AS input_tokens,
         COALESCE((SELECT SUM(output_tokens) FROM debate_usage_events WHERE debate_run_id = $1), 0) AS output_tokens,
         COALESCE((SELECT SUM(r.settled_usd + r.retained_usd +
           CASE WHEN r.status = 'active' THEN r.amount_usd ELSE 0 END)
           FROM debate_reservations r
           JOIN debate_turn_attempts ta ON ta.id = r.turn_attempt_id
           JOIN debate_turns t ON t.id = ta.turn_id
           WHERE r.debate_run_id = $1 AND t.actor_id = $2), 0) AS actor_committed_cost,
         COALESCE((SELECT COUNT(*) FROM debate_turns
           WHERE debate_run_id = $1 AND actor_id = $2), 0) AS actor_turns`,
      [claim.run.id, actor.id],
    );
    const totals = consumed.rows[0];
    const runBudgetExceeded =
      Number(totals?.committed_cost ?? 0) + amount >
        claim.debate.stopping_policy.max_total_cost_usd ||
      Number(totals?.input_tokens ?? 0) + actor.max_input_tokens >
        claim.debate.stopping_policy.max_total_input_tokens ||
      Number(totals?.output_tokens ?? 0) + actor.max_output_tokens >
        claim.debate.stopping_policy.max_total_output_tokens;
    const actorLimitExceeded =
      Number(totals?.actor_committed_cost ?? 0) + amount > actor.budget_limit_usd ||
      Number(totals?.actor_turns ?? 0) >= actor.max_turns;
    if (runBudgetExceeded || actorLimitExceeded) {
      const latest = await tx.query<{ id: string }>(
        "SELECT id FROM debate_messages WHERE debate_run_id = $1 ORDER BY sequence DESC LIMIT 1",
        [claim.run.id],
      );
      const latestMessageId = latest.rows[0]?.id;
      if (!latestMessageId) throw new Error("cannot finalize a budget-limited run without output");
      await tx.query(
        `INSERT INTO debate_final_outputs (
           id, project_id, debate_id, debate_run_id, content, content_hash, created_at
         ) SELECT $1,$2,$3,$4,content,content_hash,$5
           FROM debate_messages WHERE id = $6
         ON CONFLICT DO NOTHING`,
        [
          newId("debate_output"),
          claim.debate.project_id,
          claim.debate.id,
          claim.run.id,
          now,
          latestMessageId,
        ],
      );
      const stopReason = actorLimitExceeded ? "actor_limit_reached" : "budget_reached";
      await tx.query(
        `UPDATE debate_runs SET state = 'finalizing', stop_reason = $2,
          lifecycle_version = lifecycle_version + 1, aggregate_version = aggregate_version + 1,
          updated_at = $3 WHERE id = $1`,
        [claim.run.id, stopReason, now],
      );
      await this.appendRunEvent(tx, claim, {
        eventType: "debate_run_finalizing",
        payload: { stop_reason: stopReason },
        occurredAt: now,
        lifecycleEvent: true,
      });
      await this.completeRun(tx, claim, stopReason, now);
      return;
    }
    let roundId = claim.round.id;
    if (createRound && roundNumber !== claim.round.round_number) {
      roundId = newId("debate_round");
      await tx.query(
        `INSERT INTO debate_rounds (
           id, project_id, debate_id, debate_run_id, round_number, state,
           started_at, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,'active',$6,$6,$6)`,
        [roundId, claim.debate.project_id, claim.debate.id, claim.run.id, roundNumber, now],
      );
    }
    const countResult = await tx.query<{ turn_number: number }>(
      "SELECT COALESCE(MAX(turn_number),0) + 1 AS turn_number FROM debate_turns WHERE debate_run_id = $1",
      [claim.run.id],
    );
    const turnNumber = Number(countResult.rows[0]?.turn_number ?? 1);
    const turnId = newId("debate_turn");
    const attemptId = newId("debate_attempt");
    await tx.query(
      `INSERT INTO debate_turns (
         id, project_id, debate_id, debate_run_id, round_id, turn_number,
         actor_id, state, prompt_hash, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,'queued',$8,$9,$9)`,
      [
        turnId,
        claim.debate.project_id,
        claim.debate.id,
        claim.run.id,
        roundId,
        turnNumber,
        actor.id,
        createHash("sha256").update(`${claim.run.id}:${roundNumber}:${actor.id}`).digest("hex"),
        now,
      ],
    );
    await tx.query(
      `INSERT INTO debate_turn_attempts (
         id, project_id, debate_id, debate_run_id, turn_id, attempt_number,
         state, is_designated, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,1,'queued',true,$6,$6)`,
      [attemptId, claim.debate.project_id, claim.debate.id, claim.run.id, turnId, now],
    );
    await tx.query("UPDATE debate_turns SET designated_attempt_id = $2 WHERE id = $1", [
      turnId,
      attemptId,
    ]);
    await tx.query(
      `INSERT INTO debate_reservations (
         id, project_id, debate_id, debate_run_id, turn_attempt_id, amount_usd,
         status, version, expires_at, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,'active',1,$7,$8,$8)`,
      [
        newId("debate_reservation"),
        claim.debate.project_id,
        claim.debate.id,
        claim.run.id,
        attemptId,
        amount,
        new Date(Date.parse(now) + 30 * 60_000).toISOString(),
        now,
      ],
    );
    await tx.query(
      `INSERT INTO debate_jobs (
         id, project_id, debate_id, debate_run_id, turn_attempt_id, job_kind,
         state, is_designated, delivery_attempt, idempotency_key, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,'execute_turn','queued',true,1,$6,$7,$7)`,
      [
        newId("debate_job"),
        claim.debate.project_id,
        claim.debate.id,
        claim.run.id,
        attemptId,
        `debate-turn:${attemptId}`,
        now,
      ],
    );
    await tx.query(
      `UPDATE debate_runs SET state = CASE WHEN state = 'finalizing' THEN 'finalizing' ELSE 'running' END,
        cursor_round_number = $2, cursor_turn_number = $3,
        aggregate_version = aggregate_version + 1, updated_at = $4 WHERE id = $1`,
      [claim.run.id, roundNumber, turnNumber, now],
    );
  }

  private async completeRun(
    tx: V2SqlExecutor,
    claim: ClaimedJob,
    reason: string,
    now: string,
  ): Promise<void> {
    const unresolved = await tx.query<{ unresolved: string | number }>(
      `SELECT COUNT(*) AS unresolved FROM debate_reservations
       WHERE debate_run_id = $1 AND status IN ('active','retained_ambiguous')`,
      [claim.run.id],
    );
    if (Number(unresolved.rows[0]?.unresolved ?? 0) > 0) {
      await tx.query(
        `UPDATE debate_runs SET state = 'paused', stop_reason = 'unresolved_reservation',
          lifecycle_version = lifecycle_version + 1, aggregate_version = aggregate_version + 1,
          finished_at = NULL, updated_at = $2 WHERE id = $1`,
        [claim.run.id, now],
      );
      await this.appendRunEvent(tx, claim, {
        eventType: "debate_run_paused",
        payload: { stop_reason: "unresolved_reservation" },
        occurredAt: now,
        lifecycleEvent: true,
      });
      return;
    }
    await tx.query(
      `UPDATE debate_runs SET state = 'completed', stop_reason = COALESCE(stop_reason, $2),
        lifecycle_version = lifecycle_version + 1, aggregate_version = aggregate_version + 1,
        finished_at = $3, updated_at = $3 WHERE id = $1`,
      [claim.run.id, reason, now],
    );
    await this.appendRunEvent(tx, claim, {
      eventType: "debate_run_completed",
      payload: { stop_reason: reason },
      occurredAt: now,
      lifecycleEvent: true,
    });
    await tx.query(
      "UPDATE debate_rounds SET state = 'completed', finished_at = COALESCE(finished_at,$2), updated_at = $2 WHERE id = $1 AND state = 'active'",
      [claim.round.id, now],
    );
  }

  private async insertRevision(
    tx: V2SqlExecutor,
    claim: ClaimedJob,
    input: {
      kind: "finding_disposition" | "judgment" | "final_output" | "correction";
      rationale: string;
      payload: Record<string, unknown>;
      supersedesRevisionId?: string | null;
      now: string;
    },
  ): Promise<string> {
    const revisionNumber = await tx.query<{ revision_number: string | number }>(
      `SELECT COALESCE(MAX(revision_number), 0) + 1 AS revision_number
       FROM debate_revisions WHERE debate_run_id = $1`,
      [claim.run.id],
    );
    const revisionId = newId("debate_revision");
    await tx.query(
      `INSERT INTO debate_revisions (
         id, project_id, debate_id, debate_run_id, revision_number, revision_kind,
         supersedes_revision_id, rationale, payload, created_by_actor_type,
         created_by_actor_id, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,'agent',$10,$11)`,
      [
        revisionId,
        claim.debate.project_id,
        claim.debate.id,
        claim.run.id,
        Number(revisionNumber.rows[0]?.revision_number ?? 1),
        input.kind,
        input.supersedesRevisionId ?? null,
        input.rationale,
        JSON.stringify(input.payload),
        claim.actor.id,
        input.now,
      ],
    );
    return revisionId;
  }

  private async insertFindings(
    tx: V2SqlExecutor,
    claim: ClaimedJob,
    messageId: string,
    findings: DebateFindingDraftT[],
    now: string,
  ): Promise<void> {
    for (const finding of findings) {
      await tx.query(
        `INSERT INTO debate_findings (
           id, project_id, debate_id, debate_run_id, message_id, finding_key,
           severity, finding, recommendation, disposition, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'open',$10)
         ON CONFLICT (message_id, finding_key) DO NOTHING`,
        [
          newId("debate_finding"),
          claim.debate.project_id,
          claim.debate.id,
          claim.run.id,
          messageId,
          finding.key,
          finding.severity,
          finding.finding,
          finding.recommendation,
          now,
        ],
      );
    }
  }

  private async fail(
    claim: ClaimedJob,
    error: unknown,
    externalExecutionStarted: boolean,
  ): Promise<void> {
    await this.transactions.transaction(async (tx) => {
      const runLock = await tx.query<{ state: string }>(
        "SELECT state FROM debate_runs WHERE id = $1 FOR UPDATE",
        [claim.run.id],
      );
      const currentRunState = runLock.rows[0]?.state;
      const found = await tx.query<{ lease_token: string | null; delivery_attempt: number }>(
        "SELECT lease_token, delivery_attempt FROM debate_jobs WHERE id = $1 FOR UPDATE",
        [claim.jobId],
      );
      const job = found.rows[0];
      if (!job || job.lease_token !== claim.leaseToken) return;
      const now = this.now().toISOString();
      const ambiguous =
        externalExecutionStarted &&
        (!(error instanceof AdapterError) ||
          ["network", "server", "cancelled", "invalid_response"].includes(error.kind));
      const retryableWithoutAmbiguity =
        error instanceof AdapterError && ["rate_limit", "overloaded"].includes(error.kind);
      const retry =
        currentRunState !== "cancelling" &&
        currentRunState !== "pausing" &&
        retryableWithoutAmbiguity &&
        job.delivery_attempt <
          Math.min(this.maxAttempts, claim.debate.stopping_policy.provider_failure_threshold);
      if (currentRunState === "cancelling") {
        await tx.query(
          `UPDATE debate_jobs SET state = 'cancelled', lease_token = NULL, leased_until = NULL,
            updated_at = $2 WHERE id = $1`,
          [claim.jobId, now],
        );
        await tx.query(
          `UPDATE debate_turn_attempts SET state = 'cancelled', failure_code = 'cancelled',
            failure_detail = $2, lease_token = NULL, leased_until = NULL,
            finished_at = $3, updated_at = $3 WHERE id = $1`,
          [
            claim.turnAttemptId,
            error instanceof Error
              ? error.message.slice(0, 10_000)
              : String(error).slice(0, 10_000),
            now,
          ],
        );
        await tx.query(
          "UPDATE debate_turns SET state = 'cancelled', completed_at = $2, updated_at = $2 WHERE id = $1",
          [claim.turn.id, now],
        );
        await tx.query(
          `UPDATE debate_rounds SET state = 'cancelled', finished_at = $2, updated_at = $2
           WHERE debate_run_id = $1 AND state IN ('pending','active')`,
          [claim.run.id, now],
        );
        if (ambiguous) {
          await tx.query(
            `UPDATE debate_reservations SET status = 'settled',
              resolution_outcome = 'cancelled_assumed_full_charge', settled_usd = amount_usd,
              retained_usd = 0, released_usd = 0, version = version + 1, updated_at = $2
             WHERE turn_attempt_id = $1 AND status = 'active'`,
            [claim.turnAttemptId, now],
          );
        } else {
          await tx.query(
            `UPDATE debate_reservations SET status = 'released', resolution_outcome = 'cancelled',
              released_usd = amount_usd, version = version + 1, updated_at = $2
             WHERE turn_attempt_id = $1 AND status = 'active'`,
            [claim.turnAttemptId, now],
          );
        }
        await tx.query(
          `UPDATE debate_runs SET state = 'cancelled', stop_reason = COALESCE(stop_reason, 'cancelled'),
            lifecycle_version = lifecycle_version + 1, aggregate_version = aggregate_version + 1,
            finished_at = $2, updated_at = $2 WHERE id = $1`,
          [claim.run.id, now],
        );
        await this.appendRunEvent(tx, claim, {
          eventType: "debate_run_cancelled_after_turn_failure",
          payload: { ambiguous, assumed_full_charge: ambiguous },
          occurredAt: now,
          lifecycleEvent: true,
        });
        return;
      }
      await tx.query(
        `UPDATE debate_jobs SET state = $2, lease_token = NULL, leased_until = NULL,
          delivery_attempt = delivery_attempt + CASE WHEN $2 = 'queued' THEN 1 ELSE 0 END,
          updated_at = $3 WHERE id = $1`,
        [claim.jobId, retry ? "queued" : "dead_letter", now],
      );
      await tx.query(
        `UPDATE debate_turn_attempts SET state = $2, failure_code = 'provider_failure',
          failure_detail = $3, lease_token = NULL, leased_until = NULL,
          finished_at = CASE WHEN $2 = 'failed' THEN $4::timestamptz ELSE NULL END, updated_at = $4
         WHERE id = $1`,
        [
          claim.turnAttemptId,
          retry ? "queued" : "failed",
          error instanceof Error ? error.message.slice(0, 10_000) : String(error).slice(0, 10_000),
          now,
        ],
      );
      await tx.query("UPDATE debate_turns SET state = $2, updated_at = $3 WHERE id = $1", [
        claim.turn.id,
        retry ? "queued" : "failed",
        now,
      ]);
      if (!retry) {
        if (ambiguous) {
          await tx.query(
            `UPDATE debate_reservations SET status = 'retained_ambiguous',
              retained_usd = amount_usd, version = version + 1, updated_at = $2
             WHERE turn_attempt_id = $1 AND status = 'active'`,
            [claim.turnAttemptId, now],
          );
        } else {
          await tx.query(
            `UPDATE debate_reservations SET status = 'released', resolution_outcome = 'provider_rejected',
              released_usd = amount_usd, version = version + 1, updated_at = $2
             WHERE turn_attempt_id = $1 AND status = 'active'`,
            [claim.turnAttemptId, now],
          );
        }
        await tx.query(
          `UPDATE debate_runs SET state = 'paused', stop_reason = $2,
            lifecycle_version = lifecycle_version + 1, aggregate_version = aggregate_version + 1,
            updated_at = $3 WHERE id = $1`,
          [
            claim.run.id,
            currentRunState === "pausing"
              ? "operator_pause"
              : ambiguous
                ? "ambiguous_execution"
                : "provider_failure_threshold",
            now,
          ],
        );
      }
      await this.appendRunEvent(tx, claim, {
        eventType: retry
          ? "debate_turn_retry_queued"
          : ambiguous
            ? "debate_turn_execution_ambiguous"
            : "debate_turn_paused_after_failure",
        payload: {
          round_number: claim.round.round_number,
          turn_number: claim.turn.turn_number,
          turn_attempt_id: claim.turnAttemptId,
          failure:
            error instanceof Error
              ? error.message.slice(0, 10_000)
              : String(error).slice(0, 10_000),
          retry,
          ambiguous,
        },
        occurredAt: now,
        lifecycleEvent: !retry,
      });
    });
  }

  private async appendRunEvent(
    tx: V2SqlExecutor,
    claim: ClaimedJob,
    input: {
      eventType: string;
      payload: Record<string, unknown>;
      occurredAt: string;
      lifecycleEvent?: boolean;
    },
  ): Promise<void> {
    const run = await tx.query<{ event_version: number; lifecycle_version: number }>(
      "SELECT event_version, lifecycle_version FROM debate_runs WHERE id = $1 FOR UPDATE",
      [claim.run.id],
    );
    const sequence = Number(run.rows[0]?.event_version ?? 0) + 1;
    await tx.query(
      `INSERT INTO debate_events (
         id, project_id, debate_id, debate_run_id, sequence, event_type,
         lifecycle_version, actor_type, actor_id, correlation_id, causation_id, payload, occurred_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,'agent',$8,$9,$10,$11::jsonb,$12)`,
      [
        newId("debate_event"),
        claim.debate.project_id,
        claim.debate.id,
        claim.run.id,
        sequence,
        input.eventType,
        input.lifecycleEvent ? Number(run.rows[0]?.lifecycle_version ?? 0) : null,
        claim.actor.id,
        claim.run.id,
        claim.turn.id,
        JSON.stringify(input.payload),
        input.occurredAt,
      ],
    );
    await tx.query(
      "UPDATE debate_runs SET event_version = $2, aggregate_version = aggregate_version + 1, updated_at = $3 WHERE id = $1",
      [claim.run.id, sequence, input.occurredAt],
    );
  }
}

function normalizeDates(row: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!row) throw new Error("required debate record missing");
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      value instanceof Date ? value.toISOString() : value,
    ]),
  );
}

function without(row: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const excluded = new Set(keys);
  return Object.fromEntries(Object.entries(row).filter(([key]) => !excluded.has(key)));
}

function parseActor(row: Record<string, unknown> | undefined): V2DebateActorT {
  const normalized = without(normalizeDates(row), ["project_id"]);
  return V2DebateActor.parse({
    ...normalized,
    budget_limit_usd: Number(normalized.budget_limit_usd),
  });
}

function outputContent(output: DebateTurnOutput): string {
  if ("content" in output) return output.content;
  return output.conclusion;
}

function semanticSignals(output: DebateTurnOutput): {
  consensus: boolean;
  materialChange: boolean;
  disagreementFingerprint: string | null;
} {
  const consensus = "consensus_reported" in output ? output.consensus_reported : false;
  const materialChange = "material_change" in output ? output.material_change : true;
  const disagreements = "unresolved_disagreements" in output ? output.unresolved_disagreements : [];
  return {
    consensus,
    materialChange,
    disagreementFingerprint:
      disagreements.length === 0
        ? null
        : createHash("sha256").update(JSON.stringify(disagreements)).digest("hex"),
  };
}
