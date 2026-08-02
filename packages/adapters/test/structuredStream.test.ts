// streamStructured is the streamed twin of completeStructured: same validated
// result, same failure taxonomy, plus raw text deltas while it generates.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { FakeAdapter } from "../src/fake.js";
import { AdapterError } from "../src/types.js";

const Plan = z.object({
  plan: z.object({
    modules: z.array(z.object({ id: z.string(), title: z.string() })).min(1),
  }),
});

const request = { prompt: "propose a plan", projectId: "proj-1" };

describe("streamStructured", () => {
  it("streams deltas and resolves the validated structured result", async () => {
    const adapter = new FakeAdapter("anthropic");
    const value = {
      plan: {
        modules: [
          { id: "one", title: "First module with a deliberately long title" },
          { id: "two", title: "Second module" },
        ],
      },
    };
    adapter.enqueue(value);
    const deltas: string[] = [];
    const result = await adapter.streamStructured(request, Plan, "plan", (delta) =>
      deltas.push(delta),
    );

    expect(result.value).toEqual(value);
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join("")).toBe(JSON.stringify(value));
    expect(result.text).toBe(JSON.stringify(value));
    expect(result.usage.output_tokens).toBe(50);
    // identical to the buffered path
    adapter.enqueue(value);
    const buffered = await adapter.completeStructured(request, Plan, "plan");
    expect(buffered.value).toEqual(result.value);
  });

  it("classifies a malformed response as not_json and keeps the provider text", async () => {
    const adapter = new FakeAdapter("openai");
    adapter.enqueue("I'm afraid I can't do that.");
    const error = await adapter
      .streamStructured(request, Plan, "plan", () => undefined)
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(AdapterError);
    const adapterError = error as AdapterError;
    expect(adapterError.kind).toBe("invalid_response");
    expect(adapterError.metadata?.structured_failure?.kind).toBe("not_json");
    expect(adapterError.metadata?.response_text).toBe("I'm afraid I can't do that.");
    // usage stays exact so the caller can settle spend on a rejected response
    expect(adapterError.metadata?.usage?.output_tokens).toBe(50);
    expect(adapterError.metadata?.request_dispatched).toBe(true);
  });

  it("classifies a body cut short by the output limit as output_truncated", async () => {
    const adapter = new FakeAdapter("anthropic");
    adapter.enqueue(FakeAdapter.truncated('{"plan":{"modules":[{"id":"one","title":"First'));
    const error = await adapter
      .streamStructured(request, Plan, "plan", () => undefined)
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(AdapterError);
    expect((error as AdapterError).metadata?.structured_failure?.kind).toBe("output_truncated");
    expect((error as AdapterError).metadata?.finish_reason).toBe("max_tokens");
  });

  it("reports schema violations as schema_validation", async () => {
    const adapter = new FakeAdapter("anthropic");
    adapter.enqueue({ plan: { modules: [] } });
    const error = await adapter
      .streamStructured(request, Plan, "plan", () => undefined)
      .catch((cause: unknown) => cause);

    expect((error as AdapterError).metadata?.structured_failure?.kind).toBe("schema_validation");
  });
});
