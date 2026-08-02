import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConversationContextAssembler } from "../src/conversations/contextAssembler.js";
import {
  QUICK_EXECUTION_PM_INSTRUCTIONS,
  QUICK_EXECUTION_PM_PROMPT_VERSION,
} from "../src/conversations/prompt.js";
import { PostgresConversationRepository } from "../src/conversations/repository.js";
import { ConversationService } from "../src/conversations/service.js";
import { canonicalSha256 } from "../src/persistence/migration/canonicalJson.js";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";

const asMigrationDatabase = (database: PGlite): V2MigrationDatabase =>
  database as unknown as V2MigrationDatabase;

describe.sequential("quick work-item workspace", () => {
  const actor = { id: "quick-owner" };
  let pg: PGlite;
  let conversations: ConversationService;
  let contexts: ConversationContextAssembler;
  let idSequence = 0;

  beforeAll(async () => {
    pg = new PGlite();
    await pg.exec("CREATE ROLE norns_app NOLOGIN");
    await runCurrentV2Migrations(asMigrationDatabase(pg));
    await pg.exec(`
      INSERT INTO users (
        id, username, display_name, email, name, password_hash,
        password_hash_scheme, role, status
      ) VALUES (
        'quick-owner', 'quick-owner@example.com', 'Quick Owner',
        'quick-owner@example.com', 'Quick Owner', 'hash', 'scrypt-v1',
        'member', 'active'
      );
      INSERT INTO projects (
        id, name, status, assignment_policy_ref, verification_policy_ref,
        budget_policy_ref, owner_user_id
      ) VALUES (
        'quick-project', 'Quick Project', 'active',
        'assignment/default', 'verification/default', 'budget/default',
        'quick-owner'
      );
      INSERT INTO global_rule_settings (id, filename, content, version, updated_by)
      VALUES ('global','NORN.md','Keep changes narrowly scoped.',1,'quick-owner');
      INSERT INTO project_memory_entries (
        id, project_id, category, content, provenance, source_ref, confidence,
        version, status, approved_by_human, approved_by, approved_at
      ) VALUES (
        'quick-project-knowledge','quick-project','constraint',
        'Run the project verification command before delivery.','human',
        '{"kind":"quick_test"}'::jsonb,1,1,'active',true,'quick-owner',now()
      );
    `);
    const transactions = new PGliteTransactionRunner(pg);
    conversations = new ConversationService(new PostgresConversationRepository(transactions), {
      newId: (prefix) => `${prefix}-quick-${++idSequence}`,
    });
    contexts = new ConversationContextAssembler(transactions);
  }, 60_000);

  afterAll(async () => {
    await pg.close();
  });

  it("atomically materializes an executing work item and active development conversation", async () => {
    const created = await conversations.createQuickWorkspace(
      actor,
      {
        project_id: "quick-project",
        title: "Fix the compact header",
        objective: "Increase the compact header hit target without changing navigation.",
      },
      { provider: "openai", model: "gpt-5.6-terra" },
    );

    expect(created.work_item).toMatchObject({
      project_id: "quick-project",
      status: "executing",
      planning_run_id: null,
      approved_plan_version_id: null,
      phase_id: expect.any(String),
      execution_started_at: expect.any(String),
    });
    expect(created.conversation).toMatchObject({
      work_item_id: created.work_item.id,
      kind: "execution_pm",
      status: "active",
      provider: "openai",
      model: "gpt-5.6-terra",
    });

    const durable = await pg.query<{ phase_status: string; conversations: number }>(
      `SELECT phase.status AS phase_status,
              (SELECT count(*)::int FROM work_conversations conversation
                WHERE conversation.work_item_id=item.id) AS conversations
         FROM work_items item
         JOIN phases phase ON phase.project_id=item.project_id AND phase.id=item.phase_id
        WHERE item.id=$1`,
      [created.work_item.id],
    );
    expect(durable.rows).toEqual([{ phase_status: "proposed", conversations: 1 }]);
  });

  it("assembles a quick development turn from durable project and objective context", async () => {
    const created = await conversations.createQuickWorkspace(
      actor,
      {
        project_id: "quick-project",
        title: "Adjust button copy",
        objective: "Change the submit label to Start development.",
      },
      { provider: "openai", model: "gpt-5.6-terra" },
    );
    const trigger = await conversations.submitUserMessage(actor, {
      project_id: "quick-project",
      work_item_id: created.work_item.id,
      conversation_id: created.conversation.id,
      client_message_id: "quick-development-message",
      parts: [{ type: "text", format: "plain", text: "Please make this small change." }],
    });

    const assembled = await contexts.assemble(
      "quick-project",
      created.work_item.id,
      created.conversation.id,
      trigger.id,
    );
    expect(assembled.manifest.entries[0]).toEqual({
      kind: "prompt",
      ref: QUICK_EXECUTION_PM_PROMPT_VERSION,
      content_hash: canonicalSha256(QUICK_EXECUTION_PM_INSTRUCTIONS),
      estimated_tokens: Math.ceil(QUICK_EXECUTION_PM_INSTRUCTIONS.length / 4),
    });
    expect(assembled.manifest.entries.map((entry) => entry.kind)).toEqual([
      "prompt",
      "global_rules",
      "project_knowledge",
      "work_objective",
      "message",
    ]);
    expect(assembled.system).toContain("quick workflow intentionally has no approved plan");
    expect(assembled.system).toContain("Change the submit label to Start development.");
    expect(assembled.messages).toEqual([
      { role: "user", content: "Please make this small change." },
    ]);
  });
});
