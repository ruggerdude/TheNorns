// Login covers three pre-auth screens (email+password login, one-time
// first-admin bootstrap, and email-invite acceptance) driven by the same
// component via the `mode` prop. Each mode posts to a different auth route
// and should surface that route's error cleanly.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { Login } from "./Login";
import type { AuthSession } from "./auth";
import { MockFetch } from "./test/mockFetch";

describe("Login — sign in", () => {
  let mock: MockFetch;

  beforeEach(() => {
    mock = new MockFetch();
  });

  test("submits email + password and reports the session to the caller", async () => {
    const session: AuthSession = {
      token: "tok-123",
      user: { id: "u1", email: "a@x.com", name: null, role: "member", status: "active" },
    };
    mock.post("/api/auth/login", { body: session });
    mock.install();

    const onAuthenticated = vi.fn();
    const user = userEvent.setup();
    render(<Login mode="login" onAuthenticated={onAuthenticated} error={null} />);

    await user.type(screen.getByPlaceholderText("you@example.com"), "a@x.com");
    await user.type(screen.getByPlaceholderText("Enter password"), "password1");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    await vi.waitFor(() => expect(onAuthenticated).toHaveBeenCalledWith(session));
  });

  test("shows a friendly message on invalid credentials, without calling onAuthenticated", async () => {
    mock.post("/api/auth/login", { status: 401, body: { error: "invalid_credentials" } });
    mock.install();

    const onAuthenticated = vi.fn();
    const user = userEvent.setup();
    render(<Login mode="login" onAuthenticated={onAuthenticated} error={null} />);

    await user.type(screen.getByPlaceholderText("you@example.com"), "a@x.com");
    await user.type(screen.getByPlaceholderText("Enter password"), "wrong");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    expect(await screen.findByTestId("login-error")).toHaveTextContent(
      /incorrect email or password/i,
    );
    expect(onAuthenticated).not.toHaveBeenCalled();
  });
});

describe("Login — first-time bootstrap", () => {
  let mock: MockFetch;

  beforeEach(() => {
    mock = new MockFetch();
  });

  test("posts the deploy key + new admin credentials to /api/auth/bootstrap", async () => {
    const session: AuthSession = {
      token: "tok-admin",
      user: { id: "u1", email: "root@x.com", name: null, role: "admin", status: "active" },
    };
    mock.post("/api/auth/bootstrap", (_url, init) => {
      const body = JSON.parse(init?.body as string);
      expect(body).toMatchObject({
        deploy_token: "deploy-secret",
        email: "root@x.com",
        password: "password123",
      });
      return { body: session };
    });
    mock.install();

    const onAuthenticated = vi.fn();
    const user = userEvent.setup();
    render(<Login mode="bootstrap" onAuthenticated={onAuthenticated} error={null} />);

    await user.type(screen.getByPlaceholderText("NORNS_TOKEN"), "deploy-secret");
    await user.type(screen.getByPlaceholderText("you@example.com"), "root@x.com");
    await user.type(screen.getByPlaceholderText("At least 8 characters"), "password123");
    await user.click(screen.getByRole("button", { name: /create admin account/i }));

    await vi.waitFor(() => expect(onAuthenticated).toHaveBeenCalledWith(session));
  });

  test("surfaces already_bootstrapped clearly", async () => {
    mock.post("/api/auth/bootstrap", { status: 403, body: { error: "already_bootstrapped" } });
    mock.install();

    const user = userEvent.setup();
    render(<Login mode="bootstrap" onAuthenticated={vi.fn()} error={null} />);

    await user.type(screen.getByPlaceholderText("NORNS_TOKEN"), "deploy-secret");
    await user.type(screen.getByPlaceholderText("you@example.com"), "root@x.com");
    await user.type(screen.getByPlaceholderText("At least 8 characters"), "password123");
    await user.click(screen.getByRole("button", { name: /create admin account/i }));

    expect(await screen.findByTestId("login-error")).toHaveTextContent(/already been completed/i);
  });
});

describe("Login — accept invite", () => {
  let mock: MockFetch;

  beforeEach(() => {
    mock = new MockFetch();
  });

  test("posts the invite token from props + chosen password", async () => {
    const session: AuthSession = {
      token: "tok-invited",
      user: { id: "u2", email: "b@x.com", name: null, role: "member", status: "active" },
    };
    mock.post("/api/auth/accept-invite", (_url, init) => {
      const body = JSON.parse(init?.body as string);
      expect(body).toMatchObject({ invite_token: "invite-abc", password: "new-password-1" });
      return { body: session };
    });
    mock.install();

    const onAuthenticated = vi.fn();
    const user = userEvent.setup();
    render(
      <Login
        mode="invite"
        inviteToken="invite-abc"
        onAuthenticated={onAuthenticated}
        error={null}
      />,
    );

    // Only the password field is shown in invite mode.
    expect(screen.queryByPlaceholderText("you@example.com")).not.toBeInTheDocument();
    await user.type(screen.getByPlaceholderText("At least 8 characters"), "new-password-1");
    await user.click(screen.getByRole("button", { name: /activate account/i }));

    await vi.waitFor(() => expect(onAuthenticated).toHaveBeenCalledWith(session));
  });

  test("shows the server's message for an invalid/expired invite", async () => {
    mock.post("/api/auth/accept-invite", {
      status: 400,
      body: {
        error: "invalid_invite",
        message: "invite link is invalid or has already been used.",
      },
    });
    mock.install();

    const user = userEvent.setup();
    render(<Login mode="invite" inviteToken="dead" onAuthenticated={vi.fn()} error={null} />);

    await user.type(screen.getByPlaceholderText("At least 8 characters"), "new-password-1");
    await user.click(screen.getByRole("button", { name: /activate account/i }));

    expect(await screen.findByTestId("login-error")).toHaveTextContent(
      /invalid or has already been used/i,
    );
  });
});
