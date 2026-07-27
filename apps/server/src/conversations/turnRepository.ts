import {
  type V2ConversationContextManifestT,
  V2ConversationTurnAttempt,
  type V2ConversationTurnAttemptT,
  V2WorkMessagePart,
  type V2WorkMessagePartT,
  type V2WorkMessageT,
} from "@norns/contracts";
import type { UsageEventT } from "@norns/contracts";
import type { V2SqlExecutor, V2TransactionRunner } from "../persistence/v2/database.js";
import { ConversationPersistenceError } from "./repository.js";

interface AttemptRow {
  schema_version: 2;
  id: string;
  project_id: string;
  work_item_id: string;
  conversation_id: string;
  initiated_by_user_id: string;
  actor_type: V2ConversationTurnAttemptT["actor"]["actor_type"];
  actor_id: string | null;
  triggering_message_id: string;
  output_message_id: string | null;
  attempt_number: number | string;
  provider: string;
  model: string;
  provider_request_id: string | null;
  usage_request_id: string;
  provider_finish_reason: string | null;
  status: V2ConversationTurnAttemptT["status"];
  context_manifest: unknown;
  context_hash: string;
  usage_status: V2ConversationTurnAttemptT["usage_status"];
  input_tokens: number | string | null;
  output_tokens: number | string | null;
  cache_read_tokens: number | string | null;
  cache_write_tokens: number | string | null;
  cost_usd: number | string | null;
  failure_code: string | null;
  failure_message_redacted: string | null;
  sanitized_failure: unknown;
  started_at: string | Date;
  settled_at: string | Date | null;
  created_at: string | Date;
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
  created_at: string | Date;
}

const attemptColumns = `schema_version, id, project_id, work_item_id, conversation_id,
  initiated_by_user_id, actor_type, actor_id, triggering_message_id, output_message_id,
  attempt_number, provider, model, provider_request_id, usage_request_id,
  provider_finish_reason, status, context_manifest, context_hash, usage_status,
  input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd,
  failure_code, failure_message_redacted, sanitized_failure, started_at, settled_at, created_at`;

const messageColumns = `schema_version, id, project_id, work_item_id, conversation_id,
  initiated_by_user_id, actor_type, actor_id, role, visibility_status, sequence,
  parts, client_message_id, request_fingerprint, created_at`;

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function nullableIso(value: string | Date | null): string | null {
  return value === null ? null : iso(value);
}

function nullableNumber(value: number | string | null): number | null {
  return value === null ? null : Number(value);
}

function attempt(row: AttemptRow): V2ConversationTurnAttemptT {
  return V2ConversationTurnAttempt.parse({
    schema_version: row.schema_version,
    id: row.id,
    project_id: row.project_id,
    work_item_id: row.work_item_id,
    conversation_id: row.conversation_id,
    initiated_by_user_id: row.initiated_by_user_id,
    actor: { actor_type: row.actor_type, actor_id: row.actor_id },
    triggering_message_id: row.triggering_message_id,
    output_message_id: row.output_message_id,
    attempt_number: Number(row.attempt_number),
    provider: row.provider,
    model: row.model,
    provider_request_id: row.provider_request_id,
    usage_request_id: row.usage_request_id,
    provider_finish_reason: row.provider_finish_reason,
    status: row.status,
    context_manifest:
      typeof row.context_manifest === "string"
        ? JSON.parse(row.context_manifest)
        : row.context_manifest,
    context_hash: row.context_hash,
    usage_status: row.usage_status,
    input_tokens: nullableNumber(row.input_tokens),
    output_tokens: nullableNumber(row.output_tokens),
    cache_read_tokens: nullableNumber(row.cache_read_tokens),
    cache_write_tokens: nullableNumber(row.cache_write_tokens),
    cost_usd: nullableNumber(row.cost_usd),
    failure_code: row.failure_code,
    failure_message_redacted: row.failure_message_redacted,
    sanitized_failure:
      typeof row.sanitized_failure === "string"
        ? JSON.parse(row.sanitized_failure)
        : row.sanitized_failure,
    started_at: iso(row.started_at),
    settled_at: nullableIso(row.settled_at),
    created_at: iso(row.created_at),
  });
}

