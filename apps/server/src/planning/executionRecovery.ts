import type { V2TransactionRunner } from "../persistence/v2/database.js";

/**
 * Returns the immutable conversation handoff that originally approved a
 * planning run. Recovery retries must preserve this binding so kickoff can
 * attach the already-created task packages before dispatching the phase.
 */
export async function conversationHandoffIdForPlanningRun(
  transactions: V2TransactionRunner,
  projectId: string,
  planningRunId: string,
): Promise<string | undefined> {
  return transactions.transaction(async (tx) => {
    const result = await tx.query<{ handoff_id: string }>(
      `SELECT handoff_id
         FROM conversation_kickoff_intents
        WHERE project_id=$1 AND planning_run_id=$2
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      [projectId, planningRunId],
    );
    return result.rows[0]?.handoff_id;
  });
}
