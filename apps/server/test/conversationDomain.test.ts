import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresConversationRepository } from "../src/conversations/repository.js";
import { ConversationService } from "../src/conversations/service.js";
import { canonicalSha256 } from "../src/persistence/migration/canonicalJson.js";
import { assertCurrentRuntimeSchema } from "../src/persistence/postgresConnection.js";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";

const asMigrationDatabase = (database: PGlite): V2MigrationDatabase =>
  database as unknown as V2MigrationDatabase;

describe.sequential("conversation-first durable domain", () => {
  let pg: PGlite;
  let service: ConversationService;
  let workItemId: string;
  let conversationId: string;
  let firstMessageId: string;
  let idSequence = 0;

  const owner = { id: "conversation-owner" };
  const member = { id: "conversation-member" };
  const outsider = { id: "conversation-outsider" };

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
          'conversation-owner', 'conversation-owner@example.com', 'Owner',
          'conversation-owner@example.com', 'Owner', 'hash', 'scrypt-v1',
          'member', 'active'
        ),
        (
          'conversation-member', 'conversation-member@example.com', 'Member',
          'conversation-member@example.com', 'Member', 'hash', 'scrypt-v1',
          'member', 'active'
        ),
        (
          'conversation-outsider', 'conversation-outsider@example.com', 'Outsider',
          'conversation-outsider@example.com', 'Outsider', 'hash', 'scrypt-v1',
          'member', 'active'
        );

      INSERT INTO projects (
        id, name, status, assignment_policy_ref, verification_policy_ref,
        budget_policy_ref, owner_user_id
      ) VALUES
        (
          'conversation-project', 'Conversation Project', 'active',
          'assignment/default', 'verification/default', 'budget/default',
          'conversation-owner'
        ),
        (
          'other-conversation-project', 'Other Project', 'active',
          'assignment/default', 'verification/default', 'budget/default',
          'conversation-outsider'
        );

      INSERT INTO project_members (
        project_id, user_id, status, added_by_user_id
      ) VALUES (
        'conversation-project', 'conversation-member', 'active', 'conversation-owner'
      );
    `);

    service = new ConversationService(
      new PostgresConversationRepository(new PGliteTransactionRunner(pg)),
      {
        newId: (prefix) => `${prefix}-${++idSequence}`,
      },
    );
  }, 60_000);

  afterAll(async () => {
    await pg.close();
  });

  it("applies and replays the complete ordered migration with restricted grants", async () => {
    const tables = await pg.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema='public'
          AND table_name IN (
            'work_items',
            'work_conversations',
            'work_messages',
            'conversation_turn_attempts',
            'conversation_actions',
            'work_plan_versions',
            'conversation_handoffs',
            'conversation_summaries'
          )
        ORDER BY table_name`,
    );
    expect(tables.rows.map((row) => row.table_name)).toHaveLength(8);

    const attribution = await pg.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.columns
        WHERE table_schema='public'
          AND column_name IN ('created_by_user_id', 'initiated_by_user_id')
          AND table_name IN (
            'work_items',
            'work_conversations',
            'work_messages',
            'conversation_turn_attempts',
            'conversation_actions',
            'work_plan_versions',
            'conversation_handoffs',
            'conversation_summaries'
          )`,
    );
    expect(new Set(attribution.rows.map((row) => row.table_name)).size).toBe(8);

    const privileges = await pg.query<{
      can_read: boolean;
      can_write_message: boolean;
      can_delete_message: boolean;
      can_update_handoff: boolean;
    }>(
      `SELECT
         has_table_privilege('norns_app','work_items','SELECT') AS can_read,
         has_table_privilege('norns_app','work_messages','INSERT') AS can_write_message,
         has_table_privilege('norns_app','work_messages','DELETE') AS can_delete_message,
         has_table_privilege('norns_app','conversation_handoffs','UPDATE')
           AS can_update_handoff`,
    );
    expect(privileges.rows[0]).toEqual({
      can_read: true,
      can_write_message: true,
      can_delete_message: false,
      can_update_handoff: false,
    });

    const triggerRows = await pg.query<{ tgname: string }>(
      `SELECT tgname
         FROM pg_trigger
        WHERE NOT tgisinternal
          AND tgname IN (
            'work_messages_immutable_truncate_guard',
            'work_messages_attachment_refs_guard',
            'attachments_conversation_retention_guard',
            'conversation_turn_attempts_lifecycle_guard',
            'conversation_turn_attempts_usage_request_guard',
            'conversation_actions_lifecycle_guard',
            'work_plan_versions_content_guard',
            'work_items_approved_plan_guard',
            'conversation_handoffs_approved_plan_guard',
            'conversation_handoffs_immutable_guard'
          )
        ORDER BY tgname`,
    );
    expect(triggerRows.rows.map((row) => row.tgname)).toHaveLength(10);
    const constraintRows = await pg.query<{ conname: string }>(
      `SELECT conname
         FROM pg_constraint
        WHERE conname IN (
          'work_items_approved_plan_scope_fk',
          'work_message_attachment_refs_attachment_scope_fk',
          'conversation_turn_attempts_terminal_usage_check',
          'conversation_actions_delivery_shape_check',
          'work_plan_versions_approval_shape_check',
          'conversation_handoffs_approved_plan_scope_fk'
        )
        ORDER BY conname`,
    );
    expect(constraintRows.rows.map((row) => row.conname)).toHaveLength(6);

    await expect(
      assertCurrentRuntimeSchema(pg as unknown as Parameters<typeof assertCurrentRuntimeSchema>[0]),
    ).resolves.toBeUndefined();
    const replay = await runCurrentV2Migrations(asMigrationDatabase(pg));
    expect(replay.at(-1)).toMatchObject({
      name: "0035_conversation_domain",
      applied: false,
    });
  });

  it("authorizes project members without leaking conversations to outsiders", async () => {
    const item = await service.createWorkItem(owner, {
      project_id: "conversation-project",
      title: "Conversation-first work",
      objective: "Build the durable foundation.",
    });
    workItemId = item.id;
    expect(item.created_by_user_id).toBe(owner.id);

    const conversation = await service.createConversation(member, {
      project_id: "conversation-project",
      work_item_id: item.id,
      kind: "planning",
      provider: "openai",
      model: "gpt-5.6-sol",
    });
    conversationId = conversation.id;
    expect(conversation.created_by_user_id).toBe(member.id);

    await expect(
      service.listMessages(outsider, "conversation-project", workItemId, conversationId),
    ).rejects.toMatchObject({
      code: "forbidden",
      httpStatus: 403,
    });
    await expect(
      service.createConversation(outsider, {
        project_id: "conversation-project",
        work_item_id: item.id,
        kind: "task",
        provider: "openai",
        model: "gpt-5.6-sol",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      service.createConversation(member, {
        project_id: "conversation-project",
        work_item_id: item.id,
        kind: "execution_pm",
        provider: "openai",
        model: "gpt-5.6-sol",
      }),
    ).rejects.toMatchObject({ code: "conversation_kind_forbidden" });
    await expect(
      service.createInternalConversation(
        {
          initiatedByUserId: owner.id,
          actor: { actor_type: "coordinator", actor_id: "approval-bridge" },
        },
        {
          project_id: "conversation-project",
          work_item_id: item.id,
          kind: "task",
          provider: "openai",
          model: "gpt-5.6-sol",
        },
      ),
    ).rejects.toMatchObject({ code: "approved_plan_required" });
  });

  it("assigns stable row-locked order and makes user submission idempotent", async () => {
    const parts = [{ type: "text" as const, format: "markdown" as const, text: "Plan this." }];
    const requestFingerprint = canonicalSha256({ parts });
    const first = await service.submitUserMessage(member, {
      project_id: "conversation-project",
      work_item_id: workItemId,
      conversation_id: conversationId,
      client_message_id: "client-message-1",
      parts,
    });
    firstMessageId = first.id;
    expect(first.sequence).toBe(1);
    expect(first.request_fingerprint).toBe(requestFingerprint);

    const replay = await service.submitUserMessage(member, {
      project_id: "conversation-project",
      work_item_id: workItemId,
      conversation_id: conversationId,
      client_message_id: "client-message-1",
      parts,
    });
    expect(replay).toEqual(first);

    const otherParts = [
      { type: "text" as const, format: "plain" as const, text: "A different request." },
    ];
    await expect(
      service.submitUserMessage(member, {
        project_id: "conversation-project",
        work_item_id: workItemId,
        conversation_id: conversationId,
        client_message_id: "client-message-1",
        parts: otherParts,
      }),
    ).rejects.toMatchObject({
      code: "idempotency_conflict",
      httpStatus: 409,
    });

    const submitted = await Promise.all(
      ["Second", "Third", "Fourth"].map((text, index) => {
        const concurrentParts = [{ type: "text" as const, format: "plain" as const, text }];
        return service.submitUserMessage(member, {
          project_id: "conversation-project",
          work_item_id: workItemId,
          conversation_id: conversationId,
          client_message_id: `client-message-${index + 2}`,
          parts: concurrentParts,
        });
      }),
    );
    expect(submitted.map((message) => message.sequence).sort()).toEqual([2, 3, 4]);
    expect(
      (await service.listMessages(member, "conversation-project", workItemId, conversationId)).map(
        (message) => message.sequence,
      ),
    ).toEqual([1, 2, 3, 4]);
  });

  it("keeps final visible messages immutable and rejects hidden content", async () => {
    await expect(
      pg.query(
        `UPDATE work_messages SET parts='[{"type":"text","text":"changed"}]'::jsonb
          WHERE id=$1`,
        [firstMessageId],
      ),
    ).rejects.toThrow(/user messages are immutable/);
    await expect(
      pg.query("DELETE FROM work_messages WHERE id=$1", [firstMessageId]),
    ).rejects.toThrow(/user messages are immutable/);
    await expect(pg.query("TRUNCATE work_messages CASCADE")).rejects.toThrow(/append-only/);

    const sequence = await pg.query<{ sequence: number }>(
      `UPDATE work_conversations
          SET next_message_sequence=next_message_sequence+1
        WHERE id=$1
       RETURNING next_message_sequence-1 AS sequence`,
      [conversationId],
    );
    await pg.query(
      `INSERT INTO work_messages (
         id, project_id, work_item_id, conversation_id, initiated_by_user_id,
         actor_type, actor_id, role, visibility_status, sequence, parts
       ) VALUES (
         'assistant-draft','conversation-project',$1,$2,'conversation-member',
         'agent','pm-1','assistant','streaming',$3,
         '[{"type":"text","format":"markdown","text":"Visible draft"}]'::jsonb
       )`,
      [workItemId, conversationId, sequence.rows[0]?.sequence],
    );
    await pg.query(
      `UPDATE work_messages
          SET parts='[{"type":"text","format":"markdown","text":"Visible final"}]'::jsonb,
              visibility_status='complete'
        WHERE id='assistant-draft'`,
    );
    await expect(
      pg.query(
        `UPDATE work_messages
            SET parts='[{"type":"text","format":"markdown","text":"Rewritten"}]'::jsonb
          WHERE id='assistant-draft'`,
      ),
    ).rejects.toThrow(/finalized visible messages are immutable/);

    const hiddenSequence = await pg.query<{ sequence: number }>(
      `UPDATE work_conversations
          SET next_message_sequence=next_message_sequence+1
        WHERE id=$1
       RETURNING next_message_sequence-1 AS sequence`,
      [conversationId],
    );
    await expect(
      pg.query(
        `INSERT INTO work_messages (
           id, project_id, work_item_id, conversation_id, initiated_by_user_id,
           actor_type, actor_id, role, visibility_status, sequence, parts
         ) VALUES (
           'hidden-message','conversation-project',$1,$2,'conversation-member',
           'agent','pm-1','assistant','complete',$3,
           '[{"type":"reasoning","text":"not visible"}]'::jsonb
         )`,
        [workItemId, conversationId, hiddenSequence.rows[0]?.sequence],
      ),
    ).rejects.toThrow(/not user-visible/);
  });

  it("normalizes attachment references and retains conversation evidence", async () => {
    await pg.exec(`
      INSERT INTO attachment_blobs (sha256, content)
      VALUES (repeat('b',64), decode('89504e470d0a1a0a','hex'));
      INSERT INTO attachments (
        id, project_id, sha256, mime, bytes, purpose, created_by
      ) VALUES (
        'conversation-attachment', 'conversation-project', repeat('b',64),
        'image/png', 8, 'conversation', 'conversation-member'
      );
    `);
    const parts = [
      {
        type: "attachment" as const,
        attachment_id: "conversation-attachment",
        name: "mockup.png",
        media_type: "image/png",
      },
    ];
    const message = await service.submitUserMessage(member, {
      project_id: "conversation-project",
      work_item_id: workItemId,
      conversation_id: conversationId,
      client_message_id: "client-message-attachment",
      parts,
    });
    const refs = await pg.query<{ attachment_id: string }>(
      "SELECT attachment_id FROM work_message_attachment_refs WHERE message_id=$1",
      [message.id],
    );
    expect(refs.rows).toEqual([{ attachment_id: "conversation-attachment" }]);
    await expect(
      pg.query("UPDATE attachments SET deleted_at=now() WHERE id='conversation-attachment'"),
    ).rejects.toThrow(/cannot be deleted/);

    await pg.exec(`
      INSERT INTO attachment_blobs (sha256, content)
      VALUES (repeat('c',64), '\\x02'::bytea);
      INSERT INTO attachments (
        id, project_id, sha256, mime, bytes, purpose, deleted_at
      ) VALUES (
        'deleted-conversation-attachment', 'conversation-project', repeat('c',64),
        'image/png', 1, 'objective', now()
      );
    `);
    const deletedParts = [
      {
        type: "attachment" as const,
        attachment_id: "deleted-conversation-attachment",
        name: "deleted.png",
        media_type: "image/png",
      },
    ];
    await expect(
      service.submitUserMessage(member, {
        project_id: "conversation-project",
        work_item_id: workItemId,
        conversation_id: conversationId,
        client_message_id: "client-message-deleted-attachment",
        parts: deletedParts,
      }),
    ).rejects.toThrow(/durable live references/);
  });

  it("confirms explicit actions exactly once and detects key conflicts", async () => {
    const proposal = await service.proposeAction(member, {
      project_id: "conversation-project",
      work_item_id: workItemId,
      conversation_id: conversationId,
      source_message_id: firstMessageId,
      action_type: "send_plan_to_qc",
      payload: { parameters: { plan_version_id: "plan-1" } },
    });
    expect(proposal.actor).toEqual({ actor_type: "human", actor_id: member.id });
    const confirmation = {
      project_id: "conversation-project",
      work_item_id: workItemId,
      conversation_id: conversationId,
      action_id: proposal.id,
      idempotency_key: "confirm-action-1",
    };
    const [confirmed, concurrentReplay] = await Promise.all([
      service.confirmAction(member, confirmation),
      service.confirmAction(member, confirmation),
    ]);
    expect(confirmed).toMatchObject({
      status: "confirmed",
      confirmed_by_user_id: member.id,
      confirmation_idempotency_key: "confirm-action-1",
      confirmation_request_fingerprint: canonicalSha256({
        action_id: proposal.id,
        action_type: proposal.action_type,
        payload_hash: proposal.payload_hash,
      }),
    });
    expect(concurrentReplay).toEqual(confirmed);
    expect(await service.confirmAction(member, confirmation)).toEqual(confirmed);

    const another = await service.proposeAction(member, {
      project_id: "conversation-project",
      work_item_id: workItemId,
      conversation_id: conversationId,
      source_message_id: firstMessageId,
      action_type: "approve_plan",
      payload: { parameters: { plan_version_id: "plan-1" } },
    });
    await expect(
      service.confirmAction(member, {
        ...confirmation,
        action_id: another.id,
      }),
    ).rejects.toMatchObject({
      code: "idempotency_conflict",
      httpStatus: 409,
    });
    await expect(
      pg.query(
        `UPDATE conversation_actions
            SET payload='{"parameters":{"plan_version_id":"tampered"}}'::jsonb
          WHERE id=$1`,
        [proposal.id],
      ),
    ).rejects.toThrow(/proposal identity and payload are immutable/);
    await expect(
      pg.query("UPDATE conversation_actions SET id='renamed-action' WHERE id=$1", [proposal.id]),
    ).rejects.toThrow(/proposal identity and payload are immutable/);
    await expect(
      pg.query(
        `UPDATE conversation_actions
            SET status='sent', recorded_at=now(), sent_at=now()
          WHERE id=$1`,
        [proposal.id],
      ),
    ).rejects.toThrow(/invalid conversation action status transition/);
    await pg.query(
      `UPDATE conversation_actions
          SET status='recorded', recorded_at=now(), updated_at=now()
        WHERE id=$1`,
      [proposal.id],
    );
    await expect(
      pg.query(
        `UPDATE conversation_actions
            SET sent_at=now()
          WHERE id=$1`,
        [proposal.id],
      ),
    ).rejects.toThrow(/delivery evidence changes only with status/);
  });

  it("returns a clean idempotency conflict when different actions race on one key", async () => {
    const concurrentFirst = await service.proposeAction(member, {
      project_id: "conversation-project",
      work_item_id: workItemId,
      conversation_id: conversationId,
      source_message_id: firstMessageId,
      action_type: "pause_work",
      payload: { parameters: {} },
    });
    const concurrentSecond = await service.proposeAction(member, {
      project_id: "conversation-project",
      work_item_id: workItemId,
      conversation_id: conversationId,
      source_message_id: firstMessageId,
      action_type: "resume_work",
      payload: { parameters: {} },
    });
    const concurrentKey = "confirm-action-concurrent-conflict";
    const concurrentResults = await Promise.allSettled(
      [concurrentFirst, concurrentSecond].map((action) =>
        service.confirmAction(member, {
          project_id: "conversation-project",
          work_item_id: workItemId,
          conversation_id: conversationId,
          action_id: action.id,
          idempotency_key: concurrentKey,
        }),
      ),
    );
    expect(concurrentResults.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const conflict = concurrentResults.find((result) => result.status === "rejected");
    expect(conflict).toMatchObject({
      status: "rejected",
      reason: {
        code: "idempotency_conflict",
        httpStatus: 409,
      },
    });
  });

  it("allows plan lifecycle updates without allowing plan-content mutation", async () => {
    const storedPlan = {
      plan: { objective: "Durable plan", modules: [{ id: "phase-1" }] },
      staffing: [
        {
          module_id: "phase-1",
          agent_role: "implementation",
          provider: "openai",
          model: "gpt-5.6-sol",
        },
      ],
      estimated_budget: { currency: "USD", amount: 0 },
    };
    await pg.query(
      `INSERT INTO work_plan_versions (
         id, project_id, work_item_id, conversation_id, created_by_user_id,
         version, status, plan, content_hash
       ) VALUES (
         'work-plan-1','conversation-project',$1,$2,'conversation-member',
         1,'candidate',$3::jsonb,$4
       )`,
      [workItemId, conversationId, JSON.stringify(storedPlan), canonicalSha256(storedPlan)],
    );
    await pg.query(
      "UPDATE work_plan_versions SET status='in_qc', updated_at=now() WHERE id='work-plan-1'",
    );
    await pg.query(
      `UPDATE work_plan_versions
          SET status='approved',
              approved_by_user_id='conversation-owner',
              approved_at=now(),
              updated_at=now()
        WHERE id='work-plan-1'`,
    );
    await expect(
      pg.query(
        `UPDATE work_plan_versions
            SET plan='{"plan":{"objective":"mutated"}}'::jsonb
          WHERE id='work-plan-1'`,
      ),
    ).rejects.toThrow(/content, hash, lineage, and identity are immutable/);
    await expect(
      pg.query(
        `UPDATE work_plan_versions
            SET id='renamed-work-plan'
          WHERE id='work-plan-1'`,
      ),
    ).rejects.toThrow(/content, hash, lineage, and identity are immutable/);

    await pg.query(
      `INSERT INTO work_plan_versions (
         id, project_id, work_item_id, conversation_id, created_by_user_id,
         version, status, plan, content_hash, supersedes_plan_version_id,
         diff_from_previous
       ) VALUES (
         'work-plan-2','conversation-project',$1,$2,'conversation-member',
         2,'candidate',$3::jsonb,$4,'work-plan-1',
         '{"added":[],"removed":[],"changed":["objective"]}'::jsonb
       )`,
      [workItemId, conversationId, JSON.stringify(storedPlan), canonicalSha256(storedPlan)],
    );
    await expect(
      pg.query(
        `UPDATE work_plan_versions
            SET status='approved',
                approved_by_user_id='conversation-owner',
                approved_at=now()
          WHERE id='work-plan-2'`,
      ),
    ).rejects.toThrow(/invalid plan version status transition/);
  });

  it("freezes the exact approved plan in handoffs and keeps summaries immutable", async () => {
    await pg.query(
      `UPDATE work_items
          SET approved_plan_version_id='work-plan-1'
        WHERE id=$1`,
      [workItemId],
    );
    const execution = await service.createInternalConversation(
      {
        initiatedByUserId: owner.id,
        actor: { actor_type: "coordinator", actor_id: "planning-approval-bridge" },
      },
      {
        project_id: "conversation-project",
        work_item_id: workItemId,
        kind: "execution_pm",
        provider: "openai",
        model: "gpt-5.6-sol",
      },
    );
    const approved = await pg.query<{ plan: unknown; content_hash: string }>(
      "SELECT plan, content_hash FROM work_plan_versions WHERE id='work-plan-1'",
    );
    const approvedPlan = approved.rows[0]?.plan as {
      plan: { modules: Array<{ id: string }> };
      staffing: unknown[];
      estimated_budget: { currency: string; amount: number };
    };
    const handoffPackage = {
      approved_plan_version_id: "work-plan-1",
      approved_plan_content_hash: approved.rows[0]?.content_hash,
      approved_plan: approved.rows[0]?.plan,
      objective: "Durable plan",
      binding_rules: [],
      human_decisions: [],
      qc_findings_and_dispositions: [],
      unresolved_risks_and_questions: [],
      task_sequence: approvedPlan.plan.modules.map((module) => module.id),
      staffing: approvedPlan.staffing,
      budget: approvedPlan.estimated_budget,
      required_mockup_artifact_ids: [],
      acceptance_evidence: [],
      artifact_ids: [],
      phase_ids: [],
      task_ids: [],
      repository_binding_ids: [],
    };
    await pg.query(
      `INSERT INTO conversation_handoffs (
         id, project_id, work_item_id, source_conversation_id,
         target_conversation_id, approved_plan_version_id, created_by_user_id,
         kind, package, content_hash
       ) VALUES (
         'handoff-1','conversation-project',$1,$2,$3,'work-plan-1',
         'conversation-owner','planning_to_execution',$4::jsonb,$5
       )`,
      [
        workItemId,
        conversationId,
        execution.id,
        JSON.stringify(handoffPackage),
        canonicalSha256(handoffPackage),
      ],
    );
    await expect(
      pg.query("UPDATE conversation_handoffs SET content_hash=$1 WHERE id='handoff-1'", [
        "c".repeat(64),
      ]),
    ).rejects.toThrow(/conversation_handoffs is immutable/);

    await pg.query(
      `INSERT INTO conversation_summaries (
         id, project_id, work_item_id, conversation_id, created_by_user_id,
         version, from_message_sequence, through_message_sequence, summary,
         content_hash
       ) VALUES (
         'summary-1','conversation-project',$1,$2,'conversation-owner',
         1,1,4,'{"objective":"Durable plan"}'::jsonb,$3
       )`,
      [workItemId, conversationId, canonicalSha256({ objective: "Durable plan" })],
    );
    await expect(
      pg.query(
        `UPDATE conversation_summaries
            SET summary='{"objective":"rewritten"}'::jsonb
          WHERE id='summary-1'`,
      ),
    ).rejects.toThrow(/conversation_summaries is immutable/);

    const badPackage = { ...handoffPackage, approved_plan: { altered: true } };
    await expect(
      pg.query(
        `INSERT INTO conversation_handoffs (
           id, project_id, work_item_id, source_conversation_id,
           target_conversation_id, approved_plan_version_id, created_by_user_id,
           kind, package, content_hash
         ) VALUES (
           'handoff-bad','conversation-project',$1,$2,$3,'work-plan-1',
           'conversation-owner','planning_to_execution',$4::jsonb,$5
         )`,
        [
          workItemId,
          conversationId,
          execution.id,
          JSON.stringify(badPackage),
          canonicalSha256(badPackage),
        ],
      ),
    ).rejects.toThrow(/exact approved plan/);

    const contradictoryPackage = {
      ...handoffPackage,
      budget: { currency: "USD", amount: 999 },
    };
    await expect(
      pg.query(
        `INSERT INTO conversation_handoffs (
           id, project_id, work_item_id, source_conversation_id,
           target_conversation_id, approved_plan_version_id, created_by_user_id,
           kind, package, content_hash
         ) VALUES (
           'handoff-contradictory','conversation-project',$1,$2,$3,'work-plan-1',
           'conversation-owner','planning_to_execution',$4::jsonb,$5
         )`,
        [
          workItemId,
          conversationId,
          execution.id,
          JSON.stringify(contradictoryPackage),
          canonicalSha256(contradictoryPackage),
        ],
      ),
    ).rejects.toThrow(/must project the approved plan/);

    const contradictoryObjectivePackage = {
      ...handoffPackage,
      objective: "A different objective",
    };
    await expect(
      pg.query(
        `INSERT INTO conversation_handoffs (
           id, project_id, work_item_id, source_conversation_id,
           target_conversation_id, approved_plan_version_id, created_by_user_id,
           kind, package, content_hash
         ) VALUES (
           'handoff-contradictory-objective','conversation-project',$1,$2,$3,'work-plan-1',
           'conversation-owner','planning_to_execution',$4::jsonb,$5
         )`,
        [
          workItemId,
          conversationId,
          execution.id,
          JSON.stringify(contradictoryObjectivePackage),
          canonicalSha256(contradictoryObjectivePackage),
        ],
      ),
    ).rejects.toThrow(/must project the approved plan/);
  });

  it("pins turn attempts to provider/model and canonical usage telemetry", async () => {
    await pg.query(
      `INSERT INTO ai_usage_events (
         id, request_id, sequence, event_type, status, occurred_at,
         provider, model, endpoint, request_type, retry_attempt,
         initiated_by_user_id, project_id, usage_source, confidence,
         cost_classification
       ) VALUES (
         'usage-start-1','conversation-usage-1',1,'request_started','started',now(),
         'openai','gpt-5.6-sol','responses','conversation_turn',0,
         'conversation-member','conversation-project','provider_api',1,
         'unavailable'
       )`,
    );
    const manifest = { entries: [], estimated_tokens: 0 };
    await pg.query(
      `INSERT INTO conversation_turn_attempts (
         id, project_id, work_item_id, conversation_id, initiated_by_user_id,
         actor_type, actor_id, triggering_message_id, attempt_number,
         provider, model, usage_request_id, status, context_manifest,
         context_hash, usage_status, started_at
       ) VALUES (
         'turn-attempt-1','conversation-project',$1,$2,'conversation-member',
         'agent','pm-1',$3,1,'openai','gpt-5.6-sol','conversation-usage-1',
         'pending',$4::jsonb,$5,'pending',now()
       )`,
      [
        workItemId,
        conversationId,
        firstMessageId,
        JSON.stringify(manifest),
        canonicalSha256(manifest),
      ],
    );
    await expect(
      pg.query(
        `INSERT INTO conversation_turn_attempts (
           id, project_id, work_item_id, conversation_id, initiated_by_user_id,
           actor_type, actor_id, triggering_message_id, attempt_number,
           provider, model, usage_request_id, status, context_manifest,
           context_hash, usage_status, started_at
         ) VALUES (
           'turn-attempt-wrong-model','conversation-project',$1,$2,
           'conversation-member','agent','pm-1',$3,2,'anthropic','claude-sonnet-5',
           'conversation-usage-2','pending',$4::jsonb,$5,'pending',now()
         )`,
        [
          workItemId,
          conversationId,
          firstMessageId,
          JSON.stringify(manifest),
          canonicalSha256(manifest),
        ],
      ),
    ).rejects.toThrow(/conversation-pinned provider and model/);
    await expect(
      pg.query(
        `INSERT INTO conversation_turn_attempts (
           id, project_id, work_item_id, conversation_id, initiated_by_user_id,
           actor_type, actor_id, triggering_message_id, attempt_number,
           provider, model, usage_request_id, status, context_manifest,
           context_hash, usage_status, started_at
         ) VALUES (
           'turn-attempt-no-usage','conversation-project',$1,$2,
           'conversation-member','agent','pm-1',$3,2,'openai','gpt-5.6-sol',
           'missing-usage-request','pending',$4::jsonb,$5,'pending',now()
         )`,
        [
          workItemId,
          conversationId,
          firstMessageId,
          JSON.stringify(manifest),
          canonicalSha256(manifest),
        ],
      ),
    ).rejects.toThrow(/no canonical telemetry start event/);

    await pg.query(
      `INSERT INTO ai_usage_events (
         id, request_id, sequence, event_type, status, occurred_at,
         provider, model, endpoint, request_type, retry_attempt,
         initiated_by_user_id, project_id, usage_source, confidence,
         cost_classification
       ) VALUES (
         'usage-start-cross-scope','conversation-usage-cross-scope',1,
         'request_started','started',now(),'openai','gpt-5.6-sol',
         'responses','conversation_turn',0,'conversation-outsider',
         'other-conversation-project','provider_api',1,'unavailable'
       )`,
    );
    await expect(
      pg.query(
        `INSERT INTO conversation_turn_attempts (
           id, project_id, work_item_id, conversation_id, initiated_by_user_id,
           actor_type, actor_id, triggering_message_id, attempt_number,
           provider, model, usage_request_id, status, context_manifest,
           context_hash, usage_status, started_at
         ) VALUES (
           'turn-attempt-cross-scope','conversation-project',$1,$2,
           'conversation-member','agent','pm-1',$3,2,'openai','gpt-5.6-sol',
           'conversation-usage-cross-scope','pending',$4::jsonb,$5,'pending',now()
         )`,
        [
          workItemId,
          conversationId,
          firstMessageId,
          JSON.stringify(manifest),
          canonicalSha256(manifest),
        ],
      ),
    ).rejects.toThrow(/attribution does not match conversation scope/);

    await pg.query(
      `INSERT INTO work_messages (
         id, project_id, work_item_id, conversation_id, initiated_by_user_id,
         actor_type, actor_id, role, visibility_status, sequence, parts
       ) VALUES (
         'turn-output-message','conversation-project',$1,$2,'conversation-member',
         'agent','pm-1','assistant','complete',99,
         '[{"type":"text","format":"markdown","text":"Visible result"}]'::jsonb
       )`,
      [workItemId, conversationId],
    );
    await expect(
      pg.query(
        `UPDATE conversation_turn_attempts
            SET context_hash=$1
          WHERE id='turn-attempt-1'`,
        ["f".repeat(64)],
      ),
    ).rejects.toThrow(/identity, context, provider, and request scope are immutable/);
    await expect(
      pg.query(
        `UPDATE conversation_turn_attempts
            SET id='renamed-turn-attempt'
          WHERE id='turn-attempt-1'`,
      ),
    ).rejects.toThrow(/identity, context, provider, and request scope are immutable/);
    await expect(
      pg.query(
        `UPDATE conversation_turn_attempts
            SET status='succeeded',
                output_message_id='turn-output-message',
                provider_finish_reason='stop',
                usage_status='unavailable',
                settled_at=now()
          WHERE id='turn-attempt-1'`,
      ),
    ).rejects.toThrow(/invalid turn attempt status transition/);
    await pg.query(
      `UPDATE conversation_turn_attempts
          SET status='streaming', provider_request_id='provider-request-1'
        WHERE id='turn-attempt-1'`,
    );
    await expect(
      pg.query(
        `UPDATE conversation_turn_attempts
            SET provider_request_id='provider-request-tampered'
          WHERE id='turn-attempt-1'`,
      ),
    ).rejects.toThrow(/provider request identity is immutable/);
    await pg.query(
      `UPDATE conversation_turn_attempts
          SET status='succeeded',
              output_message_id='turn-output-message',
              provider_finish_reason='stop',
              usage_status='unavailable',
              settled_at=now()
        WHERE id='turn-attempt-1'`,
    );
    await expect(
      pg.query(
        `UPDATE conversation_turn_attempts
            SET provider_finish_reason='rewritten'
          WHERE id='turn-attempt-1'`,
      ),
    ).rejects.toThrow(/terminal turn attempts are immutable/);
  });
});
