import {
  AdapterError,
  type ConversationLlmAdapter,
  type ConversationMessage,
  type ConversationStreamEvent,
  type ImagePart,
  type ProviderName,
} from "@norns/adapters";
import type { UsageEventT, V2ConversationTurnAttemptT } from "@norns/contracts";
import type { AttachmentService } from "../attachments/service.js";
import type { ConversationGatewayLease, ProviderGateway } from "../gateway/providerGateway.js";
import { estimateGatewayInputTokens } from "../gateway/request.js";
import { newId } from "../ids.js";
import type {
  AiInvocationTelemetry,
  AiInvocationTrace,
  AiUsageObservation,
} from "../usage-intelligence/telemetry.js";
import type { ConversationContextAssembler } from "./contextAssembler.js";
import type { ConversationActor, ConversationService } from "./service.js";
import type { ConversationAttemptUsage, ConversationTurnRepository } from "./turnRepository.js";

export type ConversationAdapterFactory = (
  provider: ProviderName,
  model: string,
) => ConversationLlmAdapter;
export type ConversationProviderGateway = Pick<ProviderGateway, "reserveConversation">;

const CONVERSATION_MAX_OUTPUT_TOKENS = 16_000;

export interface PrepareConversationTurn {
  actor: ConversationActor;
  projectId: string;
  workItemId: string;
  conversationId: string;
  triggeringMessageId: string;
  allowRetry?: boolean;
}

export interface ConversationTurnCallbacks {
  started(attempt: V2ConversationTurnAttemptT): void;
  text(delta: string): void;
  finished(attempt: V2ConversationTurnAttemptT): void;
}

export interface PreparedConversationTurn {
  readonly attempt: V2ConversationTurnAttemptT;
  readonly outputMessageId: string;
  run(callbacks: ConversationTurnCallbacks): Promise<void>;
  cancel(): void;
}

export class ConversationTurnError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus = 409,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ConversationTurnError";
  }
}

function providerName(value: string): ProviderName {
  if (value === "anthropic" || value === "openai" || value === "deepseek") return value;
  throw new ConversationTurnError(
    "provider_not_supported",
    `conversation provider "${value}" is not supported`,
  );
}

function endpointFor(provider: ProviderName): string {
  if (provider === "anthropic") return "/v1/messages";
  return provider === "openai" ? "/v1/responses" : "/v1/chat/completions";
}

function observation(usage: UsageEventT, providerRequestId: string): AiUsageObservation {
  const cacheCategoriesObserved =
    usage.cache_read_tokens !== undefined && usage.cache_write_tokens !== undefined;
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_tokens ?? 0,
    cacheWriteTokens: usage.cache_write_tokens ?? 0,
    costUsd: usage.actual_cost_usd ?? usage.estimated_cost_usd,
    costClassification: usage.actual_cost_usd === null ? "estimated" : "actual",
    usageSource: usage.usage_source,
    confidence: usage.usage_source === "provider_api" ? (cacheCategoriesObserved ? 1 : 0.8) : 0.5,
    pricingVersion: usage.pricing_version,
    providerRequestId,
  };
}

function exactUsage(error: AdapterError | null): ConversationAttemptUsage {
  return error?.metadata?.usage
    ? { usageStatus: "exact", usage: error.metadata.usage }
    : { usageStatus: "unavailable" };
}

function hasVisibleContent(text: string): boolean {
  return /\S/u.test(text.replace(/(?:\u200B|\u200C|\u200D|\u2060|\uFEFF)/gu, ""));
}

function publicFailure(error: unknown): {
  code: string;
  category: string;
  messageRedacted: string;
  sanitized: Record<string, unknown> | null;
} {
  if (error instanceof AdapterError) {
    return {
      code: error.kind,
      category: "adapter_error",
      messageRedacted: `provider stream failed (${error.kind})`,
      sanitized: {
        retryable: error.retryable,
        request_dispatched: error.metadata?.request_dispatched ?? null,
      },
    };
  }
  if (error instanceof ConversationTurnError) {
    return {
      code: error.code,
      category: "conversation_error",
      messageRedacted: error.message,
      sanitized: null,
    };
  }
  return {
    code: "unexpected",
    category: "unexpected_error",
    messageRedacted: "conversation turn failed unexpectedly",
    sanitized: null,
  };
}

