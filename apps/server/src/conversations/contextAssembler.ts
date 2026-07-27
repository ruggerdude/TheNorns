import type { ConversationMessage } from "@norns/adapters";
import {
  V2ConversationContextManifest,
  type V2ConversationContextManifestT,
  V2ConversationSummaryContent,
  V2WorkMessagePart,
  type V2WorkMessagePartT,
} from "@norns/contracts";
import { canonicalSha256 } from "../persistence/migration/canonicalJson.js";
import type { V2SqlExecutor, V2TransactionRunner } from "../persistence/v2/database.js";
import {
  CONVERSATIONAL_PM_INSTRUCTIONS,
  CONVERSATIONAL_PM_PROMPT_VERSION,
  conversationalPmSystem,
} from "./prompt.js";

const MAX_RECENT_MESSAGES = 50;

interface ContextMaterial {
  kind: V2ConversationContextManifestT["entries"][number]["kind"];
  ref: string;
  content: string;
  contentHash?: string;
  estimatedTokens?: number;
}

interface SummaryRow {
  id: string;
  through_message_sequence: number | string;
  summary: unknown;
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
  const parsed = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? JSON.parse(value)
      : value;
  return Array.isArray(parsed) ? parsed.map((part) => V2WorkMessagePart.parse(part)) : [];
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
      }
    })
    .join("\n\n");
}

function section(label: string, content: string): string {
  return `## ${label}\n${content}`;
}

/**
 * A bounded, provider-neutral context receipt. The SQL order below is the
 * product priority order; manifest entries and rendered system sections are
 * derived from the same exact strings so their hashes remain auditable.
 */
export class ConversationContextAssembler {
  constructor(private readonly transactions: V2TransactionRunner) {}

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
        triggering_message_sequence: number | string;
      }>(
        `SELECT item.id, item.objective,
                triggering_message.sequence AS triggering_message_sequence
           FROM work_items item
           JOIN work_conversations conversation
             ON conversation.project_id=item.project_id
            AND conversation.work_item_id=item.id
           JOIN work_messages triggering_message
             ON triggering_message.project_id=item.project_id
            AND triggering_message.work_item_id=item.id
            AND triggering_message.conversation_id=conversation.id
            AND triggering_message.id=$4
          WHERE item.project_id=$1 AND item.id=$2 AND conversation.id=$3`,
        [projectId, workItemId, conversationId, triggeringMessageId],
      );
      const work = scope.rows[0];
      if (!work) throw new Error("conversation scope not found");

      const materials: ContextMaterial[] = [];
      const systemSections: string[] = [];
      materials.push({
        kind: "prompt",
        ref: CONVERSATIONAL_PM_PROMPT_VERSION,
        content: CONVERSATIONAL_PM_INSTRUCTIONS,
      });
      await this.addRules(tx, projectId, materials, systemSections);
      await this.addKnowledge(tx, projectId, materials, systemSections);

      materials.push({ kind: "work_objective", ref: workItemId, content: work.objective });
      systemSections.push(section("Current work objective", work.objective));

      const summary = await this.addSummary(
        tx,
        projectId,
        workItemId,
        conversationId,
        Number(work.triggering_message_sequence),
        materials,
        systemSections,
      );
      await this.addDecisionsAndRisks(tx, projectId, workItemId, materials, systemSections);
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
      const artifactIds: string[] = [];
      for (const row of recent) {
        const parsedParts = parts(row.parts);
        const content = visibleText(parsedParts);
        if (!content) continue;
        materials.push({ kind: "message", ref: row.id, content });
        if (row.role !== "system") {
          messages.push({ role: row.role, content });
          if (row.id === triggeringMessageId) triggeringMessageIndex = messages.length - 1;
        }
        for (const part of parsedParts) {
          if (part.type === "attachment") {
            attachmentIds.push(part.attachment_id);
            if (row.id === triggeringMessageId) currentAttachmentIds.push(part.attachment_id);
          }
          if (part.type === "artifact") artifactIds.push(part.artifact_id);
        }
      }
      await this.addReferencedArtifacts(
        tx,
        projectId,
        [...new Set(attachmentIds)],
        [...new Set(artifactIds)],
        materials,
        systemSections,
      );

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
        system: conversationalPmSystem(systemSections.join("\n\n")),
        messages,
        attachment_ids: [...new Set(currentAttachmentIds)],
        triggering_message_index: triggeringMessageIndex,
      };
    });
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
        `SELECT id, through_message_sequence, summary
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
    materials.push({ kind: "conversation_summary", ref: row.id, content });
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
  ): Promise<void> {
    const rendered: string[] = [];
    if (attachmentIds.length > 0) {
      const attachments = await tx.query<AttachmentRow>(
        `SELECT id, sha256, mime FROM attachments
          WHERE project_id=$1 AND deleted_at IS NULL AND id=ANY($2::text[])
          ORDER BY id`,
        [projectId, attachmentIds],
      );
      for (const attachment of attachments.rows) {
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
  }
}
