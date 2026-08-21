import { createHash } from "node:crypto";
import { CommandEnvelope, type CommandEnvelopeT } from "@norns/contracts";
import type { V2TransactionRunner } from "../persistence/v2/database.js";

const MAX_COLLECTION_ATTEMPTS = 3;

export interface EligibleCollection {
  project_id: string;
  work_item_id: string;
  conversation_id: string;
  phase_id: string;
  task_id: string;
  run_id: string;
  approved_mockup_version_id: string;
  repository_binding_id: string;
  verification_result_id: string;
  deployment_record_id: string;
  deployment_observation_id: string;
  commit_sha: string;
}

interface ClaimedCollection extends EligibleCollection {
  id: string;
  attempts: number;
  lease_owner: string;
}

function stableId(prefix: string, values: unknown[]): string {
  return `${prefix}_${createHash("sha256")
    .update(JSON.stringify(values))
    .digest("hex")
    .slice(0, 32)}`;
}

export interface VisualEvidenceCollectionTarget {
  repository_binding_id: string;
  runner_id: string;
  runner_generation: number;
}

export interface Phase6VisualEvidenceCollectionWorkerOptions {
  prepareTarget: (
    collection: EligibleCollection & { id: string },
  ) => Promise<VisualEvidenceCollectionTarget>;
  launch: (input: {
    project_id: string;
    repository_binding_id: string;
    dispatch_job_id: string;
    run_id: string;
    runner_id: string;
    runner_generation: number;
  }) => Promise<void>;
  enqueue: (command: CommandEnvelopeT) => boolean;
  notify?: (runnerId: string) => void;
  clock?: () => Date;
  workerId?: string;
}

/**
 * Durable post-deployment continuation. It discovers exact eligible tuples,
 * provisions a new ephemeral runner, and delivers one idempotent collection
 * command. The runner upload completes the collection in the same transaction
 * as immutable visual evidence.
 */
export class Phase6VisualEvidenceCollectionWorker {
  private readonly workerId: string;
  private readonly clock: () => Date;

  constructor(
    private readonly transactions: V2TransactionRunner,
    private readonly options: Phase6VisualEvidenceCollectionWorkerOptions,
  ) {
    this.workerId = options.workerId ?? `phase6-visual:${process.pid}`;
    this.clock = options.clock ?? (() => new Date());
  }

  async tick(): Promise<boolean> {
    await this.seedOne();
    await this.failTerminalRunner();
    if (await this.deliverEnrolled()) return true;
    const claimed = await this.claim();
    if (!claimed) {
      await this.relaunchAwaiting();
      return false;
    }
    try {
      const target = await this.options.prepareTarget(claimed);
      if (target.repository_binding_id !== claimed.repository_binding_id) {
        throw new Error("visual evidence target changed repository binding");
      }
      const command = await this.provision(claimed, target);
      await this.options.launch({
        project_id: claimed.project_id,
        repository_binding_id: claimed.repository_binding_id,
        dispatch_job_id:
          command.payload.kind === "collect_visual_evidence"
            ? stableId("visual-dispatch", [claimed.id])
            : "",
        run_id: claimed.run_id,
        runner_id: target.runner_id,
        runner_generation: target.runner_generation,
      });
      return true;
    } catch (error) {
      await this.releaseClaim(
        claimed,
        error instanceof Error ? error.message : "visual evidence provisioning failed",
      );
      return true;
    }
  }

