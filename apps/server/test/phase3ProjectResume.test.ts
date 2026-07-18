import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";
import { PhaseWorkflowService } from "../src/projects/phaseWorkflowService.js";
import { ProjectResumeService } from "../src/projects/projectResumeService.js";
import { RepositoryIngestionService } from "../src/projects/repositoryIngestionService.js";
import { SourceBindingService } from "../src/projects/sourceBindingService.js";

describe.sequential("Phase 3 Project Resume", () => {
  let pg: PGlite;
  let transactions: PGliteTransactionRunner;

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
       ) VALUES ('project-1','Project One','Persistent project','initializing',
                 'assignment','verification','budget')`,
    );
    transactions = new PGliteTransactionRunner(pg);
  });

  afterEach(async () => {
    await pg.close();
  });

  it("opens an existing project with current architecture, phases, attention, and next action", async () => {
    const resume = new ProjectResumeService(transactions);
    expect((await resume.open("project-1")).next_recommended_action).toBe(
      "Connect a project repository",
    );

    const binding = await new SourceBindingService(transactions).createLocal({
      project_id: "project-1",
      runner_id: "runner-1",
      workspace_id: "workspace-1",
      repository_id: "repository-1",
      repository_display_name: "Project One",
      default_branch: "main",
      observed_head: "commit-1",
      verification_policy_ref: "verification",
      created_by: { actor_type: "human", actor_id: "admin-1" },
    });
    await new RepositoryIngestionService(transactions).ingest({
      project_id: "project-1",
      repository_binding_id: binding.id,
      repository_revision: "commit-1",
      architecture: {
        title: "Architecture",
        summary: "Persistent project architecture",
        artifact: {
          storage_ref: "artifact://architecture",
          content_hash: "a".repeat(64),
          byte_size: 10,
          media_type: "text/markdown",
        },
      },
      repository_facts: [{ key: "language", value: "TypeScript", confidence: 1 }],
      constraints: [],
      directives: [],
      assignment_policy_ref: "assignment",
      verification_policy_ref: "verification",
      budget_policy_ref: "budget",
      created_by: { actor_type: "human", actor_id: "admin-1" },
    });
    await new PhaseWorkflowService(transactions).create({
      schema_version: 2,
      command_id: "create-phase-1",
      kind: "create_phase",
      command_family: "phase",
      actor: { actor_type: "human", actor_id: "admin-1" },
      idempotency_key: "phase-1",
      correlation_id: "correlation-1",
      causation_id: null,
      issued_at: "2026-07-16T19:20:00.000Z",
      project_id: "project-1",
      objective_summary: "Add animations",
      priority: 5,
      predecessor_phase_ids: [],
      expected_project_version: 2,
    });

    const result = await resume.open("project-1");
    expect(result).toMatchObject({
      project: { id: "project-1", status: "active" },
      architecture: { revision: 1, repository_revision: "commit-1" },
      attention: { open_decisions: 0, active_runs: 0, blocked_tasks: 0 },
      active_memory_entries: 2,
      next_recommended_action: "Generate a strategy for the proposed phase",
    });
    expect(result.repositories).toHaveLength(1);
    expect(result.phases).toEqual([
      expect.objectContaining({
        objective_summary: "Add animations",
        status: "proposed",
        objectives: 0,
        tasks: 0,
      }),
    ]);
  });

  it("redacts a legacy local path from the project resume response", async () => {
    await pg.exec(
      `INSERT INTO repository_bindings (
         id, project_id, binding_type, status, runner_id, workspace_id,
         repository_id, repository_display_name, granted_permissions,
         default_branch, observed_head, verification_policy_ref,
         repository_health, created_by_actor_type, created_by_actor_id
       ) VALUES (
         'legacy-local-binding','project-1','local_runner','connected','runner-1',
         'legacy-workspace','legacy-repository','C:\\Users\\operator\\private',
         '{}'::jsonb,'main','commit-1','verification','healthy','system','legacy-import'
       );
       UPDATE projects SET primary_repository_binding_id='legacy-local-binding'
       WHERE id='project-1'`,
    );

    const result = await new ProjectResumeService(transactions).open("project-1");
    expect(result.repositories[0]?.display_name).toBe("Local repository");
    expect(JSON.stringify(result)).not.toContain("operator");
  });
});
