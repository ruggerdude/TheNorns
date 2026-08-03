import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEEPSEEK_PROVIDER_MIGRATION_NAME,
  type V2MigrationDatabase,
  currentV2MigrationSources,
  runCurrentV2Migrations,
} from "../src/persistence/v2/migrate.js";

const DEEPSEEK_CONSTRAINTS = [
  "conversation_plan_proposal_attempts_provider_check",
  "conversation_plan_reviews_provider_policy_check",
  "planning_reviewer_settings_provider_check",
  "planning_runs_agent_selection_check",
  "planning_runs_pm_selection_check",
  "planning_runs_worker_providers_check",
  "project_planning_preferences_pm_provider_check",
  "project_planning_preferences_reviewer_provider_check",
] as const;

describe.sequential("DeepSeek provider migration", () => {
  let database: PGlite;

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
  });

  afterAll(async () => {
    await database.close();
  });

  it("registers and applies 0080 through the current migration runner", async () => {
    const sources = await currentV2MigrationSources();
    const source = sources.find(({ name }) => name === DEEPSEEK_PROVIDER_MIGRATION_NAME);
    expect(source).toBeDefined();
    expect(source?.sql).toContain("'deepseek'");

    const results = await runCurrentV2Migrations(database as unknown as V2MigrationDatabase);
    expect(results.find(({ name }) => name === DEEPSEEK_PROVIDER_MIGRATION_NAME)).toMatchObject({
      name: DEEPSEEK_PROVIDER_MIGRATION_NAME,
      applied: true,
    });
  }, 60_000);

  it("installs every durable provider constraint with DeepSeek accepted", async () => {
    const constraints = await database.query<{ conname: string; definition: string }>(
      `SELECT conname, pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE conname = ANY($1::text[])
        ORDER BY conname`,
      [DEEPSEEK_CONSTRAINTS],
    );

    expect(constraints.rows.map((row) => row.conname)).toEqual(DEEPSEEK_CONSTRAINTS);
    for (const constraint of constraints.rows) {
      expect(constraint.definition, constraint.conname).toContain("deepseek");
    }
  });
});
