import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { isPmModelForProvider } from "@norns/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubIntegrationService } from "../src/integrations/github.js";
import {
  LegacyProjectSnapshot,
  type LegacyProjectSnapshotT,
  parseLegacyProjectPayloads,
} from "../src/persistence/migration/legacyProjectSchemas.js";
import { buildLegacyProjectImportPlan } from "../src/persistence/migration/projectImportPlan.js";
import { importLegacyProject } from "../src/persistence/migration/projectImportService.js";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";
import { PhaseWorkflowService } from "../src/projects/phaseWorkflowService.js";
import { ProjectResumeService } from "../src/projects/projectResumeService.js";
import { RepositoryIngestionService } from "../src/projects/repositoryIngestionService.js";
import { SourceBindingService } from "../src/projects/sourceBindingService.js";
import { ProjectStore, type ProjectStoreSnapshot } from "../src/projects/store.js";
import { StrategyBridgeService } from "../src/projects/strategyBridgeService.js";
import { StrategyWorkflowService } from "../src/projects/strategyWorkflowService.js";
import { type NornsServer, buildServer } from "../src/server.js";
import { createProjectRuntime, loadDurableProjectRoutes } from "../src/startup/projectRuntime.js";
import { RelayStores } from "../src/stores.js";
import { UserStore } from "../src/users/store.js";
import { testAdminToken } from "./helpers.js";

const RUN_ID = "migration-project-runtime";
const MANIFEST_HASH = "a".repeat(64);
const FROZEN_AT = "2026-07-16T16:00:00.000Z";

function fixture(name: string): LegacyProjectSnapshotT {
  return LegacyProjectSnapshot.parse(
    JSON.parse(
      readFileSync(new URL(`./fixtures/phase2/projects/${name}.json`, import.meta.url), "utf8"),
    ),
  );
}

function legacyStore(sources: readonly LegacyProjectSnapshotT[]): ProjectStore {
  const snapshot: ProjectStoreSnapshot = {
    projects: sources.map((source) => {
      const parsed = parseLegacyProjectPayloads(source);
      if (!parsed.plan_valid || !parsed.graph_valid || !parsed.approval_valid) {
        throw new Error("runtime test requires restorable legacy projects");
      }
      const pmModel = source.pmModel ?? null;
      if (pmModel !== null && !isPmModelForProvider(source.pmProvider, pmModel)) {
        throw new Error("runtime test fixture has an invalid PM model");
      }
      return {
        id: source.id,
        name: source.name,
        description: source.description,
        pmProvider: source.pmProvider,
        pmModel,
        sourceType: source.sourceType ?? null,
        sourceLocation: source.sourceLocation ?? null,
        createdAt: source.createdAt,
        plan: parsed.plan,
        graph: parsed.graph,
        approval: parsed.approval,
      };
    }),
  };
  const store = new ProjectStore();
  store.restoreFrom(snapshot);
  return store;
}

