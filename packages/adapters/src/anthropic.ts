// Anthropic adapter over the official SDK. maxRetries is 0 by design: retry
// policy belongs to the engine (failure taxonomy), not hidden in the SDK.
import Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";
import { DEFAULT_MODEL_REGISTRY, type ModelEntry, makeUsageEvent } from "./registry.js";
import { parseStructured } from "./structuredFailure.js";
import {
  AdapterError,
  type CompletionAttribution,
  type CompletionRequest,
  type CompletionResult,
  type ConversationRequest,
  type ConversationStreamEvent,
  type LlmAdapter,
  type ProviderCompletionMetadata,
  type StructuredResult,
  boundedImageParts,
  kindForStatus,
  prepareStructuredOutputPrompt,
} from "./types.js";

/**
 * Anthropic bills thinking tokens against `max_tokens` — the one budget bounds
 * thinking AND visible output together. Claude Sonnet 5 / Opus 5 run adaptive
 * thinking when `thinking` is omitted (Sonnet 4.6 did not), so a caller that
 * sized `maxTokens` around a JSON envelope silently loses most of it to
 * thinking and the envelope truncates mid-object — surfacing as
 * `invalid_response`. Structured-output callers here budget 3k–16k tokens for
 * the envelope alone, so thinking is explicitly disabled on the non-chat
 * completion paths and the budget means output tokens, deterministically.
 *
 * `streamConversation` (ordinary chat) is deliberately NOT covered: chat
 * benefits from thinking and its budget is not load-bearing.
 *
 * Fable/Mythos 5 reject an explicit `thinking: {type:"disabled"}` with a 400
 * (thinking is always on there), so they opt out and keep the default.
 */
const THINKING_ALWAYS_ON = /^claude-(fable|mythos)/;

function outputOnlyThinking(model: string): { thinking?: Anthropic.ThinkingConfigParam } {
  return THINKING_ALWAYS_ON.test(model) ? {} : { thinking: { type: "disabled" } };
}

export interface AnthropicAdapterOptions {
  apiKey: string;
  model: string;
  baseURL?: string;
  registry?: Record<string, ModelEntry>;
}

export class AnthropicAdapter implements LlmAdapter {
  readonly provider = "anthropic" as const;
  readonly model: string;
  private readonly client: Anthropic;
  private readonly registry: Record<string, ModelEntry>;

  constructor(options: AnthropicAdapterOptions) {
    this.model = options.model;
    this.registry = options.registry ?? DEFAULT_MODEL_REGISTRY;
    this.client = new Anthropic({
      apiKey: options.apiKey,
      maxRetries: 0,
      ...(options.baseURL !== undefined ? { baseURL: options.baseURL } : {}),
    });
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const startedAt = Date.now();
    const response = await this.call(request);
    return {
      text: this.textOf(response),
      usage: this.usageOf(response, request),
      ...this.metadataOf(response, startedAt),
    };
  }

  async completeStructured<T>(
    request: CompletionRequest,
    schema: z.ZodType<T>,
    schemaName: string,
  ): Promise<StructuredResult<T>> {
    const startedAt = Date.now();
    const structuredRequest: CompletionRequest = {
      ...request,
      prompt: request.structuredOutputPrepared
        ? request.prompt
        : prepareStructuredOutputPrompt(request.prompt, schema, schemaName),
    };
    const response = await this.call(structuredRequest);
    return this.structuredResult(response, request, startedAt, schema, schemaName);
  }

  /**
   * The streamed twin of `completeStructured`: identical request, identical
   * validated result, with raw text handed to `onDelta` as it arrives so the
   * caller can show progress instead of a blind wait.
   */
  async streamStructured<T>(
    request: CompletionRequest,
    schema: z.ZodType<T>,
    schemaName: string,
    onDelta: (delta: string) => void,
  ): Promise<StructuredResult<T>> {
    const startedAt = Date.now();
    const structuredRequest: CompletionRequest = {
      ...request,
      prompt: request.structuredOutputPrepared
        ? request.prompt
        : prepareStructuredOutputPrompt(request.prompt, schema, schemaName),
    };
    let response: Anthropic.Message;
    try {
      const stream = this.client.messages.stream(
        {
          model: this.model,
          max_tokens: request.maxTokens ?? 16000,
          ...outputOnlyThinking(this.model),
          ...(request.system !== undefined ? { system: request.system } : {}),
          messages: [{ role: "user", content: this.userContent(structuredRequest) }],
        },
        request.signal !== undefined ? { signal: request.signal } : {},
      );
      for await (const event of stream) {
        if (
          event.type === "content_block_delta" &&
          event.delta.type === "text_delta" &&
          event.delta.text.length > 0
        ) {
          onDelta(event.delta.text);
        }
      }
      response = await stream.finalMessage();
    } catch (error) {
      throw this.mapError(error);
    }
    return this.structuredResult(response, request, startedAt, schema, schemaName);
  }

  private structuredResult<T>(
    response: Anthropic.Message,
    request: CompletionRequest,
    startedAt: number,
    schema: z.ZodType<T>,
    schemaName: string,
  ): StructuredResult<T> {
    const text = this.textOf(response);
    const value = parseStructured(
      text,
      schema,
      schemaName,
      this.failureMetadata(response, request, startedAt),
    );
    return {
      value,
      usage: this.usageOf(response, request),
      text,
      ...this.metadataOf(response, startedAt),
    };
  }

