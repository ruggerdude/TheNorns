import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import {
  HELD_EXECUTION_KICKOFF_MIGRATION_NAME,
  PROJECT_DESTROY_MIGRATION_NAME,
  QC_TERMINAL_FOLLOWUP_CHAT_MIGRATION_NAME,
  type V2MigrationDatabase,
  currentV2MigrationSources,
  runCurrentV2Migrations,
} from "../src/persistence/v2/migrate.js";
import { RelationalProjectReadRepository } from "../src/projects/relationalReadRepository.js";
import { ProjectNotFoundError } from "../src/projects/store.js";

describe.sequential("permanent project deletion", () => {
  let pg: PGlite;
  let projects: RelationalProjectReadRepository;

  beforeAll(async () => {
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
    projects = new RelationalProjectReadRepository(
      new PGliteTransactionRunner(pg as never),
      "project-destroy-test",
    );
  }, 30_000);

  afterAll(async () => {
    await pg.close();
  });

  it("registers held execution kickoff and terminal QC chat after project deletion", async () => {
    const names = (await currentV2MigrationSources()).map(({ name }) => name);
    expect(names.slice(-3)).toEqual([
      PROJECT_DESTROY_MIGRATION_NAME,
      HELD_EXECUTION_KICKOFF_MIGRATION_NAME,
      QC_TERMINAL_FOLLOWUP_CHAT_MIGRATION_NAME,
    ]);
  });

  it("deletes the complete project graph while retaining normal immutability", async () => {
    await pg.exec(`
      INSERT INTO users (
        id, username, display_name, email, name, password_hash,
        password_hash_scheme, role, status
      ) VALUES (
        'destroy-owner', 'destroy-owner@example.com', 'Destroy Owner',
        'destroy-owner@example.com', 'Destroy Owner', 'hash', 'scrypt-v1',
        'member', 'active'
      );

      INSERT INTO projects (
        id, name, status, assignment_policy_ref, verification_policy_ref,
        budget_policy_ref, owner_user_id
      ) VALUES (
        'project-destroy', 'Project to destroy', 'active',
        'assignment/default', 'verification/default', 'budget/default',
        'destroy-owner'
      );

      INSERT INTO domain_events (
        event_id, stream_type, stream_id, stream_version, event_type,
        project_id, actor_type, actor_id, correlation_id, occurred_at, payload
      ) VALUES (
        'destroy-event', 'project', 'project-destroy', 1, 'project.created',
        'project-destroy', 'human', 'destroy-owner', 'destroy-correlation', now(),
        '{}'::jsonb
      );

      INSERT INTO work_items (
        id, project_id, created_by_user_id, title, objective
      ) VALUES (
        'destroy-work-item', 'project-destroy', 'destroy-owner',
        'Delete this work', 'Verify project graph deletion'
      );
      INSERT INTO work_conversations (
        id, project_id, work_item_id, created_by_user_id,
        kind, provider, model
      ) VALUES (
        'destroy-conversation', 'project-destroy', 'destroy-work-item',
        'destroy-owner', 'planning', 'openai', 'gpt-test'
      );
      INSERT INTO work_messages (
        id, project_id, work_item_id, conversation_id,
        initiated_by_user_id, actor_type, actor_id, role,
        sequence, parts, client_message_id, request_fingerprint
      ) VALUES (
        'destroy-message', 'project-destroy', 'destroy-work-item',
        'destroy-conversation', 'destroy-owner', 'human', 'destroy-owner',
        'user', 1, '[{"type":"text","text":"Delete me"}]'::jsonb,
        'destroy-client-message', repeat('a', 64)
      );

      INSERT INTO usage_budget_policies (
        id, scope_type, scope_project_id, period, limit_tokens,
        created_by_user_id
      ) VALUES (
        'destroy-policy', 'project', 'project-destroy', 'monthly', 1000,
        'destroy-owner'
      );
      INSERT INTO usage_budget_threshold_notifications (
        id, policy_id, period_start, period_end, threshold_percentage,
        metric, consumed_usd, consumed_tokens, limit_tokens
      ) VALUES (
        'destroy-notification', 'destroy-policy',
        '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z', 50,
        'tokens', 0, 500, 1000
      );
    `);

    await expect(pg.query("DELETE FROM projects WHERE id = 'project-destroy'")).rejects.toThrow(
      /append-only/,
    );

    await pg.exec("SET ROLE norns_app");
    try {
      await expect(projects.destroy("project-destroy", "destroy-owner")).resolves.toBeUndefined();
    } finally {
      await pg.exec("RESET ROLE");
    }

    const remaining = await pg.query<{ project_count: number; message_count: number }>(`
      SELECT
        (SELECT count(*)::int FROM projects WHERE id='project-destroy') AS project_count,
        (SELECT count(*)::int FROM work_messages WHERE project_id='project-destroy') AS message_count,
        (SELECT count(*)::int FROM domain_events WHERE project_id='project-destroy') AS event_count,
        (SELECT count(*)::int FROM usage_budget_threshold_notifications WHERE id='destroy-notification') AS notification_count
    `);
    expect(remaining.rows[0]).toEqual({
      project_count: 0,
      message_count: 0,
      event_count: 0,
      notification_count: 0,
    });
    expect((await pg.query("SELECT id FROM users WHERE id='destroy-owner'")).rows).toHaveLength(1);
    await pg.exec("SET ROLE norns_app");
    try {
      await expect(projects.destroy("project-destroy", "destroy-owner")).rejects.toBeInstanceOf(
        ProjectNotFoundError,
      );
    } finally {
      await pg.exec("RESET ROLE");
    }
  });
});
