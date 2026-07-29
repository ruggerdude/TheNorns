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
  CONVERSATION_ORGANIZATION_MIGRATION_NAME,
  type V2MigrationDatabase,
  runCurrentV2Migrations,
} from "../src/persistence/v2/migrate.js";

const asMigrationDatabase = (database: PGlite): V2MigrationDatabase =>
  database as unknown as V2MigrationDatabase;

describe.sequential("conversation organization", () => {
  let pg: PGlite;
  let service: ConversationService;
  let app: FastifyInstance;
  let idSequence = 0;

  const owner = { id: "organization-owner" };
  const member = { id: "organization-member" };
  const outsider = { id: "organization-outsider" };

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
          'organization-owner', 'organization-owner@example.com', 'Owner',
          'organization-owner@example.com', 'Owner', 'hash', 'scrypt-v1',
          'member', 'active'
        ),
        (
          'organization-member', 'organization-member@example.com', 'Member',
          'organization-member@example.com', 'Member', 'hash', 'scrypt-v1',
          'member', 'active'
        ),
        (
          'organization-outsider', 'organization-outsider@example.com', 'Outsider',
          'organization-outsider@example.com', 'Outsider', 'hash', 'scrypt-v1',
          'member', 'active'
        );

      INSERT INTO projects (
        id, name, status, assignment_policy_ref, verification_policy_ref,
        budget_policy_ref, owner_user_id
      ) VALUES (
        'organization-project', 'Organization Project', 'active',
        'assignment/default', 'verification/default', 'budget/default',
        'organization-owner'
      );

      INSERT INTO project_members (
        project_id, user_id, status, added_by_user_id
      ) VALUES (
        'organization-project', 'organization-member', 'active', 'organization-owner'
      );

      INSERT INTO work_items (
        id, project_id, created_by_user_id, title, objective, created_at, updated_at
      ) VALUES
        (
          'work-newest', 'organization-project', 'organization-owner',
          'Newest visible activity', 'Newest objective',
          '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
        ),
        (
          'work-pinned', 'organization-project', 'organization-owner',
          'Pinned chat', 'Pinned objective',
          '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z'
        ),
        (
          'work-no-message', 'organization-project', 'organization-owner',
          'No-message chat', 'No-message objective',
          '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'
        );

      INSERT INTO work_conversations (
        id, project_id, work_item_id, created_by_user_id,
        kind, provider, model, created_at, updated_at
      ) VALUES
        (
          'conversation-newest', 'organization-project', 'work-newest',
          'organization-owner', 'planning', 'openai', 'gpt-5.6-sol',
          '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
        ),
        (
          'conversation-pinned', 'organization-project', 'work-pinned',
          'organization-owner', 'planning', 'openai', 'gpt-5.6-sol',
          '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z'
        );

      INSERT INTO work_messages (
        id, project_id, work_item_id, conversation_id, initiated_by_user_id,
        actor_type, actor_id, role, visibility_status, sequence, parts,
        client_message_id, request_fingerprint, created_at
      ) VALUES
        (
          'message-newest', 'organization-project', 'work-newest',
          'conversation-newest', 'organization-owner',
          'human', 'organization-owner', 'user', 'complete', 1,
          '[{"type":"text","format":"plain","text":"Newest"}]'::jsonb,
          'client-newest',
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          '2026-03-03T00:00:00Z'
        ),
        (
          'message-pinned', 'organization-project', 'work-pinned',
          'conversation-pinned', 'organization-owner',
          'human', 'organization-owner', 'user', 'complete', 1,
          '[{"type":"text","format":"plain","text":"Pinned"}]'::jsonb,
          'client-pinned',
          'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          '2026-03-02T00:00:00Z'
        );
    `);

    service = new ConversationService(
      new PostgresConversationRepository(new PGliteTransactionRunner(pg)),
      { newId: (prefix) => `${prefix}-organization-${++idSequence}` },
    );

    app = Fastify();
    registerConversationRoutes(app, {
      requireUser: async () => owner,
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

  it("applies the additive organization schema with restricted runtime grants", async () => {
    const migrations = await pg.query<{ name: string }>(
      "SELECT name FROM norns_schema_migrations WHERE name=$1",
      [CONVERSATION_ORGANIZATION_MIGRATION_NAME],
    );
    expect(migrations.rows).toEqual([{ name: CONVERSATION_ORGANIZATION_MIGRATION_NAME }]);

    const catalog = await pg.query<{
      folders: string | null;
      preferences: string | null;
      marker: string | null;
      can_read: boolean;
      can_write: boolean;
      can_delete_preferences: boolean;
    }>(
      `SELECT
         to_regclass('conversation_folders')::text AS folders,
         to_regclass('work_item_organization_preferences')::text AS preferences,
         to_regclass('conversation_organization_v1')::text AS marker,
         has_table_privilege('norns_app','conversation_folders','SELECT') AS can_read,
         has_table_privilege(
           'norns_app','work_item_organization_preferences','UPDATE'
         ) AS can_write,
         has_table_privilege(
           'norns_app','work_item_organization_preferences','DELETE'
         ) AS can_delete_preferences`,
    );
    expect(catalog.rows[0]).toEqual({
      folders: "conversation_folders",
      preferences: "work_item_organization_preferences",
      marker: "conversation_organization_v1",
      can_read: true,
      can_write: true,
      can_delete_preferences: false,
    });
  });

  it("keeps folders private per user and enforces case-insensitive names", async () => {
    const ownerFolder = await service.createConversationFolder(owner, "organization-project", {
      name: "Research",
    });
    const ownerSecond = await service.createConversationFolder(owner, "organization-project", {
      name: "Delivery",
    });
    const memberFolder = await service.createConversationFolder(member, "organization-project", {
      name: "Research",
    });

    expect(ownerFolder.user_id).toBe(owner.id);
    expect(memberFolder.user_id).toBe(member.id);
    await expect(
      service.createConversationFolder(owner, "organization-project", { name: "research" }),
    ).rejects.toMatchObject({
      code: "conversation_folder_name_conflict",
      httpStatus: 409,
    });
    await expect(
      service.createConversationFolder(outsider, "organization-project", { name: "Forbidden" }),
    ).rejects.toMatchObject({ code: "forbidden" });

    const reordered = await service.reorderConversationFolders(owner, "organization-project", {
      folder_ids: [ownerSecond.id, ownerFolder.id],
    });
    expect(reordered.map(({ id, sort_order }) => [id, sort_order])).toEqual([
      [ownerSecond.id, 0],
      [ownerFolder.id, 1],
    ]);
    await expect(
      service.reorderConversationFolders(owner, "organization-project", {
        folder_ids: [ownerFolder.id],
      }),
    ).rejects.toMatchObject({ code: "conversation_folder_order_invalid" });

    const renamed = await service.updateConversationFolder(
      owner,
      "organization-project",
      ownerSecond.id,
      { name: "Launch" },
    );
    expect(renamed.name).toBe("Launch");
    await expect(
      service.updateConversationFolder(owner, "organization-project", ownerSecond.id, {
        name: "RESEARCH",
      }),
    ).rejects.toMatchObject({ code: "conversation_folder_name_conflict" });
  });

  it("pins and files chat families without leaking preferences between users", async () => {
    const ownerNavigation = await service.conversationNavigation(owner, "organization-project", 10);
    const research = ownerNavigation.folders.find((folder) => folder.name === "Research");
    expect(research).toBeDefined();

    const organization = await service.updateWorkItemOrganization(
      owner,
      "organization-project",
      "work-pinned",
      { folder_id: research?.id, pinned: true },
    );
    expect(organization).toMatchObject({
      user_id: owner.id,
      work_item_id: "work-pinned",
      folder_id: research?.id,
    });
    expect(organization.pinned_at).not.toBeNull();
    const replayedPin = await service.updateWorkItemOrganization(
      owner,
      "organization-project",
      "work-pinned",
      { pinned: true },
    );
    expect(replayedPin.pinned_at).toBe(organization.pinned_at);

    const ownerPage = await service.conversationNavigation(owner, "organization-project", 2);
    expect(ownerPage.items.map((item) => item.id)).toEqual(["work-pinned", "work-newest"]);
    expect(ownerPage.items[0]).toMatchObject({
      folder_id: research?.id,
      latest_activity_at: "2026-03-02T00:00:00.000Z",
      conversation_count: 1,
      latest_conversation: {
        id: "conversation-pinned",
        kind: "planning",
      },
    });
    expect(ownerPage.next_cursor).toEqual(expect.any(String));

    const nextPage = await service.conversationNavigation(
      owner,
      "organization-project",
      2,
      ownerPage.next_cursor ?? undefined,
    );
    expect(nextPage.items.map((item) => item.id)).toEqual(["work-no-message"]);
    expect(nextPage.next_cursor).toBeNull();

    const memberPage = await service.conversationNavigation(member, "organization-project", 10);
    expect(memberPage.items.map((item) => item.id)).toEqual([
      "work-newest",
      "work-pinned",
      "work-no-message",
    ]);
    expect(memberPage.items.find((item) => item.id === "work-pinned")).toMatchObject({
      folder_id: null,
      pinned_at: null,
    });
    await expect(
      service.conversationNavigation(owner, "organization-project", 10, "not-a-cursor"),
    ).rejects.toMatchObject({ code: "invalid_navigation_cursor", httpStatus: 400 });
  });

  it("deletes folders non-destructively by unfiling their chat families", async () => {
    const before = await service.conversationNavigation(owner, "organization-project", 10);
    const research = before.folders.find((folder) => folder.name === "Research");
    expect(research).toBeDefined();

    const deleted = await service.deleteConversationFolder(
      owner,
      "organization-project",
      research?.id ?? "",
    );
    expect(deleted).toEqual({
      deleted_folder_id: research?.id,
      unfiled_work_item_count: 1,
    });

    const after = await service.conversationNavigation(owner, "organization-project", 10);
    expect(after.folders.some((folder) => folder.id === research?.id)).toBe(false);
    expect(after.items.find((item) => item.id === "work-pinned")).toMatchObject({
      folder_id: null,
      pinned_at: expect.any(String),
    });
  });

  it("exposes organization through authenticated HTTP routes", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/api/v2/projects/organization-project/conversation-folders",
      payload: { name: "API folder" },
    });
    expect(create.statusCode).toBe(201);
    const folder = create.json().folder as { id: string };

    const move = await app.inject({
      method: "PATCH",
      url: "/api/v2/projects/organization-project/work-items/work-newest/organization",
      payload: { folder_id: folder.id, pinned: true },
    });
    expect(move.statusCode).toBe(200);
    expect(move.json().organization).toMatchObject({
      work_item_id: "work-newest",
      folder_id: folder.id,
    });

    const navigation = await app.inject({
      method: "GET",
      url: "/api/v2/projects/organization-project/conversation-navigation?limit=1",
    });
    expect(navigation.statusCode).toBe(200);
    expect(navigation.json()).toMatchObject({
      folders: expect.arrayContaining([expect.objectContaining({ id: folder.id })]),
      items: [expect.objectContaining({ id: "work-newest" })],
      next_cursor: expect.any(String),
    });
  });
});
