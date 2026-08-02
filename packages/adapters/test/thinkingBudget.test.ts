// Regression: on Anthropic, `max_tokens` bounds thinking AND visible output
// together, and Sonnet 5 / Opus 5 think by default when `thinking` is omitted.
// Structured callers size `maxTokens` around the JSON envelope, so the
// structured paths must disable thinking explicitly or the envelope truncates
// mid-object and surfaces as `invalid_response`. These assert the actual wire
// request the SDK sends, not adapter internals.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { AnthropicAdapter } from "../src/anthropic.js";
import { type MockProvider, startMockProvider } from "./mockProvider.js";

let mock: MockProvider;

beforeAll(async () => {
  mock = await startMockProvider();
});

afterAll(async () => {
  await mock.close();
});

const schema = z.object({ name: z.string(), count: z.number() });
const attribution = { projectId: "proj-thinking", nodeId: "node-1", runId: "run-1" };

function adapterFor(model: string): AnthropicAdapter {
  return new AnthropicAdapter({ apiKey: "mock-key", model, baseURL: mock.url });
}

/** Body of the request the SDK put on the wire during `run`. */
async function sentBody(run: () => Promise<unknown>): Promise<Record<string, unknown>> {
  const before = mock.requests.length;
  await run();
  const sent = mock.requests.slice(before);
  expect(sent).toHaveLength(1);
  return JSON.parse(sent[0]?.body ?? "{}") as Record<string, unknown>;
}

describe("anthropic structured output token budget", () => {
  it("completeStructured disables thinking so max_tokens bounds the envelope alone", async () => {
    const adapter = adapterFor("claude-sonnet-5");
    const body = await sentBody(() =>
      adapter.completeStructured(
        { prompt: "STRUCTURED please", maxTokens: 4000, ...attribution },
        schema,
        "plan_revision",
      ),
    );

    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.max_tokens).toBe(4000);
  });

  it("streamStructured carries the same configuration as the buffered twin", async () => {
    const adapter = adapterFor("claude-sonnet-5");
    const body = await sentBody(() =>
      adapter.streamStructured(
        { prompt: "STRUCTURED please", maxTokens: 4000, ...attribution },
        schema,
        "plan_revision",
        () => undefined,
      ),
    );

    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.max_tokens).toBe(4000);
    expect(body.stream).toBe(true);
  });

  it("leaves ordinary chat alone — thinking stays on for streamConversation", async () => {
    const adapter = adapterFor("claude-sonnet-5");
    const body = await sentBody(async () => {
      const stream = await adapter.streamConversation({
        projectId: "proj-thinking",
        initiatedByUserId: "user-1",
        messages: [{ role: "user", content: "hello" }],
      });
      for await (const _event of stream) {
        // drain
      }
    });

    expect(body).not.toHaveProperty("thinking");
  });

  it("omits the disable on models that reject it (thinking is always on)", async () => {
    const adapter = adapterFor("claude-fable-5");
    const body = await sentBody(() =>
      adapter.completeStructured(
        { prompt: "STRUCTURED please", maxTokens: 4000, ...attribution },
        schema,
        "plan_revision",
      ),
    );

    expect(body).not.toHaveProperty("thinking");
  });
});
