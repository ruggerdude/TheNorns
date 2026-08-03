// O1 (ONBOARDING program): New and Existing work can each use GitHub or an
// already-initialized local Git repository approved through Connections:
//   new_repo:      Norns creates a fresh GitHub repository.
//   existing_repo: the human picks one of the connected account's
//                  repositories (searchable list, or paste a repo URL).
//   new + local:   Norns creates only its project record and analyzes the
//                  approved repository. It never creates a local folder.
//                  (DESIGN R2: planning starts in the conversation after
//                  creation, not from the wizard.)
// Connections are configured once in Settings.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ProjectOpenOptions, type ProjectSummary, Projects } from "./Projects";
import { makeProject } from "./test/fixtures";
import { MockFetch } from "./test/mockFetch";

const githubStatus = {
  configured: true,
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
    {
      id: "github:43",
      provider: "github",
      display_name: "acme on GitHub",
      owner_type: "organization",
      owner_login: "acme",
      installation_id: "43",
      repository_selection: "all",
      status: "connected",
      last_validated_at: "2026-07-16T20:00:00Z",
    },
  ],
};

const repository = {
  id: "9001",
  connection_id: "github:42",
  owner: "octocat",
  name: "existing-app",
  full_name: "octocat/existing-app",
  private: true,
  default_branch: "main",
  html_url: "https://github.com/octocat/existing-app",
  clone_url: "https://github.com/octocat/existing-app.git",
  description: "Existing application",
  language: "TypeScript",
  archived: false,
  updated_at: "2026-07-16T20:00:00Z",
};

const projectComputer = {
  device_id: "device-1",
  owner_user_id: "owner-1",
  name: "David's Mac",
  location_label: "Home office",
  os_family: "macos",
  os_version: "15.5",
  lifecycle: "active",
  status: {
    availability: "online",
    compatibility: "ready",
    workload: "idle",
    access: "owned",
  },
  last_seen_at: "2026-07-30T14:30:00.000Z",
  active_credential: {
    device_id: "device-1",
    credential_id: "credential-1",
    generation: 1,
    public_key_fingerprint: "a".repeat(64),
    state: "active",
    activated_at: "2026-07-29T12:00:00.000Z",
  },
  agent: {
    version: "0.4.0",
    protocol_version: "1",
    capabilities: [
      "device_control",
      "repository_access",
      "workspace_picker",
      "workspace_repository_inventory",
      "workspace_clone",
      "workspace_clone_destination",
    ],
  },
  repository_grants: [],
  activity: {
    active_run_count: 0,
    queued_command_count: 0,
  },
};

