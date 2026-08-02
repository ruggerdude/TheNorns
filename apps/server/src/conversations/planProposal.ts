import {
  AdapterError,
  type ConversationMessage,
  type LlmAdapter,
  type MessageContent,
  type ProviderName,
} from "@norns/adapters";
import {
  V2ConversationAction,
  V2CreateConversationPlanProposalInput,
  type V2CreateConversationPlanProposalInputT,
  type V2CreateConversationPlanProposalResponseT,
  V2PlanningLiveProgress,
  type V2PlanningLiveProgressT,
  V2WorkMessage,
  type V2WorkMessageT,
  V2WorkPlanContract,
} from "@norns/contracts";
import { newId } from "../ids.js";
import { canonicalSha256 } from "../persistence/migration/canonicalJson.js";
import type { V2SqlExecutor, V2TransactionRunner } from "../persistence/v2/database.js";
import type { ConversationContextAssembler } from "./contextAssembler.js";
import {
  ConversationPlanWorkflowError,
  type ConversationPlanWorkflowService,
} from "./planWorkflow.js";
import type { ConversationService } from "./service.js";

export const PLAN_PROPOSAL_MAX_OUTPUT_TOKENS = 7_000;
export const PLAN_PROPOSAL_MAX_DISCUSSION_MESSAGES = 16;
export const PLAN_PROPOSAL_MAX_DISCUSSION_CHARACTERS = 16_000;
export const PLAN_PROPOSAL_MAX_MESSAGE_CHARACTERS = 4_000;

const MIN_TRUNCATED_MESSAGE_CHARACTERS = 256;

const PLAN_PROPOSAL_SYSTEM = [
  "You are the conversational PM proposing a structured Work Plan Contract from the visible project conversation and binding context.",
  "Return only the strict provider-neutral Work Plan Contract envelope requested by the schema.",
  "The proposal is inert: do not claim that it was saved, reviewed, approved, or started.",
  "Treat the conversation as source evidence, not as the plan itself. Extract the latest agreed direction and explicit human decisions; do not turn greetings, exploration, abandoned alternatives, repeated explanations, or the mechanics of creating the plan into plan modules.",
  "When later messages revise or reject earlier ideas, keep only the latest accepted direction. Put genuinely unresolved choices in open_decisions instead of silently treating them as commitments.",
  "Write a concise, executable contract. State the objective once; avoid repeating the same requirement across descriptions, deliverables, acceptance criteria, risks, and verification requirements. Each module must describe an independently implementable and verifiable area, not a conversation topic.",
  "Normally use 1-8 modules and the fewest modules that fully cover the accepted scope. Exceed eight only when the visible accepted scope genuinely requires more independently deliverable areas. Keep assumptions, risks, out-of-scope items, open decisions, deliverables, and acceptance criteria bounded to material items.",
  "Preserve established human decisions, surface unresolved decisions, pin one OpenAI or Anthropic staffing choice per module, and include concrete executable verification requirements and a realistic budget.",
].join("\n\n");

export interface PlanProposalDiscussionMessage {
  source_index: number;
  role: ConversationMessage["role"];
  content: string;
  source_content_sha256: string;
  original_characters: number;
  included_characters: number;
  truncated: boolean;
}

export interface PlanProposalDiscussionEnvelope {
  schema_version: 1;
  chronological_messages: PlanProposalDiscussionMessage[];
  bounds: {
    max_messages: number;
    max_included_characters: number;
    max_characters_per_message: number;
  };
  omission: {
    total_messages: number;
    included_messages: number;
    omitted_messages: number;
    truncated_messages: number;
    total_rendered_characters: number;
    included_characters: number;
    omitted_content_sha256: string | null;
  };
}

export interface ConversationPlanProposalRequestEnvelope {
  system: string;
  prompt: string;
  maxTokens: number;
  discussion: PlanProposalDiscussionEnvelope;
}

interface RenderedDiscussionMessage {
  source_index: number;
  role: ConversationMessage["role"];
  content: string;
  source_content_sha256: string;
}

function renderVisibleMessageContent(content: MessageContent): string {
  if (typeof content === "string") return content.trim();
  const rendered = content
    .map((part) =>
      part.type === "text"
        ? part.text
        : `[Visible ${part.mime} image omitted from the text-only plan digest.]`,
    )
    .join("\n")
    .trim();
  return rendered || "[Visible non-text message omitted from the text-only plan digest.]";
}

