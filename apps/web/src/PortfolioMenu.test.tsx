import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PortfolioMenu } from "./PortfolioMenu";
import { makeProject } from "./test/fixtures";

describe("PortfolioMenu", () => {
  it("opens the Portfolio and active projects from the sidebar menu", async () => {
    const user = userEvent.setup();
    const projects = [
      makeProject({ id: "project-one", name: "Oak" }),
      makeProject({ id: "project-two", name: "Rowan" }),
    ];
    const onNewProject = vi.fn();
    const onOpenPortfolio = vi.fn();
    const onOpenProject = vi.fn();

    render(
      <PortfolioMenu
        projects={projects}
        activeProjectId="project-two"
        onNewProject={onNewProject}
        onOpenPortfolio={onOpenPortfolio}
        onOpenProject={onOpenProject}
        onUnauthorized={vi.fn()}
      />,
    );

    const navigation = screen.getByRole("navigation", { name: "Portfolio navigation" });
    const newProject = screen.getByRole("button", { name: "New project" });
    const portfolio = screen.getByRole("button", { name: "Portfolio" });
    expect(newProject.compareDocumentPosition(portfolio)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    await user.click(portfolio);
    expect(onOpenPortfolio).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Show active projects" }));
    expect(screen.getByRole("button", { name: "Rowan" })).toHaveAttribute("aria-current", "page");

    await user.click(screen.getByRole("button", { name: "Oak" }));
    expect(onOpenProject).toHaveBeenCalledWith(projects[0]);
    expect(screen.queryByRole("button", { name: "Hide active projects" })).not.toBeInTheDocument();

    await user.click(newProject);
    expect(onNewProject).toHaveBeenCalledTimes(1);
    expect(navigation).toContainElement(newProject);
  });
});
