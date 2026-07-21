// FRONT DOOR P5 (tracking): percent-complete / ETA / burn-rate math, the
// resume-payload additions, and the update_interval_seconds project setting.
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";
import { AttentionService } from "../src/projects/attentionService.js";
import { PhaseWorkflowService } from "../src/projects/phaseWorkflowService.js";
import {
  ProjectResumeNotFoundError,
  ProjectResumeService,
  ProjectSettingsValidationError,
  computeBlendedEtaAt,
  computeBurnRateUsdPerHour,
  computeOverallPercentComplete,
  computePercentComplete,
  computePhaseEta,
} from "../src/projects/projectResumeService.js";
import { RepositoryIngestionService } from "../src/projects/repositoryIngestionService.js";
import { SourceBindingService } from "../src/projects/sourceBindingService.js";
import { ProjectStore } from "../src/projects/store.js";
import { StrategyBridgeService } from "../src/projects/strategyBridgeService.js";
import { StrategyWorkflowService } from "../src/projects/strategyWorkflowService.js";
import { type NornsServer, buildServer } from "../src/server.js";
import { RelayStores } from "../src/stores.js";
import { UserStore } from "../src/users/store.js";
import { testAdminToken } from "./helpers.js";

describe("progress math (pure functions)", () => {
  describe("computePercentComplete", () => {
    it("weights tasks equally and rounds to the nearest int", () => {
      expect(computePercentComplete(1, 3)).toBe(33);
      expect(computePercentComplete(2, 3)).toBe(67);
      expect(computePercentComplete(5, 8)).toBe(63);
    });

    it("guards the empty-phase division by zero as 0%, not NaN", () => {
      expect(computePercentComplete(0, 0)).toBe(0);
    });

    it("is never negative or over 100 even with malformed input", () => {
      expect(computePercentComplete(5, 4)).toBe(100);
      expect(computePercentComplete(-1, 4)).toBe(0);
    });
  });

  describe("computePhaseEta", () => {
    const base = {
      isExecuting: true,
      tasksCompleted: 3,
      tasksTotal: 4,
      recentCompletionTimestamps: [
        "2026-07-20T10:00:00.000Z",
        "2026-07-20T11:00:00.000Z",
        "2026-07-20T12:00:00.000Z",
      ],
    };

    it("projects linearly from rolling-window throughput", () => {
      expect(computePhaseEta(base)).toBe("2026-07-20T13:00:00.000Z");
    });

    it("is null when the phase is not executing (no fabricated ETA)", () => {
      expect(computePhaseEta({ ...base, isExecuting: false })).toBeNull();
    });

    it("is null when there is nothing left to project", () => {
      expect(computePhaseEta({ ...base, tasksCompleted: 4 })).toBeNull();
      expect(computePhaseEta({ ...base, tasksCompleted: 5, tasksTotal: 4 })).toBeNull();
    });

    it("is null with fewer than 2 completions (no throughput signal)", () => {
      expect(
        computePhaseEta({ ...base, recentCompletionTimestamps: ["2026-07-20T10:00:00.000Z"] }),
      ).toBeNull();
      expect(computePhaseEta({ ...base, recentCompletionTimestamps: [] })).toBeNull();
    });

    it("guards a zero/degenerate time span instead of dividing by zero", () => {
      expect(
        computePhaseEta({
          ...base,
          recentCompletionTimestamps: ["2026-07-20T10:00:00.000Z", "2026-07-20T10:00:00.000Z"],
        }),
      ).toBeNull();
    });

    it("sorts out-of-order timestamps before projecting", () => {
      const shuffled = {
        ...base,
        recentCompletionTimestamps: [
          "2026-07-20T12:00:00.000Z",
          "2026-07-20T10:00:00.000Z",
          "2026-07-20T11:00:00.000Z",
        ],
      };
      expect(computePhaseEta(shuffled)).toBe("2026-07-20T13:00:00.000Z");
    });
  });

  describe("computeBurnRateUsdPerHour", () => {
    it("computes total cost over total elapsed hours", () => {
      const samples = [
        {
          started_at: "2026-07-20T09:30:00Z",
          finished_at: "2026-07-20T10:00:00Z",
          usage_cost_usd: 5,
        },
        {
          started_at: "2026-07-20T10:30:00Z",
          finished_at: "2026-07-20T11:00:00Z",
          usage_cost_usd: 5,
        },
        {
          started_at: "2026-07-20T11:30:00Z",
          finished_at: "2026-07-20T12:00:00Z",
          usage_cost_usd: 5,
        },
      ];
      expect(computeBurnRateUsdPerHour(samples)).toBe(10);
    });

    it("is null with no signal (no finished runs)", () => {
      expect(computeBurnRateUsdPerHour([])).toBeNull();
    });

    it("guards zero/negative elapsed time instead of dividing by zero", () => {
      expect(
        computeBurnRateUsdPerHour([
          {
            started_at: "2026-07-20T10:00:00Z",
            finished_at: "2026-07-20T10:00:00Z",
            usage_cost_usd: 5,
          },
          {
            started_at: "2026-07-20T10:00:00Z",
            finished_at: "2026-07-20T09:00:00Z",
            usage_cost_usd: 5,
          },
        ]),
      ).toBeNull();
    });

    it("skips samples missing a start or finish instead of throwing", () => {
      expect(
        computeBurnRateUsdPerHour([
          { started_at: null, finished_at: "2026-07-20T10:00:00Z", usage_cost_usd: 5 },
          { started_at: "2026-07-20T09:00:00Z", finished_at: null, usage_cost_usd: 5 },
          {
            started_at: "2026-07-20T09:00:00Z",
            finished_at: "2026-07-20T10:00:00Z",
            usage_cost_usd: 4,
          },
        ]),
      ).toBe(4);
    });
  });

  describe("computeOverallPercentComplete", () => {
    it("task-weights across mixed phase states, excluding cancelled phases", () => {
      const phases = [
        { tasksCompleted: 3, tasksTotal: 4, status: "active" },
        { tasksCompleted: 0, tasksTotal: 2, status: "blocked" },
        { tasksCompleted: 0, tasksTotal: 0, status: "proposed" },
        { tasksCompleted: 2, tasksTotal: 2, status: "completed" },
        { tasksCompleted: 1, tasksTotal: 3, status: "cancelled" },
      ];
      // included: (3+0+0+2) / (4+2+0+2) = 5/8 = 62.5% -> rounds to 63
      expect(computeOverallPercentComplete(phases)).toBe(63);
    });

    it("guards an all-empty / all-cancelled project as 0%, not NaN", () => {
      expect(computeOverallPercentComplete([])).toBe(0);
      expect(
        computeOverallPercentComplete([{ tasksCompleted: 5, tasksTotal: 5, status: "cancelled" }]),
      ).toBe(0);
    });
  });

  describe("computeBlendedEtaAt", () => {
    it("takes the latest ETA among executing phases", () => {
      expect(
        computeBlendedEtaAt([
          "2026-07-20T13:00:00.000Z",
          null,
          "2026-07-21T09:00:00.000Z",
          "2026-07-20T18:00:00.000Z",
        ]),
      ).toBe("2026-07-21T09:00:00.000Z");
    });

    it("is null when no phase has an ETA signal", () => {
      expect(computeBlendedEtaAt([null, null])).toBeNull();
      expect(computeBlendedEtaAt([])).toBeNull();
    });
  });
});

