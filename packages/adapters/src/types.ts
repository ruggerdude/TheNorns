// The LLM adapter interface (ADR-001): business logic never touches provider
// SDKs directly. Both providers pass the same conformance suite.
import type { UsageEventT } from "@norns/contracts";
import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

export type ProviderName = "anthropic" | "openai";

// ---- FRONT DOOR P4: multi-part message content ---------------------------
// Provider-neutral message content. A message's user content is either a plain
// string (the historical, unchanged form) or an ordered array of parts. Only
// the two part kinds below exist; adapters render `image` parts to each
// provider's native image encoding (Anthropic base64 source blocks, OpenAI
// data-URI image_url). This shape is the PM-signed contract addition in the
// FRONT DOOR design freeze (docs/phases/FRONTDOOR-PROGRAM.md §D3) — nothing
// beyond it. Callers that keep passing a string `prompt` are unaffected.

/** The image formats accepted end-to-end (matches the attachments caps). */
export type ImageMime = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export interface TextPart {
  type: "text";
  text: string;
}

export interface ImagePart {
  type: "image";
  mime: ImageMime;
  /** Raw base64 payload (no `data:` prefix). */
  base64: string;
}

export type MessagePart = TextPart | ImagePart;

/** Either the legacy plain string or the new ordered part array. */
export type MessageContent = string | readonly MessagePart[];

/** Per-request image cap (cost control), enforced by both adapters. */
export const MAX_IMAGE_PARTS_PER_REQUEST = 8;

/** Stable attribution copied into debate usage and execution records by the caller. */
export interface CompletionAttribution {
  projectId: string;
  nodeId?: string | null | undefined;
  runId?: string | null | undefined;
  debateId?: string | null | undefined;
  debateRunId?: string | null | undefined;
  debateTurnId?: string | null | undefined;
  debateTurnAttemptId?: string | null | undefined;
}

export interface CompletionRequest extends CompletionAttribution {
  system?: string;
  prompt: string;
  maxTokens?: number;
  signal?: AbortSignal;
  /** The caller already appended structuredOutputInstruction verbatim. */
  structuredOutputPrepared?: boolean;
  /**
   * FRONT DOOR P4: optional image parts attached to the user message. When
   * absent (the default for every legacy caller) the user message is exactly
   * `prompt` and the wire request is byte-identical to before. When present,
   * the adapter sends multi-part content: the `prompt` text followed by these
   * images. Capped at MAX_IMAGE_PARTS_PER_REQUEST.
   */
  images?: readonly ImagePart[];
}

export function prepareStructuredOutputPrompt<T>(
  prompt: string,
  schema: z.ZodType<T>,
  schemaName: string,
): string {
  return `${prompt}\n\n${structuredOutputInstruction(schema, schemaName)}`;
}

/** Provider-neutral metadata retained when the upstream API exposes it. */
export interface ProviderCompletionMetadata {
  provider_execution_id?: string;
  finish_reason?: string;
  /** Wall-clock latency observed by the adapter, when a provider response arrived. */
  latency_ms?: number;
}

/**
 * Evidence retained when a provider accepted a request but its response cannot
 * be used.  This is intentionally distinct from transport failures: callers
 * can settle the known usage instead of conservatively treating a malformed
 * response as an ambiguous execution.
 */
export interface AdapterFailureMetadata extends ProviderCompletionMetadata {
  usage?: UsageEventT;
  /** True only after the provider has returned a response to this request. */
  request_dispatched?: boolean;
}

export interface CompletionResult extends ProviderCompletionMetadata {
  text: string;
  usage: UsageEventT;
}

export interface StructuredResult<T> extends ProviderCompletionMetadata {
  value: T;
  usage: UsageEventT;
}

export interface LlmAdapter {
  readonly provider: ProviderName;
  readonly model: string;
  complete(request: CompletionRequest): Promise<CompletionResult>;
  completeStructured<T>(
    request: CompletionRequest,
    schema: z.ZodType<T>,
    schemaName: string,
  ): Promise<StructuredResult<T>>;
}

/** Provider-neutral full schema instruction used when native schema mode is unavailable. */
export function structuredOutputInstruction<T>(schema: z.ZodType<T>, schemaName: string): string {
  const jsonSchema = zodToJsonSchema(schema, {
    name: schemaName,
    $refStrategy: "none",
  });
  return [
    `Respond with ONLY one JSON object matching the JSON Schema named "${schemaName}".`,
    "Do not add prose, Markdown, or code fences.",
    `JSON Schema:\n${JSON.stringify(jsonSchema)}`,
  ].join("\n");
}

// Failure taxonomy (Phase 2 exit): every provider error maps to one kind, so
// engine retry policy never inspects provider-specific error classes.
export type AdapterErrorKind =
  | "rate_limit"
  | "auth"
  | "invalid_request"
  | "overloaded"
  | "server"
  | "network"
  | "cancelled"
  | "invalid_response";

const RETRYABLE: ReadonlySet<AdapterErrorKind> = new Set([
  "rate_limit",
  "overloaded",
  "server",
  "network",
]);

export class AdapterError extends Error {
  readonly kind: AdapterErrorKind;
  readonly retryable: boolean;
  readonly metadata: AdapterFailureMetadata | undefined;

  constructor(
    kind: AdapterErrorKind,
    message: string,
    options?: { cause?: unknown; metadata?: AdapterFailureMetadata },
  ) {
    super(message, options);
    this.name = "AdapterError";
    this.kind = kind;
    this.retryable = RETRYABLE.has(kind);
    this.metadata = options?.metadata;
  }
}

/**
 * FRONT DOOR P4: validate the per-request image cap once, in provider-neutral
 * code, so both adapters reject an oversized request identically (invalid_request,
 * non-retryable). Returns the parts unchanged (empty array when none).
 */
export function boundedImageParts(images: readonly ImagePart[] | undefined): readonly ImagePart[] {
  const parts = images ?? [];
  if (parts.length > MAX_IMAGE_PARTS_PER_REQUEST) {
    throw new AdapterError(
      "invalid_request",
      `too many image parts: ${parts.length} exceeds the per-request cap of ${MAX_IMAGE_PARTS_PER_REQUEST}`,
    );
  }
  return parts;
}

/** Shared status-code mapping for both providers' HTTP errors. */
export function kindForStatus(status: number): AdapterErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
  if (status === 529) return "overloaded";
  if (status >= 500) return "server";
  return "invalid_request";
}
