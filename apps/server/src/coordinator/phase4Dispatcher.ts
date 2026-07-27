import {
  V2DispatchCommand,
  type V2DispatchCommandT,
  resolveV2BudgetReservation,
} from "@norns/contracts";
import type { V2SqlExecutor, V2TransactionRunner } from "../persistence/v2/database.js";
import {
  transitionV2AgentRunLifecycle,
  transitionV2TaskLifecycle,
} from "../persistence/v2/lifecycleMutation.js";
import {
  SqlV2ApplicationTransaction,
  SqlV2BudgetTransaction,
} from "../persistence/v2/sqlRepositories.js";

export interface Phase4ClaimedDispatch {
  job_id: string;
  attempts: number;
  run_id: string;
  command: V2DispatchCommandT;
}

export interface Phase4TerminalActionsDispatch {
  job_id: string;
  error: string;
}

export class Phase4DispatchRepository {
  constructor(private readonly transactions: V2TransactionRunner) {}

  claim(owner: string, leaseMs: number): Promise<Phase4ClaimedDispatch | null> {
    return this.transactions.transaction(async (sql) => {
      const result = await sql.query<{
        id: string;
        attempts: number;
        run_id: string;
        envelope: unknown;
      }>(
        `WITH candidate AS (
           SELECT id FROM dispatch_jobs
           WHERE (status = 'queued'
                  OR (status = 'leased' AND lease_expires_at <= now()))
             AND available_at <= now()
           ORDER BY available_at, created_at, id
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         UPDATE dispatch_jobs job
         SET status = 'leased', attempts = attempts + 1, lease_owner = $1,
             lease_expires_at = now() + ($2::text || ' milliseconds')::interval,
             updated_at = now()
         FROM candidate, commands command
         WHERE job.id = candidate.id AND command.command_id = job.command_id
           AND command.kind='launch_run'
         RETURNING job.id, job.attempts, job.run_id, command.envelope`,
        [owner, leaseMs],
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        job_id: row.id,
        attempts: row.attempts,
        run_id: row.run_id,
        command: V2DispatchCommand.parse(row.envelope),
      };
    });
  }

  claimTerminalActionsContinuation(
    owner: string,
    leaseMs: number,
  ): Promise<Phase4TerminalActionsDispatch | null> {
    return this.transactions.transaction(async (sql) => {
      const row = (
        await sql.query<{
          job_id: string;
          actions_status: string;
          conclusion: string | null;
          last_error: string | null;
        }>(
          `WITH candidate AS (
             SELECT job.id,actions.status AS actions_status,
                    actions.conclusion,actions.last_error
              FROM dispatch_jobs job
               JOIN github_actions_runs actions ON actions.dispatch_job_id=job.id
              JOIN commands command ON command.command_id=job.command_id
               LEFT JOIN github_actions_execution_bindings binding
                 ON binding.repository_binding_id=actions.repository_binding_id
              WHERE job.status='awaiting_enrollment'
                AND command.kind='launch_run'
                AND (
                  actions.status IN ('completed','failed','abandoned')
                  OR binding.enabled IS NOT TRUE
                  OR command.status IN (
                    'succeeded','failed','rejected','expired','cancelled'
                  )
                  OR (
                    actions.status IN ('requested','dispatching','dispatched','enrolled')
                    AND (command.envelope->>'expires_at')::timestamptz<=now()
                  )
                )
              ORDER BY actions.completed_at,job.created_at,job.id
              FOR UPDATE OF job,actions SKIP LOCKED
              LIMIT 1
           )
           UPDATE dispatch_jobs job
              SET status='leased',attempts=attempts+1,lease_owner=$1,
                  lease_expires_at=now()+($2::text || ' milliseconds')::interval,
                  updated_at=now()
             FROM candidate
            WHERE job.id=candidate.id
          RETURNING job.id AS job_id,candidate.actions_status,
                    candidate.conclusion,candidate.last_error`,
          [owner, leaseMs],
        )
      ).rows[0];
      if (!row) return null;
      const terminalDetail = row.conclusion ?? row.last_error ?? row.actions_status;
      return {
        job_id: row.job_id,
        error: `Actions continuation ended before runner enrollment: ${terminalDetail}`,
      };
    });
  }

