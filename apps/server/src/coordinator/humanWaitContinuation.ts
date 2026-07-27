import {
  V2ContentAddressedReference,
  V2DispatchCommand,
  type V2DispatchCommandT,
  resolveV2BudgetReservation,
  v2CommandIdForDispatchJob,
} from "@norns/contracts";
import { canonicalJson, canonicalSha256 } from "../persistence/migration/canonicalJson.js";
import type { V2TransactionRunner } from "../persistence/v2/database.js";
import {
  transitionV2AgentRunLifecycle,
  transitionV2TaskLifecycle,
} from "../persistence/v2/lifecycleMutation.js";
import {
  SqlV2ApplicationTransaction,
  SqlV2BudgetTransaction,
} from "../persistence/v2/sqlRepositories.js";

export interface HumanWaitContinuationTarget {
  kind: "local" | "actions";
  runner_id: string;
  runner_generation: number;
  enrollment_secret_hash?: string;
}

export interface HumanWaitContinuationCandidate {
  continuation_id: string;
  project_id: string;
  repository_binding_id: string;
  repository_binding_type: "local_runner" | "github";
  repository_runner_id: string | null;
  source_runner_id: string;
}

export interface ProvisionedHumanWaitContinuation {
  continuation_id: string;
  wait_id: string;
  action_id: string;
  command: V2DispatchCommandT;
  target: HumanWaitContinuationTarget;
}

export class HumanWaitContinuationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HumanWaitContinuationConflictError";
  }
}

interface ContinuationRow {
  continuation_id: string;
  continuation_status: string;
  wait_id: string;
  wait_status: string;
  project_id: string;
  work_item_id: string;
  conversation_id: string;
  phase_id: string;
  task_id: string;
  source_run_id: string;
  source_runner_id: string;
  source_command_id: string;
  published_branch: string;
  published_commit_sha: string;
  runtime_session_id: string | null;
  session_portability: "transcript_only" | "same_runner" | "cross_runner_verified";
  session_portability_evidence: string | null;
  question_hash: string;
  compact_summary_hash: string;
  wait_context_hash: string;
  task_package_hash: string | null;
  root_context_refs: unknown;
  replay_context_ref: unknown;
  answer_receipt_hash: string;
  action_id: string;
  answered_by_user_id: string;
  resume_command_id: string;
  resume_job_id: string;
  budget_reservation_id: string;
  reservation_status: string;
  reservation_amount_usd: string | number;
  reservation_expires_at: Date | string;
  run_state: string;
  run_aggregate_version: number;
  run_usage_cost_usd: string | number;
  run_usage_input_tokens: string | number;
  run_usage_output_tokens: string | number;
  task_state: string;
  task_aggregate_version: number;
  repository_binding_id: string;
  repository_binding_type: "local_runner" | "github";
  repository_runner_id: string | null;
  runner_repository_id: string | null;
  root_envelope: unknown;
  original_root_envelope: unknown;
  attributable_usage_usd: string | number;
  source_actions_status: string | null;
  db_now: Date | string;
  elapsed_seconds: string | number;
}

function json<T>(value: unknown): T {
  return typeof value === "string" ? (JSON.parse(value) as T) : (value as T);
}

/**
 * Provisions one durable human-wait continuation into the ordinary Phase 4
 * dispatch outbox. It deliberately reuses the original AgentRun and budget
 * reservation: a human answer is a continuation, never a fresh attempt with a
 * fresh spending ceiling.
 */
export class HumanWaitContinuationWorker {
  private readonly owner: string;
  private readonly leaseMs: number;
  private readonly afterProvision: (provisioned: ProvisionedHumanWaitContinuation) => Promise<void>;

  constructor(
    private readonly transactions: V2TransactionRunner,
    private readonly resolveTarget: (
      candidate: HumanWaitContinuationCandidate,
    ) => Promise<HumanWaitContinuationTarget | null>,
    options: {
      owner?: string;
      leaseMs?: number;
      afterProvision?: (provisioned: ProvisionedHumanWaitContinuation) => Promise<void>;
    } = {},
  ) {
    this.owner = options.owner ?? `human-wait-continuation:${process.pid}`;
    this.leaseMs = options.leaseMs ?? 30_000;
    this.afterProvision = options.afterProvision ?? (async () => undefined);
  }