function message(row: MessageRow): V2WorkMessageT {
  return {
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
    parts:
      typeof row.parts === "string"
        ? (JSON.parse(row.parts) as V2WorkMessagePartT[])
        : (row.parts as V2WorkMessagePartT[]),
    client_message_id: row.client_message_id,
    request_fingerprint: row.request_fingerprint,
    created_at: iso(row.created_at),
  };
}

function textParts(text: string): V2WorkMessagePartT[] {
  return [V2WorkMessagePart.parse({ type: "text", format: "markdown", text })];
}

export interface BeginConversationAttempt {
  attemptId: string;
  usageRequestId: string;
  projectId: string;
  workItemId: string;
  conversationId: string;
  initiatedByUserId: string;
  triggeringMessageId: string;
  provider: string;
  model: string;
  manifest: V2ConversationContextManifestT;
  contextHash: string;
  startedAt: string;
}

export interface BegunConversationAttempt {
  attempt: V2ConversationTurnAttemptT;
}

export interface ConversationAttemptUsage {
  usageStatus: "exact" | "unavailable";
  usage?: UsageEventT | undefined;
}

export interface ConversationAttemptFailure extends ConversationAttemptUsage {
  code: string;
  messageRedacted: string;
  sanitized: Record<string, unknown> | null;
  providerRequestId?: string | null | undefined;
  finishReason?: string | null | undefined;
}

export class ConversationTurnRepository {
  constructor(private readonly transactions: V2TransactionRunner) {}

  hasActivePlanProposal(conversationId: string): Promise<boolean> {
    return this.transactions.transaction(async (tx) =>
      Boolean(
        (
          await tx.query<{ id: string }>(
            `SELECT id FROM conversation_plan_proposal_attempts
              WHERE conversation_id=$1 AND status='pending' LIMIT 1`,
            [conversationId],
          )
        ).rows[0],
      ),
    );
  }

