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

  it("disconnects with a body-less DELETE that carries no JSON content-type (POLISH P3 hotfix sweep)", async () => {
    // Production regression class: integrationRequest's old
    // `|| init?.method === "DELETE"` clause forced
    // `content-type: application/json` onto this body-less DELETE, and
    // Fastify runs the JSON body parser for DELETE too (`bodywith` method
    // set), 400ing the empty body (FST_ERR_CTP_EMPTY_JSON_BODY) before the
    // route handler ran — so Disconnect always failed. Assert the REAL fetch
    // invocation shape; a mock that only checks the URL is what let the
    // sibling buttons ship broken.
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
    mock.del("/api/integrations/github/connections/github%3A42", { status: 204 });
    mock.install();

    render(<Account user={admin} initialTab="connections" onClose={vi.fn()} onSignOut={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Manage GitHub" }));
    await userEvent.click(await screen.findByRole("button", { name: "Disconnect" }));

    const call = mock.calls.find((entry) => entry.method === "DELETE");
    expect(call?.url).toBe("/api/integrations/github/connections/github%3A42");
    expect(call?.body).toBeUndefined();
    expect(call?.headers["content-type"]).toBeUndefined();
  });

  it("surfaces manifest callback failures and opens the GitHub setup details", async () => {
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

  it("offers no local-runner install or pairing surface", async () => {
    // POLISH P1: the product owner rejected any design where a user installs a
    // local runner. Execution is dispatched to ephemeral GitHub Actions
    // runners by the server; Settings must never surface installing, pairing,
    // or managing local runners.
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
    expect(screen.queryByText(/local runner/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /manage runners/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /pair new runner/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/install-runner/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/pairing code/i)).not.toBeInTheDocument();
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
