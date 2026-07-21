// EXECUTION E12 — "how many are running, and how many are waiting?"
//
// Deliverable 3 of this phase says a human must be able to see fan-out rather
// than infer it from a stalled dashboard. This module is that view, and it is
// deliberately DERIVED rather than stored: `running` is a count of live
// `agent_runs`, `queued` is a query for dependency-ready tasks that have not
// been dispatched yet. There is no queue table, no queue position column, and
// no queue state machine to fall out of sync with reality.
//
// That was a real design choice and it is worth stating why, because the
// obvious alternative (a `phase_task_queue` table written at launch time) is
// what the refoundation would have done. A stored queue has exactly one
// advantage -- it remembers intent across a restart -- and one fatal
// disadvantage in this codebase: it introduces a second opinion about what is
// runnable. The dependency graph, the task lifecycle, the budget and the
// coordinator gate ALREADY decide that, transactionally, and they can change
// underneath a stored queue row at any moment (a dependency fails, a human
// cancels a task, the budget is cut). Every such divergence becomes a queue
// entry that points at work which must not run, and the failure mode is
// dispatching it anyway. Deriving the queue makes that class of bug
// unrepresentable: the queue cannot claim a task is ready unless the same
// query the coordinator trusts says so.
//
// The cost is that "queued" carries no promise of ordering beyond the stable
// `created_at, id` sort the launcher itself uses, and no memory of *why* a
// human started the phase. Both are acceptable; neither is hidden.
import type { V2SqlExecutor } from "../persistence/v2/database.js";

/** Run states that occupy a concurrency slot. Must stay identical to the set
 *  `Phase4Coordinator.schedule()` counts, or the view lies about headroom. */
export const OCCUPYING_RUN_STATES = ["created", "dispatched", "running", "verifying"] as const;

export interface PhaseRunningRun {
  run_id: string;
  task_id: string;
  task_title: string;
  state: string;
  /** True when this run belongs to a DIFFERENT phase of the same project. The
   *  cap is project-wide, so another phase's runs really do consume this
   *  phase's headroom, and a human staring at one phase deserves to know that
   *  rather than concluding the cap is broken. */
  other_phase: boolean;
  phase_id: string;
}

export interface PhaseQueuedTask {
  task_id: string;
  task_title: string;
  /** Position in the same stable order the launcher dispatches in. 1-based. */
  position: number;
}

export interface PhaseConcurrencySnapshot {
  project_id: string;
  phase_id: string;
  /** `projects.max_concurrent_tasks`. Ships as 1; see the module note in
   *  `phaseQueueDrainer.ts` for why raising it is a human's cost decision. */
  max_concurrent_tasks: number;
  /** Occupied slots across the WHOLE project (the cap's actual scope). */
  running: number;
  /** Free slots right now. Never negative. */
  available: number;
  /** Dependency-ready, undispatched tasks in THIS phase, in dispatch order. */
  queued: number;
  running_runs: PhaseRunningRun[];
  queued_tasks: PhaseQueuedTask[];
  /** Open `run_integration_conflicts` rows for this phase. Non-zero means a
   *  human has something to look at before this phase can finish. */
  open_conflicts: number;
}

/**
 * The exact set of tasks the launcher considers dispatchable, in the exact
 * order it will dispatch them. `PhaseLaunchService.schedulableTasks()` runs
 * this same predicate; keeping one definition here is what makes the "queued"
 * number honest instead of approximately right.
 */
export const SCHEDULABLE_TASKS_SQL = `
  SELECT t.id AS task_id, t.title AS task_title,
         t.designated_assignment_id AS assignment_id,
         a.budget_limit_usd AS budget_limit_usd
    FROM tasks t
    JOIN agent_assignments a ON a.id = t.designated_assignment_id
   WHERE t.project_id = $1 AND t.phase_id = $2
     AND t.state IN ('pending', 'ready')
     AND t.designated_assignment_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM task_dependencies d
       JOIN tasks pred ON pred.id = d.predecessor_task_id
        WHERE d.successor_task_id = t.id AND pred.state <> 'completed'
     )
   ORDER BY t.created_at ASC, t.id ASC`;

export async function describePhaseConcurrency(
  sql: V2SqlExecutor,
  projectId: string,
  phaseId: string,
): Promise<PhaseConcurrencySnapshot> {
  const occupying = OCCUPYING_RUN_STATES.map((state) => `'${state}'`).join(",");

  const capRow = await sql.query<{ max_concurrent_tasks: number }>(
    "SELECT max_concurrent_tasks FROM projects WHERE id = $1",
    [projectId],
  );
  const cap = capRow.rows[0]?.max_concurrent_tasks ?? 1;

  const running = await sql.query<{
    run_id: string;
    task_id: string;
    task_title: string;
    state: string;
    phase_id: string;
  }>(
    `SELECT run.id AS run_id, run.task_id, task.title AS task_title,
            run.state, run.phase_id
       FROM agent_runs run
       JOIN tasks task ON task.id = run.task_id
      WHERE run.project_id = $1 AND run.state IN (${occupying})
      ORDER BY run.created_at ASC, run.id ASC`,
    [projectId],
  );

  const queued = await sql.query<{ task_id: string; task_title: string }>(SCHEDULABLE_TASKS_SQL, [
    projectId,
    phaseId,
  ]);

  const conflicts = await sql.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM run_integration_conflicts
      WHERE phase_id = $1 AND status = 'awaiting_human'`,
    [phaseId],
  );

  return {
    project_id: projectId,
    phase_id: phaseId,
    max_concurrent_tasks: cap,
    running: running.rows.length,
    available: Math.max(0, cap - running.rows.length),
    queued: queued.rows.length,
    running_runs: running.rows.map((row) => ({
      run_id: row.run_id,
      task_id: row.task_id,
      task_title: row.task_title,
      state: row.state,
      phase_id: row.phase_id,
      other_phase: row.phase_id !== phaseId,
    })),
    queued_tasks: queued.rows.map((row, index) => ({
      task_id: row.task_id,
      task_title: row.task_title,
      position: index + 1,
    })),
    open_conflicts: conflicts.rows[0]?.count ?? 0,
  };
}