function withCurrentImages(
  messages: readonly ConversationMessage[],
  index: number,
  images: readonly ImagePart[],
): ConversationMessage[] {
  if (index < 0 || index >= messages.length) {
    throw new ConversationTurnError(
      "trigger_not_in_context",
      "the triggering message is outside the current bounded conversation context",
    );
  }
  if (images.length === 0) return [...messages];
  return messages.map((message, messageIndex) => {
    if (messageIndex !== index) return message;
    const content =
      typeof message.content === "string"
        ? [{ type: "text" as const, text: message.content }, ...images]
        : [...message.content, ...images];
    return { ...message, content };
  });
}

export class ConversationTurnService {
  private readonly controllers = new Map<
    string,
    { projectId: string; conversationId: string; controller: AbortController }
  >();
  private readonly makeId: (prefix: string) => string;
  private readonly now: () => Date;

  constructor(
    private readonly conversations: ConversationService,
    private readonly contexts: ConversationContextAssembler,
    private readonly attempts: ConversationTurnRepository,
    private readonly attachments: AttachmentService,
    private readonly telemetry: AiInvocationTelemetry,
    private readonly createAdapter: ConversationAdapterFactory,
    private readonly gateway: ConversationProviderGateway,
    options: { newId?: (prefix: string) => string; now?: () => Date } = {},
  ) {
    this.makeId = options.newId ?? newId;
    this.now = options.now ?? (() => new Date());
  }

