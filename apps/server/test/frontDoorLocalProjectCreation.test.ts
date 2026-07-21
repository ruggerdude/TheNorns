// FRONT DOOR P2b (D2): folder-first local project creation. Before this
// change, POST /api/projects structurally rejected any {source_type: "local"}
// body — a runner-verified selection token was the only accepted path. D2
// requires accepting a raw local path with no runner online: the project is
// created immediately with an unverified repository-binding candidate;
// planning/staffing/approval work unverified; only execution dispatch (see
// phase4Coordinator.test.ts) requires a later-verified binding.
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";
import { PhaseWorkflowService } from "../src/projects/phaseWorkflowService.js";
import { ProjectResumeService } from "../src/projects/projectResumeService.js";
import { RelationalProjectReadRepository } from "../src/projects/relationalReadRepository.js";
import { RepositoryIngestionService } from "../src/projects/repositoryIngestionService.js";
import { SourceBindingService } from "../src/projects/sourceBindingService.js";
import { StrategyBridgeService } from "../src/projects/strategyBridgeService.js";
import { StrategyWorkflowService } from "../src/projects/strategyWorkflowService.js";
import { type NornsServer, buildServer } from "../src/server.js";
import { RelayStores } from "../src/stores.js";
import { UserStore } from "../src/users/store.js";
import { testAdminToken } from "./helpers.js";

interface InjectedResponse {
  statusCode: number;
  json: () => unknown;
  body: string;
}

async function inject(
  server: NornsServer,
  method: "GET" | "POST",
  url: string,
  token?: string,
  body?: unknown,
): Promise<InjectedResponse> {
  const response = await server.app.inject({
    method,
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
  });
  return response as unknown as InjectedResponse;
}