describe.sequential("ProjectResumeService progress + settings (pglite)", () => {
  let pg: PGlite;
  let transactions: PGliteTransactionRunner;
  let resume: ProjectResumeService;

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
      INSERT INTO projects (id, name, description, status, assignment_policy_ref, verification_policy_ref, budget_policy_ref)
      VALUES ('project-1','Project One','','active','assignment','verification','budget');

      INSERT INTO repository_bindings (
        id, project_id, binding_type, status, runner_id, workspace_id,
        repository_id, repository_display_name, granted_permissions, default_branch,
        observed_head, verification_policy_ref, repository_health,
        created_by_actor_type, created_by_actor_id
      ) VALUES ('binding-1','project-1','local_runner','connected','runner-1','workspace-1',
        'repo-1','Project One','{}'::jsonb,'main','commit-1','verification','healthy','human','admin-1');

      -- phase-active: executing, 3 of 4 tasks completed on a steady cadence.
      -- phases_active_strategy_check requires approved_strategy_version_id
      -- before status can be 'active', so it is created 'approved' and
      -- flipped to 'active' once its strategy version exists.
      INSERT INTO phases (id, project_id, objective_summary, priority, status, approved_budget_usd)
      VALUES ('phase-active','project-1','Ship tracking',3,'approved',100);
      INSERT INTO strategy_versions (id, project_id, phase_id, version, status, objective, content, convergence, review_rounds, content_hash)
      VALUES ('strategy-active','project-1','phase-active',1,'approved','Ship tracking','{}'::jsonb,'converged',1,repeat('a',64));
      UPDATE phases SET approved_strategy_version_id='strategy-active', status='active' WHERE id='phase-active';
      INSERT INTO objectives (id, project_id, phase_id, outcome, success_measures, status, "order")
      VALUES ('objective-active','project-1','phase-active','Tracking works','["visible"]'::jsonb,'active',0);
      INSERT INTO tasks (
        id, project_id, phase_id, objective_id, strategy_version_id, title, description,
        deliverables, acceptance_criteria, complexity, risk, required_roles,
        required_capabilities, required_inputs, expected_outputs, environment_policy_ref,
        verification_policy_ref, state, lifecycle_version, aggregate_version,
        review_evidence, completion_evidence, completed_at
      ) VALUES
        ('task-a','project-1','phase-active','objective-active','strategy-active','Task A','desc',
          '["d"]'::jsonb,'["c"]'::jsonb,'M','low','["backend"]'::jsonb,'[]'::jsonb,'[]'::jsonb,'["out"]'::jsonb,
          'environment','verification','completed',1,1,'[{"e":1}]'::jsonb,'[{"e":1}]'::jsonb,'2026-07-20T10:00:00Z'),
        ('task-b','project-1','phase-active','objective-active','strategy-active','Task B','desc',
          '["d"]'::jsonb,'["c"]'::jsonb,'M','low','["backend"]'::jsonb,'[]'::jsonb,'[]'::jsonb,'["out"]'::jsonb,
          'environment','verification','completed',1,1,'[{"e":1}]'::jsonb,'[{"e":1}]'::jsonb,'2026-07-20T11:00:00Z'),
        ('task-c','project-1','phase-active','objective-active','strategy-active','Task C','desc',
          '["d"]'::jsonb,'["c"]'::jsonb,'M','low','["backend"]'::jsonb,'[]'::jsonb,'[]'::jsonb,'["out"]'::jsonb,
          'environment','verification','completed',1,1,'[{"e":1}]'::jsonb,'[{"e":1}]'::jsonb,'2026-07-20T12:00:00Z'),
        ('task-d','project-1','phase-active','objective-active','strategy-active','Task D','desc',
          '["d"]'::jsonb,'["c"]'::jsonb,'M','low','["backend"]'::jsonb,'[]'::jsonb,'[]'::jsonb,'["out"]'::jsonb,
          'environment','verification','in_progress',1,1,'[]'::jsonb,'[]'::jsonb,NULL);

      INSERT INTO agent_profiles (id, provider, runtime, model, roles, capabilities, context_limit_tokens, security_restrictions, status, active_workload, cost_metadata)
      VALUES ('profile-1','anthropic','api','claude','["backend"]'::jsonb,'[]'::jsonb,100000,'[]'::jsonb,'available',0,'{}'::jsonb);
      INSERT INTO agent_assignments (id, project_id, phase_id, task_id, agent_profile_id, status, rationale, rationale_factors, allocation_policy_ref)
      VALUES
        ('assignment-a','project-1','phase-active','task-a','profile-1','completed','ok','[]'::jsonb,'allocation'),
        ('assignment-b','project-1','phase-active','task-b','profile-1','completed','ok','[]'::jsonb,'allocation'),
        ('assignment-c','project-1','phase-active','task-c','profile-1','completed','ok','[]'::jsonb,'allocation'),
        ('assignment-d','project-1','phase-active','task-d','profile-1','active','ok','[]'::jsonb,'allocation');
      INSERT INTO agent_runs (id, project_id, phase_id, task_id, assignment_id, attempt, state, repository_binding_id, expected_revision, usage_cost_usd, started_at, finished_at, lifecycle_version)
      VALUES
        ('run-a','project-1','phase-active','task-a','assignment-a',1,'succeeded','binding-1','commit-1',5,'2026-07-20T09:30:00Z','2026-07-20T10:00:00Z',1),
        ('run-b','project-1','phase-active','task-b','assignment-b',1,'succeeded','binding-1','commit-1',5,'2026-07-20T10:30:00Z','2026-07-20T11:00:00Z',1),
        ('run-c','project-1','phase-active','task-c','assignment-c',1,'succeeded','binding-1','commit-1',5,'2026-07-20T11:30:00Z','2026-07-20T12:00:00Z',1),
        ('run-d','project-1','phase-active','task-d','assignment-d',1,'running','binding-1','commit-1',0,'2026-07-20T12:30:00Z',NULL,1);

      -- phase-blocked: no completions yet, no ETA signal
      INSERT INTO phases (id, project_id, objective_summary, priority, status, approved_budget_usd)
      VALUES ('phase-blocked','project-1','Fix outage',2,'blocked',50);
      INSERT INTO objectives (id, project_id, phase_id, outcome, success_measures, status, "order")
      VALUES ('objective-blocked','project-1','phase-blocked','Outage fixed','["visible"]'::jsonb,'active',0);
      INSERT INTO strategy_versions (id, project_id, phase_id, version, status, objective, content, convergence, review_rounds, content_hash)
      VALUES ('strategy-blocked','project-1','phase-blocked',1,'approved','Fix outage','{}'::jsonb,'converged',1,repeat('b',64));
      UPDATE phases SET approved_strategy_version_id='strategy-blocked' WHERE id='phase-blocked';
      INSERT INTO tasks (
        id, project_id, phase_id, objective_id, strategy_version_id, title, description,
        deliverables, acceptance_criteria, complexity, risk, required_roles,
        required_capabilities, required_inputs, expected_outputs, environment_policy_ref,
        verification_policy_ref, state, lifecycle_version, aggregate_version
      ) VALUES
        ('task-e','project-1','phase-blocked','objective-blocked','strategy-blocked','Task E','desc',
          '["d"]'::jsonb,'["c"]'::jsonb,'M','high','["backend"]'::jsonb,'[]'::jsonb,'[]'::jsonb,'["out"]'::jsonb,
          'environment','verification','blocked',1,1),
        ('task-f','project-1','phase-blocked','objective-blocked','strategy-blocked','Task F','desc',
          '["d"]'::jsonb,'["c"]'::jsonb,'M','high','["backend"]'::jsonb,'[]'::jsonb,'[]'::jsonb,'["out"]'::jsonb,
          'environment','verification','ready',1,1);

      -- phase-proposed: queued, no strategy/tasks yet
      INSERT INTO phases (id, project_id, objective_summary, priority, status, approved_budget_usd)
      VALUES ('phase-proposed','project-1','Next up',1,'proposed',0);

      -- phase-completed: fully done, must not carry an ETA
      INSERT INTO phases (id, project_id, objective_summary, priority, status, approved_budget_usd)
      VALUES ('phase-completed','project-1','Already shipped',4,'completed',20);
      INSERT INTO objectives (id, project_id, phase_id, outcome, success_measures, status, "order")
      VALUES ('objective-completed','project-1','phase-completed','Shipped','["visible"]'::jsonb,'completed',0);
      INSERT INTO strategy_versions (id, project_id, phase_id, version, status, objective, content, convergence, review_rounds, content_hash)
      VALUES ('strategy-completed','project-1','phase-completed',1,'approved','Already shipped','{}'::jsonb,'converged',1,repeat('c',64));
      UPDATE phases SET approved_strategy_version_id='strategy-completed' WHERE id='phase-completed';
      INSERT INTO tasks (
        id, project_id, phase_id, objective_id, strategy_version_id, title, description,
        deliverables, acceptance_criteria, complexity, risk, required_roles,
        required_capabilities, required_inputs, expected_outputs, environment_policy_ref,
        verification_policy_ref, state, lifecycle_version, aggregate_version,
        review_evidence, completion_evidence, completed_at
      ) VALUES
        ('task-g','project-1','phase-completed','objective-completed','strategy-completed','Task G','desc',
          '["d"]'::jsonb,'["c"]'::jsonb,'S','low','["backend"]'::jsonb,'[]'::jsonb,'[]'::jsonb,'["out"]'::jsonb,
          'environment','verification','completed',1,1,'[{"e":1}]'::jsonb,'[{"e":1}]'::jsonb,'2026-07-19T09:00:00Z'),
        ('task-h','project-1','phase-completed','objective-completed','strategy-completed','Task H','desc',
          '["d"]'::jsonb,'["c"]'::jsonb,'S','low','["backend"]'::jsonb,'[]'::jsonb,'[]'::jsonb,'["out"]'::jsonb,
          'environment','verification','completed',1,1,'[{"e":1}]'::jsonb,'[{"e":1}]'::jsonb,'2026-07-19T10:00:00Z');

      -- phase-cancelled: scope withdrawn, must not dilute the project aggregate
      INSERT INTO phases (id, project_id, objective_summary, priority, status, approved_budget_usd)
      VALUES ('phase-cancelled','project-1','Abandoned idea',0,'cancelled',0);
      INSERT INTO objectives (id, project_id, phase_id, outcome, success_measures, status, "order")
      VALUES ('objective-cancelled','project-1','phase-cancelled','n/a','["visible"]'::jsonb,'cancelled',0);
      INSERT INTO strategy_versions (id, project_id, phase_id, version, status, objective, content, convergence, review_rounds, content_hash)
      VALUES ('strategy-cancelled','project-1','phase-cancelled',1,'approved','Abandoned idea','{}'::jsonb,'converged',1,repeat('d',64));
      UPDATE phases SET approved_strategy_version_id='strategy-cancelled' WHERE id='phase-cancelled';
      INSERT INTO tasks (
        id, project_id, phase_id, objective_id, strategy_version_id, title, description,
        deliverables, acceptance_criteria, complexity, risk, required_roles,
        required_capabilities, required_inputs, expected_outputs, environment_policy_ref,
        verification_policy_ref, state, lifecycle_version, aggregate_version,
        review_evidence, completion_evidence, completed_at
      ) VALUES
        ('task-i','project-1','phase-cancelled','objective-cancelled','strategy-cancelled','Task I','desc',
          '["d"]'::jsonb,'["c"]'::jsonb,'S','low','["backend"]'::jsonb,'[]'::jsonb,'[]'::jsonb,'["out"]'::jsonb,
          'environment','verification','completed',1,1,'[{"e":1}]'::jsonb,'[{"e":1}]'::jsonb,'2026-07-18T09:00:00Z'),
        ('task-j','project-1','phase-cancelled','objective-cancelled','strategy-cancelled','Task J','desc',
          '["d"]'::jsonb,'["c"]'::jsonb,'S','low','["backend"]'::jsonb,'[]'::jsonb,'[]'::jsonb,'["out"]'::jsonb,
          'environment','verification','cancelled',1,1,'[]'::jsonb,'[]'::jsonb,NULL),
        ('task-k','project-1','phase-cancelled','objective-cancelled','strategy-cancelled','Task K','desc',
          '["d"]'::jsonb,'["c"]'::jsonb,'S','low','["backend"]'::jsonb,'[]'::jsonb,'[]'::jsonb,'["out"]'::jsonb,
          'environment','verification','cancelled',1,1,'[]'::jsonb,'[]'::jsonb,NULL);

      INSERT INTO decision_points (
        id, project_id, phase_id, scope_entity_type, scope_entity_id, reason_class,
        source_instance_id, condition_key, condition_fingerprint, question, context,
        options, recommendation_option_id, urgency, status
      ) VALUES (
        'decision-1','project-1','phase-blocked','task','task-e','ambiguous_scope',
        'source-1','condition-1',repeat('a',64),'Which fix?','context',
        '[{"id":"a","label":"A"}]'::jsonb,'a','high','open'
      );
    `);
    transactions = new PGliteTransactionRunner(pg);
    resume = new ProjectResumeService(transactions);
  });

  afterEach(async () => {
    await pg.close();
  });

  it("computes per-phase progress and defaults update_interval_seconds to 300", async () => {
    const result = await resume.open("project-1");
    expect(result.update_interval_seconds).toBe(300);

    const active = result.phases.find((phase) => phase.id === "phase-active");
    expect(active).toMatchObject({
      percent_complete: 75,
      tasks_completed: 3,
      tasks_total: 4,
      eta_at: "2026-07-20T13:00:00.000Z",
      burn_rate_usd_per_hour: 10,
    });

    const blocked = result.phases.find((phase) => phase.id === "phase-blocked");
    expect(blocked).toMatchObject({
      percent_complete: 0,
      tasks_completed: 0,
      tasks_total: 2,
      eta_at: null,
      burn_rate_usd_per_hour: null,
    });

    const proposed = result.phases.find((phase) => phase.id === "phase-proposed");
    expect(proposed).toMatchObject({
      percent_complete: 0,
      tasks_completed: 0,
      tasks_total: 0,
      eta_at: null,
      burn_rate_usd_per_hour: null,
    });

    const completed = result.phases.find((phase) => phase.id === "phase-completed");
    expect(completed).toMatchObject({
      percent_complete: 100,
      tasks_completed: 2,
      tasks_total: 2,
      eta_at: null, // not executing, even though every task is done
    });
  });

  it("aggregates task-weighted overall percent, blended ETA, active agents, and decisions", async () => {
    const result = await resume.open("project-1");
    // included phases (all but cancelled): active(3/4) + blocked(0/2) + proposed(0/0) + completed(2/2)
    // = 5 / 8 = 62.5% -> 63
    expect(result.progress).toMatchObject({
      overall_percent_complete: 63,
      blended_eta_at: "2026-07-20T13:00:00.000Z",
      agents_active: 1, // run-d is 'running'
      decisions_waiting: 1, // decision-1 is 'open'
    });
  });

  it("does not let a cancelled phase's tasks dilute the project aggregate", async () => {
    const result = await resume.open("project-1");
    const cancelled = result.phases.find((phase) => phase.id === "phase-cancelled");
    expect(cancelled?.tasks_total).toBe(3);
    // if phase-cancelled's 1/3 completed tasks were included, the aggregate
    // would differ from the 63% asserted above.
    expect(result.progress.overall_percent_complete).toBe(63);
  });

  describe("update_interval_seconds settings", () => {
    it("round-trips a valid value through updateSettings and a subsequent resume", async () => {
      await expect(resume.updateSettings("project-1", 900)).resolves.toEqual({
        update_interval_seconds: 900,
      });
      const reopened = await resume.open("project-1");
      expect(reopened.update_interval_seconds).toBe(900);
    });

    it.each([100, 0, -60, 61, 1.5])(
      "rejects a disallowed update_interval_seconds value (%s)",
      async (value) => {
        await expect(resume.updateSettings("project-1", value)).rejects.toBeInstanceOf(
          ProjectSettingsValidationError,
        );
      },
    );

    it("enforces the 60s floor independently of the allowed-value check", async () => {
      await expect(resume.updateSettings("project-1", 59)).rejects.toThrow(/at least 60 seconds/);
    });

    it("throws ProjectResumeNotFoundError for an unknown project", async () => {
      await expect(resume.updateSettings("does-not-exist", 900)).rejects.toBeInstanceOf(
        ProjectResumeNotFoundError,
      );
    });
  });
});

describe.sequential("AttentionService.phase() progress fields (pglite)", () => {
  let pg: PGlite;
  let attention: AttentionService;

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
      INSERT INTO projects (id, name, description, status, assignment_policy_ref, verification_policy_ref, budget_policy_ref)
      VALUES ('project-2','Project Two','','active','assignment','verification','budget');
      INSERT INTO repository_bindings (
        id, project_id, binding_type, status, runner_id, workspace_id,
        repository_id, repository_display_name, granted_permissions, default_branch,
        observed_head, verification_policy_ref, repository_health,
        created_by_actor_type, created_by_actor_id
      ) VALUES ('binding-2','project-2','local_runner','connected','runner-1','workspace-1',
        'repo-1','Project Two','{}'::jsonb,'main','commit-1','verification','healthy','human','admin-1');
      INSERT INTO phases (id, project_id, objective_summary, priority, status, approved_budget_usd)
      VALUES ('phase-2','project-2','Ship tracking',1,'approved',100);
      INSERT INTO strategy_versions (id, project_id, phase_id, version, status, objective, content, convergence, review_rounds, content_hash)
      VALUES ('strategy-2','project-2','phase-2',1,'approved','Ship tracking','{}'::jsonb,'converged',1,repeat('a',64));
      UPDATE phases SET approved_strategy_version_id='strategy-2', status='active' WHERE id='phase-2';
      INSERT INTO objectives (id, project_id, phase_id, outcome, success_measures, status, "order")
      VALUES ('objective-2','project-2','phase-2','Tracking works','["visible"]'::jsonb,'active',0);
      INSERT INTO tasks (
        id, project_id, phase_id, objective_id, strategy_version_id, title, description,
        deliverables, acceptance_criteria, complexity, risk, required_roles,
        required_capabilities, required_inputs, expected_outputs, environment_policy_ref,
        verification_policy_ref, state, lifecycle_version, aggregate_version,
        review_evidence, completion_evidence, completed_at
      ) VALUES
        ('task-x','project-2','phase-2','objective-2','strategy-2','Task X','desc',
          '["d"]'::jsonb,'["c"]'::jsonb,'M','low','["backend"]'::jsonb,'[]'::jsonb,'[]'::jsonb,'["out"]'::jsonb,
          'environment','verification','completed',1,1,'[{"e":1}]'::jsonb,'[{"e":1}]'::jsonb,'2026-07-20T10:00:00Z'),
        ('task-y','project-2','phase-2','objective-2','strategy-2','Task Y','desc',
          '["d"]'::jsonb,'["c"]'::jsonb,'M','low','["backend"]'::jsonb,'[]'::jsonb,'[]'::jsonb,'["out"]'::jsonb,
          'environment','verification','completed',1,1,'[{"e":1}]'::jsonb,'[{"e":1}]'::jsonb,'2026-07-20T11:00:00Z'),
        ('task-z','project-2','phase-2','objective-2','strategy-2','Task Z','desc',
          '["d"]'::jsonb,'["c"]'::jsonb,'M','low','["backend"]'::jsonb,'[]'::jsonb,'[]'::jsonb,'["out"]'::jsonb,
          'environment','verification','ready',1,1,'[]'::jsonb,'[]'::jsonb,NULL);
    `);
    attention = new AttentionService(new PGliteTransactionRunner(pg));
  });

  afterEach(async () => {
    await pg.close();
  });

  it("adds percent/eta/burn-rate fields to the phase-scoped execution read model", async () => {
    const result = await attention.phase("project-2", "phase-2");
    expect(result.phase).toMatchObject({
      completed_tasks: 2,
      total_tasks: 3,
      percent_complete: 67,
      tasks_completed: 2,
      tasks_total: 3,
      eta_at: "2026-07-20T12:00:00.000Z",
      burn_rate_usd_per_hour: null, // no succeeded agent_runs in this fixture
    });
  });
});

