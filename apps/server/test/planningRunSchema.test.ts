// FRONT DOOR P2 §D1: schema-level guarantees for the durable planning_runs
// and planning_reviewer_settings tables (drizzle/0012_planning_runs.sql).
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";

describe.sequential("planning_runs schema", () => {
  let pg: PGlite;

  beforeEach(async () => {
    pg = new PGlite();
    await pg.exec("CREATE ROLE norns_app NOLOGIN");
    await runCurrentV2Migrations(pg as unknown as V2MigrationDatabase);
    await pg.exec(`
      INSERT INTO projects (
        id, name, status, assignment_policy_ref, verification_policy_ref, budget_policy_ref
      ) VALUES ('project-1', 'Planning project', 'active', 'assignment/default', 'verification/default', 'budget/default');
    `);
  }, 30_000);

  afterEach(async () => {
    if (!pg.closed) await pg.close();
  });

  it("round-trips a queued row and rejects an unknown status", async () => {
    await pg.exec(`
      INSERT INTO planning_runs (id, project_id, status, round, max_rounds, objective)
      VALUES ('run-1', 'project-1', 'queued', 0, 3, 'Ship the thing');
    `);
    const result = await pg.query<{ status: string; transcript: unknown; result: unknown }>(
      "SELECT status, transcript, result FROM planning_runs WHERE id = 'run-1'",
    );
    expect(result.rows[0]?.status).toBe("queued");
    expect(result.rows[0]?.transcript).toEqual([]);
    expect(result.rows[0]?.result).toBeNull();

    await expect(
      pg.query(
        `INSERT INTO planning_runs (id, project_id, status, round, max_rounds, objective)
         VALUES ('run-bad', 'project-1', 'not_a_status', 0, 3, 'x')`,
      ),
    ).rejects.toThrow();
  });

  it("requires error exactly when failed, and result exactly when terminal-success", async () => {
    await pg.exec(`
      INSERT INTO planning_runs (id, project_id, status, round, max_rounds, objective)
      VALUES ('run-2', 'project-1', 'queued', 0, 3, 'obj');
    `);

    // failed without an error message is rejected
    await expect(
      pg.query("UPDATE planning_runs SET status = 'failed' WHERE id = 'run-2'"),
    ).rejects.toThrow();

    await pg.query("UPDATE planning_runs SET status = 'failed', error = 'boom' WHERE id = 'run-2'");

    // converged without a result payload is rejected
    await pg.exec(`
      INSERT INTO planning_runs (id, project_id, status, round, max_rounds, objective)
      VALUES ('run-3', 'project-1', 'reviewing', 1, 3, 'obj');
    `);
    await expect(
      pg.query("UPDATE planning_runs SET status = 'converged' WHERE id = 'run-3'"),
    ).rejects.toThrow();
    await pg.query(
      `UPDATE planning_runs SET status = 'converged', result = '{"plan":{}}'::jsonb WHERE id = 'run-3'`,
    );
    const row = await pg.query<{ status: string }>(
      "SELECT status FROM planning_runs WHERE id = 'run-3'",
    );
    expect(row.rows[0]?.status).toBe("converged");
  });

  it("bounds max_rounds to 1-5 and requires a real project via the FK", async () => {
    await expect(
      pg.query(
        `INSERT INTO planning_runs (id, project_id, status, round, max_rounds, objective)
         VALUES ('run-bad-rounds', 'project-1', 'queued', 0, 9, 'x')`,
      ),
    ).rejects.toThrow();

    await expect(
      pg.query(
        `INSERT INTO planning_runs (id, project_id, status, round, max_rounds, objective)
         VALUES ('run-bad-project', 'no-such-project', 'queued', 0, 3, 'x')`,
      ),
    ).rejects.toThrow();
  });

  it("persists a per-project reviewer override with the provider/model pair required together", async () => {
    await expect(
      pg.query(
        `INSERT INTO planning_reviewer_settings (project_id, reviewer_provider)
         VALUES ('project-1', 'openai')`,
      ),
    ).rejects.toThrow();

    await pg.exec(`
      INSERT INTO planning_reviewer_settings (project_id, reviewer_provider, reviewer_model, default_max_rounds)
      VALUES ('project-1', 'openai', 'gpt-5.6-luna', 4);
    `);
    const row = await pg.query<{
      reviewer_provider: string;
      reviewer_model: string;
      default_max_rounds: number;
    }>(
      "SELECT reviewer_provider, reviewer_model, default_max_rounds FROM planning_reviewer_settings WHERE project_id = 'project-1'",
    );
    expect(row.rows[0]).toEqual({
      reviewer_provider: "openai",
      reviewer_model: "gpt-5.6-luna",
      default_max_rounds: 4,
    });
  });
});
