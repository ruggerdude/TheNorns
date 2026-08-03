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
    next.get("/api/devices", { body: { devices: [] } });
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
    expect((await screen.findAllByText("Not connected")).length).toBeGreaterThan(0);
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

  it("shows the account-synced Local Agent without exposing legacy pairing secrets", async () => {
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

    const { container } = render(
      <Account user={admin} initialTab="connections" onClose={vi.fn()} onSignOut={vi.fn()} />,
    );

    expect(await screen.findByText("Not configured")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /manage agent/i })).toBeInTheDocument();
    expect(screen.getByText(/norns local agent/i)).toBeInTheDocument();
    expect(
      mock.calls.some(
        (call) =>
          call.url === "/api/pairing/start" ||
          call.url === "/api/runners/helper/repositories" ||
          call.url === "/api/runners/helper/repositories/choose",
      ),
    ).toBe(false);
    expect(
      [...container.querySelectorAll("a")].some((anchor) =>
        (anchor.getAttribute("href") ?? "").startsWith("norns-agent:"),
      ),
    ).toBe(false);
    expect(container).not.toHaveTextContent("runner-1");
    expect(container).not.toHaveTextContent("a1b2c3d4");
    expect(screen.getByRole("button", { name: "Set up GitHub" })).toBeInTheDocument();
  });

  it("shows enrolled computers and their approved local folders", async () => {
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
    mock.get("/api/devices", {
      body: {
        devices: [
          {
            device_id: "device-1",
            owner_user_id: "u1",
            name: "Studio Mac",
            location_label: null,
            os_family: "macos",
            os_version: null,
            lifecycle: "active",
            status: {
              availability: "online",
              workload: "idle",
              compatibility: "ready",
              access: "owned",
            },
            active_credential: {
              device_id: "device-1",
              credential_id: "credential-1",
              generation: 1,
              public_key_fingerprint: "a".repeat(64),
              state: "active",
              activated_at: "2026-07-30T19:00:00.000Z",
            },
            agent: {
              version: "0.3.1",
              protocol_version: "1",
              capabilities: ["device_control", "repository_access"],
            },
            repository_grants: [],
            activity: {
              active_run_count: 0,
              queued_command_count: 0,
            },
            last_seen_at: "2026-07-30T20:00:00.000Z",
          },
        ],
      },
    });
    mock.get("/api/devices/device-1/repository-access", {
      body: {
        device_id: "device-1",
        registrations: [
          {
            registration_id: "registration-1",
            repository_id: "repository-1",
            repository_display_name: "Guitar Tabs",
            default_branch: "main",
            state: "active",
            grants: [],
          },
        ],
        eligible_projects: [],
      },
    });
    mock.install();

    render(<Account user={admin} initialTab="connections" onClose={vi.fn()} onSignOut={vi.fn()} />);

    expect(await screen.findByText("1 ready")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Manage agent" }));
    expect(screen.getByText("Studio Mac")).toBeInTheDocument();
    expect(screen.getByText(/Guitar Tabs/)).toBeInTheDocument();
    expect(screen.getByText(/1 approved folder is synced/i)).toBeInTheDocument();
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
          {
            id: "deepseek",
            name: "DeepSeek",
            configured: false,
            model: "deepseek-v4-flash",
            required_environment: ["DEEPSEEK_API_KEY"],
          },
        ],
      },
    });
    mock.install();

    render(<Account user={admin} initialTab="connections" onClose={vi.fn()} onSignOut={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: "Manage providers" }));
    expect(await screen.findByText(/ANTHROPIC_API_KEY/)).toBeInTheDocument();
    expect(screen.getByText(/DEEPSEEK_API_KEY/)).toBeInTheDocument();
    expect(screen.getByText("gpt-5.6-sol")).toBeInTheDocument();
    expect(screen.getByText("deepseek-v4-flash")).toBeInTheDocument();
    expect(screen.getByText(/DeepSeek is API-only/)).toBeInTheDocument();
    expect(screen.getByText("API configured")).toBeInTheDocument();
  });

  it("gives exact local subscription setup and verification directions", async () => {
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
            credential_modes: ["api", "subscription"],
            required_environment: ["ANTHROPIC_API_KEY"],
          },
          {
            id: "openai",
            name: "OpenAI",
            configured: false,
            model: "gpt-5.6-sol",
            credential_modes: ["api", "subscription"],
            required_environment: ["OPENAI_API_KEY", "NORNS_OPENAI_MODEL"],
          },
          {
            id: "deepseek",
            name: "DeepSeek",
            configured: false,
            model: "deepseek-v4-flash",
            credential_modes: ["api"],
            required_environment: ["DEEPSEEK_API_KEY"],
          },
        ],
      },
    });
    mock.install();

    render(<Account user={admin} initialTab="connections" onClose={vi.fn()} onSignOut={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: "Manage providers" }));

    expect(
      await screen.findByText("Connect local Claude and Codex subscriptions"),
    ).toBeInTheDocument();
    expect(screen.getByText("codex login", { selector: "code" })).toBeInTheDocument();
    expect(screen.getByText("codex login status", { selector: "code" })).toBeInTheDocument();
    expect(screen.getByText("Logged in using ChatGPT", { selector: "code" })).toBeInTheDocument();
    expect(screen.getByText("claude auth login", { selector: "code" })).toBeInTheDocument();
    expect(screen.getByText("claude auth status --json", { selector: "code" })).toBeInTheDocument();
    expect(screen.getByText("authMethod", { selector: "code" })).toBeInTheDocument();
    expect(
      screen.getByText(
        (_content, element) =>
          element?.matches(".subscription-next-step p") === true &&
          /choose Subscription as the execution credential/i.test(element.textContent ?? ""),
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/server API status below will not change/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /official Codex sign-in guide/i })).toHaveAttribute(
      "href",
      "https://learn.chatgpt.com/docs/auth#sign-in-with-chatgpt",
    );
    expect(
      screen.getByRole("link", { name: /official Claude Code sign-in guide/i }),
    ).toHaveAttribute("href", "https://code.claude.com/docs/en/authentication");
  });
});