  begin(input: BeginConversationAttempt): Promise<BegunConversationAttempt> {
    return this.transactions.transaction(async (tx) => {
      const conversation = (
        await tx.query<{ status: string; provider: string; model: string }>(
          `SELECT status, provider, model
             FROM work_conversations
            WHERE project_id=$1 AND work_item_id=$2 AND id=$3
            FOR UPDATE`,
          [input.projectId, input.workItemId, input.conversationId],
        )
      ).rows[0];
      if (!conversation) {
        throw new ConversationPersistenceError(
          "conversation_not_found",
          `unknown conversation "${input.conversationId}" in the requested scope`,
        );
      }
      if (conversation.status !== "active") {
        throw new ConversationPersistenceError(
          "conversation_inactive",
          `conversation "${input.conversationId}" is ${conversation.status}`,
        );
      }
      if (conversation.provider !== input.provider || conversation.model !== input.model) {
        throw new ConversationPersistenceError(
          "request_fingerprint_mismatch",
          "turn provider/model does not match the immutable conversation pin",
        );
      }
      if (
        (
          await tx.query<{ id: string }>(
            `SELECT id FROM conversation_plan_proposal_attempts
              WHERE conversation_id=$1 AND status='pending' LIMIT 1`,
            [input.conversationId],
          )
        ).rows[0]
      ) {
        throw new ConversationPersistenceError(
          "conversation_inactive",
          "wait for the active plan proposal before starting a PM response",
        );
      }
      const trigger = (
        await tx.query<{ id: string }>(
          `SELECT id FROM work_messages
            WHERE project_id=$1 AND work_item_id=$2 AND conversation_id=$3
              AND id=$4 AND role='user'`,
          [input.projectId, input.workItemId, input.conversationId, input.triggeringMessageId],
        )
      ).rows[0];
      if (!trigger) {
        throw new ConversationPersistenceError(
          "request_fingerprint_mismatch",
          "turn trigger must be an attributable user message in this conversation",
        );
      }
      const latestTrigger = (
        await tx.query<{ id: string }>(
          `SELECT id
             FROM work_messages
            WHERE project_id=$1 AND work_item_id=$2 AND conversation_id=$3
              AND role='user'
            ORDER BY sequence DESC
            LIMIT 1`,
          [input.projectId, input.workItemId, input.conversationId],
        )
      ).rows[0];
      if (latestTrigger?.id !== input.triggeringMessageId) {
        throw new ConversationPersistenceError(
          "historical_retry_forbidden",
          "only the latest user message can start or retry a response",
        );
      }
      const active = (
        await tx.query<{ id: string }>(
          `SELECT id FROM conversation_turn_attempts
            WHERE conversation_id=$1 AND status IN ('pending','streaming')
            LIMIT 1`,
          [input.conversationId],
        )
      ).rows[0];
      if (active) {
        throw new ConversationPersistenceError(
          "conversation_inactive",
          `conversation "${input.conversationId}" already has an active turn`,
        );
      }
      const attemptNumber = Number(
        (
          await tx.query<{ attempt_number: number | string }>(
            `SELECT coalesce(max(attempt_number),0)+1 AS attempt_number
               FROM conversation_turn_attempts
              WHERE conversation_id=$1 AND triggering_message_id=$2`,
            [input.conversationId, input.triggeringMessageId],
          )
        ).rows[0]?.attempt_number ?? 1,
      );
      const inserted = (
        await tx.query<AttemptRow>(
          `INSERT INTO conversation_turn_attempts (
             id, project_id, work_item_id, conversation_id, initiated_by_user_id,
             actor_type, actor_id, triggering_message_id, output_message_id,
             attempt_number, provider, model, usage_request_id, status,
             context_manifest, context_hash, usage_status, started_at
           ) VALUES (
             $1,$2,$3,$4,$5,'agent',$6,$7,NULL,$8,$9,$10,$11,'pending',
             $12::jsonb,$13,'pending',$14
           )
           RETURNING ${attemptColumns}`,
          [
            input.attemptId,
            input.projectId,
            input.workItemId,
            input.conversationId,
            input.initiatedByUserId,
            `pm:${input.conversationId}`,
            input.triggeringMessageId,
            attemptNumber,
            input.provider,
            input.model,
            input.usageRequestId,
            JSON.stringify(input.manifest),
            input.contextHash,
            input.startedAt,
          ],
        )
      ).rows[0];
      if (!inserted) throw new Error("conversation turn attempt insert returned no row");
      return { attempt: attempt(inserted) };
    });
  }

  markDispatched(
    attemptId: string,
    providerRequestId: string,
  ): Promise<V2ConversationTurnAttemptT> {
    return this.transactions.transaction(async (tx) => {
      const row = (
        await tx.query<AttemptRow>(
          `UPDATE conversation_turn_attempts
              SET status='streaming', provider_request_id=$2
            WHERE id=$1 AND status='pending'
            RETURNING ${attemptColumns}`,
          [attemptId, providerRequestId],
        )
      ).rows[0];
      if (!row) throw new Error(`attempt "${attemptId}" cannot enter streaming`);
      return attempt(row);
    });
  }

