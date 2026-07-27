import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  App,
  projectIdFromLocation,
  workConversationPath,
  workConversationRouteFromLocation,
} from "./App";
import { setToken } from "./auth";
import { fullyAllocatedGraph, projectAlpha } from "./test/fixtures";
import { MockFetch } from "./test/mockFetch";
import { preloadConversationWorkspaceForTest } from "./test/preloadConversationWorkspace";

const conversationId = "conversation-route-1";
const workItemId = "work-route-1";
const deepPath = workConversationPath(projectAlpha.id, conversationId);
const now = "2026-07-27T12:00:00.000Z";
const workItem = {
  schema_version: 2,
  id: workItemId,
  project_id: projectAlpha.id,
  created_by_user_id: "user-1",
  title: "Deep-linked planning",
  objective: "Restore this exact conversation.",
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
const conversation = {
  schema_version: 2,
  id: conversationId,
  project_id: projectAlpha.id,
  work_item_id: workItemId,
  created_by_user_id: "user-1",
  kind: "planning",
  status: "active",
  provider: "anthropic",
  model: "claude-sonnet-5",
  next_message_sequence: 1,
  created_at: now,
  updated_at: now,
  archived_at: null,
};

afterEach(() => {
  window.history.replaceState(null, "", "/");
});

describe("conversation deep links", () => {
  beforeAll(preloadConversationWorkspaceForTest);

  it("parses encoded conversation and explicit new-work routes", () => {
    window.history.replaceState(null, "", "/projects/project%20one/work/conversation%2Ftwo");
    expect(projectIdFromLocation()).toBe("project one");
    expect(workConversationRouteFromLocation()).toEqual({
      projectId: "project one",
      conversationId: "conversation/two",
    });

    window.history.replaceState(null, "", workConversationPath("project one"));
    expect(workConversationRouteFromLocation()).toEqual({
      projectId: "project one",
      conversationId: null,
    });

    window.history.replaceState(null, "", "/projects/project%20one");
    expect(projectIdFromLocation()).toBe("project one");
    expect(workConversationRouteFromLocation()).toBeNull();
  });

  it("restores a cold project Overview link", async () => {
    setToken("present");
    const projectPath = `/projects/${encodeURIComponent(projectAlpha.id)}`;
    window.history.replaceState(null, "", projectPath);
    const mock = new MockFetch();
    mock.get(`/api/projects/${projectAlpha.id}`, { body: projectAlpha });
    mock.get(`/api/projects/${projectAlpha.id}/graph`, { body: fullyAllocatedGraph });
    mock.get(`/api/v2/projects/${projectAlpha.id}/resume`, { status: 404, body: {} });
    mock.get("/api/v2/attention", { status: 404, body: {} });
    mock.get(`/api/v2/projects/${projectAlpha.id}/planning-runs`, {
      status: 404,
      body: {},
    });
    mock.get(`/api/v2/projects/${projectAlpha.id}/planning-runs/latest`, {
      status: 404,
      body: {},
    });
    mock.get(`/api/v2/projects/${projectAlpha.id}/execution-status`, {
      status: 404,
      body: {},
    });
    mock.install();

    render(<App />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Overview" })).toHaveAttribute(
        "aria-current",
        "page",
      ),
    );
    expect(screen.getByRole("heading", { level: 1, name: projectAlpha.name })).toBeInTheDocument();
    expect(screen.getByTestId("workspace-tab-overview")).toBeInTheDocument();
    expect(window.location.pathname).toBe(projectPath);
    expect(mock.calls).toContainEqual(
      expect.objectContaining({
        method: "GET",
        url: `/api/projects/${projectAlpha.id}`,
      }),
    );
    mock.restore();
  });

  it("restores a cold conversation link and returns to Overview on browser navigation", async () => {
    setToken("present");
    window.history.replaceState(null, "", deepPath);
    const mock = new MockFetch();
    mock.get(`/api/projects/${projectAlpha.id}`, { body: projectAlpha });
    mock.get(`/api/projects/${projectAlpha.id}/graph`, { body: fullyAllocatedGraph });
    mock.get(`/api/v2/projects/${projectAlpha.id}/resume`, { status: 404, body: {} });
    mock.get("/api/v2/attention", { status: 404, body: {} });
    mock.get(`/api/v2/projects/${projectAlpha.id}/planning-runs`, {
      status: 404,
      body: {},
    });
    mock.get(`/api/v2/projects/${projectAlpha.id}/planning-runs/latest`, {
      status: 404,
      body: {},
    });
    mock.get(`/api/v2/projects/${projectAlpha.id}/execution-status`, {
      status: 404,
      body: {},
    });
    mock.get(`/api/v2/projects/${projectAlpha.id}/work-items`, {
      body: { work_items: [{ work_item: workItem, conversations: [conversation] }] },
    });
    mock.get(
      `/api/v2/projects/${projectAlpha.id}/work-items/${workItemId}/conversations/${conversationId}`,
      {
        body: {
          work_item: workItem,
          conversation,
          messages: [],
          active_attempt: null,
          retryable_attempt: null,
          plan_versions: [],
          actions: [],
          plan_reviews: [],
          action_effects: [],
        },
      },
    );
    mock.install();

    render(<App />);

    expect(await screen.findByTestId("conversation-model-pin")).toHaveTextContent(
      "anthropic · claude-sonnet-5",
    );
    expect(window.location.pathname).toBe(deepPath);
    expect(screen.getByRole("button", { name: "Work" })).toHaveAttribute("aria-current", "page");

    window.history.pushState(null, "", `/projects/${projectAlpha.id}`);
    window.dispatchEvent(new PopStateEvent("popstate"));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Overview" })).toHaveAttribute(
        "aria-current",
        "page",
      ),
    );
    mock.restore();
  });
});
