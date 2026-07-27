import {
  V2ConversationHandoff,
  type V2ConversationHandoffT,
  V2ConversationPlanningExcerptReceipt,
  type V2ConversationPlanningExcerptReceiptT,
  V2ConversationSummary,
  type V2ConversationSummaryT,
  V2ConversationUsage,
  type V2ConversationUsageT,
  V2CreateConversationPlanningExcerptInput,
  type V2CreateConversationPlanningExcerptInputT,
  V2WorkMessage,
  type V2WorkMessageT,
} from "@norns/contracts";
import { newId } from "../ids.js";
import { canonicalJson, canonicalSha256 } from "../persistence/migration/canonicalJson.js";
import type { V2SqlExecutor, V2TransactionRunner } from "../persistence/v2/database.js";
import { ConversationPersistenceError } from "./repository.js";

interface ExcerptRow {
  schema_version: 2;
  id: string;
  project_id: string;
  work_item_id: string;
  source_conversation_id: string;
  target_conversation_id: string;
  handoff_id: string;
  requested_by_user_id: string;
  idempotency_key: string;
  request_fingerprint: string;
  source_message_ids: unknown;
  source_message_hashes: unknown;
  result_message_id: string;
  created_at: Date | string;
}

interface MessageRow {
  schema_version: 2;
  id: string;
  project_id: string;
  work_item_id: string;
  conversation_id: string;
  initiated_by_user_id: string;
  actor_type: V2WorkMessageT["actor"]["actor_type"];
  actor_id: string | null;
  role: V2WorkMessageT["role"];
  visibility_status: V2WorkMessageT["visibility_status"];
  sequence: number | string;
  parts: unknown;
  client_message_id: string | null;
  request_fingerprint: string | null;
  created_at: Date | string;
}

export interface ExecutionConversationDetail {
  handoff: V2ConversationHandoffT | null;
  latest_summary: V2ConversationSummaryT | null;
  planning_excerpt_receipts: V2ConversationPlanningExcerptReceiptT[];
  usage: V2ConversationUsageT;
}