  startVisibleOutput(
    attemptId: string,
    outputMessageId: string,
    text: string,
  ): Promise<{ attempt: V2ConversationTurnAttemptT; output_message: V2WorkMessageT }> {
    return this.transactions.transaction(async (tx) => {
      const locked = await this.lockAttempt(tx, attemptId);
      if (
        !locked ||
        locked.status !== "streaming" ||
        locked.provider_request_id === null ||
        locked.output_message_id !== null
      ) {
        throw new Error(`attempt "${attemptId}" cannot allocate visible output`);
      }
      const sequence = (
        await tx.query<{ sequence: number | string }>(
          `UPDATE work_conversations
              SET next_message_sequence=next_message_sequence+1, updated_at=now()
            WHERE project_id=$1 AND work_item_id=$2 AND id=$3 AND status='active'
            RETURNING next_message_sequence-1 AS sequence`,
          [locked.project_id, locked.work_item_id, locked.conversation_id],
        )
      ).rows[0]?.sequence;
      if (sequence === undefined) {
        throw new ConversationPersistenceError(
          "conversation_inactive",
          `conversation "${locked.conversation_id}" is not active`,
        );
      }
      const output = (
        await tx.query<MessageRow>(
          `INSERT INTO work_messages (
             id, project_id, work_item_id, conversation_id, initiated_by_user_id,
             actor_type, actor_id, role, visibility_status, sequence, parts
           ) VALUES ($1,$2,$3,$4,$5,'agent',$6,'assistant','streaming',$7,$8::jsonb)
           RETURNING ${messageColumns}`,
          [
            outputMessageId,
            locked.project_id,
            locked.work_item_id,
            locked.conversation_id,
            locked.initiated_by_user_id,
            locked.actor_id,
            sequence,
            JSON.stringify(textParts(text)),
          ],
        )
      ).rows[0];
      if (!output) throw new Error("assistant message insert returned no row");
      const row = (
        await tx.query<AttemptRow>(
          `UPDATE conversation_turn_attempts
              SET output_message_id=$2
            WHERE id=$1 AND status='streaming' AND output_message_id IS NULL
            RETURNING ${attemptColumns}`,
          [attemptId, outputMessageId],
        )
      ).rows[0];
      if (!row) throw new Error(`attempt "${attemptId}" cannot enter streaming`);
      return { attempt: attempt(row), output_message: message(output) };
    });
  }

  persistVisibleText(outputMessageId: string, text: string): Promise<void> {
    return this.transactions.transaction(async (tx) => {
      const row = (
        await tx.query<{ id: string }>(
          `UPDATE work_messages SET parts=$2::jsonb
            WHERE id=$1 AND role='assistant' AND visibility_status='streaming'
            RETURNING id`,
          [outputMessageId, JSON.stringify(textParts(text))],
        )
      ).rows[0];
      if (!row) throw new Error(`assistant message "${outputMessageId}" is no longer streaming`);
    });
  }

  succeed(
    attemptId: string,
    outputMessageId: string,
    text: string,
    providerRequestId: string,
    finishReason: string,
    usage: UsageEventT,
  ): Promise<V2ConversationTurnAttemptT> {
    return this.transactions.transaction(async (tx) => {
      await this.finalizeMessage(tx, outputMessageId, "complete", text);
      const row = (
        await tx.query<AttemptRow>(
          `UPDATE conversation_turn_attempts
              SET status='succeeded',
                  provider_request_id=coalesce(provider_request_id,$2),
                  provider_finish_reason=$3,
                  usage_status='exact',
                  input_tokens=$4, output_tokens=$5,
                  cache_read_tokens=$6, cache_write_tokens=$7,
                  cost_usd=$8, settled_at=now()
            WHERE id=$1 AND status='streaming'
            RETURNING ${attemptColumns}`,
          [
            attemptId,
            providerRequestId,
            finishReason,
            usage.input_tokens,
            usage.output_tokens,
            usage.cache_read_tokens ?? 0,
            usage.cache_write_tokens ?? 0,
            usage.actual_cost_usd ?? usage.estimated_cost_usd,
          ],
        )
      ).rows[0];
      if (!row) throw new Error(`attempt "${attemptId}" cannot succeed`);
      return attempt(row);
    });
  }

  cancel(
    attemptId: string,
    outputMessageId: string | null,
    text: string,
    usage: ConversationAttemptUsage,
  ): Promise<V2ConversationTurnAttemptT | null> {
    return this.transactions.transaction(async (tx) => {
      const locked = await this.lockAttempt(tx, attemptId);
      if (!locked || ["succeeded", "failed", "cancelled"].includes(locked.status)) return null;
      if (outputMessageId) {
        await this.finalizeMessage(tx, outputMessageId, "interrupted", text);
      }
      const row = await this.terminalAttempt(tx, locked, "cancelled", usage);
      return attempt(row);
    });
  }

