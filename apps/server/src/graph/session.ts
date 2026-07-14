// A graph-editing session over one project's workflow graph, plus the
// 10-node demo plan the Phase 4 exit criterion is demonstrated against.
import type { ApprovalT, PlanContractT } from "@norns/contracts";
import { validatePlan } from "@norns/contracts";
import type { AllocationApprovalRecord, AllocationApprovalStatus } from "./allocation.js";
import { WorkflowGraph } from "./graph.js";

export class GraphSession {
  readonly graph: WorkflowGraph;
  plan: PlanContractT;
  /** ADR-1: server-authoritative last-approved allocation, persisted (not just
   *  held in the client). null until the human approves an allocation. */
  private approvalRecord: AllocationApprovalRecord | null = null;

  constructor(plan: PlanContractT) {
    this.plan = plan;
    this.graph = WorkflowGraph.fromPlan(plan);
  }

  /** Record a fresh allocation approval, binding it to the graph's current
   *  version + allocation fingerprint so staleness can be judged later. */
  recordApproval(approval: ApprovalT): void {
    this.approvalRecord = {
      content_hash: approval.content_hash,
      graph_version: this.graph.version,
      allocation_fingerprint: this.graph.allocationFingerprint,
      actor: approval.actor,
      approved_at: approval.approved_at,
    };
  }

  /** The approval banner payload for the graph API: null if never approved,
   *  else the stored evidence plus a server-computed `current` flag. */
  approvalStatus(): AllocationApprovalStatus | null {
    if (!this.approvalRecord) return null;
    const current =
      this.approvalRecord.graph_version === this.graph.version &&
      this.approvalRecord.allocation_fingerprint === this.graph.allocationFingerprint;
    return {
      content_hash: this.approvalRecord.content_hash,
      approved_at: this.approvalRecord.approved_at,
      actor: this.approvalRecord.actor,
      current,
    };
  }

  /** Persistence hooks (Tier-2 snapshot round-trip via ProjectStore). */
  get storedApproval(): AllocationApprovalRecord | null {
    return this.approvalRecord;
  }
  restoreApproval(record: AllocationApprovalRecord | null): void {
    this.approvalRecord = record;
  }

  static demo(): GraphSession {
    const result = validatePlan(DEMO_PLAN);
    if (!result.ok) {
      throw new Error(`demo plan invalid: ${result.errors.map((e) => e.message).join("; ")}`);
    }
    return new GraphSession(result.plan);
  }

  /**
   * Replace the live plan+graph with the output of a (human-reviewed) live
   * planning run. Mutates the existing graph instance in place — the server
   * already holds a reference to it — so the change is visible immediately.
   */
  loadPlan(plan: PlanContractT): void {
    const result = validatePlan(plan);
    if (!result.ok) {
      throw new Error(`plan failed validation: ${result.errors.map((e) => e.message).join("; ")}`);
    }
    this.plan = result.plan;
    this.graph.restoreFrom(WorkflowGraph.fromPlan(result.plan).snapshot());
    // A brand-new plan replaces the graph wholesale; any prior approval no
    // longer describes anything real.
    this.approvalRecord = null;
  }
}

function mod(
  id: string,
  title: string,
  complexity: "S" | "M" | "L" | "XL",
  risk: "low" | "medium" | "high" | "critical",
  dependencies: string[],
  parallelSafe = false,
) {
  return {
    id,
    title,
    description: title,
    deliverables: [`${id} deliverable`],
    acceptance: [
      {
        id: "AC-1",
        statement: `${id} acceptance passes`,
        verification_type: "command",
        verification: "pnpm test",
      },
    ],
    dependencies,
    estimated_complexity: complexity,
    risk,
    parallelization: {
      safe: parallelSafe,
      candidate_work_units: parallelSafe ? ["unit-a", "unit-b"] : [],
      shared_files: [],
      integration_owner_required: true,
    },
  };
}

/** Ten nodes, layered DAG — the Phase 4 acceptance graph. */
export const DEMO_PLAN = {
  objective: "Demo: build the TheNorns pilot service",
  modules: [
    mod("contracts", "Shared contracts", "M", "medium", []),
    mod("db-schema", "Database schema", "M", "low", ["contracts"]),
    mod("auth", "Authentication", "S", "critical", ["contracts"]),
    mod("api-core", "Core API", "L", "medium", ["db-schema", "auth"]),
    mod("worker-queue", "Worker queue", "M", "high", ["db-schema"]),
    mod("integration-layer", "Integration layer", "XL", "high", ["api-core", "worker-queue"], true),
    mod("web-ui", "Web UI", "L", "low", ["api-core"], true),
    mod("notifications", "Notifications", "S", "low", ["worker-queue"]),
    mod("observability", "Observability", "M", "low", ["integration-layer"]),
    mod("release", "Release hardening", "M", "high", ["web-ui", "notifications", "observability"]),
  ],
};
