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

  afterEach(() => mock?.restore());

  it("shows GitHub identity and reusable workspace installations", async () => {
    mock = new MockFetch();
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

    expect(await screen.findByText("Authorized as octocat")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Manage GitHub" }));
    expect(screen.getByText("octocat")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /add github account or organization/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/token/i)).not.toBeInTheDocument();
  });

  it("explains when the deployment has not configured a GitHub App", async () => {
    mock = new MockFetch();
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

  it("pairs and inventories local runners from the settings card", async () => {
    mock = new MockFetch();
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
    mock.get("/api/runners", {
      body: [
        {
          runner_id: "runner-studio",
          generation: 2,
          connected: true,
          last_seen_at: "2026-07-17T15:00:00.000Z",
        },
      ],
    });
    mock.post("/api/pairing/start", {
      body: { code: "ABC-123", expires_at: "2026-07-17T16:30:00.000Z" },
    });
    mock.install();

    render(<Account user={admin} initialTab="connections" onClose={vi.fn()} onSignOut={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: "Manage runners" }));
    expect(await screen.findByText("runner-studio")).toBeInTheDocument();
    expect(screen.getByText("1 connected")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Pair new runner" }));
    expect(await screen.findByText("ABC-123")).toBeInTheDocument();
    expect(screen.getByText(/norns-runner pair ABC-123/i)).toBeInTheDocument();
    expect(screen.getByText(/norns-runner workspace add/i)).toBeInTheDocument();
    expect(screen.getByText(/norns-runner start/i)).toBeInTheDocument();
  });

  it("shows provider readiness and the exact missing deployment variables", async () => {
    mock = new MockFetch();
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