  fail(
    attemptId: string,
    outputMessageId: string | null,
    text: string,
    failure: ConversationAttemptFailure,
  ): Promise<V2ConversationTurnAttemptT | null> {
    return this.transactions.transaction(async (tx) => {
      const locked = await this.lockAttempt(tx, attemptId);
      if (!locked || ["succeeded", "failed", "cancelled"].includes(locked.status)) return null;
      if (outputMessageId) {
        await this.finalizeMessage(tx, outputMessageId, "interrupted", text);
      }
      const usage = failure.usage;
      const row = (
        await tx.query<AttemptRow>(
          `UPDATE conversation_turn_attempts
              SET status='failed',
                  provider_finish_reason=$2,
                  usage_status=$3,
                  input_tokens=$4, output_tokens=$5,
                  cache_read_tokens=$6, cache_write_tokens=$7, cost_usd=$8,
                  failure_code=$9, failure_message_redacted=$10,
                  sanitized_failure=$11::jsonb, settled_at=now()
            WHERE id=$1 AND status IN ('pending','streaming')
            RETURNING ${attemptColumns}`,
          [
            attemptId,
            failure.finishReason ?? null,
            failure.usageStatus,
            usage?.input_tokens ?? null,
            usage?.output_tokens ?? null,
            usage ? (usage.cache_read_tokens ?? 0) : null,
            usage ? (usage.cache_write_tokens ?? 0) : null,
            usage ? (usage.actual_cost_usd ?? usage.estimated_cost_usd) : null,
            failure.code,
            failure.messageRedacted,
            failure.sanitized ? JSON.stringify(failure.sanitized) : null,
          ],
        )
      ).rows[0];
      if (!row) return null;
      return attempt(row);
    });
  }

  active(projectId: string, conversationId: string): Promise<V2ConversationTurnAttemptT | null> {
    return this.transactions.transaction(async (tx) => {
      const row = (
        await tx.query<AttemptRow>(
          `SELECT ${attemptColumns} FROM conversation_turn_attempts
            WHERE project_id=$1 AND conversation_id=$2
              AND status IN ('pending','streaming')
            ORDER BY created_at DESC LIMIT 1`,
          [projectId, conversationId],
        )
      ).rows[0];
      return row ? attempt(row) : null;
    });
  }

  latestForTrigger(
    projectId: string,
    workItemId: string,
    conversationId: string,
    triggeringMessageId: string,
  ): Promise<V2ConversationTurnAttemptT | null> {
    return this.transactions.transaction(async (tx) => {
      const row = (
        await tx.query<AttemptRow>(
          `SELECT ${attemptColumns} FROM conversation_turn_attempts
            WHERE project_id=$1 AND work_item_id=$2 AND conversation_id=$3
              AND triggering_message_id=$4
            ORDER BY attempt_number DESC LIMIT 1`,
          [projectId, workItemId, conversationId, triggeringMessageId],
        )
      ).rows[0];
      return row ? attempt(row) : null;
    });
  }

  latestUserMessageId(
    projectId: string,
    workItemId: string,
    conversationId: string,
  ): Promise<string | null> {
    return this.transactions.transaction(async (tx) => {
      const row = (
        await tx.query<{ id: string }>(
          `SELECT id FROM work_messages
            WHERE project_id=$1 AND work_item_id=$2 AND conversation_id=$3
              AND role='user'
            ORDER BY sequence DESC LIMIT 1`,
          [projectId, workItemId, conversationId],
        )
      ).rows[0];
      return row?.id ?? null;
    });
  }

  latestRetryableTrigger(
    projectId: string,
    workItemId: string,
    conversationId: string,
  ): Promise<string | null> {
    return this.latestRetryableAttempt(projectId, workItemId, conversationId).then(
      (retryable) => retryable?.triggering_message_id ?? null,
    );
  }

  latestRetryableAttempt(
    projectId: string,
    workItemId: string,
    conversationId: string,
  ): Promise<V2ConversationTurnAttemptT | null> {
    return this.transactions.transaction(async (tx) => {
      const row = (
        await tx.query<AttemptRow>(
          `WITH latest_user AS (
             SELECT id
               FROM work_messages
              WHERE project_id=$1 AND work_item_id=$2 AND conversation_id=$3
                AND role='user'
              ORDER BY sequence DESC
              LIMIT 1
           ),
           latest_attempt AS (
             SELECT attempt.*
               FROM conversation_turn_attempts attempt
               JOIN latest_user ON latest_user.id=attempt.triggering_message_id
              WHERE attempt.project_id=$1
                AND attempt.work_item_id=$2
                AND attempt.conversation_id=$3
              ORDER BY attempt.attempt_number DESC
              LIMIT 1
           )
           SELECT ${attemptColumns}
             FROM latest_attempt
            WHERE status IN ('failed','cancelled')`,
          [projectId, workItemId, conversationId],
        )
      ).rows[0];
      return row ? attempt(row) : null;
    });
  }

