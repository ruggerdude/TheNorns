// Model registry (PRD: concrete model ids and pricing live in configuration,
// not in documents). Prices are USD per million tokens; pricing_version pins
// which table produced an estimate so the ledger can reconcile later.
import { UsageEvent, type UsageEventT, type UsageSourceT } from "@norns/contracts";
import type { ProviderName } from "./types.js";

export interface ModelEntry {
  provider: ProviderName;
  input_per_mtok: number;
  output_per_mtok: number;
  pricing_version: string;
  /** true when pricing is a config guess rather than a published rate */
  pricing_is_estimate: boolean;
}

export const DEFAULT_MODEL_REGISTRY: Record<string, ModelEntry> = {
  // Anthropic published rates (2026-07 price table)
  "claude-fable-5": {
    provider: "anthropic",
    input_per_mtok: 10,
    output_per_mtok: 50,
    pricing_version: "anthropic-2026-07",
    pricing_is_estimate: false,
  },
  "claude-opus-4-8": {
    provider: "anthropic",
    input_per_mtok: 5,
    output_per_mtok: 25,
    pricing_version: "anthropic-2026-07",
    pricing_is_estimate: false,
  },
  "claude-sonnet-5": {
    provider: "anthropic",
    input_per_mtok: 2,
    output_per_mtok: 10,
    pricing_version: "anthropic-2026-07-intro",
    pricing_is_estimate: false,
  },
  "claude-haiku-4-5-20251001": {
    provider: "anthropic",
    input_per_mtok: 1,
    output_per_mtok: 5,
    pricing_version: "anthropic-2026-07",
    pricing_is_estimate: false,
  },
  "claude-haiku-4-5": {
    provider: "anthropic",
    input_per_mtok: 1,
    output_per_mtok: 5,
    pricing_version: "anthropic-2026-07",
    pricing_is_estimate: false,
  },
  // OpenAI published rates (2026-07 price table)
  "gpt-5.6-sol": {
    provider: "openai",
    input_per_mtok: 5,
    output_per_mtok: 30,
    pricing_version: "openai-2026-07",
    pricing_is_estimate: false,
  },
  "gpt-5.6-terra": {
    provider: "openai",
    input_per_mtok: 2.5,
    output_per_mtok: 15,
    pricing_version: "openai-2026-07",
    pricing_is_estimate: false,
  },
  "gpt-5.6-luna": {
    provider: "openai",
    input_per_mtok: 1,
    output_per_mtok: 6,
    pricing_version: "openai-2026-07",
    pricing_is_estimate: false,
  },
  // Backward-compatible deployment placeholder.
  "openai-reasoning-default": {
    provider: "openai",
    input_per_mtok: 10,
    output_per_mtok: 40,
    pricing_version: "openai-config-placeholder",
    pricing_is_estimate: true,
  },
  // conformance-suite models (mock provider)
  "mock-anthropic": {
    provider: "anthropic",
    input_per_mtok: 2,
    output_per_mtok: 10,
    pricing_version: "mock-1",
    pricing_is_estimate: true,
  },
  "mock-openai": {
    provider: "openai",
    input_per_mtok: 2,
    output_per_mtok: 10,
    pricing_version: "mock-1",
    pricing_is_estimate: true,
  },
};

export function estimateCostUsd(
  entry: ModelEntry,
  inputTokens: number,
  outputTokens: number,
): number {
  return (
    (inputTokens / 1_000_000) * entry.input_per_mtok +
    (outputTokens / 1_000_000) * entry.output_per_mtok
  );
}

export interface UsageAttribution {
  projectId: string;
  nodeId?: string | null | undefined;
  runId?: string | null | undefined;
}

let usageCounter = 0;

/** Normalize provider-reported token counts into a ledger-ready UsageEvent. */
export function makeUsageEvent(
  model: string,
  registry: Record<string, ModelEntry>,
  attribution: UsageAttribution,
  inputTokens: number,
  outputTokens: number,
  source: UsageSourceT,
): UsageEventT {
  const entry = registry[model];
  if (!entry) throw new Error(`model ${model} not in registry`);
  usageCounter += 1;
  return UsageEvent.parse({
    id: `use_${Date.now()}_${usageCounter}`,
    provider: entry.provider,
    model,
    project_id: attribution.projectId,
    node_id: attribution.nodeId ?? null,
    run_id: attribution.runId ?? null,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    estimated_cost_usd: estimateCostUsd(entry, inputTokens, outputTokens),
    actual_cost_usd: null, // reconciled post-hoc where the provider exposes it
    usage_source: source,
    pricing_version: entry.pricing_version,
    occurred_at: new Date().toISOString(),
  });
}
