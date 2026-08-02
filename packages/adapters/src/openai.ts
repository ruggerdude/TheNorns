import type { CodexReasoningEffortT } from "@norns/contracts";
// OpenAI adapter over the official SDK — same interface, same taxonomy, same
// conformance suite as the Anthropic adapter.
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
  boundedImageParts,
  kindForStatus,
  prepareStructuredOutputPrompt,
} from "./types.js";

export interface OpenAiAdapterOptions {
  apiKey: string;
  model: string;
  reasoningEffort?: CodexReasoningEffortT;
  baseURL?: string;
  registry?: Record<string, ModelEntry>;
}

export class OpenAiAdapter implements LlmAdapter {
  readonly provider = "openai" as const;
  readonly model: string;
  private readonly client: OpenAI;
  private readonly registry: Record<string, ModelEntry>;
  private readonly reasoningEffort: CodexReasoningEffortT | undefined;

  constructor(options: OpenAiAdapterOptions) {
    this.model = options.model;
    this.reasoningEffort = options.reasoningEffort;
    this.registry = options.registry ?? DEFAULT_MODEL_REGISTRY;
    this.client = new OpenAI({
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
    let response: OpenAI.Responses.Response | null = null;
    let streamedText = "";
    try {
      const stream = await this.client.responses.create(
        {
          model: this.model,
          input: this.buildInput(structuredRequest),
          stream: true,
          ...(request.system !== undefined ? { instructions: request.system } : {}),
          ...(request.maxTokens !== undefined ? { max_output_tokens: request.maxTokens } : {}),
          ...(this.reasoningEffort !== undefined
            ? { reasoning: { effort: this.reasoningEffort } }
            : {}),
        },
        request.signal !== undefined ? { signal: request.signal } : {},
      );
      for await (const event of stream) {
        if (event.type === "response.output_text.delta") {
          if (event.delta.length > 0) {
            streamedText += event.delta;
            onDelta(event.delta);
          }
          continue;
        }
        if (event.type === "response.completed" || event.type === "response.incomplete") {
          response = event.response;
          break;
        }
        if (event.type === "response.failed") {
          throw new AdapterError(
            "server",
            event.response.error?.message ?? "OpenAI stream failed",
            {
              metadata: {
                provider_execution_id: event.response.id,
                ...(event.response.status ? { finish_reason: event.response.status } : {}),
                latency_ms: Math.max(0, Date.now() - startedAt),
                request_dispatched: true,
              },
            },
          );
        }
        if (event.type === "error") {
          throw new AdapterError("server", event.message, {
            metadata: {
              latency_ms: Math.max(0, Date.now() - startedAt),
              request_dispatched: true,
            },
          });
        }
      }
    } catch (error) {
      throw this.mapError(error);
    }
    if (response === null) {
      throw new AdapterError("invalid_response", "OpenAI stream ended without a terminal event", {
        metadata: { latency_ms: Math.max(0, Date.now() - startedAt), request_dispatched: true },
      });
    }
    if (!response.usage) {
      // Exact usage is a durability guarantee for the structured callers; a
      // zero-filled "exact" record would be a lie, so this is a hard failure —
      // same rule streamConversation already enforces.
      throw new AdapterError("invalid_response", "OpenAI stream completed without exact usage", {
        metadata: {
          ...this.metadataOf(response, startedAt),
          request_dispatched: true,
        },
      });
    }
    return this.structuredResult(
      response,
      request,
      startedAt,
      schema,
      schemaName,
      this.textOf(response) || streamedText,
    );
  }

  private structuredResult<T>(
    response: OpenAI.Responses.Response,
    request: CompletionRequest,
    startedAt: number,
    schema: z.ZodType<T>,
    schemaName: string,
    text: string = this.textOf(response),
  ): StructuredResult<T> {
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
      let providerExecutionId: string | null = null;
      let visibleText = "";
      try {
        const stream = await adapter.client.responses.create(
          {
            model: adapter.model,
            input: adapter.buildConversationInput(request),
            stream: true,
            ...(request.system !== undefined ? { instructions: request.system } : {}),
            ...(request.maxTokens !== undefined ? { max_output_tokens: request.maxTokens } : {}),
            ...(adapter.reasoningEffort !== undefined
              ? { reasoning: { effort: adapter.reasoningEffort } }
              : {}),
          },
          request.signal !== undefined ? { signal: request.signal } : {},
        );
        for await (const event of stream) {
          if (event.type === "response.created") {
            providerExecutionId = event.response.id;
            yield {
              type: "response_started",
              provider_execution_id: event.response.id,
            };
            continue;
          }
          if (event.type === "response.output_text.delta") {
            if (event.delta.length > 0) {
              visibleText += event.delta;
              yield { type: "text_delta", delta: event.delta };
            }
            continue;
          }
          if (event.type === "response.completed" || event.type === "response.incomplete") {
            const response = event.response;
            const executionId = providerExecutionId ?? response.id;
            if (providerExecutionId === null) {
              providerExecutionId = executionId;
              yield { type: "response_started", provider_execution_id: executionId };
            }
            if (!response.usage) {
              throw new AdapterError(
                "invalid_response",
                "OpenAI stream completed without exact usage",
                {
                  metadata: {
                    provider_execution_id: executionId,
                    ...(response.status ? { finish_reason: response.status } : {}),
                    latency_ms: Math.max(0, Date.now() - startedAt),
                    request_dispatched: true,
                  },
                },
              );
            }
            const finishReason =
              response.incomplete_details?.reason ?? response.status ?? "completed";
            const terminalText =
              typeof response.output_text === "string" && response.output_text.length > 0
                ? response.output_text
                : visibleText;
            yield {
              type: "finish",
              result: {
                text: terminalText,
                usage: adapter.usageOf(response, request),
                provider_execution_id: executionId,
                finish_reason: finishReason,
                latency_ms: Math.max(0, Date.now() - startedAt),
              },
            };
            return;
          }
          if (event.type === "response.failed") {
            const response = event.response;
            const executionId = providerExecutionId ?? response.id;
            if (providerExecutionId === null) {
              providerExecutionId = executionId;
              yield { type: "response_started", provider_execution_id: executionId };
            }
            throw new AdapterError("server", response.error?.message ?? "OpenAI response failed", {
              metadata: {
                provider_execution_id: executionId,
                ...(response.status ? { finish_reason: response.status } : {}),
                latency_ms: Math.max(0, Date.now() - startedAt),
                ...(response.usage ? { usage: adapter.usageOf(response, request) } : {}),
                request_dispatched: true,
              },
            });
          }
          if (event.type === "error") {
            throw new AdapterError("server", event.message, {
              metadata: {
                ...(providerExecutionId ? { provider_execution_id: providerExecutionId } : {}),
                latency_ms: Math.max(0, Date.now() - startedAt),
                request_dispatched: true,
              },
            });
          }
        }
        throw new AdapterError("invalid_response", "OpenAI stream ended without a terminal event", {
          metadata: {
            ...(providerExecutionId ? { provider_execution_id: providerExecutionId } : {}),
            latency_ms: Math.max(0, Date.now() - startedAt),
            request_dispatched: providerExecutionId !== null,
          },
        });
      } catch (error) {
        const mapped = adapter.mapError(error);
        if (mapped.metadata || providerExecutionId === null) throw mapped;
        throw new AdapterError(mapped.kind, mapped.message, {
          cause: mapped,
          metadata: {
            provider_execution_id: providerExecutionId,
            latency_ms: Math.max(0, Date.now() - startedAt),
            request_dispatched: true,
          },
        });
      }
    })();
  }

