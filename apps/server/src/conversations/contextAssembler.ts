import type { ConversationMessage } from "@norns/adapters";
import {
  V2ConversationContextManifest,
  type V2ConversationContextManifestT,
  V2ConversationHandoffPackage,
  V2ConversationSummaryContent,
  V2WorkMessagePart,
  type V2WorkMessagePartT,
} from "@norns/contracts";
import { canonicalJson, canonicalSha256 } from "../persistence/migration/canonicalJson.js";
import type { V2SqlExecutor, V2TransactionRunner } from "../persistence/v2/database.js";
import {
  CONVERSATIONAL_PM_INSTRUCTIONS,
  CONVERSATIONAL_PM_PROMPT_VERSION,
  EXECUTION_PM_INSTRUCTIONS,
  EXECUTION_PM_PROMPT_VERSION,
  QUICK_EXECUTION_PM_INSTRUCTIONS,
  QUICK_EXECUTION_PM_PROMPT_VERSION,
  conversationalPmSystem,
  executionPmSystem,
  quickExecutionPmSystem,
} from "./prompt.js";

const MAX_RECENT_MESSAGES = 50;
const RETAIN_RECENT_MESSAGES_AFTER_COMPACTION = 40;
const MAX_VISIBLE_DIGEST_ENTRIES = 24;
const MAX_VISIBLE_DIGEST_CHARACTERS = 280;
const VISIBLE_DIGEST_PREFIX = "Visible conversation message #";
const MAX_FILE_CONTEXT_CHARACTERS = 50_000;
const MAX_TOTAL_FILE_CONTEXT_CHARACTERS = 120_000;

interface ContextMaterial {
  kind: V2ConversationContextManifestT["entries"][number]["kind"];
  ref: string;
  content: string;
  contentHash?: string;
  estimatedTokens?: number;
}

interface SummaryRow {
  id: string;
  version?: number | string;
  from_message_sequence?: number | string;
  through_message_sequence: number | string;
  summary: unknown;
  content_hash?: string;
}

interface MessageRow {
  id: string;
  role: "user" | "assistant" | "system";
  sequence: number | string;
  parts: unknown;
}

interface AttachmentRow {
  id: string;
  sha256: string;
  mime: string;
  original_filename: string;
  extracted_text: string | null;
  extracted_text_sha256: string | null;
  extraction_truncated: boolean;
}

export interface ConversationContextAssembly {
  manifest: V2ConversationContextManifestT;
  context_hash: string;
  system: string;
  messages: ConversationMessage[];
  attachment_ids: string[];
  triggering_message_index: number;
}

function estimateTokens(content: string): number {
  return content.length === 0 ? 0 : Math.max(1, Math.ceil(content.length / 4));
}

function entry(material: ContextMaterial): V2ConversationContextManifestT["entries"][number] {
  return {
    kind: material.kind,
    ref: material.ref,
    content_hash: material.contentHash ?? canonicalSha256(material.content),
    estimated_tokens: material.estimatedTokens ?? estimateTokens(material.content),
  };
}

function parts(value: unknown): V2WorkMessagePartT[] {
  const parsed = jsonValue(value);
  return Array.isArray(parsed) ? parsed.map((part) => V2WorkMessagePart.parse(part)) : [];
}

function jsonValue(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}

function jsonArray(value: unknown): string[] {
  const parsed = jsonValue(value);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("expected a durable string-array receipt");
  }
  return parsed;
}

function visibleText(messageParts: readonly V2WorkMessagePartT[]): string {
  return messageParts
    .map((part) => {
      switch (part.type) {
        case "text":
          return part.text;
        case "code":
          return `\`\`\`${part.language ?? ""}\n${part.code}\n\`\`\``;
        case "attachment":
          return `[Attachment: ${part.name} (${part.media_type}), id=${part.attachment_id}]`;
        case "artifact":
          return `[Artifact: ${part.label} (${part.media_type}), id=${part.artifact_id}]`;
        case "action":
          return `[Explicit action card: ${part.action_id}]`;
        case "plan":
          return `[Plan version: ${part.plan_version_id}]`;
        case "handoff":
          return `[Execution handoff: ${part.handoff_id}]`;
        case "planning_excerpt":
          return `[Requested planning excerpt: ${part.excerpt_receipt_id}]`;
        case "human_wait":
          return `[Human decision requested: ${part.human_wait_id}]`;
        case "human_wait_update":
          return `[Human decision ${part.human_wait_id}: ${part.status}]`;
      }
    })
    .join("\n\n");
}

