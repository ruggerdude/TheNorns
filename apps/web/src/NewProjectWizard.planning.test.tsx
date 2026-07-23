// FRONT DOOR P1 (wizard): a brand-new project with an objective moves to a
// second in-place wizard step — attach reference screenshots via the real
// P4 AttachmentInput component (which needs a live project id, so the
// project is created first), then explicitly starts the planning run
// (POST .../planning-runs) with the objective, rounds, and attachment ids.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ProjectSummary, Projects } from "./Projects";
import { makeProject } from "./test/fixtures";
import { MockFetch } from "./test/mockFetch";

describe("new project wizard: create -> attach -> planning run", () => {
  let mock: MockFetch;
  const onOpenProject = vi.fn<(project: ProjectSummary) => void>();

  afterEach(() => mock.restore());

  function setup() {
    onOpenProject.mockReset();
    mock = new MockFetch();
    mock.get("/api/projects", { body: [] });
    mock.get("/api/v2/attention", { status: 404, body: {} });
    mock.get("/api/integrations/github/status", {
      body: {
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
        ],
      },
    });
    // O1: onboarding always creates/binds a GitHub repository now — POST
    // /api/v2/projects/onboarding is the single creation endpoint, returning
    // a lean { project_id, scenario, replayed, ... } summary rather than the
    // full project record (fetched separately via GET /api/projects/:id).
    mock.post("/api/v2/projects/onboarding", {
      status: 201,
      body: {
        project_id: "proj_wizard",
        scenario: "new_repo",
        replayed: false,
        workspace: null,
        remote: null,
        push: null,
        blockers: [],
      },
    });
    mock.get("/api/projects/proj_wizard", (_url, _init) => {
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
        }),
      };
    });
    mock.post("/api/v2/projects/proj_wizard/attachments", {
      status: 201,
      body: {
        id: "att_1",
        mime: "image/png",
        bytes: 1200,
        width: 4,
        height: 4,
        purpose: "objective",
      },
    });
    mock.post("/api/v2/projects/proj_wizard/planning-runs", {
      status: 202,
      body: { planning_run_id: "run_1" },
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
        onOpenAccount={vi.fn()}
        onOpenAdmin={vi.fn()}
      />,
    );
  }

  function pngFile(name = "screenshot.png"): File {
    return new File([new Uint8Array([1, 2, 3, 4])], name, { type: "image/png" });
  }

  it("creates the project, uploads an attached image, then starts the planning run with objective/rounds/attachment_ids", async () => {
    setup();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: /new project/i }));
    await user.type(screen.getByTestId("project-name"), "Ravel search index");
    await user.type(
      screen.getByTestId("project-description"),
      "Stand up a hybrid vector + keyword index over the docs corpus.",
    );

    // Bump the rounds stepper from its default of 3 to 4.
    await user.click(screen.getByRole("button", { name: /more rounds/i }));
    await user.type(await screen.findByTestId("github-new-repository-name"), "ravel-search-index");

    await user.click(screen.getByRole("button", { name: /create & draft plan/i }));

    // Step 2: the project now exists — the real AttachmentInput is mounted
    // against it, and the objective carried over automatically.
    expect(await screen.findByTestId("wizard-attach-step")).toBeInTheDocument();
    expect(
      mock.calls.filter(
        (call) => call.method === "POST" && call.url === "/api/v2/projects/onboarding",
      ),
    ).toHaveLength(1);
    expect(screen.getByTestId("wizard-objective")).toHaveValue(
      "Stand up a hybrid vector + keyword index over the docs corpus.",
    );

    const fileInput = screen.getByTestId("attachment-file-input");
    await user.upload(fileInput, pngFile());
    expect(await screen.findByTestId("attachment-chip")).toBeInTheDocument();
    expect(
      mock.calls.find(
        (call) => call.method === "POST" && call.url === "/api/v2/projects/proj_wizard/attachments",
      ),
    ).toMatchObject({
      body: expect.any(File),
      headers: {
        "content-type": "image/png",
        "x-attachment-purpose": "objective",
      },
    });

    await user.click(screen.getByRole("button", { name: /start planning run/i }));

    await waitFor(() => expect(onOpenProject).toHaveBeenCalledOnce());
    expect(
      mock.calls.find(
        (call) =>
          call.method === "POST" && call.url === "/api/v2/projects/proj_wizard/planning-runs",
      ),
    ).toMatchObject({
      body: {
        objective: "Stand up a hybrid vector + keyword index over the docs corpus.",
        max_rounds: 4,
        attachment_ids: ["att_1"],
      },
    });
    expect(onOpenProject).toHaveBeenCalledWith(
      expect.objectContaining({ id: "proj_wizard", focus_planning_run_id: "run_1" }),
    );
  });

  it("lets the human skip planning entirely after the project is created", async () => {
    setup();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: /new project/i }));
    await user.type(screen.getByTestId("project-name"), "Nimbus API gateway");
    await user.type(screen.getByTestId("project-description"), "Consolidate the edge gateways.");
    await user.type(await screen.findByTestId("github-new-repository-name"), "nimbus-api-gateway");
    await user.click(screen.getByRole("button", { name: /create & draft plan/i }));

    await screen.findByTestId("wizard-attach-step");
    await user.click(screen.getByRole("button", { name: /skip for now/i }));

    await waitFor(() => expect(onOpenProject).toHaveBeenCalledOnce());
    expect(mock.calls.some((call) => call.url.includes("/planning-runs"))).toBe(false);
    expect(onOpenProject).toHaveBeenCalledWith(expect.objectContaining({ id: "proj_wizard" }));
  });

  it("surfaces a planning-run start failure without losing the attached image", async () => {
    setup();
    mock.post("/api/v2/projects/proj_wizard/planning-runs", {
      status: 500,
      body: { message: "planning worker unavailable" },
    });
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: /new project/i }));
    await user.type(screen.getByTestId("project-name"), "Helm mobile onboarding");
    await user.type(screen.getByTestId("project-description"), "Rebuild the first-run flow.");
    await user.type(
      await screen.findByTestId("github-new-repository-name"),
      "helm-mobile-onboarding",
    );
    await user.click(screen.getByRole("button", { name: /create & draft plan/i }));

    await screen.findByTestId("wizard-attach-step");
    await user.upload(screen.getByTestId("attachment-file-input"), pngFile());
    await screen.findByTestId("attachment-chip");

    await user.click(screen.getByRole("button", { name: /start planning run/i }));

    expect(await screen.findByTestId("planning-run-error")).toHaveTextContent(
      /planning worker unavailable/i,
    );
    expect(onOpenProject).not.toHaveBeenCalled();
    // The attached image is still there — the human doesn't lose their work.
    expect(screen.getByTestId("attachment-chip")).toBeInTheDocument();
  });
});