  reconcileOrphans(): Promise<number> {
    return this.transactions.transaction(async (tx) => {
      const messages = await tx.query<{ id: string; parts: unknown }>(
        `SELECT message.id, message.parts
           FROM work_messages message
           JOIN conversation_turn_attempts attempt
             ON attempt.output_message_id=message.id
          WHERE attempt.status IN ('pending','streaming')
            AND message.visibility_status='streaming'
          FOR UPDATE`,
      );
      for (const row of messages.rows) {
        const current = this.textFromParts(row.parts);
        await this.finalizeMessage(tx, row.id, "interrupted", current);
      }
      await tx.query(
        `WITH active_attempts AS (
           SELECT attempt.*
             FROM conversation_turn_attempts attempt
            WHERE attempt.status IN ('pending','streaming')
         ),
         starts AS (
           SELECT DISTINCT ON (event.request_id) event.*
             FROM ai_usage_events event
             JOIN active_attempts attempt ON attempt.usage_request_id=event.request_id
            WHERE event.event_type='request_started'
            ORDER BY event.request_id, event.sequence ASC
         ),
         next_sequences AS (
           SELECT event.request_id, max(event.sequence)+1 AS sequence,
                  max(event.occurred_at) AS last_occurred_at
             FROM ai_usage_events event
             JOIN active_attempts attempt ON attempt.usage_request_id=event.request_id
            GROUP BY event.request_id
         )
         INSERT INTO ai_usage_events (
           id, request_id, sequence, event_type, status, occurred_at,
           provider, model, provider_request_id, endpoint, request_type,
           retry_group_id, retry_attempt, initiated_by_user_id, project_id,
           phase_id, task_id, run_id, usage_source, confidence,
           pricing_profile_id, input_tokens, output_tokens, cache_read_tokens,
           cache_write_tokens, cost_usd, cost_classification, latency_ms,
           http_status, error_code, error_category, error_message_redacted,
           sanitized_error, adjusts_event_id
         )
         SELECT
           'ai_usage_event_recovery_' || attempt.id,
           attempt.usage_request_id,
           next_sequences.sequence,
           'request_failed',
           'failed',
           greatest(now(), next_sequences.last_occurred_at),
           starts.provider,
           starts.model,
           attempt.provider_request_id,
           starts.endpoint,
           starts.request_type,
           starts.retry_group_id,
           starts.retry_attempt,
           starts.initiated_by_user_id,
           starts.project_id,
           starts.phase_id,
           starts.task_id,
           starts.run_id,
           'unavailable',
           0,
           NULL,NULL,NULL,NULL,NULL,NULL,
           'unavailable',
           NULL,NULL,
           'cancelled',
           'conversation_recovery',
           'conversation turn was interrupted by server restart',
           '{"recovered":true}'::jsonb,
           NULL
         FROM active_attempts attempt
         JOIN starts ON starts.request_id=attempt.usage_request_id
         JOIN next_sequences ON next_sequences.request_id=attempt.usage_request_id
         WHERE NOT EXISTS (
           SELECT 1 FROM ai_usage_events terminal
            WHERE terminal.request_id=attempt.usage_request_id
              AND terminal.event_type IN ('request_completed','request_failed')
         )
         ON CONFLICT (id) DO NOTHING`,
      );
      const reconciled = await tx.query<{ id: string }>(
        `WITH latest_usage AS (
           SELECT DISTINCT ON (event.request_id)
                  event.request_id, event.input_tokens, event.output_tokens,
                  event.cache_read_tokens, event.cache_write_tokens, event.cost_usd
             FROM ai_usage_events event
            WHERE event.event_type='usage_observed'
            ORDER BY event.request_id, event.sequence DESC
         )
         UPDATE conversation_turn_attempts attempt
            SET status='cancelled',
                usage_status=CASE
                  WHEN EXISTS (
                    SELECT 1 FROM latest_usage
                     WHERE latest_usage.request_id=attempt.usage_request_id
                  ) THEN 'exact'
                  ELSE 'unavailable'
                END,
                input_tokens=(
                  SELECT input_tokens FROM latest_usage
                   WHERE latest_usage.request_id=attempt.usage_request_id
                ),
                output_tokens=(
                  SELECT output_tokens FROM latest_usage
                   WHERE latest_usage.request_id=attempt.usage_request_id
                ),
                cache_read_tokens=(
                  SELECT cache_read_tokens FROM latest_usage
                   WHERE latest_usage.request_id=attempt.usage_request_id
                ),
                cache_write_tokens=(
                  SELECT cache_write_tokens FROM latest_usage
                   WHERE latest_usage.request_id=attempt.usage_request_id
                ),
                cost_usd=(
                  SELECT cost_usd FROM latest_usage
                   WHERE latest_usage.request_id=attempt.usage_request_id
                ),
                settled_at=now()
          WHERE attempt.status IN ('pending','streaming')
          RETURNING attempt.id`,
      );
      return reconciled.rows.length;
    });
  }

