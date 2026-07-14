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
  close: () => Promise<void>;
}

export async function startMockProvider(): Promise<MockProvider> {
  const server: Server = createServer(async (req, res) => {
    const body = await readBody(req);
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

      if (req.url?.includes("/messages")) {
        // Anthropic Messages API shape
        json(200, {
          id: "msg_mock",
          type: "message",
          role: "assistant",
          model: "mock-anthropic",
          content: [{ type: "text", text }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 120, output_tokens: 45 },
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
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
