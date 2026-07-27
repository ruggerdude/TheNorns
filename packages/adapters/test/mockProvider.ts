// A local mock of both providers' HTTP APIs, reached through the official
// SDKs via baseURL override — the adapters exercise their real code paths.
// Behavior is keyed by markers in the prompt text.
import { type Server, createServer } from "node:http";

const MARKERS: Record<string, number> = {
  TRIGGER_429: 429,
  TRIGGER_401: 401,
  TRIGGER_500: 500,
};

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => {
      data += String(chunk);
    });
    req.on("end", () => resolve(data));
  });
}

export interface MockProvider {
  url: string;
  requests: Array<{ url: string; body: string }>;
  close: () => Promise<void>;
}

export async function startMockProvider(): Promise<MockProvider> {
  const requests: Array<{ url: string; body: string }> = [];
  const server: Server = createServer(async (req, res) => {
    const body = await readBody(req);
    requests.push({ url: req.url ?? "", body });
    const json = (status: number, payload: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };

    for (const [marker, status] of Object.entries(MARKERS)) {
      if (body.includes(marker)) {
        json(status, { error: { type: "mock_error", message: `mock ${status}` } });
        return;
      }
    }

    const finish = (): void => {
      const structured = body.includes("STRUCTURED");
      const text = structured
        ? JSON.stringify({ name: "mock", count: 3 })
        : "hello from the mock provider";
      const streaming = (() => {
        try {
          return JSON.parse(body).stream === true;
        } catch {
          return false;
        }
      })();

      if (req.url?.includes("/messages")) {
        if (streaming) {
          res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          });
          const event = (name: string, payload: unknown): void => {
            res.write(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`);
          };
          event("message_start", {
            type: "message_start",
            message: {
              id: "msg_mock",
              type: "message",
              role: "assistant",
              model: "mock-anthropic",
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: {
                input_tokens: 100,
                output_tokens: 0,
                cache_read_input_tokens: 15,
                cache_creation_input_tokens: 5,
              },
            },
          });
          event("content_block_start", {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          });
          event("content_block_delta", {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text },
          });
          event("content_block_stop", { type: "content_block_stop", index: 0 });
          event("message_delta", {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 45 },
          });
          event("message_stop", { type: "message_stop" });
          res.end();
          return;
        }
        // Anthropic Messages API shape
        json(200, {
          id: "msg_mock",
          type: "message",
          role: "assistant",
          model: "mock-anthropic",
          content: [{ type: "text", text }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: {
            input_tokens: 100,
            output_tokens: 45,
            cache_read_input_tokens: 15,
            cache_creation_input_tokens: 5,
          },
        });
      } else if (req.url?.includes("/responses")) {
        if (streaming) {
          const omitTerminalOutputText = body.includes("TRIGGER_STREAM_NO_OUTPUT_TEXT");
          const response = {
            id: "resp_mock",
            object: "response",
            created_at: 0,
            model: "mock-openai",
            status: "completed",
            error: null,
            incomplete_details: null,
            ...(omitTerminalOutputText ? {} : { output_text: text }),
            output: [
              {
                id: "msg_mock",
                type: "message",
                status: "completed",
                role: "assistant",
                content: [{ type: "output_text", text, annotations: [], logprobs: [] }],
              },
            ],
            usage: {
              input_tokens: 120,
              output_tokens: 45,
              total_tokens: 165,
              input_tokens_details: { cached_tokens: 15, cache_write_tokens: 5 },
              output_tokens_details: { reasoning_tokens: 0 },
            },
          };
          res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          });
          const event = (payload: unknown): void => {
            res.write(`data: ${JSON.stringify(payload)}\n\n`);
          };
          event({
            type: "response.created",
            sequence_number: 0,
            response: { ...response, status: "in_progress", output: [], usage: null },
          });
          event({
            type: "response.output_text.delta",
            sequence_number: 1,
            item_id: "msg_mock",
            output_index: 0,
            content_index: 0,
            delta: text,
            logprobs: [],
          });
          event({ type: "response.completed", sequence_number: 2, response });
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
        // OpenAI Responses API shape
        json(200, {
          id: "resp_mock",
          object: "response",
          created_at: 0,
          model: "mock-openai",
          status: "completed",
          error: null,
          incomplete_details: null,
          output_text: text,
          output: [
            {
              id: "msg_mock",
              type: "message",
              status: "completed",
              role: "assistant",
              content: [{ type: "output_text", text, annotations: [], logprobs: [] }],
            },
          ],
          usage: {
            input_tokens: 120,
            output_tokens: 45,
            total_tokens: 165,
            input_tokens_details: { cached_tokens: 15, cache_write_tokens: 5 },
            output_tokens_details: { reasoning_tokens: 0 },
          },
        });
      } else {
        // OpenAI Chat Completions shape
        json(200, {
          id: "chatcmpl_mock",
          object: "chat.completion",
          created: 0,
          model: "mock-openai",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: text },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 120, completion_tokens: 45, total_tokens: 165 },
        });
      }
    };

    // TRIGGER_HANG: delay long enough for the abort test to cancel first
    if (body.includes("TRIGGER_HANG")) {
      setTimeout(finish, 5000);
      return;
    }
    finish();
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
