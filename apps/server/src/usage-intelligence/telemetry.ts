import {
  AdapterError,
  type CompletionAttribution,
  type CompletionRequest,
  type CompletionResult,
  type ConversationRequest,
  type ConversationStreamEvent,
  type LlmAdapter,
  type StructuredResult,
} from "@norns/adapters";
import type {
  AiCostClassificationT,
  AiUsageLifecycleEventInputT,
  AiUsageSourceT,
  UsageEventT,
} from "@norns/contracts";
import type { z } from "zod";
import { newId } from "../ids.js";
import type { AiUsageTelemetryRepository } from "../persistence/v2/aiUsageTelemetry.js";

export interface AiInvocationScope {
  initiatedByUserId?: string | null;
  projectId?: string | null;
  phaseId?: string | null;
  taskId?: string | null;
  runId?: string | null;
}

export interface AiInvocationStart extends AiInvocationScope {
  requestId?: string;
  provider: string;
  model: string;
  endpoint: string;
  requestType: string;
  retryGroupId?: string | null;
  retryAttempt?: number;
}

export interface AiUsageObservation {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
  costClassification: AiCostClassificationT;
  usageSource: AiUsageSourceT;
  confidence: number;
  pricingVersion?: string | null | undefined;
  providerRequestId?: string | null | undefined;
}

export interface AiInvocationTerminal {
  latencyMs?: number | null;
  httpStatus?: number | null;
  providerRequestId?: string | null | undefined;
}

export interface AiInvocationFailure extends AiInvocationTerminal {
  code: string;
  category: string;
  messageRedacted: string;
  sanitized?: Record<string, unknown> | null;
}

export interface AiInvocationTrace {
  readonly requestId: string;
  observe(input: AiUsageObservation): Promise<void>;
  complete(input?: AiInvocationTerminal): Promise<void>;
  fail(input: AiInvocationFailure): Promise<void>;
}

export interface AiTelemetryHealth {
  status: "healthy" | "degraded";
  pendingEvents: number;
  droppedEvents: number;
  lastFailureAt: string | null;
  lastRecoveryAt: string | null;
}

export interface AiInvocationTelemetryOptions {
  maxPendingEvents?: number;
  maxRetryAttempts?: number;
  retryBaseDelayMs?: number;
  onHealthChange?: (health: AiTelemetryHealth) => void;
}

interface PendingTelemetryEvent {
  event: AiUsageLifecycleEventInputT;
  stableEventId: string;
  attempts: number;
}

/**
 * Best-effort production bridge into the canonical ledger.
 *
 * Telemetry must never replace a successful provider response with a failure,
 * so persistence errors are isolated here. Once the start row exists, every
 * later write remains retry-safe through deterministic event ids.
 */
export class AiInvocationTelemetry {
  private readonly maxPendingEvents: number;
  private readonly maxRetryAttempts: number;
  private readonly retryBaseDelayMs: number;
  private readonly onHealthChange: (health: AiTelemetryHealth) => void;
  private readonly pending: PendingTelemetryEvent[] = [];
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private reconciliation: Promise<number> | null = null;
  private droppedEvents = 0;
  private lastFailureAt: string | null = null;
  private lastRecoveryAt: string | null = null;
  private lastEmittedStatus: AiTelemetryHealth["status"] = "healthy";