describe.sequential("Phase 2 project runtime routing", () => {
  let pg: PGlite;
  let transactions: PGliteTransactionRunner;
  let server: NornsServer | null;
  let users: UserStore;
  let token: string;

  beforeEach(async () => {
    pg = new PGlite();
    await pg.exec(
      `CREATE TABLE norns_state (
         key TEXT PRIMARY KEY,
         snapshot JSONB NOT NULL,
         updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
       );
       CREATE ROLE norns_app NOLOGIN;`,
    );
    await runCurrentV2Migrations(pg as unknown as V2MigrationDatabase);
    await pg.query(
      `INSERT INTO migration_runs (
         id, migration_name, source_snapshot_hashes, source_counts,
         source_frozen_at, source_manifest_hash, source_application_version,
         source_application_commit, status, started_at
       ) VALUES ($1,'phase2-project-runtime','{}'::jsonb,'{}'::jsonb,$2,$3,'0.1.0','test','shadowing',$2)`,
      [RUN_ID, FROZEN_AT, MANIFEST_HASH],
    );
    await pg.query(
      `INSERT INTO archive_encryption_key_registry (key_id, key_fingerprint)
       VALUES ('test-key', $1)`,
      ["9".repeat(64)],
    );
    await pg.query(
      `INSERT INTO legacy_snapshot_archives (
         id, migration_run_id, source_key, source_updated_at, storage_ref,
         key_id, key_fingerprint, cipher, exact_hash, canonical_hash, ciphertext_hash, aad_hash,
         manifest_hash, exact_byte_size, canonical_byte_size, object_counts,
         last_record, nonce, auth_tag, ciphertext, status, captured_at,
         retention_until, verified_at
       ) VALUES (
         'archive-project-runtime',$1,'projects',$2,'postgres://archive/projects','test-key',
         $5,'aes-256-gcm',$3,$3,$3,$3,$4,1,1,'{}'::jsonb,NULL,
         decode('00','hex'),decode('00','hex'),decode('00','hex'),
         'verified',$2,'2026-08-16T16:00:00.000Z',$2
       )`,
      [RUN_ID, FROZEN_AT, "b".repeat(64), MANIFEST_HASH, "9".repeat(64)],
    );
    transactions = new PGliteTransactionRunner(pg);
    server = null;
    users = new UserStore();
    token = testAdminToken(users);
  });

  afterEach(async () => {
    await server?.app.close();
    await pg.close();
  });

  async function importSource(source: LegacyProjectSnapshotT): Promise<void> {
    await importLegacyProject({
      transaction_runner: transactions,
      migration_run_id: RUN_ID,
      source_manifest_hash: MANIFEST_HASH,
      occurred_at: FROZEN_AT,
      plan: buildLegacyProjectImportPlan(source, { source_frozen_at: FROZEN_AT }),
    });
  }

  async function setRoute(
    scopeType: "project" | "new_projects",
    scopeKey: string,
    readMode: "legacy" | "shadow" | "relational",
    writeMode: "legacy" | "relational" = "legacy",
  ): Promise<void> {
    await pg.query(
      `INSERT INTO persistence_routes (
         scope_type, scope_key, read_mode, write_mode, migration_run_id,
         aggregate_version, changed_by_actor_type, changed_by_actor_id,
         changed_at, v2_writes_started_at, rollback_window_until
       ) VALUES ($1,$2,$3,$4,$5,1,'system',NULL,$6,
                 CASE WHEN $4='relational' THEN $6::timestamptz ELSE NULL END,NULL)
       ON CONFLICT (scope_type, scope_key) DO UPDATE
       SET read_mode = EXCLUDED.read_mode,
           write_mode = EXCLUDED.write_mode,
           aggregate_version = persistence_routes.aggregate_version + 1,
           changed_at = EXCLUDED.changed_at,
           v2_writes_started_at = COALESCE(
             persistence_routes.v2_writes_started_at,
             EXCLUDED.v2_writes_started_at
           )`,
      [scopeType, scopeKey, readMode, writeMode, RUN_ID, "2026-07-16T18:00:00.000Z"],
    );
  }

  async function bindProjectsSnapshotEvidence(store: ProjectStore): Promise<void> {
    await pg.query(
      `INSERT INTO norns_state (key, snapshot, updated_at)
       VALUES ('projects',$1::jsonb,$2)
       ON CONFLICT (key) DO UPDATE
       SET snapshot = EXCLUDED.snapshot, updated_at = EXCLUDED.updated_at`,
      [JSON.stringify(store.snapshot()), FROZEN_AT],
    );
    const canonical = await pg.query<{ snapshot_text: string }>(
      "SELECT snapshot::text AS snapshot_text FROM norns_state WHERE key = 'projects'",
    );
    const snapshotText = canonical.rows[0]?.snapshot_text;
    if (!snapshotText) throw new Error("projects snapshot was not persisted");
    const exactHash = createHash("sha256").update(snapshotText).digest("hex");
    await pg.query(
      `UPDATE migration_runs
       SET details = details || jsonb_build_object(
         'replay_source_exact_hashes', jsonb_build_object('projects', $2::text)
       )
       WHERE id = $1`,
      [RUN_ID, exactHash],
    );
  }

  async function start(
    store: ProjectStore,
    github?: GitHubIntegrationService,
  ): Promise<NornsServer> {
    const routes = await loadDurableProjectRoutes(pg);
    const runtime = createProjectRuntime({
      projects: store,
      routes,
      transactions,
      now: () => "2026-07-16T18:30:00.000Z",
    });
    server = await buildServer({
      stores: new RelayStores(),
      users,
      projects: runtime.repository,
      ...(github ? { integrations: { github } } : {}),
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
    return server;
  }

  async function request(
    target: NornsServer,
    method: "GET" | "POST",
    url: string,
    payload?: Record<string, unknown>,
  ) {
    return target.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload === undefined ? {} : { payload }),
    });
  }

  it("freezes route selection until restart, records shadow mismatch, and keeps writes legacy", async () => {
    const source = fixture("clean-planned");
    source.sourceType = "local";
    source.sourceLocation = "/Users/operator/private/runtime-project";
    await importSource(source);
    const store = legacyStore([source]);
    await bindProjectsSnapshotEvidence(store);
    await setRoute("project", source.id, "shadow");

    const first = await start(store);
    const shadowRead = await request(first, "GET", `/api/projects/${source.id}`);
    expect(shadowRead.statusCode).toBe(200);
    expect(shadowRead.json()).toMatchObject({ source_location: "Local repository" });
    expect(shadowRead.body).not.toContain(source.sourceLocation);
    const evidence = await pg.query<{ matched: boolean; differences: string[] }>(
      `SELECT matched, differences
       FROM shadow_read_comparisons
       WHERE scope_type = 'project' AND scope_key = $1 AND operation = 'summary'`,
      [source.id],
    );
    expect(evidence.rows).toEqual([{ matched: false, differences: ["/source_location"] }]);
    expect(JSON.stringify(evidence.rows)).not.toContain("runtime-project");

    await setRoute("project", source.id, "relational");
    // The running process retains its startup-frozen shadow route.
    expect((await request(first, "GET", `/api/projects/${source.id}`)).json()).toMatchObject({
      source_location: "Local repository",
    });
    await first.app.close();
    server = null;

    const restarted = await start(store);
    expect((await request(restarted, "GET", `/api/projects/${source.id}`)).json()).toMatchObject({
      source_location: null,
    });

    const mutation = await request(restarted, "POST", `/api/projects/${source.id}/graph/nodes`, {
      id: "legacy-write",
      title: "Legacy write remains available",
    });
    expect(mutation.statusCode).toBe(200);
    expect(store.session(source.id).graph.node("legacy-write")?.title).toBe(
      "Legacy write remains available",
    );
  });

  it("serves relational portfolio reads in deterministic order when timestamps tie", async () => {
    const clean = fixture("clean-planned");
    const graphOnly = fixture("graph-only-node");
    expect(clean.createdAt).toBe(graphOnly.createdAt);
    await importSource(clean);
    await importSource(graphOnly);
    const store = legacyStore([clean, graphOnly]);
    await bindProjectsSnapshotEvidence(store);
    await setRoute("new_projects", "*", "shadow");
    const shadowing = await start(store);

    const expected = [graphOnly.id, clean.id];
    expect(
      ((await request(shadowing, "GET", "/api/projects")).json() as { id: string }[]).map(
        (project) => project.id,
      ),
    ).toEqual(expected);
    const shadowEvidence = await pg.query<{ matched: boolean }>(
      `SELECT matched
       FROM shadow_read_comparisons
       WHERE scope_type = 'new_projects' AND scope_key = '*' AND operation = 'list'`,
    );
    expect(shadowEvidence.rows).toEqual([{ matched: true }]);

    await setRoute("new_projects", "*", "relational");
    await shadowing.app.close();
    server = null;
    const running = await start(store);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await request(running, "GET", "/api/projects");
      expect(response.statusCode).toBe(200);
      expect((response.json() as { id: string }[]).map((project) => project.id)).toEqual(expected);
    }

    const created = await request(running, "POST", "/api/projects", {
      name: "Still legacy-owned",
      description: "Phase 2 does not activate relational project mutation",
      pm_provider: "anthropic",
    });
    expect(created.statusCode).toBe(201);
    const createdId = (created.json() as { id: string }).id;
    expect(store.summary(createdId).name).toBe("Still legacy-owned");
  });

  it("creates new projects relationally and refuses legacy graph writes after write cutover", async () => {
    const source = fixture("clean-planned");
    await importSource(source);
    const store = legacyStore([source]);
    await bindProjectsSnapshotEvidence(store);
    await setRoute("new_projects", "*", "relational", "relational");
    await setRoute("project", source.id, "relational", "relational");
    const running = await start(store);

    const created = await request(running, "POST", "/api/projects", {
      name: "Relational pilot",
      description: "Created after the authoritative new-project route",
      pm_provider: "openai",
    });
    expect(created.statusCode).toBe(201);
    const project = created.json() as { id: string; name: string; pm_provider: string };
    expect(project).toMatchObject({ name: "Relational pilot", pm_provider: "openai" });
    expect(() => store.summary(project.id)).toThrow(/unknown project/);
    expect((await request(running, "GET", "/api/projects")).json()).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: project.id })]),
    );
    expect((await request(running, "GET", `/api/projects/${project.id}`)).json()).toMatchObject({
      id: project.id,
      name: "Relational pilot",
    });
    const graph = await request(running, "GET", `/api/projects/${project.id}/graph`);
    expect(graph.statusCode).toBe(409);
    expect(graph.json()).toMatchObject({ error: "not_planned" });
    const resume = await request(running, "GET", `/api/v2/projects/${project.id}/resume`);
    expect(resume.statusCode).toBe(200);
    expect(resume.json()).toMatchObject({
      project: { id: project.id },
      repositories: [],
      next_recommended_action: "Connect a project repository",
    });
    const history = await pg.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM domain_events
       WHERE project_id=$1 AND event_type='project.created'`,
      [project.id],
    );
    expect(history.rows[0]?.count).toBe(1);

    const mutation = await request(running, "POST", `/api/projects/${source.id}/graph/nodes`, {
      id: "must-not-write-legacy",
      title: "Must not write the legacy snapshot",
    });
    expect(mutation.statusCode).toBe(409);
    expect(mutation.json()).toMatchObject({ error: "phase3_required", operation: "addNode" });
    expect(store.session(source.id).graph.node("must-not-write-legacy")).toBeUndefined();
  });

  it("creates and reopens a GitHub-backed relational project through every read surface", async () => {
    const store = new ProjectStore();
    await bindProjectsSnapshotEvidence(store);
    await setRoute("new_projects", "*", "relational", "relational");
    await pg.query(
      `INSERT INTO service_connections (
         id, provider, display_name, status, owner_type, owner_login,
         external_account_id, installation_id, repository_selection,
         connected_by_user_id
       ) VALUES (
         'github:42','github','octocat on GitHub','connected','user','octocat',
         '101','42','all','norns-user-1'
       )`,
    );
    const resolveRepository = vi.fn(async () => ({
      id: "9001",
      connection_id: "github:42",
      owner: "octocat",
      name: "existing-app",
      full_name: "octocat/existing-app",
      private: true,
      default_branch: "main",
      html_url: "https://github.com/octocat/existing-app",
      clone_url: "https://github.com/octocat/existing-app.git",
      description: "Existing application",
      language: "TypeScript",
      archived: false,
      updated_at: "2026-07-20T00:00:00.000Z",
    }));
    const github = { resolveRepository } as unknown as GitHubIntegrationService;
    const running = await start(store, github);

    const created = await request(running, "POST", "/api/projects", {
      name: "Existing app",
      description: "Continue the selected repository",
      pm_provider: "anthropic",
      source_type: "github",
      github_connection_id: "github:42",
      github_repository_id: "9001",
    });

    expect(created.statusCode).toBe(201);
    const project = created.json() as { id: string };
    expect(resolveRepository).toHaveBeenCalledWith(expect.any(String), "github:42", "9001");
    expect((await request(running, "GET", `/api/projects/${project.id}`)).json()).toMatchObject({
      id: project.id,
      source_type: "github",
      source_location: "https://github.com/octocat/existing-app.git",
    });
    expect((await request(running, "GET", `/api/projects/${project.id}/graph`)).statusCode).toBe(
      409,
    );
    const resume = await request(running, "GET", `/api/v2/projects/${project.id}/resume`);
    expect(resume.statusCode).toBe(200);
    expect(resume.json()).toMatchObject({
      project: { id: project.id },
      repositories: [
        {
          binding_type: "github",
          display_name: "existing-app",
          status: "unverified_candidate",
          health: "unknown",
        },
      ],
      next_recommended_action: "Analyze the repository and record its architecture",
    });
  });
});
