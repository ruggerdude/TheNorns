// Node lifecycle (PRD R4 §Graph & Execution Workflow). The engine owns these
// states; gate transitions are objective. `in_review` is deliberately not
// named `review` to avoid colliding with the Review entity. `superseded`
// marks a node replaced by a conflict-resolution node.

export const NODE_STATES = [
  "pending",
  "ready",
  "assigned",
  "running",
  "verifying",
  "in_review",
  "verified",
  "integrated",
  "blocked",
  "failed",
  "cancelled",
  "superseded",
] as const;

export type NodeState = (typeof NODE_STATES)[number];

export const BLOCKED_REASONS = ["dependency", "budget", "runner", "integration"] as const;
export type BlockedReason = (typeof BLOCKED_REASONS)[number];

export const TERMINAL_NODE_STATES: ReadonlySet<NodeState> = new Set([
  "integrated",
  "cancelled",
  "superseded",
]);

export const NODE_TRANSITIONS: Record<NodeState, readonly NodeState[]> = {
  pending: ["ready", "cancelled"],
  ready: ["assigned", "blocked", "cancelled"],
  assigned: ["running", "blocked", "cancelled"],
  running: ["verifying", "blocked", "failed", "cancelled"],
  verifying: ["in_review", "failed", "blocked", "cancelled"],
  // in_review -> assigned is reviewer-requested rework
  in_review: ["verified", "assigned", "failed", "cancelled"],
  // verified -> blocked is `blocked: integration` (conflict); the engine then
  // spawns a conflict-resolution node and the original becomes superseded.
  verified: ["integrated", "blocked", "superseded"],
  // blocked resumes to the state it interrupted (engine records which).
  blocked: [
    "ready",
    "assigned",
    "running",
    "verifying",
    "in_review",
    "verified",
    "cancelled",
    "superseded",
  ],
  failed: ["assigned", "cancelled", "superseded"],
  integrated: [],
  cancelled: [],
  superseded: [],
};

export function isNodeState(value: string): value is NodeState {
  return (NODE_STATES as readonly string[]).includes(value);
}

export function canTransition(from: NodeState, to: NodeState): boolean {
  return NODE_TRANSITIONS[from].includes(to);
}