  constructor(
    private readonly repository: AiUsageTelemetryRepository,
    private readonly now: () => Date = () => new Date(),
    options: AiInvocationTelemetryOptions = {},
  ) {
    this.maxPendingEvents = options.maxPendingEvents ?? 1_000;
    this.maxRetryAttempts = options.maxRetryAttempts ?? 5;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 250;
    if (!Number.isSafeInteger(this.maxPendingEvents) || this.maxPendingEvents <= 0) {
      throw new Error("maxPendingEvents must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.maxRetryAttempts) || this.maxRetryAttempts <= 0) {
      throw new Error("maxRetryAttempts must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.retryBaseDelayMs) || this.retryBaseDelayMs <= 0) {
      throw new Error("retryBaseDelayMs must be a positive safe integer");
    }
    this.onHealthChange =
      options.onHealthChange ??
      ((health) => {
        if (health.status === "degraded") {
          console.error(
            `AI telemetry degraded: pending=${health.pendingEvents} dropped=${health.droppedEvents}`,
          );
        } else {
          console.info("AI telemetry recovered");
        }
      });
  }

  health(): AiTelemetryHealth {
    return {
      status: this.pending.length > 0 || this.droppedEvents > 0 ? "degraded" : "healthy",
      pendingEvents: this.pending.length,
      droppedEvents: this.droppedEvents,
      lastFailureAt: this.lastFailureAt,
      lastRecoveryAt: this.lastRecoveryAt,
    };
  }

  /**
   * Retry queued events in lifecycle order. Stable ids make this safe after an
   * ambiguous commit. The queue is bounded; a total database outage can still
   * exhaust it, which is surfaced through droppedEvents and never hidden.
   */
  reconcile(): Promise<number> {
    if (this.reconciliation) return this.reconciliation;
    this.reconciliation = this.drain().finally(() => {
      this.reconciliation = null;
    });
    return this.reconciliation;
  }

  async start(input: AiInvocationStart): Promise<AiInvocationTrace> {
    const requestId = input.requestId ?? newId("ai_request");
    const scope = {
      initiated_by_user_id: input.initiatedByUserId ?? null,
      project_id: input.projectId ?? null,
      phase_id: input.phaseId ?? null,
      task_id: input.taskId ?? null,
      run_id: input.runId ?? null,
    };
    const identity = {
      request_id: requestId,
      provider: input.provider,
      model: input.model,
      endpoint: input.endpoint,
      request_type: input.requestType,
      retry_group_id: input.retryGroupId ?? null,
      retry_attempt: input.retryAttempt ?? 0,
      ...scope,
    };
    const startedAt = this.now();
    await this.appendWithRecovery(
      {
        ...identity,
        event_type: "request_started",
        status: "started",
        occurred_at: startedAt.toISOString(),
        provider_request_id: null,
        usage_source: "unavailable",
        confidence: 0,
        pricing_profile_id: null,
        input_tokens: null,
        output_tokens: null,
        cache_read_tokens: null,
        cache_write_tokens: null,
        cost_usd: null,
        cost_classification: "unavailable",
        latency_ms: null,
        http_status: null,
        error_code: null,
        error_category: null,
        error_message_redacted: null,
        sanitized_error: null,
        adjusts_event_id: null,
      },
      `${requestId}:started`,
    );

    let eventOrdinal = 0;
    let lastOccurredAt = startedAt.getTime();
    const occurredAt = (): string => {
      lastOccurredAt = Math.max(lastOccurredAt, this.now().getTime());
      return new Date(lastOccurredAt).toISOString();
    };
    const append = async (
      event: Omit<
        AiUsageLifecycleEventInputT,
        | "request_id"
        | "provider"
        | "model"
        | "endpoint"
        | "request_type"
        | "retry_group_id"
        | "retry_attempt"
        | "initiated_by_user_id"
        | "project_id"
        | "phase_id"
        | "task_id"
        | "run_id"
      >,
      suffix: string,
    ): Promise<void> => {
      eventOrdinal += 1;
      await this.appendWithRecovery(
        { ...identity, ...event },
        `${requestId}:${eventOrdinal}:${suffix}`,
      );
    };

    return {
      requestId,
      observe: async (usage) => {
        const eventOccurredAt = occurredAt();
        const pricingProfileId = await this.effectivePricingProfileId(
          input.provider,
          input.model,
          eventOccurredAt,
          usage.pricingVersion,
        );
        await append(
          {
            event_type: "usage_observed",
            status: "in_progress",
            occurred_at: eventOccurredAt,
            provider_request_id: usage.providerRequestId ?? null,
            usage_source: usage.usageSource,
            confidence: usage.confidence,
            pricing_profile_id: pricingProfileId,
            input_tokens: usage.inputTokens,
            output_tokens: usage.outputTokens,
            cache_read_tokens: usage.cacheReadTokens,
            cache_write_tokens: usage.cacheWriteTokens,
            cost_usd: usage.costUsd,
            cost_classification: usage.costClassification,
            latency_ms: null,
            http_status: null,
            error_code: null,
            error_category: null,
            error_message_redacted: null,
            sanitized_error: null,
            adjusts_event_id: null,
          },
          "usage",
        );
      },
      complete: (terminal = {}) =>
        append(
          {
            event_type: "request_completed",
            status: "succeeded",
            occurred_at: occurredAt(),
            provider_request_id: terminal.providerRequestId ?? null,
            usage_source: "unavailable",
            confidence: 0,
            pricing_profile_id: null,
            input_tokens: null,
            output_tokens: null,
            cache_read_tokens: null,
            cache_write_tokens: null,
            cost_usd: null,
            cost_classification: "unavailable",
            latency_ms: terminal.latencyMs ?? null,
            http_status: terminal.httpStatus ?? null,
            error_code: null,
            error_category: null,
            error_message_redacted: null,
            sanitized_error: null,
            adjusts_event_id: null,
          },
          "completed",
        ),
      fail: (failure) =>
        append(
          {
            event_type: "request_failed",
            status: "failed",
            occurred_at: occurredAt(),
            provider_request_id: failure.providerRequestId ?? null,
            usage_source: "unavailable",
            confidence: 0,
            pricing_profile_id: null,
            input_tokens: null,
            output_tokens: null,
            cache_read_tokens: null,
            cache_write_tokens: null,
            cost_usd: null,
            cost_classification: "unavailable",
            latency_ms: failure.latencyMs ?? null,
            http_status: failure.httpStatus ?? null,
            error_code: failure.code,
            error_category: failure.category,
            error_message_redacted: failure.messageRedacted,
            sanitized_error: failure.sanitized ?? null,
            adjusts_event_id: null,
          },
          "failed",
        ),
    };
  }

  wrapAdapter(adapter: LlmAdapter): LlmAdapter {
    return new TelemetryLlmAdapter(adapter, this);
  }

  private async effectivePricingProfileId(
    provider: string,
    model: string,
    occurredAt: string,
    pricingVersion?: string | null,
  ): Promise<string | null> {
    try {
      return (
        (
          await this.repository.findEffectivePricingProfile(
            provider,
            model,
            occurredAt,
            pricingVersion ?? undefined,
          )
        )?.id ?? null
      );
    } catch {
      this.recordFailure();
      return null;
    }
  }

  private async appendWithRecovery(
    event: AiUsageLifecycleEventInputT,
    stableEventId: string,
  ): Promise<void> {
    if (this.pending.length > 0) {
      this.enqueue(event, stableEventId);
      return;
    }
    try {
      await this.repository.appendEvent(event, stableEventId);
      this.recordSuccess();
    } catch {
      this.enqueue(event, stableEventId);
    }
  }

  private enqueue(event: AiUsageLifecycleEventInputT, stableEventId: string): void {
    if (this.pending.some((candidate) => candidate.stableEventId === stableEventId)) return;
    this.recordFailure();
    if (this.pending.length >= this.maxPendingEvents) {
      this.droppedEvents += 1;
      this.emitHealth(true);
      return;
    }
    this.pending.push({ event, stableEventId, attempts: 0 });
    this.emitHealth();
    this.scheduleRetry();
  }

  private async drain(): Promise<number> {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    let recovered = 0;
    while (this.pending.length > 0) {
      const item = this.pending[0];
      if (!item) break;
      try {
        await this.repository.appendEvent(item.event, item.stableEventId);
        this.pending.shift();
        recovered += 1;
        this.recordSuccess();
      } catch {
        item.attempts += 1;
        this.recordFailure();
        if (item.attempts >= this.maxRetryAttempts) {
          this.pending.shift();
          this.droppedEvents += 1;
          this.emitHealth(true);
          continue;
        }
        break;
      }
    }
    if (this.pending.length > 0) this.scheduleRetry();
    else this.emitHealth();
    return recovered;
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.pending.length === 0) return;
    const attempts = this.pending[0]?.attempts ?? 0;
    const delay = Math.min(this.retryBaseDelayMs * 2 ** attempts, 10_000);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.reconcile();
    }, delay);
    this.retryTimer.unref?.();
  }

  private recordFailure(): void {
    this.lastFailureAt = this.now().toISOString();
    this.emitHealth();
  }

  private recordSuccess(): void {
    if (this.pending.length === 0 && this.droppedEvents === 0 && this.lastFailureAt !== null) {
      this.lastRecoveryAt = this.now().toISOString();
    }
    this.emitHealth();
  }

  private emitHealth(force = false): void {
    const health = this.health();
    if (!force && health.status === this.lastEmittedStatus) return;
    this.lastEmittedStatus = health.status;
    try {
      this.onHealthChange(health);
    } catch {
      // Observability hooks are telemetry too: they must not replace a
      // successful provider response with a failure.
    }
  }
}

