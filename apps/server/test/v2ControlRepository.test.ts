import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqlPhase2ControlRepository } from "../src/persistence/migration/controlRepository.js";
import { buildShadowReadComparison } from "../src/persistence/migration/shadowRead.js";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

describe.sequential("Phase 2 runtime control repository", () => {
  let pg: PGlite;
  let repository: SqlPhase2ControlRepository;
  let sourceText: string;

  beforeEach(async () => {
    pg = new PGlite();
    await pg.exec(`
      CREATE TABLE norns_state (
        key TEXT PRIMARY KEY,
        snapshot JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE ROLE norns_app NOLOGIN;
      INSERT INTO norns_state (key, snapshot, updated_at) VALUES
        ('users', '{"sessions":[],"users":[]}'::jsonb, '2026-07-16T21:00:00Z'),
        ('projects', '{"projects":[]}'::jsonb, '2026-07-16T21:00:01Z'),
        ('relay', '{"audit":[]}'::jsonb, '2026-07-16T21:00:02Z');
    `);
    await runCurrentV2Migrations(pg as unknown as V2MigrationDatabase);
    sourceText = (
      await pg.query<{ source_text: string }>(
        "SELECT snapshot::text AS source_text FROM norns_state WHERE key = 'projects'",
      )
    ).rows[0]?.source_text as string;
    await pg.query(
      `INSERT INTO migration_runs (
         id, migration_name, source_snapshot_hashes, source_counts,
         source_frozen_at, source_manifest_hash, status, started_at, details
       ) VALUES (
         'migration-phase2','phase2-control','{}'::jsonb,'{}'::jsonb,
         '2026-07-16T21:00:00Z',$1,'shadowing','2026-07-16T21:00:00Z',$2::jsonb
       )`,
      [
        "a".repeat(64),
        JSON.stringify({ replay_source_exact_hashes: { projects: sha256(sourceText) } }),
      ],
    );
    repository = new SqlPhase2ControlRepository(new PGliteTransactionRunner(pg));
  }, 30_000);

  afterEach(async () => {
    await pg.close();
  });

  it("binds evidence to database time, current manifest, and current source revision", async () => {
    await repository.recordShadowComparison(
      buildShadowReadComparison({
        migration_run_id: "migration-phase2",
        scope_type: "project",
        scope_key: "project-1",
        operation: "summary",
        legacy: { id: "project-1" },
        relational: { id: "project-1" },
        observed_at: "2099-12-31T23:59:59.000Z",
      }),
    );

    const evidence = await pg.query<{
      source_key: string;
      source_manifest_hash: string;
      source_exact_hash: string;
      source_updated_at: string;
      observed_at: string;
    }>(
      `SELECT source_key, source_manifest_hash, source_exact_hash,
              source_updated_at, observed_at
       FROM shadow_read_comparisons`,
    );
    expect(evidence.rows[0]).toMatchObject({
      source_key: "projects",
      source_manifest_hash: "a".repeat(64),
      source_exact_hash: sha256(sourceText),
    });
    expect(new Date(evidence.rows[0]?.source_updated_at as string).toISOString()).toBe(
      "2026-07-16T21:00:01.000Z",
    );
    expect(Date.parse(evidence.rows[0]?.observed_at as string)).toBeLessThan(
      Date.parse("2099-01-01T00:00:00Z"),
    );
  });

  it("rolls back stale evidence when the live source no longer matches the frozen replay hash", async () => {
    await pg.query(
      `UPDATE norns_state
       SET snapshot = '{"projects":[{"id":"changed"}]}'::jsonb,
           updated_at = '2026-07-16T22:00:00Z'
       WHERE key = 'projects'`,
    );
    await expect(
      repository.recordShadowComparison(
        buildShadowReadComparison({
          migration_run_id: "migration-phase2",
          scope_type: "new_projects",
          scope_key: "*",
          operation: "list",
          legacy: [],
          relational: [],
          observed_at: "2026-07-16T22:00:01Z",
        }),
      ),
    ).rejects.toThrow(/does not match.*frozen replay manifest/);
    expect(
      (
        await pg.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM shadow_read_comparisons",
        )
      ).rows[0]?.count,
    ).toBe(0);
  });

  it("reads routes without requiring route-write authority", async () => {
    await pg.query(
      `INSERT INTO persistence_routes (
         scope_type, scope_key, read_mode, write_mode, migration_run_id,
         aggregate_version, changed_by_actor_type, changed_by_actor_id,
         changed_at
       ) VALUES (
         'project','project-1','shadow','legacy','migration-phase2',
         1,'system',NULL,'2026-07-16T21:30:00Z'
       )`,
    );
    expect(await repository.findRoute("project", "project-1")).toMatchObject({
      read_mode: "shadow",
      write_mode: "legacy",
      migration_run_id: "migration-phase2",
    });
  });
});
