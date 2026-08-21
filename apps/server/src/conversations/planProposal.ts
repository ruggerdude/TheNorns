import {
  AdapterError,
  type CompletionRequest,
  type ConversationMessage,
  type ImagePart,
  type LlmAdapter,
  type ProviderName,
  type SelectableModelCatalogEntry,
} from "@norns/adapters";
import {
  V2ConversationAction,
  V2CreateConversationPlanProposalInput,
  type V2CreateConversationPlanProposalInputT,
  type V2CreateConversationPlanProposalResponseT,
  type V2PlanExecutionAgentT,
  V2PlanningLiveProgress,
  type V2PlanningLiveProgressT,
  V2WorkMessage,
  type V2WorkMessageT,
  V2WorkPlanContract,
  type V2WorkPlanContractT,
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

const PLAN_PROPOSAL_SYSTEM = [
  "You are the conversational PM proposing a structured Work Plan Contract from the visible project conversation and binding context.",
  "Return only the strict provider-neutral Work Plan Contract envelope requested by the schema.",
  "The proposal is inert: do not claim that it was saved, reviewed, approved, or started.",
  "Treat the conversation as source evidence, not as the plan itself. Extract the latest agreed direction and explicit human decisions; do not turn greetings, exploration, abandoned alternatives, repeated explanations, or the mechanics of creating the plan into plan modules.",
  "When later messages revise or reject earlier ideas, keep only the latest accepted direction. Put genuinely unresolved choices in open_decisions instead of silently treating them as commitments.",
  "Preserve established human decisions, surface unresolved decisions, choose the best available execution agent independently for each module, and include concrete verification requirements and budget.",
  "Keep the plan compact. Use the fewest independently executable modules that cover the agreed work (normally 2–5). Do not split one coherent workstream into multiple modules for thoroughness.",
  "Dependencies are data/build-order constraints, never a way to serialize work for convenience. If two modules are marked parallelization.safe, have disjoint file/component scopes, and neither consumes the other's outputs, leave them independent so they can run concurrently.",
  "For each module, use a one-sentence description, at most 3 non-overlapping deliverables, and at most 3 objectively checkable acceptance criteria. Keep inputs, outputs, open decisions, likely paths, owned components, test commands, environment requirements, candidate work units, and shared files to at most 3 items each unless the conversation explicitly requires more.",
  "Do not repeat the same requirement across descriptions, deliverables, acceptance criteria, inputs, outputs, or verification requirements. Concision must not remove concrete repository paths, commands, dependencies, risk, staffing, verification, open decisions, or budget that are material to execution.",
].join("\n\n");

/**
 * Server-side progress for a generating plan proposal. Emitted while the model
 * streams; see the `plan-proposals/stream` route for the client-facing wire
 * contract.
 */
export interface PlanProposalProgress {
  stage: "generating" | "validating" | "saving";
  /** Module titles observed so far, in the order the model produced them. */
  modules: string[];
  /** Rough output-token count so far (characters / 4). */
  output_tokens_estimate: number;
}

export type PlanProposalProgressListener = (progress: PlanProposalProgress) => void;

/** Emit at most one progress event per this many newly estimated tokens. */
const PROGRESS_TOKEN_STEP = 200;

/**
 * Tolerant scan of a partially streamed Work Plan Contract for completed
 * module titles. `title` appears only in `plan.modules[]` across the whole
 * envelope (packages/contracts/src/plan.ts), so a flat scan is exact for this
 * schema; a title is reported only once its closing quote has arrived.
 * ponytail: flat regex, re-scanned per delta (O(n^2) over a ~17KB body, single
 * digit ms total). Switch to an incremental cursor if the envelope grows or a
 * second `title` field is ever added.
 */
export function planModuleTitles(text: string): string[] {
  const titles: string[] = [];
  for (const match of text.matchAll(/"title"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
    try {
      titles.push(JSON.parse(`"${match[1]}"`) as string);
    } catch {
      // A half-written escape sequence: skip it until more text arrives.
    }
  }
  return titles;
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
  executionModels?: () => readonly SelectableModelCatalogEntry[];
  resolveImages?: (projectId: string, attachmentIds: readonly string[]) => Promise<ImagePart[]>;
}

function executionStaffingPrompt(
  preferred: V2PlanExecutionAgentT | undefined,
  catalog: readonly SelectableModelCatalogEntry[],
): string | null {
  const available = catalog.filter((entry) => entry.available);
  if (!preferred && available.length === 0) return null;
  const lines = [
    preferred
      ? `The human selected ${preferred.provider}:${preferred.model} as the preferred development agent. Use it as the default when candidates are equally suitable, not as a forced choice for every module.`
      : null,
    available.length > 0
      ? `The exact execution agents available for staffing are:\n${available
          .map((entry) => `- ${entry.provider}:${entry.model} — ${entry.label}`)
          .join("\n")}`
      : null,
    available.length > 1
      ? "Choose the best-fit available agent separately for each module based on its responsibilities, risk, and verification work. Different modules may use different agents."
      : null,
  ];
  return lines.filter((line): line is string => line !== null).join("\n");
}

/**
 * Keep the PM's per-module choices when they are runnable, while replacing a
 * stale or invented selection with the human's preferred agent (or the first
 * currently available fallback). This deliberately does not homogenize valid
 * choices: distinct phase assignments must survive plan generation.
 */
export function reconcilePlanStaffing(
  plan: V2WorkPlanContractT,
  preferred: V2PlanExecutionAgentT | undefined,
  catalog: readonly SelectableModelCatalogEntry[],
): V2WorkPlanContractT {
  const available = catalog.filter((entry) => entry.available);
  const allowed = available.length > 0 ? available : preferred ? [{ ...preferred }] : [];
  const fallback =
    allowed.find(
      (entry) => entry.provider === preferred?.provider && entry.model === preferred?.model,
    ) ?? allowed[0];

  return V2WorkPlanContract.parse({
    ...plan,
    staffing: plan.plan.modules.map((module) => {
      const proposed = plan.staffing.find((choice) => choice.module_id === module.id);
      const proposedIsRunnable =
        proposed !== undefined &&
        (allowed.length === 0 ||
          allowed.some(
            (entry) => entry.provider === proposed.provider && entry.model === proposed.model,
          ));
      const selected = proposedIsRunnable ? proposed : fallback;
      return {
        module_id: module.id,
        agent_role: proposed?.agent_role ?? "implementation agent",
        provider: selected?.provider ?? proposed?.provider,
        model: selected?.model ?? proposed?.model,
      };
    }),
  });
}

function normalizedSet(values: readonly string[]): Set<string> {
  return new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean));
}

