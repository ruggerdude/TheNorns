// The workflow engine (PRD R4 §Graph & Execution): an event-sourced wrapper
// over the pure contracts reducer. State is always derived by replaying the
// append-only lifecycle log — never mutated directly — so a persisted log
// reconstructs identical state (the 1B exit criterion). Approval gates and
// the kill switch are enforced here; no agent path bypasses them.
import {
  type ApprovalT,
  type BlockedReason,
  type LifecycleEventT,
  type NodeState,
  type PlanContractT,
  canTransition,
  reduceLifecycle,
} from "@norns/contracts";
import { BudgetExceededError, type BudgetLedger } from "./budget.js";

export class EngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineError";
  }
}

export class KillSwitchEngagedError extends EngineError {
  constructor() {
    super("kill switch engaged: dispatch refused, human action required to resume");
    this.name = "KillSwitchEngagedError";
  }
}

interface NodeMeta {
  dependencies: readonly string[];
  blockedFrom: NodeState | null;
  activeReservation: string | null;
}

export interface EngineOptions {
  plan: PlanContractT;
  budget: BudgetLedger;
}

export class WorkflowEngine {
  readonly log: LifecycleEventT[] = [];
  private readonly meta = new Map<string, NodeMeta>();
  private readonly approvals = new Map<string, ApprovalT>();
  private readonly budget: BudgetLedger;
  private killSwitch = false;
  private eventCounter = 0;
  private started = false;

  constructor(options: EngineOptions) {
    this.budget = options.budget;
    for (const mod of options.plan.modules) {
      this.meta.set(mod.id, {
        dependencies: mod.dependencies,
        blockedFrom: null,
        activeReservation: null,
      });
    }
  }

  // -- approvals & kill switch --------------------------------------------------

  recordApproval(approval: ApprovalT): void {
    this.approvals.set(approval.kind, approval);
  }

  engageKillSwitch(): void {
    this.killSwitch = true;
  }

  /** Human action only (PRD: kill switch requires human action to resume). */
  disengageKillSwitch(): void {
    this.killSwitch = false;
  }

  killSwitchEngaged(): boolean {
    return this.killSwitch;
  }

  // -- lifecycle drives -----------------------------------------------------------

  /** Approval gate: execution starts only with plan + allocation approvals. */
  start(): void {
    if (!this.approvals.has("plan") || !this.approvals.has("allocation")) {
      throw new EngineError("cannot start: plan and allocation approvals are required");
    }
    this.started = true;
    this.cascadeReady();
  }

  assign(nodeId: string): void {
    this.append(nodeId, "assigned");
  }

  /**
   * Budget gate: metering happens BEFORE dispatch via an atomic reservation.
   * Exceeding the budget blocks the node (`blocked: budget`) instead of
   * dispatching; the kill switch refuses outright.
   */
  startRun(nodeId: string, maxChargeUsd: number): { reservationId: string } {
    if (this.killSwitch) throw new KillSwitchEngagedError();
    const meta = this.requireMeta(nodeId);
    try {
      const reservationId = this.budget.reserve(nodeId, maxChargeUsd);
      meta.activeReservation = reservationId;
      this.append(nodeId, "running");
      return { reservationId };
    } catch (error) {
      if (error instanceof BudgetExceededError) {
        this.block(nodeId, "budget");
        // a dispatch that would breach the project hard cap IS the kill-switch
        // threshold (PRD: auto-triggered by the project budget hard cap)
        if (error.scope === "project" || this.budget.projectHardCapReached()) {
          this.engageKillSwitch();
        }
      }
      throw error;
    }
  }

  /** Worker reported completion -> runner-executed verification begins. */
  completeRun(nodeId: string, actualUsd: number): void {
    const meta = this.requireMeta(nodeId);
    if (meta.activeReservation) {
      this.budget.settle(nodeId, meta.activeReservation, actualUsd);
      meta.activeReservation = null;
    }
    this.append(nodeId, "verifying");
  }

  /** Runner-produced verification result gates entry to review. */
  recordVerification(nodeId: string, passed: boolean): void {
    this.append(nodeId, passed ? "in_review" : "failed");
  }

  reviewerDecision(nodeId: string, decision: "approve" | "rework"): void {
    this.append(nodeId, decision === "approve" ? "verified" : "assigned");
  }

  /** Clean merge into the integration branch; unlocks dependents. */
  integrate(nodeId: string): void {
    this.append(nodeId, "integrated");
    this.cascadeReady();
  }

  block(nodeId: string, reason: BlockedReason): void {
    const meta = this.requireMeta(nodeId);
    meta.blockedFrom = this.stateOf(nodeId);
    this.append(nodeId, "blocked", reason);
  }

  /** Resume to the state the block interrupted (engine remembers which). */
  resume(nodeId: string): void {
    const meta = this.requireMeta(nodeId);
    if (!meta.blockedFrom) throw new EngineError(`node ${nodeId} is not blocked`);
    const target = meta.blockedFrom;
    meta.blockedFrom = null;
    this.append(nodeId, target);
  }

  cancel(nodeId: string): void {
    this.append(nodeId, "cancelled");
  }

  /** Conflict-resolution replacement: the original is archived, not deleted. */
  supersede(nodeId: string): void {
    this.append(nodeId, "superseded");
  }

  // -- state ------------------------------------------------------------------------

  stateOf(nodeId: string): NodeState {
    const reduced = reduceLifecycle(this.log);
    return reduced.nodes[nodeId]?.state ?? "pending";
  }

  states(): Record<string, NodeState> {
    const reduced = reduceLifecycle(this.log);
    const out: Record<string, NodeState> = {};
    for (const nodeId of this.meta.keys()) {
      out[nodeId] = reduced.nodes[nodeId]?.state ?? "pending";
    }
    return out;
  }

  /** Replaying the persisted log must reconstruct identical state. */
  replayFrom(log: readonly LifecycleEventT[]): Record<string, NodeState> {
    const reduced = reduceLifecycle(log);
    const out: Record<string, NodeState> = {};
    for (const [nodeId] of this.meta) {
      out[nodeId] = reduced.nodes[nodeId]?.state ?? "pending";
    }
    return out;
  }

  // -- internals ----------------------------------------------------------------------

  private requireMeta(nodeId: string): NodeMeta {
    const meta = this.meta.get(nodeId);
    if (!meta) throw new EngineError(`unknown node ${nodeId}`);
    return meta;
  }

  private append(nodeId: string, to: NodeState, reason?: string): void {
    this.requireMeta(nodeId);
    const from = this.stateOf(nodeId);
    if (!canTransition(from, to)) {
      throw new EngineError(`invalid transition ${from} -> ${to} for node ${nodeId}`);
    }
    this.eventCounter += 1;
    const event: LifecycleEventT = {
      event_id: `evt_${this.eventCounter}`,
      node_id: nodeId,
      to,
      ...(reason !== undefined ? { reason } : {}),
    };
    this.log.push(event);
  }

  /** Dependency gate: a node becomes ready only when every dep is integrated. */
  private cascadeReady(): void {
    if (!this.started) return;
    for (const [nodeId, meta] of this.meta) {
      if (this.stateOf(nodeId) !== "pending") continue;
      const depsIntegrated = meta.dependencies.every((dep) => this.stateOf(dep) === "integrated");
      if (depsIntegrated) this.append(nodeId, "ready");
    }
  }
}
