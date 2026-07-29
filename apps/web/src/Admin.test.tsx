import { render, screen, waitFor } from "@testing-library/react";
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
    mock.get("/api/admin/projects/archived", { body: [] });
    mock.get("/api/v2/admin/rules", {
      body: { filename: "NORN.md", content: "", version: 0, updated_at: null },
    });
  });

  test("loads and lists the current roster", async () => {
    mock.get("/api/admin/users", { body: makeRoster() });
    mock.install();
    render(<Admin onClose={vi.fn()} onUnauthorized={vi.fn()} />);

    const list = await screen.findByTestId("user-list");
    expect(list).toHaveTextContent("admin@x.com");
    expect(list).toHaveTextContent("member@x.com");
  });

  test("loads and saves the global NORN.md", async () => {
    mock.get("/api/admin/users", { body: makeRoster() });
    mock.put("/api/v2/admin/rules", (_url, init) => {
      const body = JSON.parse(init?.body as string);
      expect(body).toEqual({ content: "# Global rules\n\n- Keep updates concise." });
      return {
        body: {
          filename: "NORN.md",
          content: body.content,
          version: 1,
          updated_at: "2026-07-26T01:00:00.000Z",
        },
      };
    });
    mock.install();

    const user = userEvent.setup();
    render(<Admin onClose={vi.fn()} onUnauthorized={vi.fn()} />);
    const editor = await screen.findByRole("textbox", { name: "Global NORN.md" });
    await user.type(editor, "# Global rules\n\n- Keep updates concise.");
    await user.click(screen.getByRole("button", { name: "Save global rules" }));

    expect(await screen.findByText("v1")).toBeVisible();
    expect(editor).toHaveValue("# Global rules\n\n- Keep updates concise.");
  });

  test("unarchives a project and removes it from the archived list", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    let restored = false;
    mock.get("/api/admin/users", { body: makeRoster() });
    mock.get("/api/admin/projects/archived", () => ({
      body: restored
        ? []
        : [
            {
              id: "project-archived",
              name: "Archived project",
              description: "Return this project to Portfolio",
              status: "archived",
              pm_provider: "openai",
              pm_model: "gpt-5.6-sol",
              reviewer_provider: "anthropic",
              source_type: "github",
              source_location: "github.com/example/archived",
              plan_objective: null,
              archived_at: "2026-07-28T12:00:00.000Z",
            },
          ],
    }));
    mock.post("/api/admin/projects/project-archived/restore", () => {
      restored = true;
      return { body: { ok: true } };
    });
    mock.install();

    const user = userEvent.setup();
    render(<Admin onClose={vi.fn()} onUnauthorized={vi.fn()} />);

    const archivedList = await screen.findByTestId("archived-project-list");
    expect(archivedList).toHaveTextContent("Archived project");
    await user.click(screen.getByRole("button", { name: "Unarchive" }));

    expect(await screen.findByText("No archived projects.")).toBeVisible();
    expect(
      mock.calls.find(
        (call) =>
          call.method === "POST" && call.url === "/api/admin/projects/project-archived/restore",
      ),
    ).toBeDefined();
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

    const removeButtons = screen.getAllByRole("button", { name: /remove/i });
    const memberRemoveButton = removeButtons[1];
    if (!memberRemoveButton) throw new Error("member remove button not found");
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
