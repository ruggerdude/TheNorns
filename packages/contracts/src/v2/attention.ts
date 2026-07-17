import { z } from "zod";
import {
  V2EntityId,
  V2EvidenceRef,
  V2IsoDateTime,
  V2NonEmptyString,
  V2Sha256Hex,
} from "./common.js";

export const V2DirectionTarget = z.enum([
  "project_manager",
  "implementation_agent",
  "reviewer",
  "all_agents",
]);
export type V2DirectionTargetT = z.infer<typeof V2DirectionTarget>;

export const V2DecisionOption = z
  .object({
    id: V2EntityId,
    label: V2NonEmptyString,
    impact: V2NonEmptyString,
    risk: V2NonEmptyString,
  })
  .strict();

export const V2DecisionOptions = z
  .array(V2DecisionOption)
  .min(1)
  .superRefine((options, ctx) => {
    const ids = new Set<string>();
    for (const [index, option] of options.entries()) {
      if (ids.has(option.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, "id"],
          message: "decision option ids must be unique",
        });
      }
      ids.add(option.id);
    }
  });

export const V2AttentionSourceType = z.enum([
  "decision_point",
  "strategy_version",
  "task",
  "agent_run",
  "budget_reservation",
  "phase",
]);
export const V2AttentionKind = z.enum([
  "decision",
  "approval",
  "blocker",
  "failed_run",
  "stalled_run",
  "budget_exception",
  "milestone",
]);
export const V2AttentionSeverity = z.enum(["critical", "high", "normal", "low"]);

export const V2AttentionItem = z
  .object({
    key: V2NonEmptyString,
    project_id: V2EntityId,
    project_name: V2NonEmptyString,
    phase_id: V2EntityId.nullable(),
    task_id: V2EntityId.nullable(),
    source_type: V2AttentionSourceType,
    source_id: V2EntityId,
    condition_class: V2NonEmptyString,
    condition_fingerprint: V2Sha256Hex,
    kind: V2AttentionKind,
    severity: V2AttentionSeverity,
    title: V2NonEmptyString,
    summary: V2NonEmptyString,
    explanation: V2NonEmptyString,
    recommendation: V2NonEmptyString,
    tradeoffs: z.array(V2NonEmptyString),
    decision: z
      .object({
        decision_point_id: V2EntityId,
        condition_fingerprint: V2Sha256Hex,
        options: V2DecisionOptions,
        recommendation_option_id: V2EntityId,
      })
      .strict()
      .nullable(),
    impact: V2NonEmptyString,
    resumes: V2NonEmptyString,
    occurred_at: V2IsoDateTime,
    acknowledged: z.boolean(),
    snoozed_until: V2IsoDateTime.nullable(),
  })
  .strict();
export type V2AttentionItemT = z.infer<typeof V2AttentionItem>;

export const V2PortfolioAttention = z
  .object({
    schema_version: z.literal(2),
    generated_at: V2IsoDateTime,
    counts: z
      .object({
        critical: z.number().int().nonnegative(),
        high: z.number().int().nonnegative(),
        decisions: z.number().int().nonnegative(),
        approvals: z.number().int().nonnegative(),
        blockers: z.number().int().nonnegative(),
        active_projects: z.number().int().nonnegative(),
        active_runs: z.number().int().nonnegative(),
      })
      .strict(),
    items: z.array(V2AttentionItem),
    projects: z.array(
      z
        .object({
          id: V2EntityId,
          name: V2NonEmptyString,
          status: V2NonEmptyString,
          health: z.enum(["healthy", "attention", "blocked"]),
          current_phase: V2NonEmptyString.nullable(),
          completed_tasks: z.number().int().nonnegative(),
          total_tasks: z.number().int().nonnegative(),
          active_runs: z.number().int().nonnegative(),
          attention_count: z.number().int().nonnegative(),
          next_action: V2NonEmptyString,
        })
        .strict(),
    ),
  })
  .strict();
