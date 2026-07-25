import {
  type EventEnvelopeT,
  type EventPayloadT,
  type V2ActorT,
  V2TaskContextManifest,
} from "@norns/contracts";
import { KnowledgeSystemError, KnowledgeSystemService } from "../knowledge/service.js";
import { canonicalJson, canonicalSha256 } from "../persistence/migration/canonicalJson.js";
import type { V2SqlExecutor, V2TransactionRunner } from "../persistence/v2/database.js";

type KnowledgePayload = Extract<
  EventPayloadT,
  {
    kind:
      | "knowledge_registration"
      | "knowledge_heartbeat"
      | "knowledge_delta"
      | "knowledge_handoff";
  }
>;

export type Phase4KnowledgeEvent = EventEnvelopeT & { payload: KnowledgePayload };

export interface Phase4KnowledgeRunScope {
  id: string;
  project_id: string;
  phase_id: string;
  task_id: string;
  execution_mode?: "quick" | "planned";
  expected_revision?: string;
}

export interface Phase4KnowledgeApplyResult {
  applied: boolean;
  completion_gate_passed?: boolean;
  reason?: string;
}

export interface Phase4QuickDeltaEvidence {
  artifact_id: string;
  content_hash: string;
}

class BoundTransactionRunner implements V2TransactionRunner {
  constructor(private readonly sql: V2SqlExecutor) {}

  transaction<T>(work: (tx: V2SqlExecutor) => Promise<T>): Promise<T> {
    return work(this.sql);
  }
}

