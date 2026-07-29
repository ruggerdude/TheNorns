// DESIGN R2: the wizard is name-first. The single required field is the
// project name (used directly for the project and repo slug); the project is
// created with an empty description and NO wizard planning kickoff — planning
// begins in the conversation after creation.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ProjectSummary, Projects, deriveProjectIdentity } from "./Projects";
import { makeProject } from "./test/fixtures";
import { MockFetch } from "./test/mockFetch";

const connection = (id: string, owner: string) => ({
  id,
  provider: "github" as const,
  display_name: `${owner} on GitHub`,
  owner_type: "user" as const,
  owner_login: owner,
  installation_id: id,
  repository_selection: "all" as const,
  status: "connected" as const,
  last_validated_at: "2026-07-16T20:00:00Z",
});

describe("new project: name-first creation, planning in the conversation", () => {
  let mock = new MockFetch();
  const onOpenProject = vi.fn<(project: ProjectSummary) => void>();
  const onOpenAccount = vi.fn();

  afterEach(() => mock.restore());

  function setup(connections = [connection("github:42", "octocat")]) {
    onOpenProject.mockReset();
    onOpenAccount.mockReset();
    mock = new MockFetch();
    mock.get("/api/projects", { body: [] });
    mock.get("/api/v2/attention", { status: 404, body: {} });
    mock.get("/api/integrations/github/status", {
      body: {
        configured: true,
        user_authorization: { connected: connections.length > 0, login: "octocat" },
        connections,
      },
    });
    mock.post("/api/v2/projects/onboarding", (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { scenario: string };
      return {
        status: 201,
        body: {
          project_id: "proj_wizard",
          scenario: body.scenario,
          replayed: false,
          workspace: null,
          remote: null,
          push: null,
          blockers: [],
        },
      };
    });
    mock.get("/api/projects/proj_wizard", () => {
      const onboardingCall = mock.calls.find(
        (call) => call.method === "POST" && call.url === "/api/v2/projects/onboarding",
      );
      const body = (onboardingCall?.body ?? {}) as { name: string; description: string };
      return {
        body: makeProject({
          id: "proj_wizard",
          name: body.name,
          description: body.description,
          status: "draft",
          plan_objective: null,
          onboarding_scenario: "new_repo",
        }),
      };
    });
    mock.del("/api/v2/projects/proj_wizard/planning-reviewer", { status: 204 });
    mock.install();
    render(
      <Projects
        onOpenProject={onOpenProject}
        openProjects={[]}
        onUnauthorized={vi.fn()}
        onSignOut={vi.fn()}
        user={null}
        onOpenAccount={onOpenAccount}
        onOpenAdmin={vi.fn()}
      />,
    );
  }

  async function openWizard() {
    await userEvent.click(await screen.findByRole("button", { name: /new project/i }));
  }

  it("derives a concise name and valid repository slug", () => {
    expect(
      deriveProjectIdentity("Build a lightweight habit tracker for distributed teams."),
    ).toEqual({
      projectName: "Lightweight habit tracker for distributed teams",
      repositorySlug: "lightweight-habit-tracker-for-distributed-teams",
    });
    expect(deriveProjectIdentity("Anything", "Launch Console", "console_v2")).toEqual({
      projectName: "Launch Console",
      repositorySlug: "console_v2",
    });
  });

  it("uses the sole destination automatically and needs only the project name", async () => {
    setup();
    const user = userEvent.setup();
    await openWizard();

    expect(screen.getByTestId("automatic-github-destination")).toHaveTextContent("octocat");
    expect(screen.queryByTestId("github-connection")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /create project/i })).toBeDisabled();

    await user.type(screen.getByTestId("project-name"), "Lightweight habit tracker");
    expect(screen.getByTestId("derived-project-summary")).toHaveTextContent(
      "Lightweight habit tracker",
    );
    await user.click(screen.getByRole("button", { name: /create project/i }));

    await waitFor(() => expect(onOpenProject).toHaveBeenCalledOnce());
    expect(
      mock.calls.find(
        (call) => call.method === "POST" && call.url === "/api/v2/projects/onboarding",
      ),
    ).toMatchObject({
      body: {
        scenario: "new_repo",
        name: "Lightweight habit tracker",
        description: "",
        connection_id: "github:42",
        repository_name: "lightweight-habit-tracker",
        private: true,
      },
    });
    expect(onOpenProject).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "proj_wizard",
        entry_flow: "new",
      }),
    );
  });

  it("does not start a planning run at creation — planning happens in the conversation", async () => {
    setup();
    const user = userEvent.setup();
    await openWizard();
    await user.type(screen.getByTestId("project-name"), "Incident timeline");
    await user.click(screen.getByRole("button", { name: /create project/i }));

    await waitFor(() => expect(onOpenProject).toHaveBeenCalledOnce());
    expect(
      mock.calls.some((call) => call.method === "POST" && call.url.endsWith("/planning-runs")),
    ).toBe(false);
    expect(onOpenProject.mock.calls[0]?.[0]?.focus_planning_run_id).toBeUndefined();
  });

  it("shows destination choice only when it changes repository ownership", async () => {
    setup([connection("github:42", "octocat"), connection("github:84", "acme")]);
    const user = userEvent.setup();
    await openWizard();
    await user.selectOptions(screen.getByTestId("github-connection"), "github:84");
    await user.type(screen.getByTestId("project-name"), "Incident timeline");
    await user.click(screen.getByRole("button", { name: /create project/i }));

    await waitFor(() => expect(onOpenProject).toHaveBeenCalledOnce());
    expect(
      mock.calls.find(
        (call) => call.method === "POST" && call.url === "/api/v2/projects/onboarding",
      ),
    ).toMatchObject({ body: { connection_id: "github:84" } });
  });

  it("applies slug and visibility overrides, without a reference-images input", async () => {
    setup();
    const user = userEvent.setup();
    await openWizard();
    await user.type(screen.getByTestId("project-name"), "Ravel Search");
    await user.click(screen.getByText("Options"));
    expect(screen.queryByTestId("new-project-attachment-input")).not.toBeInTheDocument();
    await user.type(screen.getByTestId("github-new-repository-name"), "ravel-index");
    await user.selectOptions(screen.getByTestId("github-repository-visibility"), "public");
    await user.click(screen.getByRole("button", { name: /create project/i }));

    await waitFor(() => expect(onOpenProject).toHaveBeenCalledOnce());
    expect(
      mock.calls.find(
        (call) => call.method === "POST" && call.url === "/api/v2/projects/onboarding",
      ),
    ).toMatchObject({
      body: {
        name: "Ravel Search",
        repository_name: "ravel-index",
        private: false,
      },
    });
  });

  it("allows zero plan review rounds and says review is off", async () => {
    setup();
    const user = userEvent.setup();
    await openWizard();
    await user.type(screen.getByTestId("project-name"), "Ravel Search");
    await user.click(screen.getByText("Options"));

    expect(screen.getByText("Cross-provider review is on.")).toBeInTheDocument();
    const fewer = screen.getByRole("button", { name: /fewer rounds/i });
    await user.click(fewer);
    await user.click(fewer);
    await user.click(fewer);
    expect(screen.getByTestId("rounds-stepper")).toHaveTextContent("0");
    expect(fewer).toBeDisabled();
    expect(screen.getByText("Plan review is off.")).toBeInTheDocument();
    expect(screen.queryByText("Cross-provider review is on.")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /more rounds/i }));
    expect(screen.getByText("Cross-provider review is on.")).toBeInTheDocument();
  });

  it("does not show success or navigate when repository creation fails", async () => {
    setup();
    mock.post("/api/v2/projects/onboarding", {
      status: 503,
      body: { message: "GitHub repository creation unavailable" },
    });
    const user = userEvent.setup();
    await openWizard();
    await user.type(screen.getByTestId("project-name"), "Incident timeline");
    await user.click(screen.getByRole("button", { name: /create project/i }));

    expect(await screen.findByText("GitHub repository creation unavailable")).toBeInTheDocument();
    expect(onOpenProject).not.toHaveBeenCalled();
    expect(
      mock.calls.some((call) => call.method === "POST" && call.url.endsWith("/planning-runs")),
    ).toBe(false);
  });
});
