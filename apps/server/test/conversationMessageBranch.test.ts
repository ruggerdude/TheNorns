import { PGlite } from "@electric-sql/pglite";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresConversationRepository } from "../src/conversations/repository.js";
import {
  type ConversationRouteOptions,
  registerConversationRoutes,
} from "../src/conversations/routes.js";
import { ConversationService } from "../src/conversations/service.js";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import {
  CONVERSATION_MESSAGE_BRANCHES_MIGRATION_NAME,
  type V2MigrationDatabase,
  runCurrentV2Migrations,
} from "../src/persistence/v2/migrate.js";

const asMigrationDatabase = (database: PGlite): V2MigrationDatabase =>
  database as unknown as V2MigrationDatabase;

describe.sequential("conversation message branches", () => {
  let pg: PGlite;
  let service: ConversationService;
  let app: FastifyInstance;
  let idSequence = 0;

  const owner = { id: "branch-owner" };
  const member = { id: "branch-member" };
  const outsider = { id: "branch-outsider" };

  beforeAll(async () => {
    pg = new PGlite();
    await pg.exec("CREATE ROLE norns_app NOLOGIN");
    await runCurrentV2Migrations(asMigrationDatabase(pg));
    await pg.exec(`
      INSERT INTO users (
        id, username, display_name, email, name, password_hash,
        password_hash_scheme, role, status
      ) VALUES
        (
          'branch-owner', 'branch-owner@example.com', 'Owner',
          'branch-owner@example.com', 'Owner', 'hash', 'scrypt-v1',
          'member', 'active'
        ),
        (
          'branch-member', 'branch-member@example.com', 'Member',
          'branch-member@example.com', 'Member', 'hash', 'scrypt-v1',
          'member', 'active'
        ),
        (
          'branch-outsider', 'branch-outsider@example.com', 'Outsider',
          'branch-outsider@example.com', 'Outsider', 'hash', 'scrypt-v1',
          'member', 'active'
        );

      INSERT INTO projects (
        id, name, status, assignment_policy_ref, verification_policy_ref,
        budget_policy_ref, owner_user_id
      ) VALUES (
        'branch-project', 'Branch Project', 'active',
        'assignment/default', 'verification/default', 'budget/default',
        'branch-owner'
      );
      INSERT INTO project_members (
        project_id, user_id, status, added_by_user_id
      ) VALUES (
        'branch-project', 'branch-member', 'active', 'branch-owner'
      );

      INSERT INTO work_items (
        id, project_id, created_by_user_id, title, objective
      ) VALUES
        ('branch-work', 'branch-project', 'branch-owner', 'Editable chat', 'Branch safely'),
        ('special-work', 'branch-project', 'branch-owner', 'Special chat', 'Reject workflow copy'),
        ('task-work', 'branch-project', 'branch-owner', 'Task chat', 'Reject task branch'),
        ('archived-work', 'branch-project', 'branch-owner', 'Archived chat', 'Reject archive branch');

      INSERT INTO work_conversations (
        id, project_id, work_item_id, created_by_user_id,
        kind, status, provider, model, next_message_sequence, archived_at
      ) VALUES
        (
          'parent-conversation', 'branch-project', 'branch-work', 'branch-owner',
          'planning', 'active', 'openai', 'gpt-5.6-sol', 5, NULL
        ),
        (
          'special-conversation', 'branch-project', 'special-work', 'branch-owner',
          'planning', 'active', 'openai', 'gpt-5.6-sol', 3, NULL
        ),
        (
          'task-conversation', 'branch-project', 'task-work', 'branch-owner',
          'task', 'active', 'openai', 'gpt-5.6-sol', 2, NULL
        ),
        (
          'archived-conversation', 'branch-project', 'archived-work', 'branch-owner',
          'planning', 'archived', 'openai', 'gpt-5.6-sol', 2, now()
        );

      INSERT INTO attachment_blobs (sha256, content)
      VALUES (
        'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        decode('00', 'hex')
      );
      INSERT INTO attachments (
        id, project_id, sha256, mime, bytes, width, height, purpose,
        created_by, original_filename
      ) VALUES (
        'branch-attachment', 'branch-project',
        'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        'image/png', 1, 1, 1, 'conversation', 'branch-owner', 'context.png'
      );
    `);

    await pg.transaction(async (tx) => {
      await tx.exec(`
        INSERT INTO work_messages (
          id, project_id, work_item_id, conversation_id, initiated_by_user_id,
          actor_type, actor_id, role, visibility_status, sequence, parts,
          client_message_id, request_fingerprint, created_at
        ) VALUES
          (
            'prefix-user', 'branch-project', 'branch-work', 'parent-conversation',
            'branch-owner', 'human', 'branch-owner', 'user', 'complete', 1,
            '[
              {"type":"text","format":"plain","text":"Original context"},
              {
                "type":"attachment",
                "attachment_id":"branch-attachment",
                "name":"context.png",
                "media_type":"image/png"
              }
            ]'::jsonb,
            'prefix-client',
            '1111111111111111111111111111111111111111111111111111111111111111',
            '2026-01-01T00:00:00Z'
          ),
          (
            'prefix-assistant', 'branch-project', 'branch-work', 'parent-conversation',
            'branch-owner', 'agent', 'pm:parent', 'assistant', 'complete', 2,
            '[{"type":"text","format":"markdown","text":"Original answer"}]'::jsonb,
            NULL, NULL, '2026-01-01T00:01:00Z'
          ),
          (
            'edit-source', 'branch-project', 'branch-work', 'parent-conversation',
            'branch-owner', 'human', 'branch-owner', 'user', 'complete', 3,
            '[{"type":"text","format":"plain","text":"Text to replace"}]'::jsonb,
            'edit-client',
            '2222222222222222222222222222222222222222222222222222222222222222',
            '2026-01-01T00:02:00Z'
          ),
          (
            'after-source', 'branch-project', 'branch-work', 'parent-conversation',
            'branch-owner', 'agent', 'pm:parent', 'assistant', 'complete', 4,
            '[{"type":"text","format":"plain","text":"Excluded response"}]'::jsonb,
            NULL, NULL, '2026-01-01T00:03:00Z'
          ),
          (
            'special-plan', 'branch-project', 'special-work', 'special-conversation',
            'branch-owner', 'agent', 'pm:special', 'assistant', 'complete', 1,
            '[{"type":"plan","plan_version_id":"unsafe-plan"}]'::jsonb,
            NULL, NULL, '2026-01-02T00:00:00Z'
          ),
          (
            'special-source', 'branch-project', 'special-work', 'special-conversation',
            'branch-owner', 'human', 'branch-owner', 'user', 'complete', 2,
            '[{"type":"text","format":"plain","text":"Do not branch the plan"}]'::jsonb,
            'special-client',
            '3333333333333333333333333333333333333333333333333333333333333333',
            '2026-01-02T00:01:00Z'
          ),
          (
            'task-source', 'branch-project', 'task-work', 'task-conversation',
            'branch-owner', 'human', 'branch-owner', 'user', 'complete', 1,
            '[{"type":"text","format":"plain","text":"Task direction"}]'::jsonb,
            'task-client',
            '4444444444444444444444444444444444444444444444444444444444444444',
            '2026-01-03T00:00:00Z'
          ),
          (
            'archived-source', 'branch-project', 'archived-work', 'archived-conversation',
            'branch-owner', 'human', 'branch-owner', 'user', 'complete', 1,
            '[{"type":"text","format":"plain","text":"Archived direction"}]'::jsonb,
            'archived-client',
            '5555555555555555555555555555555555555555555555555555555555555555',
            '2026-01-04T00:00:00Z'
          );

        INSERT INTO work_message_attachment_refs (
          project_id, work_item_id, conversation_id, message_id,
          attachment_id, created_by_user_id
        ) VALUES (
          'branch-project', 'branch-work', 'parent-conversation', 'prefix-user',
          'branch-attachment', 'branch-owner'
        );
      `);
    });

    service = new ConversationService(
      new PostgresConversationRepository(new PGliteTransactionRunner(pg)),
      { newId: (prefix) => `${prefix}-branch-${++idSequence}` },
    );

    app = Fastify();
    registerConversationRoutes(app, {
      requireUser: async () => member,
      conversations: service,
      turns: {} as ConversationRouteOptions["turns"],
      attempts: {} as ConversationRouteOptions["attempts"],
      pinForProject: async () => ({ provider: "openai", model: "gpt-5.6-sol" }),
    });
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await pg.close();
  });

  it("applies append-only branch lineage with restricted grants", async () => {
    const migration = await pg.query<{ name: string }>(
      "SELECT name FROM norns_schema_migrations WHERE name=$1",
      [CONVERSATION_MESSAGE_BRANCHES_MIGRATION_NAME],
    );
    expect(migration.rows).toEqual([{ name: CONVERSATION_MESSAGE_BRANCHES_MIGRATION_NAME }]);

    const catalog = await pg.query<{
      relation: string | null;
      marker: string | null;
      message_branch: boolean;
      can_read: boolean;
      can_insert: boolean;
      can_update: boolean;
      can_delete: boolean;
    }>(
      `SELECT
         to_regclass('conversation_message_branches')::text AS relation,
         to_regclass('conversation_message_branches_v1')::text AS marker,
         EXISTS (
           SELECT 1
             FROM information_schema.columns
            WHERE table_name='work_conversations' AND column_name='message_branch'
         ) AS message_branch,
         has_table_privilege(
           'norns_app','conversation_message_branches','SELECT'
         ) AS can_read,
         has_table_privilege(
           'norns_app','conversation_message_branches','INSERT'
         ) AS can_insert,
         has_table_privilege(
           'norns_app','conversation_message_branches','UPDATE'
         ) AS can_update,
         has_table_privilege(
           'norns_app','conversation_message_branches','DELETE'
         ) AS can_delete`,
    );
    expect(catalog.rows[0]).toEqual({
      relation: "conversation_message_branches",
      marker: "conversation_message_branches_v1",
      message_branch: true,
      can_read: true,
      can_insert: true,
      can_update: false,
      can_delete: false,
    });

    await expect(
      pg.exec(`
        INSERT INTO work_conversations (
          id, project_id, work_item_id, created_by_user_id,
          kind, provider, model, message_branch
        ) VALUES (
          'lineage-less-child', 'branch-project', 'branch-work', 'branch-owner',
          'planning', 'openai', 'gpt-5.6-sol', true
        )
      `),
    ).rejects.toThrow(/require durable lineage/i);
  });

  it("branches a safe immutable prefix while leaving the parent untouched", async () => {
    const parentBefore = await service.getConversation(
      owner,
      "branch-project",
      "parent-conversation",
    );
    const messagesBefore = await service.listMessages(
      owner,
      "branch-project",
      "branch-work",
      "parent-conversation",
    );

    const created = await service.createConversationMessageBranch(
      member,
      "branch-project",
      "branch-work",
      "parent-conversation",
      { source_message_id: "edit-source" },
    );

    expect(created.conversation).toMatchObject({
      project_id: "branch-project",
      work_item_id: "branch-work",
      kind: "planning",
      status: "active",
      provider: "openai",
      model: "gpt-5.6-sol",
      next_message_sequence: 3,
    });
    expect(created.branch_lineage).toMatchObject({
      child_conversation_id: created.conversation.id,
      parent_conversation_id: "parent-conversation",
      source_message_id: "edit-source",
      created_by_user_id: member.id,
    });
    await expect(
      pg.query(
        `UPDATE conversation_message_branches
            SET source_message_id='prefix-user'
          WHERE id=$1`,
        [created.branch_lineage.id],
      ),
    ).rejects.toThrow(/immutable/i);

    const copied = await service.listMessages(
      member,
      "branch-project",
      "branch-work",
      created.conversation.id,
    );
    expect(copied).toHaveLength(2);
    expect(copied.map((message) => message.sequence)).toEqual([1, 2]);
    expect(copied.map((message) => message.id)).not.toContain("prefix-user");
    expect(copied.map((message) => message.parts)).toEqual(
      messagesBefore.slice(0, 2).map((message) => message.parts),
    );
    expect(copied[0]?.client_message_id).not.toBe("prefix-client");
    expect(copied.some((message) => message.id === "edit-source")).toBe(false);
    expect(copied.some((message) => message.id === "after-source")).toBe(false);

    const copiedRef = await pg.query<{
      conversation_id: string;
      attachment_id: string;
      created_by_user_id: string;
    }>(
      `SELECT conversation_id, attachment_id, created_by_user_id
         FROM work_message_attachment_refs
        WHERE conversation_id=$1`,
      [created.conversation.id],
    );
    expect(copiedRef.rows).toEqual([
      {
        conversation_id: created.conversation.id,
        attachment_id: "branch-attachment",
        created_by_user_id: member.id,
      },
    ]);

    const parentAfter = await service.getConversation(
      owner,
      "branch-project",
      "parent-conversation",
    );
    const messagesAfter = await service.listMessages(
      owner,
      "branch-project",
      "branch-work",
      "parent-conversation",
    );
    expect(parentAfter.conversation).toEqual(parentBefore.conversation);
    expect(messagesAfter).toEqual(messagesBefore);

    const durableObjects = await pg.query<{ actions: number; plans: number }>(
      `SELECT
         (
           SELECT count(*)::int FROM conversation_actions
            WHERE conversation_id=$1
         ) AS actions,
         (
           SELECT count(*)::int FROM work_plan_versions
            WHERE conversation_id=$1
         ) AS plans`,
      [created.conversation.id],
    );
    expect(durableObjects.rows[0]).toEqual({ actions: 0, plans: 0 });
  });

  it("exposes branch lineage in conversation list and detail reads", async () => {
    const conversations = await service.listConversations(owner, "branch-project", "branch-work");
    const branch = conversations.find((conversation) => conversation.branch_lineage !== null);
    expect(branch?.branch_lineage).toMatchObject({
      parent_conversation_id: "parent-conversation",
      source_message_id: "edit-source",
    });

    const detail = await service.getConversation(owner, "branch-project", branch?.id ?? "");
    expect(detail.branch_lineage).toEqual(branch?.branch_lineage);
  });

  it("fails closed for unsafe sources, prefixes, scopes, and inactive conversations", async () => {
    await expect(
      service.createConversationMessageBranch(
        owner,
        "branch-project",
        "branch-work",
        "parent-conversation",
        { source_message_id: "prefix-assistant" },
      ),
    ).rejects.toMatchObject({ code: "conversation_branch_unsafe" });

    await expect(
      service.createConversationMessageBranch(
        owner,
        "branch-project",
        "branch-work",
        "parent-conversation",
        { source_message_id: "special-source" },
      ),
    ).rejects.toMatchObject({ code: "message_not_found", httpStatus: 404 });

    await expect(
      service.createConversationMessageBranch(
        owner,
        "branch-project",
        "special-work",
        "special-conversation",
        { source_message_id: "special-source" },
      ),
    ).rejects.toMatchObject({ code: "conversation_branch_unsafe" });

    await expect(
      service.createConversationMessageBranch(
        owner,
        "branch-project",
        "task-work",
        "task-conversation",
        { source_message_id: "task-source" },
      ),
    ).rejects.toMatchObject({ code: "conversation_kind_forbidden" });

    await expect(
      service.createConversationMessageBranch(
        owner,
        "branch-project",
        "archived-work",
        "archived-conversation",
        { source_message_id: "archived-source" },
      ),
    ).rejects.toMatchObject({ code: "conversation_inactive" });

    await expect(
      service.createConversationMessageBranch(
        outsider,
        "branch-project",
        "branch-work",
        "parent-conversation",
        { source_message_id: "edit-source" },
      ),
    ).rejects.toMatchObject({ code: "forbidden", httpStatus: 403 });
  });

  it("creates a sibling branch through the authenticated HTTP route", async () => {
    const response = await app.inject({
      method: "POST",
      url:
        "/api/v2/projects/branch-project/work-items/branch-work/" +
        "conversations/parent-conversation/branches",
      payload: { source_message_id: "edit-source" },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      conversation: {
        kind: "planning",
        status: "active",
        provider: "openai",
        model: "gpt-5.6-sol",
      },
      branch_lineage: {
        parent_conversation_id: "parent-conversation",
        source_message_id: "edit-source",
        created_by_user_id: member.id,
      },
    });
  });

  it("rejects branching while parent conversation work is active", async () => {
    await pg.exec(`
      INSERT INTO conversation_plan_proposal_attempts (
        id, project_id, work_item_id, conversation_id, initiated_by_user_id,
        idempotency_key, request_fingerprint, source_message_id,
        provider, model, usage_request_id, context_manifest, context_hash, started_at
      ) VALUES (
        'active-branch-proposal', 'branch-project', 'branch-work',
        'parent-conversation', 'branch-owner',
        'active-branch-key',
        '6666666666666666666666666666666666666666666666666666666666666666',
        'edit-source', 'openai', 'gpt-5.6-sol', 'active-branch-usage',
        '{"entries":[],"estimated_tokens":0}'::jsonb,
        '7777777777777777777777777777777777777777777777777777777777777777',
        now()
      )
    `);

    await expect(
      service.createConversationMessageBranch(
        owner,
        "branch-project",
        "branch-work",
        "parent-conversation",
        { source_message_id: "edit-source" },
      ),
    ).rejects.toMatchObject({ code: "turn_in_progress" });
  });
});