function boundedMessageExcerpt(
  message: RenderedDiscussionMessage,
  maxCharacters: number,
): { content: string; truncated: boolean; omittedSegmentSha256: string | null } {
  if (message.content.length <= maxCharacters) {
    return { content: message.content, truncated: false, omittedSegmentSha256: null };
  }

  const available = Math.max(MIN_TRUNCATED_MESSAGE_CHARACTERS, maxCharacters);
  const markerTemplate = "\n… [message middle omitted; sha256=HASH] …\n";
  const markerLength = markerTemplate.length - "HASH".length + 64;
  const retainedCharacters = available - markerLength;
  const headCharacters = Math.ceil(retainedCharacters / 2);
  const tailCharacters = Math.floor(retainedCharacters / 2);
  const omittedEnd = message.content.length - tailCharacters;
  const omitted = message.content.slice(headCharacters, omittedEnd);
  const omittedSegmentSha256 = canonicalSha256(omitted);
  const marker = `\n… [message middle omitted; sha256=${omittedSegmentSha256}] …\n`;
  return {
    content: message.content.slice(0, headCharacters) + marker + message.content.slice(omittedEnd),
    truncated: true,
    omittedSegmentSha256,
  };
}

/**
 * Builds the bounded, provider-neutral initial proposal request. The binding
 * system context remains byte-for-byte intact; only recent visible discussion
 * is excerpted. Selection walks newest-to-oldest, then restores chronology.
 */
export function buildConversationPlanProposalRequest(input: {
  assembledSystem: string;
  messages: readonly ConversationMessage[];
  handoff?: V2CreateConversationPlanProposalInputT["handoff"];
}): ConversationPlanProposalRequestEnvelope {
  const rendered: RenderedDiscussionMessage[] = input.messages.map((message, sourceIndex) => ({
    source_index: sourceIndex,
    role: message.role,
    content: renderVisibleMessageContent(message.content),
    source_content_sha256: canonicalSha256({ role: message.role, content: message.content }),
  }));
  const selected: PlanProposalDiscussionMessage[] = [];
  const omittedDescriptors: Array<Record<string, string | number>> = [];
  let remainingCharacters = PLAN_PROPOSAL_MAX_DISCUSSION_CHARACTERS;

  for (let index = rendered.length - 1; index >= 0; index -= 1) {
    const message = rendered[index];
    if (!message) continue;
    const hasMessageCapacity = selected.length < PLAN_PROPOSAL_MAX_DISCUSSION_MESSAGES;
    const canFitWholeMessage = message.content.length <= remainingCharacters;
    const canFitTruncatedMessage = remainingCharacters >= MIN_TRUNCATED_MESSAGE_CHARACTERS;
    if (!hasMessageCapacity || (!canFitWholeMessage && !canFitTruncatedMessage)) {
      omittedDescriptors.push({
        source_index: message.source_index,
        source_content_sha256: message.source_content_sha256,
        reason: hasMessageCapacity ? "character_limit" : "message_limit",
      });
      continue;
    }

    const excerpt = boundedMessageExcerpt(
      message,
      Math.min(PLAN_PROPOSAL_MAX_MESSAGE_CHARACTERS, remainingCharacters),
    );
    selected.push({
      source_index: message.source_index,
      role: message.role,
      content: excerpt.content,
      source_content_sha256: message.source_content_sha256,
      original_characters: message.content.length,
      included_characters: excerpt.content.length,
      truncated: excerpt.truncated,
    });
    remainingCharacters -= excerpt.content.length;
    if (excerpt.omittedSegmentSha256) {
      omittedDescriptors.push({
        source_index: message.source_index,
        omitted_segment_sha256: excerpt.omittedSegmentSha256,
        reason: "message_truncated",
      });
    }
  }

  selected.reverse();
  const includedSourceIndexes = new Set(selected.map((message) => message.source_index));
  const discussion: PlanProposalDiscussionEnvelope = {
    schema_version: 1,
    chronological_messages: selected,
    bounds: {
      max_messages: PLAN_PROPOSAL_MAX_DISCUSSION_MESSAGES,
      max_included_characters: PLAN_PROPOSAL_MAX_DISCUSSION_CHARACTERS,
      max_characters_per_message: PLAN_PROPOSAL_MAX_MESSAGE_CHARACTERS,
    },
    omission: {
      total_messages: rendered.length,
      included_messages: selected.length,
      omitted_messages: rendered.length - includedSourceIndexes.size,
      truncated_messages: selected.filter((message) => message.truncated).length,
      total_rendered_characters: rendered.reduce(
        (total, message) => total + message.content.length,
        0,
      ),
      included_characters: selected.reduce(
        (total, message) => total + message.included_characters,
        0,
      ),
      omitted_content_sha256:
        omittedDescriptors.length > 0 ? canonicalSha256(omittedDescriptors) : null,
    },
  };
  const prompt = [
    "Propose the complete Work Plan Contract envelope now.",
    "Use the binding context plus the bounded visible-discussion digest below to synthesize only the latest accepted plan. Omission hashes are provenance metadata, not plan requirements.",
    input.handoff
      ? `The human selected ${input.handoff.execution_agent.provider}:${input.handoff.execution_agent.model} as the execution agent. Use that exact provider and model for every module staffing choice.`
      : null,
    "BOUNDED_VISIBLE_DISCUSSION_JSON",
    JSON.stringify(discussion),
    "Return the strict structured result only.",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  return {
    system: `${PLAN_PROPOSAL_SYSTEM}\n\n${input.assembledSystem}`,
    prompt,
    maxTokens: PLAN_PROPOSAL_MAX_OUTPUT_TOKENS,
    discussion,
  };
}

interface ProposalAttemptRow {
  id: string;
  project_id: string;
  work_item_id: string;
  conversation_id: string;
  initiated_by_user_id: string;
  idempotency_key: string;
  request_fingerprint: string;
  source_message_id: string;
  provider: ProviderName;
  model: string;
  usage_request_id: string;
  status: "pending" | "succeeded" | "failed";
  output_message_id: string | null;
  action_id: string | null;
  failure_code: string | null;
  failure_message_redacted: string | null;
  live_progress: unknown | null;
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

export interface ConversationPlanProposalOptions {
  newId?: (prefix: string) => string;
  now?: () => Date;
  createAdapter(provider: ProviderName, model: string): LlmAdapter;
}

function provider(value: string): ProviderName {
  if (value === "anthropic" || value === "openai") return value;
  throw new ConversationPlanWorkflowError(
    "invalid_plan_state",
    `unsupported pinned conversation provider "${value}"`,
  );
}

function visibleMessage(row: MessageRow): V2WorkMessageT {
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
    parts: typeof row.parts === "string" ? JSON.parse(row.parts) : row.parts,
    client_message_id: row.client_message_id,
    request_fingerprint: row.request_fingerprint,
    created_at:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : new Date(row.created_at).toISOString(),
  });
}

