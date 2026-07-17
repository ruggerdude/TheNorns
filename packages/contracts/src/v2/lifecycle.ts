import { z } from "zod";
import { V2EntityId, V2IsoDateTime, V2PositiveVersion } from "./common.js";

export const V2TaskState = z.enum([
  "pending",
  "ready",
  "assigned",
  "in_progress",
  "verifying",
  "in_review",
  "completed",
  "blocked",
  "failed",
  "cancelled",
]);
export type V2TaskStateT = z.infer<typeof V2TaskState>;

export const V2_TASK_STATES = V2TaskState.options;

export const V2_TASK_TRANSITIONS: Record<V2TaskStateT, readonly V2TaskStateT[]> = {
  pending: ["ready", "blocked", "cancelled"],
  ready: ["assigned", "blocked", "cancelled"],
  assigned: ["in_progress", "blocked", "cancelled"],
  in_progress: ["verifying", "blocked", "failed", "cancelled"],
  verifying: ["in_review", "in_progress", "blocked", "failed", "cancelled"],
  in_review: ["completed", "in_progress", "blocked", "failed", "cancelled"],
  completed: [],
  blocked: ["ready", "assigned", "in_progress", "verifying", "in_review", "failed", "cancelled"],
  failed: ["in_progress", "cancelled"],
  cancelled: [],
};

export const V2_TERMINAL_TASK_STATES: ReadonlySet<V2TaskStateT> = new Set([
  "completed",
  "cancelled",
]);

export function v2CanTaskTransition(from: V2TaskStateT, to: V2TaskStateT): boolean {
  return V2_TASK_TRANSITIONS[from].includes(to);
}

export const V2AgentRunState = z.enum([
  "created",
  "dispatched",
  "running",
  "verifying",
  "succeeded",
  "failed",
  "cancelled",
  "expired",
]);
export type V2AgentRunStateT = z.infer<typeof V2AgentRunState>;

export const V2_AGENT_RUN_STATES = V2AgentRunState.options;

export const V2_AGENT_RUN_TRANSITIONS: Record<V2AgentRunStateT, readonly V2AgentRunStateT[]> = {
  created: ["dispatched", "cancelled", "expired"],
  dispatched: ["running", "failed", "cancelled", "expired"],
  running: ["verifying", "failed", "cancelled"],
  verifying: ["succeeded", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
  expired: [],
};

export const V2_TERMINAL_AGENT_RUN_STATES: ReadonlySet<V2AgentRunStateT> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "expired",
]);

export function v2CanAgentRunTransition(from: V2AgentRunStateT, to: V2AgentRunStateT): boolean {
  return V2_AGENT_RUN_TRANSITIONS[from].includes(to);
}

const transitionBase = {
  schema_version: z.literal(2),
  event_id: V2EntityId,
  lifecycle_version: V2PositiveVersion,
  occurred_at: V2IsoDateTime,
};

export const V2TaskTransitionEvent = z
  .object({
    ...transitionBase,
    task_id: V2EntityId,
    from: V2TaskState,
    to: V2TaskState,
    reason: z.string().nullable(),
  })
  .strict()
  .superRefine((event, ctx) => {
    if (!v2CanTaskTransition(event.from, event.to)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["to"],
        message: `invalid Task transition ${event.from} -> ${event.to}`,
      });
    }
  });
export type V2TaskTransitionEventT = z.infer<typeof V2TaskTransitionEvent>;

export const V2AgentRunTransitionEvent = z
  .object({
    ...transitionBase,
    run_id: V2EntityId,
    task_id: V2EntityId,
    from: V2AgentRunState,
    to: V2AgentRunState,
    reason: z.string().nullable(),
  })
  .strict()
  .superRefine((event, ctx) => {
    if (!v2CanAgentRunTransition(event.from, event.to)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["to"],
        message: `invalid AgentRun transition ${event.from} -> ${event.to}`,
      });
    }
  });
export type V2AgentRunTransitionEventT = z.infer<typeof V2AgentRunTransitionEvent>;

export interface V2LifecycleReduction<TState extends string> {
  state: TState;
  version: number;
  applied_event_ids: string[];
  rejected_event_ids: string[];
}