function intersects(left: Set<string>, right: Set<string>): boolean {
  for (const value of left) if (right.has(value)) return true;
  return false;
}

/** Remove only edges contradicted by the plan's own explicit safety facts. */
export function removeFalsePlanDependencies(plan: V2WorkPlanContractT): V2WorkPlanContractT {
  const byId = new Map(plan.plan.modules.map((module) => [module.id, module] as const));
  return V2WorkPlanContract.parse({
    ...plan,
    plan: {
      ...plan.plan,
      modules: plan.plan.modules.map((module) => ({
        ...module,
        dependencies: module.dependencies.filter((dependencyId) => {
          const predecessor = byId.get(dependencyId);
          if (!predecessor) return true;
          if (!module.parallelization.safe || !predecessor.parallelization.safe) return true;
          const predecessorScope = normalizedSet([
            ...predecessor.execution.likely_paths,
            ...predecessor.execution.owned_components,
            ...predecessor.parallelization.shared_files,
          ]);
          const successorScope = normalizedSet([
            ...module.execution.likely_paths,
            ...module.execution.owned_components,
            ...module.parallelization.shared_files,
          ]);
          if (intersects(predecessorScope, successorScope)) return true;
          const predecessorOutputs = normalizedSet([
            ...predecessor.outputs,
            ...predecessor.deliverables,
          ]);
          const successorInputs = normalizedSet(module.inputs);
          return intersects(predecessorOutputs, successorInputs);
        }),
      })),
    },
  });
}

