import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Account } from "./Account";
import type { CurrentUser } from "./auth";
import { MockFetch } from "./test/mockFetch";

const admin: CurrentUser = {
  id: "u1",
  email: "admin@x.com",
  name: "Ada",
  role: "admin",
  status: "active",
};

describe("Account panel", () => {
  test("shows the signed-in user's email, name, and role", () => {
    render(<Account user={admin} onClose={vi.fn()} onSignOut={vi.fn()} />);
    const panel = screen.getByTestId("account-panel");
    expect(panel).toHaveTextContent("admin@x.com");
    expect(panel).toHaveTextContent("Ada");
    expect(panel).toHaveTextContent("admin");
  });

  test("Close calls onClose, Sign out calls onSignOut", async () => {
    const onClose = vi.fn();
    const onSignOut = vi.fn();
    const user = userEvent.setup();
    render(<Account user={admin} onClose={onClose} onSignOut={onSignOut} />);

    await user.click(screen.getByRole("button", { name: /sign out/i }));
    expect(onSignOut).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: /^close$/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("clicking the backdrop dismisses the panel", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<Account user={admin} onClose={onClose} onSignOut={vi.fn()} />);

    const backdrop = document.querySelector(".modal-backdrop");
    expect(backdrop).not.toBeNull();
    await user.click(backdrop as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("session revoke (POLISH P3 hotfix sweep)", () => {
  let mock: MockFetch | undefined;

  afterEach(() => mock?.restore());

  test("revokes with a body-less DELETE that carries no JSON content-type", async () => {
    // Production regression class: `authHeaders(true)` set
    // `content-type: application/json` on this body-less DELETE, and Fastify
    // runs the JSON body parser for DELETE too (it is in the `bodywith`
    // method set), rejecting the empty body with 400
    // FST_ERR_CTP_EMPTY_JSON_BODY before the route handler runs — so Revoke
    // always failed. Assert the REAL fetch invocation shape; a mock that only
    // checks the URL is exactly what let the sibling buttons ship broken.
    mock = new MockFetch();
    mock.get("/api/auth/sessions", {
      body: {
        sessions: [
          {
            id: "sess-current",
            status: "active",
            created_at: "2026-07-22T00:00:00Z",
            last_seen_at: null,
            current: true,
          },
          {
            id: "sess-other",
            status: "active",
            created_at: "2026-07-22T00:00:00Z",
            last_seen_at: null,
            current: false,
          },
        ],
      },
    });
    mock.get("/api/integrations/github/status", {
      body: {
        configured: false,
        setup_available: false,
        configuration_source: null,
        user_authorization: { connected: false, login: null },
        connections: [],
      },
    });
    // The real route replies 200 { ok: true } (server.ts ~1030).
    mock.del("/api/auth/sessions/sess-other", { body: { ok: true } });
    mock.install();

    const user = userEvent.setup();
    render(<Account user={admin} initialTab="security" onClose={vi.fn()} onSignOut={vi.fn()} />);

    await user.click(await screen.findByRole("button", { name: "Revoke" }));

    await waitFor(() =>
      expect(
        mock?.calls.some(
          (call) => call.method === "DELETE" && call.url === "/api/auth/sessions/sess-other",
        ),
      ).toBe(true),
    );
    const call = mock.calls.find((entry) => entry.method === "DELETE");
    expect(call?.body).toBeUndefined();
    expect(call?.headers["content-type"]).toBeUndefined();
    // The success reply was accepted (no "Could not revoke session" error
    // shown) and the inventory was reloaded.
    await waitFor(() =>
      expect(
        mock?.calls.filter((entry) => entry.method === "GET" && entry.url === "/api/auth/sessions")
          .length,
      ).toBeGreaterThanOrEqual(2),
    );
    expect(screen.queryByText(/could not revoke session/i)).not.toBeInTheDocument();
  });
});