  pendingForRunner(runnerId: string, runnerGeneration: number): Promise<V2DispatchCommandT[]> {
    return this.transactions.transaction(async (sql) => {
      const awaiting = await sql.query<{ id: string }>(
        `SELECT job.id
           FROM dispatch_jobs job
           JOIN commands command ON command.command_id=job.command_id
           JOIN github_actions_runs actions ON actions.dispatch_job_id=job.id
         WHERE job.runner_id=$1 AND job.status='awaiting_enrollment'
            AND command.kind='launch_run'
            AND command.runner_id=$1 AND command.runner_generation=$2
            AND actions.runner_id=$1 AND actions.runner_generation=$2
            AND actions.status='enrolled'
            AND command.status='queued'
            AND (command.envelope->>'expires_at')::timestamptz>now()
          ORDER BY job.available_at,job.created_at,job.id
          FOR UPDATE OF job,actions`,
        [runnerId, runnerGeneration],
      );
      const occurredAt = new Date().toISOString();
      for (const job of awaiting.rows) {
        await this.markDeliveredInTransaction(
          sql,
          job.id,
          `runner-enrollment:${runnerId}`,
          occurredAt,
          true,
        );
      }
      const result = await sql.query<{ envelope: unknown }>(
        `SELECT command.envelope
         FROM dispatch_jobs job
         JOIN commands command ON command.command_id=job.command_id
         WHERE job.runner_id=$1 AND job.status='delivered'
           AND command.runner_id=$1 AND command.runner_generation=$2
           AND command.status NOT IN ('succeeded','failed','rejected','expired','cancelled')
         ORDER BY job.delivered_at, job.id`,
        [runnerId, runnerGeneration],
      );
      return result.rows.map((row) => V2DispatchCommand.parse(row.envelope));
    });
  }

  markDelivered(jobId: string, owner: string, occurredAt: string): Promise<void> {
    return this.transactions.transaction((sql) =>
      this.markDeliveredInTransaction(sql, jobId, owner, occurredAt, false),
    );
  }

