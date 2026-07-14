// Live-provider smoke: auto-enables when real keys are present in the
// environment (Phase 2's "green on both live providers" — gated on
// credentials, like the deployed 1A acceptance).
import { describe, expect, it } from "vitest";
import { AnthropicAdapter } from "../src/anthropic.js";
import { OpenAiAdapter } from "../src/openai.js";

const anthropicKey = process.env.ANTHROPIC_API_KEY;
const openaiKey = process.env.OPENAI_API_KEY;
const openaiModel = process.env.NORNS_OPENAI_MODEL; // set the real reasoning model id

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
});