function section(label: string, content: string): string {
  return `## ${label}\n${content}`;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function boundedVisibleDigest(messages: readonly MessageRow[]): string[] {
  const entries = messages.map((message) => {
    const rendered = visibleText(parts(message.parts)).replace(/\s+/gu, " ").trim();
    const shortened =
      rendered.length > MAX_VISIBLE_DIGEST_CHARACTERS
        ? `${rendered.slice(0, MAX_VISIBLE_DIGEST_CHARACTERS - 1)}…`
        : rendered;
    return `${VISIBLE_DIGEST_PREFIX}${Number(message.sequence)} [${message.role}]: ${
      shortened || "[structured visible content]"
    }`;
  });
  if (entries.length <= MAX_VISIBLE_DIGEST_ENTRIES) return entries;
  const edge = MAX_VISIBLE_DIGEST_ENTRIES / 2;
  return [...entries.slice(0, edge), ...entries.slice(-edge)];
}

function planRisks(value: unknown): string[] {
  const raw = jsonValue(value);
  if (!raw || typeof raw !== "object") return [];
  const envelope = raw as Record<string, unknown>;
  const nested =
    envelope.plan && typeof envelope.plan === "object"
      ? (envelope.plan as Record<string, unknown>)
      : undefined;
  const risks = Array.isArray(envelope.risks)
    ? envelope.risks
    : Array.isArray(nested?.risks)
      ? nested.risks
      : [];
  return risks.map((risk) => (typeof risk === "string" ? risk : JSON.stringify(risk)));
}

export type ConversationCompactionCheckpoint = (
  checkpoint: "summary_inserted",
) => void | Promise<void>;

/**
 * A bounded, provider-neutral context receipt. The SQL order below is the
 * product priority order; manifest entries and rendered system sections are
 * derived from the same exact strings so their hashes remain auditable.
 */
export class ConversationContextAssembler {
  private readonly checkpoint: ConversationCompactionCheckpoint;

  constructor(
    private readonly transactions: V2TransactionRunner,
    options: { checkpoint?: ConversationCompactionCheckpoint } = {},
  ) {
    this.checkpoint = options.checkpoint ?? (() => undefined);
  }

  assemble(
    projectId: string,
    workItemId: string,
    conversationId: string,
    triggeringMessageId: string,
  ): Promise<ConversationContextAssembly> {
    return this.transactions.transaction(async (tx) => {
      const scope = await tx.query<{
        id: string;
        objective: string;
        kind: "planning" | "execution_pm" | "task";
        triggering_message_sequence: number | string;
        triggering_user_id: string;
      }>(
        `SELECT item.id, item.objective, conversation.kind,
                triggering_message.sequence AS triggering_message_sequence,
                triggering_message.initiated_by_user_id AS triggering_user_id
           FROM work_items item
           JOIN work_conversations conversation
             ON conversation.project_id=item.project_id
            AND conversation.work_item_id=item.id
           JOIN work_messages triggering_message
             ON triggering_message.project_id=item.project_id
            AND triggering_message.work_item_id=item.id
            AND triggering_message.conversation_id=conversation.id
            AND triggering_message.id=$4
          WHERE item.project_id=$1 AND item.id=$2 AND conversation.id=$3
          FOR UPDATE OF conversation`,
        [projectId, workItemId, conversationId, triggeringMessageId],
      );
      const work = scope.rows[0];
      if (!work) throw new Error("conversation scope not found");
      await this.compactAtContextThreshold(
        tx,
        projectId,
        workItemId,
        conversationId,
        Number(work.triggering_message_sequence),
        work.triggering_user_id,
        work.objective,
      );

      const materials: ContextMaterial[] = [];
      const systemSections: string[] = [];
      const executionPm = work.kind === "execution_pm";
      let hasExecutionHandoff = false;
      materials.push({
        kind: "prompt",
        ref: executionPm ? EXECUTION_PM_PROMPT_VERSION : CONVERSATIONAL_PM_PROMPT_VERSION,
        content: executionPm ? EXECUTION_PM_INSTRUCTIONS : CONVERSATIONAL_PM_INSTRUCTIONS,
      });
      if (executionPm) {
        hasExecutionHandoff = await this.addExecutionHandoff(
          tx,
          projectId,
          workItemId,
          conversationId,
          materials,
          systemSections,
        );
        if (!hasExecutionHandoff) {
          materials[0] = {
            kind: "prompt",
            ref: QUICK_EXECUTION_PM_PROMPT_VERSION,
            content: QUICK_EXECUTION_PM_INSTRUCTIONS,
          };
        }
      }
      if (!executionPm || !hasExecutionHandoff) {
        await this.addRules(tx, projectId, materials, systemSections);
        await this.addProjectSetup(tx, projectId, materials, systemSections);
        await this.addKnowledge(tx, projectId, materials, systemSections);
        materials.push({ kind: "work_objective", ref: workItemId, content: work.objective });
        systemSections.push(section("Current work objective", work.objective));
      }

      const summary = await this.addSummary(
        tx,
        projectId,
        workItemId,
        conversationId,
        Number(work.triggering_message_sequence),
        materials,
        systemSections,
      );
      if (!executionPm || !hasExecutionHandoff) {
        await this.addDecisionsAndRisks(tx, projectId, workItemId, materials, systemSections);
      }
      const recent = await this.recentMessages(
        tx,
        projectId,
        workItemId,
        conversationId,
        summary?.through_message_sequence ?? 0,
        triggeringMessageId,
      );
      const messages: ConversationMessage[] = [];
      let triggeringMessageIndex = -1;
      const attachmentIds: string[] = [];
      const currentAttachmentIds: string[] = [];
      const messageAttachmentIds: Array<{
        messageIndex: number;
        attachmentIds: string[];
      }> = [];
      const artifactIds: string[] = [];
      const excerptReceiptIds: string[] = [];
      for (const row of recent) {
        const parsedParts = parts(row.parts);
        const content = visibleText(parsedParts);
        if (!content) continue;
        materials.push({ kind: "message", ref: row.id, content });
        let messageIndex = -1;
        if (row.role !== "system") {
          messages.push({ role: row.role, content });
          messageIndex = messages.length - 1;
          if (row.id === triggeringMessageId) triggeringMessageIndex = messages.length - 1;
        }
        const rowAttachmentIds: string[] = [];
        for (const part of parsedParts) {
          if (part.type === "attachment") {
            attachmentIds.push(part.attachment_id);
            rowAttachmentIds.push(part.attachment_id);
            if (row.id === triggeringMessageId) currentAttachmentIds.push(part.attachment_id);
          }
          if (part.type === "artifact") artifactIds.push(part.artifact_id);
          if (part.type === "planning_excerpt") {
            excerptReceiptIds.push(part.excerpt_receipt_id);
          }
        }
        if (messageIndex >= 0 && rowAttachmentIds.length > 0) {
          messageAttachmentIds.push({ messageIndex, attachmentIds: rowAttachmentIds });
        }
      }
      if (executionPm && excerptReceiptIds.length > 0) {
        await this.addPlanningExcerpts(
          tx,
          projectId,
          workItemId,
          conversationId,
          [...new Set(excerptReceiptIds)],
          materials,
          systemSections,
        );
      }
      const fileContexts = await this.addReferencedArtifacts(
        tx,
        projectId,
        [...new Set(attachmentIds)],
        [...new Set(artifactIds)],
        materials,
        systemSections,
      );
      for (const referenced of messageAttachmentIds) {
        const fileBlocks = referenced.attachmentIds.flatMap((attachmentId) => {
          const content = fileContexts.get(attachmentId);
          return content ? [content] : [];
        });
        if (fileBlocks.length === 0) continue;
        const message = messages[referenced.messageIndex];
        if (!message) continue;
        const fileContent = fileBlocks.join("\n");
        messages[referenced.messageIndex] = {
          ...message,
          content:
            typeof message.content === "string"
              ? `${message.content}\n\n${fileContent}`
              : [...message.content, { type: "text", text: fileContent }],
        };
      }

      const manifest = V2ConversationContextManifest.parse({
        entries: materials.map(entry),
        estimated_tokens: materials.reduce(
          (total, material) =>
            total + (material.estimatedTokens ?? estimateTokens(material.content)),
          0,
        ),
      });
      return {
        manifest,
        context_hash: canonicalSha256(manifest),
        system:
          executionPm && hasExecutionHandoff
            ? executionPmSystem(systemSections.join("\n\n"))
            : executionPm
              ? quickExecutionPmSystem(systemSections.join("\n\n"))
              : conversationalPmSystem(systemSections.join("\n\n")),
        messages,
        attachment_ids: [...new Set(currentAttachmentIds)],
        triggering_message_index: triggeringMessageIndex,
      };
    });
  }

  private async compactAtContextThreshold(
    tx: V2SqlExecutor,
    projectId: string,
    workItemId: string,
    conversationId: string,
    triggeringSequence: number,
    triggeringUserId: string,
    objective: string,
  ): Promise<void> {
    const locked = await tx.query<{ id: string }>(
      `SELECT id
         FROM work_conversations
        WHERE project_id=$1 AND work_item_id=$2 AND id=$3
        FOR UPDATE`,
      [projectId, workItemId, conversationId],
    );
    if (!locked.rows[0]) throw new Error("conversation scope disappeared during compaction");

    const previous = (
      await tx.query<SummaryRow>(
        `SELECT id, version, from_message_sequence, through_message_sequence, summary
           FROM conversation_summaries
          WHERE project_id=$1 AND work_item_id=$2 AND conversation_id=$3
            AND through_message_sequence<=$4
          ORDER BY version DESC
          LIMIT 1`,
        [projectId, workItemId, conversationId, triggeringSequence],
      )
    ).rows[0];
    const unsummarized = await tx.query<MessageRow>(
      `SELECT id, role, sequence, parts
         FROM work_messages
        WHERE project_id=$1 AND work_item_id=$2 AND conversation_id=$3
          AND visibility_status='complete'
          AND sequence>$4 AND sequence<=$5
        ORDER BY sequence, id`,
      [
        projectId,
        workItemId,
        conversationId,
        Number(previous?.through_message_sequence ?? 0),
        triggeringSequence,
      ],
    );
    if (unsummarized.rows.length <= MAX_RECENT_MESSAGES) return;

    const compactedDeltaCount = unsummarized.rows.length - RETAIN_RECENT_MESSAGES_AFTER_COMPACTION;
    const throughSequence = Number(
      unsummarized.rows[compactedDeltaCount - 1]?.sequence ?? triggeringSequence,
    );
    const sources = await tx.query<MessageRow>(
      `SELECT id, role, sequence, parts
         FROM work_messages
        WHERE project_id=$1 AND work_item_id=$2 AND conversation_id=$3
          AND visibility_status='complete' AND sequence<=$4
        ORDER BY sequence, id`,
      [projectId, workItemId, conversationId, throughSequence],
    );
    const firstSource = sources.rows[0];
    const lastSource = sources.rows.at(-1);
    if (!firstSource || !lastSource) {
      throw new Error("conversation compaction source range disappeared");
    }

    const constraints = await tx.query<{ content: string }>(
      `SELECT content
         FROM project_memory_entries
        WHERE project_id=$1 AND status='active' AND approved_by_human=TRUE
          AND category IN ('constraint','directive')
        ORDER BY created_at, id`,
      [projectId],
    );
    const decisions = await tx.query<{ id: string; title: string; rationale: string }>(
      `SELECT id, title, rationale
         FROM decision_records
        WHERE project_id=$1 AND status='active'
        ORDER BY created_at, id`,
      [projectId],
    );
    const questions = await tx.query<{ question: string; context: string }>(
      `SELECT question, context
         FROM decision_points
        WHERE project_id=$1 AND status='open'
        ORDER BY created_at, id`,
      [projectId],
    );
    const latestPlan = await tx.query<{ plan: unknown }>(
      `SELECT plan
         FROM work_plan_versions
        WHERE project_id=$1 AND work_item_id=$2
        ORDER BY version DESC
        LIMIT 1`,
      [projectId, workItemId],
    );

    const artifactIds = unique(
      sources.rows.flatMap((message) =>
        parts(message.parts).flatMap((part) => {
          if (part.type === "attachment") return [part.attachment_id];
          if (part.type === "artifact") return [part.artifact_id];
          return [];
        }),
      ),
    );
    const summary = V2ConversationSummaryContent.parse({
      objective,
      constraints: unique([
        ...constraints.rows.map((row) => row.content.trim()).filter(Boolean),
        ...boundedVisibleDigest(sources.rows),
      ]),
      decisions: decisions.rows.map((decision) => ({
        id: decision.id,
        summary: decision.title,
        rationale: decision.rationale,
      })),
      risks: planRisks(latestPlan.rows[0]?.plan),
      open_questions: questions.rows.map(
        (question) => `${question.question} — ${question.context}`,
      ),
      artifact_ids: artifactIds,
    });
    const canonicalSources = sources.rows.map((message) =>
      canonicalJson({
        sequence: Number(message.sequence),
        role: message.role,
        parts: jsonValue(message.parts),
      }),
    );
    const sourceIds = sources.rows.map((message) => message.id);
    const sourceHashes = canonicalSources.map((message) => canonicalSha256(JSON.parse(message)));
    const version = Number(previous?.version ?? 0) + 1;
    const identity = canonicalSha256({
      conversation_id: conversationId,
      through_message_sequence: throughSequence,
      source_message_hashes: sourceHashes,
    });
    const summaryId = `conversation_summary_${identity.slice(0, 32)}`;
    const receiptId = `compaction_receipt_${identity.slice(32)}`;
    const canonicalSummary = canonicalJson(summary);

    await tx.query(
      `INSERT INTO conversation_summaries (
         id, project_id, work_item_id, conversation_id, created_by_user_id,
         version, from_message_sequence, through_message_sequence,
         summary, content_hash
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)`,
      [
        summaryId,
        projectId,
        workItemId,
        conversationId,
        triggeringUserId,
        version,
        Number(firstSource.sequence),
        Number(lastSource.sequence),
        JSON.stringify(summary),
        canonicalSha256(summary),
      ],
    );
    await this.checkpoint("summary_inserted");
    await tx.query(
      `INSERT INTO conversation_compaction_receipts (
         id, project_id, work_item_id, conversation_id, summary_id, milestone,
         source_message_ids, source_message_hashes, canonical_source_messages,
         canonical_summary
       ) VALUES ($1,$2,$3,$4,$5,'context_threshold',$6::jsonb,$7::jsonb,$8::jsonb,$9)`,
      [
        receiptId,
        projectId,
        workItemId,
        conversationId,
        summaryId,
        JSON.stringify(sourceIds),
        JSON.stringify(sourceHashes),
        JSON.stringify(canonicalSources),
        canonicalSummary,
      ],
    );
  }

  private async addExecutionHandoff(
    tx: V2SqlExecutor,
    projectId: string,
    workItemId: string,
    conversationId: string,
    materials: ContextMaterial[],
    sections: string[],
  ): Promise<boolean> {
    const row = (
      await tx.query<{ id: string; package: unknown; content_hash: string }>(
        `SELECT id, package, content_hash
           FROM conversation_handoffs
          WHERE project_id=$1 AND work_item_id=$2 AND target_conversation_id=$3`,
        [projectId, workItemId, conversationId],
      )
    ).rows[0];
    if (!row) return false;
    const handoff = V2ConversationHandoffPackage.parse(
      typeof row.package === "string" ? JSON.parse(row.package) : row.package,
    );
    const content = JSON.stringify(handoff);
    if (canonicalSha256(handoff) !== row.content_hash) {
      throw new Error("execution handoff content hash mismatch");
    }
    materials.push({
      kind: "handoff",
      ref: row.id,
      content,
      contentHash: row.content_hash,
    });
    sections.push(section("Approved execution handoff", content));
    return true;
  }

  private async addPlanningExcerpts(
    tx: V2SqlExecutor,
    projectId: string,
    workItemId: string,
    targetConversationId: string,
    receiptIds: string[],
    materials: ContextMaterial[],
    sections: string[],
  ): Promise<void> {
    const receipts = await tx.query<{
      id: string;
      source_conversation_id: string;
      source_message_ids: unknown;
      source_message_hashes: unknown;
    }>(
      `SELECT id, source_conversation_id, source_message_ids, source_message_hashes
         FROM conversation_planning_excerpt_receipts
        WHERE project_id=$1 AND work_item_id=$2 AND target_conversation_id=$3
          AND id=ANY($4::text[])
        ORDER BY created_at, id`,
      [projectId, workItemId, targetConversationId, receiptIds],
    );
    if (receipts.rows.length !== receiptIds.length) {
      throw new Error("one or more requested planning excerpt receipts are unavailable");
    }
    const rendered: string[] = [];
    for (const receipt of receipts.rows) {
      const ids = jsonArray(receipt.source_message_ids);
      const hashes = jsonArray(receipt.source_message_hashes);
      const messages = await tx.query<MessageRow>(
        `SELECT id, role, sequence, parts
           FROM work_messages
          WHERE project_id=$1 AND work_item_id=$2 AND conversation_id=$3
            AND visibility_status='complete' AND id=ANY($4::text[])
          ORDER BY sequence`,
        [projectId, workItemId, receipt.source_conversation_id, ids],
      );
      if (
        messages.rows.length !== ids.length ||
        messages.rows.some((message, index) => message.id !== ids[index])
      ) {
        throw new Error("planning excerpt receipt source messages no longer match");
      }
      const excerpt = messages.rows
        .map((message, index) => {
          const content = visibleText(parts(message.parts));
          const hash = canonicalSha256({
            sequence: Number(message.sequence),
            role: message.role,
            parts: jsonValue(message.parts),
          });
          if (hash !== hashes[index]) throw new Error("planning excerpt source hash mismatch");
          return `[${message.role}] ${content}`;
        })
        .join("\n\n");
      materials.push({ kind: "planning_excerpt", ref: receipt.id, content: excerpt });
      rendered.push(`### Receipt ${receipt.id}\n${excerpt}`);
    }
    sections.push(section("Explicitly requested planning excerpts", rendered.join("\n\n")));
  }

  async assemblePlanProposal(
    projectId: string,
    workItemId: string,
    conversationId: string,
  ): Promise<ConversationContextAssembly & { source_message_id: string }> {
    const sourceMessageId = await this.transactions.transaction(async (tx) => {
      const row = (
        await tx.query<{ id: string }>(
          `SELECT id
             FROM work_messages
            WHERE project_id=$1 AND work_item_id=$2 AND conversation_id=$3
              AND visibility_status='complete'
            ORDER BY sequence DESC
            LIMIT 1`,
          [projectId, workItemId, conversationId],
        )
      ).rows[0];
      if (!row) throw new Error("plan proposal requires at least one complete visible message");
      return row.id;
    });
    return {
      ...(await this.assemble(projectId, workItemId, conversationId, sourceMessageId)),
      source_message_id: sourceMessageId,
    };
  }

  private async addRules(
    tx: V2SqlExecutor,
    projectId: string,
    materials: ContextMaterial[],
    sections: string[],
  ): Promise<void> {
    const global = (
      await tx.query<{ content: string; version: number }>(
        "SELECT content, version FROM global_rule_settings WHERE id='global'",
      )
    ).rows[0];
    if (global?.content.trim()) {
      materials.push({
        kind: "global_rules",
        ref: `global-rules-v${global.version}`,
        content: global.content,
      });
      sections.push(section("Global NORN.md", global.content));
    }
    const project = (
      await tx.query<{ id: string; content: string; version: number }>(
        `SELECT id, content, version
           FROM project_memory_entries
          WHERE project_id=$1 AND phase_id IS NULL AND task_id IS NULL
            AND category='directive' AND status='active'
            AND source_ref->>'kind'='project_rules_file'
          ORDER BY version DESC, created_at DESC, id DESC LIMIT 1`,
        [projectId],
      )
    ).rows[0];
    if (project?.content.trim()) {
      materials.push({ kind: "project_rules", ref: project.id, content: project.content });
      sections.push(section("Project NORN.md", project.content));
    }
  }

  private async addKnowledge(
    tx: V2SqlExecutor,
    projectId: string,
    materials: ContextMaterial[],
    sections: string[],
  ): Promise<void> {
    const result = await tx.query<{ id: string; category: string; content: string }>(
      `SELECT id, category, content
         FROM project_memory_entries
        WHERE project_id=$1 AND status='active' AND approved_by_human=TRUE
          AND NOT (
            category='directive' AND source_ref->>'kind'='project_rules_file'
          )
        ORDER BY created_at ASC, id ASC`,
      [projectId],
    );
    if (result.rows.length === 0) return;
    for (const row of result.rows) {
      materials.push({ kind: "project_knowledge", ref: row.id, content: row.content });
    }
    sections.push(
      section(
        "Approved project knowledge and constraints",
        result.rows.map((row) => `- [${row.category}] ${row.content}`).join("\n"),
      ),
    );
  }

  /**
   * Project onboarding already records where work will run. Planning agents
   * must treat that selection as binding context instead of asking the human
   * for a local path that intentionally never leaves the selected computer.
   */
  private async addProjectSetup(
    tx: V2SqlExecutor,
    projectId: string,
    materials: ContextMaterial[],
    sections: string[],
  ): Promise<void> {
    const row = (
      await tx.query<{
        project_name: string;
        onboarding_scenario: string | null;
        workspace_kind: "local_runner" | "github" | null;
        workspace_display_name: string | null;
        workspace_github_owner: string | null;
        workspace_github_name: string | null;
        workspace_default_branch: string | null;
        workspace_status: string | null;
        remote_github_owner: string | null;
        remote_github_name: string | null;
        remote_default_branch: string | null;
      }>(
        `SELECT project.name AS project_name,
                project.onboarding_scenario,
                COALESCE(
                  workspace_binding.binding_type,
                  CASE workspace_candidate.source_type
                    WHEN 'local' THEN 'local_runner'
                    WHEN 'github' THEN 'github'
                    ELSE NULL
                  END
                ) AS workspace_kind,
                COALESCE(
                  workspace_binding.repository_display_name,
                  workspace_candidate.display_name
                ) AS workspace_display_name,
                COALESCE(
                  workspace_binding.github_owner,
                  workspace_candidate.github_owner
                ) AS workspace_github_owner,
                COALESCE(
                  workspace_binding.github_name,
                  workspace_candidate.github_name
                ) AS workspace_github_name,
                COALESCE(
                  workspace_binding.default_branch,
                  workspace_candidate.default_branch
                ) AS workspace_default_branch,
                COALESCE(
                  workspace_binding.status,
                  workspace_candidate.status
                ) AS workspace_status,
                remote_target.github_owner AS remote_github_owner,
                remote_target.github_name AS remote_github_name,
                remote_target.default_branch AS remote_default_branch
           FROM projects project
           LEFT JOIN repository_bindings workspace_binding
             ON workspace_binding.project_id=project.id
            AND workspace_binding.id=project.primary_repository_binding_id
            AND workspace_binding.role='workspace'
            AND workspace_binding.status NOT IN ('revoked','disconnected')
           LEFT JOIN LATERAL (
             SELECT candidate.source_type, candidate.display_name,
                    candidate.github_owner, candidate.github_name,
                    candidate.default_branch, candidate.status
               FROM repository_binding_candidates candidate
              WHERE candidate.project_id=project.id
                AND candidate.role='workspace'
                AND candidate.status<>'dismissed'
              ORDER BY CASE candidate.status WHEN 'promoted' THEN 0 ELSE 1 END,
                       candidate.created_at, candidate.id
              LIMIT 1
           ) workspace_candidate ON workspace_binding.id IS NULL
           LEFT JOIN LATERAL (
             SELECT target.github_owner, target.github_name, target.default_branch
               FROM (
                 SELECT binding.github_owner, binding.github_name,
                        binding.default_branch, 0 AS tier,
                        binding.created_at, binding.id
                   FROM repository_bindings binding
                  WHERE binding.project_id=project.id
                    AND binding.role='remote'
                    AND binding.status NOT IN ('revoked','disconnected')
                 UNION ALL
                 SELECT candidate.github_owner, candidate.github_name,
                        candidate.default_branch, 1 AS tier,
                        candidate.created_at, candidate.id
                   FROM repository_binding_candidates candidate
                  WHERE candidate.project_id=project.id
                    AND candidate.role='remote'
                    AND candidate.status<>'dismissed'
               ) target
              ORDER BY target.tier, target.created_at, target.id
              LIMIT 1
           ) remote_target ON true
          WHERE project.id=$1`,
        [projectId],
      )
    ).rows[0];
    if (!row || (!row.onboarding_scenario && !row.workspace_kind && !row.remote_github_name))
      return;

    const scenario =
      row.onboarding_scenario === "new_repo"
        ? "create a new repository"
        : row.onboarding_scenario === "existing_repo"
          ? "use an existing repository"
          : "use the configured project repository";
    const workspace =
      row.workspace_kind === "local_runner"
        ? [
            "Execution location: the computer selected during project setup.",
            row.workspace_display_name
              ? `Approved local repository: ${row.workspace_display_name}.`
              : "The approved local repository is resolved by the selected computer.",
            "Its filesystem path intentionally stays on that computer and is resolved by the runner at execution time.",
          ].join(" ")
        : row.workspace_kind === "github"
          ? `Execution location: GitHub Actions in ${
              row.workspace_github_owner && row.workspace_github_name
                ? `${row.workspace_github_owner}/${row.workspace_github_name}`
                : (row.workspace_display_name ?? "the configured repository")
            }${row.workspace_default_branch ? ` on branch ${row.workspace_default_branch}` : ""}.`
          : "The execution attachment is still being provisioned by project setup.";
    const remote =
      row.remote_github_owner && row.remote_github_name
        ? `GitHub repository: ${row.remote_github_owner}/${row.remote_github_name}${
            row.remote_default_branch ? `; default branch: ${row.remote_default_branch}` : ""
          }.`
        : null;
    const content = [
      `Project: ${row.project_name}.`,
      `Setup choice: ${scenario}.`,
      workspace,
      remote,
      row.workspace_status ? `Recorded attachment status: ${row.workspace_status}.` : null,
      "This setup choice is authoritative. Do not ask the user where the project should be built, do not request a local directory path during planning, and do not add choosing a build location as an open decision. The execution system will resolve the recorded target when work begins.",
    ]
      .filter((line): line is string => line !== null)
      .join("\n");
    materials.push({ kind: "project_setup", ref: projectId, content });
    sections.push(section("Authoritative project setup and execution target", content));
  }

  private async addSummary(
    tx: V2SqlExecutor,
    projectId: string,
    workItemId: string,
    conversationId: string,
    throughSequence: number,
    materials: ContextMaterial[],
    sections: string[],
  ): Promise<SummaryRow | null> {
    const row = (
      await tx.query<SummaryRow>(
        `SELECT id, through_message_sequence, summary, content_hash
          FROM conversation_summaries
          WHERE project_id=$1 AND work_item_id=$2 AND conversation_id=$3
            AND through_message_sequence<=$4
          ORDER BY version DESC LIMIT 1`,
        [projectId, workItemId, conversationId, throughSequence],
      )
    ).rows[0];
    if (!row) return null;
    const summary = V2ConversationSummaryContent.parse(
      typeof row.summary === "string" ? JSON.parse(row.summary) : row.summary,
    );
    const content = JSON.stringify(summary);
    materials.push({
      kind: "conversation_summary",
      ref: row.id,
      content,
      ...(row.content_hash ? { contentHash: row.content_hash } : {}),
    });
    sections.push(section("Latest compacted conversation summary", content));
    return row;
  }

  private async addDecisionsAndRisks(
    tx: V2SqlExecutor,
    projectId: string,
    workItemId: string,
    materials: ContextMaterial[],
    sections: string[],
  ): Promise<void> {
    const decisions = await tx.query<{ id: string; question: string; context: string }>(
      `SELECT id, question, context
         FROM decision_points
        WHERE project_id=$1 AND status='open'
        ORDER BY
          CASE urgency WHEN 'critical' THEN 0 WHEN 'high' THEN 1
                       WHEN 'normal' THEN 2 ELSE 3 END,
          created_at ASC, id ASC`,
      [projectId],
    );
    for (const decision of decisions.rows) {
      materials.push({
        kind: "decision",
        ref: decision.id,
        content: `${decision.question}\n${decision.context}`,
      });
    }
    const plan = (
      await tx.query<{ id: string; plan: unknown }>(
        `SELECT id, plan
           FROM work_plan_versions
          WHERE project_id=$1 AND work_item_id=$2
          ORDER BY version DESC LIMIT 1`,
        [projectId, workItemId],
      )
    ).rows[0];
    const rawPlan =
      typeof plan?.plan === "string"
        ? (JSON.parse(plan.plan) as Record<string, unknown>)
        : (plan?.plan as Record<string, unknown> | undefined);
    // Phase 1 stores the full WorkPlanContract envelope (`plan.risks`), while
    // legacy fixtures can contain a direct Plan Contract (`risks`). Accept
    // both without silently losing the mandated unresolved-risk context.
    const nestedPlan =
      rawPlan?.plan && typeof rawPlan.plan === "object"
        ? (rawPlan.plan as Record<string, unknown>)
        : undefined;
    const risks = Array.isArray(rawPlan?.risks)
      ? rawPlan.risks
      : Array.isArray(nestedPlan?.risks)
        ? nestedPlan.risks
        : [];
    const riskLines: string[] = [];
    risks.forEach((risk, index) => {
      const content = typeof risk === "string" ? risk : JSON.stringify(risk);
      riskLines.push(content);
      materials.push({
        kind: "risk",
        ref: `${plan?.id ?? workItemId}:risk:${index + 1}`,
        content,
      });
    });
    if (decisions.rows.length > 0 || riskLines.length > 0) {
      sections.push(
        section(
          "Unresolved decisions and risks",
          [
            ...decisions.rows.map(
              (decision) => `- Decision ${decision.id}: ${decision.question} — ${decision.context}`,
            ),
            ...riskLines.map((risk) => `- Risk: ${risk}`),
          ].join("\n"),
        ),
      );
    }
  }

  private async recentMessages(
    tx: V2SqlExecutor,
    projectId: string,
    workItemId: string,
    conversationId: string,
    afterSequence: number | string,
    triggeringMessageId: string,
  ): Promise<MessageRow[]> {
    const result = await tx.query<MessageRow>(
      `SELECT id, role, sequence, parts
         FROM (
           SELECT id, role, sequence, parts
             FROM work_messages
            WHERE project_id=$1 AND work_item_id=$2 AND conversation_id=$3
              AND visibility_status='complete'
              AND sequence>$4
              AND sequence<=(
                SELECT sequence FROM work_messages
                 WHERE project_id=$1 AND work_item_id=$2 AND conversation_id=$3
                   AND id=$6
              )
            ORDER BY sequence DESC
            LIMIT $5
         ) recent
        ORDER BY sequence ASC`,
      [
        projectId,
        workItemId,
        conversationId,
        Number(afterSequence),
        MAX_RECENT_MESSAGES,
        triggeringMessageId,
      ],
    );
    return result.rows;
  }

  private async addReferencedArtifacts(
    tx: V2SqlExecutor,
    projectId: string,
    attachmentIds: string[],
    artifactIds: string[],
    materials: ContextMaterial[],
    sections: string[],
  ): Promise<Map<string, string>> {
    const rendered: string[] = [];
    const fileContexts = new Map<string, string>();
    if (attachmentIds.length > 0) {
      const attachments = await tx.query<AttachmentRow>(
        `SELECT id, sha256, mime, original_filename, extracted_text,
                extracted_text_sha256, extraction_truncated
           FROM attachments
          WHERE project_id=$1 AND deleted_at IS NULL AND id=ANY($2::text[])
          ORDER BY id`,
        [projectId, attachmentIds],
      );
      const attachmentsById = new Map(
        attachments.rows.map((attachment) => [attachment.id, attachment]),
      );
      const orderedAttachments = attachmentIds.flatMap((attachmentId) => {
        const attachment = attachmentsById.get(attachmentId);
        return attachment ? [attachment] : [];
      });
      const fileAttachments = orderedAttachments.filter(
        (attachment) =>
          attachment.extracted_text !== null && attachment.extracted_text_sha256 !== null,
      );
      let remainingFileCharacters = MAX_TOTAL_FILE_CONTEXT_CHARACTERS;
      let seenFiles = 0;
      for (const attachment of orderedAttachments) {
        if (!attachment) continue;
        if (attachment.extracted_text !== null && attachment.extracted_text_sha256 !== null) {
          const remainingFiles = fileAttachments.slice(seenFiles + 1);
          const reservedForRemaining = remainingFiles.reduce(
            (total, candidate) => total + minimumFileBlock(candidate).length,
            0,
          );
          const availableForFile = Math.min(
            MAX_FILE_CONTEXT_CHARACTERS,
            Math.max(
              minimumFileBlock(attachment).length,
              remainingFileCharacters - reservedForRemaining,
            ),
          );
          const content = boundedFileBlock(attachment, availableForFile);
          materials.push({
            kind: "artifact",
            ref: attachment.id,
            content,
          });
          fileContexts.set(attachment.id, content);
          remainingFileCharacters -= content.length;
          seenFiles += 1;
        } else {
          const content = `image attachment ${attachment.id} (${attachment.mime})`;
          materials.push({
            kind: "artifact",
            ref: attachment.id,
            content,
            contentHash: attachment.sha256,
            estimatedTokens: 0,
          });
          rendered.push(`- ${content}`);
        }
      }
    }
    if (artifactIds.length > 0) {
      const artifacts = await tx.query<{
        id: string;
        label: string;
        media_type: string;
        content_hash: string;
      }>(
        `SELECT id, label, media_type, content_hash FROM artifacts
          WHERE project_id=$1 AND id=ANY($2::text[]) ORDER BY id`,
        [projectId, artifactIds],
      );
      for (const artifact of artifacts.rows) {
        const content = `${artifact.label} (${artifact.media_type}), id=${artifact.id}`;
        materials.push({
          kind: "artifact",
          ref: artifact.id,
          content,
          contentHash: artifact.content_hash,
        });
        rendered.push(`- ${content}`);
      }
    }
    if (rendered.length > 0) {
      sections.push(section("Referenced artifacts", rendered.join("\n")));
    }
    return fileContexts;
  }
}

function fileBlockHeader(attachment: AttachmentRow): string {
  return [
    `### File: ${attachment.original_filename}`,
    `Media type: ${attachment.mime}; attachment id: ${attachment.id}`,
    ...(attachment.extraction_truncated
      ? ["The stored extraction was truncated to the safe ingestion limit."]
      : []),
  ].join("\n");
}

function minimumFileBlock(attachment: AttachmentRow): string {
  return `${fileBlockHeader(attachment)}\n\n[File content omitted because the conversation attachment budget was exhausted]`;
}

function boundedFileBlock(attachment: AttachmentRow, characterBudget: number): string {
  if (attachment.extracted_text === null) return minimumFileBlock(attachment);
  const header = fileBlockHeader(attachment);
  const complete = `${header}\n\n${attachment.extracted_text}`;
  if (complete.length <= characterBudget) return complete;
  const marker = "\n\n[File context truncated to the conversation limit]";
  const prefixLength = Math.max(0, characterBudget - header.length - 2 - marker.length);
  if (prefixLength === 0) return minimumFileBlock(attachment);
  return `${header}\n\n${attachment.extracted_text.slice(0, prefixLength)}${marker}`;
}
