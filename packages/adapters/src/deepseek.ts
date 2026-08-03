// DeepSeek exposes an OpenAI-compatible Chat Completions API, but not the
// OpenAI Responses API. Keep the SDK behind a small injectable boundary so the
// wire contract can be tested without network calls and without leaking
// provider-specific response fields into the rest of the application.
import OpenAI from "openai";
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
  kindForStatus,
  prepareStructuredOutputPrompt,
} from "./types.js";

export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

interface DeepSeekMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface DeepSeekChatRequest {
  model: string;
  messages: DeepSeekMessage[];
  max_tokens?: number;
  response_format?: { type: "json_object" };
  stream?: boolean;
  stream_options?: { include_usage: true };
}

export interface DeepSeekUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens?: number;
  /** DeepSeek reports cache accounting at the top level of usage. */
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
}

export interface DeepSeekChatCompletion {
  id: string;
  choices: Array<{
    message: {
      content?: string | null;
      /** Never returned from this adapter or copied into durable metadata. */
      reasoning_content?: string | null;
    };
    finish_reason: string | null;
  }>;
  usage?: DeepSeekUsage;
}

export interface DeepSeekChatCompletionChunk {
  id?: string;
  choices: Array<{
    delta: {
      content?: string | null;
      /** Deliberately ignored: callers may persist only visible text. */
      reasoning_content?: string | null;
    };
    finish_reason?: string | null;
  }>;
  usage?: DeepSeekUsage | null;
}

export interface DeepSeekClientBoundary {
  create(
    request: DeepSeekChatRequest,
    options?: { signal?: AbortSignal },
  ): Promise<DeepSeekChatCompletion | AsyncIterable<DeepSeekChatCompletionChunk>>;
}

export interface DeepSeekAdapterOptions {
  apiKey: string;
  model: string;
  baseURL?: string;
  registry?: Record<string, ModelEntry>;
  /** Test seam; production callers normally use the SDK-backed default. */
  client?: DeepSeekClientBoundary;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<DeepSeekChatCompletionChunk> {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof value[Symbol.asyncIterator] === "function"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0
    ? error.message
    : "DeepSeek request failed";
}

export class DeepSeekAdapter implements LlmAdapter {
  readonly provider = "deepseek" as const;
  readonly model: string;
  private readonly client: DeepSeekClientBoundary;
  private readonly registry: Record<string, ModelEntry>;

