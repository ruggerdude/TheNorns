import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";

describe.sequential("debate workflow schema", () => {
  let pg: PGlite;

  beforeEach(async () => {
    pg = new PGlite();
    await pg.exec("CREATE ROLE norns_app NOLOGIN");
    await runCurrentV2Migrations(pg as unknown as V2MigrationDatabase);
    await pg.exec(`
      INSERT INTO projects (
        id, name, status, assignment_policy_ref, verification_policy_ref, budget_policy_ref
      ) VALUES ('project-1', 'Debate project', 'active', 'assignment/default', 'verification/default', 'budget/default');
    `);
  }, 30_000);

  afterEach(async () => {
    if (!pg.closed) await pg.close();
  });

  it("enforces one active run and immutable transcript history", async () => {
    await pg.exec(`
      INSERT INTO debates (
        id, project_id, state, title, question, stopping_policy, content_hash,
        created_by_actor_type, aggregate_version
      ) VALUES (
        'debate-1', 'project-1', 'ready', 'Persistence?', 'How should we persist this?',
        '{}'::jsonb, repeat('a', 64), 'system', 1
      );
      INSERT INTO debate_runs (id, project_id, debate_id, attempt, state)
      VALUES ('run-1', 'project-1', 'debate-1', 1, 'created');
    `);

    await expect(
      pg.query(
        `INSERT INTO debate_runs (id, project_id, debate_id, attempt, state)
         VALUES ('run-2', 'project-1', 'debate-1', 2, 'queued')`,
      ),
    ).rejects.toThrow();

    await pg.exec(`
      INSERT INTO debate_messages (
        id, project_id, debate_id, debate_run_id, sequence, message_kind,
        content, content_hash
      ) VALUES (
        'message-1', 'project-1', 'debate-1', 'run-1', 1, 'system',
        'Starting debate', repeat('b', 64)
      );
    `);
    await expect(
      pg.query("UPDATE debate_messages SET content='changed' WHERE id='message-1'"),
    ).rejects.toThrow(/append-only/);
  });

  it("enforces scoped actor snapshots and one optional judge", async () => {
    await pg.exec(`
      INSERT INTO debates (
        id, project_id, state, title, question, stopping_policy, content_hash,
        created_by_actor_type, aggregate_version
      ) VALUES (
        'debate-1', 'project-1', 'draft', 'Architecture', 'Which design?',
        '{}'::jsonb, repeat('a', 64), 'system', 1
      );
      INSERT INTO debate_actors (
        id, project_id, debate_id, actor_kind, role_label, display_name, instructions,
        provider, model, runtime, position, max_turns, max_input_tokens, max_output_tokens,
        budget_limit_usd
      ) VALUES (
        'judge-1', 'project-1', 'debate-1', 'judge', 'judge', 'Judge', 'Evaluate evidence',
        'openai', 'chosen-model', 'provider_api', 0, 1, 100, 100, 1
      );
    `);
    await expect(
      pg.query(`
        INSERT INTO debate_actors (
          id, project_id, debate_id, actor_kind, role_label, display_name, instructions,
          provider, model, runtime, position, max_turns, max_input_tokens, max_output_tokens,
          budget_limit_usd
        ) VALUES (
          'judge-2', 'project-1', 'debate-1', 'judge', 'second judge', 'Judge 2', 'Evaluate evidence',
          'anthropic', 'chosen-model', 'provider_api', 1, 1, 100, 100, 1
        )
      `),
    ).rejects.toThrow();
  });
});
