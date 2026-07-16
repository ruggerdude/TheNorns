import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LegacyProjectSnapshot,
  type LegacyProjectSnapshotT,
} from "../src/persistence/migration/legacyProjectSchemas.js";
import { buildLegacyProjectImportPlan } from "../src/persistence/migration/projectImportPlan.js";
import {
  LegacyProjectSourceChangedError,
  importLegacyProject,
} from "../src/persistence/migration/projectImportService.js";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { transitionV2TaskLifecycle } from "../src/persistence/v2/lifecycleMutation.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";
import { SqlV2ApplicationTransaction } from "../src/persistence/v2/sqlRepositories.js";

const RUN_ID = "migration-run-projects";
const MANIFEST_HASH = "a".repeat(64);
const FROZEN_AT = "2026-07-16T16:00:00.000Z";
const IMPORTED_AT = "2026-07-16T16:05:00.000Z";
const PROJECTS_ARCHIVE_ID = "archive-projects";

function fixture(name: string): LegacyProjectSnapshotT {
  return LegacyProjectSnapshot.parse(
    JSON.parse(
      readFileSync(new URL(`./fixtures/phase2/projects/${name}.json`, import.meta.url), "utf8"),
    ),
  );
}

describe.sequential("Phase 2 project import SQL persistence", () => {
  let pg: PGlite;

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
      `INSERT INTO migration_runs (
         id, migration_name, source_snapshot_hashes, source_counts,
         source_frozen_at, source_manifest_hash, source_application_version,
         source_application_commit, status, started_at
       ) VALUES ($1,'phase2-preservation','{}'::jsonb,'{}'::jsonb,$2,$3,'0.1.0','test','importing',$2)`,
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
         $1,$2,'projects',$3,'postgres://archive/projects','test-key',
         $6,'aes-256-gcm',$4,$4,$4,$4,$5,1,1,'{}'::jsonb,NULL,
         decode('00','hex'),decode('00','hex'),decode('00','hex'),
         'verified',$3,'2026-08-16T16:00:00.000Z',$3
       )`,
      [PROJECTS_ARCHIVE_ID, RUN_ID, FROZEN_AT, "b".repeat(64), MANIFEST_HASH, "9".repeat(64)],
    );
  });

  afterEach(async () => {
    await pg.close();
  });

  function importOptions(name: string) {
    return {
      transaction_runner: new PGliteTransactionRunner(pg),
      migration_run_id: RUN_ID,
      source_manifest_hash: MANIFEST_HASH,
      occurred_at: IMPORTED_AT,
      plan: buildLegacyProjectImportPlan(fixture(name), {
        source_frozen_at: FROZEN_AT,
      }),
    };
  }

  it("persists a complete project import and transitions deleted tasks through guarded history", async () => {
    const options = importOptions("deleted-module");
    const result = await importLegacyProject(options);
    expect(result.status).toBe("imported");

    const project = await pg.query<{ status: string }>(
      "SELECT status FROM projects WHERE id = 'proj-deleted'",
    );
    expect(project.rows[0]?.status).toBe("blocked");
    expect(
      (
        await pg.query<{ import_event_id: string | null }>(
          "SELECT pm_provider, pm_model, reviewer_provider, source FROM project_planning_preferences WHERE project_id = 'proj-deleted'",
        )
      ).rows[0],
    ).toMatchObject({
      pm_provider: "anthropic",
      pm_model: null,
      reviewer_provider: "openai",
      source: "legacy_snapshot",
    });

    const strategy = await pg.query<{ status: string; approval_id: string | null }>(
      "SELECT status, approval_id FROM strategy_versions WHERE project_id = 'proj-deleted'",
    );
    expect(strategy.rows[0]).toEqual({
      status: "awaiting_approval",
      approval_id: null,
    });
    const tasks = await pg.query<{
      id: string;
      state: string;
      lifecycle_version: number;
      designated_assignment_id: string | null;
    }>(
      `SELECT id, state, lifecycle_version, designated_assignment_id
       FROM tasks WHERE project_id = 'proj-deleted' ORDER BY id`,
    );
    expect(tasks.rows).toEqual([
      expect.objectContaining({
        id: expect.stringContaining(":a"),
        state: "pending",
        lifecycle_version: 0,
        designated_assignment_id: expect.any(String),
      }),
      expect.objectContaining({
        id: expect.stringContaining(":removed"),
        state: "cancelled",
        lifecycle_version: 1,
        designated_assignment_id: expect.any(String),
      }),
    ]);

    const removedId = tasks.rows.find((task) => task.id.includes(":removed"))?.id;
    if (!removedId) throw new Error("expected removed task");
    const events = await pg.query<{
      event_type: string;
      stream_version: number;
      actor_type: string;
      actor_id: string | null;
    }>(
      `SELECT event_type, stream_version, actor_type, actor_id
       FROM domain_events WHERE stream_type = 'task' AND stream_id = $1
       ORDER BY stream_version`,
      [removedId],
    );
    expect(events.rows).toEqual([
      {
        event_type: "task_state_transitioned",
        stream_version: 1,
        actor_type: "legacy",
        actor_id: null,
      },
    ]);
    const mapping = await pg.query<{ import_event_id: string | null }>(
      `SELECT import_event_id FROM legacy_id_mappings
       WHERE migration_run_id = $1 AND v2_entity_type = 'task' AND v2_id = $2`,
      [RUN_ID, removedId],
    );
    expect(mapping.rows[0]?.import_event_id).toEqual(expect.any(String));
    expect(
      (
        await pg.query<{
          stream_type: string;
          stream_id: string;
          payload: { v2_entity_type: string; v2_entity_id: string };
        }>(
          `SELECT stream_type, stream_id, payload
           FROM domain_events WHERE event_id = $1`,
          [mapping.rows[0]?.import_event_id],
        )
      ).rows[0],
    ).toEqual({
      stream_type: "migration",
      stream_id: `migration-batch:${RUN_ID}:project:proj-deleted`,
      payload: expect.objectContaining({
        v2_entity_type: "task",
        v2_entity_id: removedId,
      }),
    });
    const migrationVersions = await pg.query<{ stream_version: number }>(
      `SELECT stream_version
       FROM domain_events
       WHERE stream_type = 'migration' AND stream_id = $1
       ORDER BY stream_version`,
      [`migration-batch:${RUN_ID}:project:proj-deleted`],
    );
    expect(migrationVersions.rows.map((row) => row.stream_version)).toEqual(
      Array.from({ length: migrationVersions.rows.length }, (_, index) => index + 1),
    );
    expect(migrationVersions.rows).toHaveLength(options.plan.id_mappings.length);

    const importRow = await pg.query<{
      archive_id: string;
      graph_version: number;
      source_counts: Record<string, number>;
    }>(
      "SELECT archive_id, graph_version, source_counts FROM legacy_project_imports WHERE migration_run_id = $1 AND project_id = 'proj-deleted'",
      [RUN_ID],
    );
    expect(importRow.rows[0]).toMatchObject({
      archive_id: PROJECTS_ARCHIVE_ID,
      graph_version: 2,
      source_counts: {
        plan_modules: 2,
        graph_nodes: 1,
        imported_tasks: 2,
      },
    });
    expect(
      (
        await pg.query<{ count: number }>(
          "SELECT COUNT(*)::int AS count FROM migration_reconciliation_findings WHERE project_id = 'proj-deleted'",
        )
      ).rows[0]?.count,
    ).toBeGreaterThan(0);
  });

  it("replays the same frozen source without duplicate rows", async () => {
    const options = importOptions("graph-only-node");
    expect((await importLegacyProject(options)).status).toBe("imported");
    expect((await importLegacyProject(options)).status).toBe("replayed");

    expect(
      (
        await pg.query<{ count: number }>(
          "SELECT COUNT(*)::int AS count FROM legacy_project_imports WHERE project_id = 'proj-graph-only'",
        )
      ).rows[0]?.count,
    ).toBe(1);
    expect(
      (
        await pg.query<{ count: number }>(
          "SELECT COUNT(*)::int AS count FROM projects WHERE id = 'proj-graph-only'",
        )
      ).rows[0]?.count,
    ).toBe(1);
  });

  it("links source candidates to the projects archive and keeps approval evidence historical", async () => {
    const source = fixture("changed-assignment");
    source.sourceType = "github";
    source.sourceLocation = "https://github.com/example/historical.git";
    const plan = buildLegacyProjectImportPlan(source, {
      source_frozen_at: FROZEN_AT,
    });
    await importLegacyProject({
      transaction_runner: new PGliteTransactionRunner(pg),
      migration_run_id: RUN_ID,
      source_manifest_hash: MANIFEST_HASH,
      occurred_at: IMPORTED_AT,
      plan,
    });

    expect(
      (
        await pg.query<{
          archive_id: string | null;
          github_owner: string | null;
          github_name: string | null;
          status: string;
        }>(
          `SELECT archive_id, github_owner, github_name, status
           FROM repository_binding_candidates
           WHERE project_id = 'proj-assignment'`,
        )
      ).rows[0],
    ).toEqual({
      archive_id: PROJECTS_ARCHIVE_ID,
      github_owner: "example",
      github_name: "historical",
      status: "unverified",
    });
    expect(
      (
        await pg.query<{
          actor_type: string;
          actor_id: string | null;
          source_actor_text: string | null;
          current_at_import: boolean;
        }>(
          `SELECT actor_type, actor_id, source_actor_text, current_at_import
           FROM legacy_approval_evidence
           WHERE project_id = 'proj-assignment'`,
        )
      ).rows[0],
    ).toEqual({
      actor_type: "legacy",
      actor_id: null,
      source_actor_text: "operator",
      current_at_import: false,
    });
    expect(
      (
        await pg.query<{ count: number }>(
          "SELECT COUNT(*)::int AS count FROM approvals WHERE project_id = 'proj-assignment'",
        )
      ).rows[0]?.count,
    ).toBe(0);
    expect(
      (
        await pg.query<{ approval_id: string | null }>(
          "SELECT approval_id FROM strategy_versions WHERE project_id = 'proj-assignment'",
        )
      ).rows[0]?.approval_id,
    ).toBeNull();
    expect(
      (
        await pg.query<{ import_event_id: string | null }>(
          `SELECT import_event_id FROM legacy_id_mappings
           WHERE migration_run_id = $1
             AND v2_entity_type = 'legacy_approval_evidence'
             AND v2_id = $2`,
          [RUN_ID, plan.historical_approval?.id],
        )
      ).rows[0]?.import_event_id,
    ).toBeNull();
  });

  it("leaves task stream version one available for the first guarded transition", async () => {
    const options = importOptions("clean-planned");
    await importLegacyProject(options);
    const task = await pg.query<{
      id: string;
      project_id: string;
      phase_id: string;
      aggregate_version: number;
    }>(
      `SELECT id, project_id, phase_id, aggregate_version
       FROM tasks WHERE project_id = 'proj-clean'`,
    );
    const row = task.rows[0];
    if (!row) throw new Error("expected imported pending task");

    const updated = await new PGliteTransactionRunner(pg).transaction((tx) =>
      transitionV2TaskLifecycle(new SqlV2ApplicationTransaction(tx), {
        project_id: row.project_id,
        phase_id: row.phase_id,
        task_id: row.id,
        expected_aggregate_version: row.aggregate_version,
        to: "ready",
        reason: "regression: first post-import transition",
        actor_type: "legacy",
        actor_id: null,
        correlation_id: "post-import-transition",
        causation_id: null,
        occurred_at: "2026-07-16T16:10:00.000Z",
      }),
    );
    expect(updated).toMatchObject({ state: "ready", lifecycle_version: 1 });
    expect(
      (
        await pg.query<{ stream_version: number; event_type: string }>(
          `SELECT stream_version, event_type
           FROM domain_events WHERE stream_type = 'task' AND stream_id = $1`,
          [row.id],
        )
      ).rows,
    ).toEqual([{ stream_version: 1, event_type: "task_state_transitioned" }]);
  });

  it("preserves an unparseable GitHub source as an unverified candidate", async () => {
    const source = fixture("clean-planned");
    source.id = "proj-unparseable-source";
    source.sourceType = "github";
    source.sourceLocation = "legacy-github-locator-without-credentials";
    await importLegacyProject({
      transaction_runner: new PGliteTransactionRunner(pg),
      migration_run_id: RUN_ID,
      source_manifest_hash: MANIFEST_HASH,
      occurred_at: IMPORTED_AT,
      plan: buildLegacyProjectImportPlan(source, {
        source_frozen_at: FROZEN_AT,
      }),
    });

    expect(
      (
        await pg.query<{
          status: string;
          github_owner: string | null;
          github_name: string | null;
          archive_id: string | null;
        }>(
          `SELECT status, github_owner, github_name, archive_id
           FROM repository_binding_candidates
           WHERE project_id = 'proj-unparseable-source'`,
        )
      ).rows[0],
    ).toEqual({
      status: "unverified",
      github_owner: null,
      github_name: null,
      archive_id: PROJECTS_ARCHIVE_ID,
    });
  });

  it("refuses a changed source under the same migration run and project identity", async () => {
    const options = importOptions("clean-planned");
    await importLegacyProject(options);
    const changed = structuredClone(options.plan);
    changed.source_hash = "f".repeat(64);
    await expect(importLegacyProject({ ...options, plan: changed })).rejects.toBeInstanceOf(
      LegacyProjectSourceChangedError,
    );
  });

  it("rolls back every row when an injected mid-import failure occurs", async () => {
    const source = fixture("clean-planned");
    source.id = "proj-fault";
    const plan = buildLegacyProjectImportPlan(source, {
      source_frozen_at: FROZEN_AT,
    });

    await expect(
      importLegacyProject({
        transaction_runner: new PGliteTransactionRunner(pg),
        migration_run_id: RUN_ID,
        source_manifest_hash: MANIFEST_HASH,
        occurred_at: IMPORTED_AT,
        plan,
        after_step: (step) => {
          if (step === "tasks") throw new Error("fault after task inserts");
        },
      }),
    ).rejects.toThrow("fault after task inserts");

    expect(
      (
        await pg.query<{ count: number }>(
          "SELECT COUNT(*)::int AS count FROM projects WHERE id = 'proj-fault'",
        )
      ).rows[0]?.count,
    ).toBe(0);
    expect(
      (
        await pg.query<{ count: number }>(
          "SELECT COUNT(*)::int AS count FROM legacy_project_imports WHERE project_id = 'proj-fault'",
        )
      ).rows[0]?.count,
    ).toBe(0);
    expect(
      (
        await pg.query<{ count: number }>(
          "SELECT COUNT(*)::int AS count FROM domain_events WHERE project_id = 'proj-fault'",
        )
      ).rows[0]?.count,
    ).toBe(0);
  });
});
