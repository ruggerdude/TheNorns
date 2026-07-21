// EXECUTION E9 — usage read out of REAL provider payload shapes.
//
// The payloads below are not invented. They are the shapes the installed SDKs
// declare, field for field:
//   * Anthropic @anthropic-ai/sdk 0.112.3 —
//     `resources/messages/messages.d.ts`: `MessageDeltaUsage.output_tokens` is
//     documented "the CUMULATIVE number of output tokens", `input_tokens` and
//     both cache counters are cumulative and NULLABLE; `message_start` carries
//     the full `Usage`.
//   * OpenAI openai 6.48.0 — `resources/responses/responses.d.ts`:
//     `ResponseUsage { input_tokens, input_tokens_details, output_tokens,
//     output_tokens_details, total_tokens }`, nested under `response.usage` on
//     `ResponseCompletedEvent` / `ResponseIncompleteEvent` / `ResponseFailedEvent`.
//
// The cases that matter most are the awkward ones: a `data:` line split across
// two TCP reads, a stream cut off before its terminal event, and a `stream:
// true` request answered with a plain JSON error body.
import { describe, expect, it } from "vitest";
import { GatewayUsageTap, billableInputTokens, isEventStream } from "../src/gateway/usage.js";

const encoder = new TextEncoder();

function feed(tap: GatewayUsageTap, ...chunks: string[]): GatewayUsageTap {
  for (const chunk of chunks) tap.push(encoder.encode(chunk));
  tap.end();
  return tap;
}

function sse(type: string, payload: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}

// -- Anthropic ---------------------------------------------------------------

const ANTHROPIC_MESSAGE_START = sse("message_start", {
  message: {
    id: "msg_01XFDUDYJgAACzvnptvVoYEL",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5",
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: {
      input_tokens: 2095,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 1200,
      output_tokens: 1,
    },
  },
});

const ANTHROPIC_MESSAGE_DELTA = sse("message_delta", {
  delta: { stop_reason: "end_turn", stop_sequence: null },
  usage: { output_tokens: 503 },
});

describe("EXECUTION E9 usage tap — Anthropic Messages", () => {
  it("reads input tokens from message_start and cumulative output from message_delta", () => {
    const tap = feed(
      new GatewayUsageTap("anthropic", true),
      ANTHROPIC_MESSAGE_START,
      sse("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
      sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: "hi" } }),
      ANTHROPIC_MESSAGE_DELTA,
      sse("message_stop", {}),
    );
    expect(tap.observed).toBe(true);
    expect(tap.complete).toBe(true);
    expect(tap.snapshot()).toEqual({
      input_tokens: 2095,
      output_tokens: 503,
      cache_read_input_tokens: 1200,
      cache_creation_input_tokens: 0,
    });
    // Cache reads and writes are billed at the input rate — conservative on
    // purpose, and the number the ledger actually charges.
    expect(billableInputTokens(tap.snapshot())).toBe(3295);
  });

  it("never lets a later cumulative event move a counter backwards", () => {
    const tap = feed(
      new GatewayUsageTap("anthropic", true),
      ANTHROPIC_MESSAGE_START,
      ANTHROPIC_MESSAGE_DELTA,
      // A malformed or replayed event reporting fewer tokens must not reduce
      // the charge — that would be a free-tokens bug.
      sse("message_delta", { delta: {}, usage: { output_tokens: 1 } }),
    );
    expect(tap.snapshot().output_tokens).toBe(503);
  });

  it("treats a null input_tokens on message_delta as absent, not as zero", () => {
    // MessageDeltaUsage declares input_tokens as `number | null`.
    const tap = feed(
      new GatewayUsageTap("anthropic", true),
      ANTHROPIC_MESSAGE_START,
      sse("message_delta", {
        delta: { stop_reason: "end_turn" },
        usage: {
          input_tokens: null,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
          output_tokens: 77,
        },
      }),
    );
    expect(tap.snapshot().input_tokens).toBe(2095);
    expect(tap.snapshot().cache_read_input_tokens).toBe(1200);
    expect(tap.snapshot().output_tokens).toBe(77);
  });

  it("reassembles an event split across arbitrary chunk boundaries", () => {
    const whole = ANTHROPIC_MESSAGE_START + ANTHROPIC_MESSAGE_DELTA;
    // Split mid-JSON, which is exactly what a real socket does.
    const cut = Math.floor(whole.length / 2);
    const tap = feed(new GatewayUsageTap("anthropic", true), whole.slice(0, cut), whole.slice(cut));
    expect(tap.snapshot().input_tokens).toBe(2095);
    expect(tap.snapshot().output_tokens).toBe(503);
  });

  it("still meters a stream that dies after message_start", () => {
    // THE CASE THAT MATTERS. A truncated stream cost real input tokens. If the
    // tap only read a terminal event, this would cost nothing at all.
    const tap = feed(
      new GatewayUsageTap("anthropic", true),
      ANTHROPIC_MESSAGE_START,
      sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: "par" } }),
    );
    expect(tap.observed).toBe(true);
    expect(tap.complete).toBe(false);
    expect(tap.snapshot().input_tokens).toBe(2095);
    expect(tap.snapshot().output_tokens).toBe(1);
  });

  it("meters a message_delta truncated before its terminating blank line", () => {
    const partial = `event: message_delta\ndata: ${JSON.stringify({
      type: "message_delta",
      delta: {},
      usage: { output_tokens: 250 },
    })}\n`;
    const tap = feed(new GatewayUsageTap("anthropic", true), ANTHROPIC_MESSAGE_START, partial);
    expect(tap.snapshot().output_tokens).toBe(250);
  });

  it("reads a non-streaming Messages body", () => {
    const tap = feed(
      new GatewayUsageTap("anthropic", false),
      JSON.stringify({
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        model: "claude-sonnet-5",
        stop_reason: "end_turn",
        usage: {
          input_tokens: 12,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 34,
        },
      }),
    );
    expect(tap.complete).toBe(true);
    expect(tap.snapshot().input_tokens).toBe(12);
    expect(tap.snapshot().output_tokens).toBe(34);
  });

  it("observes nothing from an error body and says so", () => {
    const tap = feed(
      new GatewayUsageTap("anthropic", false),
      JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }),
    );
    expect(tap.observed).toBe(false);
  });
});

