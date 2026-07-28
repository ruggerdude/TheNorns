// ONBOARDING grant repair, proved against a real role.
//
// 0018 granted only SELECT, INSERT on project_onboarding_repository_intents,
// but reserveRepositoryIntent locks the row with `SELECT ... FOR UPDATE`,
// which PostgreSQL only permits with the UPDATE table privilege. Production
// runs under the restricted `norns_app` role, so every `new_repo` onboarding
// died with "permission denied" — invisible in CI because the pglite harness
// normally runs as the owner. This suite creates the role for real, proves
// the privilege is absent before the new migration and present after it, and
// proves the boot guard now refuses a database missing the onboarding
// relations instead of booting healthy and failing at runtime.
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertCurrentRuntimeSchema } from "../src/persistence/postgresConnection.js";
import {
  type V2MigrationDatabase,
  runCurrentV2Migrations,
  runV2Migrations,
} from "../src/persistence/v2/migrate.js";

const MIGRATION_NAME = "NNNN_onboarding_intents_update_grant";
const MIGRATION_URL = new URL(
  "../drizzle/NNNN_onboarding_intents_update_grant.sql",
  import.meta.url,
);

const asMigrationDatabase = (database: PGlite): V2MigrationDatabase =>
  database as unknown as V2MigrationDatabase;

async function privilege(pg: PGlite, kind: "SELECT" | "INSERT" | "UPDATE"): Promise<boolean> {
  const result = await pg.query<{ allowed: boolean }>(
    `SELECT has_table_privilege('norns_app', 'project_onboarding_repository_intents', $1) AS allowed`,
    [kind],
  );
  return result.rows[0]?.allowed ?? false;
}

describe("onboarding intents UPDATE grant migration", () => {
  let pg: PGlite;

  beforeEach(async () => {
    pg = new PGlite();
    // The restricted production role, so the grant path in the migration's
    // DO block actually executes instead of no-opping.
    await pg.exec(`
      CREATE ROLE norns_app NOLOGIN;
      CREATE TABLE norns_state (
        key TEXT PRIMARY KEY,
        snapshot JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await runCurrentV2Migrations(asMigrationDatabase(pg));
  });

  afterEach(async () => {
    if (!pg.closed) await pg.close();
  });

  it("applies, grants UPDATE to norns_app, and is replay-safe", async () => {
    // The exact production gap: 0018 left the role able to read and insert
    // but not lock (`SELECT ... FOR UPDATE` needs UPDATE).
    expect(await privilege(pg, "SELECT")).toBe(true);
    expect(await privilege(pg, "INSERT")).toBe(true);
    expect(await privilege(pg, "UPDATE")).toBe(false);

    const sql = await readFile(MIGRATION_URL, "utf8");
    const first = await runV2Migrations(asMigrationDatabase(pg), [{ name: MIGRATION_NAME, sql }]);
    expect(first).toMatchObject([{ name: MIGRATION_NAME, applied: true }]);

    expect(await privilege(pg, "UPDATE")).toBe(true);

    // Forward-only replay: same checksum, nothing re-applied, no error.
    const replay = await runV2Migrations(asMigrationDatabase(pg), [{ name: MIGRATION_NAME, sql }]);
    expect(replay).toMatchObject([{ name: MIGRATION_NAME, applied: false }]);
  });

  it("boot guard accepts the fully-migrated schema and rejects a half-migrated one", async () => {
    const pool = pg as unknown as Parameters<typeof assertCurrentRuntimeSchema>[0];
    await expect(assertCurrentRuntimeSchema(pool)).resolves.toBeUndefined();

    // Simulate the half-migrated deploy that previously booted healthy and
    // only failed at request time. (DROP here is test scaffolding, not a
    // migration statement.)
    await pg.exec("DROP TABLE project_onboarding_repository_intents");
    await expect(assertCurrentRuntimeSchema(pool)).rejects.toMatchObject({
      code: "runtime_schema_outdated",
      message: expect.stringContaining("project_onboarding_repository_intents"),
    });
  });
});
