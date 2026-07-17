import { createHash } from "node:crypto";
import {
  V2AgentReview,
  type V2AgentReviewT,
  V2AllocationScore,
  type V2AllocationScoreT,
  V2CoordinationAllocation,
  type V2CoordinationAllocationT,
  V2CoordinationSnapshot,
  type V2CoordinationSnapshotT,
  type V2EvidenceRefT,
} from "@norns/contracts";
import { resolveV2BudgetReservation } from "@norns/contracts";
import type { V2TransactionRunner } from "../persistence/v2/database.js";
import { SqlV2BudgetTransaction } from "../persistence/v2/sqlRepositories.js";

interface TaskCandidateRow {
  task_id: string;
  assignment_id: string;
  project_id: string;
  phase_id: string;
  required_roles: unknown;
  required_capabilities: unknown;
  risk: "low" | "medium" | "high" | "critical";
  assignment_policy_ref: string;
  estimated_context_tokens: number;
  conflict_keys: unknown;
  requires_independent_review: boolean;
}

export interface Phase6AgentCandidate {
  id: string;
  provider: string;
  runtime: string;
  model: string;
  roles: string[];
  capabilities: string[];
  context_limit_tokens: number;
  security_restrictions: string[];
  status: "available" | "busy" | "offline" | "disabled";
  active_workload: number;
  max_concurrent_runs: number;
  average_latency_ms: number;
  failure_count: number;
  cost_metadata: {
    billing_mode?: string;
    input_usd_per_million?: number | null;
    output_usd_per_million?: number | null;
  };
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function ratio(required: readonly string[], actual: readonly string[]): number {
  if (required.length === 0) return 1;
  const present = new Set(actual.map((item) => item.toLowerCase()));
  return required.filter((item) => present.has(item.toLowerCase())).length / required.length;
}

/** Pure deterministic ranking used by both the coordinator and its simulations. */
export function rankPhase6AgentCandidates(
  task: {
    required_roles: string[];
    required_capabilities: string[];
    risk: "low" | "medium" | "high" | "critical";
    estimated_context_tokens: number;
  },
  candidates: readonly Phase6AgentCandidate[],
): V2AllocationScoreT[] {
  const highRisk = task.risk === "high" || task.risk === "critical";
  return candidates
    .filter(
      (candidate) =>
        candidate.status === "available" &&
        candidate.active_workload < candidate.max_concurrent_runs &&
        candidate.context_limit_tokens >= task.estimated_context_tokens &&
        !candidate.security_restrictions.includes("no_repository_write"),
    )
    .map((candidate) => {
      const capabilityFit = ratio(task.required_capabilities, candidate.capabilities);
      const roleFit = ratio(task.required_roles, candidate.roles);
      const contextFit = Math.min(
        1,
        candidate.context_limit_tokens / task.estimated_context_tokens,
      );
      const workloadFit = Math.max(
        0,
        1 - candidate.active_workload / candidate.max_concurrent_runs,
      );
      const reliabilityFit = 1 / (1 + candidate.failure_count);
      const apiRate =
        Number(candidate.cost_metadata.input_usd_per_million ?? 0) +
        Number(candidate.cost_metadata.output_usd_per_million ?? 0);
      const costFit = candidate.cost_metadata.billing_mode === "api" ? 1 / (1 + apiRate / 20) : 1;
      const score =
        capabilityFit * 35 +
        roleFit * 20 +
        contextFit * 10 +
        workloadFit * 15 +
        reliabilityFit * (highRisk ? 15 : 10) +
        costFit * (highRisk ? 5 : 10) -
        Math.min(candidate.average_latency_ms / 10_000, 5);
      return V2AllocationScore.parse({
        agent_profile_id: candidate.id,
        reviewer_agent_profile_id: null,
        score,
        capability_fit: capabilityFit,
        role_fit: roleFit,
        context_fit: contextFit,
        workload_fit: workloadFit,
        reliability_fit: reliabilityFit,
        cost_fit: costFit,
        rationale: `${candidate.provider}/${candidate.model}: capability ${capabilityFit.toFixed(2)}, role ${roleFit.toFixed(2)}, workload ${workloadFit.toFixed(2)}, reliability ${reliabilityFit.toFixed(2)}`,
      });
    })
    .filter((score) => score.capability_fit === 1 && score.role_fit > 0)
    .sort(
      (left, right) =>
        right.score - left.score || left.agent_profile_id.localeCompare(right.agent_profile_id),
    );
}

export class Phase6CoordinationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Phase6CoordinationConflictError";
  }
}

export class Phase6CoordinationService {
  constructor(private readonly transactions: V2TransactionRunner) {}

