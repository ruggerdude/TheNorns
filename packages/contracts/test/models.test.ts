import { describe, expect, it } from "vitest";
import {
  DEFAULT_PM_MODEL,
  PM_MODEL_OPTIONS,
  PmProvider,
  isPmModelForProvider,
  pmModelOption,
  providerForPmModel,
  reasoningEffortForModel,
} from "../src/models.js";

describe("reasoningEffortForModel", () => {
  it("clamps the legacy 'minimal' level (rejected by gpt-5.6) to 'low'", () => {
    for (const model of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
      expect(reasoningEffortForModel(model, "minimal")).toBe("low");
    }
  });

  it("passes every supported level through unchanged", () => {
    for (const effort of ["low", "medium", "high", "xhigh"] as const) {
      expect(reasoningEffortForModel("gpt-5.6-luna", effort)).toBe(effort);
    }
  });
});

describe("PM model catalog", () => {
  it("maps every selectable model to exactly one provider", () => {
    for (const provider of PmProvider.options) {
      for (const option of PM_MODEL_OPTIONS[provider]) {
        expect(isPmModelForProvider(provider, option.id)).toBe(true);
        expect(providerForPmModel(option.id)).toBe(provider);
        expect(pmModelOption(option.id)).toEqual(option);
      }
    }
  });

  it("uses the highest-capability default for each provider", () => {
    expect(DEFAULT_PM_MODEL).toEqual({
      anthropic: "claude-fable-5",
      openai: "gpt-5.6-sol",
      deepseek: "deepseek-v4-pro",
    });
  });
});
