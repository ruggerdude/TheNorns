// EXECUTION E9 — the only four things the gateway reads out of a request body.
//
// READ THIS BEFORE ADDING A FIFTH. The gateway forwards the request body
// VERBATIM: the exact bytes the SDK produced are the exact bytes the provider
// receives. Unknown fields, new parameters, tool definitions, beta features and
// model behaviours nobody here has heard of all work precisely because nothing
// in this file rewrites anything. What it does is INSPECT — a read-only peek at
// four values that authorization and budgeting cannot proceed without:
//
//   1. `model`             — the allowlist and the price table are keyed on it
//   2. declared max output — the only ceiling on what a single call can cost
//   3. `stream`            — how the response has to be handled downstream
//   4. the body's size     — the pre-call input-token estimate
//
// If a body cannot be inspected (not JSON, no model), the gateway REFUSES
// rather than forwarding an uncosted call. That is the one place a forwarder is
// allowed to be opinionated, because an unpriceable call is exactly what the
// human decided must never happen.
import { MAX_INFERENCE_OUTPUT_TOKENS } from "@norns/contracts";
import type { GatewayProvider } from "./usage.js";

export interface InspectedGatewayRequest {
  model: string;
  /** What the caller declared it may generate — the hold's output ceiling. */
  maxOutputTokens: number;
  /** True when the caller asked for SSE. */
  streaming: boolean;
  /** Conservative pre-call input-token estimate. Never an actual count. */
  estimatedInputTokens: number;
  /** True when the caller declared no output ceiling and we substituted one. */
  outputCeilingSubstituted: boolean;
}

export type GatewayInspectionFailure = "unparseable_body" | "missing_model";

export type GatewayInspection =
  | { ok: true; request: InspectedGatewayRequest }
  | { ok: false; reason: GatewayInspectionFailure };

/**
 * Conservative input-token estimate from raw request bytes.
 *
 * WHY BYTES AND NOT A TOKENIZER. Running the real tokenizer would mean holding
 * a per-model vocabulary for every model the allowlist might ever name,
 * including ones released after this code was written — precisely the coupling
 * a forwarder exists to avoid. So: three bytes per token, plus a fixed
 * thousand-token floor for the system prompt and tool schemas an SDK adds.
 *
 * THREE, NOT FOUR. The usual rule of thumb is four characters per token, which
 * is right for English prose and wrong in the dangerous direction for dense
 * CJK, where a byte-per-token ratio near 3 is common (UTF-8 spends three bytes
 * on a CJK codepoint and the tokenizer often spends one token on it). Choosing
 * 3 makes the estimate an over-estimate for prose, code, and base64 image
 * payloads, and roughly break-even for the worst case. Over-estimating only
 * ever refuses early; under-estimating spends money a human did not approve.
 * The residual overshoot is analysed in the E9 report.
 */
export function estimateGatewayInputTokens(bodyBytes: number): number {
  return Math.max(1, Math.ceil(bodyBytes / 3) + 1_000);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * Peek at a request body without consuming, normalizing, or re-serializing it.
 *
 * @param provider which surface the body was posted to — decides only WHICH
 *   field names name the output ceiling, never what is forwarded.
 */
export function inspectGatewayRequest(
  provider: GatewayProvider,
  body: Uint8Array,
): GatewayInspection {
  let parsed: Record<string, unknown> | null;
  try {
    parsed = asRecord(JSON.parse(new TextDecoder("utf-8").decode(body)));
  } catch {
    return { ok: false, reason: "unparseable_body" };
  }
  if (!parsed) return { ok: false, reason: "unparseable_body" };

  const model = parsed.model;
  if (typeof model !== "string" || model.trim().length === 0) {
    return { ok: false, reason: "missing_model" };
  }

  // Anthropic Messages requires `max_tokens`. OpenAI Responses treats
  // `max_output_tokens` as optional, so a Codex request routinely declares no
  // ceiling at all — which would make the hold unbounded. Substituting the
  // proxy's own hard ceiling is what keeps a single call's cost finite; the
  // request itself is still forwarded exactly as written, so the provider is
  // free to generate more and the run's ledger records what it actually cost.
  const declared =
    provider === "anthropic"
      ? positiveInt(parsed.max_tokens)
      : (positiveInt(parsed.max_output_tokens) ?? positiveInt(parsed.max_tokens));

  return {
    ok: true,
    request: {
      model,
      maxOutputTokens: declared ?? MAX_INFERENCE_OUTPUT_TOKENS,
      outputCeilingSubstituted: declared === null,
      streaming: parsed.stream === true,
      estimatedInputTokens: estimateGatewayInputTokens(body.byteLength),
    },
  };
}