function endpointFor(provider: string): string {
  return provider === "anthropic" ? "/v1/messages" : "/v1/responses";
}

function observation(usage: UsageEventT, providerRequestId?: string): AiUsageObservation {
  const actual = usage.actual_cost_usd;
  const cacheCategoriesObserved =
    usage.cache_read_tokens !== undefined && usage.cache_write_tokens !== undefined;
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_tokens ?? 0,
    cacheWriteTokens: usage.cache_write_tokens ?? 0,
    costUsd: actual ?? usage.estimated_cost_usd,
    costClassification: actual === null ? "estimated" : "actual",
    usageSource: usage.usage_source,
    confidence: usage.usage_source === "provider_api" ? (cacheCategoriesObserved ? 1 : 0.8) : 0.5,
    pricingVersion: usage.pricing_version,
    providerRequestId,
  };
}

function scope(request: CompletionAttribution): AiInvocationScope {
  return {
    initiatedByUserId: request.initiatedByUserId ?? null,
    projectId: request.projectId,
    phaseId: request.phaseId ?? null,
    taskId: request.taskId ?? request.nodeId ?? null,
    runId: request.runId ?? null,
  };
}

class TelemetryLlmAdapter implements LlmAdapter {
  readonly provider;
  readonly model;

  constructor(
    private readonly adapter: LlmAdapter,
    private readonly telemetry: AiInvocationTelemetry,
  ) {
    this.provider = adapter.provider;
    this.model = adapter.model;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    return this.invoke(request, "completion", () => this.adapter.complete(request));
  }