  private async seedOne(): Promise<void> {
    await this.transactions.transaction(async (tx) => {
      const candidate = (
        await tx.query<EligibleCollection>(
          `SELECT run.project_id,supplement.work_item_id,supplement.conversation_id,
                  run.phase_id,run.task_id,run.id AS run_id,
                  version.id AS approved_mockup_version_id,
                  run.repository_binding_id,verification.id AS verification_result_id,
                  delivery.id AS deployment_record_id,
                  observation.id AS deployment_observation_id,
                  run.published_commit_sha AS commit_sha
             FROM agent_runs run
             JOIN conversation_task_package_supplements supplement
               ON supplement.project_id=run.project_id AND supplement.task_id=run.task_id
              AND supplement.supplement ? 'implementation_visual_evidence_requirement'
              AND supplement.supplement#>>'{implementation_visual_evidence_requirement,approved_mockup_version_id}'
                    =supplement.source_mockup_version_id
             JOIN conversation_mockup_versions version
               ON version.id=supplement.source_mockup_version_id
             JOIN conversation_mockup_decisions decision
               ON decision.mockup_version_id=version.id AND decision.decision='approved'
             JOIN LATERAL (
               SELECT result.id
                 FROM verification_results result
                WHERE result.project_id=run.project_id
                  AND result.phase_id=run.phase_id AND result.task_id=run.task_id
                  AND result.run_id=run.id
                  AND result.repository_binding_id=run.repository_binding_id
                  AND result.commit_sha=run.published_commit_sha AND result.passed=true
                ORDER BY result.created_at DESC,result.id DESC LIMIT 1
             ) verification ON true
             JOIN LATERAL (
               SELECT record.*
                 FROM project_delivery_records record
                WHERE record.project_id=run.project_id
                  AND record.phase_id=run.phase_id AND record.task_id=run.task_id
                  AND record.run_id=run.id
                  AND record.repository_binding_id=run.repository_binding_id
                  AND record.commit_sha=run.published_commit_sha
                  AND record.status='succeeded'
                ORDER BY record.completed_at DESC,record.id DESC LIMIT 1
             ) delivery ON true
             JOIN project_delivery_observations observation
               ON observation.project_id=delivery.project_id
              AND observation.delivery_record_id=delivery.id
              AND observation.sequence=delivery.current_observation_sequence
              AND observation.status='succeeded'
            WHERE run.publication_outcome='pushed'
              AND run.published_commit_sha IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM implementation_visual_evidence evidence
                 WHERE evidence.run_id=run.id
                   AND evidence.approved_mockup_version_id=version.id
              )
              AND NOT EXISTS (
                SELECT 1 FROM implementation_visual_evidence_collections collection
                 WHERE collection.run_id=run.id
                   AND collection.approved_mockup_version_id=version.id
              )
            ORDER BY delivery.completed_at,run.id,version.id
            -- Lock only the run. A row lock needs UPDATE privilege on every
            -- locked table, and the runtime role has only SELECT/INSERT on the
            -- mockup and observation tables, so locking them fails with 42501
            -- on every tick once an eligible row exists. Serializing on the
            -- run is enough: the INSERT below is idempotent (ON CONFLICT).
            FOR SHARE OF run
            LIMIT 1`,
        )
      ).rows[0];
      if (!candidate) return;
      await tx.query(
        `INSERT INTO implementation_visual_evidence_collections (
           id,project_id,work_item_id,conversation_id,phase_id,task_id,run_id,
           approved_mockup_version_id,repository_binding_id,
           verification_result_id,deployment_record_id,deployment_observation_id,
           commit_sha
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT(run_id,approved_mockup_version_id) DO NOTHING`,
        [
          stableId("visual-collection", [
            candidate.project_id,
            candidate.run_id,
            candidate.approved_mockup_version_id,
          ]),
          candidate.project_id,
          candidate.work_item_id,
          candidate.conversation_id,
          candidate.phase_id,
          candidate.task_id,
          candidate.run_id,
          candidate.approved_mockup_version_id,
          candidate.repository_binding_id,
          candidate.verification_result_id,
          candidate.deployment_record_id,
          candidate.deployment_observation_id,
          candidate.commit_sha,
        ],
      );
    });
  }

  private async claim(): Promise<ClaimedCollection | null> {
    return this.transactions.transaction(async (tx) => {
      await tx.query(
        `UPDATE implementation_visual_evidence_collections
            SET status='queued',lease_owner=NULL,lease_expires_at=NULL,
                available_at=now(),last_error='recovered_expired_collection_lease',
                updated_at=now()
          WHERE status='leased' AND lease_expires_at<=now()`,
      );
      const leaseOwner = `${this.workerId}:${stableId("lease", [
        this.clock().toISOString(),
        Math.random(),
      ])}`;
      const row = (
        await tx.query<ClaimedCollection>(
          `WITH candidate AS (
             SELECT id
               FROM implementation_visual_evidence_collections
              WHERE status='queued' AND available_at<=now()
              ORDER BY available_at,created_at,id
              FOR UPDATE SKIP LOCKED LIMIT 1
           )
           UPDATE implementation_visual_evidence_collections collection
              SET status='leased',lease_owner=$1,
                  lease_expires_at=now()+interval '2 minutes',
                  attempts=attempts+1,last_error=NULL,updated_at=now()
             FROM candidate WHERE collection.id=candidate.id
           RETURNING collection.*`,
          [leaseOwner],
        )
      ).rows[0];
      return row ? { ...row, attempts: Number(row.attempts), lease_owner: leaseOwner } : null;
    });
  }