  async tick(): Promise<ProvisionedHumanWaitContinuation | null> {
    const recovery = await this.provisionedActionsRecovery();
    if (recovery) {
      await this.afterProvision(recovery);
      return recovery;
    }
    const candidate = await this.transactions.transaction(async (tx) => {
      const row = (
        await tx.query<HumanWaitContinuationCandidate>(
          `WITH candidate AS (
             SELECT id FROM human_wait_continuations
              WHERE (
                status='queued'
                OR (status='leased' AND lease_expires_at<=now())
              )
                AND available_at<=now()
              ORDER BY available_at,created_at,id
              FOR UPDATE SKIP LOCKED
              LIMIT 1
           )
           UPDATE human_wait_continuations continuation
              SET status='leased',lease_owner=$1,
                  lease_expires_at=now()+($2::text || ' milliseconds')::interval,
                  attempts=attempts+1,updated_at=now()
             FROM candidate,human_waits wait,agent_runs run,repository_bindings binding
            WHERE continuation.id=candidate.id
              AND wait.id=continuation.wait_id
              AND run.id=continuation.root_run_id
              AND binding.id=run.repository_binding_id
           RETURNING continuation.id AS continuation_id,wait.project_id,
                  run.repository_binding_id,
                  binding.binding_type AS repository_binding_type,
                  binding.runner_id AS repository_runner_id,
                  run.runner_id AS source_runner_id`,
          [this.owner, this.leaseMs],
        )
      ).rows[0];
      return row ?? null;
    });
    if (!candidate) return null;
    try {
      const target = await this.resolveTarget(candidate);
      if (!target) {
        await this.release(candidate.continuation_id, "no eligible continuation runner");
        return null;
      }
      const provisioned = await this.provision(candidate.continuation_id, target);
      if (provisioned) await this.afterProvision(provisioned);
      return provisioned;
    } catch (error) {
      await this.release(
        candidate.continuation_id,
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }

  private async provisionedActionsRecovery(): Promise<ProvisionedHumanWaitContinuation | null> {
    return this.transactions.transaction(async (tx) => {
      const row = (
        await tx.query<{
          continuation_id: string;
          wait_id: string;
          action_id: string;
          runner_id: string;
          runner_generation: number;
          enrollment_secret_hash: string | null;
          envelope: unknown;
        }>(
          `SELECT continuation.id AS continuation_id,continuation.wait_id,
                  answer.action_id,continuation.runner_id,
                  continuation.runner_generation,continuation.enrollment_secret_hash,
                  command.envelope
             FROM human_wait_continuations continuation
             JOIN human_wait_answers answer ON answer.id=continuation.answer_id
             JOIN human_waits wait ON wait.id=continuation.wait_id
             JOIN agent_runs run ON run.id=continuation.root_run_id
             JOIN repository_bindings binding ON binding.id=run.repository_binding_id
             JOIN commands command ON command.command_id=continuation.resume_command_id
             LEFT JOIN github_actions_runs actions
               ON actions.dispatch_job_id=continuation.resume_job_id
            WHERE continuation.status='provisioned'
              AND binding.binding_type='github'
              AND continuation.runner_id IS NOT NULL
              AND continuation.runner_generation IS NOT NULL
              -- Once the durable Actions outbox row exists, the shared
              -- Actions launch worker exclusively owns requested/dispatching
              -- retries and max-attempt terminalization.
              AND actions.id IS NULL
              AND continuation.available_at<=now()
            ORDER BY continuation.updated_at,continuation.id
            LIMIT 1`,
        )
      ).rows[0];
      if (!row) return null;
      return {
        continuation_id: row.continuation_id,
        wait_id: row.wait_id,
        action_id: row.action_id,
        command: V2DispatchCommand.parse(json(row.envelope)),
        target: {
          kind: "actions",
          runner_id: row.runner_id,
          runner_generation: row.runner_generation,
          ...(row.enrollment_secret_hash
            ? { enrollment_secret_hash: row.enrollment_secret_hash }
            : {}),
        },
      };
    });
  }

  private async release(continuationId: string, error: string): Promise<void> {
    await this.transactions.transaction(async (tx) => {
      await tx.query(
        `UPDATE human_wait_continuations
            SET status='queued',lease_owner=NULL,lease_expires_at=NULL,
                available_at=now()+interval '5 seconds',
                last_error=$3,updated_at=now()
          WHERE id=$1 AND status='leased' AND lease_owner=$2`,
        [continuationId, this.owner, error.slice(0, 2_000)],
      );
    });
  }

  async provision(
    continuationId: string,
    target: HumanWaitContinuationTarget,
  ): Promise<ProvisionedHumanWaitContinuation | null> {
    return this.transactions.transaction(async (tx) => {
      const row = (
        await tx.query<ContinuationRow>(
          `WITH RECURSIVE command_chain(command_id,envelope,depth) AS (
             SELECT command.command_id,command.envelope,0
               FROM human_wait_continuations target_continuation
               JOIN commands command
                 ON command.command_id=target_continuation.root_command_id
              WHERE target_continuation.id=$1
             UNION ALL
             SELECT parent.command_id,parent.envelope,chain.depth+1
               FROM command_chain chain
               JOIN commands parent
                 ON parent.command_id=chain.envelope->'continuation'->>'root_command_id'
              WHERE chain.depth<100
           )
           SELECT continuation.id AS continuation_id,
                  continuation.status AS continuation_status,
                  continuation.wait_id,continuation.replay_context_ref,
                  continuation.answer_receipt_hash,continuation.resume_command_id,
                  continuation.resume_job_id,continuation.budget_reservation_id,
                  wait.status AS wait_status,wait.project_id,wait.work_item_id,
                  wait.conversation_id,wait.phase_id,wait.task_id,
                  wait.source_run_id,wait.source_command_id,
                  wait.published_branch,wait.published_commit_sha,
                  wait.runtime_session_id,wait.session_portability,
                  wait.session_portability_evidence,wait.question_hash,
                  wait.compact_summary_hash,wait.context_hash AS wait_context_hash,
                  wait.task_package_hash,wait.root_context_refs,
                  answer.action_id,answer.answered_by_user_id,
                  reservation.status AS reservation_status,
                  reservation.amount_usd AS reservation_amount_usd,
                  reservation.expires_at AS reservation_expires_at,
                  run.state AS run_state,run.aggregate_version AS run_aggregate_version,
                  GREATEST(run.usage_cost_usd,COALESCE((
                    SELECT sum(receipt.cost_usd)
                      FROM run_command_usage_receipts receipt
                     WHERE receipt.run_id=run.id
                  ),0)) AS run_usage_cost_usd,
                  GREATEST(run.usage_input_tokens,COALESCE((
                    SELECT sum(receipt.input_tokens)
                      FROM run_command_usage_receipts receipt
                     WHERE receipt.run_id=run.id
                  ),0)) AS run_usage_input_tokens,
                  GREATEST(run.usage_output_tokens,COALESCE((
                    SELECT sum(receipt.output_tokens)
                      FROM run_command_usage_receipts receipt
                     WHERE receipt.run_id=run.id
                  ),0)) AS run_usage_output_tokens,
                  run.runner_id AS source_runner_id,run.repository_binding_id,
                  task.state AS task_state,task.aggregate_version AS task_aggregate_version,
                  binding.binding_type AS repository_binding_type,
                  binding.runner_id AS repository_runner_id,
                  binding.repository_id AS runner_repository_id,
                  root.envelope AS root_envelope,
                  original_root.envelope AS original_root_envelope,
                  GREATEST(COALESCE((
                    SELECT sum(usage.cost_usd)
                      FROM usage_events usage
                     WHERE usage.run_id=run.id
                  ),0),COALESCE((
                    SELECT sum(receipt.cost_usd)
                      FROM run_command_usage_receipts receipt
                     WHERE receipt.run_id=run.id
                  ),0),run.usage_cost_usd) AS attributable_usage_usd,
                  (
                    SELECT actions.status
                      FROM github_actions_runs actions
                     WHERE actions.run_id=run.id
                     ORDER BY actions.created_at DESC,actions.id DESC
                     LIMIT 1
                  ) AS source_actions_status,
                  statement_timestamp() AS db_now,
                  COALESCE((
                    SELECT sum(receipt.active_ms)::numeric/1000
                      FROM run_command_usage_receipts receipt
                     WHERE receipt.run_id=run.id
                  ),0) AS elapsed_seconds
             FROM human_wait_continuations continuation
             JOIN human_waits wait ON wait.id=continuation.wait_id
             JOIN human_wait_answers answer ON answer.id=continuation.answer_id
             JOIN agent_runs run ON run.id=continuation.root_run_id
             JOIN tasks task ON task.id=run.task_id
             JOIN budget_reservations reservation
               ON reservation.id=continuation.budget_reservation_id
             JOIN commands root ON root.command_id=continuation.root_command_id
             JOIN LATERAL (
               SELECT chain.envelope
                 FROM command_chain chain
                ORDER BY chain.depth DESC
                LIMIT 1
             ) original_root ON true
             JOIN repository_bindings binding ON binding.id=run.repository_binding_id
            WHERE continuation.id=$1
            FOR UPDATE OF continuation,wait,run,task,reservation`,
          [continuationId],
        )
      ).rows[0];
      if (!row) return null;
      if (row.continuation_status !== "leased") return null;
      if (
        row.wait_status !== "continuation_queued" ||
        row.run_state !== "waiting_for_human" ||
        row.task_state !== "blocked" ||
        row.reservation_status !== "active"
      ) {
        throw new HumanWaitContinuationConflictError(
          "continuation source run, task, wait, and reservation are not resumable",
        );
      }
      if (
        (row.repository_binding_type === "local_runner" && target.kind !== "local") ||
        (row.repository_binding_type === "github" && target.kind !== "actions")
      ) {
        throw new HumanWaitContinuationConflictError(
          "continuation target kind does not match the repository binding",
        );
      }
      if (row.repository_binding_type === "github" && row.source_actions_status === null) {
        throw new HumanWaitContinuationConflictError(
          "the source GitHub Actions execution ledger is missing",
        );
      }
      if (
        row.source_actions_status !== null &&
        !["completed", "failed", "abandoned"].includes(row.source_actions_status)
      ) {
        throw new HumanWaitContinuationConflictError(
          "the prior GitHub Actions runner has not reached a terminal state",
        );
      }
      if (
        row.repository_binding_type === "local_runner" &&
        target.runner_id !== row.repository_runner_id
      ) {
        throw new HumanWaitContinuationConflictError(
          "a local continuation must use the repository binding's paired runner",
        );
      }
      const root = V2DispatchCommand.parse(json(row.root_envelope));
      const originalRoot = V2DispatchCommand.parse(json(row.original_root_envelope));
      if (
        root.command_id !== row.source_command_id ||
        root.run_id !== row.source_run_id ||
        root.budget_reservation_id !== row.budget_reservation_id ||
        root.repository_binding_id !== row.repository_binding_id
      ) {
        throw new HumanWaitContinuationConflictError(
          "the root command no longer matches the exact wait scope",
        );
      }
      if (
        originalRoot.run_id !== row.source_run_id ||
        originalRoot.budget_reservation_id !== row.budget_reservation_id ||
        originalRoot.continuation !== undefined
      ) {
        throw new HumanWaitContinuationConflictError(
          "the immutable original command ceiling could not be resolved",
        );
      }
      const rootRefs = json<unknown[]>(row.root_context_refs).map((reference) =>
        V2ContentAddressedReference.parse(reference),
      );
      if (canonicalJson(rootRefs) !== canonicalJson(root.context_refs)) {
        throw new HumanWaitContinuationConflictError(
          "the preserved root context order does not match the root command",
        );
      }
      const replayRef = V2ContentAddressedReference.parse(json(row.replay_context_ref));
      if (rootRefs.some((reference) => reference.artifact_id === replayRef.artifact_id)) {
        throw new HumanWaitContinuationConflictError(
          "the continuation addendum must be a new context artifact",
        );
      }
      const issuedAt = new Date(row.db_now).toISOString();
      const expiresAt = new Date(row.reservation_expires_at).toISOString();
      if (Date.parse(expiresAt) <= Date.parse(issuedAt)) {
        throw new HumanWaitContinuationConflictError(
          "the continuation budget reservation expired before dispatch",
        );
      }
      const actualUsage = Math.max(
        Number(row.run_usage_cost_usd),
        Number(row.attributable_usage_usd),
      );
      const remainingCharge = Math.max(
        0,
        Math.min(Number(row.reservation_amount_usd), originalRoot.max_charge_usd) - actualUsage,
      );
      const remainingInputTokens = Math.max(
        0,
        originalRoot.max_input_tokens - Number(row.run_usage_input_tokens),
      );
      const remainingOutputTokens = Math.max(
        0,
        originalRoot.max_output_tokens - Number(row.run_usage_output_tokens),
      );
      const remainingDurationSeconds = Math.max(
        0,
        originalRoot.max_duration_seconds - Math.ceil(Number(row.elapsed_seconds)),
      );
      if (
        remainingCharge <= 0 ||
        remainingInputTokens <= 0 ||
        remainingOutputTokens <= 0 ||
        remainingDurationSeconds <= 0
      ) {
        throw new HumanWaitContinuationConflictError(
          "the continuation has no remaining money, token, or duration budget",
        );
      }
      const canResumeSession =
        row.runtime_session_id !== null &&
        (row.session_portability === "cross_runner_verified" ||
          (row.session_portability === "same_runner" && target.runner_id === row.source_runner_id));
      const resumeSessionId = canResumeSession ? row.runtime_session_id : null;
      const { runner_repository_id: _rootRunnerRepositoryId, ...rootWithoutRunnerRepository } =
        root;
      const command = V2DispatchCommand.parse({
        ...rootWithoutRunnerRepository,
        dispatch_job_id: row.resume_job_id,
        command_id: v2CommandIdForDispatchJob(row.resume_job_id),
        delivery_attempt: 1,
        idempotency_key: row.resume_command_id,
        correlation_id: row.continuation_id,
        causation_id: row.source_command_id,
        runner_id: target.runner_id,
        runner_generation: target.runner_generation,
        expected_revision: row.published_commit_sha,
        target_branch: row.published_branch,
        context_refs: [...rootRefs, replayRef],
        continuation: {
          wait_id: row.wait_id,
          root_command_id: row.source_command_id,
          resume_commit_sha: row.published_commit_sha,
          resume_branch: row.published_branch,
          question_hash: row.question_hash,
          answer_receipt_hash: row.answer_receipt_hash,
          compact_summary_hash: row.compact_summary_hash,
          context_hash: row.wait_context_hash,
          task_package_hash: row.task_package_hash,
          replay_context_ref: replayRef,
          ...(resumeSessionId ? { resume_session_id: resumeSessionId } : {}),
          session_portability: canResumeSession ? row.session_portability : "transcript_only",
          session_portability_evidence: canResumeSession ? row.session_portability_evidence : null,
        },
        budget_reservation_id: row.budget_reservation_id,
        max_charge_usd: remainingCharge,
        max_input_tokens: remainingInputTokens,
        max_output_tokens: remainingOutputTokens,
        max_duration_seconds: remainingDurationSeconds,
        authorized_by: {
          actor_type: "human",
          actor_id: row.answered_by_user_id,
        },
        authorized_by_session_id: `human-wait:${row.wait_id}`,
        issued_at: issuedAt,
        expires_at: expiresAt,
        ...(row.repository_binding_type === "local_runner" && row.runner_repository_id
          ? { runner_repository_id: row.runner_repository_id }
          : {}),
      });
      if (
        command.command_id !== row.resume_command_id ||
        canonicalJson(command.context_refs) !== canonicalJson([...rootRefs, replayRef])
      ) {
        throw new HumanWaitContinuationConflictError(
          "continuation command identity or context order is not exact",
        );
      }
      await tx.query(
        `INSERT INTO commands (
           command_id,dispatch_job_id,project_id,phase_id,task_id,run_id,
           runner_id,runner_generation,kind,envelope,status,correlation_id,causation_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'launch_run',$9::jsonb,'queued',$10,$11)`,
        [
          command.command_id,
          command.dispatch_job_id,
          row.project_id,
          row.phase_id,
          row.task_id,
          row.source_run_id,
          target.runner_id,
          target.runner_generation,
          JSON.stringify(command),
          command.correlation_id,
          command.causation_id,
        ],
      );
      for (const supplement of command.task_package_supplements) {
        await tx.query(
          `INSERT INTO conversation_task_package_supplement_dispatch_receipts (
             command_id,run_id,supplement_id,project_id,phase_id,task_id,
             base_package_id,ordinal,content_hash,context_document_id,context_ref
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
          [
            command.command_id,
            row.source_run_id,
            supplement.supplement_id,
            row.project_id,
            row.phase_id,
            row.task_id,
            supplement.base_package_id,
            supplement.ordinal,
            supplement.content_hash,
            supplement.context_ref.artifact_id,
            JSON.stringify(supplement.context_ref),
          ],
        );
      }
      await tx.query(
        `INSERT INTO dispatch_jobs (
           id,project_id,phase_id,task_id,run_id,command_id,runner_id,status
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          command.dispatch_job_id,
          row.project_id,
          row.phase_id,
          row.task_id,
          row.source_run_id,
          command.command_id,
          target.runner_id,
          target.kind === "actions" ? "awaiting_enrollment" : "queued",
        ],
      );
      for (const reference of command.context_refs) {
        await tx.query(
          `INSERT INTO dispatch_context_documents (
             runner_id,context_document_id,dispatch_job_id,run_id
           ) VALUES ($1,$2,$3,$4)
           ON CONFLICT(runner_id,context_document_id) DO UPDATE SET
             dispatch_job_id=EXCLUDED.dispatch_job_id,
             run_id=EXCLUDED.run_id,created_at=now()`,
          [target.runner_id, reference.artifact_id, command.dispatch_job_id, row.source_run_id],
        );
      }
      const queuedDirections = (
        await tx.query<{
          action_id: string;
          project_id: string;
          work_item_id: string;
          conversation_id: string;
          action_status: string;
          intent_id: string;
        }>(
          `SELECT checkpoint.action_id,checkpoint.project_id,checkpoint.work_item_id,
                  checkpoint.conversation_id,action.status AS action_status,
                  intent.id AS intent_id
             FROM conversation_action_checkpoint_contexts checkpoint
             JOIN conversation_actions action ON action.id=checkpoint.action_id
             JOIN conversation_action_delivery_intents intent
               ON intent.action_id=checkpoint.action_id
            WHERE checkpoint.task_id=$1 AND checkpoint.status='prepared'
              AND checkpoint.context_document_id=$2 AND checkpoint.context_hash=$3
              AND intent.status='fallback_queued'
            ORDER BY action.confirmed_at,action.id
            FOR UPDATE OF checkpoint,action,intent`,
          [row.task_id, replayRef.artifact_id, replayRef.content_hash],
        )
      ).rows;
      for (const direction of queuedDirections) {
        await tx.query(
          `UPDATE conversation_action_delivery_intents
              SET status='leased',lease_owner='human-wait-direction',
                  lease_expires_at=now()+interval '30 seconds',attempts=attempts+1,
                  updated_at=now()
            WHERE id=$1 AND status='fallback_queued'`,
          [direction.intent_id],
        );
        const sentIntent = await tx.query<{ id: string }>(
          `UPDATE conversation_action_delivery_intents
              SET status='sent',target_command_id=$2,target_runner_generation=$3,
                  lease_owner=NULL,lease_expires_at=NULL,last_error=NULL,updated_at=now()
            WHERE id=$1 AND status='leased' AND lease_owner='human-wait-direction'
            RETURNING id`,
          [direction.intent_id, command.command_id, target.runner_generation],
        );
        if (direction.action_status === "recorded") {
          await tx.query(
            `UPDATE conversation_actions SET status='sent',sent_at=$2,updated_at=now()
              WHERE id=$1 AND status='recorded'`,
            [direction.action_id, issuedAt],
          );
        }
        const sentContext = await tx.query<{ action_id: string }>(
          `UPDATE conversation_action_checkpoint_contexts
              SET status='sent',command_id=$2,sent_at=$3
            WHERE action_id=$1 AND status='prepared'
            RETURNING action_id`,
          [direction.action_id, command.command_id, issuedAt],
        );
        if (!sentIntent.rows[0] || !sentContext.rows[0]) {
          throw new HumanWaitContinuationConflictError(
            "queued continuation direction lost its exact checkpoint binding",
          );
        }
        await tx.query(
          `INSERT INTO conversation_action_delivery_events (
             id,project_id,work_item_id,conversation_id,action_id,sequence,status,
             delivery_mode,target_run_id,target_command_id,receipt,occurred_at
           ) SELECT $1,$2,$3,$4,$5,COALESCE(max(sequence),0)+1,
                    'sent','continuation',$6,$7,$8::jsonb,$9
               FROM conversation_action_delivery_events WHERE action_id=$5`,
          [
            `action-delivery-event:${direction.action_id}:continuation:${command.command_id}`,
            direction.project_id,
            direction.work_item_id,
            direction.conversation_id,
            direction.action_id,
            row.source_run_id,
            command.command_id,
            JSON.stringify({ kind: "sent", outbox_id: command.dispatch_job_id }),
            issuedAt,
          ],
        );
      }
      const lifecycle = new SqlV2ApplicationTransaction(tx);
      const lockedRun = await lifecycle.lockAgentRunLifecycle(row.source_run_id);
      if (
        !lockedRun ||
        lockedRun.state !== "waiting_for_human" ||
        lockedRun.aggregate_version !== row.run_aggregate_version
      ) {
        throw new HumanWaitContinuationConflictError(
          "continuation could not retarget the waiting run to the selected runner",
        );
      }
      await lifecycle.recordAgentRunContinuationTarget({
        row: lockedRun,
        runner_id: target.runner_id,
        expected_revision: row.published_commit_sha,
      });
      await transitionV2AgentRunLifecycle(lifecycle, {
        project_id: row.project_id,
        phase_id: row.phase_id,
        task_id: row.task_id,
        run_id: row.source_run_id,
        expected_aggregate_version: lockedRun.aggregate_version,
        to: "dispatched",
        reason: `human wait ${row.wait_id} answered`,
        actor_type: "coordinator",
        actor_id: "human-wait-continuation",
        correlation_id: row.continuation_id,
        causation_id: row.source_command_id,
        occurred_at: issuedAt,
      });
      await transitionV2TaskLifecycle(lifecycle, {
        project_id: row.project_id,
        phase_id: row.phase_id,
        task_id: row.task_id,
        expected_aggregate_version: row.task_aggregate_version,
        to: "assigned",
        reason: `continuation ${row.continuation_id} queued`,
        actor_type: "coordinator",
        actor_id: "human-wait-continuation",
        correlation_id: row.continuation_id,
        causation_id: row.source_command_id,
        occurred_at: issuedAt,
      });
      const deliveryReceiptHash = canonicalSha256({
        kind: "provisioned",
        outbox_id: command.dispatch_job_id,
        target_run_id: row.source_run_id,
        target_command_id: command.command_id,
        runner_id: target.runner_id,
        runner_generation: target.runner_generation,
        context_refs_hash: canonicalSha256(command.context_refs),
      });
      const provisioned = await tx.query<{ id: string }>(
        `UPDATE human_wait_continuations
            SET status='provisioned',runner_id=$2,runner_generation=$3,
                enrollment_secret_hash=$4,delivery_receipt_hash=$5,
                lease_owner=NULL,lease_expires_at=NULL,updated_at=now()
          WHERE id=$1 AND status='leased' AND lease_owner=$6
          RETURNING id`,
        [
          row.continuation_id,
          target.runner_id,
          target.runner_generation,
          target.enrollment_secret_hash ?? null,
          deliveryReceiptHash,
          this.owner,
        ],
      );
      if (!provisioned.rows[0]) {
        throw new HumanWaitContinuationConflictError(
          "continuation provisioning lost its fenced lease",
        );
      }
      return {
        continuation_id: row.continuation_id,
        wait_id: row.wait_id,
        action_id: row.action_id,
        command,
        target,
      };
    });
  }
}

export class HumanWaitRecoveryWorker {
  constructor(private readonly transactions: V2TransactionRunner) {}

  async scan(limit = 100, cutoff?: string): Promise<number> {
    let expired = 0;
    for (let index = 0; index < limit; index += 1) {
      if (!(await this.expireOne(cutoff))) break;
      expired += 1;
    }
    return expired;
  }

  private async expireOne(cutoff?: string): Promise<boolean> {
    return this.transactions.transaction(async (tx) => {
      const row = (
        await tx.query<{
          id: string;
          project_id: string;
          work_item_id: string;
          conversation_id: string;
          phase_id: string;
          task_id: string;
          source_run_id: string;
          source_command_id: string;
          decision_point_id: string;
          budget_reservation_id: string;
          initiated_by_user_id: string;
          next_message_sequence: string | number;
          actual_usage_usd: string | number;
          db_now: Date | string;
        }>(
          `SELECT wait.id,wait.project_id,wait.work_item_id,wait.conversation_id,
                  wait.phase_id,wait.task_id,wait.source_run_id,
                  wait.source_command_id,wait.decision_point_id,
                  wait.budget_reservation_id,conversation.created_by_user_id
                    AS initiated_by_user_id,
                  conversation.next_message_sequence,
                  GREATEST(
                    run.usage_cost_usd,
                    COALESCE((
                      SELECT sum(usage.cost_usd)
                        FROM usage_events usage
                       WHERE usage.run_id=wait.source_run_id
                    ),0)
                  ) AS actual_usage_usd,
                  statement_timestamp() AS db_now
             FROM human_waits wait
             JOIN work_conversations conversation ON conversation.id=wait.conversation_id
             JOIN agent_runs run ON run.id=wait.source_run_id
            WHERE wait.status='awaiting_human'
              AND wait.expires_at<=COALESCE($1::timestamptz,now())
            ORDER BY wait.expires_at,wait.id
            FOR UPDATE OF wait,conversation,run SKIP LOCKED
            LIMIT 1`,
          [cutoff ?? null],
        )
      ).rows[0];
      if (!row) return false;
      const budget = new SqlV2BudgetTransaction(tx);
      const reservation = await budget.lockReservation(row.budget_reservation_id);
      if (!reservation) {
        throw new HumanWaitContinuationConflictError(
          "expired human wait has no budget reservation",
        );
      }
      const occurredAt = new Date(row.db_now).toISOString();
      const usage = Math.min(reservation.amount_usd, Math.max(0, Number(row.actual_usage_usd)));
      if (reservation.status === "active") {
        const outcome: "partial_usage" | "expired" = usage > 0 ? "partial_usage" : "expired";
        const request = {
          reservation_id: reservation.id,
          expected_version: reservation.version,
          outcome,
          attributable_usage_usd: usage,
          reason: `human wait ${row.id} expired without an answer`,
          actor_type: "coordinator" as const,
          actor_id: "human-wait-recovery",
          correlation_id: row.id,
          causation_id: row.source_command_id,
          occurred_at: occurredAt,
        };
        await budget.applyResolution(
          reservation,
          request,
          resolveV2BudgetReservation(reservation.amount_usd, request),
        );
      }
      const lifecycle = new SqlV2ApplicationTransaction(tx);
      const run = await lifecycle.lockAgentRunLifecycle(row.source_run_id);
      if (run?.state === "waiting_for_human") {
        await transitionV2AgentRunLifecycle(lifecycle, {
          project_id: row.project_id,
          phase_id: row.phase_id,
          task_id: row.task_id,
          run_id: row.source_run_id,
          expected_aggregate_version: run.aggregate_version,
          to: "expired",
          reason: `human wait ${row.id} expired`,
          actor_type: "coordinator",
          actor_id: "human-wait-recovery",
          correlation_id: row.id,
          causation_id: row.source_command_id,
          occurred_at: occurredAt,
        });
      }
      await tx.query(
        `UPDATE decision_points
            SET status='dismissed',resolved_at=$2,updated_at=now()
          WHERE id=$1 AND status='open'`,
        [row.decision_point_id, occurredAt],
      );
      const expired = await tx.query<{ id: string }>(
        `UPDATE human_waits
            SET status='expired',version=version+1,updated_at=now()
          WHERE id=$1 AND status='awaiting_human'
            AND expires_at<=COALESCE($2::timestamptz,now())
          RETURNING id`,
        [row.id, cutoff ?? null],
      );
      if (!expired.rows[0]) {
        throw new HumanWaitContinuationConflictError("expired human wait changed during recovery");
      }
      await tx.query(
        `INSERT INTO work_messages (
           id,project_id,work_item_id,conversation_id,initiated_by_user_id,
           actor_type,actor_id,role,visibility_status,sequence,parts
         ) VALUES ($1,$2,$3,$4,$5,'coordinator',NULL,'assistant','complete',$6,$7::jsonb)`,
        [
          `message:expired:${row.id}`,
          row.project_id,
          row.work_item_id,
          row.conversation_id,
          row.initiated_by_user_id,
          Number(row.next_message_sequence),
          JSON.stringify([
            {
              type: "text",
              format: "markdown",
              text: "This decision request expired. The runner remains released and the task is blocked for new direction.",
            },
            { type: "human_wait_update", human_wait_id: row.id, status: "expired" },
          ]),
        ],
      );
      await tx.query(
        `UPDATE work_conversations
            SET next_message_sequence=next_message_sequence+1,updated_at=now()
          WHERE id=$1`,
        [row.conversation_id],
      );
      return true;
    });
  }
}