function failure(error: unknown): {
  code: string;
  message: string;
  sanitized: Record<string, unknown>;
} {
  if (error instanceof AdapterError) {
    return {
      code: error.kind,
      message: `provider plan proposal failed (${error.kind})`,
      sanitized: {
        retryable: error.retryable,
        request_dispatched: error.metadata?.request_dispatched ?? null,
      },
    };
  }
  return {
    code: "plan_proposal_failed",
    message: "plan proposal generation failed",
    sanitized: {},
  };
}

export class ConversationPlanProposalService {
  private readonly makeId: (prefix: string) => string;
  private readonly now: () => Date;

  constructor(
    private readonly transactions: V2TransactionRunner,
    private readonly conversations: ConversationService,
    private readonly contexts: ConversationContextAssembler,
    private readonly workflow: ConversationPlanWorkflowService,
    private readonly options: ConversationPlanProposalOptions,
  ) {
    this.makeId = options.newId ?? newId;
    this.now = options.now ?? (() => new Date());
  }

  async reconcileOrphans(): Promise<number> {
    return this.transactions.transaction(async (tx) => {
      const result = await tx.query<{ id: string }>(
        `UPDATE conversation_plan_proposal_attempts
            SET status='failed', usage_status='unavailable',
                live_progress=NULL,
                failure_code='orphaned',
                failure_message_redacted='server restarted before the plan proposal settled',
                sanitized_failure='{"restart_reconciled":true}'::jsonb,
                settled_at=now(), updated_at=now()
          WHERE status='pending'
          RETURNING id`,
      );
      return result.rows.length;
    });
  }