  private async markDeliveredInTransaction(
    sql: V2SqlExecutor,
    jobId: string,
    owner: string,
    occurredAt: string,
    allowAwaitingEnrollment: boolean,
  ): Promise<void> {
    const result = await sql.query<{
      command_id: string;
      project_id: string;
      phase_id: string;
      task_id: string;
      run_id: string;
    }>(
      `UPDATE dispatch_jobs
         SET status = 'delivered', delivered_at = COALESCE(delivered_at, $3),
             lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
         WHERE id = $1
           AND (
             (status = 'leased' AND lease_owner = $2)
             OR status = 'delivered'
             OR ($4::boolean AND status = 'awaiting_enrollment')
           )
         RETURNING command_id, project_id, phase_id, task_id, run_id`,
      [jobId, owner, occurredAt, allowAwaitingEnrollment],
    );
    const job = result.rows[0];
    if (!job) throw new Error(`dispatch job ${jobId} is not leased by ${owner}`);
    await sql.query(
      `UPDATE commands SET status = 'dispatched', updated_at = now()
         WHERE command_id = $1 AND status IN ('queued','dispatched')`,
      [job.command_id],
    );
    const continuation = (
      await sql.query<{
        continuation_id: string;
        action_id: string;
        project_id: string;
        work_item_id: string;
        conversation_id: string;
      }>(
        `UPDATE human_wait_continuations continuation
              SET status='dispatched',updated_at=now()
             FROM human_waits wait,human_wait_answers answer
            WHERE continuation.resume_command_id=$1
              AND continuation.status='provisioned'
              AND wait.id=continuation.wait_id
              AND answer.id=continuation.answer_id
          RETURNING continuation.id AS continuation_id,answer.action_id,
                    wait.project_id,wait.work_item_id,wait.conversation_id`,
        [job.command_id],
      )
    ).rows[0];
    if (continuation) {
      const sentAction = await sql.query<{ id: string }>(
        `UPDATE conversation_actions
              SET status='sent',sent_at=COALESCE(sent_at,$2),updated_at=now()
            WHERE id=$1 AND status='recorded'
            RETURNING id`,
        [continuation.action_id, occurredAt],
      );
      if (!sentAction.rows[0]) {
        throw new Error(`continuation action ${continuation.action_id} was not recordable as sent`);
      }
      await sql.query(
        `INSERT INTO conversation_action_delivery_events (
             id,project_id,work_item_id,conversation_id,action_id,sequence,status,
             delivery_mode,target_run_id,target_command_id,receipt,occurred_at
           ) VALUES ($1,$2,$3,$4,$5,3,'sent','continuation',$6,$7,$8::jsonb,$9)`,
        [
          `action-delivery-event:${continuation.action_id}:3`,
          continuation.project_id,
          continuation.work_item_id,
          continuation.conversation_id,
          continuation.action_id,
          job.run_id,
          job.command_id,
          JSON.stringify({ kind: "sent", outbox_id: jobId }),
          occurredAt,
        ],
      );
    }
    const pauseResume = (
      await sql.query<{
        pause_action_id: string;
        resume_action_id: string;
        project_id: string;
        work_item_id: string;
        conversation_id: string;
        intent_id: string;
      }>(
        `UPDATE conversation_pause_checkpoints checkpoint
              SET status='dispatched',updated_at=now()
             FROM conversation_actions action,
                  conversation_action_delivery_intents intent
            WHERE checkpoint.resume_command_id=$1
              AND checkpoint.status='provisioned'
              AND action.id=checkpoint.resume_action_id
              AND intent.action_id=action.id
          RETURNING checkpoint.pause_action_id,checkpoint.resume_action_id,
                    checkpoint.project_id,checkpoint.work_item_id,
                    checkpoint.conversation_id,intent.id AS intent_id`,
        [job.command_id],
      )
    ).rows[0];
    if (pauseResume) {
      await sql.query(
        `UPDATE conversation_action_delivery_intents
              SET status='leased',lease_owner='pause-resume-dispatch',
                  lease_expires_at=now()+interval '30 seconds',attempts=attempts+1,
                  updated_at=now()
            WHERE id=$1 AND status='fallback_queued'`,
        [pauseResume.intent_id],
      );
      const sentIntent = await sql.query<{ id: string }>(
        `UPDATE conversation_action_delivery_intents
              SET status='sent',target_command_id=$2,
                  target_runner_generation=(
                    SELECT runner_generation FROM commands WHERE command_id=$2
                  ),
                  lease_owner=NULL,lease_expires_at=NULL,last_error=NULL,updated_at=now()
            WHERE id=$1 AND status='leased' AND lease_owner='pause-resume-dispatch'
            RETURNING id`,
        [pauseResume.intent_id, job.command_id],
      );
      const sentAction = await sql.query<{ id: string }>(
        `UPDATE conversation_actions
              SET status='sent',sent_at=COALESCE(sent_at,$2),updated_at=now()
            WHERE id=$1 AND status='recorded'
            RETURNING id`,
        [pauseResume.resume_action_id, occurredAt],
      );
      if (!sentIntent.rows[0] || !sentAction.rows[0]) {
        throw new Error("pause-resume dispatch lost its recorded action or intent");
      }
      await sql.query(
        `INSERT INTO conversation_action_delivery_events (
             id,project_id,work_item_id,conversation_id,action_id,sequence,status,
             delivery_mode,target_run_id,target_command_id,receipt,occurred_at
           ) SELECT $1,$2,$3,$4,$5,COALESCE(max(sequence),0)+1,
                    'sent','continuation',$6,$7,$8::jsonb,$9
               FROM conversation_action_delivery_events WHERE action_id=$5`,
        [
          `action-delivery-event:${pauseResume.resume_action_id}:sent:${job.command_id}`,
          pauseResume.project_id,
          pauseResume.work_item_id,
          pauseResume.conversation_id,
          pauseResume.resume_action_id,
          job.run_id,
          job.command_id,
          JSON.stringify({ kind: "sent", outbox_id: jobId }),
          occurredAt,
        ],
      );
    }
    const lifecycle = new SqlV2ApplicationTransaction(sql);
    const run = await lifecycle.lockAgentRunLifecycle(job.run_id);
    if (run?.state === "created") {
      await transitionV2AgentRunLifecycle(lifecycle, {
        project_id: job.project_id,
        phase_id: job.phase_id,
        task_id: job.task_id,
        run_id: job.run_id,
        expected_aggregate_version: run.aggregate_version,
        to: "dispatched",
        reason: `dispatch job ${jobId} delivered`,
        actor_type: "coordinator",
        actor_id: owner,
        correlation_id: job.command_id,
        causation_id: jobId,
        occurred_at: occurredAt,
      });
    }
  }

