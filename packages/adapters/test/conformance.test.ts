// Phase 2 conformance suite: one identical spec, both providers. Runs the
// real adapter + real SDK code paths against a local mock of each provider's
// HTTP API (baseURL override). The same suite runs live when keys exist —
// see live.test.ts.
import { UsageEvent } from "@norns/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { AnthropicAdapter } from "../src/anthropic.js";
import { OpenAiAdapter } from "../src/openai.js";
import { DEFAULT_MODEL_REGISTRY, estimateCostUsd } from "../src/registry.js";
import { AdapterError, type LlmAdapter } from "../src/types.js";
import { type MockProvider, startMockProvider } from "./mockProvider.js";

let mock: MockProvider;

beforeAll(async () => {
  mock = await startMockProvider();
});

afterAll(async () => {
  await mock.close();
});

const cases: { name: string; make: () => LlmAdapter }[] = [
  {
    name: "anthropic",
    make: () =>
      new AnthropicAdapter({ apiKey: "mock-key", model: "mock-anthropic", baseURL: mock.url }),
  },
  {
    name: "openai",
    make: () =>
      new OpenAiAdapter({ apiKey: "mock-key", model: "mock-openai", baseURL: `${mock.url}/v1` }),
  },
];

const attribution = { projectId: "proj-test", nodeId: "node-1", runId: "run-1" };

describe.each(cases)("adapter conformance: $name", ({ name, make }) => {
  it("completes and emits a normalized, ledger-valid usage event", async () => {
    const adapter = make();
    const result = await adapter.complete({ prompt: "say hello", ...attribution });
    expect(result.text).toContain("hello from the mock provider");

    // the usage event is schema-valid for the ledger
    const usage = UsageEvent.parse(result.usage);
    expect(usage.provider).toBe(name);
    expect(usage.input_tokens).toBe(120);
    expect(usage.output_tokens).toBe(45);
    expect(usage.usage_source).toBe("provider_api");
    expect(usage.node_id).toBe("node-1");

    // ledger reconciliation: estimated cost === registry math, exactly
    const entry = DEFAULT_MODEL_REGISTRY[adapter.model];
    expect(entry).toBeDefined();
    if (entry) expect(usage.estimated_cost_usd).toBe(estimateCostUsd(entry, 120, 45));
  });

  it("returns schema-validated structured output", async () => {
    const adapter = make();
    const schema = z.object({ name: z.string(), count: z.number().int() });
    const result = await adapter.completeStructured(
      { prompt: "STRUCTURED please", ...attribution },
      schema,
      "test_object",
    );
    expect(result.value).toEqual({ name: "mock", count: 3 });
  });

  it("rejects structured responses that fail the schema", async () => {
    const adapter = make();
    const schema = z.object({ missing_field: z.string() });
    await expect(
      adapter.completeStructured({ prompt: "STRUCTURED please", ...attribution }, schema, "strict"),
    ).rejects.toMatchObject({ kind: "invalid_response", retryable: false });
  });

  it("maps the failure taxonomy: 429 retryable, 401 fatal, 500 retryable", async () => {
    const adapter = make();
    await expect(adapter.complete({ prompt: "TRIGGER_429", ...attribution })).rejects.toMatchObject(
      { kind: "rate_limit", retryable: true },
    );
    await expect(adapter.complete({ prompt: "TRIGGER_401", ...attribution })).rejects.toMatchObject(
      { kind: "auth", retryable: false },
    );
    await expect(adapter.complete({ prompt: "TRIGGER_500", ...attribution })).rejects.toMatchObject(
      { kind: "server", retryable: true },
    );
  });

  it("supports cancellation via AbortSignal", async () => {
    const adapter = make();
    const controller = new AbortController();
    const pending = adapter.complete({
      prompt: "TRIGGER_HANG",
      signal: controller.signal,
      ...attribution,
    });
    setTimeout(() => controller.abort(), 50);
    const error = await pending.then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(AdapterError);
    expect((error as AdapterError).kind).toBe("cancelled");
  });
});
