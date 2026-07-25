import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KnowledgeSystemService } from "../src/knowledge/service.js";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";
import { buildServer } from "../src/server.js";
import { RelayStores } from "../src/stores.js";
import { UserStore } from "../src/users/store.js";
import { testAdminToken } from "./helpers.js";

const owner = { actor_type: "human" as const, actor_id: "owner-1" };
const start = "2026-07-25T12:00:00.000Z";

const packageContent = (purpose: string) => ({
  purpose,
  scope: [],
  out_of_scope: [],
  authoritative_standards: [`${purpose} is authoritative.`],
  architecture: [],
  interfaces: [],
  dependencies: [],
  constraints: [],
  current_state: [],
  known_issues: [],
  open_decisions: [],
  acceptance_requirements: [],
  related_packages: [],
  related_decision_records: [],
  change_history: ["1.0.0 created"],
});

const interfaceContent = {
  purpose: "Keep independently implemented components compatible.",
  inputs: ["Resolved domain event"],
  outputs: ["Cancelable presentation handle"],
  error_behavior: ["Presentation failure never changes game state"],
  timing_behavior: ["Completion callback fires once"],
  state_ownership: ["The domain owns gameplay state"],
  cancellation_behavior: ["Cancellation leaves resolved state untouched"],
  concurrency_behavior: ["A group id coordinates simultaneous events"],
  performance_expectations: ["No unbounded work"],
  producing_components: ["domain"],
  consuming_components: ["presentation"],
};