  async completeStructured<T>(
    request: CompletionRequest,
    schema: z.ZodType<T>,
    schemaName: string,
  ): Promise<StructuredResult<T>> {
    return this.invoke(request, `structured:${schemaName}`, () =>
      this.adapter.completeStructured(request, schema, schemaName),
    );
  }

  /**
   * Streamed structured output is the same provider call as
   * `completeStructured` — same request type, same usage, same latency
   * accounting — so it goes through the same instrumented path. Only the
   * delta callback differs.
   */
  async streamStructured<T>(
    request: CompletionRequest,
    schema: z.ZodType<T>,
    schemaName: string,
    onDelta: (delta: string) => void,
  ): Promise<StructuredResult<T>> {
    return this.invoke(request, `structured:${schemaName}`, () =>
      // An adapter without streaming support still returns the same result;
      // the caller simply sees no progress deltas.
      this.adapter.streamStructured
        ? this.adapter.streamStructured(request, schema, schemaName, onDelta)
        : this.adapter.completeStructured(request, schema, schemaName),
    );
  }

  async streamConversation(
    request: ConversationRequest,
  ): Promise<AsyncIterable<ConversationStreamEvent>> {
    const startedAt = Date.now();
    const trace = await this.telemetry.start({
      ...(request.telemetryRequestId ? { requestId: request.telemetryRequestId } : {}),
      provider: this.provider,
      model: this.model,
      endpoint: endpointFor(this.provider),
      requestType: "conversation_turn",
      retryGroupId: request.telemetryRetryGroupId ?? null,
      retryAttempt: request.telemetryRetryAttempt ?? 0,
      ...scope(request),
    });
    const adapter = this.adapter;
    return (async function* meteredConversationStream() {
      let terminal = false;
      let failed = false;
      try {
        if (!adapter.streamConversation) {
          throw new AdapterError(
            "invalid_request",
            "adapter does not support streaming conversations",
          );
        }
        const stream = await adapter.streamConversation(request);
        for await (const event of stream) {
          if (event.type === "finish") {
            await trace.observe(
              observation(event.result.usage, event.result.provider_execution_id),
            );
            await trace.complete({
              latencyMs: event.result.latency_ms ?? Math.max(0, Date.now() - startedAt),
              providerRequestId: event.result.provider_execution_id,
            });
            terminal = true;
          }
          yield event;
        }
        if (!terminal) {
          throw new AdapterError(
            "invalid_response",
            "provider stream ended without terminal usage",
          );
        }
      } catch (error) {
        failed = true;
        const adapterError = error instanceof AdapterError ? error : null;
        const metadata = adapterError?.metadata;
        if (metadata?.usage) {
          await trace.observe(observation(metadata.usage, metadata.provider_execution_id));
        }
        await trace.fail({
          code: adapterError?.kind ?? "unexpected",
          category: adapterError ? "adapter_error" : "unexpected_error",
          messageRedacted: adapterError
            ? `provider stream failed (${adapterError.kind})`
            : "provider stream failed unexpectedly",
          latencyMs: metadata?.latency_ms ?? Math.max(0, Date.now() - startedAt),
          providerRequestId: metadata?.provider_execution_id,
          sanitized: adapterError
            ? {
                retryable: adapterError.retryable,
                request_dispatched: metadata?.request_dispatched ?? null,
              }
            : null,
        });
        throw error;
      } finally {
        if (!terminal && !failed) {
          await trace.fail({
            code: "cancelled",
            category: "adapter_error",
            messageRedacted: "provider stream cancelled",
            latencyMs: Math.max(0, Date.now() - startedAt),
            sanitized: { retryable: false, request_dispatched: null },
          });
        }
      }
    })();
  }

