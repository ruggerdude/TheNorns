import { createHash } from "node:crypto";
import {
  V2AttentionItem,
  type V2AttentionItemT,
  V2DecisionResolutionResult,
  type V2DecisionResolutionResultT,
  type V2DirectionTargetT,
  V2HumanDirectionResult,
  type V2HumanDirectionResultT,
  V2PhaseExecution,
  type V2PhaseExecutionT,
  V2PortfolioAttention,
  type V2PortfolioAttentionT,
} from "@norns/contracts";
import { z } from "zod";
import type { V2TransactionRunner } from "../persistence/v2/database.js";
import {
  PROGRESS_WINDOW_SIZE,
  type V2PhaseProgressT,
  computeBurnRateUsdPerHour,
  computePercentComplete,
  computePhaseEta,
} from "./projectResumeService.js";

interface SourceRow {
  project_id: string;
  project_name: string;
  phase_id: string | null;
  task_id: string | null;
  source_type: V2AttentionItemT["source_type"];
  source_id: string;
  condition_class: string;
  kind: V2AttentionItemT["kind"];
  severity: V2AttentionItemT["severity"];
  title: string;
  summary: string;
  explanation: string;
  recommendation: string;
  tradeoffs: unknown;
  decision: unknown;
  impact: string;
  resumes: string;
  occurred_at: string | Date;
  material: unknown;
}

interface StateRow {
  item_key: string;
  condition_fingerprint: string;
  disposition: "acknowledged" | "snoozed";
  snoozed_until: string | Date | null;
}

