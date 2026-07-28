import { parseJsonEventStream, uiMessageChunkSchema } from "ai";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ConversationRouteOptions,
  registerConversationRoutes,
  streamPrepared,
} from "../src/conversations/routes.js";
import {
  ConversationTurnError,
  type PreparedConversationTurn,
} from "../src/conversations/turnService.js";

describe("AI SDK UI protocol conversation stream", () => {
  const app = Fastify();

  beforeAll(async () => {
    app.get("/stream", async (request, reply) => {
      const prepared: PreparedConversationTurn = {
        attempt: {} as PreparedConversationTurn["attempt"],
        outputMessageId: "message-ui-stream",
        cancel: () => undefined,
        run: async (callbacks) => {
          callbacks.text("Hello ");
          callbacks.text("there");
          callbacks.finished({
            provider_finish_reason: "completed",
          } as PreparedConversationTurn["attempt"]);
        },
      };
      await streamPrepared(request, reply, prepared);
    });
    app.get("/abort", async (request, reply) => {
      const prepared: PreparedConversationTurn = {
        attempt: {} as PreparedConversationTurn["attempt"],
        outputMessageId: "message-ui-abort",
        cancel: () => undefined,
        run: async () => {
          throw new ConversationTurnError("cancelled", "response stopped", 499);
        },
      };
      await streamPrepared(request, reply, prepared);
    });
    app.get("/error", async (request, reply) => {
      const prepared: PreparedConversationTurn = {
        attempt: {} as PreparedConversationTurn["attempt"],
        outputMessageId: "message-ui-error",
        cancel: () => undefined,
        run: async () => {
          throw new ConversationTurnError("network", "provider stream failed (network)", 502);
        },
      };
      await streamPrepared(request, reply, prepared);
    });
    registerConversationRoutes(app, {
      requireUser: async () => ({ id: "user-route" }),
      conversations: {
        getConversation: async () => ({
          work_item: { id: "work-route" },
          conversation: { id: "conversation-route" },
        }),
        listMessages: async () => [],
        renameWorkItem: async (
          _user: unknown,
          projectId: string,
          workItemId: string,
          title: string,
        ) => ({
          id: workItemId,
          project_id: projectId,
          title,
        }),
      },
      attempts: {
        active: async () => null,
        latestRetryableAttempt: async () => ({
          id: "attempt-route",
          triggering_message_id: "message-route",
          status: "cancelled",
          output_message_id: null,
        }),
      },
      turns: {},
      pinForProject: async () => ({ provider: "openai", model: "mock-openai" }),
    } as unknown as ConversationRouteOptions);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("emits an AI SDK v1 SSE stream that the official parser accepts", async () => {
    const response = await app.inject({ method: "GET", url: "/stream" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["x-vercel-ai-ui-message-stream"]).toBe("v1");
    expect(response.headers["content-type"]).toContain("text/event-stream");

    const body = new Response(response.rawPayload).body;
    if (!body) throw new Error("missing stream body");
    const parsed = parseJsonEventStream({ stream: body, schema: uiMessageChunkSchema });
    const chunks: unknown[] = [];
    for await (const result of parsed) {
      expect(result.success).toBe(true);
      if (result.success) chunks.push(result.value);
    }
    expect(chunks).toEqual([
      { type: "start", messageId: "message-ui-stream" },
      { type: "text-start", id: "message-ui-stream:text" },
      { type: "text-delta", id: "message-ui-stream:text", delta: "Hello " },
      { type: "text-delta", id: "message-ui-stream:text", delta: "there" },
      { type: "text-end", id: "message-ui-stream:text" },
      { type: "finish", finishReason: "stop" },
    ]);
  });

  it.each([
    [
      "/abort",
      [
        { type: "start", messageId: "message-ui-abort" },
        { type: "text-start", id: "message-ui-abort:text" },
        { type: "abort", reason: "stopped" },
      ],
    ],
    [
      "/error",
      [
        { type: "start", messageId: "message-ui-error" },
        { type: "text-start", id: "message-ui-error:text" },
        { type: "error", errorText: "provider stream failed (network)" },
      ],
    ],
  ])("emits a parser-valid terminal protocol for %s", async (url, expected) => {
    const response = await app.inject({ method: "GET", url });
    const body = new Response(response.rawPayload).body;
    if (!body) throw new Error("missing stream body");
    const parsed = parseJsonEventStream({ stream: body, schema: uiMessageChunkSchema });
    const chunks: unknown[] = [];
    for await (const result of parsed) {
      expect(result.success).toBe(true);
      if (result.success) chunks.push(result.value);
    }
    expect(chunks).toEqual(expected);
  });

  it("exposes a terminal pre-visible attempt for a truthful resume banner", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v2/projects/project-route/work-items/work-route/conversations/conversation-route",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      active_attempt: null,
      retryable_attempt: {
        id: "attempt-route",
        triggering_message_id: "message-route",
        status: "cancelled",
        output_message_id: null,
      },
    });
  });

  it("renames the durable work-item title", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: "/api/v2/projects/project-route/work-items/work-route",
      payload: { title: "Renamed from the title bar" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      work_item: {
        id: "work-route",
        project_id: "project-route",
        title: "Renamed from the title bar",
      },
    });
  });
});