  allocate(taskId: string, decidedAt: string): Promise<V2CoordinationAllocationT> {
    return this.transactions.transaction(async (sql) => {
      const taskResult = await sql.query<TaskCandidateRow>(
        `SELECT task.id AS task_id, assignment.id AS assignment_id,
                task.project_id, task.phase_id, task.required_roles,
                task.required_capabilities, task.risk, project.assignment_policy_ref,
                COALESCE(constraint_row.estimated_context_tokens, 1) AS estimated_context_tokens,
                COALESCE(constraint_row.conflict_keys, '[]'::jsonb) AS conflict_keys,
                COALESCE(constraint_row.requires_independent_review, true) AS requires_independent_review
         FROM tasks task
         JOIN projects project ON project.id=task.project_id
         JOIN agent_assignments assignment ON assignment.task_id=task.id
           AND assignment.status IN ('proposed','active')
         LEFT JOIN task_coordination_constraints constraint_row ON constraint_row.task_id=task.id
         WHERE task.id=$1 AND task.state IN ('pending','ready','in_review')
         ORDER BY assignment.created_at DESC LIMIT 1
         FOR UPDATE OF task, assignment`,
        [taskId],
      );
      const task = taskResult.rows[0];
      if (!task) throw new Phase6CoordinationConflictError("task is not allocatable");
      const profileResult = await sql.query<Phase6AgentCandidate>(
        `SELECT id, provider, runtime, model, roles, capabilities,
                context_limit_tokens, security_restrictions, status, active_workload,
                max_concurrent_runs, average_latency_ms, failure_count, cost_metadata
         FROM agent_profiles WHERE status IN ('available','busy') ORDER BY id`,
      );
      const profiles = profileResult.rows.map((row) => ({
        ...row,
        roles: strings(row.roles),
        capabilities: strings(row.capabilities),
        security_restrictions: strings(row.security_restrictions),
      }));
      const ranked = rankPhase6AgentCandidates(
        {
          required_roles: strings(task.required_roles),
          required_capabilities: strings(task.required_capabilities),
          risk: task.risk,
          estimated_context_tokens: task.estimated_context_tokens,
        },
        profiles,
      );
      const selectedBase = ranked[0];
      if (!selectedBase) throw new Phase6CoordinationConflictError("no capable agent is available");
      const selectedProfile = profiles.find(
        (profile) => profile.id === selectedBase.agent_profile_id,
      );
      const reviewCandidates = profiles
        .filter(
          (profile) =>
            profile.id !== selectedBase.agent_profile_id &&
            profile.status === "available" &&
            profile.active_workload < profile.max_concurrent_runs &&
            ratio(strings(task.required_capabilities), profile.capabilities) === 1 &&
            profile.roles.some((role) =>
              ["architecture", "security", "testing", "integration", "code_quality"].includes(role),
            ),
        )
        .sort((left, right) => {
          const leftCross = left.provider !== selectedProfile?.provider ? 1 : 0;
          const rightCross = right.provider !== selectedProfile?.provider ? 1 : 0;
          return (
            rightCross - leftCross ||
            left.active_workload - right.active_workload ||
            left.id.localeCompare(right.id)
          );
        });
      const reviewer = task.requires_independent_review ? reviewCandidates[0] : undefined;
      if (task.requires_independent_review && !reviewer) {
        throw new Phase6CoordinationConflictError("independent review capacity is unavailable");
      }
      const selected = V2AllocationScore.parse({
        ...selectedBase,
        reviewer_agent_profile_id: reviewer?.id ?? null,
      });
      const sequence = await sql.query<{ next: number }>(
        "SELECT count(*)::int + 1 AS next FROM agent_allocation_decisions WHERE task_id=$1",
        [task.task_id],
      );
      const decisionId = `allocation:${task.task_id}:${sequence.rows[0]?.next ?? 1}`;
      const conflictKeys = strings(task.conflict_keys);
      const allocation = V2CoordinationAllocation.parse({
        schema_version: 2,
        decision_id: decisionId,
        project_id: task.project_id,
        phase_id: task.phase_id,
        task_id: task.task_id,
        assignment_id: task.assignment_id,
        selected,
        alternatives: ranked.slice(1, 4),
        conflict_keys: conflictKeys,
        policy_ref: task.assignment_policy_ref,
        decided_at: decidedAt,
      });
      await sql.query(
        `UPDATE agent_assignments
         SET agent_profile_id=$2, reviewer_agent_profile_id=$3,
             rationale=$4, rationale_factors=$5::jsonb,
             allocation_policy_ref=$6, aggregate_version=aggregate_version+1, updated_at=$7
         WHERE id=$1`,
        [
          task.assignment_id,
          selected.agent_profile_id,
          selected.reviewer_agent_profile_id,
          selected.rationale,
          JSON.stringify(["capability", "workload", "risk", "budget", "review"]),
          task.assignment_policy_ref,
          decidedAt,
        ],
      );
      await sql.query(
        `INSERT INTO agent_allocation_decisions (
           id, project_id, phase_id, task_id, assignment_id, agent_profile_id,
           reviewer_agent_profile_id, score, factors, alternatives, conflict_keys,
           policy_ref, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12,$13)`,
        [
          decisionId,
          task.project_id,
          task.phase_id,
          task.task_id,
          task.assignment_id,
          selected.agent_profile_id,
          selected.reviewer_agent_profile_id,
          selected.score,
          JSON.stringify(selected),
          JSON.stringify(allocation.alternatives),
          JSON.stringify(conflictKeys),
          task.assignment_policy_ref,
          decidedAt,
        ],
      );
      return allocation;
    });
  }