  private async call(request: CompletionRequest): Promise<OpenAI.Responses.Response> {
    try {
      return await this.client.responses.create(
        {
          model: this.model,
          input: this.buildInput(request),
          ...(request.system !== undefined ? { instructions: request.system } : {}),
          ...(request.maxTokens !== undefined ? { max_output_tokens: request.maxTokens } : {}),
          ...(this.reasoningEffort !== undefined
            ? { reasoning: { effort: this.reasoningEffort } }
            : {}),
        },
        request.signal !== undefined ? { signal: request.signal } : {},
      );
    } catch (error) {
      throw this.mapError(error);
    }
  }

  /**
   * FRONT DOOR P4: legacy string input by default; when the request carries
   * image parts, a single user message whose content is the prompt text
   * followed by one `input_image` per attachment, each a base64 data-URI.
   */
  private buildInput(request: CompletionRequest): OpenAI.Responses.ResponseInput | string {
    const images = boundedImageParts(request.images);
    if (images.length === 0) return request.prompt;
    return [
      {
        role: "user",
        content: [
          { type: "input_text", text: request.prompt },
          ...images.map(
            (image): OpenAI.Responses.ResponseInputImage => ({
              type: "input_image",
              image_url: `data:${image.mime};base64,${image.base64}`,
              detail: "auto",
            }),
          ),
        ],
      },
    ];
  }

  private buildConversationInput(request: ConversationRequest): OpenAI.Responses.ResponseInput {
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
    return request.messages.map((message) => {
      if (typeof message.content === "string") {
        return { role: message.role, content: message.content };
      }
      if (message.role === "assistant") {
        const text = message.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("");
        return { role: "assistant", content: text };
      }
      return {
        role: "user",
        content: message.content.map((part) =>
          part.type === "text"
            ? ({ type: "input_text", text: part.text } as const)
            : ({
                type: "input_image",
                image_url: `data:${part.mime};base64,${part.base64}`,
                detail: "auto",
              } as const),
        ),
      };
    });
  }

  private textOf(response: OpenAI.Responses.Response): string {
    return response.output_text;
  }

  private usageOf(response: OpenAI.Responses.Response, request: CompletionAttribution) {
    const cacheReadTokens = response.usage?.input_tokens_details.cached_tokens ?? 0;
    const cacheWriteTokens = response.usage?.input_tokens_details.cache_write_tokens ?? 0;
    return makeUsageEvent(
      this.model,
      this.registry,
      { projectId: request.projectId, nodeId: request.nodeId, runId: request.runId },
      response.usage?.input_tokens ?? 0,
      response.usage?.output_tokens ?? 0,
      "provider_api",
      { readTokens: cacheReadTokens, writeTokens: cacheWriteTokens },
    );
  }

  private metadataOf(
    response: OpenAI.Responses.Response,
    startedAt: number,
  ): ProviderCompletionMetadata {
    const finishReason = response.incomplete_details?.reason ?? response.status;
    return {
      provider_execution_id: response.id,
      latency_ms: Math.max(0, Date.now() - startedAt),
      ...(finishReason !== undefined ? { finish_reason: finishReason } : {}),
    };
  }

  private failureMetadata(
    response: OpenAI.Responses.Response,
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
    if (error instanceof OpenAI.APIUserAbortError) {
      return new AdapterError("cancelled", "request aborted", { cause: error });
    }
    if (error instanceof OpenAI.APIConnectionError) {
      return new AdapterError("network", error.message, { cause: error });
    }
    if (error instanceof OpenAI.APIError) {
      const status = typeof error.status === "number" ? error.status : 500;
      return new AdapterError(kindForStatus(status), error.message, { cause: error });
    }
    return new AdapterError("network", error instanceof Error ? error.message : "unknown error", {
      cause: error,
    });
  }
}
