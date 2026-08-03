import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  DeepSeekAdapter,
  type DeepSeekChatCompletion,
  type DeepSeekChatCompletionChunk,
  type DeepSeekChatRequest,
  type DeepSeekClientBoundary,
} from "../src/deepseek.js";
import { DEFAULT_MODEL_REGISTRY, estimateCostUsd } from "../src/registry.js";
import { AdapterError } from "../src/types.js";

const attribution = { projectId: "proj-deepseek", nodeId: "node-1", runId: "run-1" };

const usage = {
  prompt_tokens: 120,
  completion_tokens: 30,
  total_tokens: 150,
  prompt_cache_hit_tokens: 40,
  prompt_cache_miss_tokens: 80,
};

function completion(
  content: string | null = "visible answer",
  overrides: Partial<DeepSeekChatCompletion> = {},
): DeepSeekChatCompletion {
  return {
    id: "chatcmpl_deepseek",
    choices: [
      {
        message: { content, reasoning_content: "private chain of thought" },
        finish_reason: "stop",
      },
    ],
    usage,
    ...overrides,
  };
}

function streamOf(
  chunks: readonly DeepSeekChatCompletionChunk[],
): AsyncIterable<DeepSeekChatCompletionChunk> {
  return (async function* chunksInOrder() {
    for (const chunk of chunks) yield chunk;
  })();
}

function harness(
  respond: (
    request: DeepSeekChatRequest,
  ) => DeepSeekChatCompletion | AsyncIterable<DeepSeekChatCompletionChunk> | Promise<never>,
) {
  const requests: DeepSeekChatRequest[] = [];
  const client: DeepSeekClientBoundary = {
    async create(request) {
      requests.push(request);
      return await respond(request);
    },
  };
  return {
    adapter: new DeepSeekAdapter({
      apiKey: "not-used",
      model: "deepseek-v4-pro",
      client,
    }),
    requests,
  };
}

