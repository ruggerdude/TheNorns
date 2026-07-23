import {
  PhaseLaunchError,
  type PhaseLaunchResult,
  type PhaseLaunchService,
} from "../coordinator/phaseLaunchService.js";
// PHASE TAB P4 — the real ApprovedPlanExecutionKickoff.
//
// The product decision this implements: approving a plan in the Phase tab IS
// the human strategy-approval gate, so an approve decision auto-starts
// execution. The chain was never a single call, and this service does not
// make it one by reimplementing anything — it drives the EXISTING services in
// order, each with its own invariants intact:
//
//   1. StrategyBridgeService.createPhaseFromPlanningRun — planning_run_id ->
//      phase + proposed StrategyVersion (idempotent saga; profiles ensured;
//      staffing falls back to result.staffing_proposal.recommendations).
//   2. StrategyBridgeService.editStaffing — the human's per-node
//      provider/model overrides recorded with the decision, applied as a
//      superseding strategy version. Nodes without overrides keep the
//      recommendation staffing from step 1.
//   3. StrategyBridgeService.approve — the canonical, transactional strategy
//      approval + materialization (tasks, assignments, budget). The approval
//      is attributed to the planning-run decision: `approved_by` carries the
//      run id and `approved_at` carries the decision's decided_at.
//   4. PhaseLaunchService.startPhase — dispatch through the real coordinator
//      gate. Nothing here bypasses or weakens that gate.
//
// HONESTY CONTRACT (enforced by the decision route, restated here): the
// planning-run approval is recorded BEFORE this service runs and is never
// rolled back by anything below. Every failure path returns
// `{ started: false, detail }` with a human-readable reason — including the
// repo's one-executing-phase-per-project default: if any phase in the project
// is already `active`, the kickoff refuses before mutating anything rather
// than forcing a second executing phase.
import type { V2SqlExecutor, V2TransactionRunner } from "../persistence/v2/database.js";
import type {
  StaffingAssignmentEdit,
  StrategyBridgeService,
  StrategyReviewDto,
} from "../projects/strategyBridgeService.js";
import type {
  ApprovedPlanExecutionKickoff,
  ApprovedPlanExecutionKickoffInput,
  PlanningRunDecisionDto,
} from "./runService.js";

export interface ExecutionKickoffServiceDeps {
  transactions: V2TransactionRunner;
  bridge: StrategyBridgeService;
  phaseLaunch: PhaseLaunchService;
  now?: () => Date;
}

interface ActivePhaseRow {
  id: string;
  objective_summary: string;
  planning_run_id: string | null;
}

type KickoffReport = { started: boolean; detail: string };

export class ExecutionKickoffService implements ApprovedPlanExecutionKickoff {
  private readonly transactions: V2TransactionRunner;
  private readonly bridge: StrategyBridgeService;
  private readonly phaseLaunch: PhaseLaunchService;
  private readonly now: () => Date;

  constructor(deps: ExecutionKickoffServiceDeps) {
    this.transactions = deps.transactions;
    this.bridge = deps.bridge;
    this.phaseLaunch = deps.phaseLaunch;
    this.now = deps.now ?? (() => new Date());
  }

  async kickoff(input: ApprovedPlanExecutionKickoffInput): Promise<KickoffReport> {
    // Any escape below is converted into a refusal, never a throw: the
    // decision route has already recorded the approval, and a kickoff error
    // must surface as an honest `{ started: false }` report, not a 500.
    try {
      return await this.run(input);
    } catch (error) {
      return {
        started: false,
        detail: describeError(error),
      };
    }
  }

  private async run(input: ApprovedPlanExecutionKickoffInput): Promise<KickoffReport> {
    // ---- 0. one executing phase per project (repo default) -----------------
    // Checked before ANY mutation so a refusal leaves no half-materialized
    // state behind. The plan itself stays approved and recorded; it can be
    // started through the existing strategy/phase flow once the active phase
    // completes.
    const active = await this.transactions.transaction(async (tx) =>
      this.loadActivePhase(tx, input.projectId),
    );
    if (active) {
      const which =
        active.planning_run_id === input.planningRunId
          ? `the phase for this plan ("${active.objective_summary}", ${active.id}) is already executing`
          : `phase "${active.objective_summary}" (${active.id}) is already executing`;
      return {
        started: false,
        detail: `${which}; this project runs one phase at a time. The approved plan is recorded and can be started once the active phase completes.`,
      };
    }

    // The decision's decided_at is the approval's timestamp of record.
    const decidedAt = (await this.loadDecision(input)) ?? this.now().toISOString();
    const actor = { actor_id: `planning-run-decision:${input.planningRunId}` };

    // ---- 1. materialize the plan (idempotent) ------------------------------
    let review = await this.bridge.createPhaseFromPlanningRun({
      projectId: input.projectId,
      planningRunId: input.planningRunId,
      actor,
    });
    const phaseId = review.phase.id;
    const phaseName = review.phase.objective_summary;

    if (review.strategy?.status === "awaiting_approval") {
      // ---- 2. apply the decision's staffing overrides ----------------------
      const edits = this.overrideEdits(input, review);
      if (edits.length > 0) {
        review = await this.bridge.editStaffing({
          projectId: input.projectId,
          phaseId,
          edits,
          actor,
        });
      }

      // ---- 3. approve + materialize, attributed to the decision ------------
      await this.bridge.approve({
        projectId: input.projectId,
        phaseId,
        actor,
        idempotencyKey: `planning-run-approve:${input.planningRunId}`,
        issuedAt: decidedAt,
      });
    }
    // A strategy already `approved` (a re-entered kickoff after a partial
    // earlier attempt) skips straight to launch; anything else — e.g. blocked
    // by open must-fix findings — surfaces as the bridge's own refusal above.

    // ---- 4. start the phase through the real gate --------------------------
    const result = await this.phaseLaunch.startPhase({
      project_id: input.projectId,
      phase_id: phaseId,
      authorized_by: { actor_type: "human", actor_id: actor.actor_id },
      authorized_by_session_id: `planning-run-decision:${input.planningRunId}`,
      issued_at: this.now().toISOString(),
    });
    return describeLaunch(phaseId, phaseName, result);
  }

