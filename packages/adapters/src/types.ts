// The LLM adapter interface (ADR-001): business logic never touches provider
// SDKs directly. Both providers pass the same conformance suite.
import type { UsageEventT } from "@norns/contracts";
import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

export type ProviderName = "anthropic" | "openai";

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

  constructor(kind: AdapterErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AdapterError";
    this.kind = kind;
    this.retryable = RETRYABLE.has(kind);
  }
}

/** Shared status-code mapping for both providers' HTTP errors. */
export function kindForStatus(status: number): AdapterErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
  if (status === 529) return "overloaded";
  if (status >= 500) return "server";
  return "invalid_request";
}
