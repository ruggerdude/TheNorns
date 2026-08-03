// FRONT DOOR P2 §D1: resolving which PM/reviewer provider+model pair a
// durable planning run uses — a persisted per-project override when present,
// falling back to exactly the existing live-planning route's default policy.
import { describe, expect, it } from "vitest";
import {
  PlanningConfigurationError,
  PlanningModelProfileConfigurationError,
  defaultReviewerProviderFor,
  planningModelProfileFromEnvironment,
  resolvePlanningParticipants,
} from "../src/planning/reviewerSelection.js";

const fullEnv = {
  ANTHROPIC_API_KEY: "test-anthropic",
  OPENAI_API_KEY: "test-openai",
  NORNS_PM_MODEL: "claude-opus-4-8",
  NORNS_OPENAI_MODEL: "gpt-5.6-luna",
  NORNS_REVIEWER_ANTHROPIC_MODEL: "claude-sonnet-5",
};

const defaultPmModel = {
  anthropic: "claude-opus-4-8",
  openai: "gpt-5.6-luna",
  deepseek: "deepseek-v4-pro",
};

describe("resolvePlanningParticipants", () => {
  it.each([
    ["quality", "claude-fable-5", "gpt-5.6-sol"],
    ["balanced", "claude-sonnet-5", "gpt-5.6-terra"],
    ["fast", "claude-haiku-4-5-20251001", "gpt-5.6-luna"],
  ] as const)(
    "uses the %s profile only when exact participant models are unconfigured",
    (profile, anthropicModel, openaiModel) => {
      const result = resolvePlanningParticipants({
        pmSelection: { provider: "anthropic", model: null },
        persistedReviewer: null,
        env: { ANTHROPIC_API_KEY: "test-anthropic", OPENAI_API_KEY: "test-openai" },
        defaultPmModel,
        profile,
      });
      expect(result.pm).toEqual({ provider: "anthropic", model: anthropicModel });
      expect(result.reviewer).toEqual({ provider: "openai", model: openaiModel });
      const inverse = resolvePlanningParticipants({
        pmSelection: { provider: "openai", model: null },
        persistedReviewer: null,
        env: { ANTHROPIC_API_KEY: "test-anthropic", OPENAI_API_KEY: "test-openai" },
        defaultPmModel,
        profile,
      });
      expect(inverse.pm).toEqual({ provider: "openai", model: openaiModel });
      expect(inverse.reviewer).toEqual({ provider: "anthropic", model: anthropicModel });
    },
  );

  it("defaults an unconfigured deployment profile to balanced and rejects invalid values", () => {
    expect(planningModelProfileFromEnvironment({})).toBe("balanced");
    expect(planningModelProfileFromEnvironment({ NORNS_PLANNING_MODEL_PROFILE: " fast " })).toBe(
      "fast",
    );
    expect(() =>
      planningModelProfileFromEnvironment({ NORNS_PLANNING_MODEL_PROFILE: "turbo" }),
    ).toThrowError(PlanningModelProfileConfigurationError);
  });

  it("keeps exact project, reviewer, and legacy environment selections ahead of a profile", () => {
    const result = resolvePlanningParticipants({
      pmSelection: { provider: "anthropic", model: "claude-project-exact" },
      persistedReviewer: { provider: "openai", model: "openai-reviewer-exact" },
      env: fullEnv,
      defaultPmModel,
      profile: "quality",
    });
    expect(result.pm.model).toBe("claude-project-exact");
    expect(result.reviewer.model).toBe("openai-reviewer-exact");

    const legacyEnvironment = resolvePlanningParticipants({
      pmSelection: { provider: "anthropic", model: null },
      persistedReviewer: null,
      env: fullEnv,
      defaultPmModel,
      profile: "quality",
    });
    expect(legacyEnvironment.pm.model).toBe("claude-opus-4-8");
    expect(legacyEnvironment.reviewer.model).toBe("gpt-5.6-luna");
  });

  it("defaults the reviewer to the opposite provider when nothing is persisted", () => {
    const result = resolvePlanningParticipants({
      pmSelection: { provider: "anthropic", model: null },
      persistedReviewer: null,
      env: fullEnv,
      defaultPmModel,
    });
    expect(result.pm).toEqual({ provider: "anthropic", model: "claude-opus-4-8" });
    expect(result.reviewer).toEqual({ provider: "openai", model: "gpt-5.6-luna" });
    expect(result.reviewer.provider).toBe(defaultReviewerProviderFor("anthropic"));
  });

  it("uses the PM's own persisted model when set, bypassing env defaults", () => {
    const result = resolvePlanningParticipants({
      pmSelection: { provider: "openai", model: "gpt-6-nova" },
      persistedReviewer: null,
      env: fullEnv,
      defaultPmModel,
    });
    expect(result.pm).toEqual({ provider: "openai", model: "gpt-6-nova" });
    expect(result.reviewer).toEqual({ provider: "anthropic", model: "claude-sonnet-5" });
  });

  it("honors a persisted reviewer override over the default opposite-provider policy", () => {
    const result = resolvePlanningParticipants({
      pmSelection: { provider: "anthropic", model: null },
      persistedReviewer: { provider: "openai", model: "gpt-4.9-quartz" },
      env: fullEnv,
      defaultPmModel,
    });
    expect(result.reviewer).toEqual({ provider: "openai", model: "gpt-4.9-quartz" });
  });

  it("throws PlanningConfigurationError listing every missing requirement", () => {
    expect(() =>
      resolvePlanningParticipants({
        pmSelection: { provider: "anthropic", model: null },
        persistedReviewer: null,
        env: {},
        defaultPmModel: { anthropic: undefined, openai: undefined, deepseek: undefined },
      }),
    ).toThrowError(PlanningConfigurationError);
    try {
      resolvePlanningParticipants({
        pmSelection: { provider: "anthropic", model: null },
        persistedReviewer: null,
        env: {},
        defaultPmModel: { anthropic: undefined, openai: undefined, deepseek: undefined },
      });
      throw new Error("expected resolvePlanningParticipants to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(PlanningConfigurationError);
      const missing = (error as PlanningConfigurationError).missing;
      expect(missing).toContain("ANTHROPIC_API_KEY");
      expect(missing).toContain("OPENAI_API_KEY");
    }
  });
});
