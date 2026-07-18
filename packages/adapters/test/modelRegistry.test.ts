import { PM_MODEL_OPTIONS, PmProvider } from "@norns/contracts";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL_REGISTRY,
  buildSelectableModelCatalog,
  conservativeMaxChargeUsd,
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
