import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { type V2StrategyVersionT, fingerprintV2StrategyImmutableContent } from "@norns/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";
import { PhaseWorkflowService } from "../src/projects/phaseWorkflowService.js";
import {
  StrategyWorkflowConflictError,
  StrategyWorkflowService,
} from "../src/projects/strategyWorkflowService.js";
import { hashCurrentPassword } from "../src/users/passwords.js";

const NOW = "2026-07-16T19:30:00.000Z";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function strategy(phaseId: string): V2StrategyVersionT {
  const candidate: V2StrategyVersionT = {
    schema_version: 2,
    id: "strategy-animation-v1",
    project_id: "project-1",
    phase_id: phaseId,
    version: 1,
    status: "awaiting_approval",
    objective: "Add polished interface animations",
    assumptions: ["Existing components remain structurally stable"],
    risks: ["Motion can reduce accessibility"],
    scope_in: ["Page and panel transitions"],
    scope_out: ["Execution engine changes"],
    architecture_impact: "Frontend-only animation layer with reduced-motion support.",
    proposed_objectives: [
      {
        local_id: "objective-animation",
        outcome: "Interfaces transition clearly without harming accessibility",
        success_measures: ["Reduced-motion behavior is verified"],
      },
    ],
    proposed_tasks: [
      {
        local_id: "task-animation",
        objective_local_id: "objective-animation",
        title: "Implement interface animations",
        description: "Add accessible transitions to the primary interface.",
        deliverables: ["Animation components"],
        acceptance_criteria: ["Reduced-motion preference disables nonessential motion"],
        complexity: "M",
        risk: "medium",
        required_roles: ["frontend"],
        required_capabilities: ["react"],
        required_inputs: [],
        expected_outputs: ["Verified animation implementation"],
        environment_policy_ref: "environment-default",
        verification_policy_ref: "verification-default",
        dependency_local_ids: [],
      },
    ],
    proposed_assignments: [
      {
        local_id: "assignment-animation",
        task_local_id: "task-animation",
        agent_profile_id: "agent-frontend",
        rationale: "Frontend specialist with React capability",
        rationale_factors: ["capability"],
        budget_limit_usd: 10,
        reviewer_agent_profile_id: null,
        allocation_policy_ref: "allocation-default",
      },
    ],
    proposed_concurrency: 1,
    proposed_budget_usd: 10,
    provenance: [
      {
        provider: "anthropic",
        model: "claude-sonnet",
        runtime: "server",
        generated_at: NOW,
        invocation_id: "invocation-1",
      },
    ],
    convergence: "converged",
    review_rounds: 1,
    findings: [],
    content_hash: "0".repeat(64),
    approval: null,
    supersedes_strategy_version_id: null,
    aggregate_version: 1,
    created_at: NOW,
    updated_at: NOW,
  };
  candidate.content_hash = fingerprintV2StrategyImmutableContent(candidate, sha256);
  return candidate;
}

