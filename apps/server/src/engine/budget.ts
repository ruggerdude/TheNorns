// Budget enforcement with atomic reservations (PRD R4 §Budget Enforcement):
// available = approved − settled − active reservations. Each reserve() is a
// synchronous check-and-set, so concurrent dispatch attempts cannot
// oversubscribe. No agent can extend a budget — there is no API for it here;
// extension is a human Approval that constructs a new ledger entry.
import { availableBudgetUsd, budgetThresholdReached } from "@norns/contracts";

export class BudgetExceededError extends Error {
  constructor(
    nodeId: string,
    requested: number,
    available: number,
    readonly scope: "node" | "project" = "node",
  ) {
    super(`budget exceeded for ${nodeId}: requested $${requested}, available $${available}`);
    this.name = "BudgetExceededError";
  }
}

interface NodeBudget {
  approvedUsd: number;
  settledUsd: number;
  reservations: Map<string, number>; // reservation_id -> max charge
}

export class BudgetLedger {
  private readonly nodes = new Map<string, NodeBudget>();
  private reservationCounter = 0;
  private onThreshold: ((nodeId: string) => void) | null = null;

  constructor(private readonly projectCapUsd: number) {}

  /** PM notification hook for the 80% threshold. */
  notifyThreshold(callback: (nodeId: string) => void): void {
    this.onThreshold = callback;
  }

  approve(nodeId: string, approvedUsd: number): void {
    this.nodes.set(nodeId, { approvedUsd, settledUsd: 0, reservations: new Map() });
  }

  available(nodeId: string): number {
    const node = this.require(nodeId);
    return availableBudgetUsd(node.approvedUsd, node.settledUsd, this.activeUsd(node));
  }

  /** Atomic: throws BudgetExceededError instead of oversubscribing. */
  reserve(nodeId: string, maxChargeUsd: number): string {
    const node = this.require(nodeId);
    const available = this.available(nodeId);
    if (maxChargeUsd > available) {
      throw new BudgetExceededError(nodeId, maxChargeUsd, available);
    }
    if (this.projectActiveUsd() + this.projectSettledUsd() + maxChargeUsd > this.projectCapUsd) {
      throw new BudgetExceededError("project-cap", maxChargeUsd, this.projectCapUsd, "project");
    }
    this.reservationCounter += 1;
    const id = `res_${this.reservationCounter}`;
    node.reservations.set(id, maxChargeUsd);
    if (budgetThresholdReached(node.approvedUsd, node.settledUsd, this.activeUsd(node))) {
      this.onThreshold?.(nodeId);
    }
    return id;
  }

  /** Settle against actual usage; the unused remainder is released. */
  settle(nodeId: string, reservationId: string, actualUsd: number): void {
    const node = this.require(nodeId);
    const held = node.reservations.get(reservationId);
    if (held === undefined) throw new Error(`unknown reservation ${reservationId}`);
    node.reservations.delete(reservationId);
    node.settledUsd += Math.min(actualUsd, held); // per-call cap bounds overshoot
  }

  release(nodeId: string, reservationId: string): void {
    this.require(nodeId).reservations.delete(reservationId);
  }

  settledUsd(nodeId: string): number {
    return this.require(nodeId).settledUsd;
  }

  activeReservationsUsd(nodeId: string): number {
    return this.activeUsd(this.require(nodeId));
  }

  projectHardCapReached(): boolean {
    return this.projectSettledUsd() + this.projectActiveUsd() >= this.projectCapUsd;
  }

  /** Ledger rollup for the dashboard — settled, held, approved, cap. */
  summary(): {
    settled_usd: number;
    active_reservations_usd: number;
    approved_usd: number;
    project_cap_usd: number;
  } {
    let approved = 0;
    for (const node of this.nodes.values()) approved += node.approvedUsd;
    return {
      settled_usd: this.projectSettledUsd(),
      active_reservations_usd: this.projectActiveUsd(),
      approved_usd: approved,
      project_cap_usd: this.projectCapUsd,
    };
  }

  private require(nodeId: string): NodeBudget {
    const node = this.nodes.get(nodeId);
    if (!node) throw new Error(`no approved budget for node ${nodeId}`);
    return node;
  }

  private activeUsd(node: NodeBudget): number {
    let total = 0;
    for (const amount of node.reservations.values()) total += amount;
    return total;
  }

  private projectActiveUsd(): number {
    let total = 0;
    for (const node of this.nodes.values()) total += this.activeUsd(node);
    return total;
  }

  private projectSettledUsd(): number {
    let total = 0;
    for (const node of this.nodes.values()) total += node.settledUsd;
    return total;
  }
}
