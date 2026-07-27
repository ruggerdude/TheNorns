import type { V2WorkConversationT, V2WorkItemT, V2WorkMessageT } from "@norns/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationWorkspace } from "./ConversationWorkspace";

const projectId = "project-conversation";
const workItemId = "work-item-1";
const conversationId = "conversation-1";
const now = "2026-07-27T12:00:00.000Z";

const workItem: V2WorkItemT = {
  schema_version: 2,
  id: workItemId,
  project_id: projectId,
  created_by_user_id: "user-1",
  title: "Conversation-first planning",
  objective: "Plan a durable project conversation.",
  status: "planning",
  planning_run_id: null,
  phase_id: null,
  approved_plan_version_id: null,
  aggregate_version: 1,
  created_at: now,
  updated_at: now,
  execution_started_at: null,
  completed_at: null,
};

const conversation: V2WorkConversationT = {
  schema_version: 2,
  id: conversationId,
  project_id: projectId,
  work_item_id: workItemId,
  created_by_user_id: "user-1",
  kind: "planning",
  status: "active",
  provider: "anthropic",
  model: "claude-sonnet-5",
  next_message_sequence: 3,
  created_at: now,
  updated_at: now,
  archived_at: null,
};

function message(
  overrides: Pick<V2WorkMessageT, "id" | "role" | "sequence" | "parts"> & Partial<V2WorkMessageT>,
): V2WorkMessageT {
  const isUser = overrides.role === "user";
  return {
    schema_version: 2,
    project_id: projectId,
    work_item_id: workItemId,
    conversation_id: conversationId,
    initiated_by_user_id: "user-1",
    actor: isUser
      ? { actor_type: "human", actor_id: "user-1" }
      : { actor_type: "agent", actor_id: "project-pm" },
    visibility_status: "complete",
    client_message_id: isUser ? `client-${overrides.id}` : null,
    request_fingerprint: isUser ? "a".repeat(64) : null,
    created_at: now,
    ...overrides,
  };
}

function listResponse(): Response {
  return Response.json({
    work_items: [{ work_item: workItem, conversations: [conversation] }],
  });
}

function detailResponse(
  messages: V2WorkMessageT[] = [],
  activeAttempt: unknown = null,
  retryableAttempt: unknown = null,
): Response {
  return Response.json({
    work_item: workItem,
    conversation,
    messages,
    active_attempt: activeAttempt,
    retryable_attempt: retryableAttempt,
  });
}