  async streamConversation(
    request: ConversationRequest,
  ): Promise<AsyncIterable<ConversationStreamEvent>> {
    const adapter = this;
    return (async function* streamVisibleConversation() {
      const startedAt = Date.now();
      let dispatched = false;
      let providerExecutionId: string | null = null;
      try {
        const stream = adapter.client.messages.stream(
          {
            model: adapter.model,
            max_tokens: request.maxTokens ?? 16_000,
            ...(request.system !== undefined ? { system: request.system } : {}),
            messages: adapter.conversationMessages(request),
          },
          request.signal !== undefined ? { signal: request.signal } : {},
        );
        dispatched = true;
        for await (const event of stream) {
          if (event.type === "message_start") {
            providerExecutionId = event.message.id;
            yield {
              type: "response_started",
              provider_execution_id: event.message.id,
            };
            continue;
          }
          if (
            event.type === "content_block_delta" &&
            event.delta.type === "text_delta" &&
            event.delta.text.length > 0
          ) {
            yield { type: "text_delta", delta: event.delta.text };
          }
        }
        const response = await stream.finalMessage();
        const executionId = providerExecutionId ?? response.id;
        yield {
          type: "finish",
          result: {
            text: adapter.textOf(response),
            usage: adapter.usageOf(response, request),
            provider_execution_id: executionId,
            finish_reason: response.stop_reason ?? "end_turn",
            latency_ms: Math.max(0, Date.now() - startedAt),
          },
        };
      } catch (error) {
        const mapped = adapter.mapError(error);
        if (mapped.metadata || !dispatched) throw mapped;
        throw new AdapterError(mapped.kind, mapped.message, {
          cause: mapped,
          metadata: {
            ...(providerExecutionId ? { provider_execution_id: providerExecutionId } : {}),
            latency_ms: Math.max(0, Date.now() - startedAt),
            request_dispatched: true,
          },
        });
      }
    })();
  }

  private async call(request: CompletionRequest): Promise<Anthropic.Message> {
    try {
      return await this.client.messages.create(
        {
          model: this.model,
          max_tokens: request.maxTokens ?? 16000,
          // Covers both `complete` and `completeStructured` — every buffered
          // completion path assumes max_tokens bounds visible output alone.
          ...outputOnlyThinking(this.model),
          ...(request.system !== undefined ? { system: request.system } : {}),
          messages: [{ role: "user", content: this.userContent(request) }],
        },
        request.signal !== undefined ? { signal: request.signal } : {},
      );
    } catch (error) {
      throw this.mapError(error);
    }
  }

  /**
   * FRONT DOOR P4: legacy string content by default; when the request carries
   * image parts, a multi-block content array — the prompt text followed by
   * one base64 `image` source block per attachment.
   */
  private userContent(request: CompletionRequest): string | Anthropic.ContentBlockParam[] {
    const images = boundedImageParts(request.images);
    if (images.length === 0) return request.prompt;
    return [
      { type: "text", text: request.prompt },
      ...images.map(
        (image): Anthropic.ImageBlockParam => ({
          type: "image",
          source: { type: "base64", media_type: image.mime, data: image.base64 },
        }),
      ),
    ];
  }

  private conversationMessages(request: ConversationRequest): Anthropic.MessageParam[] {
    if (request.messages.length === 0) {
      throw new AdapterError("invalid_request", "conversation requires at least one message");
    }
    boundedImageParts(
      request.messages.flatMap((message) =>
        typeof message.content === "string"
          ? []
          : message.content.filter(
              (part): part is import("./types.js").ImagePart => part.type === "image",
            ),
      ),
    );
    return request.messages.map((message): Anthropic.MessageParam => {
      if (typeof message.content === "string") {
        return { role: message.role, content: message.content };
      }
      const content: Anthropic.ContentBlockParam[] = message.content.map((part) =>
        part.type === "text"
          ? { type: "text", text: part.text }
          : {
              type: "image",
              source: { type: "base64", media_type: part.mime, data: part.base64 },
            },
      );
      return { role: message.role, content };
    });
  }

  private textOf(response: Anthropic.Message): string {
    return response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");
  }

  private usageOf(response: Anthropic.Message, request: CompletionAttribution) {
    const cacheReadTokens = response.usage.cache_read_input_tokens ?? 0;
    const cacheWriteTokens = response.usage.cache_creation_input_tokens ?? 0;
    return makeUsageEvent(
      this.model,
      this.registry,
      { projectId: request.projectId, nodeId: request.nodeId, runId: request.runId },
      response.usage.input_tokens + cacheReadTokens + cacheWriteTokens,
      response.usage.output_tokens,
      "provider_api",
      { readTokens: cacheReadTokens, writeTokens: cacheWriteTokens },
    );
  }

  private metadataOf(response: Anthropic.Message, startedAt: number): ProviderCompletionMetadata {
    return {
      provider_execution_id: response.id,
      latency_ms: Math.max(0, Date.now() - startedAt),
      ...(response.stop_reason !== null ? { finish_reason: response.stop_reason } : {}),
    };
  }

  private failureMetadata(
    response: Anthropic.Message,
    request: CompletionRequest,
    startedAt: number,
  ) {
    return {
      ...this.metadataOf(response, startedAt),
      usage: this.usageOf(response, request),
      request_dispatched: true,
    };
  }

  private mapError(error: unknown): AdapterError {
    if (error instanceof AdapterError) return error;
    if (error instanceof Anthropic.APIUserAbortError) {
      return new AdapterError("cancelled", "request aborted", { cause: error });
    }
    if (error instanceof Anthropic.APIConnectionError) {
      return new AdapterError("network", error.message, { cause: error });
    }
    if (error instanceof Anthropic.APIError) {
      const status = typeof error.status === "number" ? error.status : 500;
      return new AdapterError(kindForStatus(status), error.message, { cause: error });
    }
    return new AdapterError("network", error instanceof Error ? error.message : "unknown error", {
      cause: error,
    });
  }
}
