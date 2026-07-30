import {
  V2ContentAddressedReference,
  V2DispatchCommand,
  type V2DispatchCommandT,
  v2CommandIdForDispatchJob,
} from "@norns/contracts";
import type { PostgresDeviceActionAuthorization } from "../devices/actionAuthorization.js";
import { canonicalJson, canonicalSha256 } from "../persistence/migration/canonicalJson.js";
import type { V2TransactionRunner } from "../persistence/v2/database.js";
import {
  transitionV2AgentRunLifecycle,
  transitionV2TaskLifecycle,
} from "../persistence/v2/lifecycleMutation.js";
import { SqlV2ApplicationTransaction } from "../persistence/v2/sqlRepositories.js";

export interface PauseResumeTarget {
  kind: "local" | "actions";
  runner_id: string;
  runner_generation: number;
  enrollment_secret_hash?: string;
}

export interface PauseResumeCandidate {
  pause_action_id: string;
  continuation_id: string;
  project_id: string;
  repository_binding_id: string;
  repository_binding_type: "local_runner" | "github";
  repository_runner_id: string | null;
}

export interface ProvisionedPauseResume {
  pause_action_id: string;
  resume_action_id: string;
  command: V2DispatchCommandT;
  target: PauseResumeTarget;
}

function json<T>(value: unknown): T {
  return typeof value === "string" ? (JSON.parse(value) as T) : (value as T);
}

/**
 * Provisions an explicit pause resume into the ordinary Phase 4 outbox. The
 * logical AgentRun and reservation remain unchanged; only the runner lease,
 * command and immutable resume addendum are new.
 */
export class PauseResumeContinuationWorker {
  private readonly owner: string;

  constructor(
    private readonly transactions: V2TransactionRunner,
    private readonly resolveTarget: (
      candidate: PauseResumeCandidate,
    ) => Promise<PauseResumeTarget | null>,
    private readonly afterProvision: (result: ProvisionedPauseResume) => Promise<void> = async () =>
      undefined,
    owner = `pause-resume:${process.pid}`,
    private readonly deviceAuthorization?: PostgresDeviceActionAuthorization,
  ) {
    this.owner = owner;
  }

