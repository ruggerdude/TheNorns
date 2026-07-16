import { createHash } from "node:crypto";
import {
  V2ApproveStrategyVersionCommand,
  type V2ApproveStrategyVersionCommandT,
  V2StrategyVersion,
  type V2StrategyVersionT,
  canonicalizeV2StrategyImmutableContent,
  fingerprintV2StrategyImmutableContent,
  materializeV2StrategyVersion,
  validateV2StrategyApproval,
} from "@norns/contracts";
import type { V2TransactionRunner } from "../persistence/v2/database.js";

export class StrategyWorkflowConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StrategyWorkflowConflictError";
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export class StrategyWorkflowService {
  constructor(private readonly transactions: V2TransactionRunner) {}

  async saveAwaitingApproval(input: V2StrategyVersionT): Promise<V2StrategyVersionT> {
    const strategy = V2StrategyVersion.parse(input);
    if (strategy.status !== "awaiting_approval" || strategy.approval !== null) {
      throw new StrategyWorkflowConflictError(
        "a retained approval candidate must be awaiting_approval with no approval evidence",
      );
    }
    const computed = fingerprintV2StrategyImmutableContent(strategy, sha256);
    if (computed !== strategy.content_hash) {
      throw new StrategyWorkflowConflictError(
        "strategy content hash does not match immutable content",
      );
    }
    const content = canonicalizeV2StrategyImmutableContent(strategy);
    return this.transactions.transaction(async (tx) => {
      const replay = await tx.query<{ content_hash: string; content: unknown }>(
        "SELECT content_hash, content FROM strategy_versions WHERE id = $1 FOR UPDATE",
        [strategy.id],
      );
      const existing = replay.rows[0];
      if (existing) {
        if (existing.content_hash !== computed) {
          throw new StrategyWorkflowConflictError(
            `strategy identity ${strategy.id} already contains different immutable content`,
          );
        }
        return strategy;
      }
      const phase = await tx.query<{
        status: string;
        approved_strategy_version_id: string | null;
      }>(
        "SELECT status, approved_strategy_version_id FROM phases WHERE id = $1 AND project_id = $2 FOR UPDATE",
        [strategy.phase_id, strategy.project_id],
      );
      const currentPhase = phase.rows[0];
      if (
        !currentPhase ||
        currentPhase.status === "completed" ||
        currentPhase.status === "cancelled"
      ) {
        throw new StrategyWorkflowConflictError("strategy phase is unavailable for planning");
      }
      const latest = await tx.query<{ id: string; version: number }>(
        `SELECT id, version FROM strategy_versions
         WHERE project_id = $1 AND phase_id = $2 ORDER BY version DESC LIMIT 1`,
        [strategy.project_id, strategy.phase_id],
      );
      const previous = latest.rows[0];
      if (strategy.version !== (previous?.version ?? 0) + 1) {
        throw new StrategyWorkflowConflictError(
          "strategy version must follow the retained phase history",
        );
      }
      if ((strategy.supersedes_strategy_version_id ?? null) !== (previous?.id ?? null)) {
        throw new StrategyWorkflowConflictError(
          "strategy supersession must reference the latest version",
        );
      }
      await tx.query(
        `INSERT INTO strategy_versions (
           id, project_id, phase_id, version, aggregate_version, status,
           objective, content, convergence, review_rounds, content_hash,
           approval_id, supersedes_strategy_version_id, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,NULL,$12,$13,$14)`,
        [
          strategy.id,
          strategy.project_id,
          strategy.phase_id,
          strategy.version,
          strategy.aggregate_version,
          strategy.status,
          strategy.objective,
          content,
          strategy.convergence,
          strategy.review_rounds,
          computed,
          strategy.supersedes_strategy_version_id,
          strategy.created_at,
          strategy.updated_at,
        ],
      );
      if (previous) {
        await tx.query(
          `UPDATE strategy_versions SET status = 'superseded', updated_at = now()
           WHERE id = $1 AND status <> 'approved'`,
          [previous.id],
        );
      }
      await tx.query(
        `UPDATE phases SET status = 'awaiting_approval', aggregate_version = aggregate_version + 1,
                           updated_at = now()
         WHERE id = $1`,
        [strategy.phase_id],
      );
      return strategy;
    });
  }

  async approve(commandInput: V2ApproveStrategyVersionCommandT): Promise<{
    strategy_version_id: string;
    approval_id: string;
    objectives: number;
    tasks: number;
  }> {
    const command = V2ApproveStrategyVersionCommand.parse(commandInput);
    return this.transactions.transaction(async (tx) => {
      const phaseResult = await tx.query<{
        aggregate_version: number;
        approved_strategy_version_id: string | null;
      }>(
        `SELECT aggregate_version, approved_strategy_version_id
         FROM phases WHERE id = $1 AND project_id = $2 FOR UPDATE`,
        [command.phase_id, command.project_id],
      );
      const phase = phaseResult.rows[0];
      if (!phase) throw new StrategyWorkflowConflictError("approval phase does not exist");
      const strategyResult = await tx.query<{
        id: string;
        status: V2StrategyVersionT["status"];
        aggregate_version: number;
        content: Record<string, unknown>;
        content_hash: string;
        approval_id: string | null;
        created_at: Date | string;
        updated_at: Date | string;
      }>("SELECT * FROM strategy_versions WHERE id = $1 FOR UPDATE", [command.strategy_version_id]);
      const row = strategyResult.rows[0];
      if (!row) throw new StrategyWorkflowConflictError("strategy version does not exist");
      const approvalId = `approval:${command.command_id}`;
      if (row.status === "approved" && row.approval_id === approvalId) {
        const counts = await tx.query<{ objectives: number; tasks: number }>(
          `SELECT (SELECT count(*)::int FROM objectives WHERE phase_id = $1) AS objectives,
                  (SELECT count(*)::int FROM tasks WHERE phase_id = $1) AS tasks`,
          [command.phase_id],
        );
        return {
          strategy_version_id: row.id,
          approval_id: approvalId,
          objectives: counts.rows[0]?.objectives ?? 0,
          tasks: counts.rows[0]?.tasks ?? 0,
        };
      }
      const strategy = V2StrategyVersion.parse({
        ...row.content,
        status: row.status,
        aggregate_version: row.aggregate_version,
        content_hash: row.content_hash,
        approval: null,
        created_at: new Date(row.created_at).toISOString(),
        updated_at: new Date(row.updated_at).toISOString(),
      });
      const decision = validateV2StrategyApproval(
        strategy,
        command,
        sha256,
        phase.aggregate_version,
      );
      if (!decision.allowed) {
        throw new StrategyWorkflowConflictError(
          `strategy approval refused: ${decision.reasons.join(", ")}`,
        );
      }
      const approved = V2StrategyVersion.parse({
        ...strategy,
        status: "approved",
        approval: {
          approval_id: approvalId,
          approved_by: command.actor.actor_id,
          approved_at: command.issued_at,
          content_hash: strategy.content_hash,
        },
        aggregate_version: strategy.aggregate_version + 1,
        updated_at: command.issued_at,
      });
      const materialized = materializeV2StrategyVersion(approved, command.issued_at, sha256);
      const profileIds = [
        ...new Set(
          materialized.agent_assignments.flatMap((assignment) =>
            assignment.reviewer_agent_profile_id === null
              ? [assignment.agent_profile_id]
              : [assignment.agent_profile_id, assignment.reviewer_agent_profile_id],
          ),
        ),
      ];
      const profiles = await tx.query<{ id: string }>(
        "SELECT id FROM agent_profiles WHERE id = ANY($1::text[])",
        [profileIds],
      );
      if (profiles.rows.length !== profileIds.length) {
        throw new StrategyWorkflowConflictError(
          "every proposed assignment requires a known agent profile",
        );
      }
      await tx.query(
        `INSERT INTO approvals (
           id, project_id, phase_id, kind, subject_entity_type, subject_entity_id,
           actor_id, content_hash, status, approved_at
         ) VALUES ($1,$2,$3,'strategy','strategy_version',$4,$5,$6,'active',$7)`,
        [
          approvalId,
          command.project_id,
          command.phase_id,
          command.strategy_version_id,
          command.actor.actor_id,
          strategy.content_hash,
          command.issued_at,
        ],
      );
      for (const objective of materialized.objectives) {
        await tx.query(
          `INSERT INTO objectives (
             id, project_id, phase_id, outcome, success_measures, status, "order",
             completion_evidence, aggregate_version, created_at, updated_at
           ) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8::jsonb,$9,$10,$11)`,
          [
            objective.id,
            objective.project_id,
            objective.phase_id,
            objective.outcome,
            JSON.stringify(objective.success_measures),
            objective.status,
            objective.order,
            JSON.stringify(objective.completion_evidence),
            objective.aggregate_version,
            objective.created_at,
            objective.updated_at,
          ],
        );
      }
      for (const task of materialized.tasks) {
        await tx.query(
          `INSERT INTO tasks (
             id, project_id, phase_id, objective_id, strategy_version_id, title,
             description, deliverables, acceptance_criteria, complexity, risk,
             required_roles, required_capabilities, required_inputs, expected_outputs,
             environment_policy_ref, verification_policy_ref, state,
             designated_assignment_id, designated_run_id, review_evidence,
             completion_evidence, lifecycle_version, aggregate_version,
             created_at, updated_at, completed_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12::jsonb,
                     $13::jsonb,$14::jsonb,$15::jsonb,$16,$17,$18,NULL,NULL,$19::jsonb,
                     $20::jsonb,$21,$22,$23,$24,$25)`,
          [
            task.id,
            task.project_id,
            task.phase_id,
            task.objective_id,
            task.strategy_version_id,
            task.title,
            task.description,
            JSON.stringify(task.deliverables),
            JSON.stringify(task.acceptance_criteria),
            task.complexity,
            task.risk,
            JSON.stringify(task.required_roles),
            JSON.stringify(task.required_capabilities),
            JSON.stringify(task.required_inputs),
            JSON.stringify(task.expected_outputs),
            task.environment_policy_ref,
            task.verification_policy_ref,
            task.state,
            JSON.stringify(task.review_evidence),
            JSON.stringify(task.completion_evidence),
            task.lifecycle_version,
            task.aggregate_version,
            task.created_at,
            task.updated_at,
            task.completed_at,
          ],
        );
      }
      for (const dependency of materialized.task_dependencies) {
        await tx.query(
          `INSERT INTO task_dependencies (
             id, project_id, phase_id, predecessor_task_id, predecessor_phase_id,
             successor_task_id, successor_phase_id, created_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            dependency.id,
            dependency.project_id,
            dependency.phase_id,
            dependency.predecessor_task_id,
            dependency.predecessor_phase_id,
            dependency.successor_task_id,
            dependency.successor_phase_id,
            dependency.created_at,
          ],
        );
      }
      for (const assignment of materialized.agent_assignments) {
        await tx.query(
          `INSERT INTO agent_assignments (
             id, project_id, phase_id, task_id, agent_profile_id, status,
             rationale, rationale_factors, budget_limit_usd, reviewer_agent_profile_id,
             allocation_policy_ref, aggregate_version, created_at, updated_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14)`,
          [
            assignment.id,
            assignment.project_id,
            assignment.phase_id,
            assignment.task_id,
            assignment.agent_profile_id,
            assignment.status,
            assignment.rationale,
            JSON.stringify(assignment.rationale_factors),
            assignment.budget_limit_usd,
            assignment.reviewer_agent_profile_id,
            assignment.allocation_policy_ref,
            assignment.aggregate_version,
            assignment.created_at,
            assignment.updated_at,
          ],
        );
      }
      for (const task of materialized.tasks) {
        await tx.query("UPDATE tasks SET designated_assignment_id = $2 WHERE id = $1", [
          task.id,
          task.designated_assignment_id,
        ]);
      }
      await tx.query(
        `UPDATE strategy_versions SET status = 'approved', approval_id = $2,
             aggregate_version = aggregate_version + 1, updated_at = $3 WHERE id = $1`,
        [strategy.id, approvalId, command.issued_at],
      );
      await tx.query(
        `UPDATE phases SET status = 'approved', approved_strategy_version_id = $2,
             approved_budget_usd = $3, aggregate_version = aggregate_version + 1,
             updated_at = $4 WHERE id = $1`,
        [command.phase_id, strategy.id, strategy.proposed_budget_usd, command.issued_at],
      );
      return {
        strategy_version_id: strategy.id,
        approval_id: approvalId,
        objectives: materialized.objectives.length,
        tasks: materialized.tasks.length,
      };
    });
  }
}
