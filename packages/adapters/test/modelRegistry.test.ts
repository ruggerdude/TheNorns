import { PM_MODEL_OPTIONS, PmProvider } from "@norns/contracts";
import { describe, expect, it } from "vitest";
import {
  DEBATE_ALLOWED_MODELS_ENV,
  DEFAULT_MODEL_REGISTRY,
  buildSelectableModelCatalog,
  conservativeMaxChargeUsd,
  estimateCostUsd,
  modelAvailabilityFromDebateEnvironment,
  quoteConservativeMaxCharge,
  snapshotModelPricing,
} from "../src/registry.js";

describe("selectable PM model metering", () => {
  it("has provider-matched pricing metadata for every selectable model", () => {
    for (const provider of PmProvider.options) {
      for (const model of PM_MODEL_OPTIONS[provider]) {
        expect(DEFAULT_MODEL_REGISTRY[model.id]).toMatchObject({
          provider,
          label: model.label,
          selectable: true,
          supports_structured_output: true,
          pricing_is_estimate: false,
        });
      }
    }
  });

  it("pins DeepSeek pricing and image capabilities to the effective published schedule", () => {
    expect(DEFAULT_MODEL_REGISTRY["deepseek-v4-flash"]).toMatchObject({
      provider: "deepseek",
      supports_images: false,
      input_per_mtok: 0.14,
      cache_read_per_mtok: 0.0028,
      output_per_mtok: 0.28,
      pricing_version: "deepseek-2026-08-03",
      pricing_is_estimate: false,
    });
    expect(DEFAULT_MODEL_REGISTRY["deepseek-v4-pro"]).toMatchObject({
      provider: "deepseek",
      supports_images: false,
      input_per_mtok: 0.435,
      cache_read_per_mtok: 0.003625,
      output_per_mtok: 0.87,
      pricing_version: "deepseek-2026-08-03",
      pricing_is_estimate: false,
    });

    const flash = DEFAULT_MODEL_REGISTRY["deepseek-v4-flash"];
    expect(flash).toBeDefined();
    if (flash) {
      expect(estimateCostUsd(flash, 1_000_000, 1_000_000, 250_000)).toBeCloseTo(0.3857);
    }
  });

  it("fails closed and enables only the exact provider/model pairs reported available", () => {
    const catalog = buildSelectableModelCatalog([
      { provider: "openai", model: "gpt-5.6-sol", available: true },
      {
        provider: "anthropic",
        model: "claude-sonnet-5",
        available: false,
        reason: "credential_missing",
      },
      // A same-named signal at the wrong provider must not enable the OpenAI pair.
      { provider: "anthropic", model: "gpt-5.6-terra", available: true },
    ]);

    expect(catalog.every((entry) => entry.model !== "mock-openai")).toBe(true);
    expect(catalog.every((entry) => entry.model !== "openai-reasoning-default")).toBe(true);
    expect(catalog.find((entry) => entry.model === "gpt-5.6-sol")).toMatchObject({
      provider: "openai",
      available: true,
      unavailable_reason: null,
      pricing: {
        provider: "openai",
        model: "gpt-5.6-sol",
        pricing_version: "openai-2026-07",
      },
    });
    expect(catalog.find((entry) => entry.model === "gpt-5.6-terra")).toMatchObject({
      provider: "openai",
      available: false,
      unavailable_reason: "not_reported_available",
    });
    expect(catalog.find((entry) => entry.model === "claude-sonnet-5")).toMatchObject({
      available: false,
      unavailable_reason: "credential_missing",
    });
  });

  it("rejects duplicate availability signals rather than resolving them by order", () => {
    expect(() =>
      buildSelectableModelCatalog([
        { provider: "openai", model: "gpt-5.6-sol", available: true },
        { provider: "openai", model: "gpt-5.6-sol", available: false },
      ]),
    ).toThrow("duplicate availability");
  });

  it("requires a deployment allowlist as well as a provider credential for debate execution", () => {
    const withoutAllowlist = buildSelectableModelCatalog(
      modelAvailabilityFromDebateEnvironment({
        OPENAI_API_KEY: "openai-key",
        ANTHROPIC_API_KEY: "anthropic-key",
      }),
    );
    expect(withoutAllowlist.every((entry) => !entry.available)).toBe(true);
    expect(withoutAllowlist[0]?.unavailable_reason).toBe(
      "debate_model_allowlist_not_configured_or_invalid",
    );

    const configured = buildSelectableModelCatalog(
      modelAvailabilityFromDebateEnvironment({
        OPENAI_API_KEY: "openai-key",
        [DEBATE_ALLOWED_MODELS_ENV]: "openai/gpt-5.6-terra,anthropic/claude-sonnet-5",
      }),
    );
    expect(configured.find((entry) => entry.model === "gpt-5.6-terra")).toMatchObject({
      available: true,
      unavailable_reason: null,
    });
    expect(configured.find((entry) => entry.model === "claude-sonnet-5")).toMatchObject({
      available: false,
      unavailable_reason: "provider_api_key_not_configured",
    });
    expect(configured.find((entry) => entry.model === "gpt-5.6-sol")).toMatchObject({
      available: false,
      unavailable_reason: "model_not_in_debate_allowlist",
    });

    const deepseekConfigured = buildSelectableModelCatalog(
      modelAvailabilityFromDebateEnvironment({
        DEEPSEEK_API_KEY: "deepseek-key",
        [DEBATE_ALLOWED_MODELS_ENV]: "deepseek/deepseek-v4-flash",
      }),
    );
    expect(deepseekConfigured.find((entry) => entry.model === "deepseek-v4-flash")).toMatchObject({
      provider: "deepseek",
      available: true,
      unavailable_reason: null,
      supports_images: false,
      pricing: {
        cache_read_per_mtok: 0.0028,
        pricing_version: "deepseek-2026-08-03",
      },
    });
  });

  it("freezes a pricing snapshot and rounds conservative actor-cap quotes upward", () => {
    const pricing = snapshotModelPricing("openai", "gpt-5.6-terra");
    expect(Object.isFrozen(pricing)).toBe(true);
    expect(
      conservativeMaxChargeUsd(pricing, {
        max_input_tokens: 1,
        max_output_tokens: 1,
      }),
    ).toBe(0.000018); // 17.5 micro-USD, rounded up to 18 micro-USD.

    expect(
      quoteConservativeMaxCharge(
        { provider: "openai", model: "gpt-5.6-sol" },
        { max_input_tokens: 20_000, max_output_tokens: 4_000 },
      ),
    ).toMatchObject({
      max_input_tokens: 20_000,
      max_output_tokens: 4_000,
      max_charge_usd: 0.22,
      pricing: {
        provider: "openai",
        model: "gpt-5.6-sol",
        input_per_mtok: 5,
        output_per_mtok: 30,
      },
    });
  });

  it("prices Sonnet cache reads and writes at the published cache multipliers", () => {
    const sonnet = DEFAULT_MODEL_REGISTRY["claude-sonnet-5"];
    expect(sonnet).toBeDefined();
    if (!sonnet) throw new Error("Sonnet 5 registry entry is missing");
    expect(snapshotModelPricing("anthropic", "claude-sonnet-5")).toMatchObject({
      input_per_mtok: 2,
      cache_read_per_mtok: 0.2,
      cache_write_per_mtok: 2.5,
      output_per_mtok: 10,
      pricing_version: "anthropic-2026-07-intro-cache-corrected",
    });
    expect(estimateCostUsd(sonnet, 1_000_000, 100_000, 800_000, 100_000)).toBeCloseTo(1.61, 9);
  });

  it("rejects provider/model mismatches and unsafe token caps", () => {
    expect(() => snapshotModelPricing("anthropic", "gpt-5.6-sol")).toThrow(
      "model anthropic/gpt-5.6-sol not in registry",
    );
    const pricing = snapshotModelPricing("openai", "gpt-5.6-sol");
    expect(() =>
      conservativeMaxChargeUsd(pricing, {
        max_input_tokens: Number.MAX_SAFE_INTEGER + 1,
        max_output_tokens: 1,
      }),
    ).toThrow("safe integer");
    expect(() =>
      conservativeMaxChargeUsd(
        { ...pricing, input_per_mtok: -1 },
        { max_input_tokens: 1, max_output_tokens: 1 },
      ),
    ).toThrow("input_per_mtok must be finite and nonnegative");
  });
});
