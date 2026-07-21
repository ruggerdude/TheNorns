// EXECUTION E3 — proxied model inference over the runner relay.
//
// WHY THIS EXISTS: a runner executing in a GitHub Actions job has no provider
// credentials, and there is no safe way to give it any. Putting an Anthropic or
// OpenAI key in a repository secret hands the raw key to every workflow in that
// repository, to anyone who can open a pull request that runs one, and to the
// CI logs of a machine Norns does not control. The human's decision is that
// Norns proxies the calls instead: the key stays on the server, never enters a
// repository, and every call is metered before it is made.
//
// This file is STRICTLY ADDITIVE. It introduces new types only; no existing
// frame, envelope, or enum member changes meaning. A runner that never sends an
// inference_request is bit-for-bit unaffected, and a server that never receives
// one behaves exactly as before.
//
// ---------------------------------------------------------------------------
// ON STREAMING — deliberately absent, and here is the honest reason.
//
// Streaming is not blocked by the relay: adding an `inference_chunk` frame
// would be easy. It is blocked one layer down. The proxy is required to call
// providers through the existing `packages/adapters` (`AnthropicAdapter` /
// `OpenAiAdapter`), and `LlmAdapter` exposes exactly two operations, both of
// which return a COMPLETE result: `complete()` and `completeStructured()`.
// There is no token-level surface to forward. Streaming the relay would
// therefore mean either adding a streaming path to the adapters (a change to a
// package E3 does not own, affecting every existing caller) or opening a second
// provider client (explicitly forbidden — it is how key handling fragments).
//
// So: complete responses only. A caller sees one request and one response.
// `max_tokens` and the run's remaining budget bound how long that takes. If
// streaming becomes a product requirement, the change is additive in both
// places — a chunk frame here and a streaming method on LlmAdapter — and
// nothing in this file has to change shape to allow it.
// ---------------------------------------------------------------------------
import { z } from "zod";
import { Provider } from "./usage.js";

const nonEmpty = z.string().min(1);
/** Same opaque-handle grammar the workspace side channel uses. */
const opaqueId = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._:-]+$/);

/** Hard ceiling on a single proxied prompt, before any budget check. */
export const MAX_INFERENCE_PROMPT_CHARS = 600_000;
/** Hard ceiling on requested output, independent of the model's own limit. */
export const MAX_INFERENCE_OUTPUT_TOKENS = 32_000;

/**
 * Runner -> server: "call this model for me."
 *
 * NOTE WHAT IS NOT HERE: no project_id, no budget, no credential, no base URL.
 * The runner does not get to say which project it is spending, because a
 * compromised job would simply say a different one. It names only the run it
 * claims to be executing; the server resolves that run to a project, task and
 * budget from its own records, and refuses if the authenticated runner identity
 * is not the one that run was dispatched to. Everything that costs money is
 * derived server-side from data the runner cannot influence.
 *
 * `system` + `prompt` + `max_tokens` rather than a general message array
 * because that is precisely the surface `LlmAdapter.complete` exposes. A richer
 * shape here would be a promise the proxy could not keep.
 */
export const RunnerInferenceRequest = z
  .object({
    request_id: opaqueId,
    /** The run this call belongs to. Verified, not trusted. */
    run_id: nonEmpty,
    /** The task the runner believes it is working. Cross-checked, not trusted. */
    task_id: nonEmpty,
    provider: Provider,
    model: nonEmpty,
    system: z.string().max(MAX_INFERENCE_PROMPT_CHARS).optional(),
    prompt: z.string().min(1).max(MAX_INFERENCE_PROMPT_CHARS),
    max_tokens: z.number().int().positive().max(MAX_INFERENCE_OUTPUT_TOKENS),
  })
  .strict();
export type RunnerInferenceRequestT = z.infer<typeof RunnerInferenceRequest>;

/**
 * Typed refusals. Every one is a deliberate server decision, distinguishable by
 * the runner without parsing prose, and none of them leaks why beyond the
 * category — an authorization failure must not tell a compromised job whether
 * the run exists, whether it belongs to someone else, or which check tripped.
 */
export const InferenceErrorCode = z.enum([
  /** The runner is not the one this run was dispatched to, or is superseded. */
  "unauthorized",
  /** The run exists but is not in a state that may spend (finished, cancelled). */
  "run_not_active",
  /** Refused BEFORE calling the provider: the budget cannot cover this call. */
  "budget_exhausted",
  /** The model is not configured, not permitted, or has no pricing. */
  "model_unavailable",
  /** Well-formed but unacceptable (oversized prompt, unknown task for the run). */
  "invalid_request",
  /** The provider rate-limited us. Retryable. */
  "rate_limited",
  /** The provider failed. Retryable per the adapter's taxonomy. */
  "provider_error",
  /** The proxy is not enabled on this deployment. */
  "unsupported",
]);
export type InferenceErrorCodeT = z.infer<typeof InferenceErrorCode>;

/** Retry guidance the runner can act on without knowing provider specifics. */
export const RETRYABLE_INFERENCE_ERRORS: ReadonlySet<InferenceErrorCodeT> = new Set([
  "rate_limited",
  "provider_error",
]);

/** Token counts as the provider reported them, echoed for runner-side logging. */
export const InferenceUsage = z
  .object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
  })
  .strict();
export type InferenceUsageT = z.infer<typeof InferenceUsage>;

/**
 * Server -> runner. Discriminated on `status` so a runner cannot mistake a
 * refusal for an empty completion — the failure mode that would let a budget
 * stop look like a model that had nothing to say.
 */
export const RunnerInferenceResponse = z.discriminatedUnion("status", [
  z
    .object({
      request_id: opaqueId,
      status: z.literal("ok"),
      provider: Provider,
      model: nonEmpty,
      text: z.string(),
      usage: InferenceUsage,
      finish_reason: z.string().optional(),
    })
    .strict(),
  z
    .object({
      request_id: opaqueId,
      status: z.literal("error"),
      code: InferenceErrorCode,
      /** Safe for a CI log: category-level, never provider or key detail. */
      message: z.string().max(500),
    })
    .strict(),
]);
export type RunnerInferenceResponseT = z.infer<typeof RunnerInferenceResponse>;