describe.sequential("FRONT DOOR P2b: folder-first local project creation", () => {
  let pg: PGlite;
  let server: NornsServer;
  let transactions: PGliteTransactionRunner;
  let sourceBindings: SourceBindingService;
  let token: string;

  const RAW_LOCAL_PATH = "/Users/operator/code/my-secret-startup/apps/web";

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
    transactions = new PGliteTransactionRunner(pg);
    sourceBindings = new SourceBindingService(transactions);
    const users = new UserStore();
    token = testAdminToken(users);
    server = await buildServer({
      stores: new RelayStores(),
      users,
      projects: new RelationalProjectReadRepository(transactions, "local-creation-test"),
      phase3: {
        sourceBindings,
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
      planningRuns: { transactions },
    });
  });

  afterEach(async () => {
    await server?.app.close();
    if (!pg.closed) await pg.close();
  });

  async function createLocalProject(): Promise<{ id: string }> {
    const created = await inject(server, "POST", "/api/projects", token, {
      name: "Unverified local project",
      description: "No runner required at creation",
      pm_provider: "anthropic",
      source_type: "local",
      source_location: RAW_LOCAL_PATH,
    });
    expect(created.statusCode).toBe(201);
    return created.json() as { id: string };
  }

  it("accepts a raw local path with no runner online and never echoes it back", async () => {
    const created = await inject(server, "POST", "/api/projects", token, {
      name: "Unverified local project",
      description: "No runner required at creation",
      pm_provider: "anthropic",
      source_type: "local",
      source_location: RAW_LOCAL_PATH,
    });
    expect(created.statusCode).toBe(201);
    expect(created.body).not.toContain(RAW_LOCAL_PATH);
    const project = created.json() as Record<string, unknown>;
    // ProjectSummary.source_location only ever reflects a runner-verified
    // (connected) binding's display name — an unverified candidate has none
    // yet, matching pre-existing behavior for a project with no repository
    // binding at all. The unverified candidate itself (with its sanitized
    // last-path-segment display name) is visible via Resume; see the next
    // test.
    expect(project).toMatchObject({ source_type: "local", source_location: null });
  });

  it("still rejects source_type=local with no path, and a path with no source_type", async () => {
    const noPath = await inject(server, "POST", "/api/projects", token, {
      name: "x",
      description: "y",
      pm_provider: "anthropic",
      source_type: "local",
    });
    expect(noPath.statusCode).toBe(400);

    const noType = await inject(server, "POST", "/api/projects", token, {
      name: "x",
      description: "y",
      pm_provider: "anthropic",
      source_location: RAW_LOCAL_PATH,
    });
    expect(noType.statusCode).toBe(400);
  });

  it("stores the binding as an unverified candidate, visible (but not leaked) via Resume", async () => {
    const project = await createLocalProject();

    const candidate = await pg.query<{ status: string; source_type: string }>(
      "SELECT status, source_type FROM repository_binding_candidates WHERE project_id = $1",
      [project.id],
    );
    expect(candidate.rows).toEqual([{ status: "unverified", source_type: "local" }]);

    const resume = await inject(server, "GET", `/api/v2/projects/${project.id}/resume`, token);
    expect(resume.statusCode).toBe(200);
    expect(resume.body).not.toContain(RAW_LOCAL_PATH);
    expect(resume.json()).toMatchObject({
      project: { id: project.id },
      repositories: [
        {
          binding_type: "local_runner",
          display_name: "web",
          status: "unverified_candidate",
          health: "unknown",
        },
      ],
    });
  });

  it("lets planning start before any runner has verified the binding", async () => {
    const project = await createLocalProject();
    const planningRun = await inject(
      server,
      "POST",
      `/api/v2/projects/${project.id}/planning-runs`,
      token,
      { objective: "Ship the first vertical slice" },
    );
    expect(planningRun.statusCode).toBe(202);
    const body = planningRun.json() as { planning_run_id: string };
    expect(typeof body.planning_run_id).toBe("string");
  });

  it("connects unverified -> verified through the existing runner-verification " +
    "flow, at the service level, and closes out the candidate", async () => {
    const project = await createLocalProject();

    const before = await pg.query<{ status: string }>(
      "SELECT status FROM repository_binding_candidates WHERE project_id = $1",
      [project.id],
    );
    expect(before.rows).toEqual([{ status: "unverified" }]);

    // This is the existing, already-shipped verification flow (D2: "when a
    // paired runner later reports the workspace, existing verification
    // flows mark it verified") — no new runner protocol is exercised here,
    // only the state transition it produces.
    await sourceBindings.createLocal({
      project_id: project.id,
      runner_id: "runner-1",
      workspace_id: "workspace-1",
      repository_id: "repository-1",
      repository_display_name: "my-secret-startup",
      default_branch: "main",
      observed_head: "commit-1",
      verification_policy_ref: "verification-policy:default-v1",
      created_by: { actor_type: "human", actor_id: "admin-1" },
    });

    const after = await pg.query<{ status: string }>(
      "SELECT status FROM repository_binding_candidates WHERE project_id = $1",
      [project.id],
    );
    expect(after.rows).toEqual([{ status: "promoted" }]);

    const binding = await pg.query<{ status: string; binding_type: string }>(
      "SELECT status, binding_type FROM repository_bindings WHERE project_id = $1",
      [project.id],
    );
    expect(binding.rows).toEqual([{ status: "connected", binding_type: "local_runner" }]);

    const projectRow = await pg.query<{ primary_repository_binding_id: string | null }>(
      "SELECT primary_repository_binding_id FROM projects WHERE id = $1",
      [project.id],
    );
    expect(projectRow.rows[0]?.primary_repository_binding_id).not.toBeNull();

    // Resume now shows exactly one (connected) repository entry — the
    // promoted candidate no longer surfaces as a second, stale one.
    const resume = await inject(server, "GET", `/api/v2/projects/${project.id}/resume`, token);
    expect(resume.json()).toMatchObject({
      repositories: [
        {
          binding_type: "local_runner",
          display_name: "my-secret-startup",
          status: "connected",
          health: "healthy",
        },
      ],
    });
  });
});