  async tick(): Promise<ProvisionedPauseResume | null> {
    const recovery = await this.provisionedActionsRecovery();
    if (recovery) {
      await this.afterProvision(recovery);
      return recovery;
    }
    const candidate = await this.transactions.transaction(async (tx) => {
      const row = (
        await tx.query<PauseResumeCandidate>(
          `WITH candidate AS (
             SELECT pause_action_id FROM conversation_pause_checkpoints
              WHERE status='resume_queued'
                 OR (status='leased' AND lease_expires_at<=now())
              ORDER BY available_at,created_at,pause_action_id
              FOR UPDATE SKIP LOCKED
              LIMIT 1
           )
           UPDATE conversation_pause_checkpoints checkpoint
              SET status='leased',lease_owner=$1,lease_expires_at=now()+interval '30 seconds',
                  attempts=attempts+1,updated_at=now()
             FROM candidate,agent_runs run,repository_bindings binding
            WHERE checkpoint.pause_action_id=candidate.pause_action_id
              AND run.id=checkpoint.run_id AND binding.id=run.repository_binding_id
           RETURNING checkpoint.pause_action_id,
                     ('pause-resume:' || checkpoint.pause_action_id) AS continuation_id,
                     checkpoint.project_id,run.repository_binding_id,
                     binding.binding_type AS repository_binding_type,
                     binding.runner_id AS repository_runner_id`,
          [this.owner],
        )
      ).rows[0];
      return row ?? null;
    });
    if (!candidate) return null;
    try {
      const target = await this.resolveTarget(candidate);
      if (!target) {
        await this.release(candidate.pause_action_id, "no eligible pause-resume runner");
        return null;
      }
      const result = await this.provision(candidate.pause_action_id, target);
      if (result) await this.afterProvision(result);
      return result;
    } catch (error) {
      await this.release(
        candidate.pause_action_id,
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }

  private async provisionedActionsRecovery(): Promise<ProvisionedPauseResume | null> {
    return this.transactions.transaction(async (tx) => {
      const row = (
        await tx.query<{
          pause_action_id: string;
          resume_action_id: string;
          runner_id: string;
          runner_generation: number;
          enrollment_secret_hash: string | null;
          envelope: unknown;
        }>(
          `SELECT checkpoint.pause_action_id,checkpoint.resume_action_id,
                  checkpoint.runner_id,checkpoint.runner_generation,
                  checkpoint.enrollment_secret_hash,command.envelope
             FROM conversation_pause_checkpoints checkpoint
             JOIN agent_runs run ON run.id=checkpoint.run_id
             JOIN repository_bindings binding ON binding.id=run.repository_binding_id
             JOIN commands command ON command.command_id=checkpoint.resume_command_id
             LEFT JOIN github_actions_runs actions
               ON actions.dispatch_job_id=checkpoint.resume_job_id
            WHERE checkpoint.status='provisioned'
              AND binding.binding_type='github'
              AND checkpoint.runner_id IS NOT NULL
              AND checkpoint.runner_generation IS NOT NULL
              -- The shared Actions launch worker owns all retries after its
              -- durable row has been created.
              AND actions.id IS NULL
              AND checkpoint.available_at<=now()
            ORDER BY checkpoint.updated_at,checkpoint.pause_action_id
            LIMIT 1`,
        )
      ).rows[0];
      if (!row) return null;
      return {
        pause_action_id: row.pause_action_id,
        resume_action_id: row.resume_action_id,
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

  private async release(pauseActionId: string, error: string): Promise<void> {
    await this.transactions.transaction(async (tx) => {
      await tx.query(
        `UPDATE conversation_pause_checkpoints
            SET status='resume_queued',lease_owner=NULL,lease_expires_at=NULL,
                available_at=now()+interval '5 seconds',last_error=$3,updated_at=now()
          WHERE pause_action_id=$1 AND status='leased' AND lease_owner=$2`,
        [pauseActionId, this.owner, error.slice(0, 2_000)],
      );
    });
  }

  async provision(
    pauseActionId: string,
    target: PauseResumeTarget,
  ): Promise<ProvisionedPauseResume | null> {
    return this.transactions.transaction(async (tx) => {
      const row = (
        await tx.query<{
          pause_action_id: string;
          resume_action_id: string;
          project_id: string;
          work_item_id: string;
          conversation_id: string;
          phase_id: string;
          task_id: string;
          run_id: string;
          source_command_id: string;
          budget_reservation_id: string;
          published_branch: string;
          published_commit_sha: string;
          root_context_refs: unknown;
          context_hash: string;
          resume_context_ref: unknown;
          resume_command_id: string;
          resume_job_id: string;
          run_state: string;
          run_aggregate_version: number;
          task_state: string;
          task_aggregate_version: number;
          repository_binding_id: string;
          repository_binding_type: "local_runner" | "github";
          repository_runner_id: string | null;
          runner_repository_id: string | null;
          source_runner_id: string | null;
          reservation_status: string;
          reservation_amount_usd: string | number;
          reservation_expires_at: Date | string;
          root_envelope: unknown;
          original_root_envelope: unknown;
          usage_cost_usd: string | number;
          usage_input_tokens: string | number;
          usage_output_tokens: string | number;
          elapsed_seconds: string | number;
          source_actions_status: string | null;
          resumed_by_user_id: string;
        }>(
          `WITH RECURSIVE command_chain(command_id,envelope,depth) AS (
             SELECT command.command_id,command.envelope,0
               FROM conversation_pause_checkpoints checkpoint
               JOIN commands command ON command.command_id=checkpoint.source_command_id
              WHERE checkpoint.pause_action_id=$1
             UNION ALL
             SELECT parent.command_id,parent.envelope,chain.depth+1
               FROM command_chain chain
               JOIN commands parent
                 ON parent.command_id=chain.envelope->'continuation'->>'root_command_id'
              WHERE chain.depth<100
           )
           SELECT checkpoint.pause_action_id,checkpoint.resume_action_id,
                  checkpoint.project_id,checkpoint.work_item_id,checkpoint.conversation_id,
                  checkpoint.phase_id,checkpoint.task_id,checkpoint.run_id,
                  checkpoint.source_command_id,checkpoint.budget_reservation_id,
                  checkpoint.published_branch,checkpoint.published_commit_sha,
                  checkpoint.root_context_refs,checkpoint.context_hash,
                  checkpoint.resume_context_ref,
                  checkpoint.resume_command_id,checkpoint.resume_job_id,
                  run.state AS run_state,run.aggregate_version AS run_aggregate_version,
                  task.state AS task_state,task.aggregate_version AS task_aggregate_version,
                  run.repository_binding_id,binding.binding_type AS repository_binding_type,
                  binding.runner_id AS repository_runner_id,
                  binding.repository_id AS runner_repository_id,
                  run.runner_id AS source_runner_id,
                  reservation.status AS reservation_status,
                  reservation.amount_usd AS reservation_amount_usd,
                  reservation.expires_at AS reservation_expires_at,
                  root.envelope AS root_envelope,original_root.envelope AS original_root_envelope,
                  GREATEST(run.usage_cost_usd,COALESCE((
                    SELECT sum(receipt.cost_usd) FROM run_command_usage_receipts receipt
                     WHERE receipt.run_id=run.id
                  ),0),COALESCE((
                    SELECT sum(usage.cost_usd) FROM usage_events usage WHERE usage.run_id=run.id
                  ),0)) AS usage_cost_usd,
                  GREATEST(run.usage_input_tokens,COALESCE((
                    SELECT sum(receipt.input_tokens) FROM run_command_usage_receipts receipt
                     WHERE receipt.run_id=run.id
                  ),0)) AS usage_input_tokens,
                  GREATEST(run.usage_output_tokens,COALESCE((
                    SELECT sum(receipt.output_tokens) FROM run_command_usage_receipts receipt
                     WHERE receipt.run_id=run.id
                  ),0)) AS usage_output_tokens,
                  COALESCE((
                    SELECT sum(receipt.active_ms)::numeric/1000
                      FROM run_command_usage_receipts receipt WHERE receipt.run_id=run.id
                  ),0) AS elapsed_seconds,
                  (
                    SELECT actions.status FROM github_actions_runs actions
                     WHERE actions.run_id=run.id
                     ORDER BY actions.created_at DESC,actions.id DESC LIMIT 1
                  ) AS source_actions_status,
                  resume.initiated_by_user_id AS resumed_by_user_id
             FROM conversation_pause_checkpoints checkpoint
             JOIN conversation_actions resume ON resume.id=checkpoint.resume_action_id
             JOIN agent_runs run ON run.id=checkpoint.run_id
             JOIN tasks task ON task.id=run.task_id
             JOIN repository_bindings binding ON binding.id=run.repository_binding_id
             JOIN budget_reservations reservation ON reservation.id=checkpoint.budget_reservation_id
             JOIN commands root ON root.command_id=checkpoint.source_command_id
             JOIN LATERAL (
               SELECT chain.envelope FROM command_chain chain
                ORDER BY chain.depth DESC LIMIT 1
             ) original_root ON true
            WHERE checkpoint.pause_action_id=$1 AND checkpoint.status='leased'
              AND checkpoint.lease_owner=$2
            FOR UPDATE OF checkpoint,run,task,reservation`,
          [pauseActionId, this.owner],
        )
      ).rows[0];
      if (!row) return null;
      if (
        row.run_state !== "waiting_for_human" ||
        row.task_state !== "blocked" ||
        row.reservation_status !== "active"
      ) {
        throw new Error("pause checkpoint run, task, or reservation is not resumable");
      }
      if (
        (row.repository_binding_type === "local_runner" && target.kind !== "local") ||
        (row.repository_binding_type === "github" && target.kind !== "actions")
      ) {
        throw new Error("pause-resume target does not match repository binding");
      }
      if (
        row.repository_binding_type === "local_runner" &&
        target.runner_id !== row.repository_runner_id
      ) {
        throw new Error("local pause resume must use the paired repository runner");
      }
      if (
        row.repository_binding_type === "github" &&
        !["completed", "failed", "abandoned"].includes(row.source_actions_status ?? "")
      ) {
        throw new Error("prior Actions execution is not terminal");
      }
      const root = V2DispatchCommand.parse(json(row.root_envelope));
      const originalRoot = V2DispatchCommand.parse(json(row.original_root_envelope));
      const rootRefs = json<unknown[]>(row.root_context_refs).map((reference) =>
        V2ContentAddressedReference.parse(reference),
      );
      const resumeRef = V2ContentAddressedReference.parse(json(row.resume_context_ref));
      if (
        root.command_id !== row.source_command_id ||
        root.run_id !== row.run_id ||
        root.budget_reservation_id !== row.budget_reservation_id ||
        canonicalJson(root.context_refs) !== canonicalJson(rootRefs) ||
        canonicalSha256(rootRefs) !== row.context_hash ||
        originalRoot.run_id !== row.run_id ||
        originalRoot.budget_reservation_id !== row.budget_reservation_id
      ) {
        throw new Error("pause checkpoint immutable command scope changed");
      }
      const remainingCharge = Math.max(
        0,
        Math.min(Number(row.reservation_amount_usd), originalRoot.max_charge_usd) -
          Number(row.usage_cost_usd),
      );
      const remainingInputTokens = Math.max(
        0,
        originalRoot.max_input_tokens - Number(row.usage_input_tokens),
      );
      const remainingOutputTokens = Math.max(
        0,
        originalRoot.max_output_tokens - Number(row.usage_output_tokens),
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
        throw new Error("pause resume has no remaining budget");
      }
      const issuedAt = new Date().toISOString();
      const expiresAt = new Date(row.reservation_expires_at).toISOString();
      if (Date.parse(expiresAt) <= Date.parse(issuedAt)) {
        throw new Error("pause resume reservation expired");
      }
      const {
        continuation: _continuation,
        runner_repository_id: _runnerRepositoryId,
        task_package_context_ref: rootTaskPackageRef,
        ...rootBase
      } = root;
      const command = V2DispatchCommand.parse({
        ...rootBase,
        dispatch_job_id: row.resume_job_id,
        command_id: v2CommandIdForDispatchJob(row.resume_job_id),
        delivery_attempt: 1,
        idempotency_key: row.resume_command_id,
        correlation_id: row.resume_action_id,
        causation_id: row.source_command_id,
        runner_id: target.runner_id,
        runner_generation: target.runner_generation,
        expected_revision: row.published_commit_sha,
        target_branch: row.published_branch,
        context_refs: [...rootRefs, resumeRef],
        ...(rootTaskPackageRef ? { task_package_context_ref: rootTaskPackageRef } : {}),
        budget_reservation_id: row.budget_reservation_id,
        max_charge_usd: remainingCharge,
        max_input_tokens: remainingInputTokens,
        max_output_tokens: remainingOutputTokens,
        max_duration_seconds: remainingDurationSeconds,
        authorized_by: { actor_type: "human", actor_id: row.resumed_by_user_id },
        authorized_by_session_id: `conversation-pause:${row.pause_action_id}`,
        issued_at: issuedAt,
        expires_at: expiresAt,
        ...(row.repository_binding_type === "local_runner" && row.runner_repository_id
          ? { runner_repository_id: row.runner_repository_id }
          : {}),
      });
      if (command.command_id !== row.resume_command_id) {
        throw new Error("pause resume command identity is not exact");
      }
      if (this.deviceAuthorization) {
        const identity = await this.deviceAuthorization.resolveDispatchTargetIdentity(tx, {
          runner_id: target.runner_id,
          generation: target.runner_generation,
        });
        await this.deviceAuthorization.assertDispatchBinding(tx, {
          ...identity,
          actor_user_id: row.resumed_by_user_id,
          project_id: row.project_id,
          repository_binding_id: row.repository_binding_id,
        });
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
          row.run_id,
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
            row.run_id,
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
          row.run_id,
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
             dispatch_job_id=EXCLUDED.dispatch_job_id,run_id=EXCLUDED.run_id,created_at=now()`,
          [target.runner_id, reference.artifact_id, command.dispatch_job_id, row.run_id],
        );
      }
      const lifecycle = new SqlV2ApplicationTransaction(tx);
      const lockedRun = await lifecycle.lockAgentRunLifecycle(row.run_id);
      if (
        !lockedRun ||
        lockedRun.state !== "waiting_for_human" ||
        lockedRun.aggregate_version !== row.run_aggregate_version
      ) {
        throw new Error("paused run could not be retargeted");
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
        run_id: row.run_id,
        expected_aggregate_version: lockedRun.aggregate_version,
        to: "dispatched",
        reason: `pause ${row.pause_action_id} resumed`,
        actor_type: "coordinator",
        actor_id: "pause-resume-continuation",
        correlation_id: row.resume_action_id,
        causation_id: row.source_command_id,
        occurred_at: issuedAt,
      });
      await transitionV2TaskLifecycle(lifecycle, {
        project_id: row.project_id,
        phase_id: row.phase_id,
        task_id: row.task_id,
        expected_aggregate_version: row.task_aggregate_version,
        to: "assigned",
        reason: `pause ${row.pause_action_id} resumed`,
        actor_type: "coordinator",
        actor_id: "pause-resume-continuation",
        correlation_id: row.resume_action_id,
        causation_id: row.source_command_id,
        occurred_at: issuedAt,
      });
      const updated = await tx.query<{ pause_action_id: string }>(
        `UPDATE conversation_pause_checkpoints
            SET status='provisioned',runner_id=$2,runner_generation=$3,
                enrollment_secret_hash=$4,
                lease_owner=NULL,lease_expires_at=NULL,last_error=NULL,updated_at=now()
          WHERE pause_action_id=$1 AND status='leased' AND lease_owner=$5
          RETURNING pause_action_id`,
        [
          row.pause_action_id,
          target.runner_id,
          target.runner_generation,
          target.enrollment_secret_hash ?? null,
          this.owner,
        ],
      );
      if (!updated.rows[0]) throw new Error("pause resume lost its fenced lease");
      return {
        pause_action_id: row.pause_action_id,
        resume_action_id: row.resume_action_id,
        command,
        target,
      };
    });
  }
}