function urlOf(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("conversation workspace", () => {
  it("restores durable visible history, structured parts, and the pinned PM", async () => {
    const history = [
      message({
        id: "message-user",
        role: "user",
        sequence: 1,
        parts: [{ type: "text", format: "markdown", text: "Please inspect the API." }],
      }),
      message({
        id: "message-assistant",
        role: "assistant",
        sequence: 2,
        parts: [
          { type: "text", format: "markdown", text: "I found **one risk**." },
          { type: "code", language: "ts", code: "const durable = true;" },
          {
            type: "artifact",
            artifact_id: "artifact-1",
            label: "API review",
            media_type: "text/markdown",
          },
        ],
      }),
    ];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url.endsWith("/work-items")) return listResponse();
      if (url.endsWith(`/conversations/${conversationId}`)) return detailResponse(history);
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const view = render(
      <ConversationWorkspace
        projectId={projectId}
        initialConversationId={conversationId}
        onConversationSelected={() => undefined}
        onUnsupported={() => undefined}
        onUnauthorized={() => undefined}
      />,
    );

    expect(await screen.findByText("Please inspect the API.")).toBeInTheDocument();
    expect(screen.getByText("one risk")).toBeInTheDocument();
    expect(screen.getByText("const durable = true;")).toBeInTheDocument();
    expect(screen.getByTestId("conversation-artifact")).toHaveTextContent("API review");
    expect(screen.getByTestId("conversation-model-pin")).toHaveTextContent(
      "anthropic · claude-sonnet-5",
    );
    expect(screen.queryByTestId("conversation-welcome")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry response" })).not.toBeInTheDocument();

    const callsBeforeParentRerender = fetchMock.mock.calls.length;
    view.rerender(
      <ConversationWorkspace
        projectId={projectId}
        initialConversationId={conversationId}
        onConversationSelected={() => undefined}
        onUnsupported={() => undefined}
        onUnauthorized={() => undefined}
      />,
    );
    await new Promise((resolve) => window.setTimeout(resolve, 20));

    expect(fetchMock).toHaveBeenCalledTimes(callsBeforeParentRerender);
    expect(screen.getByText("Please inspect the API.")).toBeInTheDocument();
    expect(screen.getByTestId("conversation-model-pin")).toBeInTheDocument();
  });

  it("submits the visible parts through the AI SDK stream and hides the welcome immediately", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let submitted = false;
    const persistedAfterStream = [
      message({
        id: "message-user-stream",
        role: "user",
        sequence: 1,
        parts: [{ type: "text", format: "markdown", text: "Draft the plan" }],
      }),
      message({
        id: "message-assistant-stream",
        role: "assistant",
        sequence: 2,
        parts: [{ type: "text", format: "markdown", text: "Streaming **works**." }],
      }),
    ];
    const stream =
      'data: {"type":"start","messageId":"message-assistant-stream"}\n\n' +
      'data: {"type":"text-start","id":"text-1"}\n\n' +
      'data: {"type":"text-delta","id":"text-1","delta":"Streaming **works**."}\n\n' +
      'data: {"type":"text-end","id":"text-1"}\n\n' +
      'data: {"type":"data-usage","data":{"input_tokens":12,"output_tokens":4,"cost_usd":0.0012},"transient":true}\n\n' +
      'data: {"type":"finish","finishReason":"stop"}\n\n' +
      "data: [DONE]\n\n";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = urlOf(input);
        calls.push({ url, init });
        if (url.endsWith("/work-items")) return listResponse();
        if (
          url.endsWith(`/conversations/${conversationId}`) &&
          (!init?.method || init.method === "GET")
        ) {
          return detailResponse(submitted ? persistedAfterStream : []);
        }
        if (url.endsWith(`/conversations/${conversationId}/messages`) && init?.method === "POST") {
          submitted = true;
          return new Response(stream, {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
              "x-vercel-ai-ui-message-stream": "v1",
            },
          });
        }
        throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
      }),
    );
    const user = userEvent.setup();

    render(
      <ConversationWorkspace
        projectId={projectId}
        initialConversationId={conversationId}
        onUnauthorized={() => undefined}
      />,
    );

    const composer = await screen.findByRole("textbox", { name: "Message the project PM" });
    expect(screen.getByTestId("conversation-welcome")).toBeInTheDocument();
    await user.type(composer, "Draft the plan{enter}");

    await waitFor(() =>
      expect(screen.queryByTestId("conversation-welcome")).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(screen.getByText("works")).toBeInTheDocument());

    const submit = calls.find(
      ({ url, init }) => url.endsWith("/messages") && init?.method === "POST",
    );
    expect(submit).toBeDefined();
    expect(JSON.parse(String(submit?.init?.body))).toMatchObject({
      parts: [{ type: "text", format: "markdown", text: "Draft the plan" }],
    });
    expect(JSON.parse(String(submit?.init?.body)).client_message_id).toEqual(expect.any(String));
  });

  it("keeps new-work mode explicit instead of silently reopening the latest conversation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = urlOf(input);
        if (url.endsWith("/work-items")) return listResponse();
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    render(
      <ConversationWorkspace
        projectId={projectId}
        initialNewConversation
        onUnauthorized={() => undefined}
      />,
    );

    expect(
      await screen.findByRole("heading", { name: "What work should the PM help you plan?" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Please inspect the API.")).not.toBeInTheDocument();
  });

  it("offers a truthful status refresh instead of claiming an active stream can resume", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url.endsWith("/work-items")) return listResponse();
      if (url.endsWith(`/conversations/${conversationId}`)) {
        return detailResponse([], { status: "streaming" });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(
      <ConversationWorkspace
        projectId={projectId}
        initialConversationId={conversationId}
        onUnauthorized={() => undefined}
      />,
    );

    expect(await screen.findByText("A PM response is streaming.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resume response" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Refresh status" }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([input]) =>
          urlOf(input as RequestInfo | URL).endsWith(`/conversations/${conversationId}`),
        ),
      ).toHaveLength(2),
    );
  });

  it("retries the latest terminal pre-visible failure without advertising stale retries", async () => {
    const userMessage = message({
      id: "message-user-retry",
      role: "user",
      sequence: 1,
      parts: [{ type: "text", format: "markdown", text: "Try the provider." }],
    });
    const assistantMessage = message({
      id: "message-assistant-retry",
      role: "assistant",
      sequence: 2,
      parts: [{ type: "text", format: "markdown", text: "The fresh retry worked." }],
    });
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let retried = false;
    const stream =
      'data: {"type":"start","messageId":"message-assistant-retry"}\n\n' +
      'data: {"type":"text-start","id":"text-retry"}\n\n' +
      'data: {"type":"text-delta","id":"text-retry","delta":"The fresh retry worked."}\n\n' +
      'data: {"type":"text-end","id":"text-retry"}\n\n' +
      'data: {"type":"finish","finishReason":"stop"}\n\n' +
      "data: [DONE]\n\n";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = urlOf(input);
        calls.push({ url, init });
        if (url.endsWith("/work-items")) return listResponse();
        if (
          url.endsWith(`/conversations/${conversationId}`) &&
          (!init?.method || init.method === "GET")
        ) {
          return detailResponse(
            retried ? [userMessage, assistantMessage] : [userMessage],
            null,
            retried ? null : { status: "failed", output_message_id: null },
          );
        }
        if (url.endsWith(`/conversations/${conversationId}/resume`) && init?.method === "POST") {
          retried = true;
          return new Response(stream, {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
              "x-vercel-ai-ui-message-stream": "v1",
            },
          });
        }
        throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
      }),
    );
    const user = userEvent.setup();

    render(
      <ConversationWorkspace
        projectId={projectId}
        initialConversationId={conversationId}
        onUnauthorized={() => undefined}
      />,
    );

    expect(
      await screen.findByText("The last PM response failed before it completed."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry response" }));

    expect(await screen.findByText("The fresh retry worked.")).toBeInTheDocument();
    const retry = calls.find(({ url, init }) => url.endsWith("/resume") && init?.method === "POST");
    expect(JSON.parse(String(retry?.init?.body))).toEqual({});
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Retry response" })).not.toBeInTheDocument(),
    );
  });
});
