// EXECUTION E9 — reading token usage out of a stream we are only forwarding.
//
// THE CONSTRAINT THAT SHAPES THIS FILE. The gateway is a forwarder: it does not
// parse the provider's response in order to understand it, and it never
// re-serializes it. Bytes go out exactly as they came in. But metering has to
// happen, and the only place the token counts exist is inside those bytes. So
// this module is a TAP: it is fed a copy of every chunk as it passes, it reads
// the two or three numbers it needs, and it is structurally incapable of
// altering the stream. If the tap throws, misparses, or meets a shape it has
// never seen, the caller still forwards the bytes untouched — a parse failure
// must degrade metering, never the agent's response.
//
// WHY IT IS INCREMENTAL AND NOT "PARSE THE FINISHED BODY". A stream that dies
// mid-flight has still cost money. Anthropic emits the input-token count in the
// FIRST event (`message_start`) and a running output count on every
// `message_delta`, so a tap that updates as it goes can meter a truncated
// stream honestly. Buffering the whole body and parsing at the end would meter
// exactly nothing in the case that matters most.
//
// PAYLOAD SHAPES ARE TAKEN FROM THE INSTALLED SDKS, NOT FROM MEMORY:
//   Anthropic  @anthropic-ai/sdk 0.112.3
//     resources/messages/messages.d.ts `MessageDeltaUsage`  — output_tokens is
//     "the CUMULATIVE number of output tokens", input_tokens/cache_* likewise
//     cumulative and nullable; `Usage` on message_start carries input_tokens,
//     cache_creation_input_tokens, cache_read_input_tokens.
//   OpenAI     openai 6.48.0
//     resources/responses/responses.d.ts `ResponseUsage` — input_tokens,
//     output_tokens, total_tokens, nested under `response.usage` on the
//     terminal `response.completed` / `response.incomplete` / `response.failed`
//     events (each of which carries a full `Response`).

/** The only three numbers metering needs, plus the cache split for honesty. */
export interface GatewayTokenUsage {
  input_tokens: number;
  output_tokens: number;
  /** Anthropic only; 0 elsewhere. Billed at the input rate here (see below). */
  cache_read_input_tokens: number;
  /** Anthropic only; 0 elsewhere. */
  cache_creation_input_tokens: number;
}

export function emptyUsage(): GatewayTokenUsage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
}

/**
 * Tokens charged at the registry's single input rate.
 *
 * The registry prices one input rate per model, but Anthropic bills cache
 * READS at roughly a tenth of it and cache WRITES at rather more. Charging all
 * three at the full input rate over-charges cache reads. That is the deliberate
 * direction: over-charging shrinks a run's remaining budget slightly faster
 * than reality, which refuses early. Under-charging would let a run spend past
 * what a human approved, which is the failure this whole subsystem exists to
 * prevent.
 */
export function billableInputTokens(usage: GatewayTokenUsage): number {
  return usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens;
}

function finiteInt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// ---------------------------------------------------------------------------
// SSE framing
// ---------------------------------------------------------------------------

/**
 * A minimal, allocation-cheap SSE reassembler.
 *
 * It exists because chunk boundaries are arbitrary: a single `data:` line
 * routinely arrives split across two TCP reads, and a tap that parsed
 * per-chunk would silently drop the very event that carries the usage. Only
 * `data:` fields are collected — `event:`, `id:`, `retry:` and comments are
 * ignored, because both providers repeat the discriminator inside the JSON.
 *
 * Deliberately tolerant: an unparseable event is skipped, never thrown.
 */
export class SseEventReassembler {
  private readonly decoder = new TextDecoder("utf-8");
  private buffer = "";
  private data: string[] = [];

  constructor(private readonly onEvent: (data: string) => void) {}

  push(chunk: Uint8Array): void {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    this.drain();
  }

  /** Flush whatever a truncated stream left behind. Safe to call twice. */
  end(): void {
    this.buffer += this.decoder.decode();
    this.drain();
    // A stream cut mid-event leaves data lines with no terminating blank line.
    // Emit them anyway: on Anthropic that is exactly the last `message_delta`,
    // which is the most valuable usage reading we will ever get from a dying
    // stream.
    this.flush();
    this.buffer = "";
  }

  private drain(): void {
    for (;;) {
      const index = this.buffer.indexOf("\n");
      if (index === -1) return;
      let line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line === "") {
        this.flush();
        continue;
      }
      if (line.startsWith(":")) continue;
      if (line.startsWith("data:")) {
        const value = line.slice(5);
        this.data.push(value.startsWith(" ") ? value.slice(1) : value);
      }
    }
  }

  private flush(): void {
    if (this.data.length === 0) return;
    const payload = this.data.join("\n");
    this.data = [];
    if (payload === "[DONE]") return;
    try {
      this.onEvent(payload);
    } catch {
      // A tap must never be able to break the stream it is observing.
    }
  }
}

// ---------------------------------------------------------------------------
// The tap
// ---------------------------------------------------------------------------

export type GatewayProvider = "anthropic" | "openai";

/**
 * Observes forwarded response bytes and accumulates usage.
 *
 * `streaming` is decided from the UPSTREAM response's content-type, not from
 * what the caller asked for: a provider may answer a `stream: true` request
 * with a plain JSON error body, and that body still has to be read correctly.
 */
export class GatewayUsageTap {
  private readonly usageSoFar = mutableUsage();
  private sawAny = false;
  private sawTerminalEvent = false;
  private readonly sse: SseEventReassembler | null;
  private jsonChunks: string[] = [];
  private readonly decoder = new TextDecoder("utf-8");

