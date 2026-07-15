import { describe, expect, it } from "vitest";
import {
  DEFAULT_PM_MODEL,
  PM_MODEL_OPTIONS,
  PmProvider,
  isPmModelForProvider,
  pmModelOption,
  providerForPmModel,
} from "../src/models.js";

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

  it("uses balanced defaults for each provider", () => {
    expect(DEFAULT_PM_MODEL).toEqual({
      anthropic: "claude-sonnet-5",
      openai: "gpt-5.6-terra",
    });
  });
});