function json<T>(value: unknown): T {
  return typeof value === "string" ? (JSON.parse(value) as T) : (value as T);
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function messageHash(row: Pick<MessageRow, "sequence" | "role" | "parts">): string {
  return canonicalSha256({
    sequence: Number(row.sequence),
    role: row.role,
    parts: json(row.parts),
  });
}

function toMessage(row: MessageRow): V2WorkMessageT {
  return V2WorkMessage.parse({
    schema_version: row.schema_version,
    id: row.id,
    project_id: row.project_id,
    work_item_id: row.work_item_id,
    conversation_id: row.conversation_id,
    initiated_by_user_id: row.initiated_by_user_id,
    actor: { actor_type: row.actor_type, actor_id: row.actor_id },
    role: row.role,
    visibility_status: row.visibility_status,
    sequence: Number(row.sequence),
    parts: json(row.parts),
    client_message_id: row.client_message_id,
    request_fingerprint: row.request_fingerprint,
    created_at: iso(row.created_at),
  });
}

function toExcerpt(row: ExcerptRow): V2ConversationPlanningExcerptReceiptT {
  return V2ConversationPlanningExcerptReceipt.parse({
    ...row,
    source_message_ids: json(row.source_message_ids),
    source_message_hashes: json(row.source_message_hashes),
    created_at: iso(row.created_at),
  });
}

export class ExecutionConversationService {
  private readonly makeId: (prefix: string) => string;
  private readonly now: () => Date;

  constructor(
    private readonly transactions: V2TransactionRunner,
    options: { newId?: (prefix: string) => string; now?: () => Date } = {},
  ) {
    this.makeId = options.newId ?? newId;
    this.now = options.now ?? (() => new Date());
  }

  async detail(
    userId: string,
    projectId: string,
    workItemId: string,
    conversationId: string,
  ): Promise<ExecutionConversationDetail> {
    return this.transactions.transaction(async (tx) => {
      await this.assertAccess(tx, projectId, userId);
      await this.assertConversation(tx, projectId, workItemId, conversationId, false);
      const [handoffResult, summaryResult, excerptsResult, usage] = await Promise.all([
        tx.query<{
          schema_version: 2;
          id: string;
          project_id: string;
          work_item_id: string;
          source_conversation_id: string;
          target_conversation_id: string;
          approved_plan_version_id: string;
          created_by_user_id: string;
          kind: "planning_to_execution";
          package: unknown;
          content_hash: string;
          created_at: Date | string;
        }>(
          `SELECT schema_version, id, project_id, work_item_id,
                  source_conversation_id, target_conversation_id,
                  approved_plan_version_id, created_by_user_id, kind,
                  package, content_hash, created_at
             FROM conversation_handoffs
            WHERE project_id=$1 AND work_item_id=$2
              AND ($3 IN (source_conversation_id, target_conversation_id))
            ORDER BY created_at DESC, id DESC LIMIT 1`,
          [projectId, workItemId, conversationId],
        ),
        tx.query<{
          schema_version: 2;
          id: string;
          project_id: string;
          work_item_id: string;
          conversation_id: string;
          created_by_user_id: string;
          version: number | string;
          from_message_sequence: number | string;
          through_message_sequence: number | string;
          summary: unknown;
          content_hash: string;
          created_at: Date | string;
        }>(
          `SELECT schema_version, id, project_id, work_item_id, conversation_id,
                  created_by_user_id, version, from_message_sequence,
                  through_message_sequence, summary, content_hash, created_at
             FROM conversation_summaries
            WHERE project_id=$1 AND work_item_id=$2 AND conversation_id=$3
            ORDER BY version DESC, id DESC LIMIT 1`,
          [projectId, workItemId, conversationId],
        ),
        tx.query<ExcerptRow>(
          `SELECT schema_version, id, project_id, work_item_id,
                  source_conversation_id, target_conversation_id, handoff_id,
                  requested_by_user_id, idempotency_key, request_fingerprint,
                  source_message_ids, source_message_hashes, result_message_id,
                  created_at
             FROM conversation_planning_excerpt_receipts
            WHERE project_id=$1 AND work_item_id=$2 AND target_conversation_id=$3
            ORDER BY created_at, id`,
          [projectId, workItemId, conversationId],
        ),
        this.usageInTransaction(tx, projectId, conversationId),
      ]);
      const handoffRow = handoffResult.rows[0];
      const summaryRow = summaryResult.rows[0];
      const handoff = handoffRow
        ? V2ConversationHandoff.parse({
            ...handoffRow,
            package: json(handoffRow.package),
            created_at: iso(handoffRow.created_at),
          })
        : null;
      if (handoff && canonicalSha256(handoff.package) !== handoff.content_hash) {
        throw new Error("durable handoff hash mismatch");
      }
      const latest_summary = summaryRow
        ? V2ConversationSummary.parse({
            ...summaryRow,
            version: Number(summaryRow.version),
            from_message_sequence: Number(summaryRow.from_message_sequence),
            through_message_sequence: Number(summaryRow.through_message_sequence),
            summary: json(summaryRow.summary),
            created_at: iso(summaryRow.created_at),
          })
        : null;
      if (
        latest_summary &&
        canonicalSha256(latest_summary.summary) !== latest_summary.content_hash
      ) {
        throw new Error("durable conversation summary hash mismatch");
      }
      return {
        handoff,
        latest_summary,
        planning_excerpt_receipts: excerptsResult.rows.map(toExcerpt),
        usage,
      };
    });
  }

  async usageByWorkItem(
    userId: string,
    projectId: string,
    conversationIds: readonly string[],
  ): Promise<Record<string, V2ConversationUsageT>> {
    return this.transactions.transaction(async (tx) => {
      await this.assertAccess(tx, projectId, userId);
      const result: Record<string, V2ConversationUsageT> = {};
      for (const conversationId of conversationIds) {
        result[conversationId] = await this.usageInTransaction(tx, projectId, conversationId);
      }
      return result;
    });
  }

  async createPlanningExcerpt(
    userId: string,
    projectId: string,
    workItemId: string,
    targetConversationId: string,
    candidate: V2CreateConversationPlanningExcerptInputT,
  ): Promise<{
    message: V2WorkMessageT;
    receipt: V2ConversationPlanningExcerptReceiptT;
  }> {
    const input = V2CreateConversationPlanningExcerptInput.parse(candidate);
    const fingerprint = canonicalSha256({
      source_conversation_id: input.source_conversation_id,
      message_ids: input.message_ids,
    });
    return this.transactions.transaction(async (tx) => {
      await this.assertAccess(tx, projectId, userId);
      const target = await this.assertConversation(
        tx,
        projectId,
        workItemId,
        targetConversationId,
        true,
      );
      if (target.kind !== "execution_pm" || target.status !== "active") {
        throw new ConversationPersistenceError(
          "conversation_inactive",
          "planning excerpts can be requested only from an active execution PM conversation",
        );
      }
      const existing = (
        await tx.query<ExcerptRow>(
          `SELECT schema_version, id, project_id, work_item_id,
                  source_conversation_id, target_conversation_id, handoff_id,
                  requested_by_user_id, idempotency_key, request_fingerprint,
                  source_message_ids, source_message_hashes, result_message_id,
                  created_at
             FROM conversation_planning_excerpt_receipts
            WHERE target_conversation_id=$1 AND requested_by_user_id=$2
              AND idempotency_key=$3`,
          [targetConversationId, userId, input.idempotency_key],
        )
      ).rows[0];
      if (existing) {
        if (existing.request_fingerprint !== fingerprint) {
          throw new ConversationPersistenceError(
            "idempotency_conflict",
            `planning excerpt key "${input.idempotency_key}" was reused`,
          );
        }
        const message = await this.messageById(tx, existing.result_message_id);
        return { message: toMessage(message), receipt: toExcerpt(existing) };
      }
      const handoff = (
        await tx.query<{
          id: string;
          source_conversation_id: string;
        }>(
          `SELECT id, source_conversation_id
             FROM conversation_handoffs
            WHERE project_id=$1 AND work_item_id=$2
              AND source_conversation_id=$3 AND target_conversation_id=$4`,
          [projectId, workItemId, input.source_conversation_id, targetConversationId],
        )
      ).rows[0];
      if (!handoff) {
        throw new ConversationPersistenceError(
          "conversation_scope_mismatch",
          "the requested planning conversation is not the execution handoff source",
        );
      }
      const selected = await tx.query<MessageRow>(
        `SELECT schema_version, id, project_id, work_item_id, conversation_id,
                initiated_by_user_id, actor_type, actor_id, role,
                visibility_status, sequence, parts, client_message_id,
                request_fingerprint, created_at
           FROM work_messages
          WHERE project_id=$1 AND work_item_id=$2 AND conversation_id=$3
            AND visibility_status='complete' AND id=ANY($4::text[])
          ORDER BY sequence, id`,
        [projectId, workItemId, input.source_conversation_id, input.message_ids],
      );
      if (selected.rows.length !== input.message_ids.length) {
        throw new ConversationPersistenceError(
          "message_not_found",
          "one or more requested planning messages are unavailable or incomplete",
        );
      }
      const sourceMessageIds = selected.rows.map((message) => message.id);
      const canonicalSourceMessages = selected.rows.map((message) =>
        canonicalJson({
          sequence: Number(message.sequence),
          role: message.role,
          parts: json(message.parts),
        }),
      );
      const serializedBytes = canonicalSourceMessages.reduce(
        (total, message) => total + Buffer.byteLength(message, "utf8"),
        0,
      );
      if (serializedBytes > 128 * 1024) {
        throw new ConversationPersistenceError(
          "excerpt_too_large",
          "planning excerpts are limited to 128 KiB; select fewer or smaller messages",
        );
      }
      const sourceMessageHashes = selected.rows.map(messageHash);
      const receiptId = this.makeId("planning_excerpt");
      const messageId = this.makeId("message");
      const now = this.now().toISOString();
      const sequence = (
        await tx.query<{ sequence: number | string }>(
          `UPDATE work_conversations
              SET next_message_sequence=next_message_sequence+1, updated_at=$2
            WHERE id=$1 AND status='active'
            RETURNING next_message_sequence-1 AS sequence`,
          [targetConversationId, now],
        )
      ).rows[0]?.sequence;
      if (sequence === undefined) {
        throw new ConversationPersistenceError(
          "conversation_inactive",
          "execution conversation is no longer active",
        );
      }
      const messageRow = (
        await tx.query<MessageRow>(
          `INSERT INTO work_messages (
             id, project_id, work_item_id, conversation_id, initiated_by_user_id,
             actor_type, actor_id, role, visibility_status, sequence, parts, created_at
           ) VALUES ($1,$2,$3,$4,$5,'system',NULL,'system','complete',$6,$7::jsonb,$8)
           RETURNING schema_version, id, project_id, work_item_id, conversation_id,
                     initiated_by_user_id, actor_type, actor_id, role,
                     visibility_status, sequence, parts, client_message_id,
                     request_fingerprint, created_at`,
          [
            messageId,
            projectId,
            workItemId,
            targetConversationId,
            userId,
            Number(sequence),
            JSON.stringify([
              {
                type: "text",
                format: "markdown",
                text: `Planning excerpt requested (${sourceMessageIds.length} message${sourceMessageIds.length === 1 ? "" : "s"}).`,
              },
              { type: "planning_excerpt", excerpt_receipt_id: receiptId },
            ]),
            now,
          ],
        )
      ).rows[0];
      if (!messageRow) throw new Error("planning excerpt message insert returned no row");
      const receiptRow = (
        await tx.query<ExcerptRow>(
          `INSERT INTO conversation_planning_excerpt_receipts (
             id, project_id, work_item_id, source_conversation_id,
             target_conversation_id, handoff_id, requested_by_user_id,
             idempotency_key, request_fingerprint, source_message_ids,
             source_message_hashes, canonical_source_messages,
             result_message_id, created_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13,$14)
           RETURNING schema_version, id, project_id, work_item_id,
                     source_conversation_id, target_conversation_id, handoff_id,
                     requested_by_user_id, idempotency_key, request_fingerprint,
                     source_message_ids, source_message_hashes, result_message_id,
                     created_at`,
          [
            receiptId,
            projectId,
            workItemId,
            input.source_conversation_id,
            targetConversationId,
            handoff.id,
            userId,
            input.idempotency_key,
            fingerprint,
            JSON.stringify(sourceMessageIds),
            JSON.stringify(sourceMessageHashes),
            JSON.stringify(canonicalSourceMessages),
            messageId,
            now,
          ],
        )
      ).rows[0];
      if (!receiptRow) throw new Error("planning excerpt receipt insert returned no row");
      return { message: toMessage(messageRow), receipt: toExcerpt(receiptRow) };
    });
  }

  private async usageInTransaction(
    tx: V2SqlExecutor,
    projectId: string,
    conversationId: string,
  ): Promise<V2ConversationUsageT> {
    const row = (
      await tx.query<{
        attempt_count: number | string;
        input_tokens: number | string | null;
        output_tokens: number | string | null;
        exact_cost: number | string | null;
        pending_count: number | string;
        unavailable_count: number | string;
      }>(
        `WITH qc_events AS (
           SELECT review.id AS review_id, review.status AS review_status, event.*
             FROM conversation_plan_reviews review
             LEFT JOIN ai_usage_events event
               ON event.project_id=review.project_id
              AND left(event.request_id, length(review.usage_request_group_id)+1)
                    =review.usage_request_group_id || ':'
            WHERE review.project_id=$1 AND review.conversation_id=$2
         ), qc_requests AS (
           SELECT review_id, review_status, request_id
             FROM qc_events
            WHERE event_type='request_started'
         ), qc_usage_ranked AS (
           SELECT event.*,
                  row_number() OVER (
                    PARTITION BY review_id, request_id
                    ORDER BY sequence DESC, recorded_at DESC, id DESC
                  ) AS usage_rank
             FROM qc_events event
            WHERE event_type='usage_observed'
         ), qc_adjustments AS (
           SELECT review_id, request_id,
                  coalesce(sum(input_tokens),0) AS input_tokens,
                  coalesce(sum(output_tokens),0) AS output_tokens,
                  coalesce(sum(cost_usd),0) AS cost_usd
             FROM qc_events
            WHERE event_type='adjustment'
            GROUP BY review_id, request_id
         ), qc_request_facts AS (
           SELECT request.review_id, request.review_status, request.request_id,
                  usage.id AS usage_event_id,
                  coalesce(usage.input_tokens,0)+coalesce(adjustment.input_tokens,0)
                    AS input_tokens,
                  coalesce(usage.output_tokens,0)+coalesce(adjustment.output_tokens,0)
                    AS output_tokens,
                  CASE WHEN usage.id IS NULL OR usage.cost_usd IS NULL THEN NULL
                       ELSE usage.cost_usd+coalesce(adjustment.cost_usd,0)
                  END AS cost_usd
             FROM qc_requests request
             LEFT JOIN qc_usage_ranked usage
               ON usage.review_id=request.review_id
              AND usage.request_id=request.request_id
              AND usage.usage_rank=1
             LEFT JOIN qc_adjustments adjustment
               ON adjustment.review_id=request.review_id
              AND adjustment.request_id=request.request_id
         ), qc_usage AS (
           SELECT review.id, review.status,
                  count(fact.request_id) AS started_requests,
                  count(fact.usage_event_id) AS observed_requests,
                  coalesce(sum(fact.input_tokens),0) AS input_tokens,
                  coalesce(sum(fact.output_tokens),0) AS output_tokens,
                  sum(fact.cost_usd) AS cost_usd,
                  count(*) FILTER (
                    WHERE fact.usage_event_id IS NOT NULL AND fact.cost_usd IS NULL
                  ) AS unavailable_observations
             FROM conversation_plan_reviews review
             LEFT JOIN qc_request_facts fact ON fact.review_id=review.id
            WHERE review.project_id=$1 AND review.conversation_id=$2
            GROUP BY review.id, review.status
         ), attempts AS (
           SELECT usage_status, input_tokens, output_tokens, cost_usd, 1 AS attempt_count
             FROM conversation_turn_attempts
            WHERE project_id=$1 AND conversation_id=$2
           UNION ALL
           SELECT usage_status, input_tokens, output_tokens, cost_usd, 1 AS attempt_count
             FROM conversation_plan_proposal_attempts
            WHERE project_id=$1 AND conversation_id=$2
           UNION ALL
           SELECT CASE
                    WHEN status IN ('queued','running') THEN 'pending'
                    WHEN observed_requests=0 OR observed_requests<>started_requests
                      OR unavailable_observations>0
                      THEN 'unavailable'
                    ELSE 'exact'
                  END AS usage_status,
                  input_tokens, output_tokens,
                  CASE
                    WHEN observed_requests>0 AND observed_requests=started_requests
                      AND unavailable_observations=0
                      THEN coalesce(cost_usd,0)
                    ELSE NULL
                  END AS cost_usd,
                  started_requests::int AS attempt_count
             FROM qc_usage
         )
         SELECT coalesce(sum(attempt_count),0) AS attempt_count,
                coalesce(sum(input_tokens),0) AS input_tokens,
                coalesce(sum(output_tokens),0) AS output_tokens,
                CASE WHEN count(*) FILTER (
                  WHERE usage_status<>'exact' OR cost_usd IS NULL
                )=0 THEN coalesce(sum(cost_usd),0) ELSE NULL END AS exact_cost,
                count(*) FILTER (WHERE usage_status='pending') AS pending_count,
                count(*) FILTER (
                  WHERE usage_status='unavailable'
                     OR (usage_status='exact' AND cost_usd IS NULL)
                ) AS unavailable_count
           FROM attempts`,
        [projectId, conversationId],
      )
    ).rows[0];
    const attemptCount = Number(row?.attempt_count ?? 0);
    const pending = Number(row?.pending_count ?? 0) > 0;
    const unavailable = Number(row?.unavailable_count ?? 0) > 0;
    const usageStatus = pending ? "pending" : unavailable ? "unavailable" : "exact";
    return V2ConversationUsage.parse({
      input_tokens: Number(row?.input_tokens ?? 0),
      output_tokens: Number(row?.output_tokens ?? 0),
      cost_usd: usageStatus === "exact" ? Number(row?.exact_cost ?? 0) : null,
      exact_cost: usageStatus === "exact",
      usage_status: usageStatus,
      attempt_count: attemptCount,
    });
  }

  private async messageById(tx: V2SqlExecutor, id: string): Promise<MessageRow> {
    const row = (
      await tx.query<MessageRow>(
        `SELECT schema_version, id, project_id, work_item_id, conversation_id,
                initiated_by_user_id, actor_type, actor_id, role,
                visibility_status, sequence, parts, client_message_id,
                request_fingerprint, created_at
           FROM work_messages WHERE id=$1`,
        [id],
      )
    ).rows[0];
    if (!row) throw new Error(`unknown excerpt result message "${id}"`);
    return row;
  }

  private async assertConversation(
    tx: V2SqlExecutor,
    projectId: string,
    workItemId: string,
    conversationId: string,
    lock: boolean,
  ): Promise<{ kind: string; status: string }> {
    const row = (
      await tx.query<{ kind: string; status: string }>(
        `SELECT kind, status FROM work_conversations
          WHERE project_id=$1 AND work_item_id=$2 AND id=$3
          ${lock ? "FOR UPDATE" : ""}`,
        [projectId, workItemId, conversationId],
      )
    ).rows[0];
    if (!row) {
      throw new ConversationPersistenceError(
        "conversation_not_found",
        "conversation not found in the requested scope",
      );
    }
    return row;
  }

  private async assertAccess(tx: V2SqlExecutor, projectId: string, userId: string): Promise<void> {
    const row = (
      await tx.query<{
        user_id: string | null;
        user_status: string | null;
        identity_role: string | null;
        project_id: string | null;
        owner_user_id: string | null;
        active_member: boolean;
      }>(
        `SELECT identity.id AS user_id, identity.status AS user_status,
                identity.role AS identity_role, project.id AS project_id,
                project.owner_user_id,
                EXISTS (
                  SELECT 1 FROM project_members membership
                   WHERE membership.project_id=project.id
                     AND membership.user_id=$1
                     AND membership.status='active'
                ) AS active_member
           FROM users identity
           LEFT JOIN projects project ON project.id=$2
          WHERE identity.id=$1`,
        [userId, projectId],
      )
    ).rows[0];
    if (!row?.user_id || row.user_status !== "active") {
      throw new ConversationPersistenceError("forbidden", "active user identity is required");
    }
    if (!row.project_id) {
      throw new ConversationPersistenceError("project_not_found", "unknown project");
    }
    if (row.identity_role !== "admin" && row.owner_user_id !== userId && !row.active_member) {
      throw new ConversationPersistenceError("forbidden", "project access is forbidden");
    }
  }
}
