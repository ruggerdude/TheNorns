import { render, screen, waitFor, within } from "@testing-library/react";
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

describe("project dashboard entry and removal", () => {
  let mock: MockFetch;
  const onOpenProject = vi.fn<(project: ProjectSummary) => void>();
  const onCloseProject = vi.fn<(id: string) => void>();

  beforeEach(() => {
    onOpenProject.mockReset();
    onCloseProject.mockReset();
    mock = new MockFetch();
    mock.get("/api/projects", { body: [alpha, beta] });
    mock.get("/api/v2/attention", { status: 404, body: {} });
    mock.get(/^\/api\/v2\/projects\/[^/]+\/resume$/, { status: 404, body: {} });
    mock.del(`/api/projects/${alpha.id}`, { status: 204 });
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
        onCloseProject={onCloseProject}
        onUnauthorized={vi.fn()}
        onSignOut={vi.fn()}
        user={null}
        onOpenAccount={vi.fn()}
        onOpenAdmin={vi.fn()}
      />,
    );
  }

  it("starts with a Portfolio page title and New project centered at the top of the page", async () => {
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
    // DESIGN R2: the create action moved out of Quick access to the top of
    // the page (not in the topbar, not inside any section).
    const createButton = screen.getByRole("button", { name: "+ New project" });
    expect(createButton.closest("section")).toBeNull();
    expect(createButton.closest("header")).toBeNull();
    expect(createButton.closest(".portfolio-primary-action")).not.toBeNull();
  });

  it("opens project setup as a dedicated page and returns to the dashboard", async () => {
    setup();
    await screen.findByRole("link", { name: "Enter Alpha" });

    await userEvent.click(screen.getByRole("button", { name: "+ New project" }));

    expect(screen.getByRole("main", { name: "New project" })).toBeInTheDocument();
    // DESIGN R2: no in-page "Project setup" heading — the topbar location
    // "New project" is the page title.
    expect(screen.queryByRole("heading", { name: "Project setup" })).not.toBeInTheDocument();
    expect(screen.queryByText("Guided setup")).not.toBeInTheDocument();
    expect(screen.queryByText("Let's set the brief")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Quick access" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Enter Alpha" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "← Dashboard" }));
    expect(await screen.findByRole("heading", { name: "Quick access" })).toBeInTheDocument();
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

  it("confirms removal, archives through the API, closes the tab, and removes the row", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    setup();
    await screen.findByRole("link", { name: "Enter Alpha" });

    const alphaRow = screen.getByRole("link", { name: "Enter Alpha" }).closest("article");
    if (!alphaRow) throw new Error("Alpha project row is missing");
    await userEvent.click(
      within(alphaRow).getByRole("button", { name: "Remove project from dashboard" }),
    );

    await waitFor(() =>
      expect(screen.queryByRole("link", { name: "Enter Alpha" })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("link", { name: "Enter Beta" })).toBeVisible();
    expect(onCloseProject).toHaveBeenCalledWith(alpha.id);
    expect(onOpenProject).not.toHaveBeenCalled();
    expect(
      mock.calls.find(
        (call) => call.method === "DELETE" && call.url === `/api/projects/${alpha.id}`,
      ),
    ).toMatchObject({ body: undefined, headers: {} });
  });

  it("leaves the project in place when removal is cancelled", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    setup();
    await screen.findByRole("link", { name: "Enter Alpha" });

    const alphaRow = screen.getByRole("link", { name: "Enter Alpha" }).closest("article");
    if (!alphaRow) throw new Error("Alpha project row is missing");
    await userEvent.click(
      within(alphaRow).getByRole("button", { name: "Remove project from dashboard" }),
    );

    expect(screen.getByRole("link", { name: "Enter Alpha" })).toBeVisible();
    expect(mock.calls.some((call) => call.method === "DELETE")).toBe(false);
    expect(onCloseProject).not.toHaveBeenCalled();
  });
});
