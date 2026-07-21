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
           FROM decision_points d JOIN projects p ON p.id=d.project_id WHERE d.status='open'
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
           FROM agent_runs r JOIN projects p ON p.id=r.project_id
           WHERE r.state IN ('failed','expired')
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
         ) attention_sources`,
        [now.toISOString()],
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
        const blocked = projectItems.some((item) => item.severity === "critical");
        const attention = projectItems.length > 0;
        return {
          ...project,
          health: blocked
            ? ("blocked" as const)
            : attention
              ? ("attention" as const)
              : ("healthy" as const),
          attention_count: projectItems.length,
          next_action:
            projectItems[0]?.recommendation ??
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
  ): Promise<V2PhaseExecutionT & { phase: V2PhaseExecutionT["phase"] & V2PhaseProgressT }> {
    return this.transactions.transaction(async (sql) => {
      const phase = await sql.query<{
        id: string;
        objective_summary: string;
        status: string;
        completed_tasks: number;
        total_tasks: number;
      }>(
        `SELECT p.id, p.objective_summary, p.status,
          count(t.id) FILTER (WHERE t.state='completed')::int AS completed_tasks,
          count(t.id)::int AS total_tasks
         FROM phases p LEFT JOIN tasks t ON t.phase_id=p.id
         WHERE p.id=$1 AND p.project_id=$2 GROUP BY p.id`,
        [phaseId, projectId],
      );
      if (!phase.rows[0]) throw new AttentionConflictError("phase not found");
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
      };
      const base = V2PhaseExecution.parse({
        schema_version: 2,
        project_id: projectId,
        phase: phaseRow,
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
      return { ...base, phase: { ...base.phase, ...progress } };
    });
  }
}
