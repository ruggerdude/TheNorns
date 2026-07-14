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
  type StructuredResult,
  kindForStatus,
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
    const response = await this.call(request);
    return { text: this.textOf(response), usage: this.usageOf(response, request) };
  }

  async completeStructured<T>(
    request: CompletionRequest,
    schema: z.ZodType<T>,
    schemaName: string,
  ): Promise<StructuredResult<T>> {
    const structuredRequest: CompletionRequest = {
      ...request,
      prompt: `${request.prompt}\n\nRespond with ONLY a JSON object named "${schemaName}" matching the required schema. No prose, no code fences.`,
    };
    const response = await this.call(structuredRequest);
    const text = this.textOf(response);
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripFences(text));
    } catch (cause) {
      throw new AdapterError("invalid_response", `${schemaName}: response is not JSON`, { cause });
    }
    const result = schema.safeParse(parsed);
    if (!result.success) {
      throw new AdapterError(
        "invalid_response",
        `${schemaName}: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      );
    }
    return { value: result.data, usage: this.usageOf(response, request) };
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
