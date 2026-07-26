import type { V2SqlExecutor, V2TransactionRunner } from "../persistence/v2/database.js";

export type InitiatorAttributionErrorCode =
  | "planning_run_not_found"
  | "identity_not_active"
  | "attribution_conflict";

export class InitiatorAttributionError extends Error {
  constructor(
    readonly code: InitiatorAttributionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "InitiatorAttributionError";
  }
}

export interface InitiatorPropagationResult {
  planningRunId: string;
  initiatedByUserId: string | null;
  phasesAttributed: number;
  tasksAttributed: number;
  runsAttributed: number;
}

interface PlanningAttributionRow {
  id: string;
  initiated_by_user_id: string | null;
}

async function requireActiveIdentity(sql: V2SqlExecutor, userId: string): Promise<void> {
  const result = await sql.query<{ active: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM users WHERE id=$1 AND status='active'
     ) AS active`,
    [userId],
  );
  if (!result.rows[0]?.active) {
    throw new InitiatorAttributionError(
      "identity_not_active",
      `initiating user "${userId}" is not an active identity`,
    );
  }
}

async function planningRun(
  sql: V2SqlExecutor,
  planningRunId: string,
): Promise<PlanningAttributionRow> {
  const result = await sql.query<PlanningAttributionRow>(
    "SELECT id, initiated_by_user_id FROM planning_runs WHERE id=$1 FOR UPDATE",
    [planningRunId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new InitiatorAttributionError(
      "planning_run_not_found",
      `unknown planning run "${planningRunId}"`,
    );
  }
  return row;
}

async function conflictCount(
  sql: V2SqlExecutor,
  query: string,
  params: unknown[],
): Promise<number> {
  const result = await sql.query<{ count: number | string }>(query, params);
  return Number(result.rows[0]?.count ?? 0);
}

async function propagate(
  sql: V2SqlExecutor,
  root: PlanningAttributionRow,
): Promise<InitiatorPropagationResult> {
  const userId = root.initiated_by_user_id;
  if (userId === null) {
    return {
      planningRunId: root.id,
      initiatedByUserId: null,
      phasesAttributed: 0,
      tasksAttributed: 0,
      runsAttributed: 0,
    };
  }

  const phaseConflicts = await conflictCount(
    sql,
    `SELECT count(*) AS count
     FROM phases
     WHERE planning_run_id=$1
       AND initiated_by_user_id IS NOT NULL
       AND initiated_by_user_id<>$2`,
    [root.id, userId],
  );
  if (phaseConflicts > 0) {
    throw new InitiatorAttributionError(
      "attribution_conflict",
      `${phaseConflicts} phase attribution record(s) conflict with planning run "${root.id}"`,
    );
  }
  const phases = await sql.query<{ id: string }>(
    `UPDATE phases
     SET initiated_by_user_id=$2, updated_at=now()
     WHERE planning_run_id=$1 AND initiated_by_user_id IS NULL
     RETURNING id`,
    [root.id, userId],
  );

  const taskConflicts = await conflictCount(
    sql,
    `SELECT count(*) AS count
     FROM tasks task
     JOIN phases phase
       ON phase.id=task.phase_id AND phase.project_id=task.project_id
     WHERE phase.planning_run_id=$1
       AND task.initiated_by_user_id IS NOT NULL
       AND task.initiated_by_user_id<>$2`,
    [root.id, userId],
  );
  if (taskConflicts > 0) {
    throw new InitiatorAttributionError(
      "attribution_conflict",
      `${taskConflicts} task attribution record(s) conflict with planning run "${root.id}"`,
    );
  }
  const tasks = await sql.query<{ id: string }>(
    `UPDATE tasks task
     SET initiated_by_user_id=$2, updated_at=now()
     FROM phases phase
     WHERE phase.id=task.phase_id
       AND phase.project_id=task.project_id
       AND phase.planning_run_id=$1
       AND task.initiated_by_user_id IS NULL
     RETURNING task.id`,
    [root.id, userId],
  );

  const runConflicts = await conflictCount(
    sql,
    `SELECT count(*) AS count
     FROM agent_runs run
     JOIN tasks task
       ON task.id=run.task_id
      AND task.phase_id=run.phase_id
      AND task.project_id=run.project_id
     JOIN phases phase
       ON phase.id=task.phase_id
      AND phase.project_id=task.project_id
     WHERE phase.planning_run_id=$1
       AND run.initiated_by_user_id IS NOT NULL
       AND run.initiated_by_user_id<>$2`,
    [root.id, userId],
  );
  if (runConflicts > 0) {
    throw new InitiatorAttributionError(
      "attribution_conflict",
      `${runConflicts} agent-run attribution record(s) conflict with planning run "${root.id}"`,
    );
  }
  const runs = await sql.query<{ id: string }>(
    `UPDATE agent_runs run
     SET initiated_by_user_id=$2, updated_at=now()
     FROM tasks task, phases phase
     WHERE task.id=run.task_id
       AND task.phase_id=run.phase_id
       AND task.project_id=run.project_id
       AND phase.id=task.phase_id
       AND phase.project_id=task.project_id
       AND phase.planning_run_id=$1
       AND run.initiated_by_user_id IS NULL
     RETURNING run.id`,
    [root.id, userId],
  );

  return {
    planningRunId: root.id,
    initiatedByUserId: userId,
    phasesAttributed: phases.rows.length,
    tasksAttributed: tasks.rows.length,
    runsAttributed: runs.rows.length,
  };
}

/**
 * Records one proven authenticated initiator and propagates it down the
 * planning-run -> phase -> task -> agent-run lineage without overwriting any
 * conflicting attribution. Call `attributePlanningRun` during request
 * creation, then `propagateFromPlanningRun` after each materialization step.
 */
export class InitiatorAttributionService {
  constructor(private readonly transactions: V2TransactionRunner) {}

  attributePlanningRun(
    planningRunId: string,
    initiatedByUserId: string,
  ): Promise<InitiatorPropagationResult> {
    return this.transactions.transaction(async (sql) => {
      await requireActiveIdentity(sql, initiatedByUserId);
      const root = await planningRun(sql, planningRunId);
      if (root.initiated_by_user_id !== null && root.initiated_by_user_id !== initiatedByUserId) {
        throw new InitiatorAttributionError(
          "attribution_conflict",
          `planning run "${planningRunId}" is already attributed to another user`,
        );
      }
      if (root.initiated_by_user_id === null) {
        await sql.query(
          `UPDATE planning_runs
           SET initiated_by_user_id=$2, updated_at=now()
           WHERE id=$1 AND initiated_by_user_id IS NULL`,
          [planningRunId, initiatedByUserId],
        );
      }
      return propagate(sql, { id: planningRunId, initiated_by_user_id: initiatedByUserId });
    });
  }

  propagateFromPlanningRun(planningRunId: string): Promise<InitiatorPropagationResult> {
    return this.transactions.transaction(async (sql) => {
      const root = await planningRun(sql, planningRunId);
      return propagate(sql, root);
    });
  }
}
