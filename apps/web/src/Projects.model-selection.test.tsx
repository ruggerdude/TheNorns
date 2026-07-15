import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ProjectSummary, Projects } from "./Projects";
import { makeProject, projectAlpha } from "./test/fixtures";
import { MockFetch } from "./test/mockFetch";

describe("project manager model selection", () => {
  let mock: MockFetch;
  const onOpenProject = vi.fn<(project: ProjectSummary) => void>();

  beforeEach(() => {
    onOpenProject.mockReset();
    mock = new MockFetch();
    mock.get("/api/projects", { body: [projectAlpha] });
    mock.post("/api/projects", (_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        name: string;
        description: string;
        pm_provider: "anthropic" | "openai";
        pm_model: Exclude<ProjectSummary["pm_model"], null>;
      };
      return {
        status: 201,
        body: makeProject({
          id: "proj_created",
          name: body.name,
          description: body.description,
          pm_provider: body.pm_provider,
          pm_model: body.pm_model,
          reviewer_provider: body.pm_provider === "anthropic" ? "openai" : "anthropic",
          status: "draft",
          plan_objective: null,
        }),
      };
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
  });

  afterEach(() => mock.restore());

  async function openCreateDialog() {
    await screen.findByText(projectAlpha.name);
    await userEvent.click(screen.getByRole("button", { name: /new project/i }));
    return screen.findByTestId("pm-model");
  }

  async function submit(name: string) {
    await userEvent.type(screen.getByTestId("project-name"), name);
    await userEvent.type(screen.getByTestId("project-description"), "Plan the delivery");
    await userEvent.click(screen.getByRole("button", { name: /create and open project/i }));
    await waitFor(() => expect(onOpenProject).toHaveBeenCalledOnce());
    return mock.calls.find((call) => call.method === "POST" && call.url === "/api/projects");
  }

  it("offers current Anthropic and OpenAI models and defaults to Sonnet", async () => {
    const select = await openCreateDialog();

    expect(within(select).getByRole("option", { name: "Claude Fable 5" })).toBeInTheDocument();
    expect(within(select).getByRole("option", { name: "GPT-5.6 Sol" })).toBeInTheDocument();
    expect(select).toHaveValue("claude-sonnet-5");
  });

  it("submits Fable with Anthropic as PM and previews OpenAI review", async () => {
    const select = await openCreateDialog();
    await userEvent.selectOptions(select, "claude-fable-5");

    expect(screen.getByText(/Claude Fable 5 will lead planning.*OpenAI/i)).toBeInTheDocument();
    expect(await submit("Fable project")).toMatchObject({
      body: {
        pm_provider: "anthropic",
        pm_model: "claude-fable-5",
      },
    });
  });

  it("submits Sol with OpenAI as PM and flips review to Anthropic", async () => {
    const select = await openCreateDialog();
    await userEvent.selectOptions(select, "gpt-5.6-sol");

    expect(screen.getByText(/GPT-5.6 Sol will lead planning.*Anthropic/i)).toBeInTheDocument();
    expect(await submit("Sol project")).toMatchObject({
      body: {
        pm_provider: "openai",
        pm_model: "gpt-5.6-sol",
      },
    });
  });

  it("shows the selected PM model on project cards", async () => {
    await screen.findByText(projectAlpha.name);
    expect(screen.getByText("Claude Sonnet 5")).toBeInTheDocument();
  });
});
