import { PM_MODEL_OPTIONS, PmProvider } from "@norns/contracts";
import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL_REGISTRY } from "../src/registry.js";

describe("selectable PM model metering", () => {
  it("has provider-matched pricing metadata for every selectable model", () => {
    for (const provider of PmProvider.options) {
      for (const model of PM_MODEL_OPTIONS[provider]) {
        expect(DEFAULT_MODEL_REGISTRY[model.id]).toMatchObject({
          provider,
          pricing_is_estimate: false,
        });
      }
    }
  });
});
