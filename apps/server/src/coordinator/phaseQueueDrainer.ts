// EXECUTION E12 — the thing that makes a queue a queue.
//
// `PhaseLaunchService.startPhase()` has always been idempotent and safe to call
// repeatedly, and its own docblock said so ("e.g. after each task completion
// unblocks its successors"). Nothing ever did. That one missing caller is the
// whole difference between "over-cap work queues" and "over-cap work is
// silently dropped until a human clicks Start again" -- the same shape of bug
// as EXECUTION E2's (a correct gate nobody called) and E12's own finding about
// `task_coordination_constraints` (a correct check over a table nobody wrote).
// This file is that caller.
//
// AUTHORIZATION, stated plainly
// =============================
//
// Draining dispatches work, which costs money, so it must be attributable. It
// does NOT invent authority: the drainer only ever touches phases already in
// `status = 'active'`, which a phase reaches exactly one way -- a human ran
// `Phase4Coordinator.schedule()` through `startPhase`, having approved a
// strategy and a budget. Draining continues the launch that human authorized,
// for tasks that were in the phase they authorized, inside the budget they
// approved (the coordinator re-checks the phase budget on every single
// dispatch; a drained task is refused exactly as a hand-launched one would be).
//
// It is attributed to `coordinator / system:phase-queue-drainer` rather than
// impersonating the human, so an audit can always tell a hand-clicked dispatch
// from an automatic one. A human who wants the fan-out to stop sets
// `max_concurrent_tasks` to the number they want, or cancels the phase; the
// drainer never exceeds the cap because it does not enforce the cap -- the
// coordinator does, transactionally, on the drainer exactly as on anyone else.
//
// WHY A POLL AND NOT AN EVENT HOOK
// ================================
//
// The obvious alternative is to drain from `Phase4EventProcessor` the moment a
// run reaches a terminal state. That is more prompt and strictly less robust:
// it drains only on the paths that emit an event, and a slot also frees on
// paths that do not (a dispatch job dead-letters, a recovery monitor expires a
// stale run, an operator cancels, the server restarts holding a queue it never
// wrote down). Each of those would need its own hook, and a MISSED hook is
// invisible -- the phase just quietly stops, which is precisely the failure
// this phase exists to remove. A poll cannot miss a transition it never saw,
// because it does not look at transitions; it looks at whether there is a free
// slot and something ready, which is the actual precondition.
//
// The cost is latency bounded by the interval (default 5s), and one cheap
// query per active phase per tick. That trade is the right way round for
// something whose failure mode is "work silently stops forever".
import type { V2ActorT } from "@norns/contracts";
import type { V2TransactionRunner } from "../persistence/v2/database.js";
import { PhaseLaunchError, type PhaseLaunchService } from "./phaseLaunchService.js";

export const PHASE_QUEUE_DRAINER_ACTOR: V2ActorT = {
  actor_type: "coordinator",
  actor_id: "system:phase-queue-drainer",
};

export interface PhaseQueueDrainOutcome {
  project_id: string;
  phase_id: string;
  dispatched: string[];
  still_queued: number;
  running: number;
}

export interface PhaseQueueDrainerOptions {
  now?: () => Date;
  /** Surfaced so an operator sees a drain that keeps failing rather than a
   *  phase that quietly stopped. Never swallows: a drain error for one phase
   *  is reported and the next phase is still attempted. */
  onError?: (projectId: string, phaseId: string, error: unknown) => void;
}

interface DrainCandidateRow {
  project_id: string;
  phase_id: string;
}

export class PhaseQueueDrainer {
  constructor(
    private readonly transactions: V2TransactionRunner,
    private readonly launch: PhaseLaunchService,
    private readonly options: PhaseQueueDrainerOptions = {},
  ) {}

  /**
   * Every active phase that has BOTH a free slot and at least one
   * dependency-ready undispatched task. Both halves matter: without the free
   * slot this would call `startPhase` for every active phase on every tick and
   * do nothing but burn queries; without the ready task it would call it for
   * phases whose remaining work is genuinely blocked.
   *
   * The cap is per PROJECT, so headroom is computed per project and a phase
   * whose sibling phase is using the slots correctly finds none.
   */
  private async candidates(): Promise<DrainCandidateRow[]> {
    return this.transactions.transaction(async (sql) => {
      const result = await sql.query<DrainCandidateRow>(
        `SELECT phase.project_id, phase.id AS phase_id
           FROM phases phase
           JOIN projects project ON project.id = phase.project_id
          WHERE phase.status = 'active'
            AND (
              SELECT count(*)::int FROM agent_runs run
               WHERE run.project_id = phase.project_id
                 AND run.state IN ('created','dispatched','running','verifying')
            ) < project.max_concurrent_tasks
            AND EXISTS (
              SELECT 1 FROM tasks t
              JOIN agent_assignments a ON a.id = t.designated_assignment_id
              WHERE t.project_id = phase.project_id AND t.phase_id = phase.id
                AND t.state IN ('pending','ready')
                AND t.designated_assignment_id IS NOT NULL
                AND NOT EXISTS (
                  SELECT 1 FROM task_dependencies d
                  JOIN tasks pred ON pred.id = d.predecessor_task_id
                   WHERE d.successor_task_id = t.id AND pred.state <> 'completed'
                )
            )
          ORDER BY phase.project_id, phase.id`,
      );
      return result.rows;
    });
  }

  /**
   * One pass. Returns what it actually dispatched, per phase.
   *
   * FAILURE ISOLATION. Each phase is drained independently and each phase's
   * failure is caught here, so one project's broken binding, missing runner or
   * exhausted budget cannot stop every other project's queue from draining.
   * Within a phase, `startPhase` already isolates per task: a task whose
   * context will not assemble is reported blocked and the loop continues to
   * the next one.
   */
  async drain(): Promise<PhaseQueueDrainOutcome[]> {
    const now = this.options.now ?? (() => new Date());
    const outcomes: PhaseQueueDrainOutcome[] = [];
    for (const candidate of await this.candidates()) {
      try {
        const result = await this.launch.startPhase({
          project_id: candidate.project_id,
          phase_id: candidate.phase_id,
          authorized_by: PHASE_QUEUE_DRAINER_ACTOR,
          authorized_by_session_id: "session:phase-queue-drainer",
          issued_at: now().toISOString(),
        });
        outcomes.push({
          project_id: candidate.project_id,
          phase_id: candidate.phase_id,
          dispatched: result.scheduled.map((entry) => entry.run_id ?? entry.task_id),
          still_queued: result.concurrency.queued,
          running: result.concurrency.running,
        });
      } catch (error) {
        // A `PhaseLaunchError` here means the phase stopped being launchable
        // between the candidate query and the launch (binding revoked, phase
        // closed, budget cut). That is ordinary and not worth alarming about;
        // anything else is reported.
        if (!(error instanceof PhaseLaunchError)) {
          this.options.onError?.(candidate.project_id, candidate.phase_id, error);
        }
      }
    }
    return outcomes;
  }
}