describe("DeepSeekAdapter", () => {
  it("uses Chat Completions and normalizes exact usage including cache hits", async () => {
    const { adapter, requests } = harness(() => completion());

    const result = await adapter.complete({
      system: "Be direct.",
      prompt: "Say hello",
      maxTokens: 321,
      ...attribution,
    });

    expect(requests).toEqual([
      {
        model: "deepseek-v4-pro",
        messages: [
          { role: "system", content: "Be direct." },
          { role: "user", content: "Say hello" },
        ],
        max_tokens: 321,
      },
    ]);
    expect(result).toMatchObject({
      text: "visible answer",
      provider_execution_id: "chatcmpl_deepseek",
      finish_reason: "stop",
      usage: {
        provider: "deepseek",
        model: "deepseek-v4-pro",
        input_tokens: 120,
        output_tokens: 30,
        cache_read_tokens: 40,
        cache_write_tokens: 0,
        usage_source: "provider_api",
      },
    });
    const entry = DEFAULT_MODEL_REGISTRY["deepseek-v4-pro"];
    expect(entry).toBeDefined();
    if (entry) {
      expect(result.usage.estimated_cost_usd).toBe(estimateCostUsd(entry, 120, 30, 40));
    }
    expect(JSON.stringify(result)).not.toContain("private chain of thought");
  });

  it("combines JSON mode with a schema prompt and Zod validation", async () => {
    const { adapter, requests } = harness(() => completion('{"name":"mock","count":3}'));
    const schema = z.object({ name: z.string(), count: z.number().int() });

    const result = await adapter.completeStructured(
      { prompt: "Return the record", ...attribution },
      schema,
      "test_object",
    );

    expect(result.value).toEqual({ name: "mock", count: 3 });
    expect(result.text).toBe('{"name":"mock","count":3}');
    expect(requests[0]).toMatchObject({
      model: "deepseek-v4-pro",
      response_format: { type: "json_object" },
      messages: [{ role: "user" }],
    });
    const prompt = requests[0]?.messages.at(-1)?.content ?? "";
    expect(prompt).toContain("Return the record");
    expect(prompt).toContain('JSON Schema named "test_object"');
    expect(prompt).toContain('"required":["name","count"]');
  });

  it("does not duplicate a schema prompt prepared by the caller", async () => {
    const { adapter, requests } = harness(() => completion('{"ok":true}'));
    await adapter.completeStructured(
      {
        prompt: "PREPARED JSON CONTRACT",
        structuredOutputPrepared: true,
        ...attribution,
      },
      z.object({ ok: z.boolean() }),
      "prepared",
    );

    expect(requests[0]?.messages).toEqual([{ role: "user", content: "PREPARED JSON CONTRACT" }]);
    expect(requests[0]?.response_format).toEqual({ type: "json_object" });
  });

  it("retains provider evidence when structured output fails validation", async () => {
    const { adapter } = harness(() => completion('{"name":42}'));

    const error = await adapter
      .completeStructured(
        { prompt: "Return JSON", ...attribution },
        z.object({ name: z.string() }),
        "record",
      )
      .then(
        () => null,
        (failure: unknown) => failure,
      );

    expect(error).toBeInstanceOf(AdapterError);
    expect(error).toMatchObject({ kind: "invalid_response", retryable: false });
    expect((error as AdapterError).metadata).toMatchObject({
      provider_execution_id: "chatcmpl_deepseek",
      finish_reason: "stop",
      request_dispatched: true,
      response_text: '{"name":42}',
      usage: { input_tokens: 120, output_tokens: 30, cache_read_tokens: 40 },
      structured_failure: { kind: "schema_validation" },
    });
  });

  it("streams structured visible deltas, ignores reasoning, and tolerates empty chunks", async () => {
    const chunks: DeepSeekChatCompletionChunk[] = [
      {
        id: "chatcmpl_stream",
        choices: [{ delta: { reasoning_content: "never persist this" } }],
      },
      // The SDK removes raw SSE `: keep-alive` comments; an empty choices
      // event exercises the same adapter-side requirement to keep waiting.
      { id: "chatcmpl_stream", choices: [] },
      {
        id: "chatcmpl_stream",
        choices: [{ delta: { content: '{"name":' } }],
      },
      {
        id: "chatcmpl_stream",
        choices: [{ delta: { content: '"mock"}' }, finish_reason: "stop" }],
      },
      { id: "chatcmpl_stream", choices: [], usage },
    ];
    const { adapter, requests } = harness(() => streamOf(chunks));
    const deltas: string[] = [];

    const result = await adapter.streamStructured(
      { prompt: "Return JSON", ...attribution },
      z.object({ name: z.string() }),
      "record",
      (delta) => deltas.push(delta),
    );

    expect(deltas).toEqual(['{"name":', '"mock"}']);
    expect(result).toMatchObject({
      value: { name: "mock" },
      text: '{"name":"mock"}',
      provider_execution_id: "chatcmpl_stream",
      finish_reason: "stop",
      usage: { input_tokens: 120, output_tokens: 30, cache_read_tokens: 40 },
    });
    expect(requests[0]).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
      response_format: { type: "json_object" },
    });
    expect(JSON.stringify(result)).not.toContain("never persist this");
  });

  it("streams a conversation without exposing reasoning_content", async () => {
    const chunks: DeepSeekChatCompletionChunk[] = [
      {
        id: "chatcmpl_turn",
        choices: [{ delta: { reasoning_content: "secret analysis" } }],
      },
      { id: "chatcmpl_turn", choices: [] },
      { id: "chatcmpl_turn", choices: [{ delta: { content: "hello " } }] },
      {
        id: "chatcmpl_turn",
        choices: [{ delta: { content: "world" }, finish_reason: "stop" }],
      },
      { id: "chatcmpl_turn", choices: [], usage },
    ];
    const { adapter, requests } = harness(() => streamOf(chunks));
    const stream = await adapter.streamConversation({
      system: "You are the PM.",
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: [{ type: "text", text: "visible history" }] },
        { role: "user", content: "continue" },
      ],
      ...attribution,
    });
    const events = [];
    for await (const event of stream) events.push(event);

    expect(requests[0]).toMatchObject({
      messages: [
        { role: "system", content: "You are the PM." },
        { role: "user", content: "first" },
        { role: "assistant", content: "visible history" },
        { role: "user", content: "continue" },
      ],
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(events).toMatchObject([
      { type: "response_started", provider_execution_id: "chatcmpl_turn" },
      { type: "text_delta", delta: "hello " },
      { type: "text_delta", delta: "world" },
      {
        type: "finish",
        result: {
          text: "hello world",
          provider_execution_id: "chatcmpl_turn",
          finish_reason: "stop",
          usage: { input_tokens: 120, output_tokens: 30, cache_read_tokens: 40 },
        },
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("secret analysis");
  });

  it("fails closed on image requests before dispatch", async () => {
    const { adapter, requests } = harness(() => completion());
    const image = { type: "image" as const, mime: "image/png" as const, base64: "AA==" };

    await expect(
      adapter.complete({ prompt: "inspect", images: [image], ...attribution }),
    ).rejects.toMatchObject({ kind: "invalid_request", retryable: false });

    await expect(
      adapter.streamConversation({
        messages: [{ role: "user", content: [{ type: "text", text: "inspect" }, image] }],
        ...attribution,
      }),
    ).rejects.toMatchObject({ kind: "invalid_request", retryable: false });
    expect(requests).toHaveLength(0);
  });

  it("maps HTTP 402 through the shared non-retryable taxonomy", async () => {
    const { adapter } = harness(() => Promise.reject({ status: 402, message: "no balance" }));

    await expect(adapter.complete({ prompt: "hello", ...attribution })).rejects.toMatchObject({
      kind: "insufficient_funds",
      retryable: false,
    });
  });

  it("rejects a completed stream that omits exact usage", async () => {
    const { adapter } = harness(() =>
      streamOf([
        {
          id: "chatcmpl_no_usage",
          choices: [{ delta: { content: "hello" }, finish_reason: "stop" }],
        },
      ]),
    );
    const stream = await adapter.streamConversation({
      messages: [{ role: "user", content: "hello" }],
      ...attribution,
    });

    const error = await (async () => {
      try {
        for await (const event of stream) void event;
        return null;
      } catch (failure) {
        return failure;
      }
    })();
    expect(error).toMatchObject({
      kind: "invalid_response",
      retryable: false,
      metadata: { provider_execution_id: "chatcmpl_no_usage", request_dispatched: true },
    });
  });
});
