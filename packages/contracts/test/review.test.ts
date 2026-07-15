import { describe, expect, it } from "vitest";
import { ReviewPolicyRecord } from "../src/review.js";

describe("ReviewPolicyRecord model provenance", () => {
  it("accepts exact model provenance while remaining compatible with 1.2 records", () => {
    const legacy = {
      requested_policy: "cross_provider" as const,
      pm_provider: "anthropic",
      reviewer_provider: "openai",
      exception_reason: null,
      exception_approved_by: null,
    };

    expect(ReviewPolicyRecord.parse(legacy)).toEqual(legacy);
    expect(
      ReviewPolicyRecord.parse({
        ...legacy,
        pm_model: "claude-fable-5",
        reviewer_model: "gpt-5.6-sol",
      }),
    ).toMatchObject({
      pm_model: "claude-fable-5",
      reviewer_model: "gpt-5.6-sol",
    });
  });
});
