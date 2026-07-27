import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConversationContextAssembler } from "../src/conversations/contextAssembler.js";
import { PostgresConversationRepository } from "../src/conversations/repository.js";
import { ConversationService } from "../src/conversations/service.js";
import { canonicalJson, canonicalSha256 } from "../src/persistence/migration/canonicalJson.js";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";

const owner = { id: "compaction-owner" };

interface SummaryReceiptRow {
  id: string;
  version: number | string;
  created_by_user_id: string;
  from_message_sequence: number | string;
  through_message_sequence: number | string;
  summary: {
    objective: string;
    constraints: string[];
    artifact_ids: string[];
  };
  content_hash: string;
  milestone: string;
  source_message_ids: string[];
  source_message_hashes: string[];
  canonical_source_messages: string[];
  canonical_summary: string;
}

describe.sequential("automatic durable conversation compaction", () => {
  let pg: PGlite;
  let transactions: PGliteTransactionRunner;
  let conversations: ConversationService;
  let workItemId: string;
  let conversationId: string;
  let clientSequence: number;

  beforeEach(async () => {
    pg = new PGlite();
    await pg.exec("CREATE ROLE norns_app NOLOGIN");
    await runCurrentV2Migrations(pg as unknown as V2MigrationDatabase);
    await pg.exec(`
      INSERT INTO users (
        id, username, display_name, email, name, password_hash,
        password_hash_scheme, role, status
      ) VALUES (
        'compaction-owner', 'compaction-owner@example.com', 'Compaction Owner',
        'compaction-owner@example.com', 'Compaction Owner', 'hash', 'scrypt-v1',
        'member', 'active'
      );
      INSERT INTO projects (
        id, name, status, assignment_policy_ref, verification_policy_ref,
        budget_policy_ref, owner_user_id
      ) VALUES (
        'compaction-project', 'Compaction Project', 'active',
        'assignment/default', 'verification/default', 'budget/default',
        'compaction-owner'
      );
      INSERT INTO project_memory_entries (
        id, project_id, category, content, provenance, source_ref, confidence,
        version, status, approved_by_human, approved_by, approved_at
      ) VALUES (
        'compaction-constraint', 'compaction-project', 'constraint',
        'Keep context evidence auditable.', 'human',
        '{"kind":"conversation_test"}'::jsonb, 1, 1, 'active', true,
        'compaction-owner', now()
      );
    `);
    transactions = new PGliteTransactionRunner(pg);
    conversations = new ConversationService(new PostgresConversationRepository(transactions), {
      newId: (prefix) => `${prefix}-compaction-${++clientSequence}`,
    });
    clientSequence = 0;
    const created = await conversations.createPlanningWorkspace(
      owner,
      {
        project_id: "compaction-project",
        title: "Compact a long planning conversation",
        objective: "Retain every important fact while bounding recent turns.",
      },
      { provider: "openai", model: "mock-openai" },
    );
    workItemId = created.work_item.id;
    conversationId = created.conversation.id;
  }, 60_000);

  afterEach(async () => {
    await pg.close();
  });

  async function submitUser(text: string) {
    return conversations.submitUserMessage(owner, {
      project_id: "compaction-project",
      work_item_id: workItemId,
      conversation_id: conversationId,
      client_message_id: `compaction-client-${++clientSequence}`,
      parts: [{ type: "text", format: "plain", text }],
    });
  }

  async function appendAssistantMessages(
    count: number,
    prefix: string,
    visibility: "complete" | "interrupted" = "complete",
  ): Promise<string[]> {
    const next = await pg.query<{ next_message_sequence: number | string }>(
      "SELECT next_message_sequence FROM work_conversations WHERE id=$1",
      [conversationId],
    );
    const firstSequence = Number(next.rows[0]?.next_message_sequence);
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const sequence = firstSequence + index;
      const id = `${prefix}-${sequence}`;
      ids.push(id);
      await pg.query(
        `INSERT INTO work_messages (
           id, project_id, work_item_id, conversation_id, initiated_by_user_id,
           actor_type, actor_id, role, visibility_status, sequence, parts
         ) VALUES (
           $1, 'compaction-project', $2, $3, 'compaction-owner',
           'coordinator', NULL, 'assistant', $4, $5, $6::jsonb
         )`,
        [
          id,
          workItemId,
          conversationId,
          visibility,
          sequence,
          JSON.stringify([
            {
              type: "text",
              format: "plain",
              text: `${prefix} visible content ${sequence}`,
            },
          ]),
        ],
      );
    }
    await pg.query("UPDATE work_conversations SET next_message_sequence=$2 WHERE id=$1", [
      conversationId,
      firstSequence + count,
    ]);
    return ids;
  }

  async function seedThresholdConversation() {
    const early = await submitUser("EARLY_REQUIREMENT: preserve the signed launch constraint.");
    await appendAssistantMessages(59, "initial-complete");
    const incompleteIds = await appendAssistantMessages(2, "never-compact", "interrupted");
    const trigger = await submitUser("TRIGGERING_DIRECTION: produce a bounded current context.");
    return { early, trigger, incompleteIds };
  }

  async function summaryReceipts(): Promise<SummaryReceiptRow[]> {
    const result = await pg.query<SummaryReceiptRow>(
      `SELECT summary.id, summary.version, summary.created_by_user_id,
              summary.from_message_sequence, summary.through_message_sequence,
              summary.summary, summary.content_hash, receipt.milestone,
              receipt.source_message_ids, receipt.source_message_hashes,
              receipt.canonical_source_messages, receipt.canonical_summary
         FROM conversation_summaries summary
         JOIN conversation_compaction_receipts receipt ON receipt.summary_id=summary.id
        WHERE summary.conversation_id=$1
        ORDER BY summary.version`,
      [conversationId],
    );
    return result.rows;
  }

  it("retains an early fact in a summary plus 40 recent complete turns with exact provenance", async () => {
    const { early, trigger, incompleteIds } = await seedThresholdConversation();
    const assembler = new ConversationContextAssembler(transactions);
    const assembled = await assembler.assemble(
      "compaction-project",
      workItemId,
      conversationId,
      trigger.id,
    );

    const receipts = await summaryReceipts();
    expect(receipts).toHaveLength(1);
    const receipt = receipts[0];
    if (!receipt) throw new Error("threshold summary was not persisted");
    expect(receipt).toMatchObject({
      version: 1,
      created_by_user_id: owner.id,
      from_message_sequence: 1,
      through_message_sequence: 21,
      milestone: "context_threshold",
    });
    expect(receipt.summary.objective).toBe(
      "Retain every important fact while bounding recent turns.",
    );
    expect(receipt.summary.constraints).toContain("Keep context evidence auditable.");
    expect(receipt.summary.constraints.join("\n")).toContain("EARLY_REQUIREMENT");
    expect(receipt.source_message_ids).toHaveLength(21);
    expect(receipt.source_message_ids[0]).toBe(early.id);
    expect(receipt.source_message_ids).not.toEqual(expect.arrayContaining(incompleteIds));
    expect(receipt.source_message_hashes).toEqual(
      receipt.canonical_source_messages.map((message) => canonicalSha256(JSON.parse(message))),
    );
    expect(receipt.canonical_source_messages[0]).toBe(
      canonicalJson({
        sequence: 1,
        role: "user",
        parts: [
          {
            type: "text",
            format: "plain",
            text: "EARLY_REQUIREMENT: preserve the signed launch constraint.",
          },
        ],
      }),
    );
    expect(JSON.parse(receipt.canonical_summary)).toEqual(receipt.summary);
    expect(receipt.content_hash).toBe(canonicalSha256(receipt.summary));

    expect(
      assembled.manifest.entries.filter((entry) => entry.kind === "conversation_summary"),
    ).toEqual([expect.objectContaining({ ref: receipt.id, content_hash: receipt.content_hash })]);
    expect(assembled.messages).toHaveLength(40);
    expect(assembled.messages.at(-1)).toEqual({
      role: "user",
      content: "TRIGGERING_DIRECTION: produce a bounded current context.",
    });
    expect(assembled.triggering_message_index).toBe(39);
    expect(JSON.stringify(assembled.messages)).not.toContain("never-compact");

    await assembler.assemble("compaction-project", workItemId, conversationId, trigger.id);
    await expect(summaryReceipts()).resolves.toHaveLength(1);
  });

  it("serializes concurrent threshold assembly into one replay-safe summary version", async () => {
    const { trigger } = await seedThresholdConversation();
    const first = new ConversationContextAssembler(transactions);
    const second = new ConversationContextAssembler(transactions);
    const [a, b] = await Promise.all([
      first.assemble("compaction-project", workItemId, conversationId, trigger.id),
      second.assemble("compaction-project", workItemId, conversationId, trigger.id),
    ]);

    expect(a.context_hash).toBe(b.context_hash);
    expect(a.triggering_message_index).toBe(39);
    expect(b.triggering_message_index).toBe(39);
    const receipts = await summaryReceipts();
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ version: 1, milestone: "context_threshold" });
  });

  it("rolls back an inserted summary when its receipt cannot be completed", async () => {
    const { trigger } = await seedThresholdConversation();
    const failing = new ConversationContextAssembler(transactions, {
      checkpoint: (checkpoint) => {
        if (checkpoint === "summary_inserted") throw new Error("injected receipt failure");
      },
    });
    await expect(
      failing.assemble("compaction-project", workItemId, conversationId, trigger.id),
    ).rejects.toThrow("injected receipt failure");
    const counts = await pg.query<{ summaries: number | string; receipts: number | string }>(
      `SELECT
         (SELECT count(*) FROM conversation_summaries WHERE conversation_id=$1) AS summaries,
         (SELECT count(*) FROM conversation_compaction_receipts WHERE conversation_id=$1)
           AS receipts`,
      [conversationId],
    );
    expect(counts.rows[0]).toEqual({ summaries: 0, receipts: 0 });

    const recovered = new ConversationContextAssembler(transactions);
    await recovered.assemble("compaction-project", workItemId, conversationId, trigger.id);
    await expect(summaryReceipts()).resolves.toHaveLength(1);
  });

  it("creates a cumulative second version whose receipt rebinds the full source range", async () => {
    const { early, trigger } = await seedThresholdConversation();
    const assembler = new ConversationContextAssembler(transactions);
    await assembler.assemble("compaction-project", workItemId, conversationId, trigger.id);

    await appendAssistantMessages(10, "successive-complete");
    const secondTrigger = await submitUser("SECOND_TRIGGER: retain a fresh bounded tail.");
    const assembled = await assembler.assemble(
      "compaction-project",
      workItemId,
      conversationId,
      secondTrigger.id,
    );
    const receipts = await summaryReceipts();
    expect(receipts).toHaveLength(2);
    expect(receipts.map((receipt) => Number(receipt.version))).toEqual([1, 2]);
    const latest = receipts[1];
    if (!latest) throw new Error("successive summary was not persisted");
    expect(Number(latest.from_message_sequence)).toBe(1);
    expect(Number(latest.through_message_sequence)).toBe(32);
    expect(latest.source_message_ids).toHaveLength(32);
    expect(latest.source_message_ids[0]).toBe(early.id);
    expect(latest.summary.constraints.join("\n")).toContain("EARLY_REQUIREMENT");
    expect(latest.canonical_source_messages).toEqual(
      expect.arrayContaining(receipts[0]?.canonical_source_messages ?? []),
    );
    expect(assembled.messages).toHaveLength(40);
    expect(assembled.messages.at(-1)).toEqual({
      role: "user",
      content: "SECOND_TRIGGER: retain a fresh bounded tail.",
    });
    expect(assembled.triggering_message_index).toBe(39);
  });
});
