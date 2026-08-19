import type { SendEmailInput } from "../email/resend.js";
import type { V2TransactionRunner } from "../persistence/v2/database.js";

export interface BuildFailureEmailPreference {
  enabled: boolean;
  email: string;
  delivery_configured: boolean;
}

export class BuildFailureEmailPreferenceNotFoundError extends Error {
  constructor() {
    super("project or user not found");
    this.name = "BuildFailureEmailPreferenceNotFoundError";
  }
}

export class BuildFailureEmailPreferences {
  constructor(
    private readonly transactions: V2TransactionRunner,
    private readonly deliveryConfigured: boolean,
  ) {}

  get(projectId: string, userId: string): Promise<BuildFailureEmailPreference> {
    return this.transactions.transaction(async (sql) => {
      const result = await sql.query<{ email: string; enabled: boolean | null }>(
        `SELECT identity.email, subscription.enabled
           FROM projects project
           JOIN users identity ON identity.id=$2
           LEFT JOIN build_failure_email_subscriptions subscription
             ON subscription.project_id=project.id
            AND subscription.user_id=identity.id
          WHERE project.id=$1`,
        [projectId, userId],
      );
      const row = result.rows[0];
      if (!row) throw new BuildFailureEmailPreferenceNotFoundError();
      return {
        enabled: row.enabled ?? false,
        email: row.email,
        delivery_configured: this.deliveryConfigured,
      };
    });
  }

  set(projectId: string, userId: string, enabled: boolean): Promise<BuildFailureEmailPreference> {
    return this.transactions.transaction(async (sql) => {
      const exists = await sql.query<{ email: string }>(
        `SELECT identity.email
           FROM projects project
           JOIN users identity ON identity.id=$2
          WHERE project.id=$1`,
        [projectId, userId],
      );
      const identity = exists.rows[0];
      if (!identity) throw new BuildFailureEmailPreferenceNotFoundError();

      await sql.query(
        `INSERT INTO build_failure_email_subscriptions (
           project_id,user_id,enabled,enabled_at,created_at,updated_at
         ) VALUES ($1,$2,$3,CASE WHEN $3 THEN now() ELSE NULL END,now(),now())
         ON CONFLICT (project_id,user_id) DO UPDATE
         SET enabled=EXCLUDED.enabled,
             enabled_at=CASE
               WHEN EXCLUDED.enabled AND NOT build_failure_email_subscriptions.enabled THEN now()
               WHEN EXCLUDED.enabled THEN build_failure_email_subscriptions.enabled_at
               ELSE NULL
             END,
             updated_at=now()`,
        [projectId, userId, enabled],
      );
      return {
        enabled,
        email: identity.email,
        delivery_configured: this.deliveryConfigured,
      };
    });
  }
}

interface ClaimedFailureEmail {
  run_id: string;
  user_id: string;
  recipient_email: string;
  project_id: string;
  project_name: string;
  phase_name: string;
  task_name: string;
  attempt: number;
  failure_code: string | null;
  failure_detail: string | null;
}

export interface BuildFailureEmailWorkerOptions {
  send: (input: SendEmailInput) => Promise<void>;
  publicOrigin: string;
  maxAttempts?: number;
  batchSize?: number;
}

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

function emailFor(candidate: ClaimedFailureEmail, publicOrigin: string): SendEmailInput {
  const projectUrl = new URL(`/projects/${encodeURIComponent(candidate.project_id)}`, publicOrigin);
  const detail =
    candidate.failure_detail ?? candidate.failure_code ?? "No failure detail was recorded.";
  return {
    to: candidate.recipient_email,
    subject: `[The Norns] Build failed: ${candidate.task_name}`,
    html: `<p>A development attempt stopped before it finished.</p><p><strong>Project:</strong> ${escapeHtml(candidate.project_name)}<br><strong>Phase:</strong> ${escapeHtml(candidate.phase_name)}<br><strong>Task:</strong> ${escapeHtml(candidate.task_name)}<br><strong>Attempt:</strong> ${candidate.attempt}</p><p><strong>Failure:</strong> ${escapeHtml(detail)}</p><p><a href="${escapeHtml(projectUrl.toString())}">Open the project in The Norns</a></p>`,
  };
}

export class BuildFailureEmailWorker {
  private readonly maxAttempts: number;
  private readonly batchSize: number;

  constructor(
    private readonly transactions: V2TransactionRunner,
    private readonly options: BuildFailureEmailWorkerOptions,
  ) {
    this.maxAttempts = options.maxAttempts ?? 5;
    this.batchSize = options.batchSize ?? 20;
  }

