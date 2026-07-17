import { describe, expect, it } from "vitest";
import {
  V2AgentRunTransitionEvent,
  V2TaskTransitionEvent,
  V2_AGENT_RUN_STATES,
  V2_AGENT_RUN_TRANSITIONS,
  V2_TASK_STATES,
  V2_TASK_TRANSITIONS,
  projectV2TaskStateFromRun,
  reduceV2AgentRunLifecycle,
  reduceV2TaskLifecycle,
  v2CanAgentRunTransition,
  v2CanTaskTransition,
} from "../src/v2/index.js";
import type {
  V2AgentRunStateT,
  V2AgentRunTransitionEventT,
  V2TaskStateT,
  V2TaskTransitionEventT,
} from "../src/v2/index.js";

const NOW = "2026-07-16T12:00:00.000Z";

function taskEvent(
  id: string,
  lifecycleVersion: number,
  from: V2TaskStateT,
  to: V2TaskStateT,
): V2TaskTransitionEventT {
  return V2TaskTransitionEvent.parse({
    schema_version: 2,
    event_id: id,
    task_id: "task-1",
    lifecycle_version: lifecycleVersion,
    occurred_at: NOW,
    from,
    to,
    reason: null,
  });
}

function runEvent(
  id: string,
  lifecycleVersion: number,
  from: V2AgentRunStateT,
  to: V2AgentRunStateT,
): V2AgentRunTransitionEventT {
  return V2AgentRunTransitionEvent.parse({
    schema_version: 2,
    event_id: id,
    run_id: "run-1",
    task_id: "task-1",
    lifecycle_version: lifecycleVersion,
    occurred_at: NOW,
    from,
    to,
    reason: null,
  });
}

describe("V2 Task lifecycle", () => {
  it("exhaustively agrees across every state pair and event schema", () => {
    for (const from of V2_TASK_STATES) {
      for (const to of V2_TASK_STATES) {
        const expected = V2_TASK_TRANSITIONS[from].includes(to);
        expect(v2CanTaskTransition(from, to), `${from} -> ${to}`).toBe(expected);
        const parsed = V2TaskTransitionEvent.safeParse({
          schema_version: 2,
          event_id: `${from}-${to}`,
          task_id: "task-1",
          lifecycle_version: 1,
          occurred_at: NOW,
          from,
          to,
          reason: null,
        });
        expect(parsed.success, `schema ${from} -> ${to}`).toBe(expected);
        if (parsed.success) {
          expect(reduceV2TaskLifecycle(from, 0, [parsed.data])).toMatchObject({
            state: to,
            version: 1,
            rejected_event_ids: [],
          });
        }
      }
    }
  });

  it("reduces a complete evidence-gated path deterministically and idempotently", () => {
    const events = [
      taskEvent("t1", 1, "pending", "ready"),
      taskEvent("t2", 2, "ready", "assigned"),
      taskEvent("t3", 3, "assigned", "in_progress"),
      taskEvent("t4", 4, "in_progress", "verifying"),
      taskEvent("t5", 5, "verifying", "in_review"),
      taskEvent("t6", 6, "in_review", "completed"),
    ];
    const expected = reduceV2TaskLifecycle("pending", 0, events);
    expect(expected).toMatchObject({ state: "completed", version: 6, rejected_event_ids: [] });
    expect(reduceV2TaskLifecycle("pending", 0, events)).toEqual(expected);
    expect(reduceV2TaskLifecycle("pending", 0, [...events, ...events])).toEqual(expected);
  });

  it("rejects lifecycle gaps without confusing aggregate metadata versions", () => {
    const result = reduceV2TaskLifecycle("ready", 4, [
      taskEvent("wrong-version", 6, "ready", "assigned"),
      taskEvent("correct", 5, "ready", "assigned"),
    ]);
    expect(result).toEqual({
      state: "assigned",
      version: 5,
      applied_event_ids: ["correct"],
      rejected_event_ids: ["wrong-version"],
    });
  });
});