  private provision(
    collection: ClaimedCollection,
    target: VisualEvidenceCollectionTarget,
  ): Promise<CommandEnvelopeT> {
    return this.transactions.transaction(async (tx) => {
      const dispatchJobId = stableId("visual-dispatch", [collection.id]);
      const commandId = stableId("visual-command", [collection.id]);
      const issuedAt = this.clock();
      const binding = (
        await tx.query<{ binding_type: string; repository_id: string }>(
          `SELECT binding_type,repository_id
             FROM repository_bindings
            WHERE id=$1
              AND project_id=$2
              AND status IN ('connected','degraded','disconnected')
            FOR UPDATE`,
          [collection.repository_binding_id, collection.project_id],
        )
      ).rows[0];
      if (!binding) throw new Error("visual evidence repository binding is no longer available");
      const command = CommandEnvelope.parse({
        protocol: 1,
        command_id: commandId,
        idempotency_key: commandId,
        correlation_id: collection.id,
        causation_id: collection.deployment_observation_id,
        project_id: collection.project_id,
        runner_id: target.runner_id,
        generation: target.runner_generation,
        issued_by_session: `phase6:visual-evidence:${collection.id}`,
        issued_at: issuedAt.toISOString(),
        expires_at: new Date(issuedAt.getTime() + 2 * 60 * 60 * 1_000).toISOString(),
        payload: {
          kind: "collect_visual_evidence",
          collection_id: collection.id,
          project_id: collection.project_id,
          work_item_id: collection.work_item_id,
          conversation_id: collection.conversation_id,
          phase_id: collection.phase_id,
          task_id: collection.task_id,
          run_id: collection.run_id,
          approved_mockup_version_id: collection.approved_mockup_version_id,
          repository_binding_id: collection.repository_binding_id,
          ...(binding.binding_type === "local_runner"
            ? { runner_repository_id: binding.repository_id }
            : {}),
          verification_result_id: collection.verification_result_id,
          deployment_record_id: collection.deployment_record_id,
          deployment_observation_id: collection.deployment_observation_id,
          commit_sha: collection.commit_sha,
        },
      });
      const fenced = await tx.query<{ id: string }>(
        `SELECT id FROM implementation_visual_evidence_collections
          WHERE id=$1 AND status='leased' AND lease_owner=$2
            AND lease_expires_at>now() FOR UPDATE`,
        [collection.id, collection.lease_owner],
      );
      if (!fenced.rows[0]) throw new Error("visual evidence collection lease was lost");
      await tx.query(
        `INSERT INTO commands (
           command_id,dispatch_job_id,project_id,phase_id,task_id,run_id,
           runner_id,runner_generation,kind,envelope,status,correlation_id,causation_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'collect_visual_evidence',$9::jsonb,
                   'queued',$10,$11)
         ON CONFLICT(command_id) DO NOTHING`,
        [
          commandId,
          dispatchJobId,
          collection.project_id,
          collection.phase_id,
          collection.task_id,
          collection.run_id,
          target.runner_id,
          target.runner_generation,
          JSON.stringify(command),
          collection.id,
          collection.deployment_observation_id,
        ],
      );
      await tx.query(
        `INSERT INTO dispatch_jobs (
           id,project_id,phase_id,task_id,run_id,command_id,runner_id,status
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,'awaiting_enrollment')
         ON CONFLICT(id) DO NOTHING`,
        [
          dispatchJobId,
          collection.project_id,
          collection.phase_id,
          collection.task_id,
          collection.run_id,
          commandId,
          target.runner_id,
        ],
      );
      await tx.query(
        `UPDATE implementation_visual_evidence_collections
            SET status='awaiting_runner',command_id=$3,dispatch_job_id=$4,
                runner_id=$5,runner_generation=$6,
                lease_owner=NULL,lease_expires_at=NULL,updated_at=now()
          WHERE id=$1 AND status='leased' AND lease_owner=$2`,
        [
          collection.id,
          collection.lease_owner,
          commandId,
          dispatchJobId,
          target.runner_id,
          target.runner_generation,
        ],
      );
      return command;
    });
  }