describe.sequential("knowledge-package and agent execution system", () => {
  let pg: PGlite;
  let service: KnowledgeSystemService;

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
    await pg.exec(`
      INSERT INTO projects (
        id, name, description, status, max_concurrent_tasks, assignment_policy_ref,
        verification_policy_ref, budget_policy_ref
      ) VALUES ('project-k','Knowledge Project','', 'active',2,'allocation','verification','budget');
      INSERT INTO repository_bindings (
        id, project_id, binding_type, status, runner_id, workspace_id,
        repository_id, repository_display_name, granted_permissions, default_branch,
        observed_head, verification_policy_ref, repository_health,
        created_by_actor_type, created_by_actor_id
      ) VALUES (
        'binding-k','project-k','local_runner','connected','runner-k','workspace-k',
        'repo-k','Knowledge Project','{}'::jsonb,'main','base-k','verification',
        'healthy','human','owner-1'
      );
      UPDATE projects SET primary_repository_binding_id='binding-k' WHERE id='project-k';
      INSERT INTO phases (
        id, project_id, objective_summary, priority, status, approved_budget_usd
      ) VALUES ('phase-k','project-k','Deliver coherent work',1,'awaiting_approval',100);
      INSERT INTO strategy_versions (
        id, project_id, phase_id, version, status, objective, content,
        convergence, review_rounds, content_hash
      ) VALUES (
        'strategy-k','project-k','phase-k',1,'approved','Deliver',
        '{}'::jsonb,'converged',1,repeat('a',64)
      );
      UPDATE phases
         SET status='approved', approved_strategy_version_id='strategy-k'
       WHERE id='phase-k';
      INSERT INTO objectives (
        id, project_id, phase_id, outcome, success_measures, status, "order"
      ) VALUES (
        'objective-k','project-k','phase-k','Coherent delivery','["green"]'::jsonb,'active',0
      );
      INSERT INTO agent_profiles (
        id, provider, runtime, model, roles, capabilities, context_limit_tokens,
        security_restrictions, status, active_workload, cost_metadata
      ) VALUES
        ('builder-k','openai','codex','gpt-5','["implementation"]'::jsonb,
         '["typescript"]'::jsonb,200000,'[]'::jsonb,'available',0,'{}'::jsonb),
        ('reviewer-k','anthropic','claude','claude','["testing"]'::jsonb,
         '["typescript"]'::jsonb,200000,'[]'::jsonb,'available',0,'{}'::jsonb);
      INSERT INTO tasks (
        id, project_id, phase_id, objective_id, strategy_version_id, title, description,
        deliverables, acceptance_criteria, complexity, risk, required_roles,
        required_capabilities, required_inputs, expected_outputs,
        environment_policy_ref, verification_policy_ref, state, lifecycle_version
      ) VALUES
        ('task-k1','project-k','phase-k','objective-k','strategy-k','Implement A','Build A',
         '["A"]'::jsonb,'["A works"]'::jsonb,'M','high','["implementation"]'::jsonb,
         '["typescript"]'::jsonb,'[]'::jsonb,'["A"]'::jsonb,
         'environment','verification','pending',0),
        ('task-k2','project-k','phase-k','objective-k','strategy-k','Implement B','Build B',
         '["B"]'::jsonb,'["B works"]'::jsonb,'M','medium','["implementation"]'::jsonb,
         '["typescript"]'::jsonb,'[]'::jsonb,'["B"]'::jsonb,
         'environment','verification','pending',0);
      INSERT INTO agent_assignments (
        id, project_id, phase_id, task_id, agent_profile_id, status, rationale,
        rationale_factors, budget_limit_usd, reviewer_agent_profile_id, allocation_policy_ref
      ) VALUES
        ('assignment-k1','project-k','phase-k','task-k1','builder-k','active','fit',
         '["capability"]'::jsonb,20,'reviewer-k','allocation'),
        ('assignment-k2','project-k','phase-k','task-k2','builder-k','active','fit',
         '["capability"]'::jsonb,20,'reviewer-k','allocation');
      INSERT INTO agent_runs (
        id, project_id, phase_id, task_id, assignment_id, attempt, state,
        is_designated, repository_binding_id, expected_revision, verification_status
      ) VALUES
        ('run-k1','project-k','phase-k','task-k1','assignment-k1',1,'created',true,
         'binding-k','base-k','pending'),
        ('run-k2','project-k','phase-k','task-k2','assignment-k2',1,'created',true,
         'binding-k','base-k','pending');
      UPDATE tasks
         SET designated_assignment_id='assignment-k1', designated_run_id='run-k1'
       WHERE id='task-k1';
      UPDATE tasks
         SET designated_assignment_id='assignment-k2', designated_run_id='run-k2'
       WHERE id='task-k2';
      INSERT INTO task_coordination_constraints (
        task_id, project_id, phase_id, conflict_keys, estimated_context_tokens,
        requires_independent_review, critical_path_weight, conflict_scope_declared
      ) VALUES
        ('task-k1','project-k','phase-k','["src/shared.ts"]'::jsonb,1000,true,1,true),
        ('task-k2','project-k','phase-k','["src/shared.ts"]'::jsonb,1000,true,1,true);
    `);
    service = new KnowledgeSystemService(new PGliteTransactionRunner(pg));
  });

  afterEach(async () => pg.close());

  async function activePackage(input: {
    id: string;
    name: string;
    type: "project" | "phase" | "domain";
    scope_kind: "project" | "phase" | "domain";
    scope_id: string;
    parent_package_id?: string;
    dependencies?: string[];
  }) {
    await service.createPackage({
      id: input.id,
      project_id: "project-k",
      name: input.name,
      type: input.type,
      authority: input.type === "project" ? "constitutional" : "domain_standard",
      owner: "curator",
      scope_kind: input.scope_kind,
      scope_id: input.scope_id,
      parent_package_id: input.parent_package_id ?? null,
      actor: owner,
      created_at: start,
    });
    const version = await service.createPackageVersion({
      package_id: input.id,
      version: "1.0.0",
      content: packageContent(input.name),
      dependency_package_ids: (input.dependencies ?? []).map((package_id) => ({
        package_id,
        relation_kind: "mandatory" as const,
      })),
      actor: owner,
      created_at: start,
    });
    await service.transitionPackageVersion({
      version_id: version.id,
      to: "under_review",
      actor: owner,
      transitioned_at: "2026-07-25T12:01:00.000Z",
    });
    await service.transitionPackageVersion({
      version_id: version.id,
      to: "approved",
      actor: owner,
      transitioned_at: "2026-07-25T12:02:00.000Z",
    });
    return service.transitionPackageVersion({
      version_id: version.id,
      to: "active",
      actor: owner,
      transitioned_at: "2026-07-25T12:03:00.000Z",
    });
  }

  async function activeInterface() {
    const version = await service.createInterfaceContractVersion({
      contract_id: "ic-k",
      project_id: "project-k",
      name: "Presentation contract",
      owner: "architecture",
      version: "1.0.0",
      content: interfaceContent,
      actor: owner,
      created_at: start,
    });
    for (const [index, to] of ["under_review", "approved", "active"].entries()) {
      await service.transitionInterfaceContractVersion({
        version_id: version.id,
        to: to as "under_review" | "approved" | "active",
        actor: owner,
        transitioned_at: `2026-07-25T12:0${index + 1}:30.000Z`,
      });
    }
    return version;
  }

  async function approvedTaskPackage(taskId: "task-k1" | "task-k2") {
    return service.createTaskPackage({
      task_id: taskId,
      status: "approved",
      assignment: `Complete ${taskId}`,
      expected_outcome: `${taskId} works`,
      business_or_user_outcome: "The user receives coherent behavior.",
      scope: ["Implementation"],
      out_of_scope: [],
      deliverables: [taskId === "task-k1" ? "A" : "B"],
      file_scope_declared: true,
      permitted_files: ["src/shared.ts"],
      restricted_files: [],
      required_package_ids: ["kp-combat"],
      required_interface_contract_ids: ["ic-k"],
      required_decision_record_ids: [],
      dependencies: [],
      acceptance_criteria: [taskId === "task-k1" ? "A works" : "B works"],
      required_tests: ["pnpm test"],
      performance_requirements: [],
      accessibility_requirements: [],
      reporting_interval_seconds: 300,
      escalation_conditions: ["C3 or C4 conflict"],
      completion_format: "AGENT HANDOFF",
      branch_or_workspace: `codex/${taskId}`,
      token_budget: 20_000,
      actor: owner,
      created_at: "2026-07-25T12:04:00.000Z",
    });
  }

  async function baseline() {
    const project = await activePackage({
      id: "kp-project",
      name: "Project Package",
      type: "project",
      scope_kind: "project",
      scope_id: "project-k",
    });
    await activePackage({
      id: "kp-phase",
      name: "Phase Package",
      type: "phase",
      scope_kind: "phase",
      scope_id: "phase-k",
      dependencies: ["kp-project"],
    });
    await activePackage({
      id: "kp-animation",
      name: "Animation Package",
      type: "domain",
      scope_kind: "domain",
      scope_id: "animation",
    });
    const combat = await activePackage({
      id: "kp-combat",
      name: "Combat Package",
      type: "domain",
      scope_kind: "domain",
      scope_id: "combat",
      parent_package_id: "kp-animation",
      dependencies: ["kp-project"],
    });
    await activeInterface();
    return { project, combat };
  }

  it("assembles the minimum complete context with exact parent and dependency versions", async () => {
    const { project, combat } = await baseline();
    await approvedTaskPackage("task-k1");
    const manifest = await service.assembleContextManifest({
      task_id: "task-k1",
      repository_commit: "base-k",
      generated_by: owner,
      generated_at: "2026-07-25T12:05:00.000Z",
    });
    expect(manifest.included_packages.map((entry) => entry.package_id).sort()).toEqual([
      "kp-animation",
      "kp-combat",
      "kp-phase",
      "kp-project",
    ]);
    expect(manifest.included_packages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ package_id: "kp-project", version_id: project.id }),
        expect.objectContaining({ package_id: "kp-combat", version_id: combat.id }),
      ]),
    );
    expect(manifest.included_interface_contracts[0]).toMatchObject({
      contract_id: "ic-k",
      version: "1.0.0",
    });
    const repeated = await service.assembleContextManifest({
      task_id: "task-k1",
      repository_commit: "base-k",
      generated_by: owner,
      generated_at: "2026-07-25T12:06:00.000Z",
    });
    expect(repeated.id).toBe(manifest.id);
    expect(repeated.content_hash).toBe(manifest.content_hash);
  });

  it("detects stagnation and file conflicts, and enforces structured completion", async () => {
    await baseline();
    await approvedTaskPackage("task-k1");
    await approvedTaskPackage("task-k2");
    const manifest1 = await service.assembleContextManifest({
      task_id: "task-k1",
      repository_commit: "base-k",
      generated_by: owner,
      generated_at: "2026-07-25T12:05:00.000Z",
    });
    const manifest2 = await service.assembleContextManifest({
      task_id: "task-k2",
      repository_commit: "base-k",
      generated_by: owner,
      generated_at: "2026-07-25T12:05:00.000Z",
    });
    await service.registerAgent({
      run_id: "run-k1",
      context_manifest_id: manifest1.id,
      provider: "openai",
      model: "gpt-5",
      branch_or_workspace: "codex/task-k1",
      token_budget: 20_000,
      actor: owner,
      registered_at: "2026-07-25T12:06:00.000Z",
    });
    await service.registerAgent({
      run_id: "run-k2",
      context_manifest_id: manifest2.id,
      provider: "openai",
      model: "gpt-5",
      branch_or_workspace: "codex/task-k2",
      token_budget: 20_000,
      actor: owner,
      registered_at: "2026-07-25T12:06:00.000Z",
    });

    const heartbeat = {
      run_id: "run-k1",
      status: "working" as const,
      completed_since_last_update: [],
      currently_working_on: ["Implementation"],
      findings: [],
      blockers: [],
      decisions_needed: [],
      files_changed: ["src/shared.ts"],
      tests: "In progress",
      estimated_remaining_work: "moderate" as const,
      risk_level: "green" as const,
      actor: owner,
    };
    await service.recordHeartbeat({
      ...heartbeat,
      reported_at: "2026-07-25T12:07:00.000Z",
    });
    await service.recordHeartbeat({
      ...heartbeat,
      reported_at: "2026-07-25T12:12:00.000Z",
    });
    const stagnant = await service.recordHeartbeat({
      ...heartbeat,
      reported_at: "2026-07-25T12:17:00.000Z",
    });
    expect(stagnant.repeated_update_count).toBe(2);

    const conflicts = await service.detectConflicts({
      project_id: "project-k",
      phase_id: "phase-k",
      actor: owner,
      detected_at: "2026-07-25T12:18:00.000Z",
    });
    expect(conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "file_overlap",
          severity: "C2",
          details: ["src/shared.ts"],
        }),
      ]),
    );

    const delta = await service.submitKnowledgeDelta({
      run_id: "run-k1",
      changes: [
        {
          kind: "confirmed_assumption",
          summary: "The contract works",
          detail: "The implementation used the pinned interface.",
          affected_package_ids: ["kp-combat"],
        },
      ],
      recommended_package_updates: [],
      submitted_at: "2026-07-25T12:20:00.000Z",
      actor: owner,
    });
    await service.submitHandoff({
      run_id: "run-k1",
      status: "completed",
      summary: "Implemented A.",
      deliverables: ["A"],
      files_changed: ["src/shared.ts"],
      interfaces_used: ["ic-k"],
      interfaces_changed: [],
      tests_added: ["A test"],
      test_results: ["pnpm test: passed"],
      acceptance_criteria: [{ criterion: "A works", result: "pass", evidence: "A test passes" }],
      known_limitations: [],
      open_issues: [],
      dependencies_created: [],
      knowledge_delta_id: delta.id,
      recommended_package_updates: [],
      recommended_follow_up_tasks: [],
      branch: "codex/task-k1",
      commit: "commit-k1",
      artifacts: [],
      submitted_at: "2026-07-25T12:21:00.000Z",
      actor: owner,
    });
    const blockedGate = await service.evaluateTaskCompletion({
      task_id: "task-k1",
      evaluated_at: "2026-07-25T12:22:00.000Z",
    });
    expect(blockedGate.passed).toBe(false);
    expect(blockedGate.blockers).toEqual(
      expect.arrayContaining([
        "Runner verification passed",
        "Independent review is approved when required",
      ]),
    );

    await pg.exec(`
      UPDATE agent_runs SET verification_status='passed' WHERE id='run-k1';
      INSERT INTO agent_reviews (
        id, project_id, phase_id, task_id, run_id, reviewer_agent_profile_id,
        review_round, decision, summary, evidence, reviewer_provider, reviewer_model,
        reviewer_roles
      ) VALUES (
        'review-k1','project-k','phase-k','task-k1','run-k1','reviewer-k',
        1,'approved','Approved','[{"artifact_id":"review"}]'::jsonb,
        'anthropic','claude','["testing"]'::jsonb
      );
    `);
    const passingGate = await service.evaluateTaskCompletion({
      task_id: "task-k1",
      evaluated_at: "2026-07-25T12:23:00.000Z",
    });
    expect(passingGate.passed).toBe(true);
    await expect(
      service.evaluateTaskCompletion({
        task_id: "task-k1",
        evaluated_at: "2026-07-25T12:23:00.000Z",
      }),
    ).resolves.toEqual(passingGate);
    expect(
      (
        await pg.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM knowledge_gate_evaluations WHERE task_id='task-k1'",
        )
      ).rows[0]?.count,
    ).toBe(2);

    // A deterministic id is replay-safe only for the same computed evidence.
    // If state changes under an identical task/timestamp identity, fail closed
    // instead of silently returning or overwriting the original evaluation.
    await pg.exec("UPDATE agent_runs SET verification_status='failed' WHERE id='run-k1'");
    await expect(
      service.evaluateTaskCompletion({
        task_id: "task-k1",
        evaluated_at: "2026-07-25T12:23:00.000Z",
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringContaining("already exists with different evidence"),
    });
    await pg.exec("UPDATE agent_runs SET verification_status='passed' WHERE id='run-k1'");

    const status = await service.phaseStatus("project-k", "phase-k", "2026-07-25T12:30:01.000Z");
    expect(status.overall_status).toBe("red");
    expect(status.missing_heartbeat_run_ids).toContain("run-k2");
  });

  it("mounts authenticated knowledge administration routes", async () => {
    const users = new UserStore();
    const token = testAdminToken(users);
    const server = await buildServer({
      stores: new RelayStores(),
      users,
      knowledge: { service },
      clock: () => new Date(start),
    });
    try {
      const unauthenticated = await server.app.inject({
        method: "GET",
        url: "/api/v2/projects/project-k/knowledge/packages",
      });
      expect(unauthenticated.statusCode).toBe(401);

      const created = await server.app.inject({
        method: "POST",
        url: "/api/v2/projects/project-k/knowledge/packages",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        payload: {
          id: "kp-route",
          name: "Route Package",
          type: "project",
          authority: "constitutional",
          owner: "curator",
          scope_kind: "project",
          scope_id: "project-k",
        },
      });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({ id: "kp-route", project_id: "project-k" });

      const listed = await server.app.inject({
        method: "GET",
        url: "/api/v2/projects/project-k/knowledge/packages",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(listed.statusCode).toBe(200);
      expect(listed.json()).toEqual([
        expect.objectContaining({
          package: expect.objectContaining({ id: "kp-route" }),
          versions: [],
        }),
      ]);
    } finally {
      await server.app.close();
    }
  });

  it("lets the runtime append evidence but not rewrite knowledge history", async () => {
    const privileges = await pg.query<{
      heartbeat_insert: boolean;
      heartbeat_update: boolean;
      handoff_delete: boolean;
      audit_insert: boolean;
      audit_update: boolean;
    }>(`
      SELECT
        has_table_privilege('norns_app','agent_status_heartbeats','INSERT') AS heartbeat_insert,
        has_table_privilege('norns_app','agent_status_heartbeats','UPDATE') AS heartbeat_update,
        has_table_privilege('norns_app','agent_handoffs','DELETE') AS handoff_delete,
        has_table_privilege('norns_app','knowledge_audit_log','INSERT') AS audit_insert,
        has_table_privilege('norns_app','knowledge_audit_log','UPDATE') AS audit_update
    `);
    expect(privileges.rows[0]).toEqual({
      heartbeat_insert: true,
      heartbeat_update: false,
      handoff_delete: false,
      audit_insert: true,
      audit_update: false,
    });
  });
});