  async prepare(input: PrepareConversationTurn): Promise<PreparedConversationTurn> {
    const scope = await this.conversations.getConversation(
      input.actor,
      input.projectId,
      input.conversationId,
    );
    if (scope.work_item.id !== input.workItemId) {
      throw new ConversationTurnError("conversation_scope_mismatch", "conversation scope mismatch");
    }
    if (!["planning", "execution_pm"].includes(scope.conversation.kind)) {
      throw new ConversationTurnError(
        "conversation_kind_forbidden",
        "streaming is limited to planning and execution PM conversations",
      );
    }
    if (scope.conversation.status !== "active") {
      throw new ConversationTurnError(
        "conversation_inactive",
        `conversation is ${scope.conversation.status}`,
      );
    }
    const [prior, latestUserMessageId] = await Promise.all([
      this.attempts.latestForTrigger(
        input.projectId,
        input.workItemId,
        input.conversationId,
        input.triggeringMessageId,
      ),
      this.attempts.latestUserMessageId(input.projectId, input.workItemId, input.conversationId),
    ]);
    if (latestUserMessageId !== input.triggeringMessageId) {
      throw new ConversationTurnError(
        "historical_retry_forbidden",
        "only the latest user message can start or retry a response",
      );
    }
    if (prior) {
      if (!input.allowRetry) {
        throw new ConversationTurnError(
          "message_already_processed",
          "this idempotent message submission already has a turn attempt; refresh or use retry",
        );
      }
      if (prior.status !== "failed" && prior.status !== "cancelled") {
        throw new ConversationTurnError(
          "turn_not_retryable",
          `the latest response attempt is ${prior.status} and cannot be retried`,
        );
      }
    } else if (input.allowRetry) {
      throw new ConversationTurnError(
        "turn_not_retryable",
        "the latest message has no failed or interrupted response to retry",
      );
    }

    const assembled = await this.contexts.assemble(
      input.projectId,
      input.workItemId,
      input.conversationId,
      input.triggeringMessageId,
    );
    const resolvedAttachments = await this.attachments.resolveForConversationTurn(
      input.projectId,
      assembled.attachment_ids,
    );
    if (resolvedAttachments.unavailableAttachmentIds.length > 0) {
      throw new ConversationTurnError(
        "attachment_unavailable",
        "one or more referenced attachments are unavailable",
        422,
      );
    }
    const messages = withCurrentImages(
      assembled.messages,
      assembled.triggering_message_index,
      resolvedAttachments.images,
    );
    const provider = providerName(scope.conversation.provider);

    const attemptId = this.makeId("attempt");
    const outputMessageId = this.makeId("message");
    const usageRequestId = this.makeId("ai_request");
    const startedAt = this.now();
    const trace = await this.telemetry.start({
      requestId: usageRequestId,
      provider,
      model: scope.conversation.model,
      endpoint: endpointFor(provider),
      requestType: "conversation_turn",
      retryGroupId: input.triggeringMessageId,
      retryAttempt: prior?.attempt_number ?? 0,
      projectId: input.projectId,
      initiatedByUserId: input.actor.id,
    });
    let begun: V2ConversationTurnAttemptT;
    try {
      begun = (
        await this.attempts.begin({
          attemptId,
          usageRequestId,
          projectId: input.projectId,
          workItemId: input.workItemId,
          conversationId: input.conversationId,
          initiatedByUserId: input.actor.id,
          triggeringMessageId: input.triggeringMessageId,
          provider,
          model: scope.conversation.model,
          manifest: assembled.manifest,
          contextHash: assembled.context_hash,
          startedAt: startedAt.toISOString(),
        })
      ).attempt;
    } catch (error) {
      const failure = publicFailure(error);
      await trace.fail({
        ...failure,
        latencyMs: Math.max(0, this.now().getTime() - startedAt.getTime()),
      });
      throw error;
    }
    let adapter: ConversationLlmAdapter;
    try {
      adapter = this.createAdapter(provider, scope.conversation.model);
    } catch (error) {
      const failure = publicFailure(error);
      await this.attempts.fail(begun.id, null, "", {
        usageStatus: "unavailable",
        code: failure.code,
        messageRedacted: failure.messageRedacted,
        sanitized: failure.sanitized,
      });
      await trace.fail({
        ...failure,
        latencyMs: Math.max(0, this.now().getTime() - startedAt.getTime()),
      });
      throw error;
    }

    const maxInputTokens = estimateGatewayInputTokens(
      new TextEncoder().encode(
        JSON.stringify({
          system: assembled.system,
          messages,
          maxTokens: CONVERSATION_MAX_OUTPUT_TOKENS,
        }),
      ).byteLength,
    );
    const admission = await this.gateway.reserveConversation(
      {
        reservationKey: begun.id,
        usageRequestId,
        projectId: input.projectId,
        workItemId: input.workItemId,
        conversationId: input.conversationId,
        initiatedByUserId: input.actor.id,
        provider,
        model: scope.conversation.model,
      },
      { maxInputTokens, maxOutputTokens: CONVERSATION_MAX_OUTPUT_TOKENS },
    );
    if (admission.kind === "refused") {
      await this.attempts.fail(begun.id, null, "", {
        usageStatus: "unavailable",
        code: admission.code,
        messageRedacted: admission.message,
        sanitized: null,
      });
      await trace.fail({
        code: admission.code,
        category: "gateway_admission",
        messageRedacted: admission.message,
        latencyMs: Math.max(0, this.now().getTime() - startedAt.getTime()),
        sanitized: { request_dispatched: false },
      });
      throw new ConversationTurnError(
        admission.code,
        admission.message,
        admission.code === "gateway_unavailable" ? 503 : 402,
      );
    }

    const controller = new AbortController();
    this.controllers.set(attemptId, {
      projectId: input.projectId,
      conversationId: input.conversationId,
      controller,
    });
    const request = {
      projectId: input.projectId,
      initiatedByUserId: input.actor.id,
      telemetryRequestId: usageRequestId,
      telemetryRetryGroupId: input.triggeringMessageId,
      telemetryRetryAttempt: prior?.attempt_number ?? 0,
      system: assembled.system,
      messages,
      maxTokens: CONVERSATION_MAX_OUTPUT_TOKENS,
      signal: controller.signal,
    };
    let hasRun = false;
    return {
      attempt: begun,
      outputMessageId,
      run: async (callbacks) => {
        if (hasRun) throw new Error(`attempt "${attemptId}" has already run`);
        hasRun = true;
        await this.run(
          begun,
          outputMessageId,
          adapter,
          request,
          admission.lease,
          trace,
          controller,
          startedAt,
          callbacks,
        );
      },
      cancel: () => {
        controller.abort();
        if (!hasRun) void admission.lease.release().catch(() => undefined);
      },
    };
  }

