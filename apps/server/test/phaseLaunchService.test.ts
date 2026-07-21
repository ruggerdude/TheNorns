// EXECUTION E2: `PhaseLaunchService` — the caller `Phase4Coordinator.schedule()`
// never had. This suite proves the real chain end to end against a real
// PGlite database and the REAL Phase4Coordinator gate and REAL
// RelationalTaskContextAssembler (no mocks of either): an approved strategy
// becomes `phases.status = 'active'` with real `dispatch_jobs` rows carrying
// real, assembled `context_refs`; every one of E1's typed assembly failures
// blocks scheduling with its specific code and reason; the coordinator gate
// still refuses everything it always refused (unverified binding, exhausted
// budget); and a task is never scheduled with partial context.
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DispatchContextScopeRepository } from "../src/coordinator/dispatchContextScope.js";
import {
  DEFAULT_PHASE_LAUNCH_POLICY,
  PhaseLaunchService,
} from "../src/coordinator/phaseLaunchService.js";
import { Phase4Coordinator } from "../src/coordinator/phase4Coordinator.js";
import { RelationalTaskContextAssembler, TaskContextStore } from "../src/execution/index.js";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";

const PROJECT = "project-e2";
const PHASE = "phase-e2";
const STRATEGY = "strategy-e2";
const OBJECTIVE = "objective-e2";
const TASK = "task-e2";
const ARCHITECTURE = "arch-e2";
const ASSIGNMENT = "assignment-e2";
const PROFILE = "profile-e2";
const USER = "user-e2";
const RUNNER = "runner-e2";
const BINDING = "binding-e2";

const HASH_64 = "a".repeat(64);

interface SeedOptions {
  bindingType?: "local_runner" | "github";
  bindingStatus?: string;
  installationReady?: boolean | null;
  approvedBudgetUsd?: number;
  taskBudgetLimitUsd?: number;
  phaseStatus?: string;
  /** Omit repository facts (build/test/lint commands) so assembly fails with
   *  `verification_commands_missing` — proves a task is never scheduled with
   *  partial context. */
  skipVerificationCommands?: boolean;
}

