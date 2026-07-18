// Model registry (PRD: concrete model ids and pricing live in configuration,
// not in documents). Prices are USD per million tokens; pricing_version pins
// which table produced an estimate so the ledger can reconcile later.
import { UsageEvent, type UsageEventT, type UsageSourceT } from "@norns/contracts";
import type { CompletionAttribution, ProviderName } from "./types.js";

export interface ModelEntry {
  provider: ProviderName;
  /** Human-readable copy; provider/model remains the canonical identity. */
  label: string;
  /** Only selectable entries are exposed by the runtime catalog. */
  selectable: boolean;
  /** Debate turns require provider-neutral schema validation. */
  supports_structured_output: boolean;
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
    label: "Claude Fable 5",
    selectable: true,
    supports_structured_output: true,
    input_per_mtok: 10,
    output_per_mtok: 50,
    pricing_version: "anthropic-2026-07",
    pricing_is_estimate: false,
  },
  "claude-opus-4-8": {
    provider: "anthropic",
    label: "Claude Opus 4.8",
    selectable: true,
    supports_structured_output: true,
    input_per_mtok: 5,
    output_per_mtok: 25,
    pricing_version: "anthropic-2026-07",
    pricing_is_estimate: false,
  },
  "claude-sonnet-5": {
    provider: "anthropic",
    label: "Claude Sonnet 5",
    selectable: true,
    supports_structured_output: true,
    input_per_mtok: 2,
    output_per_mtok: 10,
    pricing_version: "anthropic-2026-07-intro",
    pricing_is_estimate: false,
  },
  "claude-haiku-4-5-20251001": {
    provider: "anthropic",
    label: "Claude Haiku 4.5",
    selectable: true,
    supports_structured_output: true,
    input_per_mtok: 1,
    output_per_mtok: 5,
    pricing_version: "anthropic-2026-07",
    pricing_is_estimate: false,
  },
  "claude-haiku-4-5": {
    provider: "anthropic",
    label: "Claude Haiku 4.5 (alias)",
    selectable: false,
    supports_structured_output: true,
    input_per_mtok: 1,
    output_per_mtok: 5,
    pricing_version: "anthropic-2026-07",
    pricing_is_estimate: false,
  },
  // OpenAI published rates (2026-07 price table)
  "gpt-5.6-sol": {
    provider: "openai",
    label: "GPT-5.6 Sol",
    selectable: true,
    supports_structured_output: true,
    input_per_mtok: 5,
    output_per_mtok: 30,
    pricing_version: "openai-2026-07",
    pricing_is_estimate: false,
  },
  "gpt-5.6-terra": {
    provider: "openai",
    label: "GPT-5.6 Terra",
    selectable: true,
    supports_structured_output: true,
    input_per_mtok: 2.5,
    output_per_mtok: 15,
    pricing_version: "openai-2026-07",
    pricing_is_estimate: false,
  },
  "gpt-5.6-luna": {
    provider: "openai",
    label: "GPT-5.6 Luna",
    selectable: true,
    supports_structured_output: true,
    input_per_mtok: 1,
    output_per_mtok: 6,
    pricing_version: "openai-2026-07",
    pricing_is_estimate: false,
  },
  // Backward-compatible deployment placeholder.
  "openai-reasoning-default": {
    provider: "openai",
    label: "OpenAI deployment default",
    selectable: false,
    supports_structured_output: true,
    input_per_mtok: 10,
    output_per_mtok: 40,
    pricing_version: "openai-config-placeholder",
    pricing_is_estimate: true,
  },
  // conformance-suite models (mock provider)
  "mock-anthropic": {
    provider: "anthropic",
    label: "Mock Anthropic",
    selectable: false,
    supports_structured_output: true,
    input_per_mtok: 2,
    output_per_mtok: 10,
    pricing_version: "mock-1",
    pricing_is_estimate: true,
  },
  "mock-openai": {
    provider: "openai",
    label: "Mock OpenAI",
    selectable: false,
    supports_structured_output: true,
    input_per_mtok: 2,
    output_per_mtok: 10,
    pricing_version: "mock-1",
    pricing_is_estimate: true,
  },
};

export interface ModelSelection {
  provider: ProviderName;
  model: string;
}

/**
 * Availability is supplied by the credential/configuration boundary. Missing
 * pairs are unavailable by default, and a signal for one provider never
 * enables a same-named model at another provider.
 */
export interface ModelAvailabilityInput extends ModelSelection {
  available: boolean;
  reason?: string;
}

export interface ModelPricingSnapshot extends ModelSelection {
  input_per_mtok: number;
  output_per_mtok: number;
  pricing_version: string;
  pricing_is_estimate: boolean;
}

export interface SelectableModelCatalogEntry extends ModelSelection {
  label: string;
  available: boolean;
  unavailable_reason: string | null;
  supports_structured_output: boolean;
  pricing: ModelPricingSnapshot;
}