function reduceV2Lifecycle<TState extends string>(
  initialState: TState,
  initialVersion: number,
  events: readonly {
    event_id: string;
    lifecycle_version: number;
    from: TState;
    to: TState;
  }[],
  canTransition: (from: TState, to: TState) => boolean,
): V2LifecycleReduction<TState> {
  let state = initialState;
  let version = initialVersion;
  const applied: string[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>();

  for (const event of events) {
    if (seen.has(event.event_id)) continue;
    seen.add(event.event_id);
    if (
      event.from !== state ||
      event.lifecycle_version !== version + 1 ||
      !canTransition(state, event.to)
    ) {
      rejected.push(event.event_id);
      continue;
    }
    state = event.to;
    version = event.lifecycle_version;
    applied.push(event.event_id);
  }

  return {
    state,
    version,
    applied_event_ids: applied,
    rejected_event_ids: rejected,
  };
}

export function reduceV2TaskLifecycle(
  initialState: V2TaskStateT,
  initialVersion: number,
  events: readonly V2TaskTransitionEventT[],
): V2LifecycleReduction<V2TaskStateT> {
  return reduceV2Lifecycle(initialState, initialVersion, events, v2CanTaskTransition);
}

export function reduceV2AgentRunLifecycle(
  initialState: V2AgentRunStateT,
  initialVersion: number,
  events: readonly V2AgentRunTransitionEventT[],
): V2LifecycleReduction<V2AgentRunStateT> {
  return reduceV2Lifecycle(initialState, initialVersion, events, v2CanAgentRunTransition);
}

export const V2RunFailureDisposition = z.enum(["blocked", "failed"]);
export type V2RunFailureDispositionT = z.infer<typeof V2RunFailureDisposition>;

export const V2TaskRunProjectionInput = z
  .object({
    task_state: V2TaskState,
    designated_run_id: V2EntityId.nullable(),
    run_id: V2EntityId,
    run_state: V2AgentRunState,
    run_is_designated: z.boolean(),
    run_superseded_at: V2IsoDateTime.nullable(),
    verification_status: z.enum(["pending", "passed", "failed"]),
    failure_disposition: V2RunFailureDisposition,
  })
  .strict();
export type V2TaskRunProjectionInputT = z.infer<typeof V2TaskRunProjectionInput>;

export const V2TaskRunProjectionResult = z
  .object({
    state: V2TaskState,
    applied: z.boolean(),
    reason: z.enum([
      "projected",
      "task_terminal",
      "not_designated",
      "superseded",
      "awaiting_green_verification",
      "no_state_change",
      "invalid_task_transition",
    ]),
  })
  .strict();
export type V2TaskRunProjectionResultT = z.infer<typeof V2TaskRunProjectionResult>;

/**
 * Pure projection from the designated AgentRun into Task lifecycle state.
 * Review/integration evidence owns Task.completed; a run can project no
 * further than Task.in_review.
 */
export function projectV2TaskStateFromRun(
  input: V2TaskRunProjectionInputT,
): V2TaskRunProjectionResultT {
  if (V2_TERMINAL_TASK_STATES.has(input.task_state)) {
    return { state: input.task_state, applied: false, reason: "task_terminal" };
  }
  if (
    !input.run_is_designated ||
    input.designated_run_id === null ||
    input.designated_run_id !== input.run_id
  ) {
    return { state: input.task_state, applied: false, reason: "not_designated" };
  }
  if (input.run_superseded_at !== null) {
    return { state: input.task_state, applied: false, reason: "superseded" };
  }

  let targetState: V2TaskStateT;
  let projectionReason: "projected" | "awaiting_green_verification" = "projected";
  switch (input.run_state) {
    case "created":
    case "dispatched":
    case "running":
      targetState = "in_progress";
      break;
    case "verifying":
      targetState = "verifying";
      break;
    case "succeeded":
      if (input.verification_status !== "passed") {
        targetState = "verifying";
        projectionReason = "awaiting_green_verification";
        break;
      }
      targetState = "in_review";
      break;
    case "failed":
      targetState = input.failure_disposition;
      break;
    case "cancelled":
    case "expired":
      targetState = "blocked";
      break;
  }

  if (targetState === input.task_state) {
    return {
      state: input.task_state,
      applied: false,
      reason:
        projectionReason === "awaiting_green_verification"
          ? "awaiting_green_verification"
          : "no_state_change",
    };
  }
  if (!v2CanTaskTransition(input.task_state, targetState)) {
    return {
      state: input.task_state,
      applied: false,
      reason: "invalid_task_transition",
    };
  }
  return { state: targetState, applied: true, reason: projectionReason };
}
