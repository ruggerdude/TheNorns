// O1 (ONBOARDING program): the project-creation wizard collapsed to a
// single question — "Is this new, or existing work?" — because execution
// moved to GitHub Actions (REDIRECT: nothing is ever installed on the
// user's machine, so there is no local-folder scenario anymore). Both
// answers resolve to a GitHub repository:
//   new_repo:      Norns creates a fresh repository.
//   existing_repo: the human picks one of the connected account's
//                  repositories (searchable list, or paste a repo URL).
// Both require a GitHub connection first, so the connect step is
// first-class inside the wizard rather than something buried in Settings.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ProjectSummary, Projects } from "./Projects";
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

describe("O1: two-question onboarding (GitHub Actions only)", () => {
  let mock: MockFetch;
  const onOpenProject = vi.fn<(project: ProjectSummary) => void>();

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
        onCloseProject={vi.fn()}
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
    await user.type(screen.getByTestId("project-name"), "Fresh app");
    await user.type(screen.getByTestId("project-description"), "Build a fresh application");
    await user.type(await screen.findByTestId("github-new-repository-name"), "fresh-app");

    await user.click(screen.getByRole("button", { name: /create & draft plan/i }));
    // A "new" project with an objective moves to the wizard's
    // attach-and-launch step (FRONT DOOR P1); skip it — this test is only
    // about the onboarding request shape.
    await user.click(await screen.findByRole("button", { name: /skip for now/i }));

    await waitFor(() => expect(onOpenProject).toHaveBeenCalledOnce());
    const onboardingCall = mock.calls.find(
      (call) => call.method === "POST" && call.url === "/api/v2/projects/onboarding",
    );
    expect(onboardingCall).toMatchObject({
      body: {
        scenario: "new_repo",
        name: "Fresh app",
        description: "Build a fresh application",
        pm_provider: "anthropic",
        connection_id: "github:42",
        repository_name: "fresh-app",
        private: true,
      },
    });
    expect(typeof (onboardingCall?.body as { idempotency_key?: unknown })?.idempotency_key).toBe(
      "string",
    );
  });

  it("switches to Existing and selects a repository from the searchable list, reaching scenario=existing_repo", async () => {
    const user = userEvent.setup();
    renderWizard();
    await user.click(await screen.findByRole("button", { name: /new project/i }));
    await user.click(screen.getByRole("button", { name: /^existing/i }));
    await user.click(await screen.findByRole("button", { name: /octocat\/existing-app/i }));
    expect(screen.getByTestId("project-name")).toHaveValue("existing-app");
    expect(screen.getByTestId("project-description")).toHaveValue("Existing application");

    await user.click(screen.getByRole("button", { name: /create and open project/i }));
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

    expect(screen.getByTestId("project-name")).toHaveValue("existing-app");
  });

  it("shows a single Connect GitHub button (not a Settings redirect) when nothing is connected yet, and runs the existing authorize flow", async () => {
    mock.get("/api/integrations/github/status", {
      body: {
        configured: true,
        user_authorization: { connected: false, login: null },
        connections: [],
      },
    });
    mock.get("/api/integrations/github/authorize", {
      body: { authorization_url: "https://github.com/login/oauth/authorize?state=abc" },
    });
    const assignSpy = vi.fn();
    Object.defineProperty(window, "location", {
      value: { ...window.location, assign: assignSpy },
      writable: true,
    });

    const user = userEvent.setup();
    renderWizard();
    await user.click(await screen.findByRole("button", { name: /new project/i }));

    expect(await screen.findByText(/connect github to continue/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /open settings/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^connect github$/i }));

    await waitFor(() =>
      expect(assignSpy).toHaveBeenCalledWith("https://github.com/login/oauth/authorize?state=abc"),
    );
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
    expect(screen.getByRole("button", { name: /open settings/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^connect github$/i })).not.toBeInTheDocument();
  });

  it("shows the plain-language confirmation before the submit button, honest about GitHub Actions and never claiming to touch the user's machine", async () => {
    const user = userEvent.setup();
    renderWizard();
    await user.click(await screen.findByRole("button", { name: /new project/i }));

    expect(await screen.findByTestId("setup-confirmation")).toHaveTextContent(
      /choose or create a github repository/i,
    );

    await user.type(await screen.findByTestId("github-new-repository-name"), "fresh-app");
    expect(await screen.findByTestId("setup-confirmation")).toHaveTextContent(
      "Work happens in a GitHub Actions job inside octocat/fresh-app. Changes arrive as commits and pull requests in that repository — to get the files on your own machine, clone or pull as usual.",
    );

    await user.click(screen.getByRole("button", { name: /^existing/i }));
    await user.click(await screen.findByRole("button", { name: /octocat\/existing-app/i }));
    expect(await screen.findByTestId("setup-confirmation")).toHaveTextContent(
      /github actions job inside octocat\/existing-app/i,
    );
  });

  it("disables Create until a repository is named (new) or selected (existing)", async () => {
    const user = userEvent.setup();
    renderWizard();
    await user.click(await screen.findByRole("button", { name: /new project/i }));
    await user.type(screen.getByTestId("project-name"), "Fresh app");
    await user.type(screen.getByTestId("project-description"), "Build a fresh application");
    await screen.findByTestId("github-new-repository-name");
    expect(screen.getByRole("button", { name: /create & draft plan/i })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: /^existing/i }));
    await screen.findByRole("button", { name: /octocat\/existing-app/i });
    expect(screen.getByRole("button", { name: /create and open project/i })).toBeDisabled();
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
    await user.click(screen.getByRole("button", { name: /create and open project/i }));

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
    await user.type(screen.getByTestId("project-name"), "Fresh app");
    await user.type(screen.getByTestId("project-description"), "Build a fresh application");
    await user.type(await screen.findByTestId("github-new-repository-name"), "fresh-app");
    await user.click(screen.getByRole("button", { name: /create & draft plan/i }));
    await user.click(await screen.findByRole("button", { name: /skip for now/i }));

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
    await user.type(screen.getByTestId("project-name"), "Second app");
    await user.type(screen.getByTestId("project-description"), "Build a second application");
    await user.type(await screen.findByTestId("github-new-repository-name"), "second-app");
    await user.click(screen.getByRole("button", { name: /create & draft plan/i }));
    await user.click(await screen.findByRole("button", { name: /skip for now/i }));

    await waitFor(() => expect(onOpenProject).toHaveBeenCalledTimes(2));
    const secondKey = (
      mock.calls.filter(
        (call) => call.method === "POST" && call.url === "/api/v2/projects/onboarding",
      )[1]?.body as { idempotency_key?: string }
    )?.idempotency_key;
    expect(secondKey).toBeTruthy();
    expect(secondKey).not.toBe(firstKey);
  });

  it("prefers the resume payload's onboarding.summary_line on the dashboard card over re-deriving it client-side", async () => {
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

    expect(
      await screen.findByText("Runs in github.com/acme/app · Pushes to github.com/acme/app"),
    ).toBeInTheDocument();
  });
});