  /** Maps decision.staffing (node_id -> provider/model) onto the bridge's
   *  assignment local ids, skipping overrides that already match the
   *  recommendation staffing (no pointless superseding version). An override
   *  for a node the plan does not contain is a refusal, not a silent skip. */
  private overrideEdits(
    input: ApprovedPlanExecutionKickoffInput,
    review: StrategyReviewDto,
  ): StaffingAssignmentEdit[] {
    const staffing = input.staffing ?? [];
    if (staffing.length === 0) return [];
    const byAssignment = new Map(
      (review.strategy?.staffing ?? []).map((entry) => [entry.assignment_id, entry]),
    );
    const edits: StaffingAssignmentEdit[] = [];
    for (const entry of staffing) {
      const assignmentId = `assignment-${entry.node_id}`;
      const current = byAssignment.get(assignmentId);
      if (!current) {
        throw new Error(
          `staffing override references unknown plan node "${entry.node_id}" — the approved plan has no task for it`,
        );
      }
      if (current.provider === entry.provider && current.model === entry.model) continue;
      edits.push({
        assignment_id: assignmentId,
        provider: entry.provider,
        model: entry.model,
      });
    }
    return edits;
  }

  private async loadActivePhase(
    tx: V2SqlExecutor,
    projectId: string,
  ): Promise<ActivePhaseRow | null> {
    const result = await tx.query<ActivePhaseRow>(
      `SELECT id, objective_summary, planning_run_id
         FROM phases WHERE project_id = $1 AND status = 'active'
        ORDER BY id LIMIT 1`,
      [projectId],
    );
    return result.rows[0] ?? null;
  }

  private async loadDecision(input: ApprovedPlanExecutionKickoffInput): Promise<string | null> {
    const row = await this.transactions.transaction(async (tx) =>
      tx.query<{ decision: PlanningRunDecisionDto | string | null }>(
        "SELECT decision FROM planning_runs WHERE id = $1 AND project_id = $2",
        [input.planningRunId, input.projectId],
      ),
    );
    const raw = row.rows[0]?.decision ?? null;
    if (raw === null) return null;
    const decision = (typeof raw === "string" ? JSON.parse(raw) : raw) as PlanningRunDecisionDto;
    return typeof decision.decided_at === "string" ? decision.decided_at : null;
  }
}

function describeLaunch(
  phaseId: string,
  phaseName: string,
  result: PhaseLaunchResult,
): KickoffReport {
  const name = `"${phaseName}" (${phaseId})`;
  if (result.scheduled.length > 0) {
    const extras: string[] = [];
    if (result.deferred.length > 0) extras.push(`${result.deferred.length} queued`);
    if (result.blocked.length > 0) extras.push(`${result.blocked.length} blocked`);
    const suffix = extras.length > 0 ? ` (${extras.join(", ")})` : "";
    return {
      started: true,
      detail: `Started phase ${name}: ${result.scheduled.length} task(s) dispatched${suffix}.`,
    };
  }
  // Nothing dispatched: the phase never flipped to active (activation happens
  // inside the coordinator gate on a successful schedule), so report the
  // first concrete reason the launcher recorded.
  const reason =
    result.blocked[0]?.blocked_reason ??
    result.deferred[0]?.blocked_reason ??
    "no dependency-ready tasks were schedulable";
  return {
    started: false,
    detail: `Phase ${name} was approved but no tasks could be dispatched: ${reason}`,
  };
}

function describeError(error: unknown): string {
  if (error instanceof PhaseLaunchError) {
    return error.action_required ? `${error.message} ${error.action_required}` : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