  private async finalizeMessage(
    tx: V2SqlExecutor,
    outputMessageId: string,
    status: "complete" | "interrupted",
    text: string,
  ): Promise<void> {
    if (text.length === 0) {
      throw new Error(`assistant message "${outputMessageId}" has no visible text to finalize`);
    }
    const row = (
      await tx.query<{ id: string }>(
        `UPDATE work_messages
            SET visibility_status=$2, parts=$3::jsonb
          WHERE id=$1 AND role='assistant' AND visibility_status='streaming'
          RETURNING id`,
        [outputMessageId, status, JSON.stringify(textParts(text))],
      )
    ).rows[0];
    if (!row) throw new Error(`assistant message "${outputMessageId}" cannot be finalized`);
  }

  private lockAttempt(tx: V2SqlExecutor, attemptId: string): Promise<AttemptRow | null> {
    return tx
      .query<AttemptRow>(
        `SELECT ${attemptColumns} FROM conversation_turn_attempts WHERE id=$1 FOR UPDATE`,
        [attemptId],
      )
      .then((result) => result.rows[0] ?? null);
  }

  private async terminalAttempt(
    tx: V2SqlExecutor,
    locked: AttemptRow,
    status: "cancelled",
    usage: ConversationAttemptUsage,
  ): Promise<AttemptRow> {
    const observed = usage.usage;
    const row = (
      await tx.query<AttemptRow>(
        `UPDATE conversation_turn_attempts
            SET status=$2, usage_status=$3,
                input_tokens=$4, output_tokens=$5,
                cache_read_tokens=$6, cache_write_tokens=$7, cost_usd=$8,
                settled_at=now()
          WHERE id=$1 AND status=$9
          RETURNING ${attemptColumns}`,
        [
          locked.id,
          status,
          usage.usageStatus,
          observed?.input_tokens ?? null,
          observed?.output_tokens ?? null,
          observed ? (observed.cache_read_tokens ?? 0) : null,
          observed ? (observed.cache_write_tokens ?? 0) : null,
          observed ? (observed.actual_cost_usd ?? observed.estimated_cost_usd) : null,
          locked.status,
        ],
      )
    ).rows[0];
    if (!row) throw new Error(`attempt "${locked.id}" cannot be cancelled`);
    return row;
  }

  private textFromParts(value: unknown): string {
    const parsed = typeof value === "string" ? (JSON.parse(value) as V2WorkMessagePartT[]) : value;
    if (!Array.isArray(parsed)) return "";
    return parsed
      .filter(
        (part): part is Extract<V2WorkMessagePartT, { type: "text" }> =>
          typeof part === "object" && part !== null && part.type === "text",
      )
      .map((part) => part.text)
      .join("");
  }
}
