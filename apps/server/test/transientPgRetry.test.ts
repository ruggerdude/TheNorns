import { describe, expect, it } from "vitest";
import { isTransientPgError, withTransientPgRetry } from "../src/persistence/v2/database.js";

function pgError(code: string): Error & { code: string } {
  return Object.assign(new Error(code === "40P01" ? "deadlock detected" : "serialization"), {
    code,
  });
}

describe("withTransientPgRetry", () => {
  it("recognizes only deadlock and serialization failures as transient", () => {
    expect(isTransientPgError(pgError("40P01"))).toBe(true);
    expect(isTransientPgError(pgError("40001"))).toBe(true);
    expect(isTransientPgError(pgError("23505"))).toBe(false);
    expect(isTransientPgError(new Error("plain"))).toBe(false);
    expect(isTransientPgError(null)).toBe(false);
  });

  it("re-runs an idempotent operation through a deadlock and returns its result", async () => {
    let calls = 0;
    const result = await withTransientPgRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw pgError("40P01");
        return "applied";
      },
      { backoffMs: 1 },
    );
    expect(result).toBe("applied");
    expect(calls).toBe(3);
  });

  it("rethrows a non-transient error immediately", async () => {
    let calls = 0;
    await expect(
      withTransientPgRetry(
        async () => {
          calls += 1;
          throw pgError("23505");
        },
        { backoffMs: 1 },
      ),
    ).rejects.toMatchObject({ code: "23505" });
    expect(calls).toBe(1);
  });

  it("gives up after the attempt budget and surfaces the last deadlock", async () => {
    let calls = 0;
    await expect(
      withTransientPgRetry(
        async () => {
          calls += 1;
          throw pgError("40P01");
        },
        { attempts: 3, backoffMs: 1 },
      ),
    ).rejects.toMatchObject({ code: "40P01" });
    expect(calls).toBe(3);
  });
});