  constructor(
    private readonly provider: GatewayProvider,
    streaming: boolean,
  ) {
    this.sse = streaming
      ? new SseEventReassembler((data) => {
          const parsed = safeJson(data);
          if (parsed) this.absorbEvent(parsed);
        })
      : null;
  }

  push(chunk: Uint8Array): void {
    if (this.sse) this.sse.push(chunk);
    else this.jsonChunks.push(this.decoder.decode(chunk, { stream: true }));
  }

  end(): void {
    if (this.sse) {
      this.sse.end();
      return;
    }
    this.jsonChunks.push(this.decoder.decode());
    const parsed = safeJson(this.jsonChunks.join(""));
    this.jsonChunks = [];
    if (parsed) this.absorbBody(parsed);
  }

  /** True once a usage figure has been observed at all. */
  get observed(): boolean {
    return this.sawAny;
  }

  /**
   * True when the stream reached a terminal event carrying final usage. False
   * means the numbers below are a floor, not a total — the caller records them
   * anyway and says so in the audit line.
   */
  get complete(): boolean {
    return this.sawTerminalEvent;
  }

  snapshot(): GatewayTokenUsage {
    return { ...this.usageSoFar };
  }

  // -- provider-specific readers --------------------------------------------

  private absorbEvent(event: Record<string, unknown>): void {
    if (this.provider === "anthropic") this.absorbAnthropicEvent(event);
    else this.absorbOpenAiEvent(event);
  }

  private absorbBody(body: Record<string, unknown>): void {
    if (this.provider === "anthropic") {
      // Non-streaming Messages: `usage` sits at the top level of the Message.
      if (this.takeAnthropicUsage(record(body.usage))) this.sawTerminalEvent = true;
      return;
    }
    // Non-streaming Responses: `usage` sits at the top level of the Response.
    if (this.takeOpenAiUsage(record(body.usage))) this.sawTerminalEvent = true;
  }

  private absorbAnthropicEvent(event: Record<string, unknown>): void {
    const type = event.type;
    if (type === "message_start") {
      // The input-token count, available before a single output token exists.
      // This is what makes a dying stream meterable.
      const message = record(event.message);
      if (message) this.takeAnthropicUsage(record(message.usage));
      return;
    }
    if (type === "message_delta") {
      // Cumulative, per MessageDeltaUsage — assign, never add.
      if (this.takeAnthropicUsage(record(event.usage))) this.sawTerminalEvent = true;
      return;
    }
  }

  private takeAnthropicUsage(usage: Record<string, unknown> | null): boolean {
    if (!usage) return false;
    let took = false;
    // Every field is cumulative and independently nullable, so each one is
    // taken only when present and only when it does not move a counter
    // backwards. A late event that omits input_tokens must not zero it.
    for (const [key, field] of [
      ["input_tokens", "input_tokens"],
      ["output_tokens", "output_tokens"],
      ["cache_read_input_tokens", "cache_read_input_tokens"],
      ["cache_creation_input_tokens", "cache_creation_input_tokens"],
    ] as const) {
      const value = finiteInt(usage[key]);
      if (value === null) continue;
      if (value >= this.usageSoFar[field]) this.usageSoFar[field] = value;
      took = true;
    }
    if (took) this.sawAny = true;
    return took;
  }

  private absorbOpenAiEvent(event: Record<string, unknown>): void {
    // Every terminal Responses event (`response.completed`, `response.incomplete`,
    // `response.failed`) carries a full Response object; usage lives on it.
    // Matching on the presence of `response.usage` rather than on an event-name
    // allowlist is the forwarder-shaped choice: a terminal event type we have
    // never heard of still meters correctly.
    const response = record(event.response);
    if (!response) return;
    if (this.takeOpenAiUsage(record(response.usage))) {
      const type = typeof event.type === "string" ? event.type : "";
      // `response.completed|incomplete|failed` are terminal. `response.created`
      // and `response.in_progress` carry a usage-less Response, so they never
      // reach here; anything else that does is treated as provisional.
      this.sawTerminalEvent =
        this.sawTerminalEvent ||
        type === "response.completed" ||
        type === "response.incomplete" ||
        type === "response.failed";
    }
  }

  private takeOpenAiUsage(usage: Record<string, unknown> | null): boolean {
    if (!usage) return false;
    const input = finiteInt(usage.input_tokens);
    const output = finiteInt(usage.output_tokens);
    if (input === null && output === null) return false;
    // ResponseUsage.input_tokens is inclusive of cached tokens, so the cache
    // split is observability only and is never added on top.
    if (input !== null && input >= this.usageSoFar.input_tokens) {
      this.usageSoFar.input_tokens = input;
    }
    if (output !== null && output >= this.usageSoFar.output_tokens) {
      this.usageSoFar.output_tokens = output;
    }
    this.sawAny = true;
    return true;
  }
}

function mutableUsage(): GatewayTokenUsage {
  return emptyUsage();
}

function safeJson(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  try {
    return record(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

/**
 * Does this response body need SSE framing?
 *
 * Read from the upstream `content-type` alone. A `stream: true` request whose
 * upstream answer is `application/json` is an error body, and treating it as
 * SSE would meter nothing at all.
 */
export function isEventStream(contentType: string | undefined | null): boolean {
  return typeof contentType === "string" && contentType.toLowerCase().includes("text/event-stream");
}