  async propose(
    userId: string,
    projectId: string,
    workItemId: string,
    conversationId: string,
    candidate: V2CreateConversationPlanProposalInputT,
  ): Promise<V2CreateConversationPlanProposalResponseT> {
    const input = V2CreateConversationPlanProposalInput.parse(candidate);
    const scope = await this.conversations.getConversation(
      { id: userId },
      projectId,
      conversationId,
    );
    if (
      scope.work_item.id !== workItemId ||
      scope.work_item.status !== "planning" ||
      scope.conversation.kind !== "planning" ||
      scope.conversation.status !== "active"
    ) {
      throw new ConversationPlanWorkflowError(
        "invalid_plan_state",
        "plan proposals require an active planning conversation in planning state",
      );
    }
    const replay = await this.transactions.transaction(async (tx) => {
      await this.assertScope(tx, userId, projectId, workItemId, conversationId);
      return (
        (
          await tx.query<ProposalAttemptRow>(
            `SELECT * FROM conversation_plan_proposal_attempts
            WHERE conversation_id=$1 AND initiated_by_user_id=$2
              AND idempotency_key=$3`,
            [conversationId, userId, input.idempotency_key],
          )
        ).rows[0] ?? null
      );
    });
    if (replay?.status === "succeeded") {
      return this.loadResponse(userId, projectId, workItemId, conversationId, replay);
    }
    if (replay?.status === "failed") {
      throw new ConversationPlanWorkflowError(
        "proposal_failed",
        replay.failure_message_redacted ?? "this idempotent proposal attempt failed",
        502,
      );
    }
    if (replay) {
      throw new ConversationPlanWorkflowError(
        "proposal_in_progress",
        "this idempotent plan proposal is still generating",
      );
    }
    if (input.intent_message) {
      await this.conversations.submitUserMessage(
        { id: userId },
        {
          project_id: projectId,
          work_item_id: workItemId,
          conversation_id: conversationId,
          client_message_id: `plan-intent:${input.idempotency_key}`,
          parts: [{ type: "text", format: "plain", text: input.intent_message }],
        },
      );
    }
    const assembled = await this.contexts.assemblePlanProposal(
      projectId,
      workItemId,
      conversationId,
    );
    const detail = await this.workflow.detail(userId, projectId, workItemId, conversationId);
    const predecessor = detail.plan_versions.at(-1) ?? null;
    const requestFingerprint = canonicalSha256({
      project_id: projectId,
      work_item_id: workItemId,
      conversation_id: conversationId,
      source_message_id: assembled.source_message_id,
      context_hash: assembled.context_hash,
      provider: scope.conversation.provider,
      model: scope.conversation.model,
      predecessor_plan_version_id: predecessor?.id ?? null,
      predecessor_content_hash: predecessor?.content_hash ?? null,
      handoff: input.handoff ?? null,
    });
    const attemptId = this.makeId("plan_proposal");
    const usageRequestId = this.makeId("ai_request");
    const proposalStartedAt = this.now().toISOString();
    const initialProgress = this.proposalProgress(
      "generating",
      scope.conversation.provider,
      scope.conversation.model,
      proposalStartedAt,
    );
    const begun = await this.transactions.transaction(async (tx) => {
      await this.assertScope(tx, userId, projectId, workItemId, conversationId);
      const existing = (
        await tx.query<ProposalAttemptRow>(
          `SELECT * FROM conversation_plan_proposal_attempts
            WHERE conversation_id=$1 AND initiated_by_user_id=$2 AND idempotency_key=$3
            FOR UPDATE`,
          [conversationId, userId, input.idempotency_key],
        )
      ).rows[0];
      if (existing) {
        if (existing.request_fingerprint !== requestFingerprint) {
          throw new ConversationPlanWorkflowError(
            "idempotency_conflict",
            "plan proposal key was reused after its source context changed",
          );
        }
        return existing;
      }
      if (
        (
          await tx.query<{ id: string }>(
            `SELECT id FROM conversation_turn_attempts
              WHERE conversation_id=$1 AND status IN ('pending','streaming') LIMIT 1`,
            [conversationId],
          )
        ).rows[0]
      ) {
        throw new ConversationPlanWorkflowError(
          "proposal_in_progress",
          "wait for the active PM response before creating a plan proposal",
        );
      }
      try {
        const inserted = (
          await tx.query<ProposalAttemptRow>(
            `INSERT INTO conversation_plan_proposal_attempts (
               id, project_id, work_item_id, conversation_id, initiated_by_user_id,
               idempotency_key, request_fingerprint, source_message_id,
               provider, model, usage_request_id, context_manifest, context_hash,
               live_progress, started_at
             ) VALUES (
               $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14::jsonb,$15
             ) RETURNING *`,
            [
              attemptId,
              projectId,
              workItemId,
              conversationId,
              userId,
              input.idempotency_key,
              requestFingerprint,
              assembled.source_message_id,
              scope.conversation.provider,
              scope.conversation.model,
              usageRequestId,
              JSON.stringify(assembled.manifest),
              assembled.context_hash,
              JSON.stringify(initialProgress),
              proposalStartedAt,
            ],
          )
        ).rows[0];
        if (!inserted) throw new Error("plan proposal attempt insert returned no row");
        return inserted;
      } catch (error) {
        if (error instanceof Error && (error as Error & { code?: string }).code === "23505") {
          throw new ConversationPlanWorkflowError(
            "proposal_in_progress",
            "another plan proposal is already generating for this conversation",
          );
        }
        throw error;
      }
    });
    if (begun.status === "succeeded") {
      return this.loadResponse(userId, projectId, workItemId, conversationId, begun);
    }
    if (begun.status === "failed") {
      throw new ConversationPlanWorkflowError(
        "proposal_failed",
        begun.failure_message_redacted ?? "this idempotent proposal attempt failed",
        502,
      );
    }
    if (begun.id !== attemptId) {
      throw new ConversationPlanWorkflowError(
        "proposal_in_progress",
        "this idempotent plan proposal is still generating",
      );
    }

    let exactUsage:
      | {
          input_tokens: number;
          output_tokens: number;
          cache_read_tokens: number;
          cache_write_tokens: number;
          actual_cost_usd: number | null;
          estimated_cost_usd: number;
        }
      | undefined;
    let providerRequestId: string | null = null;
    try {
      const adapter = this.options.createAdapter(
        provider(scope.conversation.provider),
        scope.conversation.model,
      );
      const proposalRequest = buildConversationPlanProposalRequest({
        assembledSystem: assembled.system,
        messages: assembled.messages,
        ...(input.handoff ? { handoff: input.handoff } : {}),
      });
      const generated = await adapter.completeStructured(
        {
          system: proposalRequest.system,
          prompt: proposalRequest.prompt,
          maxTokens: proposalRequest.maxTokens,
          projectId,
          initiatedByUserId: userId,
          telemetryRequestId: usageRequestId,
          telemetryRetryGroupId: attemptId,
          telemetryRetryAttempt: 0,
        },
        V2WorkPlanContract,
        "conversation_work_plan_contract",
      );
      await this.recordProgress(
        attemptId,
        this.proposalProgress("validating", adapter.provider, adapter.model),
      );
      const plan = V2WorkPlanContract.parse(
        input.handoff
          ? {
              ...generated.value,
              staffing: generated.value.plan.modules.map((module) => ({
                module_id: module.id,
                agent_role:
                  generated.value.staffing.find((choice) => choice.module_id === module.id)
                    ?.agent_role ?? "implementation agent",
                provider: input.handoff?.execution_agent.provider,
                model: input.handoff?.execution_agent.model,
              })),
            }
          : generated.value,
      );
      exactUsage = {
        input_tokens: generated.usage.input_tokens,
        output_tokens: generated.usage.output_tokens,
        cache_read_tokens: generated.usage.cache_read_tokens ?? 0,
        cache_write_tokens: generated.usage.cache_write_tokens ?? 0,
        actual_cost_usd: generated.usage.actual_cost_usd,
        estimated_cost_usd: generated.usage.estimated_cost_usd,
      };
      providerRequestId = generated.provider_execution_id ?? null;
      await this.recordProgress(
        attemptId,
        this.proposalProgress("saving", adapter.provider, adapter.model),
      );
      await this.settleSuccess({
        attemptId,
        userId,
        projectId,
        workItemId,
        conversationId,
        sourceMessageId: assembled.source_message_id,
        predecessor,
        plan,
        handoff: input.handoff,
        usage: exactUsage,
        providerRequestId,
      });
    } catch (error) {
      await this.settleFailure(attemptId, error, exactUsage, providerRequestId);
      const visible = failure(error);
      throw new ConversationPlanWorkflowError("proposal_failed", visible.message, 502);
    }
    const settled = await this.loadAttempt(attemptId);
    return this.loadResponse(userId, projectId, workItemId, conversationId, settled);
  }