  constructor(options: DeepSeekAdapterOptions) {
    this.model = options.model;
    this.registry = options.registry ?? DEFAULT_MODEL_REGISTRY;
    if (options.client) {
      this.client = options.client;
      return;
    }
    const sdk = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseURL ?? DEEPSEEK_BASE_URL,
      maxRetries: 0,
    });
    this.client = {
      create: (request, requestOptions) =>
        sdk.chat.completions.create(
          request as OpenAI.Chat.Completions.ChatCompletionCreateParams,
          requestOptions,
        ) as unknown as Promise<
          DeepSeekChatCompletion | AsyncIterable<DeepSeekChatCompletionChunk>
        >,
    };
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    this.assertNoCompletionImages(request);
    const startedAt = Date.now();
    const response = await this.callBuffered(this.completionBody(request), request.signal);
    const text = this.visibleText(response, request, startedAt);
    return {
      text,
      usage: this.usageOf(this.requiredUsage(response, startedAt), request),
      ...this.metadataOf(response, startedAt),
    };
  }

  async completeStructured<T>(
    request: CompletionRequest,
    schema: z.ZodType<T>,
    schemaName: string,
  ): Promise<StructuredResult<T>> {
    this.assertNoCompletionImages(request);
    const startedAt = Date.now();
    const body = this.completionBody(request, this.structuredPrompt(request, schema, schemaName));
    body.response_format = { type: "json_object" };
    const response = await this.callBuffered(body, request.signal);
    const text = this.visibleText(response, request, startedAt);
    const usage = this.requiredUsage(response, startedAt);
    const value = parseStructured(
      text,
      schema,
      schemaName,
      this.failureMetadata(response, request, startedAt, usage),
    );
    return {
      value,
      text,
      usage: this.usageOf(usage, request),
      ...this.metadataOf(response, startedAt),
    };
  }

  async streamStructured<T>(
    request: CompletionRequest,
    schema: z.ZodType<T>,
    schemaName: string,
    onDelta: (delta: string) => void,
  ): Promise<StructuredResult<T>> {
    this.assertNoCompletionImages(request);
    const startedAt = Date.now();
    const body = this.completionBody(request, this.structuredPrompt(request, schema, schemaName));
    body.response_format = { type: "json_object" };
    body.stream = true;
    body.stream_options = { include_usage: true };

    let aggregate: StreamAggregate;
    let dispatched = false;
    try {
      const stream = await this.callStreaming(body, request.signal);
      dispatched = true;
      aggregate = await this.consumeStream(stream, onDelta);
    } catch (error) {
      const mapped = this.mapError(error);
      throw dispatched ? this.withStreamMetadata(mapped, startedAt) : mapped;
    }
    const metadata = this.streamMetadata(aggregate, startedAt);
    if (!aggregate.usage) {
      throw new AdapterError("invalid_response", "DeepSeek stream completed without exact usage", {
        metadata,
      });
    }
    const value = parseStructured(aggregate.text, schema, schemaName, {
      ...metadata,
      usage: this.usageOf(aggregate.usage, request),
    });
    return {
      value,
      text: aggregate.text,
      usage: this.usageOf(aggregate.usage, request),
      ...(aggregate.id ? { provider_execution_id: aggregate.id } : {}),
      ...(aggregate.finishReason ? { finish_reason: aggregate.finishReason } : {}),
      latency_ms: Math.max(0, Date.now() - startedAt),
    };
  }

  async streamConversation(
    request: ConversationRequest,
  ): Promise<AsyncIterable<ConversationStreamEvent>> {
    const messages = this.conversationMessages(request);
    const adapter = this;
    return (async function* streamVisibleConversation() {
      const startedAt = Date.now();
      let providerExecutionId: string | null = null;
      let finishReason: string | null = null;
      let usage: DeepSeekUsage | null = null;
      let visibleText = "";
      let dispatched = false;
      try {
        const stream = await adapter.callStreaming(
          {
            model: adapter.model,
            messages,
            ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
            stream: true,
            stream_options: { include_usage: true },
          },
          request.signal,
        );
        dispatched = true;
        for await (const chunk of stream) {
          // The OpenAI SDK consumes SSE comments such as `: keep-alive` before
          // yielding chunks. Empty choice chunks are also valid (the terminal
          // usage chunk is one), so they are intentionally not treated as an
          // invalid response.
          if (providerExecutionId === null && chunk.id) {
            providerExecutionId = chunk.id;
            yield { type: "response_started", provider_execution_id: chunk.id };
          }
          if (chunk.usage) usage = chunk.usage;
          for (const choice of chunk.choices) {
            if (choice.finish_reason) finishReason = choice.finish_reason;
            const delta = choice.delta.content;
            // reasoning_content is deliberately never emitted or accumulated.
            if (typeof delta === "string" && delta.length > 0) {
              visibleText += delta;
              yield { type: "text_delta", delta };
            }
          }
        }
        if (providerExecutionId === null) {
          throw new AdapterError("invalid_response", "DeepSeek stream ended without an id", {
            metadata: {
              latency_ms: Math.max(0, Date.now() - startedAt),
              request_dispatched: true,
            },
          });
        }
        if (!usage) {
          throw new AdapterError(
            "invalid_response",
            "DeepSeek stream completed without exact usage",
            {
              metadata: {
                provider_execution_id: providerExecutionId,
                ...(finishReason ? { finish_reason: finishReason } : {}),
                latency_ms: Math.max(0, Date.now() - startedAt),
                request_dispatched: true,
              },
            },
          );
        }
        yield {
          type: "finish",
          result: {
            text: visibleText,
            usage: adapter.usageOf(usage, request),
            provider_execution_id: providerExecutionId,
            finish_reason: finishReason ?? "stop",
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
            ...(finishReason ? { finish_reason: finishReason } : {}),
            latency_ms: Math.max(0, Date.now() - startedAt),
            request_dispatched: true,
          },
        });
      }
    })();
  }

  private completionBody(request: CompletionRequest, prompt = request.prompt): DeepSeekChatRequest {
    return {
      model: this.model,
      messages: [
        ...(request.system !== undefined
          ? ([{ role: "system", content: request.system }] satisfies DeepSeekMessage[])
          : []),
        { role: "user", content: prompt },
      ],
      ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
    };
  }

  private structuredPrompt<T>(
    request: CompletionRequest,
    schema: z.ZodType<T>,
    schemaName: string,
  ): string {
    return request.structuredOutputPrepared
      ? request.prompt
      : prepareStructuredOutputPrompt(request.prompt, schema, schemaName);
  }

  private conversationMessages(request: ConversationRequest): DeepSeekMessage[] {
    if (request.messages.length === 0) {
      throw new AdapterError("invalid_request", "conversation requires at least one message");
    }
    const messages: DeepSeekMessage[] = [];
    if (request.system !== undefined) messages.push({ role: "system", content: request.system });
    for (const message of request.messages) {
      if (typeof message.content === "string") {
        messages.push({ role: message.role, content: message.content });
        continue;
      }
      if (message.content.some((part) => part.type === "image")) {
        throw new AdapterError("invalid_request", "DeepSeek models do not support image input");
      }
      messages.push({
        role: message.role,
        content: message.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join(""),
      });
    }
    return messages;
  }

  private assertNoCompletionImages(request: CompletionRequest): void {
    if ((request.images?.length ?? 0) > 0) {
      throw new AdapterError("invalid_request", "DeepSeek models do not support image input");
    }
  }

  private async callBuffered(
    body: DeepSeekChatRequest,
    signal: AbortSignal | undefined,
  ): Promise<DeepSeekChatCompletion> {
    try {
      const response = await this.client.create(
        body,
        signal !== undefined ? { signal } : undefined,
      );
      if (isAsyncIterable(response)) {
        throw new AdapterError("invalid_response", "DeepSeek returned a stream unexpectedly");
      }
      return response;
    } catch (error) {
      throw this.mapError(error);
    }
  }

  private async callStreaming(
    body: DeepSeekChatRequest,
    signal: AbortSignal | undefined,
  ): Promise<AsyncIterable<DeepSeekChatCompletionChunk>> {
    try {
      const response = await this.client.create(
        body,
        signal !== undefined ? { signal } : undefined,
      );
      if (!isAsyncIterable(response)) {
        throw new AdapterError("invalid_response", "DeepSeek did not return a stream");
      }
      return response;
    } catch (error) {
      throw this.mapError(error);
    }
  }

  private async consumeStream(
    stream: AsyncIterable<DeepSeekChatCompletionChunk>,
    onDelta: (delta: string) => void,
  ): Promise<StreamAggregate> {
    const aggregate: StreamAggregate = {
      id: null,
      finishReason: null,
      text: "",
      usage: null,
    };
    for await (const chunk of stream) {
      if (chunk.id) aggregate.id ??= chunk.id;
      if (chunk.usage) aggregate.usage = chunk.usage;
      for (const choice of chunk.choices) {
        if (choice.finish_reason) aggregate.finishReason = choice.finish_reason;
        const delta = choice.delta.content;
        // Ignore reasoning_content even when it arrives before visible text.
        if (typeof delta === "string" && delta.length > 0) {
          aggregate.text += delta;
          onDelta(delta);
        }
      }
    }
    return aggregate;
  }

  private visibleText(
    response: DeepSeekChatCompletion,
    request: CompletionAttribution,
    startedAt: number,
  ): string {
    const content = response.choices[0]?.message.content;
    if (typeof content === "string") return content;
    throw new AdapterError("invalid_response", "DeepSeek response contained no visible text", {
      metadata: {
        ...this.metadataOf(response, startedAt),
        ...(response.usage ? { usage: this.usageOf(response.usage, request) } : {}),
        request_dispatched: true,
      },
    });
  }

  private requiredUsage(response: DeepSeekChatCompletion, startedAt: number): DeepSeekUsage {
    const usage = response.usage;
    if (
      !usage ||
      !Number.isSafeInteger(usage.prompt_tokens) ||
      usage.prompt_tokens < 0 ||
      !Number.isSafeInteger(usage.completion_tokens) ||
      usage.completion_tokens < 0
    ) {
      throw new AdapterError("invalid_response", "DeepSeek response omitted exact usage", {
        metadata: {
          ...this.metadataOf(response, startedAt),
          request_dispatched: true,
        },
      });
    }
    return usage;
  }

  private usageOf(usage: DeepSeekUsage, request: CompletionAttribution) {
    return makeUsageEvent(
      this.model,
      this.registry,
      { projectId: request.projectId, nodeId: request.nodeId, runId: request.runId },
      usage.prompt_tokens,
      usage.completion_tokens,
      "provider_api",
      { readTokens: usage.prompt_cache_hit_tokens ?? 0, writeTokens: 0 },
    );
  }

  private metadataOf(
    response: DeepSeekChatCompletion,
    startedAt: number,
  ): ProviderCompletionMetadata {
    const finishReason = response.choices[0]?.finish_reason;
    return {
      provider_execution_id: response.id,
      ...(finishReason ? { finish_reason: finishReason } : {}),
      latency_ms: Math.max(0, Date.now() - startedAt),
    };
  }

  private failureMetadata(
    response: DeepSeekChatCompletion,
    request: CompletionRequest,
    startedAt: number,
    usage: DeepSeekUsage,
  ) {
    return {
      ...this.metadataOf(response, startedAt),
      usage: this.usageOf(usage, request),
      request_dispatched: true,
    };
  }

  private streamMetadata(aggregate: StreamAggregate, startedAt: number) {
    return {
      ...(aggregate.id ? { provider_execution_id: aggregate.id } : {}),
      ...(aggregate.finishReason ? { finish_reason: aggregate.finishReason } : {}),
      latency_ms: Math.max(0, Date.now() - startedAt),
      request_dispatched: true as const,
    };
  }

  private withStreamMetadata(error: unknown, startedAt: number): AdapterError {
    const mapped = this.mapError(error);
    if (mapped.metadata) return mapped;
    return new AdapterError(mapped.kind, mapped.message, {
      cause: mapped,
      metadata: {
        latency_ms: Math.max(0, Date.now() - startedAt),
        request_dispatched: true,
      },
    });
  }

  private mapError(error: unknown): AdapterError {
    if (error instanceof AdapterError) return error;
    if (
      error instanceof OpenAI.APIUserAbortError ||
      (error instanceof Error && error.name === "AbortError")
    ) {
      return new AdapterError("cancelled", "request aborted", { cause: error });
    }
    if (error instanceof OpenAI.APIConnectionError) {
      return new AdapterError("network", error.message, { cause: error });
    }
    if (error instanceof OpenAI.APIError) {
      const status = typeof error.status === "number" ? error.status : 500;
      return new AdapterError(kindForStatus(status), error.message, { cause: error });
    }
    if (
      typeof error === "object" &&
      error !== null &&
      "status" in error &&
      typeof error.status === "number"
    ) {
      return new AdapterError(kindForStatus(error.status), errorMessage(error), { cause: error });
    }
    return new AdapterError("network", errorMessage(error), { cause: error });
  }
}

interface StreamAggregate {
  id: string | null;
  finishReason: string | null;
  text: string;
  usage: DeepSeekUsage | null;
}