  retry(jobId: string, owner: string, error: string, retryDelayMs: number): Promise<void> {
    return this.transactions.transaction(async (sql) => {
      const result = await sql.query(
        `UPDATE dispatch_jobs
         SET status = 'queued', available_at = now() + ($4::text || ' milliseconds')::interval,
             lease_owner = NULL, lease_expires_at = NULL, last_error = $3, updated_at = now()
         WHERE id = $1 AND status = 'leased' AND lease_owner = $2`,
        [jobId, owner, error.slice(0, 2_000), retryDelayMs],
      );
      if ((result.affectedRows ?? result.rows.length) !== 1) {
        throw new Error(`dispatch job ${jobId} retry lost its lease`);
      }
    });
  }

  deadLetter(jobId: string, owner: string, error: string, occurredAt: string): Promise<void> {
    return this.transactions.transaction(async (sql) => {
      const result = await sql.query<{
        project_id: string;
        phase_id: string;
        task_id: string;
        run_id: string;
        command_id: string;
      }>(
        `UPDATE dispatch_jobs
         SET status='dead_letter', lease_owner=NULL, lease_expires_at=NULL,
             last_error=$3, completed_at=$4, updated_at=now()
         WHERE id=$1 AND status='leased' AND lease_owner=$2
         RETURNING project_id, phase_id, task_id, run_id, command_id`,
        [jobId, owner, error.slice(0, 2_000), occurredAt],
      );
      const job = result.rows[0];
      if (!job) throw new Error(`dispatch job ${jobId} dead-letter lost its lease`);
      await sql.query("UPDATE commands SET status='failed', updated_at=now() WHERE command_id=$1", [
        job.command_id,
      ]);
      await sql.query(
        `UPDATE github_actions_runs
            SET status=CASE
                  WHEN status='completed' THEN status
                  WHEN status='failed' THEN status
                  ELSE 'abandoned'
                END,
                conclusion=COALESCE(conclusion,'runner_never_enrolled'),
                last_error=COALESCE(last_error,$2),
                completed_at=COALESCE(completed_at,$3),
                launch_lease_owner=NULL,
                launch_lease_expires_at=NULL,
                reconcile_lease_owner=NULL,
                reconcile_lease_expires_at=NULL,
                updated_at=now()
          WHERE dispatch_job_id=$1
            AND status IN (
              'requested','dispatching','dispatched','enrolled',
              'completed','failed','abandoned'
            )`,
        [jobId, error.slice(0, 2_000), occurredAt],
      );
      const failedContinuation = (
        await sql.query<{
          continuation_id: string;
          wait_id: string;
          action_id: string;
          project_id: string;
          work_item_id: string;
          conversation_id: string;
        }>(
          `UPDATE human_wait_continuations continuation
              SET status='failed',last_error=$2,
                  lease_owner=NULL,lease_expires_at=NULL,updated_at=now()
             FROM human_wait_answers answer,human_waits wait
            WHERE continuation.resume_job_id=$1
              AND continuation.status IN (
                'leased','provisioned','dispatched','acknowledged'
              )
              AND answer.id=continuation.answer_id
              AND wait.id=continuation.wait_id
          RETURNING continuation.id AS continuation_id,continuation.wait_id,
                    answer.action_id,wait.project_id,wait.work_item_id,
                    wait.conversation_id`,
          [jobId, error.slice(0, 2_000)],
        )
      ).rows[0];
      if (failedContinuation) {
        await sql.query(
          `UPDATE human_waits
              SET status='failed',version=version+1,updated_at=now()
            WHERE id=$1 AND status IN ('answered','continuation_queued')`,
          [failedContinuation.wait_id],
        );
        await this.failConversationAction(
          sql,
          failedContinuation,
          job,
          "actions_continuation_never_enrolled",
          error,
          occurredAt,
        );
      }
      const failedPause = (
        await sql.query<{
          pause_action_id: string;
          action_id: string;
          project_id: string;
          work_item_id: string;
          conversation_id: string;
        }>(
          `UPDATE conversation_pause_checkpoints checkpoint
              SET status='failed',last_error=$2,
                  lease_owner=NULL,lease_expires_at=NULL,updated_at=now()
            WHERE checkpoint.resume_job_id=$1
              AND checkpoint.status IN ('leased','provisioned','dispatched')
          RETURNING checkpoint.pause_action_id,
                    checkpoint.resume_action_id AS action_id,
                    checkpoint.project_id,checkpoint.work_item_id,
                    checkpoint.conversation_id`,
          [jobId, error.slice(0, 2_000)],
        )
      ).rows[0];
      if (failedPause?.action_id) {
        await this.failConversationAction(
          sql,
          failedPause,
          job,
          "actions_pause_resume_never_enrolled",
          error,
          occurredAt,
        );
      }
      const lifecycle = new SqlV2ApplicationTransaction(sql);
      const run = await lifecycle.lockAgentRunLifecycle(job.run_id);
      if (run && (run.state === "created" || run.state === "dispatched")) {
        await transitionV2AgentRunLifecycle(lifecycle, {
          project_id: job.project_id,
          phase_id: job.phase_id,
          task_id: job.task_id,
          run_id: job.run_id,
          expected_aggregate_version: run.aggregate_version,
          to: "expired",
          reason: `dispatch job ${jobId} exhausted delivery attempts`,
          actor_type: "coordinator",
          actor_id: owner,
          correlation_id: job.command_id,
          causation_id: jobId,
          occurred_at: occurredAt,
        });
      }
      const task = await lifecycle.lockTaskLifecycle(job.task_id);
      if (task && !["completed", "failed", "cancelled"].includes(task.state)) {
        await transitionV2TaskLifecycle(lifecycle, {
          project_id: job.project_id,
          phase_id: job.phase_id,
          task_id: job.task_id,
          expected_aggregate_version: task.aggregate_version,
          to: "blocked",
          reason: `dispatch job ${jobId} dead-lettered`,
          actor_type: "coordinator",
          actor_id: owner,
          correlation_id: job.command_id,
          causation_id: jobId,
          occurred_at: occurredAt,
        });
      }
      const usage = (
        await sql.query<{ attributable_usage_usd: string | number }>(
          `SELECT GREATEST(
                    run.usage_cost_usd,
                    COALESCE((
                      SELECT sum(receipt.cost_usd)
                        FROM run_command_usage_receipts receipt
                       WHERE receipt.run_id=run.id
                    ),0),
                    COALESCE((
                      SELECT sum(event.cost_usd)
                        FROM usage_events event
                       WHERE event.run_id=run.id
                    ),0)
                  ) AS attributable_usage_usd
             FROM agent_runs run
            WHERE run.id=$1`,
          [job.run_id],
        )
      ).rows[0];
      const budget = new SqlV2BudgetTransaction(sql);
      const reservation = await budget.lockReservation(`budget-reservation:${job.run_id}`);
      if (reservation?.status === "active") {
        const attributableUsage = Math.min(
          reservation.amount_usd,
          Math.max(0, Number(usage?.attributable_usage_usd ?? 0)),
        );
        const request = {
          reservation_id: reservation.id,
          expected_version: reservation.version,
          outcome: attributableUsage > 0 ? ("partial_usage" as const) : ("dead_letter" as const),
          attributable_usage_usd: attributableUsage,
          reason: `dispatch job ${jobId} exhausted delivery attempts`,
          actor_type: "coordinator" as const,
          actor_id: owner,
          correlation_id: job.command_id,
          causation_id: jobId,
          occurred_at: occurredAt,
        };
        await budget.applyResolution(
          reservation,
          request,
          resolveV2BudgetReservation(reservation.amount_usd, request),
        );
      }
    });
  }