  private async settleSuccess(input: {
    attemptId: string;
    userId: string;
    projectId: string;
    workItemId: string;
    conversationId: string;
    sourceMessageId: string;
    predecessor: { id: string; content_hash: string } | null;
    plan: ReturnType<typeof V2WorkPlanContract.parse>;
    handoff: V2CreateConversationPlanProposalInputT["handoff"];
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens?: number;
      cache_write_tokens?: number;
      actual_cost_usd: number | null;
      estimated_cost_usd: number;
    };
    providerRequestId: string | null;
  }): Promise<void> {
    await this.transactions.transaction(async (tx) => {
      const attempt = (
        await tx.query<ProposalAttemptRow>(
          "SELECT * FROM conversation_plan_proposal_attempts WHERE id=$1 FOR UPDATE",
          [input.attemptId],
        )
      ).rows[0];
      if (!attempt || attempt.status !== "pending") return;
      const scope = await this.assertScope(
        tx,
        input.userId,
        input.projectId,
        input.workItemId,
        input.conversationId,
      );
      if (scope.status !== "planning") {
        throw new ConversationPlanWorkflowError(
          "invalid_plan_state",
          "work state changed while the proposal was generating",
        );
      }
      const source = (
        await tx.query<{ id: string }>(
          `SELECT id FROM work_messages
            WHERE conversation_id=$1 AND visibility_status='complete'
            ORDER BY sequence DESC LIMIT 1`,
          [input.conversationId],
        )
      ).rows[0];
      const latestPlan =
        (
          await tx.query<{ id: string; content_hash: string }>(
            `SELECT id, content_hash FROM work_plan_versions
            WHERE project_id=$1 AND work_item_id=$2
            ORDER BY version DESC LIMIT 1`,
            [input.projectId, input.workItemId],
          )
        ).rows[0] ?? null;
      if (
        source?.id !== input.sourceMessageId ||
        (latestPlan?.id ?? null) !== (input.predecessor?.id ?? null) ||
        (latestPlan?.content_hash ?? null) !== (input.predecessor?.content_hash ?? null)
      ) {
        throw new ConversationPlanWorkflowError(
          "idempotency_conflict",
          "conversation context or plan lineage changed while the proposal was generating",
        );
      }
      const messageId = this.makeId("message");
      const actionId = this.makeId("conversation_action");
      const payload = {
        parameters: {
          plan: input.plan,
          ...(input.handoff ? { handoff: input.handoff } : {}),
          predecessor_plan_version_id: input.predecessor?.id ?? null,
          predecessor_content_hash: input.predecessor?.content_hash ?? null,
          referenced_artifacts: this.proposalArtifactReferences(attempt),
        },
      };
      const sequence = (
        await tx.query<{ sequence: number | string }>(
          `UPDATE work_conversations
              SET next_message_sequence=next_message_sequence+1, updated_at=now()
            WHERE id=$1 RETURNING next_message_sequence-1 AS sequence`,
          [input.conversationId],
        )
      ).rows[0]?.sequence;
      if (sequence === undefined) throw new Error("could not allocate proposal message");
      const message = [
        {
          type: "text",
          format: "markdown",
          text: "I’ve prepared a structured Plan Contract proposal. Review it, discuss any changes, or explicitly save this candidate.",
        },
        { type: "action", action_id: actionId },
      ];
      await tx.query(
        `INSERT INTO work_messages (
           id, project_id, work_item_id, conversation_id, initiated_by_user_id,
           actor_type, actor_id, role, visibility_status, sequence, parts
         ) VALUES (
           $1,$2,$3,$4,$5,'agent',$6,'assistant','complete',$7,$8::jsonb
         )`,
        [
          messageId,
          input.projectId,
          input.workItemId,
          input.conversationId,
          input.userId,
          `pm:${input.conversationId}`,
          sequence,
          JSON.stringify(message),
        ],
      );
      await tx.query(
        `INSERT INTO conversation_actions (
           id, project_id, work_item_id, conversation_id, initiated_by_user_id,
           actor_type, actor_id, source_message_id, action_type, payload, payload_hash
         ) VALUES (
           $1,$2,$3,$4,$5,'agent',$6,$7,'save_plan_candidate',$8::jsonb,$9
         )`,
        [
          actionId,
          input.projectId,
          input.workItemId,
          input.conversationId,
          input.userId,
          `pm:${input.conversationId}`,
          messageId,
          JSON.stringify(payload),
          canonicalSha256(payload),
        ],
      );
      await tx.query(
        `UPDATE conversation_plan_proposal_attempts
            SET status='succeeded', provider_request_id=$2, usage_status='exact',
                live_progress=NULL,
                input_tokens=$3, output_tokens=$4, cache_read_tokens=$5,
                cache_write_tokens=$6, cost_usd=$7,
                output_message_id=$8, action_id=$9, plan_content_hash=$10,
                settled_at=$11, updated_at=$11
          WHERE id=$1 AND status='pending'`,
        [
          input.attemptId,
          input.providerRequestId,
          input.usage.input_tokens,
          input.usage.output_tokens,
          input.usage.cache_read_tokens ?? 0,
          input.usage.cache_write_tokens ?? 0,
          input.usage.actual_cost_usd ?? input.usage.estimated_cost_usd,
          messageId,
          actionId,
          canonicalSha256(input.plan),
          this.now().toISOString(),
        ],
      );
    });
  }

  private async settleFailure(
    attemptId: string,
    error: unknown,
    completedUsage?: {
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_write_tokens: number;
      actual_cost_usd: number | null;
      estimated_cost_usd: number;
    },
    completedProviderRequestId: string | null = null,
  ): Promise<void> {
    const visible = failure(error);
    const usage =
      completedUsage ?? (error instanceof AdapterError ? error.metadata?.usage : undefined);
    await this.transactions.transaction(async (tx) => {
      await tx.query(
        `UPDATE conversation_plan_proposal_attempts
            SET status='failed', provider_request_id=$2,
                live_progress=NULL,
                usage_status=$3, input_tokens=$4, output_tokens=$5,
                cache_read_tokens=$6, cache_write_tokens=$7, cost_usd=$8,
                failure_code=$9, failure_message_redacted=$10,
                sanitized_failure=$11::jsonb, settled_at=$12, updated_at=$12
          WHERE id=$1 AND status='pending'`,
        [
          attemptId,
          completedProviderRequestId ??
            (error instanceof AdapterError
              ? (error.metadata?.provider_execution_id ?? null)
              : null),
          usage ? "exact" : "unavailable",
          usage?.input_tokens ?? null,
          usage?.output_tokens ?? null,
          usage ? (usage.cache_read_tokens ?? 0) : null,
          usage ? (usage.cache_write_tokens ?? 0) : null,
          usage ? (usage.actual_cost_usd ?? usage.estimated_cost_usd) : null,
          visible.code,
          visible.message,
          JSON.stringify(visible.sanitized),
          this.now().toISOString(),
        ],
      );
    });
  }

  private async loadAttempt(attemptId: string): Promise<ProposalAttemptRow> {
    return this.transactions.transaction(async (tx) => {
      const row = (
        await tx.query<ProposalAttemptRow>(
          "SELECT * FROM conversation_plan_proposal_attempts WHERE id=$1",
          [attemptId],
        )
      ).rows[0];
      if (!row) throw new Error(`unknown plan proposal attempt "${attemptId}"`);
      return row;
    });
  }

  private proposalProgress(
    stage: "generating" | "validating" | "saving",
    providerName: string,
    model: string,
    startedAt = this.now().toISOString(),
  ): V2PlanningLiveProgressT {
    const checkpointAt = this.now().toISOString();
    return V2PlanningLiveProgress.parse({
      stage,
      round: null,
      attempt: 1,
      provider: provider(providerName),
      model,
      started_at: startedAt,
      checkpoint_at: checkpointAt,
    });
  }

  private async recordProgress(
    attemptId: string,
    progress: V2PlanningLiveProgressT,
  ): Promise<void> {
    await this.transactions.transaction(async (tx) => {
      await tx.query(
        `UPDATE conversation_plan_proposal_attempts
            SET live_progress=$2::jsonb, updated_at=$3
          WHERE id=$1 AND status='pending'`,
        [attemptId, JSON.stringify(progress), progress.checkpoint_at],
      );
    });
  }

  private async loadResponse(
    userId: string,
    projectId: string,
    workItemId: string,
    conversationId: string,
    attempt: ProposalAttemptRow,
  ): Promise<V2CreateConversationPlanProposalResponseT> {
    if (!attempt.output_message_id || !attempt.action_id) {
      throw new Error("successful plan proposal is missing its visible output");
    }
    const [message, detail] = await Promise.all([
      this.transactions.transaction(async (tx) => {
        const row = (
          await tx.query<MessageRow>(
            `SELECT schema_version, id, project_id, work_item_id, conversation_id,
                    initiated_by_user_id, actor_type, actor_id, role,
                    visibility_status, sequence, parts, client_message_id,
                    request_fingerprint, created_at
               FROM work_messages
              WHERE project_id=$1 AND work_item_id=$2 AND conversation_id=$3 AND id=$4`,
            [projectId, workItemId, conversationId, attempt.output_message_id],
          )
        ).rows[0];
        if (!row) throw new Error("proposal output message is unavailable");
        return visibleMessage(row);
      }),
      this.workflow.detail(userId, projectId, workItemId, conversationId),
    ]);
    const action = detail.actions.find((candidate) => candidate.id === attempt.action_id);
    if (!action) throw new Error("proposal action is unavailable");
    return { message, action: V2ConversationAction.parse(action) };
  }

  private async assertScope(
    tx: V2SqlExecutor,
    userId: string,
    projectId: string,
    workItemId: string,
    conversationId: string,
  ): Promise<{ status: string }> {
    const row = (
      await tx.query<{
        user_status: string;
        role: string;
        owner_user_id: string;
        member: boolean;
        status: string;
        conversation_status: string;
        kind: string;
      }>(
        `SELECT identity.status AS user_status, identity.role,
                project.owner_user_id,
                EXISTS (
                  SELECT 1 FROM project_members membership
                   WHERE membership.project_id=project.id
                     AND membership.user_id=identity.id
                     AND membership.status='active'
                ) AS member,
                item.status, conversation.status AS conversation_status,
                conversation.kind
           FROM users identity
           JOIN projects project ON project.id=$2
           JOIN work_items item ON item.project_id=project.id AND item.id=$3
           JOIN work_conversations conversation
             ON conversation.project_id=project.id
            AND conversation.work_item_id=item.id
            AND conversation.id=$4
          WHERE identity.id=$1
          FOR UPDATE OF item, conversation`,
        [userId, projectId, workItemId, conversationId],
      )
    ).rows[0];
    if (!row) {
      throw new ConversationPlanWorkflowError(
        "conversation_not_found",
        "plan proposal scope was not found",
      );
    }
    if (
      row.user_status !== "active" ||
      (row.role !== "admin" && row.owner_user_id !== userId && !row.member)
    ) {
      throw new ConversationPlanWorkflowError("forbidden", "plan proposal access is forbidden");
    }
    if (row.conversation_status !== "active" || row.kind !== "planning") {
      throw new ConversationPlanWorkflowError(
        "conversation_inactive",
        "plan proposal requires an active planning conversation",
      );
    }
    return { status: row.status };
  }

  private proposalArtifactReferences(
    attempt: ProposalAttemptRow & { context_manifest?: unknown },
  ): Array<{ id: string; content_hash: string }> {
    const manifest =
      typeof attempt.context_manifest === "string"
        ? JSON.parse(attempt.context_manifest)
        : attempt.context_manifest;
    if (!manifest || typeof manifest !== "object") return [];
    const entries = (manifest as { entries?: unknown }).entries;
    if (!Array.isArray(entries)) return [];
    const references = new Map<string, string>();
    for (const entry of entries) {
      if (
        entry &&
        typeof entry === "object" &&
        (entry as { kind?: unknown }).kind === "artifact" &&
        typeof (entry as { ref?: unknown }).ref === "string" &&
        typeof (entry as { content_hash?: unknown }).content_hash === "string"
      ) {
        references.set(
          (entry as { ref: string }).ref,
          (entry as { content_hash: string }).content_hash,
        );
      }
    }
    return [...references]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, content_hash]) => ({ id, content_hash }));
  }
}
