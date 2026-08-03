// FRONT DOOR P2b: the wizard's Reviewer field is wired to
// GET/PATCH/DELETE /api/v2/projects/:id/planning-reviewer. Picking an
// explicit model PATCHes it; leaving it on "Automatic" DELETEs any override
// (a no-op the first time, but a deterministic "apply the selection" either
// way) — both happen right after project creation, so the preference is in
// place before planning starts in the conversation (DESIGN R2: the wizard
// itself no longer kicks off a planning run).
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  ],
};

describe("FRONT DOOR P2b: reviewer selector", () => {
  let mock: MockFetch;
  const onOpenProject = vi.fn<(project: ProjectSummary) => void>();

  afterEach(() => mock.restore());

  function setup() {
    onOpenProject.mockReset();
    mock = new MockFetch();
    mock.get("/api/projects", { body: [] });
    mock.get("/api/v2/attention", { status: 404, body: {} });
    mock.get("/api/integrations/github/status", { body: githubStatus });
    // O1: onboarding always creates/binds a GitHub repository now — POST
    // /api/v2/projects/onboarding is the single creation endpoint, returning
    // a lean { project_id, scenario, replayed, ... } summary rather than the
    // full project record (fetched separately via GET /api/projects/:id).
    mock.post("/api/v2/projects/onboarding", {
      status: 201,
      body: {
        project_id: "project-created",
        scenario: "new_repo",
        replayed: false,
        workspace: null,
        remote: null,
        push: null,
        blockers: [],
      },
    });
    mock.get("/api/projects/project-created", (_url, _init) => {
      const onboardingCall = mock.calls.find(
        (call) => call.method === "POST" && call.url === "/api/v2/projects/onboarding",
      );
      const body = (onboardingCall?.body ?? {}) as { name: string; description: string };
      return {
        body: makeProject({
          id: "project-created",
          name: body.name,
          description: body.description,
          status: "draft",
          plan_objective: null,
        }),
      };
    });
    mock.post("/api/v2/projects/project-created/planning-runs", {
      status: 202,
      body: { planning_run_id: "run-reviewer" },
    });
    // Installed here, before render — the dashboard's mount-time effects
    // (refresh/refreshGitHub) fetch immediately, so the mock must be live
    // before render(), not after. Routes registered later by individual
    // tests (mock.patch/del) still take effect: MockFetch reads its routes
    // list live on every call, it doesn't snapshot at install() time.
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

  it("PATCHes an explicit reviewer model right after creation", async () => {
    setup();
    mock.patch("/api/v2/projects/project-created/planning-reviewer", { status: 204 });
    mock.install();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: /new project/i }));
    await user.type(screen.getByTestId("project-name"), "Ravel search index");
    await user.selectOptions(screen.getByTestId("reviewer-model"), "openai:gpt-5.6-sol");
    await user.type(await screen.findByTestId("github-new-repository-name"), "ravel-search-index");
    await user.click(screen.getByRole("button", { name: /create project/i }));

    await waitFor(() =>
      expect(
        mock.calls.find(
          (call) =>
            call.method === "PATCH" &&
            call.url === "/api/v2/projects/project-created/planning-reviewer",
        ),
      ).toMatchObject({ body: { provider: "openai", model: "gpt-5.6-sol" } }),
    );
    // Never DELETEd when an explicit choice was made.
    expect(
      mock.calls.find(
        (call) =>
          call.method === "DELETE" &&
          call.url === "/api/v2/projects/project-created/planning-reviewer",
      ),
    ).toBeUndefined();
  });

  it("QCP-4A: renders the QC mode control and submits the selected mode plus the rebuttals toggle", async () => {
    setup();
    mock.patch("/api/v2/projects/project-created/planning-reviewer", { status: 204 });
    mock.install();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: /new project/i }));
    await user.type(screen.getByTestId("project-name"), "Quill approvals pipeline");
    expect(screen.getByTestId("qc-mode")).toHaveValue("automatic");
    await user.selectOptions(screen.getByTestId("qc-mode"), "gated_when_contested");
    await user.click(screen.getByTestId("allow-unadjudicated-rebuttals"));
    // An explicit reviewer choice keeps this on the single-PATCH path; the
    // Automatic/DELETE path is covered separately below.
    await user.selectOptions(screen.getByTestId("reviewer-model"), "openai:gpt-5.6-sol");
    await user.type(
      await screen.findByTestId("github-new-repository-name"),
      "quill-approvals-pipeline",
    );
    await user.click(screen.getByRole("button", { name: /create project/i }));

    await waitFor(() =>
      expect(
        mock.calls.find(
          (call) =>
            call.method === "PATCH" &&
            call.url === "/api/v2/projects/project-created/planning-reviewer",
        ),
      ).toMatchObject({
        body: {
          provider: "openai",
          model: "gpt-5.6-sol",
          qc_mode: "gated_when_contested",
          allow_unadjudicated_rebuttals: true,
        },
      }),
    );
  });

  it("DELETEs (clears) the reviewer override when left on Automatic, and still PATCHes the QC cadence default", async () => {
    setup();
    mock.del("/api/v2/projects/project-created/planning-reviewer", { status: 204 });
    // QCP-4A: qc_mode/allow_unadjudicated_rebuttals are independent of the
    // reviewer override, so leaving the reviewer on Automatic (a DELETE)
    // still needs its own PATCH to carry the (default) QC cadence settings.
    mock.patch("/api/v2/projects/project-created/planning-reviewer", { status: 204 });
    mock.install();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: /new project/i }));
    await user.type(screen.getByTestId("project-name"), "Helm mobile onboarding");
    // Reviewer left at its default "Automatic" value — no selectOptions call.
    await user.type(
      await screen.findByTestId("github-new-repository-name"),
      "helm-mobile-onboarding",
    );
    await user.click(screen.getByRole("button", { name: /create project/i }));

    await waitFor(() =>
      expect(
        mock.calls.find(
          (call) =>
            call.method === "DELETE" &&
            call.url === "/api/v2/projects/project-created/planning-reviewer",
        ),
      ).toBeDefined(),
    );
    expect(
      mock.calls.find(
        (call) =>
          call.method === "PATCH" &&
          call.url === "/api/v2/projects/project-created/planning-reviewer",
      ),
    ).toMatchObject({
      body: {
        qc_mode: "automatic",
        allow_unadjudicated_rebuttals: false,
        default_max_rounds: 1,
      },
    });
  });

  it("QCP-14: submits the stepper's round count, including 0 (review off)", async () => {
    setup();
    mock.del("/api/v2/projects/project-created/planning-reviewer", { status: 204 });
    mock.patch("/api/v2/projects/project-created/planning-reviewer", { status: 204 });
    mock.install();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: /new project/i }));
    await user.type(screen.getByTestId("project-name"), "Zephyr zero rounds");
    // Routine default is 1; one click turns review off.
    const fewer = screen.getByRole("button", { name: /fewer rounds/i });
    await user.click(fewer);
    expect(screen.getByTestId("rounds-stepper")).toHaveTextContent("0");
    await user.type(await screen.findByTestId("github-new-repository-name"), "zephyr-zero-rounds");
    await user.click(screen.getByRole("button", { name: /create project/i }));

    await waitFor(() =>
      expect(
        mock.calls.find(
          (call) =>
            call.method === "PATCH" &&
            call.url === "/api/v2/projects/project-created/planning-reviewer",
        ),
      ).toMatchObject({ body: { default_max_rounds: 0 } }),
    );
  });

  it("still opens the workspace even if the reviewer-preference call fails (best-effort, not a blocker)", async () => {
    setup();
    mock.patch("/api/v2/projects/project-created/planning-reviewer", {
      status: 500,
      body: { message: "unavailable" },
    });
    mock.install();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: /new project/i }));
    await user.type(screen.getByTestId("project-name"), "Nimbus API gateway");
    await user.selectOptions(screen.getByTestId("reviewer-model"), "anthropic:claude-opus-4-8");
    await user.type(await screen.findByTestId("github-new-repository-name"), "nimbus-api-gateway");
    await user.click(screen.getByRole("button", { name: /create project/i }));
    await waitFor(() => expect(onOpenProject).toHaveBeenCalledOnce());
  });
});
