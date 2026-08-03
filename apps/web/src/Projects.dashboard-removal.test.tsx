import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ProjectSummary, Projects } from "./Projects";
import { makeProject } from "./test/fixtures";
import { MockFetch } from "./test/mockFetch";

const alpha = makeProject({
  id: "proj_alpha",
  name: "Alpha",
  description: "First project",
});
const beta = makeProject({
  id: "proj_beta",
  name: "Beta",
  description: "Second project",
});

describe("project dashboard entry", () => {
  let mock: MockFetch;
  const onOpenProject = vi.fn<(project: ProjectSummary) => void>();

  beforeEach(() => {
    onOpenProject.mockReset();
    mock = new MockFetch();
    mock.get("/api/projects", { body: [alpha, beta] });
    mock.get("/api/v2/attention", { status: 404, body: {} });
    mock.get(/^\/api\/v2\/projects\/[^/]+\/resume$/, { status: 404, body: {} });
    mock.install();
  });

  afterEach(() => {
    mock.restore();
    vi.restoreAllMocks();
  });

  function setup() {
    render(
      <Projects
        onOpenProject={onOpenProject}
        openProjects={[alpha]}
        onUnauthorized={vi.fn()}
        onSignOut={vi.fn()}
        user={null}
        onOpenAccount={vi.fn()}
        onOpenAdmin={vi.fn()}
      />,
    );
  }

  it("starts with a Portfolio page title and New project in the application rail", async () => {
    setup();
    await screen.findByRole("link", { name: "Enter Alpha" });

    expect(screen.queryByText("Keep every project in motion.")).not.toBeInTheDocument();
    expect(screen.queryByText("Portfolio command center")).not.toBeInTheDocument();
    // DESIGN R2: "Portfolio" is the page's one true H1; the eyebrow/lede
    // helper copy around the section headings is gone.
    expect(screen.getByRole("heading", { name: "Portfolio", level: 1 })).toBeInTheDocument();
    expect(screen.queryByText("Your open and recent projects")).not.toBeInTheDocument();
    expect(screen.queryByText("Delivery detail")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Phase-by-phase progress, ownership, and next action."),
    ).not.toBeInTheDocument();
    // The create action is available from the shared rail instead of taking
    // up space in the Portfolio content.
    const createButton = screen.getByRole("button", { name: "New project" });
    expect(createButton.closest("section")).toBeNull();
    expect(createButton.closest(".topbar")).not.toBeNull();
    expect(createButton.closest(".portfolio-navigation")).not.toBeNull();
    expect(screen.queryByText("+ New project")).not.toBeInTheDocument();
  });

  it("keeps the application navigation while project setup replaces the main content", async () => {
    setup();
    await screen.findByRole("link", { name: "Enter Alpha" });
    const portfolioNavigation = screen.getByRole("navigation", {
      name: "Portfolio navigation",
    });

    await userEvent.click(screen.getByRole("button", { name: "New project" }));

    expect(screen.getByRole("main", { name: "New project" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Portfolio navigation" })).toBe(
      portfolioNavigation,
    );
    expect(portfolioNavigation.closest(".topbar")).not.toBeNull();
    // DESIGN R2: no in-page "Project setup" heading — the topbar location
    // "New project" is the page title.
    expect(screen.queryByRole("heading", { name: "Project setup" })).not.toBeInTheDocument();
    expect(screen.queryByText("Guided setup")).not.toBeInTheDocument();
    expect(screen.queryByText("Let's set the brief")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Quick access" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Enter Alpha" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "← Dashboard" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Portfolio" }));
    expect(await screen.findByRole("heading", { name: "Portfolio" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Quick access" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Enter Alpha" })).toBeInTheDocument();
  });

  it("enters a project from the full dashboard row by click or keyboard", async () => {
    setup();
    const alphaRow = await screen.findByRole("link", { name: "Enter Alpha" });

    await userEvent.click(alphaRow);
    expect(onOpenProject).toHaveBeenLastCalledWith(alpha);

    alphaRow.focus();
    await userEvent.keyboard("{Enter}");
    expect(onOpenProject).toHaveBeenCalledTimes(2);
    expect(onOpenProject).toHaveBeenLastCalledWith(alpha);
  });

  it("does not expose project removal controls in Portfolio", async () => {
    setup();
    await screen.findByRole("link", { name: "Enter Alpha" });

    expect(
      screen.queryByRole("button", { name: "Remove project from dashboard" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove project" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Enter Alpha" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Enter Beta" })).toBeVisible();
    expect(mock.calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  it("asks whether to remove the local folder when permanently deleting an archived project", async () => {
    mock.get("/api/admin/projects/archived", {
      body: [{ ...alpha, archived_at: "2026-08-01T12:00:00.000Z" }],
    });
    mock.get(`/api/v2/projects/${alpha.id}/deletion-options`, {
      body: {
        project_name: alpha.name,
        local_folder: { available: true, label: "Alpha working copy" },
        github_repository: { available: false, label: null },
      },
    });
    mock.del(`/api/v2/projects/${alpha.id}/destroy`, { status: 204 });
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(true).mockReturnValueOnce(true);
    setup();
    const user = userEvent.setup();

    await user.click(screen.getByText("Archived projects"));
    await user.click(await screen.findByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(
        mock.calls.find(
          (call) => call.method === "DELETE" && call.url === `/api/v2/projects/${alpha.id}/destroy`,
        ),
      ).toMatchObject({
        body: {
          delete_local_folder: true,
          delete_github_repository: false,
        },
      }),
    );
    expect(confirm).toHaveBeenNthCalledWith(
      1,
      'Permanently delete "Alpha"? This cannot be undone.',
    );
    expect(confirm).toHaveBeenNthCalledWith(
      2,
      'Also delete the local folder "Alpha working copy"? The files in that folder will be permanently removed.',
    );
  });
});