  async tick(): Promise<number> {
    await this.enqueueEligibleFailures();
    let delivered = 0;
    for (let index = 0; index < this.batchSize; index += 1) {
      const candidate = await this.claimNext();
      if (!candidate) break;
      try {
        await this.options.send(emailFor(candidate, this.options.publicOrigin));
        await this.markSent(candidate.run_id, candidate.user_id);
        delivered += 1;
      } catch (error) {
        await this.markFailed(candidate.run_id, candidate.user_id, error);
      }
    }
    return delivered;
  }

  private enqueueEligibleFailures(): Promise<void> {
    return this.transactions.transaction(async (sql) => {
      await sql.query(
        `INSERT INTO build_failure_email_deliveries (
           run_id,user_id,project_id,status,attempt_count,next_attempt_at,
           created_at,updated_at
         )
         SELECT run.id,subscription.user_id,run.project_id,'pending',0,now(),now(),now()
           FROM agent_runs run
           JOIN tasks task
             ON task.project_id=run.project_id
            AND task.phase_id=run.phase_id
            AND task.id=run.task_id
            AND task.designated_run_id=run.id
           JOIN build_failure_email_subscriptions subscription
             ON subscription.project_id=run.project_id
            AND subscription.enabled
           JOIN users identity
             ON identity.id=subscription.user_id
            AND identity.status='active'
           JOIN projects project ON project.id=run.project_id
          WHERE run.state='failed'
            AND run.finished_at IS NOT NULL
            AND run.finished_at >= subscription.enabled_at
            AND (
              identity.role='admin'
              OR project.owner_user_id=subscription.user_id
              OR EXISTS (
                SELECT 1
                  FROM project_members membership
                 WHERE membership.project_id=run.project_id
                   AND membership.user_id=subscription.user_id
                   AND membership.status='active'
              )
            )
         ON CONFLICT (run_id,user_id) DO NOTHING`,
      );
    });
  }

  private claimNext(): Promise<ClaimedFailureEmail | null> {
    return this.transactions.transaction(async (sql) => {
      const selected = await sql.query<{ run_id: string; user_id: string }>(
        `SELECT delivery.run_id,delivery.user_id
           FROM build_failure_email_deliveries delivery
          WHERE delivery.status IN ('pending','failed')
            AND delivery.next_attempt_at <= now()
            AND delivery.attempt_count < $1
          ORDER BY delivery.next_attempt_at,delivery.created_at,delivery.run_id,delivery.user_id
          LIMIT 1
          FOR UPDATE OF delivery SKIP LOCKED`,
        [this.maxAttempts],
      );
      const key = selected.rows[0];
      if (!key) return null;

      const claimed = await sql.query<ClaimedFailureEmail>(
        `UPDATE build_failure_email_deliveries delivery
            SET status='sending',attempt_count=attempt_count+1,last_error=NULL,updated_at=now()
           FROM agent_runs run
           JOIN users identity ON identity.id=$2
           JOIN projects project ON project.id=run.project_id
           JOIN phases phase ON phase.id=run.phase_id AND phase.project_id=run.project_id
           JOIN tasks task
             ON task.id=run.task_id
            AND task.phase_id=run.phase_id
            AND task.project_id=run.project_id
          WHERE delivery.run_id=$1
            AND delivery.user_id=$2
            AND run.id=delivery.run_id
         RETURNING delivery.run_id,delivery.user_id,identity.email AS recipient_email,
                   run.project_id,project.name AS project_name,
                   phase.objective_summary AS phase_name,task.title AS task_name,
                   run.attempt,run.failure_code,run.failure_detail`,
        [key.run_id, key.user_id],
      );
      return claimed.rows[0] ?? null;
    });
  }

  private markSent(runId: string, userId: string): Promise<void> {
    return this.transactions.transaction(async (sql) => {
      await sql.query(
        `UPDATE build_failure_email_deliveries
            SET status='sent',sent_at=now(),last_error=NULL,updated_at=now()
          WHERE run_id=$1 AND user_id=$2 AND status='sending'`,
        [runId, userId],
      );
    });
  }

  private markFailed(runId: string, userId: string, error: unknown): Promise<void> {
    const detail = (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
    return this.transactions.transaction(async (sql) => {
      await sql.query(
        `UPDATE build_failure_email_deliveries
            SET status='failed',last_error=$3,
                next_attempt_at=now() + interval '5 minutes',updated_at=now()
          WHERE run_id=$1 AND user_id=$2 AND status='sending'`,
        [runId, userId, detail],
      );
    });
  }
}