  snapshot(
    projectId: string,
    phaseId: string,
    generatedAt: string,
  ): Promise<V2CoordinationSnapshotT> {
    return this.transactions.transaction(async (sql) => {
      const counts = await sql.query<{
        ready_tasks: number;
        active_tasks: number;
        available_agents: number;
        active_providers: unknown;
      }>(
        `SELECT
          (SELECT count(*)::int FROM tasks WHERE phase_id=$2 AND state IN ('pending','ready')) AS ready_tasks,
          (SELECT count(*)::int FROM tasks WHERE phase_id=$2 AND state IN ('assigned','in_progress','verifying','in_review')) AS active_tasks,
          (SELECT count(*)::int FROM agent_profiles WHERE status='available' AND active_workload < max_concurrent_runs) AS available_agents,
          (SELECT COALESCE(jsonb_agg(DISTINCT profile.provider), '[]'::jsonb)
             FROM agent_runs run JOIN agent_assignments assignment ON assignment.id=run.assignment_id
             JOIN agent_profiles profile ON profile.id=assignment.agent_profile_id
             WHERE run.phase_id=$2 AND run.state IN ('created','dispatched','running','verifying')) AS active_providers
         WHERE EXISTS (SELECT 1 FROM phases WHERE id=$2 AND project_id=$1)`,
        [projectId, phaseId],
      );
      const row = counts.rows[0];
      if (!row) throw new Phase6CoordinationConflictError("phase was not found");
      return V2CoordinationSnapshot.parse({
        schema_version: 2,
        project_id: projectId,
        phase_id: phaseId,
        ready_tasks: row.ready_tasks,
        active_tasks: row.active_tasks,
        available_agents: row.available_agents,
        active_providers: strings(row.active_providers),
        blocked_by_capacity: [],
        blocked_by_conflict: [],
        generated_at: generatedAt,
      });
    });
  }