describe("V2 AgentRun lifecycle", () => {
  it("exhaustively agrees across every state pair and freezes terminal outcomes", () => {
    for (const from of V2_AGENT_RUN_STATES) {
      for (const to of V2_AGENT_RUN_STATES) {
        const expected = V2_AGENT_RUN_TRANSITIONS[from].includes(to);
        expect(v2CanAgentRunTransition(from, to), `${from} -> ${to}`).toBe(expected);
        const parsed = V2AgentRunTransitionEvent.safeParse({
          schema_version: 2,
          event_id: `${from}-${to}`,
          run_id: "run-1",
          task_id: "task-1",
          lifecycle_version: 1,
          occurred_at: NOW,
          from,
          to,
          reason: null,
        });
        expect(parsed.success, `schema ${from} -> ${to}`).toBe(expected);
        if (parsed.success) {
          expect(reduceV2AgentRunLifecycle(from, 0, [parsed.data])).toMatchObject({
            state: to,
            version: 1,
            rejected_event_ids: [],
          });
        }
      }
    }
    for (const terminal of ["succeeded", "failed", "cancelled", "expired"] as const) {
      expect(V2_AGENT_RUN_TRANSITIONS[terminal]).toHaveLength(0);
    }
  });

  it("reduces a run path and treats exact event replay as a no-op", () => {
    const events = [
      runEvent("r1", 1, "created", "dispatched"),
      runEvent("r2", 2, "dispatched", "running"),
      runEvent("r3", 3, "running", "verifying"),
      runEvent("r4", 4, "verifying", "succeeded"),
    ];
    const once = reduceV2AgentRunLifecycle("created", 0, events);
    expect(once).toMatchObject({ state: "succeeded", version: 4 });
    expect(
      reduceV2AgentRunLifecycle("created", 0, [
        ...events,
        runEvent("r3", 3, "running", "verifying"),
      ]),
    ).toEqual(once);
  });
});

