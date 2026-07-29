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
    const onOpenPortfolio = vi.fn();
    const onOpenProject = vi.fn();

    render(
      <PortfolioMenu
        projects={projects}
        activeProjectId="project-two"
        onOpenPortfolio={onOpenPortfolio}
        onOpenProject={onOpenProject}
        onUnauthorized={vi.fn()}
      />,
    );

    await user.click(screen.getByLabelText("Portfolio and active projects"));
    expect(screen.getByRole("button", { name: "Rowan" })).toHaveAttribute("aria-current", "page");

    await user.click(screen.getByRole("button", { name: "Oak" }));
    expect(onOpenProject).toHaveBeenCalledWith(projects[0]);

    await user.click(screen.getByLabelText("Portfolio and active projects"));
    await user.click(screen.getByRole("button", { name: "Portfolio overview" }));
    expect(onOpenPortfolio).toHaveBeenCalledTimes(1);
  });
});
