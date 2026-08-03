import { describe, expect, it } from "vitest";
import {
  AI_PROVIDER_OPTIONS,
  PM_MODEL_GROUPS,
  aiProviderLabel,
  asAiProvider,
  defaultReviewerProviderFor,
} from "./aiProviders";

describe("web AI provider catalog", () => {
  it("exposes DeepSeek labels and models from the shared contracts", () => {
    expect(AI_PROVIDER_OPTIONS).toContainEqual({ value: "deepseek", label: "DeepSeek" });
    expect(PM_MODEL_GROUPS.find((group) => group.provider === "deepseek")?.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "deepseek-v4-pro" }),
        expect.objectContaining({ id: "deepseek-v4-flash" }),
      ]),
    );
    expect(asAiProvider("deepseek")).toBe("deepseek");
    expect(aiProviderLabel("deepseek")).toBe("DeepSeek");
  });

  it("mirrors the server's deterministic automatic reviewer choice", () => {
    expect(defaultReviewerProviderFor("anthropic")).toBe("openai");
    expect(defaultReviewerProviderFor("openai")).toBe("anthropic");
    expect(defaultReviewerProviderFor("deepseek")).toBe("anthropic");
  });
});