function keyOf(
  row: Pick<SourceRow, "project_id" | "source_type" | "source_id" | "condition_class">,
) {
  return ["attention", row.project_id, row.source_type, row.source_id, row.condition_class]
    .map(encodeURIComponent)
    .join(":");
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

const severityRank = { critical: 0, high: 1, normal: 2, low: 3 } as const;

/**
 * QCP-2A — a paused QC gate that has sat unread escalates one severity step
 * (normal -> high, high -> critical) so a silent stall does not sit invisible
 * forever. "Unread" is elapsed wall-clock time since the more recent of (a)
 * the review row's own `updated_at` (there is no `paused_at` column, so this
 * doubles as "when it parked" per the spec's documented fallback) and (b) the
 * latest human-authored chat message on the review — "any interaction of any
 * kind" resets the clock, per QC-PAUSE-POINTS.md. A single module constant,
 * no settings surface: YAGNI until proven otherwise.
 */
export const QC_GATE_NUDGE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Milestones are activity/history, not intervention. Every other currently
 * defined attention kind represents an approval, decision, exception, or
 * blocked execution condition and remains actionable regardless of severity.
 * Keeping this kind-based prevents a future low-severity decision from being
 * silently treated as healthy merely because it is low.
 */
export function requiresHumanIntervention(item: Pick<V2AttentionItemT, "kind">): boolean {
  return item.kind !== "milestone";
}

/**
 * EXECUTION E10 — project the persisted verification command results down to
 * just the ones that FAILED, which is all a human reading a red run needs.
 *
 * Defensive about the stored shape on purpose: rows written before E10 hold the
 * hardcoded `[]`, and a runner is an external process whose payload has already
 * been schema-validated at the event boundary but whose historical rows have
 * not. Anything unrecognisable yields no entries rather than a 500 on a page
 * whose entire job is to explain a failure.
 */
function failedVerificationCommands(
  value: unknown,
): { name: string; command: string[]; exit_code: number; output: string }[] {
  if (!Array.isArray(value)) return [];
  const failures: { name: string; command: string[]; exit_code: number; output: string }[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (record.passed !== false) continue;
    const name = typeof record.name === "string" && record.name ? record.name : "verification";
    failures.push({
      name,
      command: Array.isArray(record.command)
        ? record.command.filter((part): part is string => typeof part === "string")
        : [],
      exit_code: typeof record.exit_code === "number" ? record.exit_code : -1,
      output: typeof record.output === "string" ? record.output : "",
    });
  }
  return failures;
}

// ---------------------------------------------------------------------------
// EXECUTION E13 (read model) — live cost and live log tail.
//
// `V2PhaseExecution`'s `phase` and `tasks[]` objects are `.strict()` zod
// shapes owned by `packages/contracts` (out of this phase's ownership, same
// constraint FRONT DOOR P5 recorded in projectResumeService.ts). The fields
// below are validated locally and merged onto the contract-parsed object in
// `AttentionService.phase()` AFTER `V2PhaseExecution.parse(...)` has already
// accepted the contract-owned shape — never fed back through the strict
// schema itself. Same pattern, same reason.
//
// HONESTY IS THE POINT (per the phase brief): a task or phase that has not
// yet accrued any `usage_events` rows reports `spend_usd: null` and
// `tokens: null` — NEVER a fabricated `0`, which would read as "confirmed
// free" rather than "nothing metered yet". `budget_usd` on a TASK is
// likewise `null` when no `budget_reservations` row exists for its run (the
// run has not been scheduled/reserved) — distinct from a real reservation of
// $0. The PHASE's `budget_usd` is not nullable: `phases.approved_budget_usd`
// is a real, always-populated column (defaulted to 0 until a strategy is
// approved), so 0 there honestly means "nothing approved yet", not "unknown".
// The phase-level fields reuse `V2PhaseProgress` from projectResumeService.ts
// (FRONT DOOR P5 extended it with the same `spend_usd`/`budget_usd` pair)
// rather than a second local schema, so both read models share one shape.
// ---------------------------------------------------------------------------
const V2TaskCost = z
  .object({
    spend_usd: z.number().nonnegative().nullable(),
    input_tokens: z.number().int().nonnegative().nullable(),
    output_tokens: z.number().int().nonnegative().nullable(),
    budget_usd: z.number().nonnegative().nullable(),
    last_usage_at: z.string().datetime().nullable(),
  })
  .strict();
type V2TaskCostT = z.infer<typeof V2TaskCost>;

/** Per-run usage aggregated from `usage_events`, keyed by `run_id`. A run
 *  absent from this map has never had a metered call recorded for it. */
interface RunUsageAggregate {
  input_tokens: string | number;
  output_tokens: string | number;
  cost_usd: string | number | null;
  last_usage_at: string | Date | null;
}

function buildTaskCost(
  usage: RunUsageAggregate | undefined,
  budgetUsd: string | number | undefined,
): V2TaskCostT {
  const hasUsage = usage !== undefined && usage.cost_usd !== null;
  return V2TaskCost.parse({
    spend_usd: hasUsage ? Number(usage?.cost_usd) : null,
    input_tokens: hasUsage ? Number(usage?.input_tokens ?? 0) : null,
    output_tokens: hasUsage ? Number(usage?.output_tokens ?? 0) : null,
    budget_usd: budgetUsd === undefined ? null : Number(budgetUsd),
    last_usage_at:
      hasUsage && usage?.last_usage_at ? new Date(usage.last_usage_at).toISOString() : null,
  });
}

/**
 * Bounds on the live run-log tail, so a chatty agent cannot make either this
 * endpoint or the page rendering it unbounded:
 *  - at most `RUN_LOG_PAGE_LIMIT` entries returned per call, and
 *  - each entry's `chunk` capped at `RUN_LOG_MAX_CHUNK_CHARS` (defensive; the
 *    wire protocol does not itself bound a runner's chunk size).
 * `truncated` is set whenever more matching entries exist than were
 * returned, so the caller can say so rather than silently showing a partial
 * log as if it were complete.
 */
export const RUN_LOG_PAGE_LIMIT = 200;
export const RUN_LOG_MAX_CHUNK_CHARS = 20_000;

const V2RunLogEntry = z
  .object({
    sequence: z.number().int().nonnegative(),
    occurred_at: z.string().datetime(),
    chunk: z.string(),
  })
  .strict();

const V2RunLogTail = z
  .object({
    run_id: z.string().nullable(),
    entries: z.array(V2RunLogEntry),
    /** True when older/newer matching entries exist beyond what was
     *  returned — the caller must say so, never drop it silently. */
    truncated: z.boolean(),
    /** Total run_log entries known for this run; null only when `run_id`
     *  itself is null (no run to report on at all). */
    total_entries: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type V2RunLogTailT = z.infer<typeof V2RunLogTail>;

export class AttentionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttentionConflictError";
  }
}

export class DecisionResolutionError extends Error {
  constructor(
    readonly code:
      | "decision_not_found"
      | "decision_closed"
      | "stale_decision"
      | "invalid_option"
      | "scope_not_found"
      | "idempotency_conflict",
    message: string,
  ) {
    super(message);
    this.name = "DecisionResolutionError";
  }
}

const iso = (value: string | Date): string => new Date(value).toISOString();

function stableFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function decisionMetadata(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const options = Array.isArray(source.options)
    ? source.options.map((entry) => {
        const option =
          entry && typeof entry === "object" && !Array.isArray(entry)
            ? (entry as Record<string, unknown>)
            : {};
        return {
          id: String(option.id ?? "option"),
          label: String(option.label ?? "Option"),
          impact: String(option.impact ?? "Review the operational impact before selecting."),
          risk: String(option.risk ?? "No explicit risk was recorded for this legacy option."),
        };
      })
    : [];
  return { ...source, options };
}

export interface RecoveryDecisionIntent {
  action: "retry" | "cancel";
  project_id: string;
  phase_id: string;
  task_id: string;
  failed_run_id: string;
  expected_task_version: number;
  /** Historical evidence only; never reuse it as a new dispatch deadline. */
  decision_created_at: string;
}

export class AttentionService {
  constructor(private readonly transactions: V2TransactionRunner) {}

  portfolio(
    userId: string,
    options: { includeAcknowledged?: boolean; now?: Date } = {},
  ): Promise<V2PortfolioAttentionT> {
    const now = options.now ?? new Date();
    return this.transactions.transaction(async (sql) => {
      const sources = await sql.query<SourceRow>(
        `SELECT * FROM (
           SELECT p.id AS project_id, p.name AS project_name, d.phase_id, d.task_id,
             'decision_point'::text AS source_type, d.id AS source_id,
             d.reason_class AS condition_class, 'decision'::text AS kind,
             CASE WHEN d.urgency='critical' THEN 'critical' ELSE 'high' END AS severity,
             d.question AS title, d.context AS summary,
             'Human judgment is required before the blocked scope can continue.' AS explanation,
             COALESCE((SELECT option->>'label' FROM jsonb_array_elements(d.options) option
                       WHERE option->>'id'=d.recommendation_option_id LIMIT 1),
                      'Review the available options') AS recommendation,
             d.options AS tradeoffs,
             jsonb_build_object(
               'decision_point_id', d.id,
               'condition_fingerprint', d.condition_fingerprint,
               'options', d.options,
               'recommendation_option_id', d.recommendation_option_id
             ) AS decision,
             'The declared blocking scope remains paused until orchestration applies the recorded direction.' AS impact,
             'Resolution records an approved directive for subsequent coordinator evaluation.' AS resumes,
             d.updated_at AS occurred_at,
             jsonb_build_object('status',d.status,'revision',d.condition_revision,
                                'fingerprint',d.condition_fingerprint) AS material
           FROM decision_points d JOIN projects p ON p.id=d.project_id
           WHERE d.status='open'
             AND NOT EXISTS (
               SELECT 1
                 FROM agent_runs recovery_run
                 JOIN tasks recovery_task ON recovery_task.id=recovery_run.task_id
                 JOIN phases recovery_phase ON recovery_phase.id=recovery_run.phase_id
                WHERE d.reason_class IN ('stuck_run','failed_run')
                  AND d.scope_entity_type='agent_run'
                  AND recovery_run.id=d.scope_entity_id
                  AND (
                    recovery_run.state='succeeded'
                    OR recovery_run.is_designated=false
                    OR recovery_run.superseded_at IS NOT NULL
                    OR recovery_task.state IN ('completed','cancelled')
                    OR recovery_phase.status IN ('completed','cancelled')
                  )
             )
           UNION ALL
           SELECT p.id, p.name, s.phase_id, NULL, 'strategy_version', s.id,
             'strategy_approval', 'approval', 'high',
             'Strategy approval required', s.objective,
             'A converged strategy is ready for human authorization.',
             'Review scope, assignments, budget, and approve when correct',
             jsonb_build_array('Approval materializes canonical execution tasks',
                               'Changes require a new immutable strategy version'),
             NULL::jsonb,
             'The phase cannot begin execution until approved.',
             'Approval materializes tasks and enables scheduling.', s.updated_at,
             jsonb_build_object('status',s.status,'hash',s.content_hash,'version',s.version)
           FROM strategy_versions s JOIN projects p ON p.id=s.project_id
           WHERE s.status='awaiting_approval'
           UNION ALL
           SELECT p.id, p.name,
             (SELECT phase.id FROM phases phase
               WHERE phase.project_id=planning.project_id
                 AND phase.planning_run_id=planning.id
               ORDER BY phase.created_at DESC, phase.id LIMIT 1),
             NULL::text, 'planning_run', planning.id,
             'quick_kickoff_failed', 'blocker', 'high',
             'Coding needs a restart',
             COALESCE(NULLIF(planning.quick_kickoff_result->>'detail', ''),
                      'The approved quick change did not dispatch any coding work.'),
             'The quick change is durably approved, but its kickoff completed without starting execution.',
             'Open the Phase tab, resolve the reported blocker, and retry coding',
             jsonb_build_array('No execution is active for this quick change',
                               'Retry only after the reported blocker is resolved'),
             NULL::jsonb,
             'The approved phase remains pending and no implementation work is running.',
             'A successful retry dispatches the pending task without recreating the approved plan.',
             planning.updated_at,
             jsonb_build_object(
               'status', planning.status,
               'kickoff_status', planning.quick_kickoff_status,
               'kickoff_result', planning.quick_kickoff_result,
               'attempts', planning.quick_kickoff_attempts,
               'phase_status', (
                 SELECT phase.status FROM phases phase
                  WHERE phase.project_id=planning.project_id
                    AND phase.planning_run_id=planning.id
                  ORDER BY phase.created_at DESC, phase.id LIMIT 1
               )
             )
           FROM planning_runs planning JOIN projects p ON p.id=planning.project_id
           WHERE planning.mode='quick'
             AND planning.status='approved'
             AND planning.quick_kickoff_status='completed'
             AND planning.quick_kickoff_result @> '{"started":false}'::jsonb
             AND NOT EXISTS (
               SELECT 1 FROM phases started_phase
                WHERE started_phase.project_id=planning.project_id
                  AND started_phase.planning_run_id=planning.id
                  AND started_phase.status IN ('active','completed')
             )
           UNION ALL
           SELECT p.id, p.name, t.phase_id, t.id, 'task', t.id,
             'task_blocked', 'blocker',
             CASE WHEN t.state='failed' THEN 'critical' ELSE 'high' END,
             t.title, 'Task is ' || t.state || ' and requires intervention',
             'Execution cannot make progress automatically from the current task state.',
             'Inspect the latest run and choose retry, rework, or cancellation',
             jsonb_build_array('Retry may repeat work', 'Rework may change phase scope'),
             NULL::jsonb,
             'Dependent tasks and phase completion are blocked.',
             'A disposition returns the task to an executable state.', t.updated_at,
             jsonb_build_object('state',t.state,'version',t.aggregate_version)
           FROM tasks t JOIN projects p ON p.id=t.project_id
           WHERE t.state IN ('blocked','failed')
             AND NOT EXISTS (
               SELECT 1 FROM decision_points decision
               WHERE decision.task_id=t.id AND decision.status='open'
             )
             AND NOT EXISTS (
               SELECT 1 FROM agent_runs designated
               WHERE designated.id=t.designated_run_id AND designated.state IN ('failed','expired')
             )
           UNION ALL
           SELECT p.id, p.name, r.phase_id, r.task_id, 'agent_run', r.id,
             CASE WHEN r.state='expired' THEN 'stalled_run' ELSE 'run_failed' END,
             CASE WHEN r.state='expired' THEN 'stalled_run' ELSE 'failed_run' END,
             'high', 'Agent run needs recovery',
             COALESCE(r.failure_detail, 'The run ended without a successful verified result.'),
             'The designated execution attempt did not produce reviewable work.',
             'Review evidence and retry with a fresh fenced run when safe',
             jsonb_build_array('Retry can consume additional budget',
                               'Cancellation leaves the task incomplete'),
             NULL::jsonb,
             'The assigned task cannot advance to review.',
             'A new designated run resumes task execution.', r.updated_at,
             jsonb_build_object('state',r.state,'attempt',r.attempt,
                                'failure',r.failure_code,'version',r.aggregate_version)
           FROM agent_runs r
           JOIN projects p ON p.id=r.project_id
           JOIN tasks run_task ON run_task.id=r.task_id
           JOIN phases run_phase ON run_phase.id=r.phase_id
           WHERE r.state IN ('failed','expired')
             AND r.is_designated=true
             AND r.superseded_at IS NULL
             AND run_task.state NOT IN ('completed','cancelled')
             AND run_phase.status='active'
           UNION ALL
           SELECT p.id, p.name, b.phase_id, b.task_id, 'budget_reservation', b.id,
             'ambiguous_budget', 'budget_exception', 'critical',
             'Budget usage requires reconciliation',
             'Execution outcome is ambiguous, so reserved budget remains held.',
             'Automatic release could undercount real provider usage.',
             'Reconcile provider usage before releasing or settling funds',
             jsonb_build_array('Release risks overspend', 'Retain reduces available phase budget'),
             NULL::jsonb,
             'New work may be prevented by the remaining budget hold.',
             'Reconciliation restores an accurate available budget.', b.updated_at,
             jsonb_build_object('status',b.status,'amount',b.amount_usd,
                                'retained',b.retained_usd,'version',b.version)
           FROM budget_reservations b JOIN projects p ON p.id=b.project_id
           WHERE b.status='retained_ambiguous'
           UNION ALL
           SELECT p.id, p.name, phase.id, NULL, 'phase', phase.id,
             'phase_completed', 'milestone', 'low', 'Phase completed',
             phase.objective_summary,
             'The phase closed with reviewed and integrated evidence.',
             'Review the completion summary or create the next phase',
             jsonb_build_array('No action is required'),
             NULL::jsonb,
             'Project memory and progress have been updated.',
             'A new phase can begin without reconstructing prior context.', phase.closed_at,
             jsonb_build_object('status',phase.status,'version',phase.aggregate_version,
                                'closed_at',phase.closed_at)
           FROM phases phase JOIN projects p ON p.id=phase.project_id
           WHERE phase.status='completed' AND phase.closed_at >= $1::timestamptz - interval '7 days'
           UNION ALL
           -- QCP-2A: a conversation_plan_reviews row parked awaiting_human at
           -- one of the three QC gates (Gate A/after_review, Gate B/
           -- after_revision, Gate C/adjudication). Gate C is the mandatory
           -- adjudication stop and outranks the two cadence gates (kind
           -- 'decision', severity 'high' vs 'approval'/'normal'), per
           -- QC-PAUSE-POINTS.md ("Gate C outranks Gate A and B"). gate.elapsed_ms
           -- is the TTL nudge: elapsed time since the more recent of the
           -- review's own updated_at and its latest human chat message,
           -- compared against QC_GATE_NUDGE_TTL_MS, escalates severity one
           -- step and says so in the copy.
           SELECT p.id, p.name, wi.phase_id, NULL::text,
             'conversation_plan_review'::text AS source_type, review.id AS source_id,
             CASE review.paused_checkpoint
               WHEN 'adjudication' THEN 'qc_gate_adjudication'
               WHEN 'after_review' THEN 'qc_gate_after_review'
               ELSE 'qc_gate_after_revision'
             END AS condition_class,
             CASE WHEN review.paused_checkpoint='adjudication' THEN 'decision' ELSE 'approval' END
               AS kind,
             CASE
               WHEN review.paused_checkpoint='adjudication' AND gate.elapsed_ms > $2::numeric
                 THEN 'critical'
               WHEN review.paused_checkpoint='adjudication' THEN 'high'
               WHEN gate.elapsed_ms > $2::numeric THEN 'high'
               ELSE 'normal'
             END AS severity,
             CASE review.paused_checkpoint
               WHEN 'adjudication' THEN 'QC adjudication required'
               WHEN 'after_review' THEN 'QC review awaiting your input'
               ELSE 'QC revision awaiting your review'
             END AS title,
             (CASE review.paused_checkpoint
                WHEN 'adjudication' THEN
                  'The reviewer and PM could not resolve a must-fix finding at round '
                    || review.paused_at_round::text || '; the review is parked until you rule.'
                WHEN 'after_review' THEN
                  'Round ' || review.paused_at_round::text
                    || ' findings are ready for you before the PM responds.'
                ELSE
                  'Round ' || review.paused_at_round::text
                    || '''s revision is ready for your review before the next round begins.'
              END)
               || CASE WHEN gate.elapsed_ms > $2::numeric
                    THEN ' Waiting ' || floor(gate.elapsed_ms / 86400000)::text
                           || ' day(s) with no response.'
                    ELSE ''
                  END AS summary,
             CASE review.paused_checkpoint
               WHEN 'adjudication' THEN
                 'Two agents disagree on a must-fix finding and neither can settle it from the frozen context receipt they both read.'
               WHEN 'after_review' THEN
                 'The reviewer filed findings and the loop is paused so you can redirect before the PM spends a revision pass.'
               ELSE
                 'The PM disposed of the reviewer''s findings and revised the plan; the loop is paused for your inspection.'
             END AS explanation,
             CASE review.paused_checkpoint
               WHEN 'adjudication' THEN
                 'Open the QC tab, read the disputed finding and rebuttal, and rule for the reviewer or the PM.'
               WHEN 'after_review' THEN
                 'Open the QC tab and continue, or leave a note for the reviewer or PM before it proceeds.'
               ELSE
                 'Open the QC tab, read the plan diff, and continue or accept the plan as-is.'
             END AS recommendation,
             jsonb_build_array('Continuing advances the loop one step',
                                'Cancelling discards this review') AS tradeoffs,
             NULL::jsonb AS decision,
             'The plan review cannot proceed until a human responds at this gate.' AS impact,
             'Continuing, noting, accepting, or cancelling resumes or ends the paused review.'
               AS resumes,
             review.updated_at AS occurred_at,
             jsonb_build_object('status', review.status, 'paused_checkpoint', review.paused_checkpoint,
                                 'paused_at_round', review.paused_at_round,
                                 'chat_message_count', jsonb_array_length(review.chat_messages))
               AS material
           FROM conversation_plan_reviews review
           JOIN projects p ON p.id=review.project_id
           JOIN work_items wi ON wi.project_id=review.project_id AND wi.id=review.work_item_id
           CROSS JOIN LATERAL (
             SELECT EXTRACT(EPOCH FROM (
               $1::timestamptz - GREATEST(
                 review.updated_at,
                 (SELECT max((msg->>'created_at')::timestamptz)
                    FROM jsonb_array_elements(review.chat_messages) msg
                   WHERE msg->>'speaker'='human')
               )
             )) * 1000 AS elapsed_ms
           ) gate
           WHERE review.status='awaiting_human'
         ) attention_sources`,
        [now.toISOString(), QC_GATE_NUDGE_TTL_MS],
      );
      const states = await sql.query<StateRow>(
        `SELECT item_key, condition_fingerprint, disposition, snoozed_until
         FROM attention_item_states WHERE user_id=$1`,
        [userId],
      );
      const stateByKey = new Map(states.rows.map((state) => [state.item_key, state]));
      const allItems = sources.rows.map((row) => {
        const { material, ...source } = row;
        const key = keyOf(row);
        const currentFingerprint = fingerprint(material);
        const state = stateByKey.get(key);
        const same = state?.condition_fingerprint === currentFingerprint;
        const acknowledged = Boolean(same && state?.disposition === "acknowledged");
        const snoozedUntil = same && state?.disposition === "snoozed" ? state.snoozed_until : null;
        const tradeoffs = Array.isArray(row.tradeoffs)
          ? row.tradeoffs.map((entry) =>
              typeof entry === "string"
                ? entry
                : `${String((entry as { label?: unknown }).label ?? "Option")}: ${String(
                    (entry as { impact?: unknown }).impact ?? "Review impact",
                  )}`,
            )
          : [];
        return V2AttentionItem.parse({
          ...source,
          key,
          condition_fingerprint: currentFingerprint,
          occurred_at: new Date(row.occurred_at).toISOString(),
          tradeoffs,
          decision: decisionMetadata(row.decision),
          acknowledged,
          snoozed_until: snoozedUntil ? new Date(snoozedUntil).toISOString() : null,
        });
      });
      allItems.sort(
        (left, right) =>
          severityRank[left.severity] - severityRank[right.severity] ||
          Date.parse(right.occurred_at) - Date.parse(left.occurred_at),
      );
      const visibleItems = allItems.filter(
        (item) =>
          options.includeAcknowledged ||
          (!item.acknowledged &&
            (!item.snoozed_until || Date.parse(item.snoozed_until) <= now.getTime())),
      );
      const projectRows = await sql.query<{
        id: string;
        name: string;
        status: string;
        current_phase: string | null;
        completed_tasks: number;
        total_tasks: number;
        active_runs: number;
      }>(
        `SELECT p.id, p.name, p.status,
           (SELECT objective_summary FROM phases ph WHERE ph.project_id=p.id
            AND ph.status IN ('active','approved','awaiting_approval','proposed')
            ORDER BY ph.priority DESC, ph.created_at LIMIT 1) AS current_phase,
           (SELECT count(*)::int FROM tasks t WHERE t.project_id=p.id AND t.state='completed') AS completed_tasks,
           (SELECT count(*)::int FROM tasks t WHERE t.project_id=p.id) AS total_tasks,
           (SELECT count(*)::int FROM agent_runs r WHERE r.project_id=p.id
            AND r.state IN ('created','dispatched','running','verifying')) AS active_runs
         FROM projects p WHERE p.status <> 'archived' ORDER BY p.updated_at DESC, p.id`,
      );
      const projects = projectRows.rows.map((project) => {
        const projectItems = visibleItems.filter((item) => item.project_id === project.id);
        const interventionItems = projectItems.filter(requiresHumanIntervention);
        const blocked = interventionItems.some((item) => item.severity === "critical");
        const attention = interventionItems.length > 0;
        return {
          ...project,
          health: blocked
            ? ("blocked" as const)
            : attention
              ? ("attention" as const)
              : ("healthy" as const),
          attention_count: interventionItems.length,
          next_action:
            interventionItems[0]?.recommendation ??
            (project.current_phase ? "Monitor the current phase" : "Create the next phase"),
        };
      });
      return V2PortfolioAttention.parse({
        schema_version: 2,
        generated_at: now.toISOString(),
        counts: {
          critical: visibleItems.filter((item) => item.severity === "critical").length,
          high: visibleItems.filter((item) => item.severity === "high").length,
          decisions: visibleItems.filter((item) => item.kind === "decision").length,
          approvals: visibleItems.filter((item) => item.kind === "approval").length,
          blockers: visibleItems.filter((item) => item.kind === "blocker").length,
          active_projects: projects.length,
          active_runs: projects.reduce((sum, project) => sum + project.active_runs, 0),
        },
        items: visibleItems,
        projects,
      });
    });
  }

  async disposition(input: {
    user_id: string;
    item_key: string;
    condition_fingerprint: string;
    disposition: "acknowledged" | "snoozed";
    snoozed_until: string | null;
    now?: Date;
  }): Promise<void> {
    const current = await this.portfolio(input.user_id, {
      includeAcknowledged: true,
      ...(input.now ? { now: input.now } : {}),
    });
    const item = current.items.find((candidate) => candidate.key === input.item_key);
    if (!item || item.condition_fingerprint !== input.condition_fingerprint) {
      throw new AttentionConflictError("attention condition changed; refresh before disposition");
    }
    if ((input.disposition === "snoozed") !== (input.snoozed_until !== null)) {
      throw new AttentionConflictError("snoozed disposition requires snoozed_until");
    }
    await this.transactions.transaction(async (sql) => {
      await sql.query(
        `INSERT INTO attention_item_states (
           user_id, item_key, project_id, source_type, source_id, condition_class,
           condition_fingerprint, disposition, snoozed_until, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (user_id,item_key) DO UPDATE SET
           condition_fingerprint=EXCLUDED.condition_fingerprint,
           disposition=EXCLUDED.disposition, snoozed_until=EXCLUDED.snoozed_until,
           updated_at=EXCLUDED.updated_at`,
        [
          input.user_id,
          item.key,
          item.project_id,
          item.source_type,
          item.source_id,
          item.condition_class,
          item.condition_fingerprint,
          input.disposition,
          input.snoozed_until,
          (input.now ?? new Date()).toISOString(),
        ],
      );
    });
  }

  /**
   * Resolve the exact execution scope behind a generated recovery decision
   * without closing it. The recovery action remains authoritative for task/run
   * state, while resolveDecision records the human decision only after that
   * action succeeds.
   */
  recoveryDecisionIntent(input: {
    project_id: string;
    decision_point_id: string;
    expected_condition_fingerprint: string;
    selected_option_id: string;
  }): Promise<RecoveryDecisionIntent | null> {
    return this.transactions.transaction(async (sql) => {
      const found = await sql.query<{
        id: string;
        status: string;
        condition_fingerprint: string;
        options: unknown;
        reason_class: string;
        phase_id: string | null;
        task_id: string | null;
        scope_entity_type: string;
        scope_entity_id: string;
        task_version: number | null;
        run_state: string | null;
        created_at: string | Date;
      }>(
        `SELECT decision.id, decision.status, decision.condition_fingerprint,
                decision.options, decision.reason_class, decision.phase_id,
                decision.task_id, decision.scope_entity_type,
                decision.scope_entity_id, decision.created_at,
                task.aggregate_version AS task_version,
                run.state AS run_state
           FROM decision_points decision
           LEFT JOIN tasks task
             ON task.id=decision.task_id
            AND task.project_id=decision.project_id
            AND task.phase_id=decision.phase_id
           LEFT JOIN agent_runs run
             ON run.id=decision.scope_entity_id
            AND run.task_id=decision.task_id
          WHERE decision.id=$1 AND decision.project_id=$2`,
        [input.decision_point_id, input.project_id],
      );
      const point = found.rows[0];
      if (
        !point ||
        !["failed_run", "stuck_run"].includes(point.reason_class) ||
        point.scope_entity_type !== "agent_run"
      ) {
        return null;
      }
      if (point.status !== "open") {
        throw new DecisionResolutionError("decision_closed", "decision point is already closed");
      }
      if (point.condition_fingerprint !== input.expected_condition_fingerprint) {
        throw new DecisionResolutionError(
          "stale_decision",
          "decision condition changed; refresh before resolving",
        );
      }
      const optionIds = Array.isArray(point.options)
        ? point.options.map((option) =>
            option && typeof option === "object" && !Array.isArray(option)
              ? String((option as Record<string, unknown>).id ?? "")
              : "",
          )
        : [];
      if (!optionIds.includes(input.selected_option_id)) {
        throw new DecisionResolutionError(
          "invalid_option",
          "selected option is not available on this decision point",
        );
      }
      if (input.selected_option_id !== "retry" && input.selected_option_id !== "cancel") {
        throw new DecisionResolutionError(
          "invalid_option",
          "this recovery decision only supports retry or cancel",
        );
      }
      if (
        !point.phase_id ||
        !point.task_id ||
        point.task_version === null ||
        !["failed", "expired"].includes(point.run_state ?? "")
      ) {
        throw new DecisionResolutionError(
          "scope_not_found",
          `the recovery scope is not a terminal failed or expired run (current state: ${point.run_state ?? "missing"})`,
        );
      }
      return {
        action: input.selected_option_id,
        project_id: input.project_id,
        phase_id: point.phase_id,
        task_id: point.task_id,
        failed_run_id: point.scope_entity_id,
        expected_task_version: point.task_version,
        decision_created_at: iso(point.created_at),
      };
    });
  }

  resolveDecision(input: {
    user_id: string;
    project_id: string;
    decision_point_id: string;
    idempotency_key: string;
    expected_condition_fingerprint: string;
    selected_option_id: string;
    rationale: string;
    direction_target: V2DirectionTargetT;
    direction_text: string;
    now?: Date;
  }): Promise<V2DecisionResolutionResultT> {
    const resolvedAt = (input.now ?? new Date()).toISOString();
    return this.transactions.transaction(async (sql) => {
      const requestFingerprint = stableFingerprint({
        project_id: input.project_id,
        decision_point_id: input.decision_point_id,
        expected_condition_fingerprint: input.expected_condition_fingerprint,
        selected_option_id: input.selected_option_id,
        rationale: input.rationale.trim(),
        direction_target: input.direction_target,
        direction_text: input.direction_text.trim(),
      });
      const existingIdempotency = await sql.query<{
        request_fingerprint: string;
        status: string;
        response: unknown;
      }>(
        `SELECT request_fingerprint, status, response FROM idempotency_records
         WHERE actor_id=$1 AND command_family='decision_resolution' AND idempotency_key=$2`,
        [input.user_id, input.idempotency_key],
      );
      const prior = existingIdempotency.rows[0];
      if (prior) {
        if (prior.request_fingerprint !== requestFingerprint) {
          throw new DecisionResolutionError(
            "idempotency_conflict",
            "idempotency key was already used for a different decision resolution",
          );
        }
        if (prior.status !== "committed_succeeded" || !prior.response) {
          throw new DecisionResolutionError(
            "idempotency_conflict",
            "matching decision resolution is still in progress",
          );
        }
        return V2DecisionResolutionResult.parse(prior.response);
      }
      const found = await sql.query<{
        id: string;
        project_id: string;
        phase_id: string | null;
        task_id: string | null;
        status: string;
        condition_fingerprint: string;
        condition_revision: number;
        question: string;
        options: unknown;
        scope_entity_type: string;
        scope_entity_id: string;
      }>(
        `SELECT id, project_id, phase_id, task_id, status, condition_fingerprint,
                condition_revision, question, options, scope_entity_type, scope_entity_id
         FROM decision_points WHERE id=$1 AND project_id=$2 FOR UPDATE`,
        [input.decision_point_id, input.project_id],
      );
      const point = found.rows[0];
      if (!point) {
        throw new DecisionResolutionError(
          "decision_not_found",
          "decision point does not exist in this project",
        );
      }
      if (point.status !== "open") {
        throw new DecisionResolutionError("decision_closed", "decision point is already closed");
      }
      if (point.condition_fingerprint !== input.expected_condition_fingerprint) {
        throw new DecisionResolutionError(
          "stale_decision",
          "decision condition changed; refresh before resolving",
        );
      }
      const options = Array.isArray(point.options)
        ? point.options.filter((option): option is Record<string, unknown> =>
            Boolean(option && typeof option === "object" && !Array.isArray(option)),
          )
        : [];
      const optionIds = options.map((option) => String(option.id ?? ""));
      if (new Set(optionIds).size !== optionIds.length) {
        throw new DecisionResolutionError(
          "invalid_option",
          "decision point contains duplicate option ids",
        );
      }
      const selected = options.find(
        (option) => String(option.id ?? "") === input.selected_option_id,
      );
      if (!selected) {
        throw new DecisionResolutionError(
          "invalid_option",
          "selected option is not available on this decision point",
        );
      }
      const normalizedDirection =
        input.direction_text.trim() ||
        `${String(selected.label ?? input.selected_option_id)} — ${input.rationale.trim()}`;
      const decisionMaterial = {
        decision_point_id: point.id,
        condition_fingerprint: point.condition_fingerprint,
        selected_option_id: input.selected_option_id,
        rationale: input.rationale.trim(),
        direction_target: input.direction_target,
        direction_text: normalizedDirection,
      };
      const contentHash = stableFingerprint(decisionMaterial);
      const commandId = `decision-resolution:${stableFingerprint({ actor: input.user_id, key: input.idempotency_key }).slice(0, 32)}`;
      await sql.query(
        `INSERT INTO idempotency_records (
           actor_id, command_family, idempotency_key, request_fingerprint, command_id,
           status, retain_until
         ) VALUES ($1,'decision_resolution',$2,$3,$4,'in_progress',$5::timestamptz + interval '30 days')`,
        [input.user_id, input.idempotency_key, requestFingerprint, commandId, resolvedAt],
      );
      const suffix = stableFingerprint(commandId).slice(0, 20);
      const approvalId = `approval:decision:${point.id}:${suffix}`;
      const recordId = `decision-record:${point.id}:${suffix}`;
      const memoryId = `memory:decision-direction:${point.id}:${suffix}`;

      await sql.query(
        `INSERT INTO approvals (
           id, project_id, phase_id, kind, subject_entity_type, subject_entity_id,
           actor_id, content_hash, status, approved_at
         ) VALUES ($1,$2,$3,'decision','decision_point',$4,$5,$6,'active',$7)`,
        [
          approvalId,
          point.project_id,
          point.phase_id,
          point.id,
          input.user_id,
          contentHash,
          resolvedAt,
        ],
      );
      await sql.query(
        `INSERT INTO decision_records (
           id, project_id, phase_id, decision_point_id, title, rationale,
           selected_option_id, direction_target, direction_text, status, decided_by,
           approval_id, affected_entities, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active',$10,$11,$12::jsonb,$13)`,
        [
          recordId,
          point.project_id,
          point.phase_id,
          point.id,
          point.question,
          input.rationale.trim(),
          input.selected_option_id,
          input.direction_target,
          normalizedDirection,
          input.user_id,
          approvalId,
          JSON.stringify([
            { entity_type: point.scope_entity_type, entity_id: point.scope_entity_id },
          ]),
          resolvedAt,
        ],
      );
      await sql.query(
        `INSERT INTO project_memory_entries (
           id, project_id, phase_id, task_id, category, content, provenance, source_ref,
           confidence, version, status, approved_by_human, approved_by, approved_at, created_at
         ) VALUES ($1,$2,$3,$4,'directive',$5,'human_decision_resolution',$6::jsonb,
                   1,1,'active',true,$7,$8,$8)`,
        [
          memoryId,
          point.project_id,
          point.phase_id,
          point.task_id,
          normalizedDirection,
          JSON.stringify({
            entity_type: "decision_record",
            entity_id: recordId,
          }),
          input.user_id,
          resolvedAt,
        ],
      );
      await sql.query(
        `UPDATE decision_points
         SET status='resolved', resolved_at=$3, updated_at=$3
         WHERE id=$1 AND project_id=$2 AND status='open'`,
        [point.id, point.project_id, resolvedAt],
      );
      const stream = await sql.query<{ next: number }>(
        `SELECT COALESCE(max(stream_version),0)::int + 1 AS next
         FROM domain_events WHERE stream_type='decision_point' AND stream_id=$1`,
        [point.id],
      );
      const streamVersion = stream.rows[0]?.next ?? 1;
      await sql.query(
        `INSERT INTO domain_events (
           event_id, stream_type, stream_id, stream_version, event_type, project_id,
           phase_id, task_id, actor_type, actor_id, correlation_id, causation_id,
           occurred_at, payload
         ) VALUES ($1,'decision_point',$2,$3,'decision_point_resolved',$4,$5,$6,
                   'human',$7,$8,$2,$9,$10::jsonb)`,
        [
          `event:decision-resolved:${point.id}:${streamVersion}`,
          point.id,
          streamVersion,
          point.project_id,
          point.phase_id,
          point.task_id,
          input.user_id,
          recordId,
          resolvedAt,
          JSON.stringify({
            kind: "decision_point_resolved",
            decision_point_id: point.id,
            decision_record_id: recordId,
            selected_option_id: input.selected_option_id,
          }),
        ],
      );
      await sql.query(
        `INSERT INTO audit_events (
           audit_id, audit_type, project_id, phase_id, task_id, actor_type, actor_id,
           outcome, severity, correlation_id, causation_id, occurred_at, targets, summary, details
         ) VALUES ($1,'decision_point_resolved',$2,$3,$4,'human',$5,'succeeded','info',
                   $6,$7,$8,$9::jsonb,$10,$11::jsonb)`,
        [
          `audit:decision-resolved:${point.id}:${suffix}`,
          point.project_id,
          point.phase_id,
          point.task_id,
          input.user_id,
          recordId,
          point.id,
          resolvedAt,
          JSON.stringify([
            { entity_type: "decision_point", entity_id: point.id },
            { entity_type: "decision_record", entity_id: recordId },
            { entity_type: "memory_entry", entity_id: memoryId },
          ]),
          `Resolved decision: ${point.question}`,
          JSON.stringify({
            selected_option_id: input.selected_option_id,
            direction_target: input.direction_target,
          }),
        ],
      );
      const result = V2DecisionResolutionResult.parse({
        decision_point_id: point.id,
        approval_id: approvalId,
        decision_record_id: recordId,
        memory_entry_id: memoryId,
        resolved_at: resolvedAt,
      });
      await sql.query(
        `UPDATE idempotency_records SET status='committed_succeeded', response=$4::jsonb, updated_at=$3
         WHERE actor_id=$1 AND command_family='decision_resolution' AND idempotency_key=$2`,
        [input.user_id, input.idempotency_key, resolvedAt, JSON.stringify(result)],
      );
      return result;
    });
  }

  recordDirection(input: {
    user_id: string;
    project_id: string;
    phase_id?: string | null;
    task_id?: string | null;
    direction_target: V2DirectionTargetT;
    direction_text: string;
    idempotency_key: string;
    now?: Date;
  }): Promise<V2HumanDirectionResultT> {
    const recordedAt = (input.now ?? new Date()).toISOString();
    const phaseId = input.phase_id ?? null;
    const taskId = input.task_id ?? null;
    const requestFingerprint = stableFingerprint({
      project_id: input.project_id,
      phase_id: phaseId,
      task_id: taskId,
      direction_target: input.direction_target,
      direction_text: input.direction_text.trim(),
    });
    return this.transactions.transaction(async (sql) => {
      const project = await sql.query<{ id: string }>(
        "SELECT id FROM projects WHERE id=$1 FOR UPDATE",
        [input.project_id],
      );
      if (!project.rows[0]) {
        throw new DecisionResolutionError("scope_not_found", "project does not exist");
      }
      if (phaseId) {
        const phase = await sql.query<{ id: string }>(
          "SELECT id FROM phases WHERE id=$1 AND project_id=$2",
          [phaseId, input.project_id],
        );
        if (!phase.rows[0]) {
          throw new DecisionResolutionError("scope_not_found", "phase does not exist in project");
        }
      }
      if (taskId) {
        const task = await sql.query<{ id: string }>(
          "SELECT id FROM tasks WHERE id=$1 AND project_id=$2 AND phase_id=$3",
          [taskId, input.project_id, phaseId],
        );
        if (!task.rows[0]) {
          throw new DecisionResolutionError("scope_not_found", "task does not exist in phase");
        }
      }
      const existing = await sql.query<{
        request_fingerprint: string;
        status: string;
        response: unknown;
      }>(
        `SELECT request_fingerprint, status, response FROM idempotency_records
         WHERE actor_id=$1 AND command_family='human_direction' AND idempotency_key=$2`,
        [input.user_id, input.idempotency_key],
      );
      const prior = existing.rows[0];
      if (prior) {
        if (prior.request_fingerprint !== requestFingerprint) {
          throw new DecisionResolutionError(
            "idempotency_conflict",
            "idempotency key was already used for different direction content or scope",
          );
        }
        if (prior.status !== "committed_succeeded" || !prior.response) {
          throw new DecisionResolutionError(
            "idempotency_conflict",
            "matching direction request is still in progress",
          );
        }
        return V2HumanDirectionResult.parse({
          ...(prior.response as Record<string, unknown>),
          replayed: true,
        });
      }
      const commandId = `human-direction:${stableFingerprint({ actor: input.user_id, key: input.idempotency_key }).slice(0, 32)}`;
      await sql.query(
        `INSERT INTO idempotency_records (
           actor_id, command_family, idempotency_key, request_fingerprint, command_id,
           status, retain_until
         ) VALUES ($1,'human_direction',$2,$3,$4,'in_progress',$5::timestamptz + interval '30 days')`,
        [input.user_id, input.idempotency_key, requestFingerprint, commandId, recordedAt],
      );
      const identitySuffix = stableFingerprint(commandId).slice(0, 32);
      const directionId = `human-direction:${identitySuffix}`;
      const memoryId = `memory:human-direction:${identitySuffix}`;
      const scopeType = taskId ? "task" : phaseId ? "phase" : "project";
      const scopeId = taskId ?? phaseId ?? input.project_id;
      await sql.query(
        `INSERT INTO human_directions (
           id, project_id, phase_id, task_id, actor_id, idempotency_key,
           direction_target, direction_text, content_hash, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          directionId,
          input.project_id,
          phaseId,
          taskId,
          input.user_id,
          input.idempotency_key,
          input.direction_target,
          input.direction_text.trim(),
          requestFingerprint,
          recordedAt,
        ],
      );
      await sql.query(
        `INSERT INTO project_memory_entries (
           id, project_id, phase_id, task_id, category, content, provenance, source_ref,
           confidence, version, status, approved_by_human, approved_by, approved_at, created_at
         ) VALUES ($1,$2,$3,$4,'directive',$5,'human_proactive_direction',$6::jsonb,
                   1,1,'active',true,$7,$8,$8)`,
        [
          memoryId,
          input.project_id,
          phaseId,
          taskId,
          input.direction_text.trim(),
          JSON.stringify({
            entity_type: "human_direction",
            entity_id: directionId,
          }),
          input.user_id,
          recordedAt,
        ],
      );
      await sql.query(
        `INSERT INTO audit_events (
           audit_id, audit_type, project_id, phase_id, task_id, actor_type, actor_id,
           outcome, severity, correlation_id, occurred_at, targets, summary, details
         ) VALUES ($1,'human_direction_recorded',$2,$3,$4,'human',$5,'succeeded','info',
                   $6,$7,$8::jsonb,'Human direction recorded; agent delivery pending context assembly',$9::jsonb)`,
        [
          `audit:human-direction:${identitySuffix}`,
          input.project_id,
          phaseId,
          taskId,
          input.user_id,
          commandId,
          recordedAt,
          JSON.stringify([
            { entity_type: "human_direction", entity_id: directionId },
            { entity_type: scopeType, entity_id: scopeId },
          ]),
          JSON.stringify({
            human_direction_id: directionId,
            memory_entry_id: memoryId,
            direction_target: input.direction_target,
            delivery_status: "pending_context_assembly",
          }),
        ],
      );
      const response = V2HumanDirectionResult.parse({
        memory_entry_id: memoryId,
        recorded_at: recordedAt,
        replayed: false,
      });
      await sql.query(
        `UPDATE idempotency_records SET status='committed_succeeded', response=$4::jsonb, updated_at=$3
         WHERE actor_id=$1 AND command_family='human_direction' AND idempotency_key=$2`,
        [input.user_id, input.idempotency_key, recordedAt, JSON.stringify(response)],
      );
      return response;
    });
  }

  phase(
    projectId: string,
    phaseId: string,
    // `Omit<..., "phase" | "tasks">` rather than `V2PhaseExecutionT & {phase:
    // ..., tasks: ...}`: intersecting a type with an override of its OWN
    // array-valued property (`tasks`) does not replace that property's
    // element type the way it does for a plain object property (`phase`) —
    // TS keeps both array types and can resolve `.find()`/`.map()` against
    // the wrong one. Omitting the keys first avoids the ambiguity entirely.
  ): Promise<
    Omit<V2PhaseExecutionT, "phase" | "tasks"> & {
      phase: V2PhaseExecutionT["phase"] & V2PhaseProgressT & { planning_mode: "planned" | "quick" };
      tasks: Array<V2PhaseExecutionT["tasks"][number] & { cost: V2TaskCostT }>;
    }
  > {
    return this.transactions.transaction(async (sql) => {
      const phase = await sql.query<{
        id: string;
        objective_summary: string;
        status: string;
        completed_tasks: number;
        total_tasks: number;
        approved_budget_usd: string | number;
        planning_mode: "planned" | "quick";
      }>(
        `SELECT p.id, p.objective_summary, p.status, p.approved_budget_usd,
          COALESCE(MAX(planning.mode), 'planned') AS planning_mode,
          count(t.id) FILTER (WHERE t.state='completed')::int AS completed_tasks,
          count(t.id)::int AS total_tasks
         FROM phases p
         LEFT JOIN planning_runs planning ON planning.id=p.planning_run_id
         LEFT JOIN tasks t ON t.phase_id=p.id
         WHERE p.id=$1 AND p.project_id=$2 GROUP BY p.id`,
        [phaseId, projectId],
      );
      if (!phase.rows[0]) throw new AttentionConflictError("phase not found");
      // EXECUTION E13 — live cost. Real `usage_events` rows, aggregated per
      // run (for the per-task figure) and across the whole phase (for the
      // phase figure). A run/phase with zero matching rows gets `cost_usd:
      // null` back from Postgres (SUM of an empty set), which is exactly the
      // "no data yet" signal `buildTaskCost` and the phase merge below need —
      // never coalesced to 0, which would read as a confirmed free run.
      const runUsage = await sql.query<{
        run_id: string;
        input_tokens: string | number;
        output_tokens: string | number;
        cost_usd: string | number | null;
        last_usage_at: string | Date | null;
      }>(
        `SELECT run_id, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
                SUM(cost_usd) AS cost_usd, MAX(occurred_at) AS last_usage_at
         FROM usage_events
         WHERE phase_id=$1 AND run_id IS NOT NULL
         GROUP BY run_id`,
        [phaseId],
      );
      const usageByRun = new Map(runUsage.rows.map((row) => [row.run_id, row]));
      const phaseUsage = await sql.query<{
        cost_usd: string | number | null;
      }>("SELECT SUM(cost_usd) AS cost_usd FROM usage_events WHERE phase_id=$1", [phaseId]);
      // Each run's OWN reservation (`SqlRunReservationBudget` charges exactly
      // this, so it is "the budget approved for this task" in the same sense
      // the human who approved it would recognise). A run absent here was
      // never scheduled/reserved — null, not a fabricated $0.
      const runBudget = await sql.query<{ run_id: string; amount_usd: string | number }>(
        `SELECT DISTINCT ON (run_id) run_id, amount_usd
         FROM budget_reservations WHERE phase_id=$1
         ORDER BY run_id, created_at DESC`,
        [phaseId],
      );
      const budgetByRun = new Map(runBudget.rows.map((row) => [row.run_id, row.amount_usd]));
      // FRONT DOOR P5 (tracking): same rolling-window progress math as
      // ProjectResumeService.open, scoped to this single phase.
      const recentCompletions = await sql.query<{ completed_at: string | Date }>(
        `SELECT completed_at FROM tasks
         WHERE project_id=$1 AND phase_id=$2 AND state='completed'
         ORDER BY completed_at DESC LIMIT $3`,
        [projectId, phaseId, PROGRESS_WINDOW_SIZE],
      );
      const recentRunCosts = await sql.query<{
        started_at: string | Date | null;
        finished_at: string | Date | null;
        usage_cost_usd: string | number;
      }>(
        `SELECT started_at, finished_at, usage_cost_usd FROM agent_runs
         WHERE project_id=$1 AND phase_id=$2 AND state='succeeded'
           AND started_at IS NOT NULL AND finished_at IS NOT NULL
         ORDER BY finished_at DESC LIMIT $3`,
        [projectId, phaseId, PROGRESS_WINDOW_SIZE],
      );
      const tasks = await sql.query<{
        id: string;
        title: string;
        state: string;
        complexity: string;
        risk: string;
        dependencies: string[];
        implementation_profile_id: string | null;
        provider: string | null;
        model: string | null;
        implementation_roles: unknown;
        reviewer_profile_id: string | null;
        reviewer_provider: string | null;
        reviewer_model: string | null;
        reviewer_roles: unknown;
        assignment_status: string | null;
        run_id: string | null;
        run_state: string | null;
        attempt: number | null;
        verification_status: string | null;
        commit_sha: string | null;
        failure_detail: string | null;
        published_branch: string | null;
        pull_request_url: string | null;
        publication_note: string | null;
        command_results: unknown;
        evidence_count: number;
      }>(
        `SELECT t.id, t.title, t.state, t.complexity, t.risk,
          COALESCE((SELECT jsonb_agg(d.predecessor_task_id ORDER BY d.predecessor_task_id)
                    FROM task_dependencies d WHERE d.successor_task_id=t.id),'[]'::jsonb) AS dependencies,
          profile.id AS implementation_profile_id, profile.provider, profile.model,
          profile.roles AS implementation_roles, assignment.status AS assignment_status,
          reviewer.id AS reviewer_profile_id, reviewer.provider AS reviewer_provider,
          reviewer.model AS reviewer_model, reviewer.roles AS reviewer_roles,
          run.id AS run_id, run.state AS run_state, run.attempt, run.verification_status,
          run.commit_sha, run.failure_detail,
          -- EXECUTION E10: the branch and pull request the run published, so a
          -- finished task is one click from its review instead of one grep
          -- through a run log.
          run.published_branch, run.pull_request_url, run.publication_note,
          -- EXECUTION E10: WHICH command failed, from the designated run's most
          -- recent verification. A red badge over an opaque digest is not
          -- evidence; the failing command's own output is.
          (SELECT verification.command_results FROM verification_results verification
            WHERE verification.run_id = run.id
            ORDER BY verification.created_at DESC, verification.id DESC
            LIMIT 1) AS command_results,
          (SELECT count(*)::int FROM verification_results verification
           WHERE verification.task_id=t.id) AS evidence_count
         FROM tasks t
         LEFT JOIN agent_assignments assignment ON assignment.id=t.designated_assignment_id
         LEFT JOIN agent_profiles profile ON profile.id=assignment.agent_profile_id
         LEFT JOIN agent_profiles reviewer ON reviewer.id=assignment.reviewer_agent_profile_id
         LEFT JOIN agent_runs run ON run.id=t.designated_run_id
         WHERE t.project_id=$1 AND t.phase_id=$2 ORDER BY t.created_at, t.id`,
        [projectId, phaseId],
      );
      const reviewRows = await sql.query<{
        id: string;
        task_id: string;
        run_id: string;
        review_round: number;
        decision: "approved" | "rework" | "escalated";
        summary: string;
        evidence: unknown;
        created_at: string | Date;
        reviewer_profile_id: string;
        reviewer_provider: string;
        reviewer_model: string;
        reviewer_roles: unknown;
      }>(
        `SELECT review.id, review.task_id, review.run_id, review.review_round,
          review.decision, review.summary, review.evidence, review.created_at,
          review.reviewer_agent_profile_id AS reviewer_profile_id,
          review.reviewer_provider, review.reviewer_model, review.reviewer_roles
         FROM agent_reviews review
         WHERE review.project_id=$1 AND review.phase_id=$2
         ORDER BY review.task_id, review.review_round, review.created_at, review.id`,
        [projectId, phaseId],
      );
      const reviewsByTask = new Map<string, typeof reviewRows.rows>();
      for (const review of reviewRows.rows) {
        const current = reviewsByTask.get(review.task_id) ?? [];
        current.push(review);
        reviewsByTask.set(review.task_id, current);
      }
      const phaseRow = phase.rows[0];
      const isExecuting = phaseRow.status === "active";
      const phaseCostUsd = phaseUsage.rows[0]?.cost_usd ?? null;
      const progress: V2PhaseProgressT = {
        percent_complete: computePercentComplete(phaseRow.completed_tasks, phaseRow.total_tasks),
        tasks_completed: phaseRow.completed_tasks,
        tasks_total: phaseRow.total_tasks,
        eta_at: computePhaseEta({
          isExecuting,
          tasksCompleted: phaseRow.completed_tasks,
          tasksTotal: phaseRow.total_tasks,
          recentCompletionTimestamps: recentCompletions.rows.map((row) => row.completed_at),
        }),
        burn_rate_usd_per_hour: computeBurnRateUsdPerHour(recentRunCosts.rows),
        // EXECUTION E13 — live cost (see the header note above this class for
        // the honesty rules these two fields follow).
        spend_usd: phaseCostUsd === null ? null : Number(phaseCostUsd),
        budget_usd: Number(phaseRow.approved_budget_usd),
      };
      // `phaseRow` also carries `approved_budget_usd`, which is NOT part of
      // the strict, contracts-owned `phase` shape — stripped here so it is
      // not fed back through `.parse()` (it is folded into `progress` above
      // instead, merged on afterwards same as every other additive field).
      const {
        approved_budget_usd: _approvedBudgetUsd,
        planning_mode: _planningMode,
        ...phaseRowForContract
      } = phaseRow;
      const base = V2PhaseExecution.parse({
        schema_version: 2,
        project_id: projectId,
        phase: phaseRowForContract,
        tasks: tasks.rows.map((task) => ({
          id: task.id,
          title: task.title,
          state: task.state,
          complexity: task.complexity,
          risk: task.risk,
          dependencies: task.dependencies,
          assignment:
            task.provider && task.model && task.assignment_status
              ? { provider: task.provider, model: task.model, status: task.assignment_status }
              : null,
          implementation_agent:
            task.implementation_profile_id && task.provider && task.model
              ? {
                  profile_id: task.implementation_profile_id,
                  provider: task.provider,
                  model: task.model,
                  roles: Array.isArray(task.implementation_roles) ? task.implementation_roles : [],
                }
              : null,
          reviewer_agent:
            task.reviewer_profile_id && task.reviewer_provider && task.reviewer_model
              ? {
                  profile_id: task.reviewer_profile_id,
                  provider: task.reviewer_provider,
                  model: task.reviewer_model,
                  roles: Array.isArray(task.reviewer_roles) ? task.reviewer_roles : [],
                }
              : null,
          run:
            task.run_id && task.run_state && task.attempt && task.verification_status
              ? {
                  id: task.run_id,
                  state: task.run_state,
                  attempt: task.attempt,
                  verification_status: task.verification_status,
                  commit_sha: task.commit_sha,
                  failure_detail: task.failure_detail,
                  published_branch: task.published_branch,
                  pull_request_url: task.pull_request_url,
                  publication_note: task.publication_note,
                }
              : null,
          failed_verification_commands: failedVerificationCommands(task.command_results),
          evidence_count: task.evidence_count,
          reviews: (reviewsByTask.get(task.id) ?? []).map((review) => ({
            id: review.id,
            run_id: review.run_id,
            review_round: review.review_round,
            decision: review.decision,
            summary: review.summary,
            evidence: review.evidence,
            reviewer: {
              profile_id: review.reviewer_profile_id,
              provider: review.reviewer_provider,
              model: review.reviewer_model,
              roles: Array.isArray(review.reviewer_roles) ? review.reviewer_roles : [],
            },
            created_at: iso(review.created_at),
          })),
        })),
      });
      // EXECUTION E13 — merge the per-task live-cost field onto the
      // contract-parsed object, same as `progress` (with its own spend/budget
      // fields, set above) is merged onto `base.phase`: `V2PhaseExecution`'s
      // per-task shape is a `.strict()` contract owned by packages/contracts,
      // so `cost` is validated locally (`V2TaskCost`) and merged AFTER
      // `.parse()` rather than fed back through it.
      const costByTaskId = new Map(
        tasks.rows.map((task) => [
          task.id,
          buildTaskCost(
            task.run_id ? usageByRun.get(task.run_id) : undefined,
            task.run_id ? budgetByRun.get(task.run_id) : undefined,
          ),
        ]),
      );
      return {
        ...base,
        phase: { ...base.phase, ...progress, planning_mode: phaseRow.planning_mode },
        tasks: base.tasks.map((task) => ({
          ...task,
          cost: costByTaskId.get(task.id) ?? buildTaskCost(undefined, undefined),
        })),
      };
    });
  }

  /**
   * PHASE TAB P1 — lightweight, pollable per-phase execution progress for a
   * whole project. Derived from the same tables the per-phase `phase()` view
   * reads (phases, tasks, agent_runs) with the same shared progress math
   * (computePercentComplete / computePhaseEta) — additive fields on existing
   * data, not a parallel status system. `percent_complete` is the honest
   * completed-tasks/total-tasks ratio; `est_completion` is the rolling-window
   * linear projection and is null whenever there is no throughput signal.
   * `name` is the phase's objective_summary (phases have no separate name
   * column).
   */
  projectExecution(projectId: string): Promise<{
    project_id: string;
    phases: Array<{
      phase_id: string;
      name: string;
      state: string;
      percent_complete: number;
      est_completion: string | null;
      notes: string;
    }>;
  }> {
    return this.transactions.transaction(async (sql) => {
      const project = await sql.query<{ id: string }>("SELECT id FROM projects WHERE id = $1", [
        projectId,
      ]);
      if (!project.rows[0]) throw new AttentionConflictError("project not found");
      const phases = await sql.query<{
        id: string;
        objective_summary: string;
        status: string;
        total_tasks: number;
        completed_tasks: number;
        failed_tasks: number;
        blocked_tasks: number;
        active_runs: number;
      }>(
        `SELECT p.id, p.objective_summary, p.status,
           count(t.id)::int AS total_tasks,
           count(t.id) FILTER (WHERE t.state = 'completed')::int AS completed_tasks,
           count(t.id) FILTER (WHERE t.state = 'failed')::int AS failed_tasks,
           count(t.id) FILTER (WHERE t.state = 'blocked')::int AS blocked_tasks,
           count(run.id) FILTER (
             WHERE run.state IN ('created','dispatched','running','verifying')
           )::int AS active_runs
         FROM phases p
         LEFT JOIN tasks t ON t.phase_id = p.id
         LEFT JOIN agent_runs run ON run.id = t.designated_run_id
         WHERE p.project_id = $1
         GROUP BY p.id
         ORDER BY p.priority ASC, p.created_at ASC, p.id ASC`,
        [projectId],
      );
      const result = [];
      for (const phase of phases.rows) {
        const isExecuting = phase.status === "active";
        // ETA needs the phase's recent completion timestamps; only an
        // executing phase can have one at all, so skip the query otherwise.
        let etaAt: string | null = null;
        if (isExecuting) {
          const recentCompletions = await sql.query<{ completed_at: string | Date }>(
            `SELECT completed_at FROM tasks
             WHERE project_id = $1 AND phase_id = $2 AND state = 'completed'
             ORDER BY completed_at DESC LIMIT $3`,
            [projectId, phase.id, PROGRESS_WINDOW_SIZE],
          );
          etaAt = computePhaseEta({
            isExecuting,
            tasksCompleted: phase.completed_tasks,
            tasksTotal: phase.total_tasks,
            recentCompletionTimestamps: recentCompletions.rows.map((row) => row.completed_at),
          });
        }
        const noteParts =
          phase.total_tasks === 0
            ? ["no tasks yet"]
            : [`${phase.completed_tasks}/${phase.total_tasks} tasks complete`];
        if (phase.active_runs > 0) noteParts.push(`${phase.active_runs} run(s) active`);
        if (phase.failed_tasks > 0) noteParts.push(`${phase.failed_tasks} task(s) failed`);
        if (phase.blocked_tasks > 0) noteParts.push(`${phase.blocked_tasks} task(s) blocked`);
        result.push({
          phase_id: phase.id,
          name: phase.objective_summary,
          state: phase.status,
          percent_complete: computePercentComplete(phase.completed_tasks, phase.total_tasks),
          est_completion: etaAt,
          notes: noteParts.join("; "),
        });
      }
      return { project_id: projectId, phases: result };
    });
  }

  /**
   * EXECUTION E13 — live activity: the streamed `run_log` output for a
   * task's designated run, tailed from `runner_events` (the durable store
   * every runner event already lands in; `run_log` rows were previously
   * write-only — recorded, never read back anywhere a human could see them).
   *
   * Two modes, chosen by `options.after`:
   *  - omitted: returns the current TAIL (the most recent
   *    `RUN_LOG_PAGE_LIMIT` entries) — the shape a panel wants on first open.
   *  - provided: returns entries with `sequence` strictly greater than the
   *    cursor, oldest first — what a panel wants on every poll after that,
   *    so it can append rather than re-render the whole log.
   *
   * `runner_events.run_id` is never populated by the event processor (an
   * existing gap outside this phase's ownership — see the E13 report), so
   * this scopes by `(runner_id, runner_generation)` — the same durable
   * dispatch fence `SqlProxiedRunLookup` authorizes against — and then
   * filters on the run id carried inside the `run_log` payload itself, which
   * IS schema-validated at the event boundary.
   */
  runLog(
    projectId: string,
    phaseId: string,
    taskId: string,
    options: { after?: number } = {},
  ): Promise<V2RunLogTailT> {
    return this.transactions.transaction(async (sql) => {
      const scope = await sql.query<{
        run_id: string;
        runner_id: string | null;
        runner_generation: number | string | null;
      }>(
        `SELECT run.id AS run_id, run.runner_id,
                (SELECT command.runner_generation FROM commands command
                  WHERE command.run_id = run.id
                  ORDER BY command.created_at DESC, command.command_id DESC LIMIT 1) AS runner_generation
         FROM tasks t
         JOIN agent_runs run ON run.id = t.designated_run_id
         WHERE t.id=$1 AND t.project_id=$2 AND t.phase_id=$3`,
        [taskId, projectId, phaseId],
      );
      const row = scope.rows[0];
      // No designated run, or a run this server cannot fence (no runner_id /
      // no dispatch generation) — nothing to tail. Honest empty, not an error:
      // a task with no run yet is a completely normal state.
      if (!row || !row.runner_id || row.runner_generation === null) {
        return V2RunLogTail.parse({
          run_id: row?.run_id ?? null,
          entries: [],
          truncated: false,
          total_entries: null,
        });
      }
      const runnerId = row.runner_id;
      const generation = Number(row.runner_generation);
      const runId = row.run_id;
      // -1 is a safe "no cursor" sentinel: `sequence` is a positive per-runner
      // counter (see EventEnvelope), so `sequence > -1` matches everything.
      const cursor = options.after ?? -1;
      const tailMode = options.after === undefined;

      const counts = await sql.query<{
        total: number | string;
        available_after_cursor: number | string;
      }>(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE sequence > $4)::int AS available_after_cursor
         FROM runner_events
         WHERE runner_id=$1 AND runner_generation=$2 AND event_type='run_log'
           AND payload->>'run_id'=$3`,
        [runnerId, generation, runId, cursor],
      );
      const totalCount = Number(counts.rows[0]?.total ?? 0);
      const availableCount = Number(counts.rows[0]?.available_after_cursor ?? 0);

      const entries = await sql.query<{
        sequence: number | string;
        received_at: string | Date;
        chunk: string | null;
      }>(
        `SELECT sequence, received_at, payload->>'chunk' AS chunk
         FROM runner_events
         WHERE runner_id=$1 AND runner_generation=$2 AND event_type='run_log'
           AND payload->>'run_id'=$3 AND sequence > $4
         ORDER BY sequence ${tailMode ? "DESC" : "ASC"}
         LIMIT $5`,
        [runnerId, generation, runId, cursor, RUN_LOG_PAGE_LIMIT],
      );
      const ordered = tailMode ? entries.rows.slice().reverse() : entries.rows;
      return V2RunLogTail.parse({
        run_id: runId,
        entries: ordered.map((entry) => ({
          sequence: Number(entry.sequence),
          occurred_at: iso(entry.received_at),
          chunk: (entry.chunk ?? "").slice(0, RUN_LOG_MAX_CHUNK_CHARS),
        })),
        truncated: availableCount > entries.rows.length,
        total_entries: totalCount,
      });
    });
  }
}
