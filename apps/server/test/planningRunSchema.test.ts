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
      INSERT INTO users (
        id, username, display_name, email, name, password_hash,
        password_hash_scheme, role, status
      ) VALUES (
        'admin-1', 'admin-1@example.com', 'Admin One',
        'admin-1@example.com', 'Admin One', 'x', 'scrypt-v1', 'admin', 'active'
      );
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

  it("persists quick mode and requires complete PM and agent selections", async () => {
    await expect(
      pg.query(
        `INSERT INTO planning_runs (
           id, project_id, status, round, max_rounds, objective, mode
         ) VALUES ('run-no-actor', 'project-1', 'queued', 0, 1, 'x', 'quick')`,
      ),
    ).rejects.toThrow();
    await expect(
      pg.query(
        `INSERT INTO planning_runs (
           id, project_id, status, round, max_rounds, objective, mode,
           requested_by, pm_provider
         ) VALUES (
           'run-partial-pm', 'project-1', 'queued', 0, 1, 'x', 'quick',
           'admin-1', 'openai'
         )`,
      ),
    ).rejects.toThrow();
    await expect(
      pg.query(
        `INSERT INTO planning_runs (
           id, project_id, status, round, max_rounds, objective, mode,
           requested_by, agent_model
         ) VALUES (
           'run-partial-agent', 'project-1', 'queued', 0, 1, 'x', 'quick',
           'admin-1', 'gpt-5.6-terra'
         )`,
      ),
    ).rejects.toThrow();

    await pg.query(
      `INSERT INTO planning_runs (
         id, project_id, status, round, max_rounds, objective, mode,
         requested_by, pm_provider, pm_model, agent_provider, agent_model
       ) VALUES (
         'run-quick', 'project-1', 'queued', 0, 1, 'Fix the copy', 'quick',
         'admin-1', 'openai', 'gpt-5.6-terra', 'anthropic', 'claude-sonnet-5'
       )`,
    );
    const row = await pg.query<{
      mode: string;
      pm_provider: string;
      pm_model: string;
      agent_provider: string;
      agent_model: string;
      requested_by: string;
    }>(
      `SELECT mode, requested_by, pm_provider, pm_model, agent_provider, agent_model
         FROM planning_runs WHERE id = 'run-quick'`,
    );
    expect(row.rows[0]).toEqual({
      mode: "quick",
      requested_by: "admin-1",
      pm_provider: "openai",
      pm_model: "gpt-5.6-terra",
      agent_provider: "anthropic",
      agent_model: "claude-sonnet-5",
    });

    await pg.query(
      `INSERT INTO planning_runs (id, project_id, status, round, max_rounds, objective)
       VALUES ('run-planned', 'project-1', 'queued', 0, 3, 'Plan it')`,
    );
    await expect(
      pg.query(
        "UPDATE planning_runs SET quick_kickoff_status = 'completed' WHERE id = 'run-planned'",
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