describe.sequential("EXECUTION E2 — PhaseLaunchService", () => {
  let pg: PGlite;
  let transactions: PGliteTransactionRunner;
  let coordinator: Phase4Coordinator;
  let taskContext: RelationalTaskContextAssembler;
  let dispatchScope: DispatchContextScopeRepository;

  async function seed(options: SeedOptions = {}): Promise<void> {
    const bindingType = options.bindingType ?? "local_runner";
    const bindingStatus = options.bindingStatus ?? "connected";
    const approvedBudgetUsd = options.approvedBudgetUsd ?? 100;
    const taskBudgetLimitUsd = options.taskBudgetLimitUsd ?? 10;
    const phaseStatus = options.phaseStatus ?? "approved";

    await pg.exec(`
      INSERT INTO users (
        id, username, display_name, email, name, password_hash,
        password_hash_scheme, role, status
      ) VALUES ('${USER}', 'pm@example.com', 'PM', 'pm@example.com', 'PM', 'x',
                'scrypt-v1', 'admin', 'active');
      INSERT INTO projects (
        id, name, description, status, current_architecture_revision_id,
        assignment_policy_ref, verification_policy_ref, budget_policy_ref
      ) VALUES (
        '${PROJECT}', 'Norns Demo', 'A demo project for E2.', 'active', NULL,
        'assignment/default', 'verification/strict', 'budget/default'
      );
    `);

    if (bindingType === "local_runner") {
      await pg.query(
        `INSERT INTO repository_bindings (
           id, project_id, binding_type, status, runner_id, workspace_id,
           repository_id, repository_display_name, granted_permissions,
           default_branch, observed_head, verification_policy_ref,
           repository_health, created_by_actor_type, created_by_actor_id
         ) VALUES ($1,$2,'local_runner',$3,$4,'workspace-e2','repository-e2','Norns Demo',
           '{}'::jsonb,'main','commit-e2','verification/strict','healthy','human',$5)`,
        [BINDING, PROJECT, bindingStatus, RUNNER, USER],
      );
    } else {
      await pg.query(
        `INSERT INTO repository_bindings (
           id, project_id, binding_type, status, runner_id, workspace_id,
           repository_id, repository_display_name, github_installation_id,
           github_owner, github_name, granted_permissions,
           default_branch, observed_head, verification_policy_ref,
           repository_health, created_by_actor_type, created_by_actor_id,
           installation_ready
         ) VALUES ($1,$2,'github',$3,$4,NULL,'repository-e2','Norns Demo','install-e2',
           'norns','demo','{}'::jsonb,'main','commit-e2','verification/strict','healthy',
           'human',$5,$6)`,
        [
          BINDING,
          PROJECT,
          bindingStatus,
          RUNNER,
          USER,
          options.installationReady ?? true,
        ],
      );
    }
    await pg.query(`UPDATE projects SET primary_repository_binding_id = $1 WHERE id = $2`, [
      BINDING,
      PROJECT,
    ]);

    await pg.query(
      `INSERT INTO phases (id, project_id, objective_summary, priority, status, approved_budget_usd)
       VALUES ($1,$2,'Ship the execution path end to end.',1,$3,$4)`,
      [PHASE, PROJECT, phaseStatus, approvedBudgetUsd],
    );
    await pg.query(
      `INSERT INTO strategy_versions (
         id, project_id, phase_id, version, status, objective, content, convergence, content_hash
       ) VALUES ($1,$2,$3,1,'approved','Ship execution','{}'::jsonb,'converged',$4)`,
      [STRATEGY, PROJECT, PHASE, HASH_64],
    );
    if (["approved", "active"].includes(phaseStatus)) {
      await pg.query(
        `UPDATE phases SET approved_strategy_version_id = $2 WHERE id = $1`,
        [PHASE, STRATEGY],
      );
    }
    await pg.query(
      `INSERT INTO objectives (id, project_id, phase_id, outcome, success_measures, status, "order")
       VALUES ($1,$2,$3,'A dispatched run produces a verified branch.',
               '["a run completes","tests pass"]'::jsonb,'active',0)`,
      [OBJECTIVE, PROJECT, PHASE],
    );
    await pg.query(
      `INSERT INTO artifacts (
         id, project_id, kind, label, media_type, storage_ref, content_hash, byte_size,
         provenance_actor_type, provenance_actor_id, redaction_status
       ) VALUES ('artifact-${PROJECT}',$1,'architecture','Repository architecture','text/markdown',
                 'https://example.com/arch',$2,10,'human',$3,'reviewed')`,
      [PROJECT, "c".repeat(64), USER],
    );
    await pg.query(
      `INSERT INTO architecture_revisions (
         id, project_id, revision, title, summary, architecture_artifact_id,
         repository_revision, provenance_actor_type, provenance_actor_id
       ) VALUES ($1,$2,1,'Monorepo','pnpm workspace.','artifact-${PROJECT}','abc123','human',$3)`,
      [ARCHITECTURE, PROJECT, USER],
    );
    await pg.query(`UPDATE projects SET current_architecture_revision_id = $1 WHERE id = $2`, [
      ARCHITECTURE,
      PROJECT,
    ]);
    await pg.query(
      `INSERT INTO agent_profiles (
         id, provider, runtime, model, roles, capabilities, context_limit_tokens, status,
         active_workload, cost_metadata
       ) VALUES ($1,'anthropic','claude-code','claude-opus-4-8','["implementer"]'::jsonb,
                 '[]'::jsonb,200000,'available',0,'{}'::jsonb)`,
      [PROFILE],
    );
    await pg.query(
      `INSERT INTO tasks (
         id, project_id, phase_id, objective_id, strategy_version_id, title, description,
         deliverables, acceptance_criteria, complexity, risk, required_roles,
         required_capabilities, required_inputs, expected_outputs,
         environment_policy_ref, verification_policy_ref, state, lifecycle_version,
         created_at
       ) VALUES ($1,$2,$3,$4,$5,'Assemble task context','Do the described work.',
                 '["change implemented"]'::jsonb,'["change has tests","build is green"]'::jsonb,
                 'M','medium','["implementer"]'::jsonb,'[]'::jsonb,'[]'::jsonb,'["commit"]'::jsonb,
                 'env/default','verification/strict','ready',1,'2026-01-02T00:00:00Z')`,
      [TASK, PROJECT, PHASE, OBJECTIVE, STRATEGY],
    );
    await pg.query(
      `INSERT INTO agent_assignments (
         id, project_id, phase_id, task_id, agent_profile_id, status, rationale,
         rationale_factors, budget_limit_usd, allocation_policy_ref
       ) VALUES ($1,$2,$3,$4,$5,'proposed','Strongest at typed backend work.',
                 '{}'::jsonb,$6,'allocation/default')`,
      [ASSIGNMENT, PROJECT, PHASE, TASK, PROFILE, taskBudgetLimitUsd],
    );
    await pg.query(`UPDATE tasks SET designated_assignment_id = $2 WHERE id = $1`, [
      TASK,
      ASSIGNMENT,
    ]);

    // A non-verification repository fact, always present, so
    // `skipVerificationCommands` isolates verification_commands_missing from
    // repository_facts_missing (the assembler checks "any fact at all"
    // before "a verification-command fact specifically").
    await seedFact("package_manager", "pnpm", 0.8);
    if (!options.skipVerificationCommands) {
      await seedFact("build_command", "pnpm run build", 0.99);
      await seedFact("test_command", "pnpm test", 0.99);
      await seedFact("lint_command", "pnpm biome check .", 0.9);
    }
  }

  async function seedFact(key: string, value: string, confidence: number): Promise<void> {
    await pg.query(
      `INSERT INTO project_memory_entries (
         id, project_id, category, content, provenance, confidence, version, status, created_at
       ) VALUES ($1,$2,'repository_fact',$3,'repository_ingestion',$4,1,'active','2026-01-01T00:00:00Z')`,
      [`memory-fact-${key}-${PROJECT}`, PROJECT, `${key}: ${value}`, confidence],
    );
  }

  function service(
    options: { resolveLocalRunner?: (runnerId: string) => { runner_id: string; runner_generation: number } | null } = {},
  ): PhaseLaunchService {
    return new PhaseLaunchService(
      transactions,
      coordinator,
      taskContext,
      dispatchScope,
      options.resolveLocalRunner ??
        ((runnerId) => (runnerId === RUNNER ? { runner_id: RUNNER, runner_generation: 1 } : null)),
      undefined,
      DEFAULT_PHASE_LAUNCH_POLICY,
    );
  }

  function issuedAt(): string {
    return "2026-07-21T12:00:00.000Z";
  }

  beforeEach(async () => {
    pg = new PGlite();
    await pg.exec("CREATE ROLE norns_app NOLOGIN");
    await runCurrentV2Migrations(pg as unknown as V2MigrationDatabase);
    transactions = new PGliteTransactionRunner(pg);
    coordinator = new Phase4Coordinator(transactions);
    taskContext = new RelationalTaskContextAssembler(transactions, new TaskContextStore(transactions), {
      baseUrl: "https://norns.example.com",
    });
    dispatchScope = new DispatchContextScopeRepository(transactions);
  }, 60_000);

  afterEach(async () => {
    if (!pg.closed) await pg.close();
  });

  // ---- the real chain: approved -> active, real dispatch_jobs, real refs ---

  it("schedules a dependency-ready task through the real coordinator gate with real assembled context_refs", async () => {
    await seed();
    const result = await service().startPhase({
      project_id: PROJECT,
      phase_id: PHASE,
      authorized_by: { actor_type: "human", actor_id: USER },
      authorized_by_session_id: "session-e2",
      issued_at: issuedAt(),
    });

    expect(result.blocked).toEqual([]);
    expect(result.scheduled).toHaveLength(1);
    const scheduled = result.scheduled[0];
    expect(scheduled?.task_id).toBe(TASK);
    expect(scheduled?.run_id).toBeTruthy();
    expect(scheduled?.dispatch_job_id).toBeTruthy();

    const phaseRow = await pg.query<{ status: string }>("SELECT status FROM phases WHERE id = $1", [
      PHASE,
    ]);
    expect(phaseRow.rows[0]?.status).toBe("active");

    const dispatchRow = await pg.query<{ status: string; runner_id: string }>(
      "SELECT status, runner_id FROM dispatch_jobs WHERE id = $1",
      [scheduled?.dispatch_job_id],
    );
    expect(dispatchRow.rows[0]).toEqual({ status: "queued", runner_id: RUNNER });

    const commandRow = await pg.query<{ envelope: { context_refs: unknown[] } }>(
      "SELECT envelope FROM commands WHERE dispatch_job_id = $1",
      [scheduled?.dispatch_job_id],
    );
    const contextRefs = commandRow.rows[0]?.envelope.context_refs ?? [];
    expect(Array.isArray(contextRefs)).toBe(true);
    expect(contextRefs.length).toBeGreaterThan(0);

    // Real, assembled content — not a placeholder — reached the dispatch
    // command. Cross-check every ref id is a real content-addressed
    // document in the store.
    const documentIds = await pg.query<{ count: string }>(
      "SELECT count(*) AS count FROM task_context_documents",
    );
    expect(Number(documentIds.rows[0]?.count)).toBe(contextRefs.length);

    // EXECUTION E2's authorization scope: the runner that was actually
    // dispatched is recorded against every context document it was handed.
    const scopeRows = await pg.query<{ count: string }>(
      "SELECT count(*) AS count FROM dispatch_context_documents WHERE runner_id = $1",
      [RUNNER],
    );
    expect(Number(scopeRows.rows[0]?.count)).toBe(contextRefs.length);
  });

  it("readiness() reports ready without scheduling anything", async () => {
    await seed();
    const readiness = await service().readiness({ project_id: PROJECT, phase_id: PHASE });
    expect(readiness).toEqual({
      ready: true,
      schedulable_task_count: 1,
      blocking_code: null,
      blocking_reason: null,
    });
    const dispatchCount = await pg.query<{ count: string }>(
      "SELECT count(*) AS count FROM dispatch_jobs",
    );
    expect(Number(dispatchCount.rows[0]?.count)).toBe(0);
    const phaseRow = await pg.query<{ status: string }>("SELECT status FROM phases WHERE id = $1", [
      PHASE,
    ]);
    expect(phaseRow.rows[0]?.status).toBe("approved");
  });

  it("is idempotent: nothing schedulable is a no-op, not an error", async () => {
    await seed();
    await pg.query(
      `UPDATE tasks SET state = 'completed', completed_at = now(),
         review_evidence = '[{"kind":"note","detail":"verified"}]'::jsonb,
         completion_evidence = '[{"kind":"note","detail":"verified"}]'::jsonb
       WHERE id = $1`,
      [TASK],
    );
    const result = await service().startPhase({
      project_id: PROJECT,
      phase_id: PHASE,
      authorized_by: { actor_type: "human", actor_id: USER },
      authorized_by_session_id: "session-e2",
      issued_at: issuedAt(),
    });
    expect(result).toEqual({ phase_id: PHASE, scheduled: [], blocked: [] });
  });

  // ---- whole-phase blocking preconditions ---------------------------------

  it("refuses a phase that isn't approved for execution", async () => {
    await seed({ phaseStatus: "proposed" });
    await expect(
      service().startPhase({
        project_id: PROJECT,
        phase_id: PHASE,
        authorized_by: { actor_type: "human", actor_id: USER },
        authorized_by_session_id: "session-e2",
        issued_at: issuedAt(),
      }),
    ).rejects.toMatchObject({ code: "phase_not_ready" });
  });

  it("refuses a project with no execution binding at all", async () => {
    await seed();
    await pg.query("UPDATE projects SET primary_repository_binding_id = NULL WHERE id = $1", [
      PROJECT,
    ]);
    await expect(
      service().startPhase({
        project_id: PROJECT,
        phase_id: PHASE,
        authorized_by: { actor_type: "human", actor_id: USER },
        authorized_by_session_id: "session-e2",
        issued_at: issuedAt(),
      }),
    ).rejects.toMatchObject({ code: "no_execution_binding" });
  });

  it("refuses a GitHub project whose App installation doesn't cover the repository yet", async () => {
    await seed({ bindingType: "github", installationReady: false });
    await expect(
      service().startPhase({
        project_id: PROJECT,
        phase_id: PHASE,
        authorized_by: { actor_type: "human", actor_id: USER },
        authorized_by_session_id: "session-e2",
        issued_at: issuedAt(),
      }),
    ).rejects.toMatchObject({ code: "installation_not_ready" });
  });

  it("refuses an unverified (not-yet-connected) binding — the gate's check, extended not weakened", async () => {
    await seed({ bindingStatus: "unverified_candidate" });
    await expect(
      service().startPhase({
        project_id: PROJECT,
        phase_id: PHASE,
        authorized_by: { actor_type: "human", actor_id: USER },
        authorized_by_session_id: "session-e2",
        issued_at: issuedAt(),
      }),
    ).rejects.toMatchObject({ code: "unverified_binding" });
    // And the underlying coordinator gate itself still refuses it too, if
    // this module's own precondition were ever bypassed — proven directly
    // against Phase4Coordinator in phase4Coordinator.test.ts.
  });

  it("refuses a GitHub-hosted project when Actions execution isn't configured on this server", async () => {
    await seed({ bindingType: "github" });
    await expect(
      service().startPhase({
        project_id: PROJECT,
        phase_id: PHASE,
        authorized_by: { actor_type: "human", actor_id: USER },
        authorized_by_session_id: "session-e2",
        issued_at: issuedAt(),
      }),
    ).rejects.toMatchObject({ code: "actions_execution_unavailable" });
  });

  it("blocks a task whose local runner has never paired with this relay", async () => {
    await seed();
    const result = await service({ resolveLocalRunner: () => null }).startPhase({
      project_id: PROJECT,
      phase_id: PHASE,
      authorized_by: { actor_type: "human", actor_id: USER },
      authorized_by_session_id: "session-e2",
      issued_at: issuedAt(),
    });
    expect(result.scheduled).toEqual([]);
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0]).toMatchObject({
      task_id: TASK,
      blocked_code: "unverified_binding",
    });
  });

  // ---- EXECUTION E1's typed assembly failures surface as blocking, never --
  // ---- as a partially scheduled task --------------------------------------

  it("blocks (never partially schedules) a task missing its verification commands", async () => {
    await seed({ skipVerificationCommands: true });
    const result = await service().startPhase({
      project_id: PROJECT,
      phase_id: PHASE,
      authorized_by: { actor_type: "human", actor_id: USER },
      authorized_by_session_id: "session-e2",
      issued_at: issuedAt(),
    });
    expect(result.scheduled).toEqual([]);
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0]).toMatchObject({
      task_id: TASK,
      blocked_code: "verification_commands_missing",
    });
    expect(result.blocked[0]?.blocked_reason).toMatch(/verification|command/i);

    // Never partially scheduled: no run, no dispatch job, phase stayed put.
    const runs = await pg.query<{ count: string }>("SELECT count(*) AS count FROM agent_runs");
    expect(Number(runs.rows[0]?.count)).toBe(0);
    const phaseRow = await pg.query<{ status: string }>("SELECT status FROM phases WHERE id = $1", [
      PHASE,
    ]);
    expect(phaseRow.rows[0]?.status).toBe("approved");
  });

  it("blocks a task whose acceptance criteria are missing, with that specific reason", async () => {
    await seed();
    await pg.query("UPDATE tasks SET acceptance_criteria = '[]'::jsonb WHERE id = $1", [TASK]);
    const readiness = await service().readiness({ project_id: PROJECT, phase_id: PHASE });
    expect(readiness.ready).toBe(false);
    expect(readiness.blocking_code).toBe("acceptance_criteria_missing");
    expect(readiness.blocking_reason).toBeTruthy();

    const result = await service().startPhase({
      project_id: PROJECT,
      phase_id: PHASE,
      authorized_by: { actor_type: "human", actor_id: USER },
      authorized_by_session_id: "session-e2",
      issued_at: issuedAt(),
    });
    expect(result.scheduled).toEqual([]);
    expect(result.blocked[0]).toMatchObject({
      task_id: TASK,
      blocked_code: "acceptance_criteria_missing",
    });
  });

  it("blocks a task whose strategy version was superseded by a later approval", async () => {
    await seed();
    // A later strategy version is approved for the phase (e.g. rework), but
    // this task was materialized from the original version and never
    // re-staffed under the new one.
    await pg.query(
      "UPDATE strategy_versions SET status = 'superseded' WHERE id = $1",
      [STRATEGY],
    );
    await pg.query(
      "INSERT INTO strategy_versions (id, project_id, phase_id, version, status, objective, content, convergence, content_hash) VALUES ($1,$2,$3,2,'approved','v2','{}'::jsonb,'converged',$4)",
      [`${STRATEGY}-v2`, PROJECT, PHASE, "b".repeat(64)],
    );
    await pg.query("UPDATE phases SET approved_strategy_version_id = $2 WHERE id = $1", [
      PHASE,
      `${STRATEGY}-v2`,
    ]);
    const result = await service().startPhase({
      project_id: PROJECT,
      phase_id: PHASE,
      authorized_by: { actor_type: "human", actor_id: USER },
      authorized_by_session_id: "session-e2",
      issued_at: issuedAt(),
    });
    expect(result.scheduled).toEqual([]);
    expect(result.blocked[0]).toMatchObject({
      task_id: TASK,
      blocked_code: "strategy_superseded",
    });
  });

  // ---- budget --------------------------------------------------------------

  it("reports budget_exhausted in readiness() when the phase budget has no room", async () => {
    await seed({ approvedBudgetUsd: 5, taskBudgetLimitUsd: 10 });
    const readiness = await service().readiness({ project_id: PROJECT, phase_id: PHASE });
    expect(readiness).toMatchObject({ ready: false, blocking_code: "budget_exhausted" });
  });

  it("the coordinator gate itself refuses an insufficient budget, surfaced as budget_exhausted", async () => {
    await seed({ approvedBudgetUsd: 5, taskBudgetLimitUsd: 10 });
    const result = await service().startPhase({
      project_id: PROJECT,
      phase_id: PHASE,
      authorized_by: { actor_type: "human", actor_id: USER },
      authorized_by_session_id: "session-e2",
      issued_at: issuedAt(),
    });
    expect(result.scheduled).toEqual([]);
    expect(result.blocked[0]).toMatchObject({
      task_id: TASK,
      blocked_code: "budget_exhausted",
    });
    const phaseRow = await pg.query<{ status: string }>("SELECT status FROM phases WHERE id = $1", [
      PHASE,
    ]);
    // The coordinator's own budget check runs inside the same transaction as
    // the phase-activation write; refusing it means the phase never flips.
    expect(phaseRow.rows[0]?.status).toBe("approved");
  });
});
