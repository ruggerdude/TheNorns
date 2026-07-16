import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";
import { PhaseWorkflowService } from "../src/projects/phaseWorkflowService.js";
import { ProjectResumeService } from "../src/projects/projectResumeService.js";
import { RepositoryIngestionService } from "../src/projects/repositoryIngestionService.js";
import { SourceBindingService } from "../src/projects/sourceBindingService.js";
import { ProjectStore } from "../src/projects/store.js";
import { StrategyWorkflowService } from "../src/projects/strategyWorkflowService.js";
import { type NornsServer, buildServer } from "../src/server.js";
import { RelayStores } from "../src/stores.js";
import { UserStore } from "../src/users/store.js";
import { testAdminToken } from "./helpers.js";

describe.sequential("Phase 3 authenticated API", () => {
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
        resume: new ProjectResumeService(transactions),
      },
    });
  });

  afterEach(async () => {
    await server.app.close();
    await pg.close();
  });

  it("requires a session and exposes Resume, binding, and phase creation", async () => {
    expect(
      (await server.app.inject({ method: "GET", url: "/api/v2/projects/project-1/resume" }))
        .statusCode,
    ).toBe(401);
    const headers = { authorization: `Bearer ${token}` };
    const binding = await server.app.inject({
      method: "POST",
      url: "/api/v2/projects/project-1/source-bindings/local",
      headers,
      payload: {
        runner_id: "runner-1",
        workspace_id: "workspace-1",
        repository_id: "repository-1",
        repository_display_name: "Project One",
        default_branch: "main",
        observed_head: "commit-1",
        verification_policy_ref: "verification",
      },
    });
    expect(binding.statusCode).toBe(201);
    const phase = await server.app.inject({
      method: "POST",
      url: "/api/v2/projects/project-1/phases",
      headers,
      payload: {
        objective_summary: "Add animations",
        priority: 5,
        predecessor_phase_ids: [],
        expected_project_version: 1,
        idempotency_key: "add-animations",
      },
    });
    expect(phase.statusCode).toBe(201);
    const resume = await server.app.inject({
      method: "GET",
      url: "/api/v2/projects/project-1/resume",
      headers,
    });
    expect(resume.statusCode).toBe(200);
    expect(resume.json()).toMatchObject({
      project: { id: "project-1" },
      repositories: [expect.objectContaining({ binding_type: "local_runner" })],
      phases: [expect.objectContaining({ objective_summary: "Add animations" })],
    });
  });
});