  private async invoke<T extends CompletionResult | StructuredResult<unknown>>(
    request: CompletionRequest,
    requestType: string,
    call: () => Promise<T>,
  ): Promise<T> {
    const startedAt = Date.now();
    const trace = await this.telemetry.start({
      ...(request.telemetryRequestId ? { requestId: request.telemetryRequestId } : {}),
      provider: this.provider,
      model: this.model,
      endpoint: endpointFor(this.provider),
      requestType,
      retryGroupId: request.telemetryRetryGroupId ?? null,
      retryAttempt: request.telemetryRetryAttempt ?? 0,
      ...scope(request),
    });
    try {
      const result = await call();
      await trace.observe(observation(result.usage, result.provider_execution_id));
      await trace.complete({
        latencyMs: result.latency_ms ?? Math.max(0, Date.now() - startedAt),
        providerRequestId: result.provider_execution_id,
      });
      return result;
    } catch (error) {
      const adapterError = error instanceof AdapterError ? error : null;
      const metadata = adapterError?.metadata;
      if (metadata?.usage) {
        await trace.observe(observation(metadata.usage, metadata.provider_execution_id));
      }
      await trace.fail({
        code: adapterError?.kind ?? "unexpected",
        category: adapterError ? "adapter_error" : "unexpected_error",
        messageRedacted: adapterError
          ? `provider call failed (${adapterError.kind})`
          : "provider call failed unexpectedly",
        latencyMs: metadata?.latency_ms ?? Math.max(0, Date.now() - startedAt),
        providerRequestId: metadata?.provider_execution_id,
        sanitized: adapterError
          ? {
              retryable: adapterError.retryable,
              request_dispatched: metadata?.request_dispatched ?? null,
            }
          : null,
      });
      throw error;
    }
  }
}