describe("pure Task-from-AgentRun projection", () => {
  const base = {
    designated_run_id: "run-1",
    run_id: "run-1",
    run_is_designated: true,
    run_superseded_at: null,
    verification_status: "pending",
    failure_disposition: "blocked",
  } as const;

  it("projects every AgentRun state without allowing a run to complete a Task", () => {
    const cases = [
      ["created", "assigned", "in_progress"],
      ["dispatched", "in_progress", "in_progress"],
      ["running", "in_progress", "in_progress"],
      ["verifying", "in_progress", "verifying"],
      ["succeeded", "verifying", "in_review"],
      ["failed", "in_progress", "blocked"],
      ["cancelled", "in_progress", "blocked"],
      ["expired", "in_progress", "blocked"],
    ] as const;
    for (const [runState, taskState, expectedTaskState] of cases) {
      const result = projectV2TaskStateFromRun({
        ...base,
        task_state: taskState,
        run_state: runState,
        verification_status: runState === "succeeded" ? "passed" : "pending",
      });
      expect(result.state, runState).toBe(expectedTaskState);
      expect(result.state, `${runState} cannot complete task`).not.toBe("completed");
      if (result.state !== taskState) {
        expect(
          v2CanTaskTransition(taskState, result.state),
          `${taskState} -> ${result.state}`,
        ).toBe(true);
      }
    }
  });

  it("holds a successful run at verifying until infrastructure evidence is green", () => {
    expect(
      projectV2TaskStateFromRun({
        ...base,
        task_state: "verifying",
        run_state: "succeeded",
        verification_status: "pending",
      }),
    ).toEqual({
      state: "verifying",
      applied: false,
      reason: "awaiting_green_verification",
    });
  });

  it("reports no-op and illegal Task projections without applying them", () => {
    expect(
      projectV2TaskStateFromRun({
        ...base,
        task_state: "in_progress",
        run_state: "running",
      }),
    ).toEqual({
      state: "in_progress",
      applied: false,
      reason: "no_state_change",
    });
    expect(
      projectV2TaskStateFromRun({
        ...base,
        task_state: "pending",
        run_state: "created",
      }),
    ).toEqual({
      state: "pending",
      applied: false,
      reason: "invalid_task_transition",
    });
  });

  it("ignores non-designated and superseded runs", () => {
    expect(
      projectV2TaskStateFromRun({
        ...base,
        task_state: "in_progress",
        run_state: "succeeded",
        run_is_designated: false,
        verification_status: "passed",
      }),
    ).toMatchObject({ state: "in_progress", applied: false, reason: "not_designated" });
    expect(
      projectV2TaskStateFromRun({
        ...base,
        task_state: "in_progress",
        run_state: "failed",
        run_superseded_at: NOW,
      }),
    ).toMatchObject({ state: "in_progress", applied: false, reason: "superseded" });
  });

  it("models retry by superseding the failed attempt and designating a new created run", () => {
    const oldRun = projectV2TaskStateFromRun({
      ...base,
      task_state: "failed",
      run_state: "failed",
      run_is_designated: false,
      run_superseded_at: NOW,
    });
    const retryRun = projectV2TaskStateFromRun({
      ...base,
      task_state: "failed",
      designated_run_id: "run-2",
      run_id: "run-2",
      run_state: "created",
    });
    expect(oldRun).toMatchObject({ state: "failed", applied: false });
    expect(retryRun).toMatchObject({ state: "in_progress", applied: true });
    expect(v2CanTaskTransition("failed", retryRun.state)).toBe(true);
  });

  it("is deterministic over a property-style matrix of valid inputs", () => {
    const taskStates = ["assigned", "in_progress", "verifying", "failed", "completed"] as const;
    for (const taskState of taskStates) {
      for (const runState of V2_AGENT_RUN_STATES) {
        for (const designated of [true, false]) {
          const input = {
            ...base,
            task_state: taskState,
            run_state: runState,
            run_is_designated: designated,
            verification_status: "passed" as const,
          };
          expect(projectV2TaskStateFromRun(input)).toEqual(
            projectV2TaskStateFromRun(structuredClone(input)),
          );
        }
      }
    }
  });

  it("never marks a no-op or illegal Cartesian projection as applied", () => {
    for (const taskState of V2_TASK_STATES) {
      for (const runState of V2_AGENT_RUN_STATES) {
        for (const designated of [true, false]) {
          for (const supersededAt of [null, NOW]) {
            for (const verificationStatus of ["pending", "passed", "failed"] as const) {
              for (const failureDisposition of ["blocked", "failed"] as const) {
                const result = projectV2TaskStateFromRun({
                  ...base,
                  task_state: taskState,
                  run_state: runState,
                  run_is_designated: designated,
                  run_superseded_at: supersededAt,
                  verification_status: verificationStatus,
                  failure_disposition: failureDisposition,
                });
                if (result.applied) {
                  expect(result.state, `${taskState}/${runState} must change`).not.toBe(taskState);
                  expect(
                    v2CanTaskTransition(taskState, result.state),
                    `${taskState} -> ${result.state}`,
                  ).toBe(true);
                }
                if (result.reason === "invalid_task_transition") {
                  expect(result.applied).toBe(false);
                  expect(result.state).toBe(taskState);
                }
              }
            }
          }
        }
      }
    }
  });

  it("cannot project a Task state unreachable from an assigned designated attempt", () => {
    const reachable = new Set<V2TaskStateT>(["assigned"]);
    const queue: V2TaskStateT[] = ["assigned"];
    while (queue.length > 0) {
      const state = queue.shift();
      if (state === undefined) break;
      for (const next of V2_TASK_TRANSITIONS[state]) {
        if (!reachable.has(next)) {
          reachable.add(next);
          queue.push(next);
        }
      }
    }

    for (const runState of V2_AGENT_RUN_STATES) {
      for (const verificationStatus of ["pending", "passed", "failed"] as const) {
        for (const failureDisposition of ["blocked", "failed"] as const) {
          const result = projectV2TaskStateFromRun({
            ...base,
            task_state: "in_progress",
            run_state: runState,
            verification_status: verificationStatus,
            failure_disposition: failureDisposition,
          });
          expect(reachable.has(result.state), `${runState} -> ${result.state}`).toBe(true);
          expect(result.state).not.toBe("completed");
        }
      }
    }
  });
});
