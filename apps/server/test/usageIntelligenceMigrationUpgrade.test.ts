import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type V2MigrationDatabase,
  type V2MigrationSource,
  runV2Migrations,
} from "../src/persistence/v2/migrate.js";

const drizzleDirectory = new URL("../drizzle/", import.meta.url);

async function migrationRange(first: number, last: number): Promise<V2MigrationSource[]> {
  const files = (await readdir(drizzleDirectory))
    .filter((file) => /^\d{4}_.+\.sql$/.test(file))
    .filter((file) => {
      const sequence = Number(file.slice(0, 4));
      return sequence >= first && sequence <= last;
    })
    .sort();
  return Promise.all(
    files.map(async (file) => ({
      name: file.slice(0, -4),
      sql: await readFile(new URL(file, drizzleDirectory), "utf8"),
    })),
  );
}

describe.sequential("usage intelligence migration upgrade path", () => {
  let database: PGlite;
  let upgrades: V2MigrationSource[];

  beforeAll(async () => {
    database = new PGlite();
    await database.exec(`
      CREATE ROLE norns_app NOLOGIN;
      CREATE TABLE norns_state (
        key TEXT PRIMARY KEY,
        snapshot JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    const legacy = await migrationRange(1, 27);
    expect(legacy).toHaveLength(27);
    expect(
      (await runV2Migrations(database as unknown as V2MigrationDatabase, legacy)).every(
        (result) => result.applied,
      ),
    ).toBe(true);

    await database.exec(`
      INSERT INTO users (
        id, username, display_name, email, name, password_hash,
        password_hash_scheme, role, status, created_at
      ) VALUES
        ('upgrade-admin','admin@example.com','Admin','admin@example.com','Admin',
         'hash','scrypt-v1','admin','active','2026-01-01T00:00:00Z'),
        ('upgrade-member','member@example.com','Member','member@example.com','Member',
         'hash','scrypt-v1','member','active','2026-02-01T00:00:00Z');

      INSERT INTO projects (
        id, name, status, assignment_policy_ref, verification_policy_ref,
        budget_policy_ref, created_at
      ) VALUES (
        'upgrade-project','Upgrade Project','active','assignment/default',
        'verification/default','budget/default','2026-03-01T00:00:00Z'
      );

      INSERT INTO planning_runs (
        id, project_id, max_rounds, objective, requested_by, created_at, updated_at
      ) VALUES (
        'upgrade-planning','upgrade-project',3,'Preserve me','upgrade-member',
        '2026-03-02T00:00:00Z','2026-03-02T00:00:00Z'
      );
    `);

    upgrades = await migrationRange(28, 32);
    expect(upgrades).toHaveLength(5);
  }, 60_000);

  afterAll(async () => {
    await database.close();
  });

  it("applies 0028 through 0032 to legacy data without losing attribution", async () => {
    const applied = await runV2Migrations(database as unknown as V2MigrationDatabase, upgrades);
    expect(applied.map((result) => [result.name, result.applied])).toEqual([
      ["0028_ai_usage_telemetry", true],
      ["0029_project_access_attribution", true],
      ["0030_usage_intelligence_policies", true],
      ["0031_usage_calibration_analytics", true],
      ["0032_shadow_evidence_order", true],
    ]);

    const project = await database.query<{ owner_user_id: string | null }>(
      "SELECT owner_user_id FROM projects WHERE id='upgrade-project'",
    );
    expect(project.rows[0]?.owner_user_id).toBe("upgrade-admin");

    const members = await database.query<{ user_id: string }>(
      "SELECT user_id FROM project_members WHERE project_id='upgrade-project' ORDER BY user_id",
    );
    expect(members.rows.map((row) => row.user_id)).toEqual(["upgrade-admin"]);

    const planning = await database.query<{
      requested_by: string | null;
      initiated_by_user_id: string | null;
    }>(
      `SELECT requested_by, initiated_by_user_id
       FROM planning_runs
       WHERE id='upgrade-planning'`,
    );
    expect(planning.rows[0]).toEqual({
      requested_by: "upgrade-member",
      initiated_by_user_id: "upgrade-member",
    });

    const schema = await database.query<{
      usage_events: string | null;
      budget_policies: string | null;
      calibration: string | null;
      recorded_order: boolean;
    }>(
      `SELECT
         to_regclass('ai_usage_events')::text AS usage_events,
         to_regclass('usage_budget_policies')::text AS budget_policies,
         to_regclass('ai_usage_calibration_observations')::text AS calibration,
         EXISTS (
           SELECT 1
           FROM information_schema.columns
           WHERE table_name='shadow_read_comparisons'
             AND column_name='recorded_order'
         ) AS recorded_order`,
    );
    expect(schema.rows[0]).toEqual({
      usage_events: "ai_usage_events",
      budget_policies: "usage_budget_policies",
      calibration: "ai_usage_calibration_observations",
      recorded_order: true,
    });
  });

  it("replays the complete upgrade range without reapplying a migration", async () => {
    const replay = await runV2Migrations(database as unknown as V2MigrationDatabase, upgrades);
    expect(replay.every((result) => !result.applied)).toBe(true);
  });
});
