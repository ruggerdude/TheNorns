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

describe("new project: one brief to canonical planning", () => {
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
    mock.post("/api/v2/projects/proj_wizard/planning-runs", {
      status: 202,
      body: { planning_run_id: "run_1" },
    });
    mock.post("/api/v2/projects/proj_wizard/attachments", {
      status: 201,
      body: {
        id: "att_1",
        mime: "image/png",
        bytes: 4,
        width: 1,
        height: 1,
        purpose: "objective",
      },
    });
    mock.install();
    render(
      <Projects
        onOpenProject={onOpenProject}
        openProjects={[]}
        onCloseProject={vi.fn()}
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

  it("derives a concise name and valid repository slug from the brief", () => {
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

  it("uses the sole destination automatically and needs only the brief", async () => {
    setup();
    const user = userEvent.setup();
    await openWizard();

    expect(screen.getByTestId("automatic-github-destination")).toHaveTextContent("octocat");
    expect(screen.queryByTestId("github-connection")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /create & start planning/i })).toBeDisabled();

    await user.type(
      screen.getByTestId("project-description"),
      "Build a lightweight habit tracker for distributed teams.",
    );
    expect(screen.getByTestId("derived-project-summary")).toHaveTextContent(
      "Lightweight habit tracker for distributed teams",
    );
    await user.click(screen.getByRole("button", { name: /create & start planning/i }));

    await waitFor(() => expect(onOpenProject).toHaveBeenCalledOnce());
    expect(
      mock.calls.find(
        (call) => call.method === "POST" && call.url === "/api/v2/projects/onboarding",
      ),
    ).toMatchObject({
      body: {
        scenario: "new_repo",
        name: "Lightweight habit tracker for distributed teams",
        description: "Build a lightweight habit tracker for distributed teams.",
        connection_id: "github:42",
        repository_name: "lightweight-habit-tracker-for-distributed-teams",
        private: true,
      },
    });
    expect(onOpenProject).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "proj_wizard",
        focus_planning_run_id: "run_1",
        entry_flow: "new",
      }),
    );
  });

  it("shows destination choice only when it changes repository ownership", async () => {
    setup([connection("github:42", "octocat"), connection("github:84", "acme")]);
    const user = userEvent.setup();
    await openWizard();
    await user.selectOptions(screen.getByTestId("github-connection"), "github:84");
    await user.type(screen.getByTestId("project-description"), "Create an incident timeline.");
    await user.click(screen.getByRole("button", { name: /create & start planning/i }));

    await waitFor(() => expect(onOpenProject).toHaveBeenCalledOnce());
    expect(
      mock.calls.find(
        (call) => call.method === "POST" && call.url === "/api/v2/projects/onboarding",
      ),
    ).toMatchObject({ body: { connection_id: "github:84" } });
  });

  it("applies identity, visibility, rounds, and attachment overrides downstream", async () => {
    setup();
    const user = userEvent.setup();
    await openWizard();
    await user.type(screen.getByTestId("project-description"), "Build a searchable docs corpus.");
    await user.click(screen.getByText("Optional details"));
    await user.type(screen.getByTestId("project-name"), "Ravel Search");
    await user.type(screen.getByTestId("github-new-repository-name"), "ravel-index");
    await user.selectOptions(screen.getByTestId("github-repository-visibility"), "public");
    await user.click(screen.getByRole("button", { name: /more rounds/i }));
    const file = new File([new Uint8Array([1, 2, 3, 4])], "reference.png", {
      type: "image/png",
    });
    await user.upload(screen.getByTestId("new-project-attachment-input"), file);
    await user.click(screen.getByRole("button", { name: /create & start planning/i }));

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
    expect(
      mock.calls.find((call) => call.method === "POST" && call.url.endsWith("/planning-runs")),
    ).toMatchObject({
      body: {
        objective: "Build a searchable docs corpus.",
        max_rounds: 4,
        attachment_ids: ["att_1"],
      },
    });
  });

  it("retains the created project and retries planning without creating again", async () => {
    setup();
    mock.post("/api/v2/projects/proj_wizard/planning-runs", {
      status: 500,
      body: { message: "planning worker unavailable" },
    });
    const user = userEvent.setup();
    await openWizard();
    await user.type(screen.getByTestId("project-description"), "Rebuild mobile onboarding.");
    await user.click(screen.getByRole("button", { name: /create & start planning/i }));

    expect(await screen.findByTestId("planning-run-error")).toHaveTextContent(
      "planning worker unavailable",
    );
    expect(screen.getAllByText("Rebuild mobile onboarding").length).toBeGreaterThan(0);
    expect(onOpenProject).not.toHaveBeenCalled();

    mock.post("/api/v2/projects/proj_wizard/planning-runs", {
      status: 202,
      body: { planning_run_id: "run_1" },
    });
    await user.click(screen.getByRole("button", { name: /retry planning/i }));
    await waitFor(() => expect(onOpenProject).toHaveBeenCalledOnce());
    expect(
      mock.calls.filter(
        (call) => call.method === "POST" && call.url === "/api/v2/projects/onboarding",
      ),
    ).toHaveLength(1);
  });

  it("recovers a planning run whose successful response was lost", async () => {
    setup();
    mock.networkError(
      "POST",
      "/api/v2/projects/proj_wizard/planning-runs",
      "connection reset after commit",
    );
    mock.get("/api/v2/projects/proj_wizard/planning-runs/latest", {
      body: { planning_run: { id: "run_recovered", status: "queued" } },
    });
    const user = userEvent.setup();
    await openWizard();
    await user.type(screen.getByTestId("project-description"), "Create an incident timeline.");
    await user.click(screen.getByRole("button", { name: /create & start planning/i }));

    await waitFor(() =>
      expect(onOpenProject).toHaveBeenCalledWith(
        expect.objectContaining({ focus_planning_run_id: "run_recovered", entry_flow: "new" }),
      ),
    );
    expect(screen.queryByTestId("planning-run-error")).not.toBeInTheDocument();
  });

  it("does not show success or start planning when repository creation fails", async () => {
    setup();
    mock.post("/api/v2/projects/onboarding", {
      status: 503,
      body: { message: "GitHub repository creation unavailable" },
    });
    const user = userEvent.setup();
    await openWizard();
    await user.type(screen.getByTestId("project-description"), "Create an incident timeline.");
    await user.click(screen.getByRole("button", { name: /create & start planning/i }));

    expect(await screen.findByText("GitHub repository creation unavailable")).toBeInTheDocument();
    expect(onOpenProject).not.toHaveBeenCalled();
    expect(
      mock.calls.some((call) => call.method === "POST" && call.url.endsWith("/planning-runs")),
    ).toBe(false);
    expect(screen.queryByTestId("wizard-attach-step")).not.toBeInTheDocument();
  });
});
