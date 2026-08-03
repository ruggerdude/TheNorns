import { describe, expect, it } from "vitest";
import {
  DEEPSEEK_SURFACE,
  GatewayUsageTap,
  SURFACES,
  billableInputTokens,
  deepSeekGatewayBaseUrl,
  inspectGatewayRequest,
} from "../src/gateway/index.js";

const encoder = new TextEncoder();

function sse(type: string, payload: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}

describe("DeepSeek provider gateway contracts", () => {
  it("inspects the Anthropic-compatible request ceiling without rewriting the body", () => {
    const bodyText = JSON.stringify({
      model: "deepseek-v4-pro",
      max_tokens: 8_192,
      stream: true,
      messages: [{ role: "user", content: "hello" }],
      unknown_future_field: { preserved: true },
    });
    const body = encoder.encode(bodyText);

    expect(inspectGatewayRequest("deepseek", body)).toEqual({
      ok: true,
      request: {
        model: "deepseek-v4-pro",
        maxOutputTokens: 8_192,
        streaming: true,
        estimatedInputTokens: Math.max(1, Math.ceil(body.byteLength / 3) + 1_000),
        outputCeilingSubstituted: false,
      },
    });
    expect(new TextDecoder().decode(body)).toBe(bodyText);
  });

  it("normalizes DeepSeek's Anthropic-compatible streaming usage and ignores keep-alives", () => {
    const tap = new GatewayUsageTap("deepseek", true);
    tap.push(encoder.encode(": keep-alive\n\n"));
    tap.push(
      encoder.encode(
        sse("message_start", {
          message: {
            id: "msg_deepseek",
            usage: {
              input_tokens: 80,
              cache_read_input_tokens: 20,
              cache_creation_input_tokens: 5,
              output_tokens: 1,
            },
          },
        }),
      ),
    );
    tap.push(
      encoder.encode(
        sse("message_delta", {
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 30 },
        }),
      ),
    );
    tap.end();

    expect(tap.observed).toBe(true);
    expect(tap.complete).toBe(true);
    expect(tap.snapshot()).toEqual({
      input_tokens: 80,
      output_tokens: 30,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 5,
    });
    // Anthropic-compatible input_tokens excludes the two cache categories.
    expect(billableInputTokens(tap.snapshot(), "deepseek")).toBe(105);
  });

  it("registers the restricted DeepSeek upstream surface and bearer credential shape", () => {
    expect(SURFACES.deepseek).toBe(DEEPSEEK_SURFACE);
    expect(DEEPSEEK_SURFACE).toMatchObject({
      provider: "deepseek",
      origin: "https://api.deepseek.com/anthropic",
    });
    expect([...DEEPSEEK_SURFACE.paths]).toEqual([
      "/v1/messages",
      "/v1/messages/count_tokens",
      "/v1/models",
    ]);
    expect([...DEEPSEEK_SURFACE.meteredPaths]).toEqual(["/v1/messages"]);
    expect(DEEPSEEK_SURFACE.authHeaders("deepseek-secret")).toEqual({
      authorization: "Bearer deepseek-secret",
    });
  });

  it("builds the runner-facing DeepSeek gateway base URL without duplicate slashes", () => {
    expect(deepSeekGatewayBaseUrl("https://norns.example")).toBe(
      "https://norns.example/api/gateway/deepseek",
    );
    expect(deepSeekGatewayBaseUrl("https://norns.example///")).toBe(
      "https://norns.example/api/gateway/deepseek",
    );
  });
});