  private async failConversationAction(
    sql: V2SqlExecutor,
    scope: {
      action_id: string;
      project_id: string;
      work_item_id: string;
      conversation_id: string;
    },
    job: {
      run_id: string;
      command_id: string;
    },
    failureCode: string,
    detail: string,
    occurredAt: string,
  ): Promise<void> {
    const action = await sql.query<{ id: string }>(
      `UPDATE conversation_actions
          SET status='failed',failure_code=$2,updated_at=now()
        WHERE id=$1 AND status IN ('confirmed','recorded','sent','agent_acknowledged')
        RETURNING id`,
      [scope.action_id, failureCode],
    );
    await sql.query(
      `UPDATE conversation_action_delivery_intents
          SET status='failed',last_error=$2,
              lease_owner=NULL,lease_expires_at=NULL,updated_at=now()
        WHERE action_id=$1
          AND status IN ('leased','sent','acknowledged','fallback_queued')`,
      [scope.action_id, detail.slice(0, 2_000)],
    );
    if (!action.rows[0]) return;
    await sql.query(
      `INSERT INTO conversation_action_delivery_events (
         id,project_id,work_item_id,conversation_id,action_id,sequence,status,
         delivery_mode,target_run_id,target_command_id,receipt,occurred_at
       ) SELECT $1,$2,$3,$4,$5,COALESCE(max(sequence),0)+1,
                'failed','continuation',$6,$7,$8::jsonb,$9
           FROM conversation_action_delivery_events WHERE action_id=$5`,
      [
        `action-delivery-event:${scope.action_id}:failed:${job.command_id}`,
        scope.project_id,
        scope.work_item_id,
        scope.conversation_id,
        scope.action_id,
        job.run_id,
        job.command_id,
        JSON.stringify({ kind: "failed", failure_code: failureCode }),
        occurredAt,
      ],
    );
  }
}