export interface ActorTokenCaps {
  max_input_tokens: number;
  max_output_tokens: number;
}

export interface ConservativeChargeQuote extends ActorTokenCaps {
  max_charge_usd: number;
  pricing: ModelPricingSnapshot;
}

function selectionKey(provider: ProviderName, model: string): string {
  return `${provider}\u0000${model}`;
}

function requireModelEntry(
  provider: ProviderName,
  model: string,
  registry: Readonly<Record<string, ModelEntry>>,
): ModelEntry {
  const entry = registry[model];
  if (!entry || entry.provider !== provider) {
    throw new Error(`model ${provider}/${model} not in registry`);
  }
  return entry;
}

function assertPrice(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be finite and nonnegative`);
  }
}

/** Freeze the exact price table used for a run/turn reservation. */
export function snapshotModelPricing(
  provider: ProviderName,
  model: string,
  registry: Readonly<Record<string, ModelEntry>> = DEFAULT_MODEL_REGISTRY,
): ModelPricingSnapshot {
  const entry = requireModelEntry(provider, model, registry);
  assertPrice("input_per_mtok", entry.input_per_mtok);
  assertPrice("output_per_mtok", entry.output_per_mtok);
  return Object.freeze({
    provider,
    model,
    input_per_mtok: entry.input_per_mtok,
    output_per_mtok: entry.output_per_mtok,
    pricing_version: entry.pricing_version,
    pricing_is_estimate: entry.pricing_is_estimate,
  });
}

function assertTokenCap(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a nonnegative safe integer`);
  }
}

/**
 * Price both actor caps at once and round upward to the nearest micro-dollar.
 * USD/MTok is numerically equal to micro-USD/token, so this avoids an
 * underestimate from rounding a small per-turn reservation downward.
 */
export function conservativeMaxChargeUsd(
  pricing: ModelPricingSnapshot,
  caps: ActorTokenCaps,
): number {
  assertTokenCap("max_input_tokens", caps.max_input_tokens);
  assertTokenCap("max_output_tokens", caps.max_output_tokens);
  assertPrice("input_per_mtok", pricing.input_per_mtok);
  assertPrice("output_per_mtok", pricing.output_per_mtok);
  const chargeInMicroUsd =
    caps.max_input_tokens * pricing.input_per_mtok +
    caps.max_output_tokens * pricing.output_per_mtok;
  if (!Number.isFinite(chargeInMicroUsd) || chargeInMicroUsd < 0) {
    throw new Error("model pricing must produce a finite nonnegative charge");
  }
  return Math.ceil(chargeInMicroUsd) / 1_000_000;
}

export function quoteConservativeMaxCharge(
  selection: ModelSelection,
  caps: ActorTokenCaps,
  registry: Readonly<Record<string, ModelEntry>> = DEFAULT_MODEL_REGISTRY,
): ConservativeChargeQuote {
  const pricing = snapshotModelPricing(selection.provider, selection.model, registry);
  return {
    ...caps,
    max_charge_usd: conservativeMaxChargeUsd(pricing, caps),
    pricing,
  };
}

/**
 * Produce the browser-safe selectable catalog. Registry-only aliases, mocks,
 * and deployment placeholders stay hidden. Estimated pricing and missing
 * structured-output support fail closed even if availability says true.
 */
export function buildSelectableModelCatalog(
  availability: readonly ModelAvailabilityInput[],
  registry: Readonly<Record<string, ModelEntry>> = DEFAULT_MODEL_REGISTRY,
): SelectableModelCatalogEntry[] {
  const availabilityBySelection = new Map<string, ModelAvailabilityInput>();
  for (const signal of availability) {
    const key = selectionKey(signal.provider, signal.model);
    if (availabilityBySelection.has(key)) {
      throw new Error(`duplicate availability for ${signal.provider}/${signal.model}`);
    }
    availabilityBySelection.set(key, signal);
  }

  return Object.entries(registry)
    .filter(([, entry]) => entry.selectable)
    .map(([model, entry]): SelectableModelCatalogEntry => {
      const signal = availabilityBySelection.get(selectionKey(entry.provider, model));
      const unavailableReason = !entry.supports_structured_output
        ? "structured_output_not_supported"
        : entry.pricing_is_estimate
          ? "pricing_is_estimate"
          : signal?.available === true
            ? null
            : signal?.reason?.trim() || "not_reported_available";
      return {
        provider: entry.provider,
        model,
        label: entry.label,
        available: unavailableReason === null,
        unavailable_reason: unavailableReason,
        supports_structured_output: entry.supports_structured_output,
        pricing: snapshotModelPricing(entry.provider, model, registry),
      };
    })
    .sort(
      (left, right) =>
        left.provider.localeCompare(right.provider) ||
        left.label.localeCompare(right.label) ||
        left.model.localeCompare(right.model),
    );
}

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

export interface UsageAttribution extends CompletionAttribution {}

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
