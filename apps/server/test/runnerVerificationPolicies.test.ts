import { DEFAULT_VERIFICATION_POLICY_REF, runnerVerificationPolicies } from "@norns/runner";
import { describe, expect, it } from "vitest";

describe("runner verification policy startup", () => {
  it("provides the folder onboarding policy without manual environment setup", () => {
    expect(runnerVerificationPolicies(undefined).get(DEFAULT_VERIFICATION_POLICY_REF)).toEqual([
      "git",
      "diff-tree",
      "--check",
      "--root",
      "HEAD",
    ]);
  });

  it("accepts an explicit replacement policy map and rejects malformed commands", () => {
    expect(
      runnerVerificationPolicies(
        JSON.stringify({ [DEFAULT_VERIFICATION_POLICY_REF]: ["pnpm", "test"] }),
      ).get(DEFAULT_VERIFICATION_POLICY_REF),
    ).toEqual(["pnpm", "test"]);
    expect(() =>
      runnerVerificationPolicies(JSON.stringify({ [DEFAULT_VERIFICATION_POLICY_REF]: [] })),
    ).toThrow(/non-empty string array/);
  });
});
