// EXECUTION E2: authorization for EXECUTION E1's runner-facing context fetch
// route (`GET ${TASK_CONTEXT_ROUTE_PREFIX}/:documentId` in server.ts).
//
// The context route authenticates a request with `DeviceHttpRequestAuthenticator`:
// a valid Ed25519 signature from ANY paired runner satisfies it, for ANY
// project's document, because runner identity carries no project or job
// scope. This module is the missing authorization layer. The moment a task
// is actually scheduled (this phase's `PhaseLaunchService`, right after
// `Phase4Coordinator.schedule()` or `ActionsExecutionCoordinator.schedule()`
// succeeds), it records which runner was handed which exact context
// documents. The fetch route then requires BOTH a valid signature AND a row
// here naming the requesting runner for the requested document -- proof of
// identity, plus proof of entitlement.
import type { V2ContentAddressedReferenceT } from "@norns/contracts";
import type { V2SqlExecutor, V2TransactionRunner } from "../persistence/v2/database.js";

export interface DispatchContextScopeInput {
  runnerId: string;
  runnerGeneration: number;
  dispatchJobId: string;
  runId: string;
}

export class DispatchContextScopeRepository {
  constructor(private readonly transactions: V2TransactionRunner) {}

  /**
   * Record that `runnerId` was dispatched `dispatchJobId` (run `runId`) with
   * exactly these context refs. Idempotent, and safe to call again for a
   * runner that is re-dispatched the same shared document (the project's
   * repository/directives/memory sections are content-addressed and reused
   * across every task in the project) -- the row is refreshed to point at the
   * latest dispatch rather than duplicated.
   */
  async recordScope(
    input: DispatchContextScopeInput,
    contextRefs: readonly V2ContentAddressedReferenceT[],
  ): Promise<void> {
    if (contextRefs.length === 0) return;
    await this.transactions.transaction(async (tx) => {
      for (const ref of contextRefs) {
        await tx.query(
          `INSERT INTO dispatch_context_documents
             (
               runner_id,runner_generation,context_document_id,
               dispatch_job_id,run_id,revoked_at
             )
           VALUES (
             $1,$2,$3,$4,$5,
             CASE
               WHEN NOT EXISTS (
                 SELECT 1
                   FROM device_run_cancellations cancellation
                  WHERE cancellation.run_id=$5
                    AND cancellation.publication_fenced_at IS NOT NULL
                    AND cancellation.publication_reauthorized_at IS NULL
               )
               THEN NULL
               ELSE now()
             END
           )
           ON CONFLICT (runner_id, context_document_id) DO UPDATE SET
             runner_generation = EXCLUDED.runner_generation,
             dispatch_job_id = EXCLUDED.dispatch_job_id,
             run_id = EXCLUDED.run_id,
             revoked_at = CASE
               WHEN EXCLUDED.revoked_at IS NOT NULL THEN EXCLUDED.revoked_at
               WHEN dispatch_context_documents.revoked_at IS NULL THEN NULL
               WHEN EXISTS (
                 SELECT 1
                   FROM commands command
                  WHERE command.run_id=EXCLUDED.run_id
                    AND command.runner_id=EXCLUDED.runner_id
                    AND command.runner_generation=EXCLUDED.runner_generation
                    AND command.status IN ('created','queued','dispatched')
               ) THEN NULL
               ELSE dispatch_context_documents.revoked_at
             END,
             created_at = now()`,
          [
            input.runnerId,
            input.runnerGeneration,
            ref.artifact_id,
            input.dispatchJobId,
            input.runId,
          ],
        );
      }
    });
  }

  /**
   * True when `runnerId` was actually dispatched a job that was handed
   * `documentId` as one of its context refs. This is the authorization check
   * the fetch route was missing: a valid signature alone proves identity, not
   * entitlement to this specific document.
   */
  async isAuthorized(
    runnerId: string,
    runnerGeneration: number,
    documentId: string,
  ): Promise<boolean> {
    return this.transactions.transaction(async (tx) =>
      Boolean(await this.authorizedRunIdInTransaction(tx, runnerId, runnerGeneration, documentId)),
    );
  }

  async authorizedRunIdInTransaction(
    tx: V2SqlExecutor,
    runnerId: string,
    runnerGeneration: number,
    documentId: string,
  ): Promise<string | null> {
    const result = await tx.query<{ run_id: string }>(
      `SELECT run_id FROM dispatch_context_documents
        WHERE runner_id=$1
          AND context_document_id=$2
          AND runner_generation=$3
          AND revoked_at IS NULL
        FOR UPDATE`,
      [runnerId, documentId, runnerGeneration],
    );
    return result.rows[0]?.run_id ?? null;
  }
}
