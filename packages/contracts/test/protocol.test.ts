import { describe, expect, it } from "vitest";
import {
  COMMAND_TRANSITIONS,
  CommandDedupStore,
  CommandEnvelope,
  EventEnvelope,
  TERMINAL_COMMAND_STATES,
  canCommandTransition,
  isCommandExpired,
} from "../src/protocol.js";

const validCommand = {
  protocol: 1,
  command_id: "cmd-001",
  idempotency_key: "idem-001",
  correlation_id: "corr-001",
  causation_id: null,
  project_id: "proj-1",
  runner_id: "runner-1",
  generation: 3,
  issued_by_session: "sess-1",
  issued_at: "2026-07-14T00:00:00.000Z",
  expires_at: "2026-07-14T00:05:00.000Z",
  payload: { kind: "interrupt", run_id: "run-1" },
} as const;

describe("command envelope", () => {
  it("parses a valid command", () => {
    expect(CommandEnvelope.safeParse(validCommand).success).toBe(true);
  });

  it("rejects envelopes missing correlation_id or generation", () => {
    const { correlation_id: _c, ...noCorrelation } = validCommand;
    expect(CommandEnvelope.safeParse(noCorrelation).success).toBe(false);
    const { generation: _g, ...noGeneration } = validCommand;
    expect(CommandEnvelope.safeParse(noGeneration).success).toBe(false);
  });

  it("rejects unknown payload kinds", () => {
    const bad = { ...validCommand, payload: { kind: "rm_rf_host" } };
    expect(CommandEnvelope.safeParse(bad).success).toBe(false);
  });

  it("computes expiry against a clock", () => {
    expect(isCommandExpired(validCommand, new Date("2026-07-14T00:04:59Z"))).toBe(false);
    expect(isCommandExpired(validCommand, new Date("2026-07-14T00:05:00Z"))).toBe(true);
  });
});

describe("command state machine", () => {
  it("permits the happy path", () => {
    const path = ["queued", "delivered", "accepted", "executing", "succeeded"] as const;
    let from: keyof typeof COMMAND_TRANSITIONS = "created";
    for (const to of path) {
      expect(canCommandTransition(from, to), `${from} -> ${to}`).toBe(true);
      from = to;
    }
  });

  it("terminal states have no exits (first terminal commits)", () => {
    for (const state of TERMINAL_COMMAND_STATES) {
      expect(COMMAND_TRANSITIONS[state]).toHaveLength(0);
    }
    // cancel cannot override a committed completion:
    expect(canCommandTransition("succeeded", "cancelled")).toBe(false);
  });

  it("rejects skipping delivery/acceptance", () => {
    expect(canCommandTransition("created", "executing")).toBe(false);
    expect(canCommandTransition("queued", "succeeded")).toBe(false);
  });
});

describe("command dedup (at-least-once + idempotent execution)", () => {
  it("executes a command exactly once across replays", async () => {
    const store = new CommandDedupStore();
    let executions = 0;
    const run = () => {
      executions += 1;
      return `outcome-${executions}`;
    };

    const first = await store.execute("cmd-001", run);
    const replay = await store.execute("cmd-001", run);

    expect(executions).toBe(1);
    expect(first.duplicate).toBe(false);
    expect(replay.duplicate).toBe(true);
    expect(replay.result).toBe(first.result);
  });

  it("distinct command ids execute independently", async () => {
    const store = new CommandDedupStore();
    let executions = 0;
    await store.execute("a", () => {
      executions += 1;
    });
    await store.execute("b", () => {
      executions += 1;
    });
    expect(executions).toBe(2);
  });
});

describe("event envelope", () => {
  it("parses a valid event and rejects a non-positive seq", () => {
    const event = {
      protocol: 1,
      event_seq: 42,
      runner_id: "runner-1",
      generation: 3,
      correlation_id: "corr-001",
      causation_id: "cmd-001",
      occurred_at: "2026-07-14T00:00:01.000Z",
      payload: { kind: "command_ack", command_id: "cmd-001", state: "accepted", detail: "" },
    };
    expect(EventEnvelope.safeParse(event).success).toBe(true);
    expect(EventEnvelope.safeParse({ ...event, event_seq: 0 }).success).toBe(false);
  });
});