describe.sequential("PATCH /api/v2/projects/:id/settings (server)", () => {
  let pg: PGlite;
  let server: NornsServer;
  let token: string;

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
       ) VALUES ('project-1','Project One','Persistent project','active',
                 'assignment','verification','budget')`,
    );
    const transactions = new PGliteTransactionRunner(pg);
    const users = new UserStore();
    token = testAdminToken(users);
    server = await buildServer({
      stores: new RelayStores(),
      users,
      projects: new ProjectStore(),
      phase3: {
        sourceBindings: new SourceBindingService(transactions),
        ingestion: new RepositoryIngestionService(transactions),
        phases: new PhaseWorkflowService(transactions),
        strategies: new StrategyWorkflowService(transactions),
        bridge: new StrategyBridgeService({
          transactions,
          phases: new PhaseWorkflowService(transactions),
          strategies: new StrategyWorkflowService(transactions),
        }),
        resume: new ProjectResumeService(transactions),
      },
    });
  });

  afterEach(async () => {
    await server.app.close();
    await pg.close();
  });

  it("requires a session", async () => {
    const response = await server.app.inject({
      method: "PATCH",
      url: "/api/v2/projects/project-1/settings",
      payload: { update_interval_seconds: 900 },
    });
    expect(response.statusCode).toBe(401);
  });

  it("rejects a disallowed interval and enforces the floor", async () => {
    const headers = { authorization: `Bearer ${token}` };
    const tooLow = await server.app.inject({
      method: "PATCH",
      url: "/api/v2/projects/project-1/settings",
      headers,
      payload: { update_interval_seconds: 30 },
    });
    expect(tooLow.statusCode).toBe(400);

    const disallowed = await server.app.inject({
      method: "PATCH",
      url: "/api/v2/projects/project-1/settings",
      headers,
      payload: { update_interval_seconds: 120 },
    });
    expect(disallowed.statusCode).toBe(400);
  });

  it("persists a valid interval and reflects it on the resume payload", async () => {
    const headers = { authorization: `Bearer ${token}` };
    const patched = await server.app.inject({
      method: "PATCH",
      url: "/api/v2/projects/project-1/settings",
      headers,
      payload: { update_interval_seconds: 60 },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toEqual({ update_interval_seconds: 60 });

    const resumed = await server.app.inject({
      method: "GET",
      url: "/api/v2/projects/project-1/resume",
      headers,
    });
    expect(resumed.json()).toMatchObject({ update_interval_seconds: 60 });
  });

  it("404s for an unknown project", async () => {
    const headers = { authorization: `Bearer ${token}` };
    const response = await server.app.inject({
      method: "PATCH",
      url: "/api/v2/projects/does-not-exist/settings",
      headers,
      payload: { update_interval_seconds: 900 },
    });
    expect(response.statusCode).toBe(404);
  });
});
