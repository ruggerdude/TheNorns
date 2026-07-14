import { describe, expect, it } from "vitest";
import {
  type NODE_STATES,
  NODE_TRANSITIONS,
  TERMINAL_NODE_STATES,
  canTransition,
} from "../src/lifecycle.js";
import { type LifecycleEventT, reduceLifecycle } from "../src/reducer.js";

describe("node lifecycle", () => {
  it("permits the happy path end to end", () => {
    const path = [
      "ready",
      "assigned",
      "running",
      "verifying",
      "in_review",
      "verified",
      "integrated",
    ] as const;
    let from: (typeof NODE_STATES)[number] = "pending";
    for (const to of path) {
      expect(canTransition(from, to), `${from} -> ${to}`).toBe(true);
      from = to;
    }
  });

  it("terminal states have no exits", () => {
    for (const state of TERMINAL_NODE_STATES) {
      expect(NODE_TRANSITIONS[state]).toHaveLength(0);
    }
  });

  it("rejects gate-skipping (running -> verified, pending -> integrated)", () => {
    expect(canTransition("running", "verified")).toBe(false);
    expect(canTransition("pending", "integrated")).toBe(false);
    expect(canTransition("verifying", "verified")).toBe(false); // review gate is mandatory
  });

  it("supports rework, retry, conflict-supersession paths", () => {
    expect(canTransition("in_review", "assigned")).toBe(true); // reviewer rework
    expect(canTransition("failed", "assigned")).toBe(true); // retry
    expect(canTransition("verified", "blocked")).toBe(true); // integration conflict
    expect(canTransition("verified", "superseded")).toBe(true); // conflict node replaces
  });
});

describe("reduceLifecycle — determinism and idempotency (Phase 0B harness)", () => {
  const log: LifecycleEventT[] = [
    { event_id: "e1", node_id: "n1", to: "ready" },
    { event_id: "e2", node_id: "n1", to: "assigned" },
    { event_id: "e3", node_id: "n2", to: "ready" },
    { event_id: "e4", node_id: "n1", to: "running" },
    { event_id: "e5", node_id: "n1", to: "verifying" },
    { event_id: "e6", node_id: "n2", to: "cancelled" },
  ];

  it("is deterministic: same log, same state, byte for byte", () => {
    const a = reduceLifecycle(log);
    const b = reduceLifecycle(log);
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });

  it("is idempotent: replayed events are exact no-ops", () => {
    const withDuplicates = [log[0], ...log, log[2], log[4]].filter(
      (e): e is LifecycleEventT => e !== undefined,
    );
    expect(JSON.stringify(reduceLifecycle(withDuplicates))).toEqual(
      JSON.stringify(reduceLifecycle(log)),
    );
  });

  it("rejects invalid transitions without corrupting state", () => {
    const result = reduceLifecycle([
      { event_id: "e1", node_id: "n1", to: "ready" },
      { event_id: "bad", node_id: "n1", to: "integrated" }, // gate-skip
      { event_id: "e2", node_id: "n1", to: "assigned" },
    ]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.event_id).toBe("bad");
    expect(result.nodes.n1?.state).toBe("assigned");
    expect(result.nodes.n1?.history).toEqual(["pending", "ready", "assigned"]);
  });

  it("replays to identical state from a persisted log (event-sourcing contract)", () => {
    const first = reduceLifecycle(log);
    const replayed = reduceLifecycle(JSON.parse(JSON.stringify(log)) as LifecycleEventT[]);
    expect(replayed).toEqual(first);
  });
});
