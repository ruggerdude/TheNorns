import type { V2ActorT } from "@norns/contracts";
import type { V2SqlExecutor } from "../persistence/v2/database.js";

interface DismissedRecoveryDecision {
  id: string;
  project_id: string;
  phase_id: string | null;
  task_id: string | null;
  scope_entity_id: string;
  reason_class: string;
}

async function auditDismissals(
  sql: V2SqlExecutor,
  decisions: readonly DismissedRecoveryDecision[],
  actor: V2ActorT,
  occurredAt: string,
  reason: string,
): Promise<void> {
  for (const decision of decisions) {
    await sql.query(
      `INSERT INTO audit_events (
         audit_id, audit_type, project_id, phase_id, task_id,
         actor_type, actor_id, outcome, severity, correlation_id,
         causation_id, occurred_at, targets, summary, details,
         redaction_applied
       ) VALUES (
         $1,'execution.recovery.auto_dismissed',$2,$3,$4,$5,$6,
         'succeeded','info',$7,$8,$9,$10::jsonb,$11,$12::jsonb,true
       )
       ON CONFLICT (audit_id) DO NOTHING`,
      [
        `audit:recovery-auto-dismissed:${decision.id}`,
        decision.project_id,
        decision.phase_id,
        decision.task_id,
        actor.actor_type,
        actor.actor_id,
        `recovery-dismissed:${decision.id}`,
        decision.scope_entity_id,
        occurredAt,
        JSON.stringify([
          { entity_type: "decision_point", entity_id: decision.id },
          { entity_type: "agent_run", entity_id: decision.scope_entity_id },
        ]),
        `Dismissed obsolete ${decision.reason_class} recovery decision`,
        JSON.stringify({ reason }),
      ],
    );
  }
}

/**
 * Successful terminal application and recovery-decision cleanup commit
 * together. A websocket crash can therefore expose either the still-open
 * recovery point with unfinished work, or successful work with the point
 * dismissed, but never the contradictory combination.
 */
export async function dismissRecoveryDecisionsForSuccessfulRun(
  sql: V2SqlExecutor,
  input: {
    project_id: string;
    phase_id: string;
    task_id: string;
    run_id: string;
    actor: V2ActorT;
    occurred_at: string;
  },
): Promise<string[]> {
  const dismissed = await sql.query<DismissedRecoveryDecision>(
    `UPDATE decision_points
        SET status='dismissed', resolved_at=$4, updated_at=$4
      WHERE project_id=$1 AND phase_id=$2 AND status='open'
        AND reason_class IN ('stuck_run','failed_run')
        AND scope_entity_type='agent_run'
        AND scope_entity_id=$3
      RETURNING id, project_id, phase_id, task_id, scope_entity_id, reason_class`,
    [input.project_id, input.phase_id, input.run_id, input.occurred_at],
  );
  await auditDismissals(
    sql,
    dismissed.rows,
    input.actor,
    input.occurred_at,
    "the designated run reached successful terminal state",
  );
  return dismissed.rows.map((row) => row.id);
}

/**
 * Startup/monitor convergence for state produced by older processes. This
 * performs the same deterministic cleanup when a run has already succeeded,
 * has been superseded, or belongs to work whose task/phase is terminal.
 */
export async function reconcileObsoleteRecoveryDecisions(
  sql: V2SqlExecutor,
  occurredAt: string,
): Promise<string[]> {
  const dismissed = await sql.query<DismissedRecoveryDecision>(
    `UPDATE decision_points decision
        SET status='dismissed', resolved_at=$1, updated_at=$1
      WHERE decision.status='open'
        AND decision.reason_class IN ('stuck_run','failed_run')
        AND decision.scope_entity_type='agent_run'
        AND EXISTS (
          SELECT 1
            FROM agent_runs run
            JOIN tasks task ON task.id=run.task_id
            JOIN phases phase ON phase.id=run.phase_id
           WHERE run.id=decision.scope_entity_id
             AND (
               run.state='succeeded'
               OR run.is_designated=false
               OR run.superseded_at IS NOT NULL
               OR task.state IN ('completed','cancelled')
               OR phase.status IN ('completed','cancelled')
             )
        )
      RETURNING decision.id, decision.project_id, decision.phase_id,
                decision.task_id, decision.scope_entity_id, decision.reason_class`,
    [occurredAt],
  );
  await auditDismissals(
    sql,
    dismissed.rows,
    { actor_type: "system", actor_id: "system:phase4-recovery" },
    occurredAt,
    "monitor reconciliation found the recovery condition was no longer actionable",
  );
  return dismissed.rows.map((row) => row.id);
}
