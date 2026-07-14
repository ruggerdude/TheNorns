// ADR-001 dispatch semantics: claim() models FOR UPDATE SKIP LOCKED — two
// dispatchers never hold the same job; expired leases are reclaimed; polling
// is the recovery guarantee.
import { describe, expect, it } from "vitest";
import { DispatchStore } from "../src/engine/dispatch.js";

describe("dispatch jobs with leases", () => {
  it("only one claimant wins a job", () => {
    const store = new DispatchStore();
    store.enqueue({ node_id: "n1", runner_id: "r1", payload: {} });
    const first = store.claim("dispatcher-a", 1000, 5000);
    const second = store.claim("dispatcher-b", 1000, 5000);
    expect(first?.lease_owner).toBe("dispatcher-a");
    expect(second).toBeNull(); // skip-locked
  });

  it("an expired lease is reclaimed by another dispatcher", () => {
    const store = new DispatchStore();
    const job = store.enqueue({ node_id: "n1", runner_id: "r1", payload: {} });
    store.claim("dispatcher-a", 1000, 500); // lease until 1500
    expect(store.claim("dispatcher-b", 1400, 500)).toBeNull(); // still leased
    const reclaimed = store.claim("dispatcher-b", 1500, 500);
    expect(reclaimed?.id).toBe(job.id);
    expect(reclaimed?.lease_owner).toBe("dispatcher-b");
    expect(reclaimed?.attempts).toBe(2);
  });

  it("completed jobs are never reclaimed; failed jobs requeue with delay", () => {
    const store = new DispatchStore();
    const job = store.enqueue({ node_id: "n1", runner_id: "r1", payload: {} });
    store.claim("a", 1000, 500);
    store.complete(job.id, "cmd-1");
    expect(store.claim("b", 10_000, 500)).toBeNull();
    expect(store.get(job.id)?.command_id).toBe("cmd-1");

    const retry = store.enqueue({ node_id: "n2", runner_id: "r1", payload: {} });
    store.claim("a", 1000, 500);
    store.fail(retry.id, 1200, 300); // available again at 1500
    expect(store.claim("b", 1400, 500)).toBeNull();
    expect(store.claim("b", 1500, 500)?.id).toBe(retry.id);
  });
});