// -- OpenAI ------------------------------------------------------------------

const OPENAI_USAGE = {
  input_tokens: 328,
  input_tokens_details: { cache_write_tokens: 0, cached_tokens: 64 },
  output_tokens: 1_204,
  output_tokens_details: { reasoning_tokens: 900 },
  total_tokens: 1_532,
};

describe("EXECUTION E9 usage tap — OpenAI Responses", () => {
  it("reads the terminal response.completed event", () => {
    const tap = feed(
      new GatewayUsageTap("openai", true),
      sse("response.created", {
        sequence_number: 0,
        response: { id: "resp_1", object: "response", status: "in_progress", output: [] },
      }),
      sse("response.output_text.delta", { sequence_number: 1, delta: "he" }),
      sse("response.completed", {
        sequence_number: 2,
        response: {
          id: "resp_1",
          object: "response",
          status: "completed",
          output: [],
          usage: OPENAI_USAGE,
        },
      }),
      "data: [DONE]\n\n",
    );
    expect(tap.complete).toBe(true);
    expect(tap.snapshot().input_tokens).toBe(328);
    expect(tap.snapshot().output_tokens).toBe(1_204);
    // ResponseUsage.input_tokens is INCLUSIVE of cached tokens, so the cached
    // count is never added on top. 328, not 392.
    expect(billableInputTokens(tap.snapshot())).toBe(328);
  });

  it("meters response.incomplete and response.failed, which also carry usage", () => {
    for (const type of ["response.incomplete", "response.failed"]) {
      const tap = feed(
        new GatewayUsageTap("openai", true),
        sse(type, {
          sequence_number: 4,
          response: { id: "resp_2", status: "incomplete", usage: OPENAI_USAGE },
        }),
      );
      expect(tap.complete, type).toBe(true);
      expect(tap.snapshot().output_tokens, type).toBe(1_204);
    }
  });

  it("ignores the usage-less events that precede the terminal one", () => {
    const tap = feed(
      new GatewayUsageTap("openai", true),
      sse("response.in_progress", {
        sequence_number: 1,
        response: { id: "resp_3", status: "in_progress" },
      }),
    );
    expect(tap.observed).toBe(false);
  });

  it("still meters a stream cut off before its terminal event, at zero", () => {
    // Unlike Anthropic, Responses reveals no usage until the end, so a stream
    // that dies early genuinely yields nothing readable. The gateway must not
    // invent a number; `observed === false` is what makes it release the hold
    // and audit `gateway.unmetered` instead. This asymmetry is stated in the
    // E9 report rather than papered over.
    const tap = feed(
      new GatewayUsageTap("openai", true),
      sse("response.output_text.delta", { sequence_number: 1, delta: "partial" }),
    );
    expect(tap.observed).toBe(false);
  });

  it("reads a non-streaming Response body", () => {
    const tap = feed(
      new GatewayUsageTap("openai", false),
      JSON.stringify({
        id: "resp_4",
        object: "response",
        status: "completed",
        usage: OPENAI_USAGE,
      }),
    );
    expect(tap.snapshot().input_tokens).toBe(328);
    expect(tap.snapshot().output_tokens).toBe(1_204);
  });
});

describe("EXECUTION E9 usage tap — framing", () => {
  it("decides SSE from the upstream content-type, not from the request", () => {
    expect(isEventStream("text/event-stream; charset=utf-8")).toBe(true);
    expect(isEventStream("application/json")).toBe(false);
    expect(isEventStream(undefined)).toBe(false);
  });

  it("survives a garbage event without losing the ones around it", () => {
    const tap = feed(
      new GatewayUsageTap("anthropic", true),
      ANTHROPIC_MESSAGE_START,
      "event: ping\ndata: {not json at all\n\n",
      ": a comment line\n\n",
      ANTHROPIC_MESSAGE_DELTA,
    );
    expect(tap.snapshot().input_tokens).toBe(2095);
    expect(tap.snapshot().output_tokens).toBe(503);
  });

  it("handles a multi-line data field and CRLF line endings", () => {
    const json = JSON.stringify({
      type: "message_delta",
      delta: {},
      usage: { output_tokens: 9 },
    });
    const half = Math.floor(json.length / 2);
    const tap = feed(
      new GatewayUsageTap("anthropic", true),
      // SSE concatenates consecutive `data:` fields with a newline. JSON
      // tolerates the whitespace, so a provider splitting a payload this way
      // must still parse.
      `event: message_delta\r\ndata: ${json.slice(0, half)}\r\ndata: ${json.slice(half)}\r\n\r\n`,
    );
    expect(tap.snapshot().output_tokens).toBe(9);
  });
});
