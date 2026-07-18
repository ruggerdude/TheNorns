// Anthropic adapter over the official SDK. maxRetries is 0 by design: retry
// policy belongs to the engine (failure taxonomy), not hidden in the SDK.
import Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";
import { DEFAULT_MODEL_REGISTRY, type ModelEntry, makeUsageEvent } from "./registry.js";
import {
  AdapterError,
  type CompletionRequest,
  type CompletionResult,
  type LlmAdapter,
  type ProviderCompletionMetadata,
  type StructuredResult,
  kindForStatus,
  prepareStructuredOutputPrompt,
} from "./types.js";

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
    const text = this.textOf(response);
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripFences(text));
    } catch (cause) {
      throw new AdapterError("invalid_response", `${schemaName}: response is not JSON`, {
        cause,
        metadata: this.failureMetadata(response, request, startedAt),
      });
    }
    const result = schema.safeParse(parsed);
    if (!result.success) {
      throw new AdapterError(
        "invalid_response",
        `${schemaName}: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
        { metadata: this.failureMetadata(response, request, startedAt) },
      );
    }
    return {
      value: result.data,
      usage: this.usageOf(response, request),
      ...this.metadataOf(response, startedAt),
    };
  }

  private async call(request: CompletionRequest): Promise<Anthropic.Message> {
    try {
      return await this.client.messages.create(
        {
          model: this.model,
          max_tokens: request.maxTokens ?? 16000,
          ...(request.system !== undefined ? { system: request.system } : {}),
          messages: [{ role: "user", content: request.prompt }],
        },
        request.signal !== undefined ? { signal: request.signal } : {},
      );
    } catch (error) {
      throw this.mapError(error);
    }
  }

  private textOf(response: Anthropic.Message): string {
    return response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");
  }

  private usageOf(response: Anthropic.Message, request: CompletionRequest) {
    return makeUsageEvent(
      this.model,
      this.registry,
      { projectId: request.projectId, nodeId: request.nodeId, runId: request.runId },
      response.usage.input_tokens,
      response.usage.output_tokens,
      "provider_api",
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

function stripFences(text: string): string {
  const trimmed = text.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return match?.[1] ?? trimmed;
}
