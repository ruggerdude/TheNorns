import { describe, expect, it } from "vitest";
import { AdapterError, kindForStatus } from "../src/types.js";

describe("provider-neutral adapter failures", () => {
  it("classifies insufficient provider balance as non-retryable", () => {
    expect(kindForStatus(402)).toBe("insufficient_funds");
    expect(new AdapterError(kindForStatus(402), "provider balance exhausted")).toMatchObject({
      kind: "insufficient_funds",
      retryable: false,
    });
  });
});