  async stop(
    actor: ConversationActor,
    projectId: string,
    conversationId: string,
    attemptId?: string,
  ): Promise<boolean> {
    await this.conversations.getConversation(actor, projectId, conversationId);
    const active = attemptId
      ? this.controllers.get(attemptId)
      : [...this.controllers.values()].find(
          (entry) => entry.projectId === projectId && entry.conversationId === conversationId,
        );
    if (!active || active.projectId !== projectId || active.conversationId !== conversationId) {
      return false;
    }
    active.controller.abort();
    return true;
  }

  abortAll(): void {
    for (const entry of this.controllers.values()) entry.controller.abort();
  }

  private async run(
    begun: V2ConversationTurnAttemptT,
    outputMessageId: string,
    adapter: ConversationLlmAdapter,
    request: Parameters<ConversationLlmAdapter["streamConversation"]>[0],
    lease: ConversationGatewayLease,
    trace: AiInvocationTrace,
    controller: AbortController,
    startedAt: Date,
    callbacks: ConversationTurnCallbacks,
  ): Promise<void> {
    let providerRequestId: string | null = null;
    let visibleOutputId: string | null = null;
    let text = "";
    let terminal = false;
    let stream: AsyncIterable<ConversationStreamEvent> | null = null;
    try {
      stream = await lease.stream(adapter, request);
      for await (const event of stream) {
        if (event.type === "response_started") {
          if (providerRequestId !== null) {
            throw new AdapterError("invalid_response", "provider started the response twice");
          }
          providerRequestId = event.provider_execution_id;
          callbacks.started(await this.attempts.markDispatched(begun.id, providerRequestId));
          continue;
        }
        if (event.type === "text_delta") {
          if (providerRequestId === null) {
            throw new AdapterError(
              "invalid_response",
              "provider emitted text before response start",
            );
          }
          if (event.delta.length === 0) continue;
          text += event.delta;
          if (visibleOutputId === null && hasVisibleContent(text)) {
            await this.attempts.startVisibleOutput(begun.id, outputMessageId, text);
            visibleOutputId = outputMessageId;
            callbacks.text(text);
          } else if (visibleOutputId !== null) {
            await this.attempts.persistVisibleText(visibleOutputId, text);
            callbacks.text(event.delta);
          }
          continue;
        }
        await this.finish(
          begun,
          outputMessageId,
          visibleOutputId,
          text,
          providerRequestId,
          event,
          lease,
          trace,
          startedAt,
          callbacks,
        );
        visibleOutputId = outputMessageId;
        terminal = true;
      }
      if (!terminal) {
        throw new AdapterError("invalid_response", "provider stream ended without terminal usage");
      }
    } catch (error) {
      if (terminal) throw error;
      const adapterError = error instanceof AdapterError ? error : null;
      const usage = exactUsage(adapterError);
      const failure = publicFailure(error);
      const metadataProviderRequestId = adapterError?.metadata?.provider_execution_id ?? null;
      if (providerRequestId === null && metadataProviderRequestId) {
        await this.attempts.markDispatched(begun.id, metadataProviderRequestId);
        providerRequestId = metadataProviderRequestId;
      }
      if (usage.usage && providerRequestId) {
        await trace.observe(observation(usage.usage, providerRequestId));
      }
      if (usage.usage) {
        await lease.settle(usage.usage).catch(() => undefined);
      } else if (
        providerRequestId === null &&
        adapterError?.metadata?.request_dispatched === false
      ) {
        await lease.release().catch(() => undefined);
      } else {
        await lease.retainAmbiguous().catch(() => undefined);
      }
      const cancelled = controller.signal.aborted || adapterError?.kind === "cancelled";
      if (cancelled) {
        await this.attempts.cancel(begun.id, visibleOutputId, text, usage);
      } else {
        await this.attempts.fail(begun.id, visibleOutputId, text, {
          ...usage,
          code: failure.code,
          messageRedacted: failure.messageRedacted,
          sanitized: failure.sanitized,
          finishReason: adapterError?.metadata?.finish_reason ?? null,
        });
      }
      await trace.fail({
        ...failure,
        code: cancelled ? "cancelled" : failure.code,
        messageRedacted: cancelled ? "provider stream cancelled" : failure.messageRedacted,
        latencyMs:
          adapterError?.metadata?.latency_ms ??
          Math.max(0, this.now().getTime() - startedAt.getTime()),
        providerRequestId:
          providerRequestId ?? adapterError?.metadata?.provider_execution_id ?? null,
      });
      throw new ConversationTurnError(
        cancelled ? "cancelled" : failure.code,
        cancelled ? "response stopped" : failure.messageRedacted,
        cancelled ? 499 : 502,
        { cause: error },
      );
    } finally {
      this.controllers.delete(begun.id);
      if (!terminal && !controller.signal.aborted) controller.abort();
    }
  }

