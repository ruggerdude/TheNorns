import { z } from "zod";
import { V2EntityId, V2IsoDateTime, V2NonEmptyString, V2Sha256Hex } from "./common.js";

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
        })
        .strict(),
    ),
  })
  .strict();
export type V2PhaseExecutionT = z.infer<typeof V2PhaseExecution>;
