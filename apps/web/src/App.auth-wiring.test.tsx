// Integration coverage for the pieces App.tsx wires together itself (as
// opposed to Login.tsx/Admin.tsx's own unit tests): which pre-auth screen
// shows up based on /api/auth/status and the ?invite= URL param, and whether
// the Account/Admin buttons appear in the authenticated chrome based on the
// signed-in user's role.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { App } from "./App";
import { getToken, setToken } from "./auth";
import { MockFetch } from "./test/mockFetch";

describe("App — pre-auth screen selection", () => {
  let mock: MockFetch;

  beforeEach(() => {
    mock = new MockFetch();
  });

  afterEach(() => {
    window.history.replaceState({}, "", "/");
  });

  test("shows the login form when bootstrap is already done", async () => {
    mock.get("/api/auth/status", { body: { needs_bootstrap: false } });
    mock.install();
    render(<App />);
    expect(
      await screen.findByRole("heading", { name: /enter your workspace/i }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
    expect(screen.queryByLabelText("Deploy setup key")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("NORNS_TOKEN")).not.toBeInTheDocument();
  });

  test("shows the first-admin bootstrap form when no users exist yet", async () => {
    mock.get("/api/auth/status", { body: { needs_bootstrap: true } });
    mock.install();
    render(<App />);
    expect(
      await screen.findByRole("heading", { name: /set up the first admin account/i }),
    ).toBeInTheDocument();
  });

  test("an ?invite= URL param takes priority and shows the accept-invite form", async () => {
    window.history.replaceState({}, "", "/?invite=abc123");
    mock.install(); // /api/auth/status should never even be called in this mode
    render(<App />);
    expect(await screen.findByRole("heading", { name: /accept your invite/i })).toBeInTheDocument();
    expect(mock.calls.find((c) => c.url.includes("/api/auth/status"))).toBeUndefined();
  });
});

describe("App — authenticated chrome reflects the signed-in user's role", () => {
  let mock: MockFetch;

  beforeEach(() => {
    setToken("test-token");
    mock = new MockFetch();
    mock.get("/api/projects", { body: [] });
  });

  test("clears a stale session marker and returns to sign-in when the cookie is gone", async () => {
    mock.get("/api/auth/me", { status: 401, body: { error: "unauthorized" } });
    mock.get("/api/auth/status", { body: { needs_bootstrap: false } });
    mock.install();

    render(<App />);

    expect(
      await screen.findByRole("heading", { name: /enter your workspace/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/session expired\. sign in again/i)).toBeInTheDocument();
    expect(getToken()).toBeNull();
  });

  test("shows Settings but not Admin for a member", async () => {
    mock.get("/api/auth/me", {
      body: { id: "u1", email: "member@x.com", name: null, role: "member", status: "active" },
    });
    mock.install();
    render(<App />);

    expect(await screen.findByRole("button", { name: /settings/i })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /^admin$/i })).not.toBeInTheDocument(),
    );
  });

  test("shows both Settings and Admin for an admin, and Admin opens the panel", async () => {
    mock.get("/api/auth/me", {
      body: { id: "u1", email: "admin@x.com", name: null, role: "admin", status: "active" },
    });
    mock.get("/api/admin/users", { body: [] });
    mock.install();
    const user = userEvent.setup();
    render(<App />);

    const adminButton = await screen.findByRole("button", { name: /^admin$/i });
    await user.click(adminButton);
    expect(await screen.findByTestId("admin-panel")).toBeInTheDocument();
  });
});
