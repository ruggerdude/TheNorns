// Phase 6 dashboard (PRD R4 §PM Dashboard): every figure derives from the
// workflow engine and the usage ledger — never LLM self-report. Progress
// moves only on gate transitions; ETA stays experimental; cost carries
// usage-source labels and a live burn rate; completion badges carry
// provenance, not invented confidence numbers.
import type { NodeState, UsageEventT } from "@norns/contracts";
import type { BudgetLedger } from "./engine/budget.js";
import type { WorkflowEngine } from "./engine/workflow.js";
import type { AuditEntry } from "./stores.js";

const COMPLEXITY_WEIGHT: Record<string, number> = { S: 1, M: 2, L: 3, XL: 5 };

// Gate-derived progress fractions per lifecycle state (deterministic).
const GATE_FRACTION: Record<NodeState, number> = {
  pending: 0,
  ready: 0.1,
  assigned: 0.2,
  running: 0.4,
  verifying: 0.6,
  in_review: 0.75,
  verified: 0.9,
  integrated: 1,
  blocked: 0.3,
  failed: 0.2,
  cancelled: 0,
  superseded: 0,
};

export interface DashboardInputs {
  engine: WorkflowEngine;
  budget: BudgetLedger;
  ledger: readonly UsageEventT[];
  audit: readonly AuditEntry[];
  complexityOf: (nodeId: string) => "S" | "M" | "L" | "XL";
  graphVersion: number;
  timelineLimit?: number;
}

export interface DashboardDto {
  graph_version: number;
  nodes: Record<string, NodeState>;
  blocked: { node_id: string; reason: string }[];
  review_queue: string[];
  progress_pct: number;
  eta: { label: "experimental"; value: null };
  cost: {
    settled_usd: number;
    active_reservations_usd: number;
    approved_usd: number;
    project_cap_usd: number;
    burn_rate_usd_per_hour: number;
  };
  usage_by_source: Record<
    string,
    { input_tokens: number; output_tokens: number; cost_usd: number }
  >;
  kill_switch: boolean;
  timeline: AuditEntry[];
  pm_summary: string;
}

export function buildDashboard(inputs: DashboardInputs): DashboardDto {
  const states = inputs.engine.states();

  // progress: weighted by complexity, moved ONLY by gate transitions
  let earned = 0;
  let total = 0;
  for (const [nodeId, state] of Object.entries(states)) {
    if (state === "cancelled" || state === "superseded") continue;
    const weight = COMPLEXITY_WEIGHT[inputs.complexityOf(nodeId)] ?? 2;
    total += weight;
    earned += weight * GATE_FRACTION[state];
  }
  const progressPct = total === 0 ? 0 : Math.round((earned / total) * 1000) / 10;

  // blocked reasons come from the engine's own lifecycle log
  const blocked: { node_id: string; reason: string }[] = [];
  for (const [nodeId, state] of Object.entries(states)) {
    if (state !== "blocked") continue;
    const lastBlock = [...inputs.engine.log]
      .reverse()
      .find((event) => event.node_id === nodeId && event.to === "blocked");
    blocked.push({ node_id: nodeId, reason: lastBlock?.reason ?? "unknown" });
  }

  // usage rollup by source label — never merged into one unlabeled number
  const bySource: DashboardDto["usage_by_source"] = {};
  for (const event of inputs.ledger) {
    const bucket = bySource[event.usage_source] ?? {
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
    };
    bucket.input_tokens += event.input_tokens;
    bucket.output_tokens += event.output_tokens;
    bucket.cost_usd = Math.round((bucket.cost_usd + event.estimated_cost_usd) * 10000) / 10000;
    bySource[event.usage_source] = bucket;
  }

  // live burn rate from ledger timestamps
  let burnRate = 0;
  if (inputs.ledger.length >= 2) {
    const times = inputs.ledger.map((event) => Date.parse(event.occurred_at)).sort((a, b) => a - b);
    const first = times[0];
    const last = times[times.length - 1];
    const spanHours = first !== undefined && last !== undefined ? (last - first) / 3_600_000 : 0;
    const totalCost = inputs.ledger.reduce((sum, event) => sum + event.estimated_cost_usd, 0);
    burnRate = spanHours > 0 ? Math.round((totalCost / spanHours) * 100) / 100 : 0;
  }

  const reviewQueue = Object.entries(states)
    .filter(([, state]) => state === "in_review")
    .map(([nodeId]) => nodeId);
  const integrated = Object.values(states).filter((state) => state === "integrated").length;

  return {
    graph_version: inputs.graphVersion,
    nodes: states,
    blocked,
    review_queue: reviewQueue,
    progress_pct: progressPct,
    eta: { label: "experimental", value: null },
    cost: { ...inputs.budget.summary(), burn_rate_usd_per_hour: burnRate },
    usage_by_source: bySource,
    kill_switch: inputs.engine.killSwitchEngaged(),
    timeline: [...inputs.audit].slice(-(inputs.timelineLimit ?? 20)),
    pm_summary:
      `${integrated}/${Object.keys(states).length} nodes integrated, ` +
      `${reviewQueue.length} awaiting review, ${blocked.length} blocked` +
      `${inputs.engine.killSwitchEngaged() ? " — KILL SWITCH ENGAGED" : ""}.`,
  };
}
