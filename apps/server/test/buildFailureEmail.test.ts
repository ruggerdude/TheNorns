import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SendEmailInput } from "../src/email/resend.js";
import {
  BuildFailureEmailPreferences,
  BuildFailureEmailWorker,
} from "../src/notifications/buildFailureEmail.js";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";
import { type NornsServer, buildServer } from "../src/server.js";
import { RelayStores } from "../src/stores.js";
import { UserStore } from "../src/users/store.js";

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

async function seedProject(pg: PGlite, userId: string): Promise<void> {
  await pg.query(
    `INSERT INTO users (
       id,username,display_name,email,name,password_hash,password_hash_scheme,role,status
     ) VALUES ($1,'owner@example.com','Owner','owner@example.com','Owner','x','scrypt-v1','admin','active')`,
    [userId],
  );
  await pg.exec(`
    INSERT INTO projects (
      id,name,description,status,assignment_policy_ref,verification_policy_ref,
      budget_policy_ref,owner_user_id
    ) VALUES (
      'project-1','Project <One>','','active','assignment','verification','budget','${userId}'
    );
    INSERT INTO repository_bindings (
      id,project_id,binding_type,status,runner_id,workspace_id,repository_id,
      repository_display_name,granted_permissions,default_branch,observed_head,
      verification_policy_ref,repository_health,created_by_actor_type,created_by_actor_id
    ) VALUES (
      'binding-1','project-1','local_runner','connected','runner-1','workspace-1','repository-1',
      'Project One','{}'::jsonb,'main','commit-1','verification','healthy','human','${userId}'
    );
    UPDATE projects SET primary_repository_binding_id='binding-1' WHERE id='project-1';
    INSERT INTO phases (id,project_id,objective_summary,priority,status,approved_budget_usd)
    VALUES ('phase-1','project-1','Core & engine',1,'approved',20);
    INSERT INTO strategy_versions (
      id,project_id,phase_id,version,status,objective,content,convergence,review_rounds,content_hash
    ) VALUES (
      'strategy-1','project-1','phase-1',1,'approved','Core engine','{}'::jsonb,
      'converged',1,repeat('a',64)
    );
    UPDATE phases SET approved_strategy_version_id='strategy-1' WHERE id='phase-1';
    INSERT INTO objectives (id,project_id,phase_id,outcome,success_measures,status,"order")
    VALUES ('objective-1','project-1','phase-1','Ship','["green"]'::jsonb,'active',0);
    INSERT INTO tasks (
      id,project_id,phase_id,objective_id,strategy_version_id,title,description,
      deliverables,acceptance_criteria,complexity,risk,required_roles,required_capabilities,
      required_inputs,expected_outputs,environment_policy_ref,verification_policy_ref,
      state,lifecycle_version
    ) VALUES (
      'task-1','project-1','phase-1','objective-1','strategy-1','Build parser','Implement it',
      '["code"]'::jsonb,'["tests"]'::jsonb,'M','medium','["implementation"]'::jsonb,
      '[]'::jsonb,'[]'::jsonb,'["commit"]'::jsonb,'environment','verification','in_progress',1
    );
    INSERT INTO agent_profiles (
      id,provider,runtime,model,roles,capabilities,context_limit_tokens,
      security_restrictions,status,active_workload,cost_metadata
    ) VALUES (
      'agent-1','openai','codex','gpt-5','["implementation"]'::jsonb,'[]'::jsonb,
      200000,'[]'::jsonb,'available',0,'{}'::jsonb
    );
    INSERT INTO agent_assignments (
      id,project_id,phase_id,task_id,agent_profile_id,status,rationale,
      rationale_factors,allocation_policy_ref
    ) VALUES (
      'assignment-1','project-1','phase-1','task-1','agent-1','active','Best fit',
      '[]'::jsonb,'allocation'
    );
  `);
}

async function seedFailedRun(pg: PGlite): Promise<void> {
  await pg.exec(`
    INSERT INTO agent_runs (
      id,project_id,phase_id,task_id,assignment_id,attempt,state,is_designated,
      repository_binding_id,expected_revision,verification_status,failure_code,
      failure_detail,lifecycle_version,started_at,finished_at
    ) VALUES (
      'run-1','project-1','phase-1','task-1','assignment-1',3,'failed',true,
      'binding-1','commit-1','failed','verification_failed','build: <boom>',1,
      now() - interval '1 minute',now()
    );
    UPDATE tasks
       SET designated_assignment_id='assignment-1',designated_run_id='run-1'
     WHERE id='task-1';
  `);
}

describe.sequential("build failure email notifications", () => {
  let pg: PGlite;
  let transactions: PGliteTransactionRunner;

  beforeEach(async () => {
    pg = new PGlite();
    await migrate(pg);
    transactions = new PGliteTransactionRunner(pg);
  });

  afterEach(async () => {
    await pg.close();
  });

  it("sends each eligible failed attempt once with escaped failure context", async () => {
    await seedProject(pg, "owner-1");
    const preferences = new BuildFailureEmailPreferences(transactions, true);
    expect(await preferences.get("project-1", "owner-1")).toEqual({
      enabled: false,
      email: "owner@example.com",
      delivery_configured: true,
    });
    await preferences.set("project-1", "owner-1", true);
    await seedFailedRun(pg);

    const sent: SendEmailInput[] = [];
    const worker = new BuildFailureEmailWorker(transactions, {
      publicOrigin: "https://norns.example",
      send: async (message) => {
        sent.push(message);
      },
    });

    expect(await worker.tick()).toBe(1);
    expect(await worker.tick()).toBe(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      to: "owner@example.com",
      subject: "[The Norns] Build failed: Build parser",
    });
    expect(sent[0]?.html).toContain("Project &lt;One&gt;");
    expect(sent[0]?.html).toContain("Core &amp; engine");
    expect(sent[0]?.html).toContain("build: &lt;boom&gt;");
    expect(sent[0]?.html).toContain("https://norns.example/projects/project-1");

    const deliveries = await pg.query<{ status: string; attempt_count: number }>(
      "SELECT status,attempt_count FROM build_failure_email_deliveries",
    );
    expect(deliveries.rows).toEqual([{ status: "sent", attempt_count: 1 }]);
  });

  it("exposes the current user's project preference and refuses enablement without delivery", async () => {
    const users = new UserStore();
    const owner = users.createActive({
      email: "owner@example.com",
      name: "Owner",
      password: "owner-password",
      role: "admin",
    });
    const token = users.login("owner@example.com", "owner-password").token;
    await seedProject(pg, owner.id);

    const server = await buildServer({
      stores: new RelayStores(),
      users,
      execution: { transactions },
      runnerInference: { transactions },
      buildFailureEmail: { configured: false, send: vi.fn() },
    });
    try {
      const headers = { authorization: `Bearer ${token}` };
      const current = await server.app.inject({
        method: "GET",
        url: "/api/v2/projects/project-1/build-failure-email",
        headers,
      });
      expect(current.statusCode).toBe(200);
      expect(current.json()).toEqual({
        enabled: false,
        email: "owner@example.com",
        delivery_configured: false,
      });

      const enabled = await server.app.inject({
        method: "PATCH",
        url: "/api/v2/projects/project-1/build-failure-email",
        headers,
        payload: { enabled: true },
      });
      expect(enabled.statusCode).toBe(409);
      expect(enabled.json()).toMatchObject({ error: "email_not_configured" });
    } finally {
      await server.app.close();
    }
  });
});