  private async releaseClaim(collection: ClaimedCollection, message: string): Promise<void> {
    await this.transactions.transaction(async (tx) => {
      const failed = collection.attempts >= MAX_COLLECTION_ATTEMPTS;
      await tx.query(
        `UPDATE implementation_visual_evidence_collections
            SET status=CASE WHEN $3 THEN 'failed' ELSE 'queued' END,
                lease_owner=NULL,lease_expires_at=NULL,last_error=$4,
                completed_at=CASE WHEN $3 THEN now() ELSE NULL END,
                available_at=CASE WHEN $3 THEN available_at
                                  ELSE now()+interval '10 seconds' END,
                updated_at=now()
          WHERE id=$1 AND status='leased' AND lease_owner=$2`,
        [collection.id, collection.lease_owner, failed, message.slice(0, 2_000)],
      );
    });
  }

  private async relaunchAwaiting(): Promise<void> {
    const candidate = await this.transactions.transaction(async (tx) => {
      return (
        await tx.query<{
          project_id: string;
          repository_binding_id: string;
          dispatch_job_id: string;
          run_id: string;
          runner_id: string;
          runner_generation: number;
        }>(
          `SELECT collection.project_id,collection.repository_binding_id,
                  collection.dispatch_job_id,collection.run_id,
                  collection.runner_id,collection.runner_generation
             FROM implementation_visual_evidence_collections collection
             LEFT JOIN github_actions_runs actions
               ON actions.dispatch_job_id=collection.dispatch_job_id
            WHERE collection.status='awaiting_runner'
              AND (actions.dispatch_job_id IS NULL OR actions.status='requested')
            ORDER BY collection.updated_at,collection.id LIMIT 1`,
        )
      ).rows[0];
    });
    if (
      !candidate ||
      !candidate.dispatch_job_id ||
      !candidate.runner_id ||
      candidate.runner_generation === null
    ) {
      return;
    }
    await this.options.launch(candidate).catch(async (error) => {
      await this.transactions.transaction(async (tx) => {
        await tx.query(
          `UPDATE implementation_visual_evidence_collections
              SET attempts=attempts+1,
                  status=CASE WHEN attempts+1 >= $3 THEN 'failed' ELSE status END,
                  last_error=$2,
                  completed_at=CASE WHEN attempts+1 >= $3 THEN now() ELSE completed_at END,
                  updated_at=now()
            WHERE dispatch_job_id=$1 AND status='awaiting_runner'`,
          [
            candidate.dispatch_job_id,
            (error instanceof Error ? error.message : "Actions launch failed").slice(0, 2_000),
            MAX_COLLECTION_ATTEMPTS,
          ],
        );
      });
    });
  }

  private async deliverEnrolled(): Promise<boolean> {
    const candidate = await this.transactions.transaction(async (tx) => {
      return (
        await tx.query<{
          id: string;
          command_id: string;
          dispatch_job_id: string;
          envelope: unknown;
        }>(
          `SELECT collection.id,collection.command_id,collection.dispatch_job_id,
                  command.envelope
             FROM implementation_visual_evidence_collections collection
             JOIN commands command ON command.command_id=collection.command_id
             JOIN github_actions_runs actions
               ON actions.dispatch_job_id=collection.dispatch_job_id
            WHERE collection.status='awaiting_runner'
              AND actions.status='enrolled' AND command.status='queued'
            ORDER BY collection.updated_at,collection.id LIMIT 1`,
        )
      ).rows[0];
    });
    if (!candidate) return false;
    const command = CommandEnvelope.parse(candidate.envelope);
    if (!this.options.enqueue(command)) return false;
    await this.transactions.transaction(async (tx) => {
      await tx.query(
        `UPDATE implementation_visual_evidence_collections
            SET status='delivered',last_error=NULL,updated_at=now()
          WHERE id=$1 AND status='awaiting_runner'`,
        [candidate.id],
      );
      await tx.query(
        `UPDATE dispatch_jobs
            SET status='delivered',delivered_at=now(),updated_at=now()
          WHERE id=$1 AND status='awaiting_enrollment'`,
        [candidate.dispatch_job_id],
      );
    });
    this.options.notify?.(command.runner_id);
    return true;
  }

  private async failTerminalRunner(): Promise<void> {
    await this.transactions.transaction(async (tx) => {
      await tx.query(
        `UPDATE implementation_visual_evidence_collections collection
            SET status='failed',
                last_error=COALESCE(actions.last_error,actions.conclusion,
                                    'visual_evidence_runner_terminated'),
                completed_at=now(),updated_at=now()
           FROM github_actions_runs actions
          WHERE actions.dispatch_job_id=collection.dispatch_job_id
            AND collection.status IN ('awaiting_runner','delivered')
            AND actions.status IN ('failed','abandoned','completed')
            AND collection.evidence_id IS NULL`,
      );
    });
  }
}