describe.sequential("Phase 3 retained strategy workflow", () => {
  let pg: PGlite;
  let workflow: StrategyWorkflowService;
  let phaseId: string;

  beforeEach(async () => {
    pg = new PGlite();
    await pg.exec(`
      CREATE ROLE norns_app NOLOGIN;
      CREATE TABLE norns_state (
        key TEXT PRIMARY KEY,
        snapshot JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await runCurrentV2Migrations(pg as unknown as V2MigrationDatabase);
    await pg.query(
      `INSERT INTO projects (
         id, name, description, status, assignment_policy_ref,
         verification_policy_ref, budget_policy_ref
       ) VALUES ('project-1','Project One','','active','assignment',
                 'verification','budget')`,
    );
    await pg.query(
      `INSERT INTO users (
         id, username, display_name, email, name, password_hash,
         password_hash_scheme, role, status
       ) VALUES ('admin-1','admin@example.com','Admin','admin@example.com','Admin',
                 $1,'scrypt-v1','admin','active')`,
      [await hashCurrentPassword("test-password")],
    );
    await pg.query(
      `INSERT INTO agent_profiles (
         id, provider, runtime, model, roles, capabilities, context_limit_tokens,
         security_restrictions, status, active_workload, cost_metadata
       ) VALUES ('agent-frontend','anthropic','server','claude-sonnet',
                 '["frontend"]'::jsonb,'["react"]'::jsonb,200000,'[]'::jsonb,
                 'available',0,'{"billing_mode":"api"}'::jsonb)`,
    );
    const transactions = new PGliteTransactionRunner(pg);
    phaseId = (
      await new PhaseWorkflowService(transactions).create({
        schema_version: 2,
        command_id: "create-phase",
        kind: "create_phase",
        command_family: "phase",
        actor: { actor_type: "human", actor_id: "admin-1" },
        idempotency_key: "phase-animation",
        correlation_id: "correlation",
        causation_id: null,
        issued_at: NOW,
        project_id: "project-1",
        objective_summary: "Add animations",
        priority: 5,
        predecessor_phase_ids: [],
        expected_project_version: 1,
      })
    ).id;
    workflow = new StrategyWorkflowService(transactions);
  });

  afterEach(async () => {
    await pg.close();
  });

  it("retains a hash-bound StrategyVersion and replays without replacing the phase", async () => {
    const candidate = strategy(phaseId);
    await expect(workflow.saveAwaitingApproval(candidate)).resolves.toEqual(candidate);
    await expect(workflow.saveAwaitingApproval(candidate)).resolves.toEqual(candidate);
    const state = await pg.query<{
      strategies: number;
      phase_status: string;
      phase_version: number;
    }>(
      `SELECT (SELECT count(*)::int FROM strategy_versions) AS strategies,
              status AS phase_status, aggregate_version AS phase_version
       FROM phases WHERE id = $1`,
      [phaseId],
    );
    expect(state.rows[0]).toEqual({
      strategies: 1,
      phase_status: "awaiting_approval",
      phase_version: 2,
    });
  });

  it("refuses tampered immutable content", async () => {
    const candidate = strategy(phaseId);
    candidate.objective = "Tampered after hashing";
    await expect(workflow.saveAwaitingApproval(candidate)).rejects.toBeInstanceOf(
      StrategyWorkflowConflictError,
    );
  });

  it("atomically approves and materializes objectives, tasks, and assignments", async () => {
    const candidate = strategy(phaseId);
    await workflow.saveAwaitingApproval(candidate);
    const command = {
      schema_version: 2 as const,
      command_id: "approve-animation-v1",
      kind: "approve_strategy_version" as const,
      command_family: "strategy_approval" as const,
      actor: { actor_type: "human" as const, actor_id: "admin-1" },
      idempotency_key: "approve-animation-v1",
      correlation_id: "correlation-approval",
      causation_id: null,
      issued_at: "2026-07-16T19:31:00.000Z",
      project_id: "project-1",
      phase_id: phaseId,
      strategy_version_id: candidate.id,
      expected_phase_version: 2,
      expected_strategy_version: 1,
      expected_strategy_aggregate_version: 1,
      expected_content_hash: candidate.content_hash,
    };
    const result = await workflow.approve(command);
    await expect(workflow.approve(command)).resolves.toEqual(result);
    expect(result).toMatchObject({ objectives: 1, tasks: 1 });
    const state = await pg.query<{
      phase_status: string;
      strategy_status: string;
      approvals: number;
      assignments: number;
    }>(
      `SELECT p.status AS phase_status, s.status AS strategy_status,
              (SELECT count(*)::int FROM approvals) AS approvals,
              (SELECT count(*)::int FROM agent_assignments) AS assignments
       FROM phases p JOIN strategy_versions s ON s.id = p.approved_strategy_version_id
       WHERE p.id = $1`,
      [phaseId],
    );
    expect(state.rows[0]).toEqual({
      phase_status: "approved",
      strategy_status: "approved",
      approvals: 1,
      assignments: 1,
    });
  });
});