export type V2PortfolioAttentionT = z.infer<typeof V2PortfolioAttention>;

export const V2AgentIdentity = z
  .object({
    profile_id: V2EntityId,
    provider: V2NonEmptyString,
    model: V2NonEmptyString,
    roles: z.array(V2NonEmptyString),
  })
  .strict();

export const V2PhaseReviewRound = z
  .object({
    id: V2EntityId,
    run_id: V2EntityId,
    review_round: z.number().int().positive(),
    decision: z.enum(["approved", "rework", "escalated"]),
    summary: V2NonEmptyString,
    evidence: z.array(V2EvidenceRef).min(1),
    reviewer: V2AgentIdentity,
    created_at: V2IsoDateTime,
  })
  .strict();

export const V2PhaseExecution = z
  .object({
    schema_version: z.literal(2),
    project_id: V2EntityId,
    phase: z
      .object({
        id: V2EntityId,
        objective_summary: V2NonEmptyString,
        status: V2NonEmptyString,
        completed_tasks: z.number().int().nonnegative(),
        total_tasks: z.number().int().nonnegative(),
      })
      .strict(),
    tasks: z.array(
      z
        .object({
          id: V2EntityId,
          title: V2NonEmptyString,
          state: V2NonEmptyString,
          complexity: V2NonEmptyString,
          risk: V2NonEmptyString,
          dependencies: z.array(V2EntityId),
          assignment: z
            .object({
              provider: V2NonEmptyString,
              model: V2NonEmptyString,
              status: V2NonEmptyString,
            })
            .strict()
            .nullable(),
          implementation_agent: V2AgentIdentity.nullable(),
          reviewer_agent: V2AgentIdentity.nullable(),
          run: z
            .object({
              id: V2EntityId,
              state: V2NonEmptyString,
              attempt: z.number().int().positive(),
              verification_status: V2NonEmptyString,
              commit_sha: V2NonEmptyString.nullable(),
              failure_detail: z.string().nullable(),
            })
            .strict()
            .nullable(),
          evidence_count: z.number().int().nonnegative(),
          reviews: z.array(V2PhaseReviewRound),
        })
        .strict(),
    ),
  })
  .strict();
export type V2PhaseExecutionT = z.infer<typeof V2PhaseExecution>;

export const V2DecisionResolutionRequest = z
  .object({
    idempotency_key: V2NonEmptyString.max(256),
    expected_condition_fingerprint: V2Sha256Hex,
    selected_option_id: V2EntityId,
    rationale: V2NonEmptyString.max(10_000),
    direction_target: V2DirectionTarget,
    direction_text: z.string().trim().max(10_000),
  })
  .strict();

export const V2DecisionResolutionResult = z
  .object({
    decision_point_id: V2EntityId,
    approval_id: V2EntityId,
    decision_record_id: V2EntityId,
    memory_entry_id: V2EntityId,
    resolved_at: V2IsoDateTime,
  })
  .strict();
export type V2DecisionResolutionResultT = z.infer<typeof V2DecisionResolutionResult>;

export const V2HumanDirectionRequest = z
  .object({
    phase_id: V2EntityId.nullable().optional(),
    task_id: V2EntityId.nullable().optional(),
    direction_target: V2DirectionTarget,
    direction_text: V2NonEmptyString.max(10_000),
    idempotency_key: V2NonEmptyString.max(256),
  })
  .strict()
  .superRefine((direction, ctx) => {
    if (direction.task_id && !direction.phase_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["phase_id"],
        message: "task-scoped direction requires phase_id",
      });
    }
  });
export type V2HumanDirectionRequestT = z.infer<typeof V2HumanDirectionRequest>;

export const V2HumanDirectionResult = z
  .object({
    memory_entry_id: V2EntityId,
    recorded_at: V2IsoDateTime,
    replayed: z.boolean(),
  })
  .strict();
export type V2HumanDirectionResultT = z.infer<typeof V2HumanDirectionResult>;
