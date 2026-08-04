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

/**
 * Projects the outcome of an explicit execution retry back into the
 * conversation journey. The original kickoff intent remains immutable as the
 * audit record of its first settled attempt; the work item and linked agent
 * run describe the latest execution truth.
 */
export async function reconcileConversationExecutionRetry(
  transactions: V2TransactionRunner,
  projectId: string,
  planningRunId: string,
  report: { started: boolean; detail: string },
): Promise<{ started: boolean; detail: string }> {
  if (!report.started) return report;

  return transactions.transaction(async (tx) => {
    const phase = (
      await tx.query<{ id: string }>(
        `SELECT id FROM phases
          WHERE project_id=$1 AND planning_run_id=$2 AND status='active'
          ORDER BY created_at DESC, id DESC LIMIT 1`,
        [projectId, planningRunId],
      )
    ).rows[0];
    if (!phase) {
      const detail = "Execution retry reported started but created no active execution phase.";
      return { started: false, detail };
    }

    await tx.query(
      `UPDATE work_items item
          SET status='executing', phase_id=$3,
              execution_started_at=coalesce(execution_started_at,now()),
              aggregate_version=aggregate_version+1, updated_at=now()
         FROM conversation_kickoff_intents intent
        WHERE intent.project_id=$1 AND intent.planning_run_id=$2
          AND item.project_id=intent.project_id AND item.id=intent.work_item_id
          AND (item.status<>'executing' OR item.phase_id IS DISTINCT FROM $3)`,
      [projectId, planningRunId, phase.id],
    );
    return report;
  });
}
