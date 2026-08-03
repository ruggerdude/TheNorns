// Scripted adapter for orchestration tests (Phase 3): deterministic queued
// responses, full request capture, contracts-validated structured outputs.
// This is a test double for the *loop logic* — live model quality iteration
// happens against real adapters.
import type { z } from "zod";
import { DEFAULT_MODEL_REGISTRY, makeUsageEvent } from "./registry.js";
import { parseStructured } from "./structuredFailure.js";
import { AdapterError } from "./types.js";
import type {
  CompletionAttribution,
  CompletionRequest,
  CompletionResult,
  ConversationMessage,
  ConversationRequest,
  ConversationStreamEvent,
  ImagePart,
  LlmAdapter,
  ProviderName,
  StructuredResult,
} from "./types.js";

export interface RecordedRequest {
  system: string | undefined;
  prompt: string;
  schemaName: string | null;
  initiatedByUserId: string | null | undefined;
  projectId: string | null | undefined;
  telemetryRequestId?: string | undefined;
  telemetryRetryGroupId?: string | null | undefined;
  telemetryRetryAttempt?: number | undefined;
  maxTokens?: number | undefined;
  outputEffort?: CompletionRequest["outputEffort"] | undefined;
  /** FRONT DOOR P4: image parts carried by this request (undefined when none). */
  images: readonly ImagePart[] | undefined;
  messages?: readonly ConversationMessage[] | undefined;
}

/** Marker for a queued partial structured body; see FakeAdapter.truncated. */
export class FakeStructuredStream {
  constructor(
    readonly text: string,
    readonly finishReason: string,
  ) {}
}

export class FakeAdapter implements LlmAdapter {
  private static conversationSequence = 0;
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

  private usage(request: CompletionAttribution) {
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
    this.requests.push({
      system: request.system,
      prompt: request.prompt,
      schemaName: null,
      initiatedByUserId: request.initiatedByUserId,
      projectId: request.projectId,
      telemetryRequestId: request.telemetryRequestId,
      telemetryRetryGroupId: request.telemetryRetryGroupId,
      telemetryRetryAttempt: request.telemetryRetryAttempt,
      maxTokens: request.maxTokens,
      outputEffort: request.outputEffort,
      images: request.images,
    });
    return { text: String(this.next()), usage: this.usage(request) };
  }

  async completeStructured<T>(
    request: CompletionRequest,
    schema: z.ZodType<T>,
    schemaName: string,
  ): Promise<StructuredResult<T>> {
    this.requests.push({
      system: request.system,
      prompt: request.prompt,
      schemaName,
      initiatedByUserId: request.initiatedByUserId,
      projectId: request.projectId,
      telemetryRequestId: request.telemetryRequestId,
      telemetryRetryGroupId: request.telemetryRetryGroupId,
      telemetryRetryAttempt: request.telemetryRetryAttempt,
      maxTokens: request.maxTokens,
      outputEffort: request.outputEffort,
      images: request.images,
    });
    // canned data must satisfy the real contracts schema — keeps fakes honest
    const raw = this.next();
    return { value: schema.parse(raw), usage: this.usage(request), text: JSON.stringify(raw) };
  }

  /**
   * Streamed structured output. The queued response drives the shape:
   * an object is serialized and streamed as valid JSON; a string is streamed
   * verbatim (malformed-JSON cases); `FakeAdapter.truncated(text, reason)`
   * streams a partial body under a truncating finish reason.
   */
  async streamStructured<T>(
    request: CompletionRequest,
    schema: z.ZodType<T>,
    schemaName: string,
    onDelta: (delta: string) => void,
  ): Promise<StructuredResult<T>> {
    this.requests.push({
      system: request.system,
      prompt: request.prompt,
      schemaName,
      initiatedByUserId: request.initiatedByUserId,
      projectId: request.projectId,
      telemetryRequestId: request.telemetryRequestId,
      telemetryRetryGroupId: request.telemetryRetryGroupId,
      telemetryRetryAttempt: request.telemetryRetryAttempt,
      maxTokens: request.maxTokens,
      outputEffort: request.outputEffort,
      images: request.images,
    });
    const queued = this.next();
    const truncation = queued instanceof FakeStructuredStream ? queued : null;
    const text = truncation?.text ?? (typeof queued === "string" ? queued : JSON.stringify(queued));
    const finishReason = truncation?.finishReason ?? "completed";
    // Chunked so callers that scan partial output are exercised across
    // arbitrary token boundaries rather than seeing one whole body.
    for (let index = 0; index < text.length; index += 32) {
      if (request.signal?.aborted) throw new AdapterError("cancelled", "request aborted");
      onDelta(text.slice(index, index + 32));
    }
    const usage = this.usage(request);
    const value = parseStructured(text, schema, schemaName, {
      finish_reason: finishReason,
      usage,
      request_dispatched: true,
    });
    return { value, usage, text, finish_reason: finishReason };
  }

  /** Queue a partial structured body that the provider stopped short. */
  static truncated(text: string, finishReason = "max_tokens"): FakeStructuredStream {
    return new FakeStructuredStream(text, finishReason);
  }

  async streamConversation(
    request: ConversationRequest,
  ): Promise<AsyncIterable<ConversationStreamEvent>> {
    this.requests.push({
      system: request.system,
      prompt: request.messages
        .map((message) =>
          typeof message.content === "string"
            ? message.content
            : message.content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join(""),
        )
        .join("\n"),
      schemaName: null,
      initiatedByUserId: request.initiatedByUserId,
      projectId: request.projectId,
      telemetryRequestId: request.telemetryRequestId,
      telemetryRetryGroupId: request.telemetryRetryGroupId,
      telemetryRetryAttempt: request.telemetryRetryAttempt,
      maxTokens: request.maxTokens,
      images: request.messages.flatMap((message) =>
        typeof message.content === "string"
          ? []
          : message.content.filter((part): part is ImagePart => part.type === "image"),
      ),
      messages: request.messages,
    });
    const value = String(this.next());
    const adapter = this;
    const providerExecutionId = `fake-${adapter.provider}-response-${++FakeAdapter.conversationSequence}`;
    return (async function* fakeConversationStream() {
      if (request.signal?.aborted) {
        throw new AdapterError("cancelled", "request aborted");
      }
      yield {
        type: "response_started",
        provider_execution_id: providerExecutionId,
      };
      if (value.length > 0) yield { type: "text_delta", delta: value };
      if (request.signal?.aborted) {
        throw new AdapterError("cancelled", "request aborted");
      }
      yield {
        type: "finish",
        result: {
          text: value,
          usage: adapter.usage(request),
          provider_execution_id: providerExecutionId,
          finish_reason: "completed",
          latency_ms: 0,
        },
      };
    })();
  }
}
