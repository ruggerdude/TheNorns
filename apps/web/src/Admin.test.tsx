import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { Admin } from "./Admin";
import { MockFetch } from "./test/mockFetch";

function makeRoster() {
  return [
    {
      id: "u1",
      email: "admin@x.com",
      name: "Ada",
      role: "admin",
      status: "active",
      created_at: "t",
    },
    {
      id: "u2",
      email: "member@x.com",
      name: null,
      role: "member",
      status: "active",
      created_at: "t",
    },
  ];
}

describe("Admin panel", () => {
  let mock: MockFetch;

  beforeEach(() => {
    mock = new MockFetch();
  });

  test("loads and lists the current roster", async () => {
    mock.get("/api/admin/users", { body: makeRoster() });
    mock.install();
    render(<Admin onClose={vi.fn()} onUnauthorized={vi.fn()} />);

    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(screen.queryByText("Computers")).not.toBeInTheDocument();
    expect(screen.queryByText("Archived projects")).not.toBeInTheDocument();
    expect(screen.queryByText("Global agent rules")).not.toBeInTheDocument();
    const list = await screen.findByTestId("user-list");
    expect(list).toHaveTextContent("admin@x.com");
    expect(list).toHaveTextContent("member@x.com");
  });

  test("promotes and demotes existing users without removing them", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const roster = makeRoster();
    mock.get("/api/admin/users", { body: roster });
    mock.patch("/api/admin/users/u2/role", (_url, init) => {
      const body = JSON.parse(init?.body as string);
      expect(body).toEqual({ role: "admin" });
      const member = roster[1];
      if (!member) throw new Error("member fixture is missing");
      member.role = "admin";
      return { body: member };
    });
    mock.patch("/api/admin/users/u1/role", (_url, init) => {
      const body = JSON.parse(init?.body as string);
      expect(body).toEqual({ role: "member" });
      const admin = roster[0];
      if (!admin) throw new Error("admin fixture is missing");
      admin.role = "member";
      return { body: admin };
    });
    mock.install();

    const onCurrentUserRoleChanged = vi.fn();
    const user = userEvent.setup();
    render(
      <Admin
        currentUserId="u1"
        onCurrentUserRoleChanged={onCurrentUserRoleChanged}
        onClose={vi.fn()}
        onUnauthorized={vi.fn()}
      />,
    );
    await screen.findByTestId("user-list");

    await user.click(screen.getByRole("button", { name: "Make admin" }));
    expect(await screen.findAllByRole("button", { name: "Remove admin" })).toHaveLength(2);

    const removeAdminButton = screen.getAllByRole("button", { name: "Remove admin" })[0];
    if (!removeAdminButton) throw new Error("remove-admin control is missing");
    await user.click(removeAdminButton);
    await waitFor(() => expect(onCurrentUserRoleChanged).toHaveBeenCalledWith("member"));
    expect(screen.getByTestId("user-list")).toHaveTextContent("admin@x.com");
  });

  test("adding a user posts the form and refreshes the roster", async () => {
    const roster = makeRoster();
    mock.get("/api/admin/users", () => ({ body: roster }));
    mock.post("/api/admin/users", (_url, init) => {
      const body = JSON.parse(init?.body as string);
      expect(body).toMatchObject({ email: "new@x.com", password: "password123", role: "member" });
      const created = {
        id: "u3",
        email: "new@x.com",
        name: null,
        role: "member" as const,
        status: "active" as const,
        created_at: "t",
      };
      roster.push(created);
      return { status: 201, body: created };
    });
    mock.install();

    const user = userEvent.setup();
    render(<Admin onClose={vi.fn()} onUnauthorized={vi.fn()} />);
    await screen.findByTestId("user-list");

    const addEmailField = screen.getAllByPlaceholderText("teammate@example.com")[0];
    if (!addEmailField) throw new Error("add-user email field not found");
    await user.type(addEmailField, "new@x.com");
    await user.type(screen.getByPlaceholderText("At least 8 characters"), "password123");
    await user.click(screen.getByRole("button", { name: /^add user$/i }));

    await waitFor(() => expect(screen.getByTestId("user-list")).toHaveTextContent("new@x.com"));
  });

  test("inviting by email, when email isn't configured, shows the manual link instead of failing hard", async () => {
    mock.get("/api/admin/users", { body: makeRoster() });
    mock.post("/api/admin/users/invite", {
      status: 502,
      body: {
        error: "email_not_configured",
        message: "email sending requires RESEND_API_KEY to be set as an environment variable",
        user: { id: "u4", email: "invitee@x.com" },
        invite_url: "http://localhost/?invite=abc123",
      },
    });
    mock.install();

    const user = userEvent.setup();
    render(<Admin onClose={vi.fn()} onUnauthorized={vi.fn()} />);
    await screen.findByTestId("user-list");

    const inviteEmailField = screen.getAllByPlaceholderText("teammate@example.com")[1];
    if (!inviteEmailField) throw new Error("invite email field not found");
    await user.type(inviteEmailField, "invitee@x.com");
    await user.click(screen.getByRole("button", { name: /send invite/i }));

    const notice = await screen.findByTestId("invite-notice");
    expect(notice).toHaveTextContent(/RESEND_API_KEY/);
    expect(notice).toHaveTextContent("http://localhost/?invite=abc123");
  });

  test("removing a user confirms, then deletes and refreshes", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const roster = makeRoster();
    let removed = false;
    mock.get("/api/admin/users", () => ({
      body: removed ? roster.filter((u) => u.id !== "u2") : roster,
    }));
    mock.del("/api/admin/users/u2", () => {
      removed = true;
      return { body: { ok: true } };
    });
    mock.install();

    const user = userEvent.setup();
    render(<Admin onClose={vi.fn()} onUnauthorized={vi.fn()} />);
    await screen.findByTestId("user-list");

    const memberRow = screen.getByText("member@x.com").closest(".user-row") as HTMLElement | null;
    if (!memberRow) throw new Error("member row not found");
    const memberRemoveButton = within(memberRow).getByRole("button", { name: "Remove" });
    await user.click(memberRemoveButton);

    expect(confirmSpy).toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByTestId("user-list")).not.toHaveTextContent("member@x.com"),
    );
    confirmSpy.mockRestore();
  });

  test("a 401 from the roster fetch calls onUnauthorized", async () => {
    mock.get("/api/admin/users", { status: 401, body: { error: "unauthorized" } });
    mock.install();

    const onUnauthorized = vi.fn();
    render(<Admin onClose={vi.fn()} onUnauthorized={onUnauthorized} />);

    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1));
  });
});
