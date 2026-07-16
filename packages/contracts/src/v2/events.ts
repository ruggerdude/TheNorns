import { z } from "zod";
import {
  V2ActorType,
  V2EntityId,
  V2EntityRef,
  V2IsoDateTime,
  V2NonEmptyString,
  V2PositiveVersion,
  V2Sha256Hex,
} from "./common.js";
import {
  V2AgentRunState,
  V2TaskState,
  v2CanAgentRunTransition,
  v2CanTaskTransition,
} from "./lifecycle.js";

export const V2DomainStreamType = z.enum([
  "project",
  "phase",
  "strategy_version",
  "task",
  "agent_assignment",
  "agent_run",
  "decision_point",
  "budget_reservation",
  "dispatch_job",
]);
export type V2DomainStreamTypeT = z.infer<typeof V2DomainStreamType>;

export const V2DomainEventPayload = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("task_state_transitioned"),
      task_id: V2EntityId,
      lifecycle_version: V2PositiveVersion,
      from: V2TaskState,
      to: V2TaskState,
      reason: z.string().nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("agent_run_state_transitioned"),
      run_id: V2EntityId,
      task_id: V2EntityId,
      lifecycle_version: V2PositiveVersion,
      from: V2AgentRunState,
      to: V2AgentRunState,
      reason: z.string().nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("strategy_version_approved"),
      strategy_version_id: V2EntityId,
      content_hash: V2Sha256Hex,
      materialized_objective_ids: z.array(V2EntityId),
      materialized_task_ids: z.array(V2EntityId),
    })
    .strict(),
  z
    .object({
      kind: z.literal("agent_assignment_created"),
      assignment_id: V2EntityId,
      task_id: V2EntityId,
      agent_profile_id: V2EntityId,
      rationale: V2NonEmptyString,
    })
    .strict(),
  z
    .object({
      kind: z.literal("decision_point_opened"),
      decision_point_id: V2EntityId,
      condition_key: V2NonEmptyString,
      condition_fingerprint: V2Sha256Hex,
    })
    .strict(),
  z
    .object({
      kind: z.literal("decision_point_resolved"),
      decision_point_id: V2EntityId,
      decision_record_id: V2EntityId,
      selected_option_id: V2EntityId,
    })
    .strict(),
  z
    .object({
      kind: z.literal("budget_reservation_resolved"),
      reservation_id: V2EntityId,
      task_id: V2EntityId,
      run_id: V2EntityId,
      outcome: z.enum([
        "success",
        "partial_usage",
        "cancelled",
        "expired",
        "rejected",
        "dead_letter",
        "ambiguous_execution",
      ]),
      settled_usd: z.number().nonnegative(),
      released_usd: z.number().nonnegative(),
      retained_usd: z.number().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("dispatch_command_created"),
      dispatch_job_id: V2EntityId,
      command_id: V2EntityId,
      task_id: V2EntityId,
      run_id: V2EntityId,
      budget_reservation_id: V2EntityId,
    })
    .strict(),
]);
export type V2DomainEventPayloadT = z.infer<typeof V2DomainEventPayload>;

