import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";
import { RepositoryIngestionService } from "../src/projects/repositoryIngestionService.js";
import { SourceBindingService } from "../src/projects/sourceBindingService.js";

describe.sequential("Phase 3 repository ingestion", () => {
  let pg: PGlite;
  let ingestion: RepositoryIngestionService;
  let bindingId: string;

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
       ) VALUES ('project-1','Project One','','initializing','assignment-old',
                 'verification-old','budget-old')`,
    );
    const transactions = new PGliteTransactionRunner(pg);
    bindingId = (
      await new SourceBindingService(transactions).createLocal({
        project_id: "project-1",
        runner_id: "runner-1",
        workspace_id: "workspace-1",
        repository_id: "repository-1",
        repository_display_name: "Project One",
        default_branch: "main",
        observed_head: "commit-1",
        verification_policy_ref: "verification-new",
        created_by: { actor_type: "human", actor_id: "admin-1" },
      })
    ).id;
    ingestion = new RepositoryIngestionService(transactions);
  });

  afterEach(async () => {
    await pg.close();
  });

  it("atomically seeds architecture, repository facts, policies, and replay identity", async () => {
    const seed = {
      project_id: "project-1",
      repository_binding_id: bindingId,
      repository_revision: "commit-1",
      architecture: {
        title: "Initial architecture",
        summary: "A TypeScript monorepo with web, server, runner, and shared contracts.",
        artifact: {
          storage_ref: "artifact://project-1/architecture/commit-1",
          content_hash: "a".repeat(64),
          byte_size: 512,
          media_type: "text/markdown",
        },
      },
      repository_facts: [
        { key: "language", value: "TypeScript", confidence: 1 },
        { key: "test_command", value: "pnpm test", confidence: 0.95 },
      ],
      constraints: ["Preserve append-only lifecycle history"],
      directives: [],
      assignment_policy_ref: "assignment-new",
      verification_policy_ref: "verification-new",
      budget_policy_ref: "budget-new",
      created_by: { actor_type: "human" as const, actor_id: "admin-1" },
    };

    const first = await ingestion.ingest(seed);
    const replay = await ingestion.ingest(seed);
    expect(first).toMatchObject({ architecture_revision: 1, replayed: false });
    expect(replay).toEqual({ ...first, replayed: true });

    const state = await pg.query<{
      status: string;
      architecture_id: string;
      assignment_policy_ref: string;
      verification_policy_ref: string;
      budget_policy_ref: string;
      architectures: number;
      memories: number;
      artifacts: number;
    }>(
      `SELECT p.status, p.current_architecture_revision_id AS architecture_id,
              p.assignment_policy_ref, p.verification_policy_ref, p.budget_policy_ref,
              (SELECT count(*)::int FROM architecture_revisions) AS architectures,
              (SELECT count(*)::int FROM project_memory_entries) AS memories,
              (SELECT count(*)::int FROM artifacts) AS artifacts
       FROM projects p WHERE p.id = 'project-1'`,
    );
    expect(state.rows[0]).toMatchObject({
      status: "active",
      architecture_id: first.architecture_revision_id,
      assignment_policy_ref: "assignment-new",
      verification_policy_ref: "verification-new",
      budget_policy_ref: "budget-new",
      architectures: 1,
      memories: 4,
      artifacts: 1,
    });
  });
});
