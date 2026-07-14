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
  type StructuredResult,
  kindForStatus,
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

  private async call(request: CompletionRequest): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    try {
      return await this.client.chat.completions.create(
        {
          model: this.model,
          messages: [
            ...(request.system !== undefined
              ? [{ role: "system" as const, content: request.system }]
              : []),
            { role: "user" as const, content: request.prompt },
          ],
        },
        request.signal !== undefined ? { signal: request.signal } : {},
      );
    } catch (error) {
      throw this.mapError(error);
    }
  }

  private textOf(response: OpenAI.Chat.Completions.ChatCompletion): string {
    return response.choices[0]?.message?.content ?? "";
  }

  private usageOf(response: OpenAI.Chat.Completions.ChatCompletion, request: CompletionRequest) {
    return makeUsageEvent(
      this.model,
      this.registry,
      { projectId: request.projectId, nodeId: request.nodeId, runId: request.runId },
      response.usage?.prompt_tokens ?? 0,
      response.usage?.completion_tokens ?? 0,
      "provider_api",
    );
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
