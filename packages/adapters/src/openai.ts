// OpenAI adapter over the official SDK — same interface, same taxonomy, same
// conformance suite as the Anthropic adapter.
import OpenAI from "openai";
import type { z } from "zod";
import { DEFAULT_MODEL_REGISTRY, type ModelEntry, makeUsageEvent } from "./registry.js";
import {
  AdapterError,
  type CompletionRequest,
  type CompletionResult,
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
  baseURL?: string;
  registry?: Record<string, ModelEntry>;
}

export class OpenAiAdapter implements LlmAdapter {
  readonly provider = "openai" as const;
  readonly model: string;
  private readonly client: OpenAI;
  private readonly registry: Record<string, ModelEntry>;

  constructor(options: OpenAiAdapterOptions) {
    this.model = options.model;
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

  private async call(request: CompletionRequest): Promise<OpenAI.Responses.Response> {
    try {
      return await this.client.responses.create(
        {
          model: this.model,
          input: this.buildInput(request),
          ...(request.system !== undefined ? { instructions: request.system } : {}),
          ...(request.maxTokens !== undefined ? { max_output_tokens: request.maxTokens } : {}),
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

  private textOf(response: OpenAI.Responses.Response): string {
    return response.output_text;
  }

  private usageOf(response: OpenAI.Responses.Response, request: CompletionRequest) {
    return makeUsageEvent(
      this.model,
      this.registry,
      { projectId: request.projectId, nodeId: request.nodeId, runId: request.runId },
      response.usage?.input_tokens ?? 0,
      response.usage?.output_tokens ?? 0,
      "provider_api",
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

function stripFences(text: string): string {
  const trimmed = text.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return match?.[1] ?? trimmed;
}