function provider(value: string): ProviderName {
  if (value === "anthropic" || value === "openai" || value === "deepseek") return value;
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

function visibleConversationContent(content: ConversationMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((part) =>
      part.type === "text" ? part.text : `[Image included with the planning context: ${part.mime}]`,
    )
    .join("\n");
}

/**
 * Structured completions accept one provider-neutral prompt rather than a
 * conversation history. Preserve the assembled user/PM turns explicitly so
 * the proposal sees the brief, clarifications, and extracted file contents.
 */
export function renderPlanProposalConversation(messages: readonly ConversationMessage[]): string {
  return messages
    .map((message, index) => {
      const label = message.role === "user" ? "Human" : "PM";
      return `### ${label} message ${index + 1}\n${visibleConversationContent(message.content)}`;
    })
    .join("\n\n");
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
    onProgress?: PlanProposalProgressListener,
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
      const executionModels = this.options.executionModels?.() ?? [];
      const images =
        adapter.provider !== "deepseek" && this.options.resolveImages
          ? await this.options.resolveImages(projectId, assembled.referenced_attachment_ids)
          : [];
      // Streaming changes nothing about the request, the result, or any of the
      // durability below: it only feeds the caller partial text while the same
      // structured call is in flight.
      let streamed = "";
      let announcedModules = 0;
      let announcedTokens = 0;
      const observe = (delta: string): void => {
        streamed += delta;
        const modules = planModuleTitles(streamed);
        const tokens = Math.round(streamed.length / 4);
        if (modules.length === announcedModules && tokens - announcedTokens < PROGRESS_TOKEN_STEP) {
          return;
        }
        announcedModules = modules.length;
        announcedTokens = tokens;
        onProgress?.({ stage: "generating", modules, output_tokens_estimate: tokens });
      };
      const structuredRequest: CompletionRequest = {
        system: `${PLAN_PROPOSAL_SYSTEM}\n\n${assembled.system}`,
        prompt: [
          "Propose the complete Work Plan Contract envelope now.",
          "Use the current objective, visible discussion, decisions, risks, and referenced artifacts to synthesize only the current agreed plan.",
          executionStaffingPrompt(input.handoff?.execution_agent, executionModels),
          "<visible_project_conversation>",
          renderPlanProposalConversation(assembled.messages),
          "</visible_project_conversation>",
          "Return the strict structured result only.",
        ]
          .filter((line): line is string => line !== null)
          .join("\n"),
        projectId,
        initiatedByUserId: userId,
        telemetryRequestId: usageRequestId,
        telemetryRetryGroupId: attemptId,
        telemetryRetryAttempt: 0,
        ...(images.length > 0 ? { images } : {}),
      };
      const generated =
        onProgress && adapter.streamStructured
          ? await adapter.streamStructured(
              structuredRequest,
              V2WorkPlanContract,
              "conversation_work_plan_contract",
              observe,
            )
          : await adapter.completeStructured(
              structuredRequest,
              V2WorkPlanContract,
              "conversation_work_plan_contract",
            );
      const streamedModules = planModuleTitles(streamed);
      const streamedTokens = Math.round(streamed.length / 4);
      onProgress?.({
        stage: "validating",
        modules: streamedModules,
        output_tokens_estimate: streamedTokens,
      });
      await this.recordProgress(
        attemptId,
        this.proposalProgress("validating", adapter.provider, adapter.model),
      );
      const plan = reconcilePlanStaffing(
        removeFalsePlanDependencies(V2WorkPlanContract.parse(generated.value)),
        input.handoff?.execution_agent,
        executionModels,
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
      onProgress?.({
        stage: "saving",
        modules: streamedModules,
        output_tokens_estimate: streamedTokens,
      });
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
