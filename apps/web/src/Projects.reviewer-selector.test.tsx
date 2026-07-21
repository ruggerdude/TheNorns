// FRONT DOOR P2b: the wizard's Reviewer field is wired to
// GET/PATCH/DELETE /api/v2/projects/:id/planning-reviewer. Picking an
// explicit model PATCHes it; leaving it on "Automatic" DELETEs any override
// (a no-op the first time, but a deterministic "apply the selection" either
// way) — both happen right after project creation, before any planning run.
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
    // O1 REDIRECT: onboarding always creates/binds a GitHub repository now —
    // POST /api/v2/projects/onboarding is the single creation endpoint
    // (O2 building it in parallel; TODO(O2) in projectSourceRequest.ts).
    mock.post("/api/v2/projects/onboarding", (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { name: string; description: string };
      return {
        status: 201,
        body: makeProject({
          id: "project-created",
          name: body.name,
          description: body.description,
          status: "draft",
          plan_objective: null,
        }),
      };
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
        onCloseProject={vi.fn()}
        onUnauthorized={vi.fn()}
        onSignOut={vi.fn()}
        user={null}
        onOpenAccount={vi.fn()}
        onOpenAdmin={vi.fn()}
      />,
    );
  }

  it("PATCHes an explicit reviewer model right after creation, before the planning run starts", async () => {
    setup();
    mock.patch("/api/v2/projects/project-created/planning-reviewer", { status: 204 });
    mock.install();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: /new project/i }));
    await user.type(screen.getByTestId("project-name"), "Ravel search index");
    await user.type(
      screen.getByTestId("project-description"),
      "Stand up a hybrid vector + keyword index.",
    );
    await user.selectOptions(screen.getByTestId("reviewer-model"), "openai:gpt-5.6-sol");
    await user.type(await screen.findByTestId("github-new-repository-name"), "ravel-search-index");
    await user.click(screen.getByRole("button", { name: /create & draft plan/i }));

    // The wizard's attach-and-launch step confirms creation succeeded; the
    // reviewer PATCH already happened by this point (right after creation).
    await screen.findByTestId("wizard-attach-step");

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

  it("DELETEs (clears) the reviewer override when left on Automatic", async () => {
    setup();
    mock.del("/api/v2/projects/project-created/planning-reviewer", { status: 204 });
    mock.install();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: /new project/i }));
    await user.type(screen.getByTestId("project-name"), "Helm mobile onboarding");
    await user.type(screen.getByTestId("project-description"), "Rebuild the first-run flow.");
    // Reviewer left at its default "Automatic" value — no selectOptions call.
    await user.type(
      await screen.findByTestId("github-new-repository-name"),
      "helm-mobile-onboarding",
    );
    await user.click(screen.getByRole("button", { name: /create & draft plan/i }));

    await screen.findByTestId("wizard-attach-step");

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
    ).toBeUndefined();
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
    await user.type(screen.getByTestId("project-description"), "Consolidate the edge gateways.");
    await user.selectOptions(screen.getByTestId("reviewer-model"), "anthropic:claude-opus-4-8");
    await user.type(await screen.findByTestId("github-new-repository-name"), "nimbus-api-gateway");
    await user.click(screen.getByRole("button", { name: /create & draft plan/i }));

    expect(await screen.findByTestId("wizard-attach-step")).toBeInTheDocument();
  });
});