  recordReview(input: {
    project_id: string;
    phase_id: string;
    task_id: string;
    run_id: string;
    reviewer_agent_profile_id: string;
    decision: "approved" | "rework" | "escalated";
    summary: string;
    evidence: V2EvidenceRefT[];
    created_at: string;
  }): Promise<V2AgentReviewT> {
    return this.transactions.transaction(async (sql) => {
      const scope = await sql.query<{
        reviewer_agent_profile_id: string | null;
        task_state: string;
        run_state: string;
        usage_cost_usd: string | number;
      }>(
        `SELECT assignment.reviewer_agent_profile_id, task.state AS task_state,
                run.state AS run_state, run.usage_cost_usd
         FROM tasks task JOIN agent_runs run ON run.id=$4 AND run.task_id=task.id
         JOIN agent_assignments assignment ON assignment.id=run.assignment_id
         WHERE task.project_id=$1 AND task.phase_id=$2 AND task.id=$3
         FOR UPDATE OF task, run, assignment`,
        [input.project_id, input.phase_id, input.task_id, input.run_id],
      );
      const row = scope.rows[0];
      if (!row || row.task_state !== "in_review" || row.run_state !== "succeeded") {
        throw new Phase6CoordinationConflictError("review requires the designated successful run");
      }
      if (row.reviewer_agent_profile_id !== input.reviewer_agent_profile_id) {
        throw new Phase6CoordinationConflictError(
          "reviewer is not the independently assigned profile",
        );
      }
      const round = await sql.query<{ next: number }>(
        "SELECT count(*)::int + 1 AS next FROM agent_reviews WHERE task_id=$1",
        [input.task_id],
      );
      const review = V2AgentReview.parse({
        schema_version: 2,
        id: `review:${input.task_id}:${round.rows[0]?.next ?? 1}`,
        ...input,
        review_round: round.rows[0]?.next ?? 1,
      });
      await sql.query(
        `INSERT INTO agent_reviews (
           id, project_id, phase_id, task_id, run_id, reviewer_agent_profile_id,
           review_round, decision, summary, evidence, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)`,
        [
          review.id,
          review.project_id,
          review.phase_id,
          review.task_id,
          review.run_id,
          review.reviewer_agent_profile_id,
          review.review_round,
          review.decision,
          review.summary,
          JSON.stringify(review.evidence),
          review.created_at,
        ],
      );
      if (review.decision === "rework") {
        const budget = new SqlV2BudgetTransaction(sql);
        const reservation = await budget.lockReservation(`budget-reservation:${review.run_id}`);
        if (reservation?.status === "active") {
          const request = {
            reservation_id: reservation.id,
            expected_version: reservation.version,
            outcome: "success" as const,
            attributable_usage_usd: Number(row.usage_cost_usd),
            reason: `review round ${review.review_round} requested rework`,
            actor_type: "agent" as const,
            actor_id: review.reviewer_agent_profile_id,
            correlation_id: review.id,
            causation_id: review.run_id,
            occurred_at: review.created_at,
          };
          await budget.applyResolution(
            reservation,
            request,
            resolveV2BudgetReservation(reservation.amount_usd, request),
          );
        }
      }
      if (review.decision === "escalated") {
        const conditionKey = `review-escalation:${review.task_id}`;
        const fingerprint = createHash("sha256")
          .update(`${review.run_id}\n${review.summary}`)
          .digest("hex");
        await sql.query(
          `INSERT INTO decision_points (
             id, project_id, phase_id, task_id, scope_entity_type, scope_entity_id,
             reason_class, source_instance_id, condition_key, condition_fingerprint,
             question, context, options, recommendation_option_id, urgency,
             blocking_scope, status
           ) VALUES ($1,$2,$3,$4,'task',$4,'agent_review_escalation',$5,$6,$7,
                     'How should reviewer escalation be resolved?',$8,
                     '[{"id":"accept","label":"Accept recommendation"},{"id":"revise","label":"Request revision"}]'::jsonb,
                     'accept','high',$9::jsonb,'open')
           ON CONFLICT (condition_key) WHERE status='open' DO NOTHING`,
          [
            `decision:${conditionKey}`,
            review.project_id,
            review.phase_id,
            review.task_id,
            review.id,
            conditionKey,
            fingerprint,
            review.summary,
            JSON.stringify({ task_id: review.task_id }),
          ],
        );
      }
      return review;
    });
  }

  capturePhaseMemory(input: {
    project_id: string;
    phase_id: string;
    lessons: string[];
    repository_facts: string[];
    architecture_changes: string[];
    recorded_at: string;
  }): Promise<{ recorded: number }> {
    return this.transactions.transaction(async (sql) => {
      const phase = await sql.query<{ status: string }>(
        "SELECT status FROM phases WHERE id=$1 AND project_id=$2 FOR UPDATE",
        [input.phase_id, input.project_id],
      );
      if (phase.rows[0]?.status !== "completed") {
        throw new Phase6CoordinationConflictError(
          "phase memory closes only after phase completion",
        );
      }
      const entries = [
        ...input.lessons.map((content, index) => ({ category: "lesson", content, index })),
        ...input.repository_facts.map((content, index) => ({
          category: "repository_fact",
          content,
          index,
        })),
        ...input.architecture_changes.map((content, index) => ({
          category: "architecture",
          content,
          index,
        })),
      ];
      for (const entry of entries) {
        const digest = createHash("sha256").update(entry.content).digest("hex").slice(0, 16);
        await sql.query(
          `INSERT INTO project_memory_entries (
             id, project_id, phase_id, category, content, provenance, source_ref,
             confidence, version, status, approved_by_human, created_at
           ) VALUES ($1,$2,$3,$4,$5,'phase6_coordination',$6::jsonb,1,1,'active',false,$7)
           ON CONFLICT (id) DO NOTHING`,
          [
            `memory:${input.phase_id}:${entry.category}:${entry.index}:${digest}`,
            input.project_id,
            input.phase_id,
            entry.category,
            entry.content,
            JSON.stringify({ phase_id: input.phase_id, source: "phase6_closure" }),
            input.recorded_at,
          ],
        );
      }
      return { recorded: entries.length };
    });
  }
}
