// Live-provider smoke: auto-enables when real keys are present in the
// environment (Phase 2's "green on both live providers" — gated on
// credentials, like the deployed 1A acceptance).
import { describe, expect, it } from "vitest";
import { AnthropicAdapter } from "../src/anthropic.js";
import { OpenAiAdapter } from "../src/openai.js";
import type { ConversationLlmAdapter, ConversationStreamEvent } from "../src/types.js";

const anthropicKey = process.env.ANTHROPIC_API_KEY;
const openaiKey = process.env.OPENAI_API_KEY;
const openaiModel = process.env.NORNS_OPENAI_MODEL; // set the real reasoning model id

async function expectLiveConversationStream(adapter: ConversationLlmAdapter): Promise<void> {
  const stream = await adapter.streamConversation({
    projectId: "proj-live-conversation-smoke",
    initiatedByUserId: "user-live-conversation-smoke",
    system: "Reply briefly and do not include reasoning.",
    messages: [{ role: "user", content: "Reply with exactly: ok" }],
    maxTokens: 128,
  });
  const events: ConversationStreamEvent[] = [];
  for await (const event of stream) events.push(event);

  expect(events[0]).toMatchObject({
    type: "response_started",
    provider_execution_id: expect.any(String),
  });
  const terminal = events.at(-1);
  expect(terminal?.type).toBe("finish");
  if (terminal?.type !== "finish") throw new Error("live stream did not return terminal usage");
  expect(terminal.result.text.toLowerCase()).toContain("ok");
  expect(terminal.result.provider_execution_id).toBe(
    events[0]?.type === "response_started" ? events[0].provider_execution_id : "",
  );
  expect(terminal.result.usage.input_tokens).toBeGreaterThan(0);
  expect(terminal.result.usage.output_tokens).toBeGreaterThan(0);
  expect(
    events
      .filter(
        (event): event is Extract<ConversationStreamEvent, { type: "text_delta" }> =>
          event.type === "text_delta",
      )
      .map((event) => event.delta)
      .join(""),
  ).toBe(terminal.result.text);
}

describe("live provider smoke", () => {
  it.skipIf(!anthropicKey)("anthropic: completes with real usage", async () => {
    const adapter = new AnthropicAdapter({
      apiKey: anthropicKey as string,
      model: "claude-haiku-4-5",
    });
    const result = await adapter.complete({
      prompt: "Reply with exactly: ok",
      maxTokens: 32,
      projectId: "proj-live-smoke",
    });
    expect(result.text.toLowerCase()).toContain("ok");
    expect(result.usage.input_tokens).toBeGreaterThan(0);
  });

  it.skipIf(!anthropicKey)("anthropic: streams visible text with terminal real usage", async () => {
    await expectLiveConversationStream(
      new AnthropicAdapter({
        apiKey: anthropicKey as string,
        model: "claude-haiku-4-5",
      }),
    );
  });

  it.skipIf(!openaiKey || !openaiModel)("openai: completes with real usage", async () => {
    const adapter = new OpenAiAdapter({
      apiKey: openaiKey as string,
      model: openaiModel as string,
    });
    const result = await adapter.complete({
      prompt: "Reply with exactly: ok",
      projectId: "proj-live-smoke",
    });
    expect(result.text.toLowerCase()).toContain("ok");
    expect(result.usage.input_tokens).toBeGreaterThan(0);
  });

  it.skipIf(!openaiKey || !openaiModel)(
    "openai: streams visible text with terminal real usage",
    async () => {
      await expectLiveConversationStream(
        new OpenAiAdapter({
          apiKey: openaiKey as string,
          model: openaiModel as string,
        }),
      );
    },
  );
});
