// FRONT DOOR P4: multi-part (image) message content. Extends the conformance
// mock pattern (mockProvider.ts) — the real adapter + real SDK serialize the
// request through the local mock HTTP server, and we assert the exact wire
// shape each provider receives, plus the backward-compatible string path and
// the per-request image cap.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AnthropicAdapter } from "../src/anthropic.js";
import { OpenAiAdapter } from "../src/openai.js";
import { AdapterError, type ImagePart } from "../src/types.js";
import { type MockProvider, startMockProvider } from "./mockProvider.js";

let mock: MockProvider;

beforeAll(async () => {
  mock = await startMockProvider();
});

afterAll(async () => {
  await mock.close();
});

const attribution = { projectId: "proj-test", nodeId: "node-1", runId: "run-1" };

// Short, opaque base64 payloads — the mock never decodes them, so validity is
// irrelevant; only the serialized request shape is under test.
const PNG: ImagePart = { type: "image", mime: "image/png", base64: "aaaaPNGaaaa" };
const JPEG: ImagePart = { type: "image", mime: "image/jpeg", base64: "bbbbJPEGbbbb" };

function anthropic() {
  return new AnthropicAdapter({ apiKey: "mock-key", model: "mock-anthropic", baseURL: mock.url });
}
function openai() {
  return new OpenAiAdapter({ apiKey: "mock-key", model: "mock-openai", baseURL: `${mock.url}/v1` });
}

function lastBody(match: (url: string) => boolean, from: number): Record<string, unknown> {
  const request = mock.requests.slice(from).find((candidate) => match(candidate.url));
  expect(request).toBeDefined();
  return JSON.parse(request?.body ?? "{}") as Record<string, unknown>;
}

describe("FRONT DOOR P4 image content — Anthropic", () => {
  it("sends prompt text plus base64 image source blocks", async () => {
    const from = mock.requests.length;
    await anthropic().complete({ prompt: "look at these", images: [PNG, JPEG], ...attribution });
    const body = lastBody((url) => url.includes("/messages"), from);
    const messages = body.messages as Array<{ role: string; content: unknown }>;
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("user");
    expect(messages[0]?.content).toEqual([
      { type: "text", text: "look at these" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "aaaaPNGaaaa" } },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "bbbbJPEGbbbb" } },
    ]);
  });

  it("keeps a plain string content when no images are attached (backward compatible)", async () => {
    const from = mock.requests.length;
    await anthropic().complete({ prompt: "text only", ...attribution });
    const body = lastBody((url) => url.includes("/messages"), from);
    const messages = body.messages as Array<{ role: string; content: unknown }>;
    expect(messages[0]?.content).toBe("text only");
  });
});

describe("FRONT DOOR P4 image content — OpenAI", () => {
  it("sends prompt text plus data-URI input_image parts", async () => {
    const from = mock.requests.length;
    await openai().complete({ prompt: "review these", images: [PNG, JPEG], ...attribution });
    const body = lastBody((url) => url.endsWith("/responses"), from);
    const input = body.input as Array<{ role: string; content: unknown }>;
    expect(input).toHaveLength(1);
    expect(input[0]?.role).toBe("user");
    expect(input[0]?.content).toEqual([
      { type: "input_text", text: "review these" },
      { type: "input_image", image_url: "data:image/png;base64,aaaaPNGaaaa", detail: "auto" },
      { type: "input_image", image_url: "data:image/jpeg;base64,bbbbJPEGbbbb", detail: "auto" },
    ]);
  });

  it("keeps a plain string input when no images are attached (backward compatible)", async () => {
    const from = mock.requests.length;
    await openai().complete({ prompt: "text only", ...attribution });
    const body = lastBody((url) => url.endsWith("/responses"), from);
    expect(body.input).toBe("text only");
  });
});

describe("FRONT DOOR P4 per-request image cap", () => {
  const nine: ImagePart[] = Array.from({ length: 9 }, (_, i) => ({
    type: "image",
    mime: "image/png",
    base64: `img${i}`,
  }));

  it("rejects more than 8 images without dispatching (Anthropic)", async () => {
    const from = mock.requests.length;
    const error = await anthropic()
      .complete({ prompt: "too many", images: nine, ...attribution })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(error).toBeInstanceOf(AdapterError);
    expect(error).toMatchObject({ kind: "invalid_request", retryable: false });
    // Nothing reached the provider.
    expect(mock.requests.slice(from).some((r) => r.url.includes("/messages"))).toBe(false);
  });

  it("rejects more than 8 images without dispatching (OpenAI)", async () => {
    const from = mock.requests.length;
    const error = await openai()
      .complete({ prompt: "too many", images: nine, ...attribution })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(error).toBeInstanceOf(AdapterError);
    expect(error).toMatchObject({ kind: "invalid_request", retryable: false });
    expect(mock.requests.slice(from).some((r) => r.url.endsWith("/responses"))).toBe(false);
  });

  it("accepts exactly 8 images", async () => {
    const eight = nine.slice(0, 8);
    const result = await openai().complete({ prompt: "ok", images: eight, ...attribution });
    expect(result.text).toContain("hello from the mock provider");
  });
});