async function registrationExists(sql: V2SqlExecutor, runId: string): Promise<boolean> {
  const result = await sql.query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM agent_execution_registrations WHERE run_id=$1
     ) AS present`,
    [runId],
  );
  return result.rows[0]?.present === true;
}

function runnerActor(event: EventEnvelopeT): V2ActorT {
  return { actor_type: "runner", actor_id: event.runner_id };
}

function strings(value: unknown): string[] {
  const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  return Array.isArray(parsed)
    ? parsed.filter(
        (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
      )
    : [];
}

/**
 * Persists capability-negotiated runner knowledge events in the same database
 * transaction as the durable runner-event watermark.
 *
 * The public KnowledgeSystemService remains the one validator and audit writer.
 * A transaction-bound adapter avoids a nested BEGIN while keeping runner event
 * deduplication, knowledge writes, and `applied_at` atomic.
 */
export class Phase4KnowledgeEventAdapter {
  async apply(
    sql: V2SqlExecutor,
    event: Phase4KnowledgeEvent,
    scope: Phase4KnowledgeRunScope,
  ): Promise<Phase4KnowledgeApplyResult> {
    const service = new KnowledgeSystemService(new BoundTransactionRunner(sql));
    const actor = runnerActor(event);

    try {
      if (event.payload.kind === "knowledge_registration") {
        if (await registrationExists(sql, scope.id))
          return { applied: false, reason: "registered" };
        let manifest = await sql.query<{ id: string }>(
          `SELECT manifest.id
             FROM task_context_manifests manifest
             JOIN task_knowledge_packages task_package
               ON task_package.id=manifest.task_package_id
            WHERE manifest.task_id=$1 AND task_package.status='approved'
            ORDER BY manifest.generated_at DESC, manifest.id DESC
            LIMIT 1`,
          [scope.task_id],
        );
        let contextManifestId = manifest.rows[0]?.id;
        if (!contextManifestId && scope.execution_mode === "quick") {
          const task = await sql.query<{
            title: string;
            description: string;
            deliverables: unknown;
            acceptance_criteria: unknown;
          }>(
            `SELECT title, description, deliverables, acceptance_criteria
               FROM tasks WHERE id=$1`,
            [scope.task_id],
          );
          const taskRow = task.rows[0];
          if (!taskRow) return { applied: false, reason: "task_not_found" };
          const dependencies = await sql.query<{ predecessor_task_id: string }>(
            `SELECT predecessor_task_id FROM task_dependencies
              WHERE successor_task_id=$1 ORDER BY predecessor_task_id`,
            [scope.task_id],
          );
          const deliverables = strings(taskRow.deliverables);
          const acceptanceCriteria = strings(taskRow.acceptance_criteria);
          const taskPackage =
            (await service.getApprovedTaskPackage(scope.task_id)) ??
            (await service.createTaskPackage({
              task_id: scope.task_id,
              status: "approved",
              assignment: taskRow.title,
              expected_outcome: taskRow.description.trim() || taskRow.title,
              business_or_user_outcome: taskRow.description.trim(),
              scope: [taskRow.description.trim() || taskRow.title],
              out_of_scope: [],
              deliverables:
                deliverables.length > 0
                  ? deliverables
                  : [`Complete Quick Change: ${taskRow.title}`],
              // Quick Change deliberately skips detailed planning. An
              // undeclared file scope is honest; the runner's handoff records
              // the files it actually changed.
              file_scope_declared: false,
              permitted_files: [],
              restricted_files: [],
              required_package_ids: [],
              required_interface_contract_ids: [],
              required_decision_record_ids: [],
              dependencies: dependencies.rows.map((row) => row.predecessor_task_id),
              acceptance_criteria:
                acceptanceCriteria.length > 0
                  ? acceptanceCriteria
                  : [`The requested Quick Change "${taskRow.title}" is verified.`],
              required_tests: [],
              performance_requirements: [],
              accessibility_requirements: [],
              reporting_interval_seconds: 300,
              escalation_conditions: [
                "Verification fails or the work expands beyond the requested Quick Change.",
              ],
              completion_format: "Verified commit with structured runner handoff.",
              branch_or_workspace: event.payload.branch_or_workspace,
              token_budget: event.payload.token_budget,
              actor: { actor_type: "system", actor_id: "system:quick-change" },
              created_at: event.occurred_at,
            }));
          const manifestSemantic = {
            project_id: scope.project_id,
            phase_id: scope.phase_id,
            task_id: scope.task_id,
            task_package_id: taskPackage.id,
            generated_by: { actor_type: "system" as const, actor_id: "system:quick-change" },
            repository_commit: scope.expected_revision ?? "repository-revision-unavailable",
            included_packages: [],
            included_decision_records: [],
            included_interface_contracts: [],
            included_source_files: [],
            included_test_files: [],
            included_current_state: [],
            explicitly_excluded_context: [
              {
                item: "Detailed planning knowledge",
                reason: "Quick Change uses the approved execution briefing directly.",
              },
            ],
            known_context_limitations: [
              "Quick Change did not require project and phase knowledge-package assembly.",
            ],
            unresolved_questions: [],
          };
          const estimatedTokens = Math.ceil(
            Buffer.byteLength(canonicalJson(manifestSemantic), "utf8") / 4,
          );
          const contentHash = canonicalSha256({
            ...manifestSemantic,
            estimated_tokens: estimatedTokens,
          });
          const quickManifest = V2TaskContextManifest.parse({
            schema_version: 2,
            id: `quick-manifest:${scope.task_id}:${contentHash.slice(0, 24)}`,
            ...manifestSemantic,
            estimated_tokens: estimatedTokens,
            content_hash: contentHash,
            generated_at: event.occurred_at,
          });
          await sql.query(
            `INSERT INTO task_context_manifests (
               id, project_id, phase_id, task_id, task_package_id, repository_commit,
               content, content_hash, generated_by_actor_type, generated_by_actor_id,
               estimated_tokens, generated_at
             ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12)
             ON CONFLICT (task_id, content_hash) DO NOTHING`,
            [
              quickManifest.id,
              quickManifest.project_id,
              quickManifest.phase_id,
              quickManifest.task_id,
              quickManifest.task_package_id,
              quickManifest.repository_commit,
              JSON.stringify(quickManifest),
              quickManifest.content_hash,
              quickManifest.generated_by.actor_type,
              quickManifest.generated_by.actor_id,
              quickManifest.estimated_tokens,
              quickManifest.generated_at,
            ],
          );
          manifest = await sql.query<{ id: string }>(
            `SELECT id FROM task_context_manifests
              WHERE task_id=$1 ORDER BY generated_at DESC, id DESC LIMIT 1`,
            [scope.task_id],
          );
          contextManifestId = manifest.rows[0]?.id;
        }
        if (!contextManifestId) {
          // Knowledge transport is optional. Tasks created before the knowledge
          // system have no approved package/manifest and must keep executing.
          return { applied: false, reason: "no_context_manifest" };
        }
        await service.registerAgent({
          run_id: scope.id,
          context_manifest_id: contextManifestId,
          provider: event.payload.provider,
          model: event.payload.model,
          branch_or_workspace: event.payload.branch_or_workspace,
          token_budget: event.payload.token_budget,
          actor,
          registered_at: event.occurred_at,
        });
        return { applied: true };
      }

      if (!(await registrationExists(sql, scope.id))) {
        return { applied: false, reason: "run_not_registered" };
      }

      if (event.payload.kind === "knowledge_heartbeat") {
        await service.recordHeartbeat({
          run_id: scope.id,
          reported_at: event.occurred_at,
          status: event.payload.status,
          completed_since_last_update: event.payload.completed_since_last_update,
          currently_working_on: event.payload.currently_working_on,
          findings: event.payload.findings,
          blockers: event.payload.blockers,
          decisions_needed: event.payload.decisions_needed,
          files_changed: event.payload.files_changed,
          tests: event.payload.tests,
          estimated_remaining_work: event.payload.estimated_remaining_work,
          risk_level: event.payload.risk_level,
          actor,
        });
        return { applied: true };
      }

      if (event.payload.kind === "knowledge_delta") {
        const existing = await sql.query<{ id: string }>(
          "SELECT id FROM knowledge_deltas WHERE run_id=$1 ORDER BY submitted_at DESC LIMIT 1",
          [scope.id],
        );
        if (existing.rows[0]) return { applied: false, reason: "delta_already_submitted" };
        await service.submitKnowledgeDelta({
          run_id: scope.id,
          changes: event.payload.changes,
          recommended_package_updates: event.payload.recommended_package_updates,
          submitted_at: event.occurred_at,
          actor,
        });
        return { applied: true };
      }

      if (event.payload.kind !== "knowledge_handoff") {
        return { applied: false, reason: "unsupported_knowledge_event" };
      }
      const handoff = event.payload;
      const existingHandoff = await sql.query<{ id: string }>(
        "SELECT id FROM agent_handoffs WHERE run_id=$1",
        [scope.id],
      );
      if (!existingHandoff.rows[0]) {
        const taskPackage = await service.getApprovedTaskPackage(scope.task_id);
        const run = await sql.query<{ verification_status: string }>(
          "SELECT verification_status FROM agent_runs WHERE id=$1",
          [scope.id],
        );
        const verificationPassed = run.rows[0]?.verification_status === "passed";
        const completed = handoff.status === "completed" && verificationPassed;
        const acceptanceCriteria =
          handoff.acceptance_criteria.length > 0
            ? handoff.acceptance_criteria
            : (taskPackage?.acceptance_criteria ?? []).map((criterion) => ({
                criterion,
                result: completed ? ("pass" as const) : ("partial" as const),
                evidence: completed
                  ? `Runner verification passed for ${handoff.commit}.`
                  : handoff.summary,
              }));
        const delta = await sql.query<{ id: string }>(
          "SELECT id FROM knowledge_deltas WHERE run_id=$1 ORDER BY submitted_at DESC LIMIT 1",
          [scope.id],
        );
        await service.submitHandoff({
          run_id: scope.id,
          status: handoff.status,
          summary: handoff.summary,
          deliverables: completed && taskPackage ? taskPackage.deliverables : handoff.deliverables,
          files_changed: handoff.files_changed,
          interfaces_used: handoff.interfaces_used,
          interfaces_changed: handoff.interfaces_changed,
          tests_added: handoff.tests_added,
          test_results: handoff.test_results,
          acceptance_criteria: acceptanceCriteria,
          known_limitations: handoff.known_limitations,
          open_issues: handoff.open_issues,
          dependencies_created: handoff.dependencies_created,
          knowledge_delta_id: delta.rows[0]?.id ?? null,
          recommended_package_updates: handoff.recommended_package_updates,
          recommended_follow_up_tasks: handoff.recommended_follow_up_tasks,
          branch: handoff.branch,
          commit: handoff.commit,
          artifacts: handoff.artifacts,
          submitted_at: event.occurred_at,
          actor,
        });
      }
      const gate = await service.evaluateTaskCompletion({
        task_id: scope.task_id,
        evaluated_at: event.occurred_at,
      });
      return { applied: !existingHandoff.rows[0], completion_gate_passed: gate.passed };
    } catch (error) {
      if (
        error instanceof KnowledgeSystemError &&
        ["not_found", "missing_context", "invalid_transition"].includes(error.code)
      ) {
        // Optional knowledge evidence must never wedge the core runner event
        // stream into a reconnect/replay loop. The original event remains in
        // runner_events for diagnosis and future repair.
        return { applied: false, reason: error.code };
      }
      throw error;
    }
  }

  async evaluateCompletion(
    sql: V2SqlExecutor,
    taskId: string,
    evaluatedAt: string,
  ): Promise<{ passed: boolean; blockers: string[] }> {
    const service = new KnowledgeSystemService(new BoundTransactionRunner(sql));
    const gate = await service.evaluateTaskCompletion({
      task_id: taskId,
      evaluated_at: evaluatedAt,
    });
    return { passed: gate.passed, blockers: gate.blockers };
  }

  /**
   * A no-review Quick Change owns its runner-authored delta: once exact-commit
   * verification, publication, and handoff have been established by the
   * caller, accepting that delta is orchestration reconciliation rather than a
   * separate human review. The write uses the normal knowledge service so its
   * attribution and audit evidence are identical to every other disposition.
   */
  async acceptQuickCompletionDelta(
    sql: V2SqlExecutor,
    scope: Phase4KnowledgeRunScope,
    dispositionedAt: string,
  ): Promise<Phase4QuickDeltaEvidence> {
    if (scope.execution_mode !== "quick") {
      throw new KnowledgeSystemError(
        "approval_required",
        "automatic knowledge-delta acceptance is limited to Quick Change completion",
      );
    }
    const service = new KnowledgeSystemService(new BoundTransactionRunner(sql));
    const found = await sql.query<{ id: string; status: string }>(
      `SELECT delta.id, delta.status
         FROM agent_handoffs handoff
         JOIN knowledge_deltas delta ON delta.id=handoff.knowledge_delta_id
        WHERE handoff.run_id=$1 AND handoff.task_id=$2
          AND handoff.status='completed'
        ORDER BY handoff.submitted_at DESC
        LIMIT 1
        FOR UPDATE OF delta`,
      [scope.id, scope.task_id],
    );
    const delta = found.rows[0];
    if (!delta) {
      throw new KnowledgeSystemError(
        "missing_context",
        "Quick Change completion requires the handoff's knowledge delta",
      );
    }
    if (delta.status === "proposed") {
      await service.dispositionKnowledgeDelta({
        delta_id: delta.id,
        status: "accepted",
        note: "Automatically accepted from successful no-review Quick Change after exact-commit verification, publication, and completed handoff.",
        actor: { actor_type: "coordinator", actor_id: "system:phase4-quick-completion" },
        dispositioned_at: dispositionedAt,
      });
    } else if (delta.status !== "accepted") {
      throw new KnowledgeSystemError(
        "approval_required",
        `Quick Change knowledge delta is ${delta.status}; automatic acceptance requires proposed or accepted evidence`,
      );
    }
    const evidence = await sql.query<{ id: string; durable_evidence: unknown }>(
      `SELECT id,
              jsonb_build_object(
                'id', id,
                'run_id', run_id,
                'status', status,
                'changes', changes,
                'recommended_package_updates', recommended_package_updates,
                'submitted_at', submitted_at,
                'disposition_note', disposition_note,
                'dispositioned_by_actor_type', dispositioned_by_actor_type,
                'dispositioned_by_actor_id', dispositioned_by_actor_id,
                'dispositioned_at', dispositioned_at
              ) AS durable_evidence
         FROM knowledge_deltas WHERE id=$1 AND status='accepted'`,
      [delta.id],
    );
    const accepted = evidence.rows[0];
    if (!accepted) {
      throw new KnowledgeSystemError(
        "conflict",
        "Quick Change knowledge delta did not remain accepted",
      );
    }
    return {
      artifact_id: accepted.id,
      content_hash: canonicalSha256(accepted.durable_evidence),
    };
  }

  async evaluatePhaseCompletion(
    sql: V2SqlExecutor,
    projectId: string,
    phaseId: string,
    evaluatedAt: string,
  ): Promise<{ passed: boolean; blockers: string[] }> {
    const service = new KnowledgeSystemService(new BoundTransactionRunner(sql));
    const gate = await service.evaluatePhaseCompletion({
      project_id: projectId,
      phase_id: phaseId,
      evaluated_at: evaluatedAt,
    });
    return { passed: gate.passed, blockers: gate.blockers };
  }
}
