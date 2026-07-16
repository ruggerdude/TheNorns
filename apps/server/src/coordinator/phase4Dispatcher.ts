import { V2DispatchCommand, type V2DispatchCommandT } from "@norns/contracts";
import type { V2TransactionRunner } from "../persistence/v2/database.js";
import { transitionV2AgentRunLifecycle } from "../persistence/v2/lifecycleMutation.js";
import { SqlV2ApplicationTransaction } from "../persistence/v2/sqlRepositories.js";

export interface Phase4ClaimedDispatch {
  job_id: string;
  attempts: number;
  run_id: string;
  command: V2DispatchCommandT;
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

  markDelivered(jobId: string, owner: string, occurredAt: string): Promise<void> {
    return this.transactions.transaction(async (sql) => {
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
         WHERE id = $1 AND ((status = 'leased' AND lease_owner = $2) OR status = 'delivered')
         RETURNING command_id, project_id, phase_id, task_id, run_id`,
        [jobId, owner, occurredAt],
      );
      const job = result.rows[0];
      if (!job) throw new Error(`dispatch job ${jobId} is not leased by ${owner}`);
      await sql.query(
        `UPDATE commands SET status = 'dispatched', updated_at = now()
         WHERE command_id = $1 AND status IN ('queued','dispatched')`,
        [job.command_id],
      );
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
    });
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
}

export class Phase4Dispatcher {
  constructor(
    private readonly repository: Phase4DispatchRepository,
    private readonly owner: string,
    private readonly deliver: (command: V2DispatchCommandT) => Promise<void>,
    private readonly options: { lease_ms?: number; retry_delay_ms?: number; now?: () => Date } = {},
  ) {}

  async tick(): Promise<boolean> {
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
      await this.repository.retry(
        claimed.job_id,
        this.owner,
        error instanceof Error ? error.message : String(error),
        this.options.retry_delay_ms ?? 1_000,
      );
      return false;
    }
  }
}
