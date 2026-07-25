import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectMembers } from "./ProjectMembers";
import { MockFetch } from "./test/mockFetch";

interface TestMember {
  user_id: string;
  email: string;
  name: string | null;
  workspace_role: "admin" | "member";
  identity_status: "active" | "invited" | "disabled";
  project_role: "owner" | "member";
  membership_status: "active" | "removed";
}

interface TestCandidate {
  user_id: string;
  email: string;
  name: string | null;
  workspace_role: "admin" | "member";
}

const owner: TestMember = {
  user_id: "owner-1",
  email: "owner@example.com",
  name: "Project Owner",
  workspace_role: "member",
  identity_status: "active",
  project_role: "owner",
  membership_status: "active",
};

const member: TestMember = {
  user_id: "member-1",
  email: "member@example.com",
  name: "Existing Member",
  workspace_role: "member",
  identity_status: "active",
  project_role: "member",
  membership_status: "active",
};

const outsider: TestCandidate = {
  user_id: "member-2",
  email: "new.member@example.com",
  name: "New Member",
  workspace_role: "member",
};

describe("ProjectMembers", () => {
  let mock: MockFetch;

  afterEach(() => mock.restore());

  it("lets an owner add and remove existing identities but never remove the owner", async () => {
    const user = userEvent.setup();
    let roster: TestMember[] = [owner, member];
    let candidates: TestCandidate[] = [outsider];
    let addAttempts = 0;
    mock = new MockFetch();
    mock.get("/api/v2/projects/project-1/access", {
      body: {
        owner_user_id: owner.user_id,
        can_access: true,
        can_manage_members: true,
        source: "owner",
      },
    });
    mock.get("/api/v2/projects/project-1/members", () => ({
      body: { owner_user_id: owner.user_id, members: roster },
    }));
    mock.get("/api/v2/projects/project-1/member-candidates", () => ({
      body: { candidates },
    }));
    mock.post("/api/v2/projects/project-1/members", () => {
      addAttempts += 1;
      if (addAttempts === 1) {
        return { status: 409, body: { message: "Membership could not be saved." } };
      }
      roster = [
        ...roster,
        {
          ...outsider,
          identity_status: "active" as const,
          project_role: "member" as const,
          membership_status: "active" as const,
        },
      ];
      candidates = [];
      return { body: { owner_user_id: owner.user_id, members: roster } };
    });
    mock.del("/api/v2/projects/project-1/members/member-1", () => {
      roster = roster.filter((entry) => entry.user_id !== member.user_id);
      candidates = [
        {
          user_id: member.user_id,
          email: member.email,
          name: member.name,
          workspace_role: member.workspace_role,
        },
      ];
      return { body: { owner_user_id: owner.user_id, members: roster } };
    });
    mock.install();

    render(<ProjectMembers projectId="project-1" onUnauthorized={vi.fn()} />);

    expect(await screen.findByText("Project Owner")).toBeInTheDocument();
    const ownerRow = screen.getByText("Project Owner").closest("tr");
    expect(ownerRow).not.toBeNull();
    expect(
      within(ownerRow as HTMLElement).getByText("Owner cannot be removed"),
    ).toBeInTheDocument();
    expect(
      within(ownerRow as HTMLElement).queryByRole("button", { name: /remove/i }),
    ).not.toBeInTheDocument();

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Add an existing workspace member" }),
      outsider.user_id,
    );
    await user.click(screen.getByRole("button", { name: "Add member" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Membership could not be saved.");

    await user.click(screen.getByRole("button", { name: "Add member" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Member added.");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(await screen.findByText("New Member")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Remove Existing Member" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Member removed.");
    await waitFor(() => expect(screen.queryByText("Existing Member")).not.toBeInTheDocument());
  });

  it("gives a workspace administrator the same membership controls", async () => {
    mock = new MockFetch();
    mock.get("/api/v2/projects/project-1/access", {
      body: {
        owner_user_id: owner.user_id,
        can_access: true,
        can_manage_members: true,
        source: "admin",
      },
    });
    mock.get("/api/v2/projects/project-1/members", {
      body: { owner_user_id: owner.user_id, members: [owner, member] },
    });
    mock.get("/api/v2/projects/project-1/member-candidates", {
      body: { candidates: [outsider] },
    });
    mock.install();

    render(<ProjectMembers projectId="project-1" onUnauthorized={vi.fn()} />);

    expect(await screen.findByText("Manage access")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove Existing Member" })).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "Add an existing workspace member" }),
    ).toBeEnabled();
  });

  it("shows standard members a read-only active-member list", async () => {
    mock = new MockFetch();
    mock.get("/api/v2/projects/project-1/access", {
      body: {
        owner_user_id: owner.user_id,
        can_access: true,
        can_manage_members: false,
        source: "membership",
      },
    });
    mock.get("/api/v2/projects/project-1/members", {
      body: {
        owner_user_id: owner.user_id,
        members: [
          owner,
          member,
          {
            ...outsider,
            identity_status: "active",
            project_role: "member",
            membership_status: "removed",
          },
        ],
      },
    });
    mock.install();

    render(<ProjectMembers projectId="project-1" onUnauthorized={vi.fn()} />);

    expect(await screen.findByText("Existing Member")).toBeInTheDocument();
    expect(screen.queryByText("New Member")).not.toBeInTheDocument();
    expect(screen.getByText(/you can view this member list/i)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /remove existing member/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("does not load project membership for a non-member and reports expired sessions", async () => {
    const onUnauthorized = vi.fn();
    mock = new MockFetch();
    mock.get("/api/v2/projects/project-1/access", {
      body: {
        owner_user_id: owner.user_id,
        can_access: false,
        can_manage_members: false,
        source: "none",
      },
    });
    mock.install();

    const { rerender } = render(
      <ProjectMembers projectId="project-1" onUnauthorized={onUnauthorized} />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "You do not have access to this project.",
    );
    expect(mock.calls.some((call) => call.url.endsWith("/members"))).toBe(false);

    mock.get("/api/v2/projects/project-2/access", {
      status: 401,
      body: { error: "unauthorized" },
    });
    rerender(<ProjectMembers projectId="project-2" onUnauthorized={onUnauthorized} />);
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1));
  });
});