export const V2DomainEvent = z
  .object({
    schema_version: z.literal(2),
    event_id: V2EntityId,
    stream_type: V2DomainStreamType,
    stream_id: V2EntityId,
    stream_version: V2PositiveVersion,
    event_type: V2NonEmptyString,
    project_id: V2EntityId,
    phase_id: V2EntityId.nullable(),
    task_id: V2EntityId.nullable(),
    actor_type: V2ActorType,
    actor_id: V2EntityId.nullable(),
    correlation_id: V2EntityId,
    causation_id: V2EntityId.nullable(),
    occurred_at: V2IsoDateTime,
    payload: V2DomainEventPayload,
  })
  .strict()
  .superRefine((event, ctx) => {
    const linkageIssue = (message: string): void => {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["payload"],
        message,
      });
    };
    if (event.event_type !== event.payload.kind) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["event_type"],
        message: "event_type must equal payload.kind",
      });
    }
    switch (event.payload.kind) {
      case "task_state_transitioned":
        if (
          !v2CanTaskTransition(event.payload.from, event.payload.to) ||
          event.stream_type !== "task" ||
          event.stream_id !== event.payload.task_id ||
          event.task_id !== event.payload.task_id ||
          event.phase_id === null
        ) {
          linkageIssue(
            "Task transition requires a valid Task stream with matching stream_id and task_id",
          );
        }
        break;
      case "agent_run_state_transitioned":
        if (
          !v2CanAgentRunTransition(event.payload.from, event.payload.to) ||
          event.stream_type !== "agent_run" ||
          event.stream_id !== event.payload.run_id ||
          event.task_id !== event.payload.task_id ||
          event.phase_id === null
        ) {
          linkageIssue(
            "AgentRun transition requires a matching AgentRun stream and owning task identity",
          );
        }
        break;
      case "strategy_version_approved":
        if (
          event.stream_type !== "strategy_version" ||
          event.stream_id !== event.payload.strategy_version_id ||
          event.phase_id === null
        ) {
          linkageIssue("Strategy approval requires its matching StrategyVersion stream and Phase");
        }
        break;
      case "agent_assignment_created":
        if (
          event.stream_type !== "agent_assignment" ||
          event.stream_id !== event.payload.assignment_id ||
          event.task_id !== event.payload.task_id ||
          event.phase_id === null
        ) {
          linkageIssue(
            "Assignment creation requires its matching AgentAssignment stream and Task identity",
          );
        }
        break;
      case "decision_point_opened":
      case "decision_point_resolved":
        if (
          event.stream_type !== "decision_point" ||
          event.stream_id !== event.payload.decision_point_id
        ) {
          linkageIssue("DecisionPoint event requires its matching DecisionPoint stream");
        }
        break;
      case "budget_reservation_resolved":
        if (
          event.stream_type !== "budget_reservation" ||
          event.stream_id !== event.payload.reservation_id ||
          event.task_id !== event.payload.task_id ||
          event.phase_id === null
        ) {
          linkageIssue(
            "Budget resolution requires its matching reservation stream and Task identity",
          );
        }
        break;
      case "dispatch_command_created":
        if (
          event.stream_type !== "dispatch_job" ||
          event.stream_id !== event.payload.dispatch_job_id ||
          event.task_id !== event.payload.task_id ||
          event.phase_id === null
        ) {
          linkageIssue(
            "Dispatch creation requires its matching DispatchJob stream and Task identity",
          );
        }
        break;
    }
    if (event.actor_type === "human" && event.actor_id === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["actor_id"],
        message: "human domain events require an attributable actor",
      });
    }
  });
export type V2DomainEventT = z.infer<typeof V2DomainEvent>;

export const V2AuditOutcome = z.enum(["allowed", "denied", "succeeded", "failed", "observed"]);
export const V2AuditSeverity = z.enum(["info", "warning", "error", "critical"]);

export const V2AuditEvent = z
  .object({
    schema_version: z.literal(2),
    audit_id: V2EntityId,
    audit_type: V2NonEmptyString,
    project_id: V2EntityId.nullable(),
    phase_id: V2EntityId.nullable(),
    task_id: V2EntityId.nullable(),
    actor_type: V2ActorType,
    actor_id: V2EntityId.nullable(),
    outcome: V2AuditOutcome,
    severity: V2AuditSeverity,
    correlation_id: V2EntityId,
    causation_id: V2EntityId.nullable(),
    occurred_at: V2IsoDateTime,
    targets: z.array(V2EntityRef),
    summary: V2NonEmptyString,
    details: z.record(z.unknown()),
    redaction_applied: z.boolean(),
  })
  .strict()
  .superRefine((event, ctx) => {
    if (event.actor_type === "human" && event.actor_id === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["actor_id"],
        message: "human audit events require an attributable actor",
      });
    }
  });
export type V2AuditEventT = z.infer<typeof V2AuditEvent>;
