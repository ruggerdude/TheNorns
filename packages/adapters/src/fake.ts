// Scripted adapter for orchestration tests (Phase 3): deterministic queued
// responses, full request capture, contracts-validated structured outputs.
// This is a test double for the *loop logic* — live model quality iteration
// happens against real adapters.
import type { z } from "zod";
import { DEFAULT_MODEL_REGISTRY, makeUsageEvent } from "./registry.js";
import type {
  CompletionRequest,
  CompletionResult,
  LlmAdapter,
  ProviderName,
  StructuredResult,
} from "./types.js";

export interface RecordedRequest {
  system: string | undefined;
  prompt: string;
  schemaName: string | null;
}

export class FakeAdapter implements LlmAdapter {
  readonly provider: ProviderName;
  readonly model: string;
  readonly requests: RecordedRequest[] = [];
  private readonly queue: unknown[] = [];

  constructor(provider: ProviderName, model = `mock-${provider}`) {
    this.provider = provider;
    this.model = model;
  }

  /** Queue the next response (a string for complete(), an object for structured). */
  enqueue(...responses: unknown[]): void {
    this.queue.push(...responses);
  }

  private next(): unknown {
    const value = this.queue.shift();
    if (value === undefined) {
      throw new Error(`FakeAdapter(${this.provider}): response queue is empty`);
    }
    return value;
  }

  private usage(request: CompletionRequest) {
    return makeUsageEvent(
      this.model,
      DEFAULT_MODEL_REGISTRY,
      { projectId: request.projectId, nodeId: request.nodeId, runId: request.runId },
      100,
      50,
      "provider_api",
    );
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    this.requests.push({ system: request.system, prompt: request.prompt, schemaName: null });
    return { text: String(this.next()), usage: this.usage(request) };
  }

  async completeStructured<T>(
    request: CompletionRequest,
    schema: z.ZodType<T>,
    schemaName: string,
  ): Promise<StructuredResult<T>> {
    this.requests.push({ system: request.system, prompt: request.prompt, schemaName });
    // canned data must satisfy the real contracts schema — keeps fakes honest
    return { value: schema.parse(this.next()), usage: this.usage(request) };
  }
}