  private async finish(
    begun: V2ConversationTurnAttemptT,
    outputMessageId: string,
    visibleOutputId: string | null,
    text: string,
    providerRequestId: string | null,
    event: Extract<ConversationStreamEvent, { type: "finish" }>,
    lease: ConversationGatewayLease,
    trace: AiInvocationTrace,
    startedAt: Date,
    callbacks: ConversationTurnCallbacks,
  ): Promise<void> {
    if (providerRequestId === null || providerRequestId !== event.result.provider_execution_id) {
      throw new AdapterError("invalid_response", "provider response identity changed mid-stream");
    }
    if (event.result.text !== text) {
      throw new AdapterError(
        "invalid_response",
        "provider terminal text did not match the visible streamed response",
        {
          metadata: {
            provider_execution_id: providerRequestId,
            finish_reason: event.result.finish_reason,
            ...(event.result.latency_ms !== undefined
              ? { latency_ms: event.result.latency_ms }
              : {}),
            request_dispatched: true,
            usage: event.result.usage,
          },
        },
      );
    }
    if (!hasVisibleContent(text)) {
      throw new AdapterError("invalid_response", "provider returned no visible response", {
        metadata: {
          provider_execution_id: providerRequestId,
          finish_reason: event.result.finish_reason,
          ...(event.result.latency_ms !== undefined ? { latency_ms: event.result.latency_ms } : {}),
          request_dispatched: true,
          usage: event.result.usage,
        },
      });
    }
    if (visibleOutputId === null) {
      await this.attempts.startVisibleOutput(begun.id, outputMessageId, text);
    }
    await trace.observe(observation(event.result.usage, providerRequestId));
    await lease.settle(event.result.usage).catch(() => undefined);
    const settled = await this.attempts.succeed(
      begun.id,
      outputMessageId,
      text,
      providerRequestId,
      event.result.finish_reason,
      event.result.usage,
    );
    await trace.complete({
      latencyMs: event.result.latency_ms ?? Math.max(0, this.now().getTime() - startedAt.getTime()),
      providerRequestId,
    });
    callbacks.finished(settled);
  }
}
