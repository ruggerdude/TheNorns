// Integration coverage for the pieces App.tsx wires together itself (as
// opposed to Login.tsx/Admin.tsx's own unit tests): which pre-auth screen
// shows up based on /api/auth/status and the ?invite= URL param, and whether
// the Account/Admin buttons appear in the authenticated chrome based on the
// signed-in user's role.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { App } from "./App";
import { consumeGitHubCallback, getToken, setToken } from "./auth";
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

describe("GitHub callback URL cleanup", () => {
  afterEach(() => {
    window.history.replaceState({}, "", "/");
  });

  test("consumes the callback once while preserving the Settings route", () => {
    window.history.replaceState({}, "", "/?settings=connections&github=failed");

    expect(consumeGitHubCallback()).toBe("failed");
    expect(window.location.search).toBe("?settings=connections");
    expect(consumeGitHubCallback()).toBeNull();
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

  test("shows Settings and Usage but not Admin for a member", async () => {
    mock.get("/api/auth/me", {
      body: { id: "u1", email: "member@x.com", name: null, role: "member", status: "active" },
    });
    mock.install();
    render(<App />);

    expect(await screen.findByRole("button", { name: /settings/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^usage$/i })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /^admin$/i })).not.toBeInTheDocument(),
    );
  });

  test("shows Settings, Usage, and Admin for an admin, and Admin opens the panel", async () => {
    mock.get("/api/auth/me", {
      body: { id: "u1", email: "admin@x.com", name: null, role: "admin", status: "active" },
    });
    mock.get("/api/admin/users", { body: [] });
    mock.install();
    const user = userEvent.setup();
    render(<App />);

    const adminButton = await screen.findByRole("button", { name: /^admin$/i });
    expect(screen.getByRole("button", { name: /^usage$/i })).toBeInTheDocument();
    const headerActions = adminButton.closest(".header-actions");
    expect(headerActions).not.toBeNull();
    const headerButtons = within(headerActions as HTMLElement).getAllByRole("button");
    // DESIGN P1: the theme toggle moved from a floating control into the
    // topbar actions, between Admin and the user menu.
    expect(headerButtons).toHaveLength(5);
    expect(headerButtons[0]).toHaveAccessibleName("Usage");
    expect(headerButtons[1]).toHaveAccessibleName("Settings");
    expect(headerButtons[2]).toHaveAccessibleName("Admin");
    expect(headerButtons[3]).toHaveAccessibleName(/switch to (light|dark) mode/i);
    expect(headerButtons[4]).toHaveAccessibleName("admin@x.com");
    await user.click(adminButton);
    expect(await screen.findByTestId("admin-panel")).toBeInTheDocument();
    expect(screen.getByTestId("admin-panel")).toHaveClass("embedded-page-view");
    expect(screen.getByRole("button", { name: "Admin" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "Usage" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Settings" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(await screen.findByTestId("account-panel")).toHaveClass("embedded-page-view");
    expect(screen.getByRole("button", { name: "Settings" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.queryByRole("button", { name: "Dismiss" })).not.toBeInTheDocument();
  });

  test("opens user settings and sign out actions from the username menu", async () => {
    mock.get("/api/auth/me", {
      body: {
        id: "u1",
        email: "david@example.com",
        name: "David Hatwell",
        role: "admin",
        status: "active",
      },
    });
    mock.get("/api/auth/sessions", { body: { sessions: [] } });
    mock.get("/api/integrations/github", {
      body: {
        configured: false,
        setup_available: false,
        configuration_source: null,
        user_authorization: { connected: false, login: null },
        connections: [],
      },
    });
    mock.get("/api/integrations/ai", { body: { cross_provider_ready: false, providers: [] } });
    mock.get("/api/local-sources", { body: { state: "unavailable", repositories: [] } });
    mock.install();
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: /david hatwell/i }));
    expect(screen.getByRole("menuitem", { name: "User settings" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Sign out" })).toBeInTheDocument();

    await user.click(screen.getByRole("menuitem", { name: "User settings" }));
    expect(await screen.findByTestId("account-panel")).toHaveClass("embedded-page-view");
    expect(screen.getByRole("button", { name: "Settings" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  test("opens personal usage from the authenticated portfolio navigation", async () => {
    mock.get("/api/auth/me", {
      body: { id: "u1", email: "member@x.com", name: null, role: "member", status: "active" },
    });
    mock.get("/api/usage/users/u1/summary", {
      body: {
        requests: 1,
        succeeded_requests: 1,
        failed_requests: 0,
        in_progress_requests: 0,
        input_tokens: 100,
        output_tokens: 20,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        cost_usd: 0.01,
        known_cost_usd: 0.01,
        priced_requests: 1,
        unpriced_requests: 0,
        average_latency_ms: 200,
        average_output_tokens: 20,
        average_known_cost_usd: 0.01,
      },
    });
    mock.get("/api/usage/users/u1/timeseries?interval=day", {
      body: { interval: "day", points: [] },
    });
    mock.get("/api/usage/users/u1/events?limit=100", {
      body: { events: [], limit: 100, offset: 0, has_more: false },
    });
    mock.get(/\/api\/usage\/users\/u1\/breakdown(?:\?.*)?$/, {
      body: { breakdowns: [] },
    });
    mock.install();
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Usage" }));

    expect(await screen.findByRole("heading", { name: "Usage", level: 1 })).toBeInTheDocument();
    expect(screen.getByTestId("usage-panel")).toHaveClass("embedded-page-view");
    expect(screen.getByRole("button", { name: "My usage" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("button", { name: "Usage" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "Settings" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Return to Portfolio" })).toBeInTheDocument();
  });
});
