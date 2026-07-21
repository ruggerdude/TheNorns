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

describe("FRONT DOOR P2b: reviewer selector", () => {
  let mock: MockFetch;
  const onOpenProject = vi.fn<(project: ProjectSummary) => void>();

  afterEach(() => mock.restore());

  function setup() {
    onOpenProject.mockReset();
    mock = new MockFetch();
    mock.get("/api/projects", { body: [] });
    mock.get("/api/v2/attention", { status: 404, body: {} });
    mock.post("/api/projects", (_url, init) => {
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
    await user.click(screen.getByRole("button", { name: /create & draft plan/i }));

    expect(await screen.findByTestId("wizard-attach-step")).toBeInTheDocument();
  });
});
