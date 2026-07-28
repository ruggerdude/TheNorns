import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Account } from "./Account";
import type { CurrentUser } from "./auth";
import { MockFetch } from "./test/mockFetch";

const admin: CurrentUser = {
  id: "u1",
  email: "admin@example.com",
  name: "Admin",
  role: "admin",
  status: "active",
};

describe("workspace connections settings", () => {
  let mock: MockFetch | undefined;

  afterEach(() => {
    mock?.restore();
    vi.restoreAllMocks();
  });

  function accountMock(): MockFetch {
    const next = new MockFetch();
    next.get("/api/runners/helper/repositories", {
      body: {
        state: "not_installed",
        runner_id: null,
        workspace_clone_ready: false,
        message: "Set up the local helper once.",
        downloads: { windows: null, macos: null, macos_release: null },
        install_command: "install-helper",
        install_command_windows: "install-helper-windows",
        repositories: [],
      },
    });
    return next;
  }

  it("shows GitHub identity and reusable workspace installations", async () => {
    mock = accountMock();
    mock.get("/api/auth/sessions", { body: { sessions: [] } });
    mock.get("/api/integrations/github/status", {
      body: {
        configured: true,
        setup_available: false,
        configuration_source: "manifest",
        user_authorization: { connected: true, login: "octocat" },
        connections: [
          {
            id: "github:42",
            provider: "github",
            display_name: "octocat on GitHub",
            owner_type: "user",
            owner_login: "octocat",
            installation_id: "42",
            repository_selection: "all",
            status: "connected",
            last_validated_at: "2026-07-16T20:00:00Z",
          },
        ],
      },
    });
    mock.install();

    render(<Account user={admin} initialTab="connections" onClose={vi.fn()} onSignOut={vi.fn()} />);

    expect(await screen.findByText("1 GitHub destination ready")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Manage GitHub" }));
    expect(screen.getByText("octocat")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /add another github destination/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/token/i)).not.toBeInTheDocument();
  });

  it("does not call an authorized identity ready until a GitHub destination is installed", async () => {
    mock = accountMock();
    mock.get("/api/auth/sessions", { body: { sessions: [] } });
    mock.get("/api/integrations/github/status", {
      body: {
        configured: true,
        setup_available: false,
        configuration_source: "manifest",
        user_authorization: { connected: true, login: "octocat" },
        connections: [],
      },
    });
    mock.install();

    render(<Account user={admin} initialTab="connections" onClose={vi.fn()} onSignOut={vi.fn()} />);

    expect(await screen.findByText("Setup incomplete")).toBeInTheDocument();
    expect(screen.getByText(/one step left: choose where norns can work/i)).toBeInTheDocument();
    expect(screen.getByText(/identity is authorized as/i)).toHaveTextContent("octocat");
    expect(screen.getByRole("button", { name: "Install The Norns on GitHub" })).toBeInTheDocument();
    expect(screen.queryByText(/destination ready/i)).not.toBeInTheDocument();
  });

  it("explains when the deployment has not configured a GitHub App", async () => {
    mock = accountMock();
    mock.get("/api/auth/sessions", { body: { sessions: [] } });
    mock.get("/api/integrations/github/status", {
      body: {
        configured: false,
        setup_available: true,
        configuration_source: null,
        user_authorization: { connected: false, login: null },
        connections: [],
      },
    });
    mock.install();

    render(<Account user={admin} initialTab="connections" onClose={vi.fn()} onSignOut={vi.fn()} />);

    expect(await screen.findByText("Not configured")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Set up GitHub" }));
    expect(screen.getByText(/Connect GitHub with guided setup/i)).toBeInTheDocument();
    const continueButton = screen.getByRole("button", { name: "Continue with GitHub" });
    expect(continueButton.closest("form")).toHaveAttribute(
      "action",
      "/api/integrations/github/manifest/start",
    );
    await userEvent.selectOptions(
      screen.getByLabelText("Create the GitHub App under"),
      "organization",
    );
    const organization = screen.getByLabelText("Organization name");
    expect(continueButton).toBeDisabled();
    await userEvent.type(organization, "norns-org");
    expect(continueButton).toBeEnabled();
  });

  it("disconnects a connection without deleting it", async () => {
    mock = accountMock();
    mock.get("/api/auth/sessions", { body: { sessions: [] } });
    mock.get("/api/integrations/github/status", {
      body: {
        configured: true,
        setup_available: false,
        configuration_source: "manifest",
        user_authorization: { connected: true, login: "octocat" },
        connections: [
          {
            id: "github:42",
            provider: "github",
            display_name: "octocat on GitHub",
            owner_type: "user",
            owner_login: "octocat",
            installation_id: "42",
            repository_selection: "all",
            status: "connected",
            last_validated_at: "2026-07-16T20:00:00Z",
          },
        ],
      },
    });
    mock.post("/api/integrations/github/connections/github%3A42/disconnect", {
      body: { status: "disconnected" },
    });
    mock.install();

    render(<Account user={admin} initialTab="connections" onClose={vi.fn()} onSignOut={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Manage GitHub" }));
    await userEvent.click(await screen.findByRole("button", { name: "Disconnect" }));

    const call = mock.calls.find(
      (entry) =>
        entry.method === "POST" &&
        entry.url === "/api/integrations/github/connections/github%3A42/disconnect",
    );
    expect(call?.body).toEqual({});
  });

  it("shows a cached connection after a refresh error and lets an admin delete it", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    mock = accountMock();
    mock.get("/api/auth/sessions", { body: { sessions: [] } });
    mock.get("/api/integrations/github/status", {
      body: {
        configured: true,
        setup_available: false,
        configuration_source: "manifest",
        refresh_error: "Bad credentials.",
        user_authorization: { connected: true, login: "octocat" },
        connections: [
          {
            id: "github:42",
            provider: "github",
            display_name: "octocat on GitHub",
            owner_type: "user",
            owner_login: "octocat",
            installation_id: "42",
            repository_selection: "all",
            status: "connected",
            last_validated_at: "2026-07-16T20:00:00Z",
          },
        ],
      },
    });
    mock.del("/api/integrations/github/connections/github%3A42", { status: 204 });
    mock.install();

    render(<Account user={admin} initialTab="connections" onClose={vi.fn()} onSignOut={vi.fn()} />);

    expect(await screen.findByText(/could not refresh the saved connections/i)).toHaveTextContent(
      "Bad credentials.",
    );
    expect(screen.queryByText(/Loading GitHub connection/i)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Delete connection" }));

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("octocat"));
    const call = mock.calls.find((entry) => entry.method === "DELETE");
    expect(call?.url).toBe("/api/integrations/github/connections/github%3A42");
    expect(call?.body).toBeUndefined();
    expect(call?.headers["content-type"]).toBeUndefined();
  });

  it("lets a user delete a broken saved identity when no installations were discovered", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    let identityDeleted = false;
    mock = accountMock();
    mock.get("/api/auth/sessions", { body: { sessions: [] } });
    mock.get("/api/integrations/github/status", () => ({
      body: identityDeleted
        ? {
            configured: true,
            setup_available: false,
            configuration_source: "manifest",
            refresh_error: null,
            user_authorization: { connected: false, login: null },
            connections: [],
          }
        : {
            configured: true,
            setup_available: false,
            configuration_source: "manifest",
            refresh_error: "Bad credentials.",
            user_authorization: { connected: true, login: "octocat" },
            connections: [],
          },
    }));
    mock.del("/api/integrations/github/authorization", () => {
      identityDeleted = true;
      return { status: 204 };
    });
    mock.install();

    render(
      <Account
        user={admin}
        initialTab="connections"
        githubCallback="failed"
        onClose={vi.fn()}
        onSignOut={vi.fn()}
      />,
    );

    expect(await screen.findByText(/could not refresh the saved connections/i)).toHaveTextContent(
      "Bad credentials.",
    );
    expect(
      screen.queryByText(/could not save the GitHub App configuration/i),
    ).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Delete GitHub identity" }));

    expect(confirm).toHaveBeenCalled();
    const call = mock.calls.find(
      (entry) =>
        entry.method === "DELETE" && entry.url === "/api/integrations/github/authorization",
    );
    expect(call?.body).toBeUndefined();
    expect(call?.headers["content-type"]).toBeUndefined();
    expect(await screen.findByText("Not connected")).toBeInTheDocument();
    expect(screen.queryByText(/Bad credentials/i)).not.toBeInTheDocument();
  });

  it("surfaces manifest callback failures and opens the GitHub setup details", async () => {
    mock = accountMock();
    mock.get("/api/auth/sessions", { body: { sessions: [] } });
    mock.get("/api/integrations/github/status", {
      body: {
        configured: false,
        setup_available: true,
        configuration_source: null,
        user_authorization: { connected: false, login: null },
        connections: [],
      },
    });
    mock.install();

    render(
      <Account
        user={admin}
        initialTab="connections"
        githubCallback="github_manifest_conversion_failed"
        onClose={vi.fn()}
        onSignOut={vi.fn()}
      />,
    );

    expect(
      await screen.findByText(/could not exchange GitHub's one-time setup code/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/Connect GitHub with guided setup/i)).toBeInTheDocument();
  });

  it("keeps one-time local helper setup in Connections", async () => {
    mock = accountMock();
    mock.get("/api/auth/sessions", { body: { sessions: [] } });
    mock.get("/api/integrations/github/status", {
      body: {
        configured: false,
        setup_available: true,
        configuration_source: null,
        user_authorization: { connected: false, login: null },
        connections: [],
      },
    });
    mock.post("/api/pairing/start", {
      body: {
        code: "a1b2c3d4",
        expires_at: "2026-07-27T21:00:00.000Z",
        runner_id: "runner-1",
        pairing_uri:
          "norns-agent://pair?server=https%3A%2F%2Fnorns.example&code=a1b2c3d4&runner_id=runner-1",
        downloads: {
          windows: "https://downloads.example/Norns-Local-Agent-Setup.exe",
          macos: "https://downloads.example/Norns-Local-Agent-macOS.pkg",
          macos_release: "unsigned_preview",
        },
        install_command: "curl https://norns.example/install | sh",
        install_command_windows: "Install-NornsHelper",
      },
    });
    mock.install();

    render(<Account user={admin} initialTab="connections" onClose={vi.fn()} onSignOut={vi.fn()} />);

    expect(await screen.findByText("Not configured")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /manage agent/i }));
    expect(screen.getByText(/set up the local helper once/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /set up norns local agent/i }));
    expect(await screen.findByRole("link", { name: "Download for Windows" })).toHaveAttribute(
      "href",
      "https://downloads.example/Norns-Local-Agent-Setup.exe",
    );
    expect(screen.getByRole("link", { name: "Download unsigned Mac preview" })).toHaveAttribute(
      "href",
      "https://downloads.example/Norns-Local-Agent-macOS.pkg",
    );
    expect(screen.getByText(/not yet Developer ID signed or notarized/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Connect installed agent" })).toHaveAttribute(
      "href",
      expect.stringMatching(/^norns-agent:\/\/pair/),
    );
    expect(screen.getByText("curl https://norns.example/install | sh")).toBeInTheDocument();
  });

  it("shows provider readiness and the exact missing deployment variables", async () => {
    mock = accountMock();
    mock.get("/api/auth/sessions", { body: { sessions: [] } });
    mock.get("/api/integrations/github/status", {
      body: {
        configured: false,
        setup_available: true,
        configuration_source: null,
        user_authorization: { connected: false, login: null },
        connections: [],
      },
    });
    mock.get("/api/integrations/ai/status", {
      body: {
        cross_provider_ready: false,
        providers: [
          {
            id: "anthropic",
            name: "Anthropic",
            configured: false,
            model: "claude-sonnet-5",
            required_environment: ["ANTHROPIC_API_KEY"],
          },
          {
            id: "openai",
            name: "OpenAI",
            configured: true,
            model: "gpt-5.6-sol",
            required_environment: ["OPENAI_API_KEY", "NORNS_OPENAI_MODEL"],
          },
        ],
      },
    });
    mock.install();

    render(<Account user={admin} initialTab="connections" onClose={vi.fn()} onSignOut={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: "Manage providers" }));
    expect(await screen.findByText(/ANTHROPIC_API_KEY/)).toBeInTheDocument();
    expect(screen.getByText("gpt-5.6-sol")).toBeInTheDocument();
    expect(screen.getByText("Configured")).toBeInTheDocument();
  });
});