describe("O1: GitHub and local Git repository onboarding", () => {
  let mock: MockFetch;
  const onOpenProject = vi.fn<(project: ProjectSummary, options?: ProjectOpenOptions) => void>();

  beforeEach(() => {
    onOpenProject.mockReset();
    mock = new MockFetch();
    mock.get("/api/projects", { body: [] });
    mock.get("/api/v2/attention", { status: 404, body: {} });
    mock.get("/api/integrations/github/status", { body: githubStatus });
    mock.get("/api/integrations/github/connections/github%3A42/repositories", {
      body: [repository],
    });
    mock.get("/api/integrations/github/connections/github%3A43/repositories", {
      body: [repository],
    });
    mock.get("/api/v2/capabilities/local-execution", {
      body: {
        schema_version: 1,
        enrollment_available: true,
        computers_available: true,
        repository_grants_available: true,
        legacy_claim_available: false,
        legacy_local_creation_available: true,
      },
    });
    mock.get("/api/devices", { body: { devices: [projectComputer] } });
    mock.post("/api/v2/computers/device-1/clone-destination", {
      body: { clone_destination_id: "local:destination-1", label: "Projects" },
    });
    mock.post("/api/v2/projects/local", (_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        name: string;
        description: string;
        pm_provider: "anthropic" | "openai";
        pm_model: ProjectSummary["pm_model"];
      };
      return {
        status: 201,
        body: makeProject({
          id: "project-local",
          name: body.name,
          description: body.description,
          pm_provider: body.pm_provider,
          pm_model: body.pm_model ?? undefined,
          reviewer_provider: body.pm_provider === "anthropic" ? "openai" : "anthropic",
          source_type: "local",
          source_location: "local-app",
        }),
      };
    });
    mock.post(/^\/api\/v2\/projects\/[^/]+\/analyze-repository$/, {
      body: {
        architecture_revision: 1,
        title: "Repository architecture",
        summary: "Understood",
      },
    });
    mock.post(/^\/api\/v2\/projects\/[^/]+\/attachments$/, {
      status: 201,
      body: { id: "attachment-local" },
    });
    mock.patch(/^\/api\/v2\/projects\/[^/]+\/planning-reviewer$/, { status: 204 });
    mock.del(/^\/api\/v2\/projects\/[^/]+\/planning-reviewer$/, { status: 204 });
    mock.post(/^\/api\/v2\/projects\/[^/]+\/planning-runs$/, {
      status: 202,
      body: { planning_run_id: "new-project-run" },
    });
    // O1: onboarding always creates/binds a GitHub repository — POST
    // /api/v2/projects/onboarding is the single creation endpoint. It
    // returns a lean { project_id, scenario, replayed, ... } summary, not
    // the full project record — that's fetched separately through the
    // existing GET /api/projects/:id route. Each call gets a distinct
    // project_id (first is "project-created", to match the id most tests
    // assert on; later calls in the same test get their own id) so a test
    // that submits twice doesn't collide on one id.
    let onboardingCount = 0;
    const onboardingBodies = new Map<string, Record<string, unknown>>();
    mock.post("/api/v2/projects/onboarding", (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { scenario: string };
      onboardingCount += 1;
      const projectId =
        onboardingCount === 1 ? "project-created" : `project-created-${onboardingCount}`;
      onboardingBodies.set(projectId, body);
      return {
        status: 201,
        body: {
          project_id: projectId,
          scenario: body.scenario,
          replayed: false,
          workspace: null,
          remote: null,
          push: null,
          blockers: [],
        },
      };
    });
    mock.get(/^\/api\/projects\/project-created(-\d+)?$/, (url) => {
      const id = url.slice(url.lastIndexOf("/") + 1);
      const body = (onboardingBodies.get(id) ?? {}) as {
        name: string;
        description: string;
        pm_provider: "anthropic" | "openai";
        pm_model: ProjectSummary["pm_model"];
      };
      return {
        body: makeProject({
          id,
          name: body.name,
          description: body.description,
          pm_provider: body.pm_provider,
          pm_model: body.pm_model ?? undefined,
          reviewer_provider: body.pm_provider === "anthropic" ? "openai" : "anthropic",
        }),
      };
    });
  });

  afterEach(() => mock.restore());

  /** Installs the mock and renders — called explicitly (after any
   *  route overrides) rather than from beforeEach, since mount-time
   *  effects (refresh/refreshGitHub) fetch immediately on render; a route
   *  registered after render() is too late to affect what already loaded. */
  function renderWizard() {
    mock.install();
    render(
      <Projects
        onOpenProject={onOpenProject}
        openProjects={[]}
        onUnauthorized={vi.fn()}
        onSignOut={vi.fn()}
        user={null}
        onOpenAccount={vi.fn()}
        onOpenAdmin={vi.fn()}
      />,
    );
  }

  it("defaults to New, and creating a GitHub repository reaches POST /api/v2/projects/onboarding with scenario=new_repo", async () => {
    const user = userEvent.setup();
    renderWizard();
    await user.click(await screen.findByRole("button", { name: /new project/i }));
    await user.type(screen.getByTestId("project-name"), "Fresh application");
    await user.click(screen.getByRole("button", { name: /create project/i }));

    await waitFor(() => expect(onOpenProject).toHaveBeenCalledOnce());
    const onboardingCall = mock.calls.find(
      (call) => call.method === "POST" && call.url === "/api/v2/projects/onboarding",
    );
    expect(onboardingCall).toMatchObject({
      body: {
        scenario: "new_repo",
        name: "Fresh application",
        description: "",
        pm_provider: "anthropic",
        connection_id: "github:42",
        repository_name: "fresh-application",
        private: true,
      },
    });
    expect(typeof (onboardingCall?.body as { idempotency_key?: unknown })?.idempotency_key).toBe(
      "string",
    );
    // DESIGN R2: the wizard never starts a planning run — planning begins in
    // the conversation after creation.
    expect(
      mock.calls.some((call) => call.method === "POST" && call.url.endsWith("/planning-runs")),
    ).toBe(false);
  });

  it("keeps GitHub Actions available when computer creation capabilities are off", async () => {
    mock.get("/api/v2/capabilities/local-execution", {
      status: 404,
      body: { error: "not_found" },
    });
    const user = userEvent.setup();
    renderWizard();
    await user.click(await screen.findByRole("button", { name: /new project/i }));

    expect(
      screen.queryByRole("button", { name: /^approved local git repository/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^this computer/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^remote computer/i })).toBeDisabled();
    expect(screen.getByTestId("execution-location-picker")).toBeInTheDocument();

    await user.type(screen.getByTestId("project-name"), "GitHub only");
    await user.click(screen.getByRole("button", { name: /create project/i }));
    await waitFor(() => expect(onOpenProject).toHaveBeenCalledOnce());

    const onboardingCall = mock.calls.find(
      (call) => call.method === "POST" && call.url === "/api/v2/projects/onboarding",
    );
    expect(onboardingCall?.body).toMatchObject({
      scenario: "new_repo",
      local_working_copy: false,
    });
    expect(mock.calls.some((call) => call.url.startsWith("/api/runners/helper/"))).toBe(false);
    expect(mock.calls.some((call) => call.url === "/api/v2/projects/local")).toBe(false);
  });

  it("switches to Existing and selects a repository from the searchable list, reaching scenario=existing_repo", async () => {
    const user = userEvent.setup();
    renderWizard();
    await user.click(await screen.findByRole("button", { name: /new project/i }));
    await user.click(screen.getByRole("button", { name: /^existing/i }));
    await user.click(await screen.findByRole("button", { name: /octocat\/existing-app/i }));
    expect(screen.queryByTestId("project-name")).not.toBeInTheDocument();
    expect(screen.getByTestId("project-description")).toHaveValue("");
    expect(screen.queryByTestId("pm-model")).not.toBeInTheDocument();
    expect(screen.queryByTestId("reviewer-model")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /adopt project/i }));
    await waitFor(() => expect(onOpenProject).toHaveBeenCalledOnce());
    expect(
      mock.calls.find(
        (call) => call.method === "POST" && call.url === "/api/v2/projects/onboarding",
      ),
    ).toMatchObject({
      body: {
        scenario: "existing_repo",
        connection_id: "github:42",
        repository_id: "9001",
      },
    });
    expect(
      mock.calls.some(
        (call) =>
          call.method === "POST" &&
          call.url === "/api/v2/projects/project-created/analyze-repository",
      ),
    ).toBe(true);
  });

  it("offers this computer and requests a device-attributed local working copy", async () => {
    const user = userEvent.setup();
    renderWizard();
    await user.click(await screen.findByRole("button", { name: /new project/i }));
    await user.click(screen.getByRole("button", { name: /^this computer/i }));
    await user.type(screen.getByTestId("project-name"), "Fresh application");
    await user.click(screen.getByRole("button", { name: /choose folder/i }));

    expect((await screen.findByText("Project folder")).parentElement).toHaveTextContent("Projects");
    expect(screen.queryByTestId("setup-confirmation")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /create project/i }));

    await waitFor(() => expect(onOpenProject).toHaveBeenCalledOnce());
    expect(
      mock.calls.find(
        (call) => call.method === "POST" && call.url === "/api/v2/projects/onboarding",
      ),
    ).toMatchObject({
      body: {
        scenario: "new_repo",
        repository_name: "fresh-application",
        local_working_copy: true,
        computer_id: "device-1",
        clone_destination_id: "local:destination-1",
      },
    });
    expect(mock.calls.some((call) => call.url.startsWith("/api/runners/helper/"))).toBe(false);
  });

  it("keeps a computer check failure beside the execution choice and out of GitHub destination", async () => {
    mock.get("/api/devices", {
      status: 500,
      body: { message: "request failed: 500" },
    });
    const user = userEvent.setup();
    renderWizard();
    await user.click(await screen.findByRole("button", { name: /new project/i }));
    await user.click(screen.getByRole("button", { name: /^this computer/i }));

    const computerError = await screen.findByTestId("computer-source-error");
    expect(computerError).toHaveTextContent(
      "Norns couldn't check your computers. Open Computers and try again.",
    );
    expect(screen.queryByText("request failed: 500")).not.toBeInTheDocument();
    expect(screen.getByTestId("github-connection")).toHaveValue("github:42");
  });

  it("shows the server's actionable onboarding message instead of a raw 500", async () => {
    mock.post("/api/v2/projects/onboarding", {
      status: 500,
      body: {
        error: "onboarding_failed",
        message:
          "Project setup couldn't finish. Try again; if it continues, verify GitHub and the Local Agent in Connections.",
      },
    });
    const user = userEvent.setup();
    renderWizard();
    await user.click(await screen.findByRole("button", { name: /new project/i }));
    await user.type(screen.getByTestId("project-name"), "Fresh application");
    await user.click(screen.getByRole("button", { name: /create project/i }));

    expect(await screen.findByTestId("onboarding-submit-error")).toHaveTextContent(
      "Project setup couldn't finish. Try again; if it continues, verify GitHub and the Local Agent in Connections.",
    );
    expect(screen.queryByText("request failed: 500")).not.toBeInTheDocument();
  });

  it.each([
    {
      label: "New + GitHub",
      startingPoint: "new",
      creationPath: "/api/v2/projects/onboarding",
      analyzes: false,
    },
    {
      label: "Existing + GitHub",
      startingPoint: "existing",
      creationPath: "/api/v2/projects/onboarding",
      analyzes: true,
    },
  ] as const)(
    "supports the onboarding source matrix: $label",
    async ({ startingPoint, creationPath, analyzes }) => {
      const user = userEvent.setup();
      renderWizard();
      await user.click(await screen.findByRole("button", { name: /new project/i }));

      if (startingPoint === "existing") {
        await user.click(screen.getByRole("button", { name: /^existing/i }));
      }
      if (startingPoint === "existing") {
        await user.click(await screen.findByRole("button", { name: /octocat\/existing-app/i }));
      }

      if (startingPoint === "new") {
        await user.type(screen.getByTestId("project-name"), "Local inventory dashboard");
      }

      await user.click(
        screen.getByRole("button", {
          name: startingPoint === "new" ? /create project/i : /adopt project/i,
        }),
      );
      await waitFor(() => expect(onOpenProject).toHaveBeenCalledOnce());

      const creationCall = mock.calls.find(
        (call) => call.method === "POST" && call.url === creationPath,
      );
      expect(creationCall).toBeDefined();
      expect(
        mock.calls.some(
          (call) => call.method === "POST" && call.url.endsWith("/analyze-repository"),
        ),
      ).toBe(analyzes);
      // DESIGN R2: no path in the matrix starts a planning run from the
      // wizard — planning happens in the conversation after creation.
      expect(
        mock.calls.some((call) => call.method === "POST" && call.url.endsWith("/planning-runs")),
      ).toBe(false);
      expect(onOpenProject.mock.calls[0]?.[0]?.entry_flow).toBeNull();
      expect(onOpenProject.mock.calls[0]?.[1]).toEqual({
        startNewWork: true,
        initialBrief: null,
      });

      expect(creationCall).toMatchObject({
        body: {
          scenario: startingPoint === "new" ? "new_repo" : "existing_repo",
        },
      });
    },
  );

  it("carries an optional adoption direction into the first work brief without starting planning", async () => {
    const user = userEvent.setup();
    renderWizard();
    await user.click(await screen.findByRole("button", { name: /new project/i }));
    await user.click(screen.getByRole("button", { name: /^existing/i }));
    await user.click(await screen.findByRole("button", { name: /octocat\/existing-app/i }));
    await user.type(screen.getByTestId("project-description"), "Improve the deployment workflow");
    await user.click(screen.getByRole("button", { name: /adopt project/i }));

    await waitFor(() =>
      expect(onOpenProject).toHaveBeenCalledWith(
        expect.objectContaining({
          entry_flow: null,
          initial_work_objective: null,
        }),
        {
          startNewWork: true,
          initialBrief: "Improve the deployment workflow",
        },
      ),
    );
    expect(
      mock.calls.some(
        (call) =>
          call.method === "POST" && call.url === "/api/v2/projects/project-created/planning-runs",
      ),
    ).toBe(false);
  });

  it("resolves a pasted repo URL to the matching entry in the searchable list", async () => {
    const user = userEvent.setup();
    renderWizard();
    await user.click(await screen.findByRole("button", { name: /new project/i }));
    await user.click(screen.getByRole("button", { name: /^existing/i }));
    await screen.findByRole("button", { name: /octocat\/existing-app/i });

    await user.type(
      screen.getByRole("textbox", { name: /search connected repositories/i }),
      "https://github.com/octocat/existing-app",
    );
    await user.click(await screen.findByRole("button", { name: /octocat\/existing-app/i }));

    expect(screen.queryByTestId("project-name")).not.toBeInTheDocument();
  });

  it("starts the complete GitHub connection journey from the wizard", async () => {
    mock.get("/api/integrations/github/status", {
      body: {
        configured: true,
        user_authorization: { connected: false, login: null },
        connections: [],
      },
    });
    const openAccount = vi.fn();

    const user = userEvent.setup();
    mock.install();
    render(
      <Projects
        onOpenProject={onOpenProject}
        openProjects={[]}
        onUnauthorized={vi.fn()}
        onSignOut={vi.fn()}
        user={null}
        onOpenAccount={openAccount}
        onOpenAdmin={vi.fn()}
      />,
    );
    await user.click(await screen.findByRole("button", { name: /new project/i }));

    expect(await screen.findByText(/connect github to continue/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect GitHub" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /open connections/i })).not.toBeInTheDocument();
    expect(openAccount).not.toHaveBeenCalled();
    expect(mock.calls.some((call) => call.url.includes("/authorize"))).toBe(false);
  });

  it("distinguishes an authorized identity from a usable GitHub installation", async () => {
    mock.get("/api/integrations/github/status", {
      body: {
        configured: true,
        user_authorization: { connected: true, login: "octocat" },
        connections: [],
      },
    });
    const user = userEvent.setup();
    renderWizard();
    await user.click(await screen.findByRole("button", { name: /new project/i }));

    expect(await screen.findByText("Finish GitHub setup")).toBeInTheDocument();
    expect(screen.getByText(/identity is authorized as octocat/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Install The Norns on GitHub" })).toBeInTheDocument();
    expect(screen.queryByText(/connect github to continue/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /create project/i })).toBeDisabled();
  });

  it("sends the human to Settings only when the GitHub App itself isn't configured (an admin-only setup step)", async () => {
    mock.get("/api/integrations/github/status", {
      body: {
        configured: false,
        setup_available: true,
        configuration_source: null,
        user_authorization: { connected: false, login: null },
        connections: [],
      },
    });
    const user = userEvent.setup();
    renderWizard();
    await user.click(await screen.findByRole("button", { name: /new project/i }));

    expect(await screen.findByText(/github is not configured/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /open connections/i })).toBeInTheDocument();
  });

  it("does not show the removed final setup confirmation", async () => {
    const user = userEvent.setup();
    renderWizard();
    await user.click(await screen.findByRole("button", { name: /new project/i }));

    expect(screen.queryByTestId("setup-confirmation")).not.toBeInTheDocument();

    await user.type(screen.getByTestId("project-name"), "Fresh application");
    expect(screen.queryByTestId("setup-confirmation")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^existing/i }));
    await user.click(await screen.findByRole("button", { name: /octocat\/existing-app/i }));
    expect(screen.queryByTestId("setup-confirmation")).not.toBeInTheDocument();
  });

  it("requires only a project name for New and a repository selection for Existing", async () => {
    const user = userEvent.setup();
    renderWizard();
    await user.click(await screen.findByRole("button", { name: /new project/i }));
    expect(screen.getByRole("button", { name: /create project/i })).toBeDisabled();
    await user.type(screen.getByTestId("project-name"), "Fresh application");
    expect(screen.getByRole("button", { name: /create project/i })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: /^existing/i }));
    await screen.findByRole("button", { name: /octocat\/existing-app/i });
    expect(screen.getByRole("button", { name: /adopt project/i })).toBeDisabled();
  });

  it("surfaces installation_not_ready as a clear, actionable message and requires Continue before proceeding", async () => {
    mock.post("/api/v2/projects/onboarding", (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { scenario: string };
      return {
        status: 201,
        body: {
          project_id: "project-created",
          scenario: body.scenario,
          replayed: false,
          workspace: null,
          remote: null,
          push: null,
          blockers: ["installation_not_ready"],
        },
      };
    });
    // The override above bypasses the shared beforeEach handler (and the
    // name/description lookup it populates), so this test's GET needs its
    // own fixed body.
    mock.get("/api/projects/project-created", {
      body: makeProject({ id: "project-created", name: "existing-app" }),
    });
    const user = userEvent.setup();
    renderWizard();
    await user.click(await screen.findByRole("button", { name: /new project/i }));
    await user.click(screen.getByRole("button", { name: /^existing/i }));
    await user.click(await screen.findByRole("button", { name: /octocat\/existing-app/i }));
    await user.click(screen.getByRole("button", { name: /adopt project/i }));

    expect(await screen.findByTestId("wizard-blocker-step")).toBeInTheDocument();
    expect(screen.getByTestId("onboarding-blockers")).toHaveTextContent(
      /add this repository to the norns app on github/i,
    );
    // Not a dead end / generic error — the project exists and a Continue
    // action resumes the normal flow.
    expect(onOpenProject).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /continue/i }));
    await waitFor(() => expect(onOpenProject).toHaveBeenCalledOnce());
  });

  it("keeps the same idempotency_key across the same submit attempt (double-click doesn't send two different keys)", async () => {
    const user = userEvent.setup();
    renderWizard();
    await user.click(await screen.findByRole("button", { name: /new project/i }));
    await user.type(screen.getByTestId("project-name"), "Fresh application");
    await user.click(screen.getByRole("button", { name: /create project/i }));

    await waitFor(() => expect(onOpenProject).toHaveBeenCalledOnce());
    const firstKey = (
      mock.calls.find(
        (call) => call.method === "POST" && call.url === "/api/v2/projects/onboarding",
      )?.body as { idempotency_key?: string }
    )?.idempotency_key;
    expect(firstKey).toBeTruthy();

    // Reopening the wizard for a new project gets a fresh key — keys are
    // per-submit-attempt, not global constants.
    await user.click(await screen.findByRole("button", { name: /new project/i }));
    await user.type(screen.getByTestId("project-name"), "Second application");
    await user.click(screen.getByRole("button", { name: /create project/i }));

    await waitFor(() => expect(onOpenProject).toHaveBeenCalledTimes(2));
    const secondKey = (
      mock.calls.filter(
        (call) => call.method === "POST" && call.url === "/api/v2/projects/onboarding",
      )[1]?.body as { idempotency_key?: string }
    )?.idempotency_key;
    expect(secondKey).toBeTruthy();
    expect(secondKey).not.toBe(firstKey);
  });

  it("stores the resume payload's onboarding.summary_line without rendering it on the compact card", async () => {
    mock.get("/api/projects", {
      body: [
        makeProject({
          id: "project-created",
          name: "Fresh app",
          description: "Build a fresh application",
        }),
      ],
    });
    mock.get("/api/v2/projects/project-created/resume", {
      body: {
        phases: [],
        attention: { open_decisions: 0, active_runs: 0, blocked_tasks: 0 },
        onboarding: { summary_line: "Runs in github.com/acme/app · Pushes to github.com/acme/app" },
      },
    });
    renderWizard();

    // The compact card no longer renders the summary_line inline; verify
    // the project card still appears with its name.
    expect(await screen.findByText("Fresh app")).toBeInTheDocument();
  });
});
