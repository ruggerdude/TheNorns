import { describe, expect, it } from "vitest";
import {
  executionModelCatalogFromEnvironment,
  executionModelUnavailableMessage,
} from "../src/runners/executionModelAvailability.js";

describe("execution model availability", () => {
  it("requires both the runner allowlist and the matching provider credential", () => {
    const catalog = executionModelCatalogFromEnvironment({
      ANTHROPIC_API_KEY: "anthropic-key",
      OPENAI_API_KEY: "",
      NORNS_RUNNER_ALLOWED_MODELS: "anthropic/claude-sonnet-5,openai/gpt-5.6-terra",
    });

    expect(
      catalog.find((model) => model.provider === "anthropic" && model.model === "claude-sonnet-5"),
    ).toMatchObject({ available: true, unavailable_reason: null });
    expect(
      catalog.find((model) => model.provider === "openai" && model.model === "gpt-5.6-terra"),
    ).toMatchObject({
      available: false,
      unavailable_reason: "provider_api_key_not_configured",
    });
    expect(
      catalog.find((model) => model.provider === "anthropic" && model.model === "claude-opus-4-8"),
    ).toMatchObject({
      available: false,
      unavailable_reason: "model_not_in_runner_allowlist",
    });
  });

  it("fails closed with actionable copy when the runner allowlist is absent", () => {
    const catalog = executionModelCatalogFromEnvironment({
      ANTHROPIC_API_KEY: "anthropic-key",
    });
    expect(catalog.every((model) => !model.available)).toBe(true);
    expect(executionModelUnavailableMessage("anthropic", "claude-sonnet-5", catalog)).toContain(
      "NORNS_RUNNER_ALLOWED_MODELS",
    );
  });
});
