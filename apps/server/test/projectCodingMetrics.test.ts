import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";
import { ProjectCodingMetricsService } from "../src/phase6/projectCodingMetrics.js";

async function migrate(pg: PGlite): Promise<void> {
  await pg.exec(`
    CREATE ROLE norns_app NOLOGIN;
    CREATE TABLE norns_state (
      key TEXT PRIMARY KEY,
      snapshot JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await runCurrentV2Migrations(pg as unknown as V2MigrationDatabase);
}

async function seedProject(pg: PGlite): Promise<void> {
  await pg.exec(`
    INSERT INTO users (
      id,username,display_name,email,name,password_hash,password_hash_scheme,role,status
    ) VALUES (
      'metrics-owner','metrics@example.com','Metrics Owner','metrics@example.com',
      'Metrics Owner','x','scrypt-v1','admin','active'
    );
    INSERT INTO projects (
      id,name,status,assignment_policy_ref,verification_policy_ref,budget_policy_ref,
      owner_user_id
    ) VALUES (
      'metrics-project','Metrics project','active','assignment','verification','budget',
      'metrics-owner'
    );
    INSERT INTO repository_bindings (
      id,project_id,binding_type,status,runner_id,workspace_id,repository_id,
      repository_display_name,granted_permissions,default_branch,observed_head,
      verification_policy_ref,repository_health,created_by_actor_type,created_by_actor_id
    ) VALUES (
      'metrics-binding','metrics-project','local_runner','connected','runner-1','workspace-1',
      'repository-1','Metrics repository','{}'::jsonb,'main',repeat('a',40),
      'verification','healthy','human','metrics-owner'
    );
    UPDATE projects
       SET primary_repository_binding_id='metrics-binding'
     WHERE id='metrics-project';
    INSERT INTO phases (
      id,project_id,objective_summary,priority,status,approved_budget_usd
    ) VALUES (
      'metrics-phase','metrics-project','Core engine',1,'approved',20
    );
    INSERT INTO strategy_versions (
      id,project_id,phase_id,version,status,objective,content,convergence,
      review_rounds,content_hash
    ) VALUES (
      'metrics-strategy','metrics-project','metrics-phase',1,'approved','Ship metrics',
      '{}'::jsonb,'converged',1,repeat('b',64)
    );
    UPDATE phases
       SET approved_strategy_version_id='metrics-strategy'
     WHERE id='metrics-phase';
    INSERT INTO objectives (
      id,project_id,phase_id,outcome,success_measures,status,"order"
    ) VALUES (
      'metrics-objective','metrics-project','metrics-phase','Ship',
      '["green"]'::jsonb,'active',0
    );
    INSERT INTO tasks (
      id,project_id,phase_id,objective_id,strategy_version_id,title,description,
      deliverables,acceptance_criteria,complexity,risk,required_roles,
      required_capabilities,required_inputs,expected_outputs,environment_policy_ref,
      verification_policy_ref,state,lifecycle_version
    ) VALUES
      (
        'metrics-task-retried','metrics-project','metrics-phase','metrics-objective',
        'metrics-strategy','Build parser','Implement the parser','["code"]'::jsonb,
        '["tests"]'::jsonb,'M','medium','["implementation"]'::jsonb,'[]'::jsonb,
        '[]'::jsonb,'["commit"]'::jsonb,'environment','verification','in_progress',1
      ),
      (
        'metrics-task-first-pass','metrics-project','metrics-phase','metrics-objective',
        'metrics-strategy','Build formatter','Implement the formatter','["code"]'::jsonb,
        '["tests"]'::jsonb,'S','low','["implementation"]'::jsonb,'[]'::jsonb,
        '[]'::jsonb,'["commit"]'::jsonb,'environment','verification','in_progress',1
      );
    INSERT INTO agent_profiles (
      id,provider,runtime,model,roles,capabilities,context_limit_tokens,
      security_restrictions,status,active_workload,cost_metadata
    ) VALUES
      (
        'metrics-agent-sol','openai','codex','gpt-5.6-sol',
        '["implementation"]'::jsonb,'[]'::jsonb,200000,'[]'::jsonb,
        'available',0,'{}'::jsonb
      ),
      (
        'metrics-agent-sonnet','anthropic','claude-code','claude-sonnet-5',
        '["implementation"]'::jsonb,'[]'::jsonb,200000,'[]'::jsonb,
        'available',0,'{}'::jsonb
      );
    INSERT INTO agent_assignments (
      id,project_id,phase_id,task_id,agent_profile_id,status,rationale,
      rationale_factors,allocation_policy_ref
    ) VALUES
      (
        'metrics-assignment-retried','metrics-project','metrics-phase',
        'metrics-task-retried','metrics-agent-sol','active','Best fit','[]'::jsonb,'allocation'
      ),
      (
        'metrics-assignment-first-pass','metrics-project','metrics-phase',
        'metrics-task-first-pass','metrics-agent-sonnet','active','Best fit',
        '[]'::jsonb,'allocation'
      );
    INSERT INTO agent_runs (
      id,project_id,phase_id,task_id,assignment_id,attempt,state,is_designated,
      repository_binding_id,expected_revision,verification_status,
      usage_input_tokens,usage_output_tokens,usage_cost_usd,lifecycle_version,
      started_at,finished_at
    ) VALUES
      (
        'metrics-run-retried-1','metrics-project','metrics-phase','metrics-task-retried',
        'metrics-assignment-retried',1,'failed',false,'metrics-binding',repeat('a',40),
        'failed',100,20,1,1,'2026-08-19T10:00:00Z','2026-08-19T10:10:00Z'
      ),
      (
        'metrics-run-retried-2','metrics-project','metrics-phase','metrics-task-retried',
        'metrics-assignment-retried',2,'succeeded',true,'metrics-binding',repeat('a',40),
        'passed',200,40,2,1,'2026-08-19T11:30:00Z','2026-08-19T12:00:00Z'
      ),
      (
        'metrics-run-first-pass-1','metrics-project','metrics-phase',
        'metrics-task-first-pass','metrics-assignment-first-pass',1,'succeeded',true,
        'metrics-binding',repeat('a',40),'passed',80,20,0.5,1,
        '2026-08-19T11:00:00Z','2026-08-19T11:15:00Z'
      );
    UPDATE tasks
       SET state='completed',completed_at='2026-08-19T12:00:00Z',
           review_evidence='[{"label":"review"}]'::jsonb,
           completion_evidence='[{"label":"commit"}]'::jsonb,
           designated_assignment_id='metrics-assignment-retried',
           designated_run_id='metrics-run-retried-2'
     WHERE id='metrics-task-retried';
    UPDATE tasks
       SET state='completed',completed_at='2026-08-19T11:30:00Z',
           review_evidence='[{"label":"review"}]'::jsonb,
           completion_evidence='[{"label":"commit"}]'::jsonb,
           designated_assignment_id='metrics-assignment-first-pass',
           designated_run_id='metrics-run-first-pass-1'
     WHERE id='metrics-task-first-pass';
    INSERT INTO ai_usage_events (
      id,request_id,sequence,event_type,status,occurred_at,provider,model,
      endpoint,request_type,retry_attempt,initiated_by_user_id,project_id,phase_id,
      task_id,run_id,usage_source,confidence,cost_classification
    ) VALUES (
      'metrics-usage-start','metrics-request',1,'request_started','started',
      '2026-08-19T12:00:00Z','openai','gpt-5.6-sol','responses','coding',0,
      'metrics-owner','metrics-project','metrics-phase','metrics-task-retried',
      'metrics-run-retried-2','provider_api',1,'unavailable'
    );
    INSERT INTO ai_usage_events (
      id,request_id,sequence,event_type,status,occurred_at,provider,model,
      endpoint,request_type,retry_attempt,initiated_by_user_id,project_id,phase_id,
      task_id,run_id,usage_source,confidence,input_tokens,output_tokens,
      cache_read_tokens,cache_write_tokens,cost_classification
    ) VALUES (
      'metrics-usage','metrics-request',2,'usage_observed','in_progress',
      '2026-08-19T12:00:01Z','openai','gpt-5.6-sol','responses','coding',0,
      'metrics-owner','metrics-project','metrics-phase','metrics-task-retried',
      'metrics-run-retried-2','provider_api',1,200,40,50,10,'unavailable'
    );
    SET session_replication_role='replica';
    INSERT INTO project_delivery_records (
      id,project_id,phase_id,task_id,run_id,repository_binding_id,environment,
      service,commit_sha,provider_id,provider_deployment_id,status,
      current_observation_sequence,started_at,completed_at
    ) VALUES (
      'metrics-deployment-failed','metrics-project','metrics-phase','metrics-task-retried',
      'metrics-run-retried-2','metrics-binding','production','metrics-service',repeat('c',40),
      'provider','provider-deployment-1','failed',1,
      '2026-08-19T12:01:00Z','2026-08-19T12:02:00Z'
    );
    SET session_replication_role='origin';
  `);
}

describe.sequential("project coding metrics", () => {
  let pg: PGlite;

  beforeEach(async () => {
    pg = new PGlite();
    await migrate(pg);
    await seedProject(pg);
  }, 30_000);

  afterEach(async () => {
    await pg.close();
  });

  it("calculates outcome-normalized speed, efficiency, quality, and drill-downs", async () => {
    const service = new ProjectCodingMetricsService(
      new PGliteTransactionRunner(pg),
      () => new Date("2026-08-20T12:00:00Z"),
    );

    const metrics = await service.read("metrics-project");

    expect(metrics).toMatchObject({
      project_id: "metrics-project",
      total_tasks: 2,
      completed_tasks: 2,
      completed_tasks_last_30_days: 2,
      terminal_runs: 3,
      active_coding_seconds: 3_300,
      time_to_verified_delivery: {
        sample_size: 2,
        median_seconds: 4_500,
        p75_seconds: 5_850,
      },
      first_pass_yield: { completed_tasks: 2, first_pass_tasks: 1, rate: 0.5 },
      tokens_per_accepted_task: {
        input_tokens: 380,
        output_tokens: 80,
        cache_read_tokens: 50,
        cache_write_tokens: 10,
        total_tokens: 460,
        per_accepted_task: 230,
      },
      cost_per_accepted_task: {
        priced_runs: 3,
        total_runs: 3,
        coverage_rate: 1,
        total_cost_usd: 3.5,
        per_accepted_task_usd: 1.75,
      },
      rework_ratio: { total_tokens: 460, rework_tokens: 240, rate: 240 / 460 },
      change_failure_rate: { terminal_deployments: 1, failed_deployments: 1, rate: 1 },
    });
    expect(metrics.phase_breakdown).toEqual([
      expect.objectContaining({
        phase_name: "Core engine",
        completed_tasks: 2,
        first_pass_yield: 0.5,
        total_tokens: 460,
      }),
    ]);
    expect(metrics.agent_breakdown).toEqual([
      expect.objectContaining({ provider: "openai", model: "gpt-5.6-sol", run_count: 2 }),
      expect.objectContaining({
        provider: "anthropic",
        model: "claude-sonnet-5",
        run_count: 1,
      }),
    ]);
    expect(metrics.task_breakdown).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          task_id: "metrics-task-retried",
          attempt_count: 2,
          delivery_seconds: 7_200,
          verification_passed: true,
        }),
      ]),
    );
  });
});