export class Phase4Dispatcher {
  constructor(
    private readonly repository: Phase4DispatchRepository,
    private readonly owner: string,
    private readonly deliver: (command: V2DispatchCommandT) => Promise<void>,
    private readonly options: {
      lease_ms?: number;
      retry_delay_ms?: number;
      max_attempts?: number;
      now?: () => Date;
    } = {},
  ) {}

  async tick(): Promise<boolean> {
    const terminal = await this.repository.claimTerminalActionsContinuation(
      this.owner,
      this.options.lease_ms ?? 30_000,
    );
    if (terminal) {
      await this.repository.deadLetter(
        terminal.job_id,
        this.owner,
        terminal.error,
        (this.options.now ?? (() => new Date()))().toISOString(),
      );
      return true;
    }
    const claimed = await this.repository.claim(this.owner, this.options.lease_ms ?? 30_000);
    if (!claimed) return false;
    try {
      await this.deliver(claimed.command);
      await this.repository.markDelivered(
        claimed.job_id,
        this.owner,
        (this.options.now ?? (() => new Date()))().toISOString(),
      );
      return true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (claimed.attempts >= (this.options.max_attempts ?? 5)) {
        await this.repository.deadLetter(
          claimed.job_id,
          this.owner,
          detail,
          (this.options.now ?? (() => new Date()))().toISOString(),
        );
      } else {
        await this.repository.retry(
          claimed.job_id,
          this.owner,
          detail,
          this.options.retry_delay_ms ?? 1_000,
        );
      }
      return false;
    }
  }
}
