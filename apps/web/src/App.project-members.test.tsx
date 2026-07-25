import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "./App";
import { setToken } from "./auth";
import { fullyAllocatedGraph, projectAlpha } from "./test/fixtures";
import { MockFetch } from "./test/mockFetch";

describe("project members workspace flow", () => {
  let mock: MockFetch;

  afterEach(() => mock.restore());

  it("opens the real project member list from the workspace navigation", async () => {
    const user = userEvent.setup();
    setToken("present");
    mock = new MockFetch();
    mock.get("/api/projects", { body: [projectAlpha] });
    mock.get(`/api/projects/${projectAlpha.id}/graph`, { body: fullyAllocatedGraph });
    mock.get(`/api/v2/projects/${projectAlpha.id}/resume`, { status: 404, body: {} });
    mock.get("/api/v2/attention", { status: 404, body: {} });
    mock.get(`/api/v2/projects/${projectAlpha.id}/access`, {
      body: {
        owner_user_id: "owner-1",
        can_access: true,
        can_manage_members: false,
        source: "membership",
      },
    });
    mock.get(`/api/v2/projects/${projectAlpha.id}/members`, {
      body: {
        owner_user_id: "owner-1",
        members: [
          {
            user_id: "owner-1",
            email: "owner@example.com",
            name: "Project Owner",
            workspace_role: "member",
            identity_status: "active",
            project_role: "owner",
            membership_status: "active",
          },
          {
            user_id: "test-user",
            email: "test@example.com",
            name: "Test User",
            workspace_role: "member",
            identity_status: "active",
            project_role: "member",
            membership_status: "active",
          },
        ],
      },
    });
    mock.install();

    render(<App />);
    await user.click(
      await screen.findByRole("button", { name: new RegExp(projectAlpha.name, "i") }),
    );
    await user.click(screen.getByRole("button", { name: "Members" }));

    expect(await screen.findByTestId("workspace-tab-members")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Project members" })).toBeInTheDocument();
    expect(screen.getByText("Project Owner")).toBeInTheDocument();
    expect(screen.getByText(/you can view this member list/i)).toBeInTheDocument();
  });
});
