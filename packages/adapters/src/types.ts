// The LLM adapter interface (ADR-001): business logic never touches provider
// SDKs directly. Both providers pass the same conformance suite.
import type { UsageEventT } from "@norns/contracts";
import type { z } from "zod";

export type ProviderName = "anthropic" | "openai";

export interface CompletionRequest {
  system?: string;
  prompt: string;
  maxTokens?: number;
  signal?: AbortSignal;
  /** attribution for the usage ledger */
  projectId: string;
  nodeId?: string | null;
  runId?: string | null;
}

export interface CompletionResult {
  text: string;
  usage: UsageEventT;
}

export interface StructuredResult<T> {
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
