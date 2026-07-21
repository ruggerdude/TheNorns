import {
  DEFAULT_VERIFICATION_POLICY_REF,
  isHygieneOnly,
  runnerVerificationPolicies,
} from "@norns/runner";
import { describe, expect, it } from "vitest";

describe("runner verification policy startup", () => {
  it("provides the folder onboarding policy without manual environment setup", () => {
    const commands = runnerVerificationPolicies(undefined).get(DEFAULT_VERIFICATION_POLICY_REF);
    expect(commands).toEqual([
      { name: "git-hygiene", command: ["git", "diff-tree", "--check", "--root", "HEAD"] },
    ]);
    // EXECUTION E4 — the built-in default is a whitespace lint, and the runner
    // now knows that about itself so a green badge earned by it alone can be
    // labelled as such instead of masquerading as a passing test suite.
    expect(isHygieneOnly(commands ?? [])).toBe(true);
  });

  it("accepts an explicit replacement policy map and rejects malformed commands", () => {
    // The pre-E4 bare-argv form still parses, so a deployment that configured a
    // single command before this phase keeps working untouched.
    expect(
      runnerVerificationPolicies(
        JSON.stringify({ [DEFAULT_VERIFICATION_POLICY_REF]: ["pnpm", "test"] }),
      ).get(DEFAULT_VERIFICATION_POLICY_REF),
    ).toEqual([{ name: DEFAULT_VERIFICATION_POLICY_REF, command: ["pnpm", "test"] }]);
    expect(() =>
      runnerVerificationPolicies(JSON.stringify({ [DEFAULT_VERIFICATION_POLICY_REF]: [] })),
    ).toThrow(/non-empty string array/);
  });

  it("accepts an ordered list of named commands so build, test and lint report separately", () => {
    const policies = runnerVerificationPolicies(
      JSON.stringify({
        verification: [
          { name: "build", command: ["pnpm", "run", "build"] },
          { name: "test", command: ["pnpm", "test"] },
          { name: "lint", command: ["pnpm", "exec", "biome", "check"] },
        ],
      }),
    );
    expect(policies.get("verification")).toEqual([
      { name: "build", command: ["pnpm", "run", "build"] },
      { name: "test", command: ["pnpm", "test"] },
      { name: "lint", command: ["pnpm", "exec", "biome", "check"] },
    ]);
    expect(isHygieneOnly(policies.get("verification") ?? [])).toBe(false);
    expect(() =>
      runnerVerificationPolicies(JSON.stringify({ verification: [{ name: "test" }] })),
    ).toThrow(/must be \{ name, command/);
  });
});
