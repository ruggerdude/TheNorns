// Pure, deterministic lifecycle reducer. The Phase 1B workflow engine wraps
// this in the durable event-sourced store; the contract itself guarantees:
// (1) determinism — same event log, same state, always; (2) idempotency —
// replayed events (same event_id) are no-ops. ADR-001 requires both to hold
// under test before any engine code is written.
import { z } from "zod";
import { type NodeState, canTransition, isNodeState } from "./lifecycle.js";

export const LifecycleEvent = z.object({
  event_id: z.string().min(1),
  node_id: z.string().min(1),
  to: z.string().refine(isNodeState, "not a valid node state"),
  reason: z.string().optional(),
});
export type LifecycleEventT = z.infer<typeof LifecycleEvent>;

export interface NodeSnapshot {
  state: NodeState;
  history: NodeState[];
}

export interface RejectedEvent {
  event_id: string;
  reason: string;
}

export interface ReducedState {
  nodes: Record<string, NodeSnapshot>;
  applied_event_ids: string[];
  rejected: RejectedEvent[];
}

const INITIAL_STATE: NodeState = "pending";

export function reduceLifecycle(events: readonly LifecycleEventT[]): ReducedState {
  const seen = new Set<string>();
  const nodes: Record<string, NodeSnapshot> = {};
  const applied: string[] = [];
  const rejected: RejectedEvent[] = [];

  for (const event of events) {
    if (seen.has(event.event_id)) continue; // idempotent replay: exact no-op
    seen.add(event.event_id);

    const to = event.to as NodeState;
    const node = nodes[event.node_id] ?? { state: INITIAL_STATE, history: [INITIAL_STATE] };
    if (!canTransition(node.state, to)) {
      rejected.push({
        event_id: event.event_id,
        reason: `invalid transition ${node.state} -> ${to} for node ${event.node_id}`,
      });
      continue;
    }
    node.state = to;
    node.history.push(to);
    nodes[event.node_id] = node;
    applied.push(event.event_id);
  }

  return { nodes, applied_event_ids: applied, rejected };
}
